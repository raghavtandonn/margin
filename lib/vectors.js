import { all, get, run, db } from '../db/index.js';
import { notesForIndexing } from './notes.js';

// ── TIER 2: THE LOCAL SEMANTIC INDEX ─────────────────────
//
// §11 requires that search work with the network disconnected and that note
// text never leave the device. That rules out a hosted embedding model, and
// shipping a transformer is not proportionate to a 400-book library.
//
// So the vector space here is lexical: TF-IDF over the words that describe a
// book (title, author, subject headings, blurb) and over the reader's own
// note text, scored by cosine. It is honest about what it is — this finds
// "books about grief" because the subject headings say grief, not because a
// network learned that grief and mourning are neighbours.
//
// Only catalogue vectors are persisted. Private notes are read for their
// owner at query time and scored in memory, without a shared note index.

export const MODEL_ID = 'tfidf-v1';

const STOP = new Set(`a an the and or but if then else of in on at to for with without from by as is are was were be been being it its this that these those他 not no nor so than too very can will just dont should now about into over under again further once here there all any both each few more most other some such only own same s t don now d ll m o re ve y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn i me my we our you your he him his she her they them their what which who whom when where why how`.split(/\s+/));

// Light stemming: enough to bring plurals and common inflections together
// without dragging in a stemmer library.
function stem(w) {
  if (w.length <= 3) return w;
  return w
    .replace(/(ational|ization|iveness|fulness|ousness)$/, '')
    .replace(/(ations|itions|ements)$/, '')
    .replace(/(ing|edly|ies|ied|ies)$/, (m) => (m === 'ies' || m === 'ied' ? 'y' : ''))
    .replace(/(ed|es|s)$/, '')
    .replace(/(ly|ness|ment|able|ible)$/, '')
    || w;
}

export function tokenize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 2);
}

// Term frequencies for one document, with fields weighted by how much they
// say about what a book is about.
function termFreq(fields) {
  const tf = new Map();
  for (const [text, weight] of fields) {
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + weight);
  }
  return tf;
}

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_vectors (
      kind      TEXT NOT NULL,        -- 'book' | 'note'
      ref_id    INTEGER NOT NULL,     -- work id, or reading id for a note
      work_id   INTEGER NOT NULL,
      excerpt   TEXT,                 -- for a note: the reader's own words
      terms     TEXT NOT NULL,        -- JSON { term: weight }
      model     TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, ref_id)
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_desk_vectors_work ON desk_vectors(work_id)');
}

// ── Building the index ───────────────────────────────────
export function reindex({ onProgress } = {}) {
  ensureTable();

  const books = all(`
    SELECT w.id, w.title, w.subtitle, w.subjects, w.blurb, w.first_lines,
           (SELECT group_concat(p.name, ' ') FROM work_people wp JOIN people p ON p.id = wp.person_id
            WHERE wp.work_id = w.id) AS people,
           (SELECT group_concat(s.name, ' ') FROM series_works sw JOIN series s ON s.id = sw.series_id
            WHERE sw.work_id = w.id) AS series,
           (SELECT group_concat(DISTINCT e.publisher) FROM editions e WHERE e.work_id = w.id) AS publishers
    FROM works w`);

  // This shared index contains catalogue metadata only.
  const docs = [];

  for (const b of books) {
    let subjects = '';
    try {
      subjects = (JSON.parse(b.subjects || '[]') || []).join(' ');
    } catch { /* unparseable subjects are simply absent */ }

    const tf = termFreq([
      [b.title, 3],
      [b.subtitle, 2],
      [b.people, 3],
      [b.series, 2],
      // Subjects are the strongest signal for what a book is ABOUT.
      [subjects, 4],
      [b.blurb, 2],
      [b.first_lines, 1],
      [b.publishers, 1]
    ]);
    if (tf.size) docs.push({ kind: 'book', ref_id: b.id, work_id: b.id, excerpt: null, tf });
  }

  // Persist catalogue documents only. Private notes are scored for their
  // owner at query time, so edits/deletions take effect immediately and no
  // plaintext copy or revealing term dictionary lands in the database.

  // Document frequency across the whole corpus.
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1;

  run('DELETE FROM desk_vectors');
  const insert = db.prepare(
    `INSERT INTO desk_vectors (kind, ref_id, work_id, excerpt, terms, model)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const [i, d] of docs.entries()) {
      const weights = {};
      let norm = 0;
      for (const [t, f] of d.tf) {
        const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
        const w = (1 + Math.log(f)) * idf;
        weights[t] = Number(w.toFixed(4));
        norm += w * w;
      }
      norm = Math.sqrt(norm) || 1;
      // Store already normalised, so scoring is a plain dot product.
      for (const t of Object.keys(weights)) weights[t] = Number((weights[t] / norm).toFixed(5));

      insert.run(d.kind, d.ref_id, d.work_id, d.excerpt, JSON.stringify(weights), MODEL_ID);
      if (onProgress && (i + 1) % 100 === 0) onProgress(i + 1, docs.length);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  cache = null;
  return {
    books: docs.filter((d) => d.kind === 'book').length,
    notes: docs.filter((d) => d.kind === 'note').length,
    vocabulary: df.size
  };
}

// ── Searching ────────────────────────────────────────────
// The whole index is a few hundred kilobytes, so it loads once and lives in
// memory. Revisit past roughly twenty thousand documents.
let cache = null;

function load() {
  if (cache) return cache;
  ensureTable();
  const rows = all("SELECT kind, ref_id, work_id, excerpt, terms FROM desk_vectors WHERE kind = 'book'");

  const postings = new Map(); // term -> [{ i, w }]
  const docs = rows.map((r, i) => {
    let terms = {};
    try { terms = JSON.parse(r.terms); } catch { /* skip a corrupt row */ }
    for (const [t, w] of Object.entries(terms)) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push({ i, w });
    }
    return { kind: r.kind, ref_id: r.ref_id, work_id: r.work_id, excerpt: r.excerpt };
  });

  cache = { docs, postings, size: rows.length };
  return cache;
}

export const invalidate = () => { cache = null; };
export const indexSize = () => load().size;

// Returns work_id -> { score, kind, excerpt } for the best-matching document
// per work. A book scores max(book similarity, best note similarity), and
// when a note wins, that note is what gets surfaced (§4, §7).
export function semanticSearch(text, { userId = null, limit = 60, floor = 0.06 } = {}) {
  const { docs, postings } = load();
  const terms = tokenize(text);
  if (!terms.length) return [];

  // Query vector, normalised the same way.
  const qtf = new Map();
  for (const t of terms) qtf.set(t, (qtf.get(t) || 0) + 1);
  let qnorm = 0;
  for (const f of qtf.values()) qnorm += (1 + Math.log(f)) ** 2;
  qnorm = Math.sqrt(qnorm) || 1;

  const scores = new Float64Array(docs.length);
  for (const [t, f] of qtf) {
    const list = postings.get(t);
    if (!list) continue;
    const qw = (1 + Math.log(f)) / qnorm;
    for (const { i, w } of list) scores[i] += qw * w;
  }

  const best = new Map();
  for (let i = 0; i < docs.length; i++) {
    const s = scores[i];
    if (s < floor) continue;
    const d = docs[i];
    const prev = best.get(d.work_id);
    if (!prev || s > prev.score) {
      best.set(d.work_id, { score: s, kind: d.kind, excerpt: d.kind === 'note' ? d.excerpt : null });
    }
  }

  if (userId != null) {
    const ownNotes = notesForIndexing(userId);
    const reviews = all('SELECT id, work_id, review FROM readings WHERE user_id = ? AND review IS NOT NULL', Number(userId));
    const byReading = new Map(ownNotes.map(n => [n.readingId, { work_id: n.workId, text: n.text }]));
    for (const r of reviews) {
      const prior = byReading.get(r.id);
      byReading.set(r.id, { work_id: r.work_id, text: [prior?.text, r.review].filter(Boolean).join('\n\n') });
    }
    for (const n of byReading.values()) {
      const tf = termFreq([[n.text, 1]]);
      let norm = 0;
      let score = 0;
      for (const [term, frequency] of tf) {
        const weight = 1 + Math.log(frequency);
        norm += weight * weight;
        if (qtf.has(term)) score += weight * (1 + Math.log(qtf.get(term))) / qnorm;
      }
      score /= Math.sqrt(norm) || 1;
      if (score >= floor && score > (best.get(n.work_id)?.score || 0)) {
        best.set(n.work_id, { score, kind: 'note', excerpt: n.text });
      }
    }
  }

  return [...best.entries()]
    .map(([work_id, v]) => ({ work_id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// §7 — a matched note is quoted verbatim, never summarised, and never cut
// mid-word.
export function noteExcerpt(text, query, max = 120) {
  if (!text) return null;
  const body = String(text).replace(/\s+/g, ' ').trim();
  if (body.length <= max) return body;

  // Prefer the window around the first query term that actually appears.
  const terms = tokenize(query);
  let at = -1;
  for (const t of terms) {
    const i = body.toLowerCase().indexOf(t.slice(0, Math.max(4, t.length - 1)));
    if (i >= 0) { at = i; break; }
  }

  let start = at < 0 ? 0 : Math.max(0, at - 40);
  if (start > 0) {
    const sp = body.indexOf(' ', start);
    start = sp === -1 ? start : sp + 1;
  }

  let slice = body.slice(start, start + max);
  if (start + max < body.length) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 40) slice = slice.slice(0, lastSpace);
    slice += '…';
  }
  return (start > 0 ? '…' : '') + slice;
}

/**
 * The stored term vector for one work, as a Map.
 *
 * §4.3 clusters a season's books over "the same vectors the desk builds" —
 * so this reads the index rather than recomputing anything, and returns
 * null for a work that was never indexed rather than an empty Map that
 * would silently join every cluster.
 */
export function vectorForWork(workId) {
  // The index may never have been built — a fresh install, or a library
  // imported but not yet indexed. §4.3 reports no clusters in that case,
  // which is a legitimate answer; throwing would take the whole season
  // down for want of an optional fact.
  let row = null;
  try {
    row = get(
      `SELECT terms FROM desk_vectors WHERE kind = 'book' AND work_id = ? LIMIT 1`,
      Number(workId)
    );
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const terms = JSON.parse(row.terms);
    const m = new Map(Object.entries(terms));
    return m.size ? m : null;
  } catch {
    return null;
  }
}
