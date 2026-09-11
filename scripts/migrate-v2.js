import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Migrates a v0.1 database to the v0.2/v0.3 shape:
//
//   • prints: CMY becomes nullable, `stars` (the K plate) added.
//     An imported C=M=Y=stars×20 row becomes a K-only row — the muddy
//     composite is discarded and the star value it was derived from is kept.
//   • readings: pass_number, format, position_type, total_positions added,
//     and the (user, work) uniqueness dropped so re-reads can exist.
//   • progress_events becomes sessions.
//
// SQLite cannot relax NOT NULL in place, so the tables are rebuilt.

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.MARGIN_DB || join(here, '..', 'data', 'margin.db');

if (!existsSync(DB_PATH)) {
  console.error(`NO DATABASE AT ${DB_PATH}`);
  process.exit(1);
}

const backup = DB_PATH.replace(/\.db$/, `.pre-v2-${Date.now()}.db`);
copyFileSync(DB_PATH, backup);
console.log('"MARGIN" — MIGRATING TO v0.2 / v0.3');
console.log(`  BACKUP ${backup}\n`);

const db = new DatabaseSync(DB_PATH);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);

const printCols = cols('prints');
if (printCols.includes('stars')) {
  console.log('  ALREADY MIGRATED.');
  process.exit(0);
}

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');

try {
  // ── readings ───────────────────────────────────────────
  const readingCols = cols('readings');
  if (!readingCols.includes('pass_number')) {
    db.exec(`
      CREATE TABLE readings_new (
        id              INTEGER PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        work_id         INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        edition_id      INTEGER REFERENCES editions(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'READING',
        pass_number     INTEGER NOT NULL DEFAULT 1,
        format          TEXT NOT NULL DEFAULT 'print',
        position_type   TEXT NOT NULL DEFAULT 'page',
        current_page    REAL NOT NULL DEFAULT 0,
        total_positions REAL,
        started_at      TEXT,
        finished_at     TEXT,
        abandoned_at    TEXT,
        abandoned_page  REAL,
        due_date        TEXT,
        due_extensions  INTEGER NOT NULL DEFAULT 0,
        due_notified    INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

    // total_positions seeds from the chosen edition's page count so the
    // impression counter has a denominator from the first log.
    run(`
      INSERT INTO readings_new
        (id, user_id, work_id, edition_id, status, pass_number, format, position_type,
         current_page, total_positions, started_at, finished_at, abandoned_at,
         abandoned_page, due_date, due_extensions, due_notified, created_at)
      SELECT r.id, r.user_id, r.work_id, r.edition_id, r.status, 1, 'print', 'page',
             r.current_page, e.page_count, r.started_at, r.finished_at, r.abandoned_at,
             r.abandoned_page, r.due_date, r.due_extensions, r.due_notified, r.created_at
      FROM readings r LEFT JOIN editions e ON e.id = r.edition_id`);

    db.exec('DROP TABLE readings');
    db.exec('ALTER TABLE readings_new RENAME TO readings');
    db.exec(`CREATE INDEX idx_readings_user_status ON readings(user_id, status)`);
    db.exec(`CREATE INDEX idx_readings_user_work ON readings(user_id, work_id)`);
    db.exec(`CREATE UNIQUE INDEX idx_readings_pass ON readings(user_id, work_id, pass_number)`);
    console.log(`  READINGS  ${get('SELECT COUNT(*) n FROM readings').n} migrated (pass 1)`);
  }

  // ── sessions ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id               INTEGER PRIMARY KEY,
      reading_id       INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
      position         REAL NOT NULL,
      position_type    TEXT,
      logged_at        TEXT NOT NULL DEFAULT (datetime('now')),
      occurred_at      TEXT NOT NULL DEFAULT (datetime('now')),
      duration_minutes INTEGER,
      note             TEXT,
      source           TEXT NOT NULL DEFAULT 'manual'
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_reading ON sessions(reading_id, occurred_at)');

  const hasEvents = get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='progress_events'`
  );
  if (hasEvents) {
    run(`
      INSERT INTO sessions (reading_id, position, position_type, logged_at, occurred_at, source)
      SELECT pe.reading_id, pe.page, 'page', pe.at, pe.at, 'import'
      FROM progress_events pe
      JOIN readings r ON r.id = pe.reading_id`);
    console.log(`  SESSIONS  ${get('SELECT COUNT(*) n FROM sessions').n} from progress_events`);
    db.exec('DROP TABLE progress_events');
  }

  // ── prints: the K plate ────────────────────────────────
  db.exec(`
    CREATE TABLE prints_new (
      id            INTEGER PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      edition_id    INTEGER REFERENCES editions(id) ON DELETE SET NULL,
      reading_id    INTEGER REFERENCES readings(id) ON DELETE SET NULL,
      craft         INTEGER CHECK (craft IS NULL OR craft BETWEEN 0 AND 100),
      momentum      INTEGER CHECK (momentum IS NULL OR momentum BETWEEN 0 AND 100),
      feeling       INTEGER CHECK (feeling IS NULL OR feeling BETWEEN 0 AND 100),
      stars         REAL CHECK (stars IS NULL OR (stars > 0 AND stars <= 5)),
      source        TEXT NOT NULL DEFAULT 'native',
      review        TEXT,
      private_note  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

  // An imported row keeps only the star it came from: the C=M=Y composite was
  // never the reader's judgment, it was a derivation. A native row keeps its
  // channels. A row that was imported with no star at all (a review with no
  // rating) becomes a blank chip that still carries its review.
  run(`
    INSERT INTO prints_new
      (id, user_id, work_id, edition_id, reading_id, craft, momentum, feeling,
       stars, source, review, created_at, updated_at)
    SELECT
      p.id, p.user_id, p.work_id, p.edition_id,
      (SELECT r.id FROM readings r
        WHERE r.user_id = p.user_id AND r.work_id = p.work_id
        ORDER BY r.pass_number DESC LIMIT 1),
      CASE WHEN p.imported = 1 THEN NULL ELSE p.craft END,
      CASE WHEN p.imported = 1 THEN NULL ELSE p.momentum END,
      CASE WHEN p.imported = 1 THEN NULL ELSE p.feeling END,
      p.legacy_stars,
      CASE WHEN p.imported = 1 THEN COALESCE(p.import_source, 'goodreads') ELSE 'native' END,
      p.review, p.created_at, p.updated_at
    FROM prints p`);

  db.exec('DROP TABLE prints');
  db.exec('ALTER TABLE prints_new RENAME TO prints');
  db.exec('CREATE INDEX idx_prints_work ON prints(work_id)');
  db.exec('CREATE UNIQUE INDEX idx_prints_reading ON prints(reading_id) WHERE reading_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX idx_prints_loose ON prints(user_id, work_id) WHERE reading_id IS NULL');

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('  MIGRATION FAILED, ROLLED BACK:', err.message);
  console.error(`  YOUR DATA IS UNCHANGED. BACKUP AT ${backup}`);
  process.exit(1);
}

db.exec('PRAGMA foreign_keys = ON');

const k = get('SELECT COUNT(*) n FROM prints WHERE stars IS NOT NULL AND craft IS NULL').n;
const cmy = get('SELECT COUNT(*) n FROM prints WHERE craft IS NOT NULL').n;
const blank = get('SELECT COUNT(*) n FROM prints WHERE craft IS NULL AND stars IS NULL').n;

console.log(`  PRINTS    ${k} K-plate · ${cmy} CMY · ${blank} blank`);
console.log(`  REVIEWS   ${get('SELECT COUNT(*) n FROM prints WHERE review IS NOT NULL').n} retained`);
console.log('\n  DONE. IMPORTED RATINGS ARE NOW ONE-PLATE CHIPS —');
console.log('  A FINISHED STATE, NOT A PROMPT.');
