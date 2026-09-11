import { readFileSync } from 'node:fs';
import { get, run, all, reindexWork, reindexAll } from '../db/index.js';
import * as W from '../lib/works.js';
import * as OL from '../lib/openlibrary.js';
import { parsePaste } from '../lib/parse-paste.js';
import { starsFromImport } from '../lib/stars.js';

// Import a pasted Goodreads "My Books" table view.
//
//   pbpaste > data/goodreads-paste.txt
//   npm run import:paste -- data/goodreads-paste.txt
//   npm run import:paste -- data/goodreads-paste.txt --resolve
//
// --resolve looks every book up on Open Library to attach a real edition:
// ISBN, cover, page count, publisher. The table view has none of those, and
// without an edition a book has no cover, no page count, and no colophon.

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const RESOLVE = args.includes('--resolve');
const limitAt = args.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;

if (!file) {
  console.error('USAGE: npm run import:paste -- <file.txt> [--resolve] [--limit N]');
  process.exit(1);
}

// Goodreads' exclusive shelves map onto MARGIN's system shelves. Everything
// else the reader invented is kept under its own name.
const SHELF_MAP = {
  'to-read': 'waiting',
  read: 'finished',
  'currently-reading': 'reading',
  'did-not-finish': 'abandoned',
  dnf: 'abandoned'
};

const STATUS_OF = {
  finished: 'FINISHED',
  reading: 'READING',
  abandoned: 'ABANDONED'
};

function shelfId(userId, slug, cache) {
  if (cache.has(slug)) return cache.get(slug);
  run(
    'INSERT OR IGNORE INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 0)',
    userId, slug.toUpperCase().replace(/-/g, ' '), slug
  );
  const s = get('SELECT id FROM shelves WHERE user_id = ? AND slug = ?', userId, slug);
  cache.set(slug, s.id);
  return s.id;
}

async function main() {
  const { books, skipped } = parsePaste(readFileSync(file, 'utf8'));
  const user = get(`SELECT * FROM users WHERE handle = 'you'`);
  if (!user) {
    console.error('NO READER. RUN: npm run reset:empty');
    process.exit(1);
  }

  console.log('"MARGIN" — IMPORTING PASTED TABLE VIEW');
  console.log(`  PARSED   ${books.length} ROWS`);
  if (skipped.length) console.log(`  SKIPPED  ${skipped.length} (no title or author)`);

  const cache = new Map();
  const stats = { created: 0, matched: 0, rated: 0, readings: 0, resolved: 0, unresolved: 0 };
  const toResolve = [];

  for (const b of books.slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
    // Match on title + author so a re-run updates instead of duplicating.
    let hit = get(
      `SELECT w.id FROM works w
       JOIN work_people wp ON wp.work_id = w.id
       JOIN people p ON p.id = wp.person_id
       WHERE lower(w.title) = lower(?) AND lower(p.name) = lower(?)`,
      b.title, b.author
    );

    let workId;
    if (hit) {
      workId = hit.id;
      stats.matched++;
    } else {
      workId = W.createWork({ title: b.title, authors: [b.author] });
      stats.created++;
      if (RESOLVE) toResolve.push({ workId, ...b });
    }

    if (b.series) {
      run('INSERT OR IGNORE INTO series (name) VALUES (?)', b.series.name);
      const s = get('SELECT id FROM series WHERE name = ?', b.series.name);
      run(
        'INSERT OR IGNORE INTO series_works (series_id, work_id, position) VALUES (?, ?, ?)',
        s.id, workId, b.series.position
      );
    }

    // §2 — the star is copied straight through. A rating of 0 means
    // UNRATED in Goodreads and must never become one star.
    const stars = starsFromImport(b.rating);

    // Shelves.
    const slugs = new Set(b.shelves.map((s) => SHELF_MAP[s] || s));
    for (const slug of slugs) {
      run(
        'INSERT OR IGNORE INTO shelf_items (shelf_id, work_id, added_at) VALUES (?, ?, ?)',
        shelfId(user.id, slug, cache), workId, b.dateAdded || null
      );
    }

    // Reading state, from whichever exclusive shelf the book sat on.
    // §2 — the rating lives on the pass, not the work.
    const status = [...slugs].map((s) => STATUS_OF[s]).find(Boolean);
    if (status || stars != null || b.review) {
      run(
        `INSERT INTO readings (user_id, work_id, status, pass_number, stars, review, started_at, finished_at, abandoned_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, work_id, pass_number) DO UPDATE SET
           status = excluded.status,
           stars = COALESCE(excluded.stars, readings.stars),
           review = COALESCE(excluded.review, readings.review),
           finished_at = COALESCE(excluded.finished_at, readings.finished_at)`,
        user.id, workId, status || 'FINISHED', stars, b.review,
        b.dateAdded || null,
        status === 'FINISHED' ? b.dateRead : null,
        status === 'ABANDONED' ? b.dateRead : null
      );
      stats.readings++;
      if (stars != null) stats.rated++;
    }

    reindexWork(workId);
  }

  console.log(`  NEW      ${stats.created} WORKS`);
  console.log(`  MATCHED  ${stats.matched} ALREADY IN THE GRAPH`);
  console.log(`  RATED    ${stats.rated}`);
  console.log(`  READINGS ${stats.readings}`);

  // ── Resolve editions against Open Library ──────────────
  // The table view has no ISBNs, so without this every book is an edition-less
  // record: no cover, no page count, no colophon, no barcode.
  if (RESOLVE && toResolve.length) {
    console.log(`\n  RESOLVING ${toResolve.length} WORKS AGAINST OPEN LIBRARY`);
    console.log('  (TITLE + AUTHOR MATCH — NO ISBN IN THE TABLE VIEW)\n');

    for (const [i, b] of toResolve.entries()) {
      // A low-confidence match is refused rather than guessed: a wrong cover
      // and ISBN on the shelf is worse than a book with no edition data.
      const match = await OL.resolveWork(b.title, b.author);

      const n = `[${String(i + 1).padStart(4)}/${toResolve.length}]`;
      if (!match) {
        stats.unresolved++;
        console.log(`  ${n} ${b.title.slice(0, 44).padEnd(45)} NO CONFIDENT MATCH`);
        continue;
      }

      run('UPDATE works SET ol_key = ?, first_published_year = ? WHERE id = ?',
        match.workKey, match.year || null, b.workId);

      let added = 0;
      const editions = await OL.editionsOfWork(match.workKey, { limit: 5 });
      for (const e of editions) {
        if (!e.isbn13) continue;
        if (get('SELECT id FROM editions WHERE isbn13 = ?', e.isbn13)) continue;
        W.addEdition(b.workId, e);
        added++;
      }

      // Fall back to the search doc's own ISBN and cover if the editions
      // endpoint gave nothing usable.
      if (!added) {
        W.addEdition(b.workId, {
          isbn13: match.isbn13 || null,
          cover_url: match.cover_url || null,
          published_year: match.year || null,
          format: 'PAPERBACK'
        });
        added = 1;
      }

      reindexWork(b.workId);
      stats.resolved++;
      console.log(
        `  ${n} ${b.title.slice(0, 44).padEnd(45)} +${added} ED · ${String(match.year || '—').padEnd(5)} ${match.confidence}`
      );
    }
  }

  reindexAll();

  console.log(`\n  RESOLVED   ${stats.resolved}`);
  if (stats.unresolved) console.log(`  UNRESOLVED ${stats.unresolved} (kept, but with no edition data)`);
  console.log('\n  RATINGS ARE STARS. UNRATED BOOKS SHOW NOTHING.');
}

main();
