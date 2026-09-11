import { seal, privateText, privateTextKey } from './crypto.js';
import { get, all, run } from '../db/index.js';

// ── SUPPLEMENTS ──────────────────────────────────────────
//
// Three of the four useful files in a Goodreads data export are not a
// library. They are things that attach to books already in one: notes left
// while reading, the dates a book was started and finished, quotes saved.
//
// So they take a different path from an import. An import creates books and
// asks first, because it can double somebody's library. A supplement only
// ever attaches to a book already there, never creates one, and never
// overwrites a value that exists. Both properties are enforced here rather
// than trusted to the caller.
//
// Nothing matches across users: a supplement can only touch a work the
// person already has a reading or a shelf for. Titles in this file arrive
// from an uploaded document, and a title-only match against the whole
// catalogue would let one attach a private note to a stranger's book.

/**
 * Titles are all this export gives us. No author, no ISBN, no id.
 *
 * So the key is deliberately aggressive — case, punctuation, accents and
 * spacing all dissolved — because the alternative to a fuzzy match here is
 * no match at all, and the blast radius is small: the worst case is a note
 * landing on the wrong edition of a book somebody owns, not on a book they
 * have never heard of.
 */
export const titleKey = (s) =>
  String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Every work this person actually has, by title key. */
function ownIndex(userId) {
  const rows = all(
    `SELECT DISTINCT w.id, w.title FROM works w
      WHERE w.id IN (SELECT work_id FROM readings WHERE user_id = ?)
         OR w.id IN (SELECT si.work_id FROM shelf_items si
                       JOIN shelves s ON s.id = si.shelf_id WHERE s.user_id = ?)`,
    Number(userId), Number(userId)
  );

  const index = new Map();
  for (const w of rows) {
    const k = titleKey(w.title);
    // A duplicate key means two of this person's books normalise the same.
    // Neither is a safe target, so the key is poisoned rather than resolved
    // by arbitrary precedence.
    if (index.has(k)) index.set(k, null);
    else index.set(k, w.id);
  }
  return index;
}

/**
 * What a supplement WOULD do, without doing any of it.
 *
 * The preview and the commit run the same function, so the screen somebody
 * approves is not a separate estimate that can drift from what is written.
 */
export function planSupplement(userId, kind, items) {
  const index = ownIndex(userId);
  const applied = [];
  const skipped = [];

  const resolve = (title) => {
    const k = titleKey(title);
    if (!index.has(k)) return { why: 'no book of that name in your library' };
    const id = index.get(k);
    if (id == null) return { why: 'two of your books share that name' };
    return { workId: id };
  };

  if (kind === 'quotes') {
    // A saved quote names no book at all in this export, so there is nothing
    // to attach it to and nothing that could be guessed honestly.
    for (const q of items) skipped.push({ title: q.text.slice(0, 60), why: 'quotes carry no book' });
    return { kind, applied, skipped };
  }

  for (const item of items) {
    const hit = resolve(item.title);
    if (hit.why) { skipped.push({ title: item.title, why: hit.why }); continue; }

    const reading = get(
      `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
        ORDER BY pass_number LIMIT 1`,
      Number(userId), hit.workId
    );
    if (!reading) {
      skipped.push({ title: item.title, why: 'never marked as read or reading' });
      continue;
    }

    if (kind === 'notes') {
      // Already imported once. Re-uploading the same file is a thing people
      // do, and it must not produce thirteen copies of the same sentence.
      const dupe = all('SELECT id, body FROM reading_notes WHERE user_id = ? AND work_id = ?',
        Number(userId), hit.workId).find(n => privateText(n.body) === item.text);
      if (dupe) { skipped.push({ title: item.title, why: 'already imported' }); continue; }
      applied.push({ kind, workId: hit.workId, readingId: reading.id, title: item.title,
                     text: item.text, at: item.at });
    }

    if (kind === 'activity') {
      // Never overwrite. A date somebody has entered by hand, or one that
      // came from the CSV, is better evidence than a newsfeed post.
      if (reading[item.field]) {
        skipped.push({ title: item.title, why: `already has a ${item.field.replace('_at', '')} date` });
        continue;
      }
      // Two newsfeed posts for the same book and field: keep the earlier.
      const already = applied.find((a) => a.readingId === reading.id && a.field === item.field);
      if (already) {
        if (item.at < already.at) already.at = item.at;
        continue;
      }
      applied.push({ kind, workId: hit.workId, readingId: reading.id, title: item.title,
                     field: item.field, at: item.at });
    }
  }

  return { kind, applied, skipped };
}

/**
 * Write a plan.
 *
 * Takes the plan rather than the items so that what is written is exactly
 * what was shown. Re-plans nothing and re-decides nothing.
 */
export function applySupplement(userId, plan) {
  let written = 0;

  for (const a of plan.applied) {
    // The reading is re-checked against this user on the way in. The plan
    // came from a session and could have been sat on while something
    // changed underneath it.
    const owns = get(
      'SELECT id FROM readings WHERE id = ? AND user_id = ?',
      a.readingId, Number(userId)
    );
    if (!owns) continue;

    if (a.kind === 'notes') {
      // Page stays null: the export records the note and the day, never the
      // page, and the marginalia renderer shows the date in its place.
      //
      // OR IGNORE rather than a pre-check, because the unique index is the
      // real guarantee. Two uploads racing each other would both pass a
      // check and only one can pass the index.
      run(
        `INSERT OR IGNORE INTO reading_notes (user_id, work_id, page, body, body_key, written_on, source)
         VALUES (?, ?, NULL, ?, ?, ?, 'goodreads')`,
        Number(userId), a.workId, seal(a.text), privateTextKey(userId, a.workId, a.text), a.at
      );
      written++;
    }

    if (a.kind === 'activity') {
      // The column is chosen from a fixed map in the reader, never from the
      // uploaded file, so this interpolation cannot carry anything but one
      // of three known column names.
      if (!['started_at', 'finished_at', 'abandoned_at'].includes(a.field)) continue;
      run(
        `UPDATE readings SET ${a.field} = ? WHERE id = ? AND ${a.field} IS NULL`,
        a.at, a.readingId
      );
      written++;
    }
  }

  return written;
}
