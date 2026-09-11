import { privateText } from './crypto.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, sqlTime, nowSQL } from '../db/index.js';
import { newToken, hashToken } from './crypto.js';
import { toCSV } from './csv.js';
import { zip } from './zip.js';
import * as notes from './notes.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = process.env.MARGIN_EXPORT_DIR || join(here, '..', 'data', 'exports');

// ── §12 — export ─────────────────────────────────────────
//
// "One click, everything, as JSON plus CSV in a zip: books, shelves, notes,
// ratings, dates, account metadata."
//
// The last line of §12 is the reason this is a first-class feature rather
// than a compliance checkbox: "a product that makes leaving easy is one
// people trust enough to stay in." So the export is complete — including the
// notes, which are the hardest thing to get back out of Goodreads.

export function buildExport(userId) {
  const id = Number(userId);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new Error('no such account');

  const readings = all(
    `SELECT r.*, w.title, w.subtitle, w.first_published_year,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author,
            e.isbn13, e.isbn10, e.publisher, e.published_year, e.page_count, e.format
       FROM readings r
       JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = r.edition_id
      WHERE r.user_id = ?
      ORDER BY r.work_id, r.pass_number`,
    id
  );

  const noteByReading = new Map(notes.notesForExport(id).map((n) => [n.reading_id, n]));

  const shelves = all(
    `SELECT s.id, s.public_id, s.name, s.slug, s.visibility, s.is_system, s.created_at
       FROM shelves s WHERE s.user_id = ? ORDER BY s.id`,
    id
  ).map((s) => ({
    ...s,
    items: all(
      `SELECT si.work_id, si.edition_id, si.added_at, si.visibility, w.title
         FROM shelf_items si JOIN works w ON w.id = si.work_id
        WHERE si.shelf_id = ? ORDER BY si.added_at`,
      s.id
    )
  }));

  const sessions = all(
    `SELECT ses.* FROM sessions ses
       JOIN readings r ON r.id = ses.reading_id
      WHERE r.user_id = ? ORDER BY ses.occurred_at`,
    id
  ).map(s => ({ ...s, note: privateText(s.note) }));

  const account = {
    public_id: user.public_id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    bio: user.bio,
    location: user.location,
    link: user.link,
    profile_visibility: user.profile_visibility,
    search_indexable: !!user.search_indexable,
    created_at: user.created_at,
    email_verified_at: user.email_verified_at,
    books_logged: user.books_logged
  };

  const books = readings.map((r) => ({
    title: r.title,
    subtitle: r.subtitle,
    author: r.author,
    isbn13: r.isbn13,
    isbn10: r.isbn10,
    publisher: r.publisher,
    published_year: r.published_year,
    first_published_year: r.first_published_year,
    page_count: r.page_count,
    format: r.format,
    status: r.status,
    pass_number: r.pass_number,
    stars: r.stars,
    started_at: r.started_at,
    finished_at: r.finished_at,
    abandoned_at: r.abandoned_at,
    abandoned_page: r.abandoned_page,
    current_position: r.current_page,
    position_type: r.position_type,
    visibility: r.visibility,
    // §12 — notes come out too. This is the data Goodreads makes hardest to
    // retrieve, and withholding it would make the export a gesture.
    note: noteByReading.get(r.id)?.note ?? null,
    note_imported: !!noteByReading.get(r.id)?.imported,
    review: r.review ?? null
  }));

  const json = {
    exported_at: new Date().toISOString(),
    format: 'margin/export/v1',
    account,
    books,
    shelves,
    sessions
  };

  // toCSV escapes every cell that could be read as a formula (§12). That is
  // the whole point of routing through it rather than joining with commas.
  const booksCSV = toCSV(books, [
    'title', 'subtitle', 'author', 'isbn13', 'isbn10', 'publisher',
    'published_year', 'page_count', 'format', 'status', 'pass_number',
    'stars', 'started_at', 'finished_at', 'abandoned_at', 'note', 'review'
  ]);

  const shelvesCSV = toCSV(
    shelves.flatMap((s) => s.items.map((i) => ({
      shelf: s.name, shelf_slug: s.slug, shelf_visibility: s.visibility,
      title: i.title, work_id: i.work_id, added_at: i.added_at,
      entry_visibility: i.visibility
    }))),
    ['shelf', 'shelf_slug', 'shelf_visibility', 'title', 'work_id', 'added_at', 'entry_visibility']
  );

  const readme =
    `MARGIN · YOUR LIBRARY\n\n` +
    `Exported ${json.exported_at}\n` +
    `${books.length} reading passes across ${new Set(readings.map((r) => r.work_id)).size} books.\n` +
    `${shelves.length} shelves. ${sessions.length} logged sessions.\n\n` +
    `library.json  everything, including notes\n` +
    `books.csv     one row per reading pass\n` +
    `shelves.csv   one row per shelved book\n\n` +
    `Cells beginning = + - or @ carry a leading apostrophe. That is deliberate:\n` +
    `without it a spreadsheet would treat your own review as a formula and run it.\n`;

  return {
    archive: zip([
      { name: 'library.json', data: JSON.stringify(json, null, 2) },
      { name: 'books.csv', data: booksCSV },
      { name: 'shelves.csv', data: shelvesCSV },
      { name: 'README.txt', data: readme }
    ]),
    counts: { books: books.length, shelves: shelves.length, sessions: sessions.length }
  };
}

/**
 * §12 — "delivered as a signed URL expiring in 1 hour". There is no object
 * store to sign against, so the equivalent is an unguessable single-use
 * token stored hashed, with the file written outside the static root so
 * nothing serves it implicitly.
 */
export function stageExport(userId) {
  const { archive, counts } = buildExport(userId);

  mkdirSync(EXPORT_DIR, { recursive: true });
  const id = randomUUID();
  const path = join(EXPORT_DIR, `${id}.zip`);
  writeFileSync(path, archive);

  const token = newToken();
  run(
    `INSERT INTO exports (id, user_id, token_hash, path, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    id, Number(userId), hashToken(token), path,
    sqlTime(Date.now() + 3600_000)
  );

  return { token, counts, bytes: archive.length };
}

/** Single-use: claiming it marks it consumed in the same statement. */
export function claimExport(token, userId) {
  const row = get(
    `SELECT * FROM exports
      WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    hashToken(token), Number(userId), nowSQL()
  );
  if (!row) return null;

  const res = run(
    `UPDATE exports SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL`,
    row.id
  );
  return res.changes ? row : null;
}

export const exportsToday = (userId) =>
  get(
    `SELECT COUNT(*) n FROM exports WHERE user_id = ? AND created_at > datetime('now', '-1 day')`,
    Number(userId)
  ).n;
