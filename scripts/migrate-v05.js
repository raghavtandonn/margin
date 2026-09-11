import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// v0.5.1 §1 — teardown migration.
//
// Ratings are plain stars now. The CMY swatch and the K plate are cut, and
// §1.1 is explicit: drop the columns rather than making them nullable,
// because "a nullable field nobody writes to becomes a bug farm."
//
// §1.2 cuts everything multi-user: marginalia, community aggregates, other
// readers. Private notes replace marginalia — a text field on the Reading,
// plus optional per-session notes.

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.MARGIN_DB || join(here, '..', 'data', 'margin.db');
if (!existsSync(DB_PATH)) {
  console.error(`NO DATABASE AT ${DB_PATH}`);
  process.exit(1);
}

const backup = DB_PATH.replace(/\.db$/, `.pre-v05-${Date.now()}.db`);
copyFileSync(DB_PATH, backup);
console.log('"MARGIN" — v0.5.1 TEARDOWN MIGRATION');
console.log(`  BACKUP ${backup}\n`);

const db = new DatabaseSync(DB_PATH);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
const hasTable = (t) =>
  !!get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');

try {
  // ── Ratings become stars on the Reading (§2) ───────────
  // "Rating lives on the Reading record, not the Work, so a re-read gets its
  // own rating and the earlier one survives."
  if (!cols('readings').includes('stars')) {
    db.exec('ALTER TABLE readings ADD COLUMN stars REAL');
    db.exec('ALTER TABLE readings ADD COLUMN review TEXT');
    db.exec('ALTER TABLE readings ADD COLUMN private_note TEXT');
    db.exec('ALTER TABLE readings ADD COLUMN marks TEXT');

    if (hasTable('prints')) {
      // Carry the star across. The CMY channels are discarded outright —
      // they are a cut feature, not data worth keeping.
      const moved = run(`
        UPDATE readings SET
          stars = (SELECT p.stars FROM prints p WHERE p.reading_id = readings.id),
          review = (SELECT p.review FROM prints p WHERE p.reading_id = readings.id),
          private_note = (SELECT p.private_note FROM prints p WHERE p.reading_id = readings.id)
        WHERE EXISTS (SELECT 1 FROM prints p WHERE p.reading_id = readings.id)`).changes;
      console.log(`  RATINGS   ${moved} moved from prints to readings`);

      // A print with no pass still carried a star; attach it to pass 1.
      run(`
        UPDATE readings SET
          stars = COALESCE(stars, (
            SELECT p.stars FROM prints p
            WHERE p.work_id = readings.work_id AND p.user_id = readings.user_id
              AND p.reading_id IS NULL)),
          review = COALESCE(review, (
            SELECT p.review FROM prints p
            WHERE p.work_id = readings.work_id AND p.user_id = readings.user_id
              AND p.reading_id IS NULL))
        WHERE pass_number = 1`);
    }
  }

  // ── §1.1 drop the colour rating system ─────────────────
  if (hasTable('prints')) {
    const orphans = get(
      `SELECT COUNT(*) n FROM prints p
       WHERE p.stars IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM readings r
                         WHERE r.work_id = p.work_id AND r.user_id = p.user_id)`
    ).n;
    // A star with no reading at all: give it a pass so nothing is lost.
    if (orphans) {
      run(`
        INSERT INTO readings (user_id, work_id, edition_id, status, pass_number, stars, review)
        SELECT p.user_id, p.work_id, p.edition_id, 'FINISHED', 1, p.stars, p.review
        FROM prints p
        WHERE p.stars IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM readings r
                          WHERE r.work_id = p.work_id AND r.user_id = p.user_id)`);
      console.log(`  RESCUED   ${orphans} ratings that had no reading pass`);
    }
    db.exec('DROP TABLE prints');
    console.log('  DROPPED   prints (craft / momentum / feeling / K plate)');
  }

  // ── §1.2 everything multi-user ─────────────────────────
  if (hasTable('annotations')) {
    // Marginalia becomes private notes. Your own notes survive as text on
    // the pass; other readers do not exist in this product any more.
    const mine = all(
      `SELECT work_id, group_concat(
         CASE WHEN page IS NOT NULL THEN 'p.' || page || ' — ' || body ELSE body END,
         char(10) || char(10)) AS text
       FROM annotations WHERE user_id = 1 GROUP BY work_id`
    );
    let kept = 0;
    for (const m of mine) {
      const r = get(
        `SELECT id FROM readings WHERE work_id = ? AND user_id = 1
         ORDER BY pass_number DESC LIMIT 1`,
        m.work_id
      );
      if (r) {
        run(
          `UPDATE readings SET private_note =
             CASE WHEN private_note IS NULL OR private_note = '' THEN ?
                  ELSE private_note || char(10) || char(10) || ? END
           WHERE id = ?`,
          m.text, m.text, r.id
        );
        kept++;
      }
    }
    db.exec('DROP TABLE annotations');
    console.log(`  NOTES     ${kept} works kept their own notes; annotations dropped`);
  }

  for (const t of ['arc_requests', 'drops', 'follows']) {
    if (hasTable(t)) {
      db.exec(`DROP TABLE ${t}`);
      console.log(`  DROPPED   ${t}`);
    }
  }

  // Other readers were only ever seeded fixtures.
  const others = get('SELECT COUNT(*) n FROM users WHERE id != 1').n;
  if (others) {
    run('DELETE FROM users WHERE id != 1');
    console.log(`  DROPPED   ${others} other readers`);
  }

  // Sessions keep their own note field (§1.2: "optional per-session notes
  // with a page number").
  if (!cols('sessions').includes('note')) {
    db.exec('ALTER TABLE sessions ADD COLUMN note TEXT');
  }

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('  MIGRATION FAILED, ROLLED BACK:', err.message);
  console.error(`  YOUR DATA IS UNCHANGED. BACKUP AT ${backup}`);
  process.exit(1);
}

db.exec('PRAGMA foreign_keys = ON');

const rated = get('SELECT COUNT(*) n FROM readings WHERE stars IS NOT NULL').n;
const notes = get(`SELECT COUNT(*) n FROM readings WHERE private_note IS NOT NULL AND private_note != ''`).n;
const reviews = get(`SELECT COUNT(*) n FROM readings WHERE review IS NOT NULL AND review != ''`).n;

console.log(`\n  READINGS  ${get('SELECT COUNT(*) n FROM readings').n}`);
console.log(`  RATED     ${rated}`);
console.log(`  REVIEWS   ${reviews}`);
console.log(`  NOTES     ${notes}`);
console.log('\n  RATINGS ARE STARS. NO COLOUR DERIVES FROM A RATING.');
