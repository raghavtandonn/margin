import { all, get, run, db } from '../db/index.js';
import { tokenize } from './vectors.js';

// ── "THE GAP" ────────────────────────────────────────────
// One book per month. It cannot be requested more often and there is no
// refresh button — the constraint is the feature.
//
// The point is NOT more of what the reader likes. It is the book maximally
// distant from the centre of their taste that is nonetheless anchored to one
// book they loved. Body Meets Dress: the deliberate lump, not the flattering
// silhouette.

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_corpus (
      id        INTEGER PRIMARY KEY,
      title     TEXT NOT NULL,
      author    TEXT NOT NULL,
      year      INTEGER,
      subjects  TEXT NOT NULL,
      ol_key    TEXT,
      cover_id  INTEGER
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_picks (
      month       TEXT PRIMARY KEY,     -- YYYY-MM: one per month, enforced
      corpus_id   INTEGER NOT NULL REFERENCES gap_corpus(id),
      anchor_work INTEGER REFERENCES works(id),
      dismissed   INTEGER NOT NULL DEFAULT 0,
      added       INTEGER NOT NULL DEFAULT 0,
      picked_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

// A document vector in the same lexical space the desk uses, so distances
// are comparable to everything else.
function vectorOf(text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, f] of tf) {
    const w = 1 + Math.log(f);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

const cosine = (a, b) => {
  let s = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o) s += w * o;
  }
  return s;
};

function centroid(vectors) {
  const c = new Map();
  for (const v of vectors) for (const [t, w] of v) c.set(t, (c.get(t) || 0) + w);
  let norm = 0;
  for (const w of c.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of c) c.set(t, w / norm);
  return c;
}

const subjectsOf = (json) => {
  try { return (JSON.parse(json || '[]') || []).join(' '); } catch { return ''; }
};

// ── The pick ─────────────────────────────────────────────
export function pickForMonth(userId, { month = currentMonth(), force = false } = {}) {
  ensureTables();

  const existing = get('SELECT * FROM gap_picks WHERE month = ?', month);
  if (existing && !force) return hydratePick(existing);

  const loved = all(
    `SELECT w.id, w.title, w.subjects, w.blurb
     FROM readings r JOIN works w ON w.id = r.work_id
     WHERE r.user_id = ? AND r.stars >= 4`,
    Number(userId)
  ).map((b) => ({ ...b, vec: vectorOf(`${b.title} ${subjectsOf(b.subjects)} ${b.blurb || ''}`) }))
   .filter((b) => b.vec.size);

  // Nothing to be distant from yet.
  if (loved.length < 3) return null;

  const T = centroid(loved.map((b) => b.vec));

  const inLibrary = new Set(
    all('SELECT lower(title) t FROM works').map((r) => r.t)
  );
  const libraryAuthors = new Set(
    all(`SELECT lower(p.name) n FROM people p JOIN work_people wp ON wp.person_id = p.id
         WHERE wp.role = 'AUTHOR'`).map((r) => r.n)
  );

  const corpus = all('SELECT * FROM gap_corpus');
  if (!corpus.length) return null;

  const scored = [];
  for (const c of corpus) {
    if (inLibrary.has(String(c.title).toLowerCase())) continue;
    // An author already in the library is not a gap.
    if (libraryAuthors.has(String(c.author).toLowerCase())) continue;

    const v = vectorOf(`${c.title} ${c.subjects}`);
    if (!v.size) continue;

    const distance = 1 - cosine(v, T);

    // The anchor is the single loved book that is nearest to it — the door
    // the reader already owns.
    let anchor = null;
    let best = 0;
    for (const b of loved) {
      const s = cosine(v, b.vec);
      if (s > best) { best = s; anchor = b; }
    }
    if (!anchor || best <= 0) continue;

    scored.push({ c, anchor, score: Math.pow(distance, 1.5) * best });
  }

  if (!scored.length) return null;

  // Top 30 by score, then weighted-random among them so it differs month to
  // month without becoming arbitrary.
  scored.sort((a, b) => b.score - a.score);
  const pool = scored.slice(0, 30);
  const total = pool.reduce((s, p) => s + p.score, 0);
  let r = Math.random() * total;
  let chosen = pool[0];
  for (const p of pool) {
    r -= p.score;
    if (r <= 0) { chosen = p; break; }
  }

  run(
    `INSERT INTO gap_picks (month, corpus_id, anchor_work) VALUES (?, ?, ?)
     ON CONFLICT (month) DO UPDATE SET corpus_id = excluded.corpus_id, anchor_work = excluded.anchor_work,
       dismissed = 0, added = 0, picked_at = datetime('now')`,
    month, chosen.c.id, chosen.anchor.id
  );

  return hydratePick(get('SELECT * FROM gap_picks WHERE month = ?', month));
}

function hydratePick(row) {
  if (!row) return null;
  const book = get('SELECT * FROM gap_corpus WHERE id = ?', row.corpus_id);
  if (!book) return null;
  const anchor = row.anchor_work ? get('SELECT id, title FROM works WHERE id = ?', row.anchor_work) : null;
  return {
    month: row.month,
    dismissed: !!row.dismissed,
    added: !!row.added,
    book: {
      ...book,
      // Same-origin, so img-src stays 'self' and Open Library is not told
      // which book a reader is being shown this month.
      cover: book.cover_id ? `/cover/ol/${book.cover_id}.jpg` : null
    },
    anchor
  };
}

export function currentGap(userId) {
  ensureTables();
  const month = currentMonth();
  const row = get('SELECT * FROM gap_picks WHERE month = ?', month);
  if (row) return row.dismissed ? null : hydratePick(row);
  return pickForMonth(userId, { month });
}

// A dismissed Gap does not return until next month.
export function dismissGap(month = currentMonth()) {
  ensureTables();
  run('UPDATE gap_picks SET dismissed = 1 WHERE month = ?', month);
}

export function markAdded(month = currentMonth()) {
  ensureTables();
  run('UPDATE gap_picks SET added = 1 WHERE month = ?', month);
}

export const corpusSize = () => {
  ensureTables();
  return get('SELECT COUNT(*) n FROM gap_corpus').n;
};
