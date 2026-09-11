import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seal, privateTextKey } from '../lib/crypto.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const DB_PATH = process.env.MARGIN_DB || join(root, 'data', 'margin.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
db.exec(readFileSync(join(here, 'schema-auth.sql'), 'utf8'));
db.exec(readFileSync(join(here, 'schema-seasons.sql'), 'utf8'));
db.exec(readFileSync(join(here, 'schema-community.sql'), 'utf8'));
db.exec(readFileSync(join(here, 'schema-lookbook.sql'), 'utf8'));
db.exec(readFileSync(join(here, 'schema-reco.sql'), 'utf8'));

// Columns added after the first release. ALTER TABLE has no IF NOT EXISTS in
// SQLite, so each is guarded by reading the table's own shape — which is
// also the only way this stays idempotent across a hundred boots.
for (const [table, column, decl] of [
  // Default ON, in step with the profile default. The taste analysis is the
  // most characterful thing this product computes and the likeliest reason
  // another reader wants to look at you; defaulting it off meant nobody
  // ever saw one. Still one switch away in Settings → Privacy.
  //
  // Existing accounts are untouched: ALTER TABLE ... DEFAULT applies to
  // rows written after it, so anyone who has already chosen keeps their
  // choice, and anyone who has not keeps the 0 they were created with.
  ['users', 'taste_public', 'INTEGER NOT NULL DEFAULT 1']
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Additive column migrations for tables that already hold data.
const { migrate } = await import('./migrate.js');
const migrated = migrate(db);
if (migrated.length) console.log(`  migrated: ${migrated.join(', ')}`);

// Earlier search indexes persisted decrypted private notes. Remove those
// documents at startup; private-note search now reads only the owner's live
// notes in memory. This also handles existing installations without a reset.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'desk_vectors'").get()) {
  db.prepare("DELETE FROM desk_vectors WHERE kind = 'note'").run();
}

// Private text introduced by imports and season captions must follow the
// same encryption contract as the primary reading note. Encrypt existing
// rows once; HMAC keys preserve import deduplication without storing text.
if (!db.prepare('PRAGMA table_info(reading_notes)').all().some(c => c.name === 'body_key')) {
  db.exec('ALTER TABLE reading_notes ADD COLUMN body_key TEXT');
}
db.exec('BEGIN');
try {
  for (const row of db.prepare("SELECT id, user_id, work_id, body FROM reading_notes WHERE typeof(body) = 'text'").all()) {
    db.prepare('UPDATE reading_notes SET body = ?, body_key = ? WHERE id = ?')
      .run(seal(row.body), privateTextKey(row.user_id, row.work_id, row.body), row.id);
  }
  for (const [table, column] of [['sessions', 'note'], ['season_frames', 'caption']]) {
    for (const row of db.prepare(`SELECT rowid AS _rid, ${column} AS value FROM ${table} WHERE typeof(${column}) = 'text'`).all()) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(seal(row.value), row._rid);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reading_notes_key ON reading_notes(user_id, work_id, body_key)');
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// §12 — transliteration. "bronte" must find "Brontë", and a folded index is
// the only way that works without a per-language rule table.
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function reindexWork(workId) {
  const work = get('SELECT id, title, subtitle FROM works WHERE id = ?', workId);
  if (!work) return;

  const authors = all(
    `SELECT p.name FROM work_people wp
     JOIN people p ON p.id = wp.person_id
     WHERE wp.work_id = ? ORDER BY wp.ord`,
    workId
  ).map((r) => r.name).join(' ');

  const seriesNames = all(
    `SELECT s.name, sw.position FROM series_works sw
     JOIN series s ON s.id = sw.series_id WHERE sw.work_id = ?`,
    workId
  ).map((r) => `${r.name} ${r.position}`).join(' ');

  const isbns = all(
    'SELECT isbn13, isbn10 FROM editions WHERE work_id = ?',
    workId
  ).flatMap((e) => [e.isbn13, e.isbn10])
    .filter(Boolean)
    .flatMap((i) => [i, i.replace(/-/g, '')])
    .join(' ');

  run('DELETE FROM works_fts WHERE work_id = ?', workId);
  run(
    'INSERT INTO works_fts (title, authors, series, isbns, work_id) VALUES (?, ?, ?, ?, ?)',
    fold([work.title, work.subtitle].filter(Boolean).join(' ')),
    fold(authors),
    fold(seriesNames),
    isbns,
    workId
  );
}

export function reindexAll() {
  run('DELETE FROM works_fts');
  for (const { id } of all('SELECT id FROM works')) reindexWork(id);
}

// ── TIME ─────────────────────────────────────────────────
// SQLite has no date type. Every timestamp in this schema is TEXT, and every
// column default is `datetime('now')`, which writes 'YYYY-MM-DD HH:MM:SS' in
// UTC with no zone marker.
//
// That format is only safe if NOTHING ever writes a different one, because
// these columns are compared as strings. An ISO-8601 value in the same column
// compares WRONG rather than failing loudly: 'T' (0x54) sorts above ' '
// (0x20), so
//
//   '2026-08-25T17:00:00.000Z'  >  '2026-08-25 18:07:02'   →  true
//
// which reads as "this token that expired an hour ago is still valid". So
// every timestamp written from JavaScript goes through sqlTime(), and every
// timestamp read back goes through parseSQLTime().
// Idempotent on purpose. A value that is ALREADY in the stored format must
// come back unchanged: `new Date('2026-08-25 17:27:30')` is parsed as LOCAL
// time and re-serialised as UTC, so passing a stored timestamp through here
// a second time silently shifted it by the timezone offset — which turned an
// audit window into one that matched nothing.
const SQL_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const sqlTime = (when = Date.now()) => {
  if (typeof when === 'string' && SQL_SHAPE.test(when)) return when;
  return new Date(when).toISOString().replace('T', ' ').slice(0, 19);
};

export const nowSQL = () => sqlTime(Date.now());

// The stored format carries no zone marker, so Date.parse would read it as
// local time. Appending the Z is what makes it UTC, as SQLite wrote it.
export const parseSQLTime = (t) => {
  if (!t) return 0;
  const s = String(t);
  return Date.parse(/[TZ]$/.test(s) || s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
};
