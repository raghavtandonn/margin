import { get, run, all, reindexAll, nowSQL } from '../db/index.js';
import * as W from './works.js';
import { setNote, noteOf } from './notes.js';
import { recountBooks } from './accounts.js';
import * as audit from './audit.js';
import * as TM from './title-match.js';

// ── §12 — writing an import ──────────────────────────────
//
// Two properties matter more than speed, and both are easy to lose:
//
//   ADDITIVE      an import adds to a library, it never replaces one. No
//                 existing rating, note, or date is overwritten by a blank
//                 from a file.
//
//   IDEMPOTENT    running the same file twice must leave the library
//                 exactly as it was after the first run. Every write below
//                 is therefore a match-then-update, never a blind insert,
//                 and test/import.test.js runs a file twice and compares.
//
// The second one is why editions are matched before they are created: an
// edition with no ISBN has nothing unique about it, so a naive insert makes
// a fresh one on every pass and the library quietly doubles.

const today = () => new Date().toISOString().slice(0, 10);

/** Find the work this row is about, or create it. */
function resolveWork(row, userId) {
  // ISBN first: it is the only identifier in the file that means anything.
  if (row.isbn13) {
    const hit = get('SELECT work_id FROM editions WHERE isbn13 = ?', row.isbn13);
    if (hit) return { workId: hit.work_id, created: false };
  }

  // Then title + author, case-insensitively.
  if (row.author) {
    const hit = get(
      `SELECT w.id FROM works w
         JOIN work_people wp ON wp.work_id = w.id
         JOIN people p ON p.id = wp.person_id
        WHERE lower(w.title) = lower(?) AND lower(p.name) = lower(?)
        LIMIT 1`,
      row.title, row.author
    );
    if (hit) return { workId: hit.id, created: false };
  }

  // Then title alone, but only when the stored work has no author either —
  // otherwise two different books called "Gold" become one.
  const bare = get(
    `SELECT w.id FROM works w
      WHERE lower(w.title) = lower(?)
        AND NOT EXISTS (SELECT 1 FROM work_people wp WHERE wp.work_id = w.id AND wp.role = 'AUTHOR')
      LIMIT 1`,
    row.title
  );
  if (bare) return { workId: bare.id, created: false };

  // ── A row that has no author to match on ───────────────
  //
  // The Goodreads DATA export carries no author column, no ISBN and no
  // page count. Every one of its rows reaches this point, and without this
  // branch every one of them creates a new work — so importing it on top of
  // an existing library silently doubles it. Four hundred books, no
  // warning, and the duplicates carry no author so they cannot be merged
  // back afterwards.
  //
  // lib/title-match.js does the work: it normalises away the invisible
  // differences between a catalogue title and an export title, tries the
  // title with and without the imprint Goodreads writes into it, and where
  // the reader genuinely owns two books of the same name it reads their own
  // shelving dates, ratings and statuses to decide which one this row is.
  // The search never leaves their own library.
  if (!row.author && userId) {
    const m = TM.matchAuthorless(userId, row);
    if (m.workId) return { workId: m.workId, created: false, matchedBy: m.why };
    // Not a book they have. Falls through and is created below.
    if (!m.create) return { workId: null, ambiguous: true, why: m.why };
  }

  return {
    workId: W.createWork({
      title: row.title,
      year: row.year,
      authors: row.author ? [row.author] : []
    }),
    created: true
  };
}

/** Find the edition, or create one. Never creates a duplicate. */
function resolveEdition(workId, row) {
  if (row.isbn13) {
    const hit = get('SELECT id FROM editions WHERE isbn13 = ?', row.isbn13);
    if (hit) return hit.id;
    return W.addEdition(workId, {
      isbn13: row.isbn13,
      isbn10: row.isbn10 || null,
      publisher: row.publisher || null,
      published_year: row.year || null,
      page_count: row.pages || null
    });
  }

  // No ISBN. An edition here is identified by the work plus its page count,
  // which is what makes a second run match instead of inserting again.
  if (row.pages) {
    const hit = get(
      `SELECT id FROM editions WHERE work_id = ? AND isbn13 IS NULL AND page_count = ? LIMIT 1`,
      workId, row.pages
    );
    if (hit) return hit.id;
    return W.addEdition(workId, {
      publisher: row.publisher || null,
      published_year: row.year || null,
      page_count: row.pages
    });
  }

  // Nothing distinguishing at all: reuse any edition the work already has
  // rather than adding an empty one per run.
  const any = get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', workId);
  return any ? any.id : null;
}

function shelfId(userId, slug, name, cache) {
  if (cache.has(slug)) return cache.get(slug);
  run(
    'INSERT OR IGNORE INTO shelves (user_id, name, slug, is_system, public_id) VALUES (?, ?, ?, 0, ?)',
    userId, name, slug, crypto.randomUUID()
  );
  const s = get('SELECT id FROM shelves WHERE user_id = ? AND slug = ?', userId, slug);
  cache.set(slug, s.id);
  return s.id;
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Write one row.
 *
 * `mapping` is what the person confirmed on the preview screen: their
 * vocabulary on the left, ours on the right.
 */
function importRow(userId, row, mapping, cache) {
  const status = mapping[row.sourceShelf || ''] || 'WAITING';
  if (status === 'SKIP') return { skipped: true };

  const { workId, created, ambiguous, why } = resolveWork(row, userId);

  // Two of this person's own books share the title and nothing in their own
  // records chooses between them. Writing to either is a coin flip, so
  // nothing is written and the row goes to the unmatched screen with the
  // reason on it.
  if (ambiguous) {
    return { failed: true, title: row.title, reason: why || 'two of your books have this title' };
  }

  const editionId = resolveEdition(workId, row);

  // ── The reading pass ──
  // COALESCE on every field the file might not carry: an import must never
  // blank a rating or a date that is already there.
  const existing = get(
    'SELECT * FROM readings WHERE user_id = ? AND work_id = ? AND pass_number = 1',
    userId, workId
  );

  run(
    `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number,
                           current_page, total_positions, stars,
                           started_at, finished_at, note_imported)
     VALUES (?, ?, ?, ?, 1, ?, (SELECT page_count FROM editions WHERE id = ?), ?, ?, ?, ?)
     ON CONFLICT (user_id, work_id, pass_number) DO UPDATE SET
       edition_id  = COALESCE(readings.edition_id, excluded.edition_id),
       status      = excluded.status,
       stars       = COALESCE(readings.stars, excluded.stars),
       started_at  = COALESCE(readings.started_at, excluded.started_at),
       finished_at = COALESCE(readings.finished_at, excluded.finished_at)`,
    userId, workId, editionId, status,
    status === 'FINISHED' ? (row.pages || 0) : 0,
    editionId,
    row.rating,
    row.dateAdded,
    status === 'FINISHED' ? (row.dateRead || row.dateAdded) : null,
    row.review || row.note ? 1 : 0
  );

  const reading = get(
    'SELECT * FROM readings WHERE user_id = ? AND work_id = ? AND pass_number = 1',
    userId, workId
  );

  // ── The review ──
  // §12: reviews land in notes "marked as imported, with a date, so they're
  // distinguishable from what someone writes here."
  //
  // A note somebody wrote in this product is never overwritten by one from
  // a file — that is the single most destructive thing an import could do.
  const incoming = [row.review, row.note].filter(Boolean).join('\n\n').trim();
  if (incoming) {
    const current = noteOf(reading);
    const alreadyImported = !!reading.note_imported;

    if (!current || (alreadyImported && current !== incoming)) {
      setNote(reading.id, incoming);
      run(
        `UPDATE readings SET note_imported = 1, note_imported_at = ? WHERE id = ?`,
        // The date the note arrived here, which is what distinguishes it.
        existing?.note_imported_at || today(),
        reading.id
      );
    }
  }

  // ── Shelves ──
  // The status shelf, plus whatever the person shelved it under themselves.
  const slugs = new Set();
  if (status === 'FINISHED') slugs.add('finished');
  else if (status === 'READING') slugs.add('reading');
  else if (status === 'ABANDONED') slugs.add('abandoned');
  else slugs.add('waiting');

  for (const s of row.extraShelves) {
    const clean = slugify(s);
    if (clean && clean !== 'read' && clean !== 'to-read' && clean !== 'currently-reading') {
      slugs.add(clean);
    }
  }

  for (const slug of slugs) {
    run(
      `INSERT OR IGNORE INTO shelf_items (shelf_id, work_id, edition_id, added_at)
       VALUES (?, ?, ?, ?)`,
      shelfId(userId, slug, slug.toUpperCase().replace(/-/g, ' '), cache),
      workId, editionId, row.dateAdded || today()
    );
  }

  return { workId, createdWork: created };
}

/**
 * Run a whole import, reporting progress as it goes.
 *
 * `onProgress(done, total)` is called so the screen can print one line —
 * "IMPORTING · 214 / 412" — rather than animating anything.
 *
 * The work YIELDS between batches. node:sqlite is synchronous, so a
 * straight loop over four hundred rows holds the event loop for its whole
 * duration: the server cannot answer the progress endpoint, the line never
 * updates, and a long enough import drops connections outright. Handing
 * control back every batch is what makes the progress line real rather
 * than decorative.
 */
const BATCH = 25;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export async function runImport(userId, rows, mapping, { onProgress = null } = {}) {
  const cache = new Map();
  const result = { imported: 0, skipped: 0, newWorks: 0, failed: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const r = importRow(userId, row, mapping, cache);
      if (r.failed) result.failed.push({ title: r.title, error: r.reason });
      else if (r.skipped) result.skipped++;
      else {
        result.imported++;
        if (r.createdWork) result.newWorks++;
      }
    } catch (err) {
      // One bad row must not abandon the other four hundred.
      result.failed.push({ title: row.title, error: err.message });
    }

    if ((i + 1) % BATCH === 0 || i === rows.length - 1) {
      onProgress?.(i + 1, rows.length);
      await yieldToLoop();
    }
  }

  reindexAll();
  recountBooks(userId);

  audit.record({
    actorType: 'user', actorId: userId, action: 'account.import.completed',
    targetUserId: userId, fields: ['readings', 'shelves', 'notes'],
    metadata: { imported: result.imported, newWorks: result.newWorks, failed: result.failed.length }
  });

  return result;
}
