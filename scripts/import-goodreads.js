import { readFileSync } from 'node:fs';
import { get, run, all, reindexAll } from '../db/index.js';
import * as W from '../lib/works.js';
import { starsFromImport } from '../lib/stars.js';
import { normalizeISBN } from '../lib/artifacts.js';

// §12 — import from Goodreads. Their export is a hostile CSV (§00 failure 4),
// so this parser handles the quoting properly rather than splitting on commas.
//
//   npm run import:goodreads -- ~/Downloads/goodreads_library_export.csv

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Goodreads wraps ISBNs as ="9780141439556"
const cleanISBN = (v) => normalizeISBN(String(v || '').replace(/^="|"$/g, ''));

function importFile(path, handle = 'you') {
  const rows = parseCSV(readFileSync(path, 'utf8'));
  const user = get('SELECT * FROM users WHERE handle = ?', handle);
  if (!user) throw new Error(`NO READER "${handle}". RUN: npm run seed`);

  const shelfCache = new Map();
  const shelfId = (slug, name) => {
    if (shelfCache.has(slug)) return shelfCache.get(slug);
    run(
      'INSERT OR IGNORE INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 0)',
      user.id, name, slug
    );
    const s = get('SELECT id FROM shelves WHERE user_id = ? AND slug = ?', user.id, slug);
    shelfCache.set(slug, s.id);
    return s.id;
  };

  const stats = { works: 0, editions: 0, rated: 0, readings: 0, skipped: 0, matched: 0 };

  for (const r of rows) {
    const title = r['Title'];
    if (!title) { stats.skipped++; continue; }

    const isbn13 = cleanISBN(r['ISBN13']) || cleanISBN(r['ISBN']);
    const author = r['Author'] || r['Author l-f'] || '';
    const pages = Number(r['Number of Pages']) || null;

    // Match on ISBN first, then on title+author, so re-running the import
    // updates rather than duplicating.
    let workId = null;
    if (isbn13) {
      const hit = get('SELECT work_id FROM editions WHERE isbn13 = ?', isbn13);
      if (hit) { workId = hit.work_id; stats.matched++; }
    }
    if (!workId) {
      const hit = get(
        `SELECT w.id FROM works w
         JOIN work_people wp ON wp.work_id = w.id
         JOIN people p ON p.id = wp.person_id
         WHERE lower(w.title) = lower(?) AND lower(p.name) = lower(?)`,
        title, author
      );
      if (hit) { workId = hit.id; stats.matched++; }
    }

    let editionId = null;

    if (!workId) {
      workId = W.createWork({
        title,
        year: Number(r['Original Publication Year']) || Number(r['Year Published']) || null,
        authors: author ? [author] : []
      });
      stats.works++;
    }

    if (isbn13) {
      const existing = get('SELECT id FROM editions WHERE isbn13 = ?', isbn13);
      editionId = existing
        ? existing.id
        : W.addEdition(workId, {
            isbn13,
            isbn10: String(r['ISBN'] || '').replace(/^="|"$/g, '') || null,
            publisher: r['Publisher'] || null,
            published_year: Number(r['Year Published']) || null,
            page_count: pages,
            format: (r['Binding'] || 'PAPERBACK').toUpperCase().replace(/\s+/g, '_')
          });
      if (!existing) stats.editions++;
    } else if (pages) {
      // No ISBN, but a page count is still worth keeping: it is what the
      // pace strip and the spine view are computed from.
      editionId = W.addEdition(workId, {
        publisher: r['Publisher'] || null,
        published_year: Number(r['Year Published']) || null,
        page_count: pages,
        format: (r['Binding'] || 'PAPERBACK').toUpperCase().replace(/\s+/g, '_')
      });
      stats.editions++;
    }

    // §2 — `My Rating` of 0 means UNRATED. Mapping it to one star is the
    // single most common import bug; starsFromImport returns null for 0.
    const stars = starsFromImport(r['My Rating']);
    const review = r['My Review'] || null;
    // Private Notes is a distinct field and is never rendered publicly.
    const privateNote = r['Private Notes'] || null;

    const grShelf = (r['Exclusive Shelf'] || '').toLowerCase();
    const dateRead = r['Date Read'] || null;
    const dateAdded = r['Date Added'] || null;

    const status =
      grShelf === 'read' ? 'FINISHED'
      : grShelf === 'currently-reading' ? 'READING'
      : 'WAITING';

    if (status !== 'WAITING' || dateRead || stars != null || review) {
      run(
        `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number, current_page, total_positions,
                               stars, review, private_note, started_at, finished_at)
         VALUES (?, ?, ?, ?, 1, ?, (SELECT page_count FROM editions WHERE id = ?), ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, work_id, pass_number) DO UPDATE SET
           status = excluded.status,
           stars = COALESCE(excluded.stars, readings.stars),
           review = COALESCE(excluded.review, readings.review),
           private_note = COALESCE(excluded.private_note, readings.private_note),
           finished_at = COALESCE(readings.finished_at, excluded.finished_at)`,
        user.id, workId, editionId, status,
        status === 'FINISHED' ? (pages || 0) : 0,
        editionId,
        stars, review, privateNote,
        dateAdded || null,
        // Date Read is frequently empty even on read books; fall back to
        // Date Added, and if both are empty leave it null (§2).
        status === 'FINISHED' ? (dateRead || dateAdded || null) : null
      );
      stats.readings++;
      if (stars != null) stats.rated++;
    }

    // Goodreads' own shelf names are preserved, plus the exclusive shelf.
    const slugs = new Set();
    if (grShelf) slugs.add(grShelf === 'read' ? 'finished' : grShelf === 'to-read' ? 'waiting' : grShelf);
    for (const s of String(r['Bookshelves'] || '').split(',')) {
      const t = s.trim();
      if (t) slugs.add(t);
    }

    for (const slug of slugs) {
      const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!clean) continue;
      run(
        'INSERT OR IGNORE INTO shelf_items (shelf_id, work_id, edition_id, added_at) VALUES (?, ?, ?, ?)',
        shelfId(clean, clean.toUpperCase().replace(/-/g, ' ')),
        workId,
        editionId,
        dateAdded || new Date().toISOString().slice(0, 10)
      );
    }
  }

  reindexAll();

  console.log('"MARGIN" — IMPORTED FROM GOODREADS');
  console.log(`  ROWS         ${rows.length}`);
  console.log(`  MATCHED      ${stats.matched}  (already in the graph)`);
  console.log(`  NEW WORKS    ${stats.works}`);
  console.log(`  NEW EDITIONS ${stats.editions}`);
  console.log(`  RATED        ${stats.rated}`);
  console.log(`  READINGS     ${stats.readings}`);
  if (stats.skipped) console.log(`  SKIPPED      ${stats.skipped}  (no title)`);
  console.log('');
  console.log('  IMPORTED RATINGS ARE GRAY C=M=Y CHIPS AND ARE LABELED AS');
  console.log('  IMPORTS. RE-PRINT ANY BOOK TO REPLACE ONE WITH REAL CHANNELS.');
}

const path = process.argv[2];
if (!path) {
  console.error('USAGE: npm run import:goodreads -- <path-to-goodreads_library_export.csv>');
  process.exit(1);
}
importFile(path, process.argv[3] || 'you');
