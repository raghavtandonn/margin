import { get, all, run } from '../db/index.js';
import { seal, open } from './crypto.js';

// ── §11 — notes are a distinct data class ────────────────
//
// "It is the most sensitive data in the product — more so than email
// addresses." That is not rhetoric: an email address is a handle, and a note
// is somebody's private writing about what a book did to them. The
// Letterboxd incident exposed private lists and deleted content, which is
// exactly this shape of data.
//
// The rules from §11, and where each one actually lives:
//
//   never public                → no visibility column exists for a note
//   encrypted at the app layer  → this file, via lib/crypto.js
//   never in logs or errors     → lib/scrub.js, with a test
//   out of the public API       → routes/api.js selects columns explicitly
//   out of staff tooling        → routes/staff.js, separately gated
//   purged first on deletion    → scripts/purge.js, pass one
//
// There is deliberately no `getAllNotes()` in this module. Notes are read one
// reading at a time by their owner, or in bulk by exactly two callers that
// have to declare themselves (the desk's index and the owner's export).

/** Write a note. Plaintext never lands in `private_note` again. */
export function setNote(readingId, text) {
  const clean = text == null ? null : String(text).slice(0, 20_000).trim() || null;
  run(
    `UPDATE readings SET note_encrypted = ?, private_note = NULL WHERE id = ?`,
    clean == null ? null : seal(clean),
    Number(readingId)
  );
  return clean;
}

/**
 * Read a note.
 *
 * Rows written before the encryption migration still hold plaintext in
 * `private_note`, so both are checked. `migrateRow` moves such a row across
 * on first read, which means the plaintext column drains naturally as a
 * library is used rather than needing a flag day.
 */
export function noteOf(reading) {
  if (!reading) return null;
  if (reading.note_encrypted) return open(reading.note_encrypted);
  if (reading.private_note) {
    migrateRow(reading.id, reading.private_note);
    return reading.private_note;
  }
  return null;
}

function migrateRow(readingId, plaintext) {
  run(
    `UPDATE readings SET note_encrypted = ?, private_note = NULL WHERE id = ?`,
    seal(plaintext), Number(readingId)
  );
}

/** One-off sweep, for a library that already has notes in it. */
export function migrateAll() {
  const rows = all(
    `SELECT id, private_note FROM readings WHERE private_note IS NOT NULL AND private_note != ''`
  );
  for (const r of rows) migrateRow(r.id, r.private_note);
  return rows.length;
}

/**
 * §11 — "The desk may read notes to build embeddings."
 *
 * The one bulk reader that is not the owner exporting their own data. It is
 * named so that it shows up in a grep for note access, and it is local: the
 * vectors are built in-process and no note text leaves the machine. If a
 * hosted embedding provider is ever used here, §11 makes that a disclosure
 * obligation, and the desk spec's local-only mode is the switch for it.
 */
export function notesForIndexing(userId) {
  return all(
    `SELECT id, work_id, note_encrypted, private_note FROM readings WHERE user_id = ?`,
    Number(userId)
  )
    .map((r) => ({ readingId: r.id, workId: r.work_id, text: noteOf(r) }))
    .filter((r) => r.text);
}

/** The other bulk reader: the owner taking their own data out (§12). */
export function notesForExport(userId) {
  return all(
    `SELECT id, work_id, pass_number, note_encrypted, private_note, note_imported
       FROM readings WHERE user_id = ?`,
    Number(userId)
  )
    .map((r) => ({
      reading_id: r.id,
      work_id: r.work_id,
      pass: r.pass_number,
      imported: !!r.note_imported,
      note: noteOf(r)
    }))
    .filter((r) => r.note);
}

/** §12 — deleted in the first pass, not at the end of a retention window. */
export function purgeFor(userId) {
  const r = run(
    `UPDATE readings SET note_encrypted = NULL, private_note = NULL, review = NULL
      WHERE user_id = ?`,
    Number(userId)
  );
  return r.changes;
}
