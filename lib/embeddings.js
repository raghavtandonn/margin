import { get, all, run } from '../db/index.js';

// ── THE EMBEDDING STORE (recommendation spec §02) ────────
//
// One vector per (work, kind, version), computed once and read everywhere.
// The store knows nothing about recommendations; consumers know nothing
// about how the vectors were produced. That separation is the whole point:
// a new embedding version can be registered, backfilled and validated on its
// own without touching a single consumer.
//
// Three rules, all of them load-bearing:
//
//   FROZEN AT WRITE   A stored vector is never recomputed in place. New
//                     model, new version row. The colour system lost a day
//                     to a frozen table diverging from a recomputed one.
//
//   NORMALISED AT WRITE  Cosine similarity is then a dot product, computed
//                     once rather than on every comparison.
//
//   ABSENCE IS A STATE  A book with no usable input gets no row. Never a
//                     zero vector: the origin is a real location in the
//                     space, and putting a book there asserts that it is
//                     maximally neutral rather than that it is unknown.

/** The kinds the spec defines. A kind not in this list is a typo. */
export const KINDS = Object.freeze([
  'text-blurb', 'text-criticism', 'text-plot',
  'clip-jacket', 'colour-oklab', 'colour-components'
]);

/**
 * L2-normalise in place and return the same array.
 *
 * A zero-length vector cannot be normalised, and normalising it to zeros
 * would be exactly the lie the absence rule forbids — so it throws rather
 * than storing something meaningless.
 */
export function normalise(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error('cannot normalise a zero or non-finite vector');
  }
  for (let i = 0; i < values.length; i++) values[i] /= norm;
  return values;
}

const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
const fromBlob = (buf) => new Float32Array(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
);

/**
 * Store a vector. Normalises first, so no caller can put an unnormalised
 * vector in "just in case".
 *
 * Writing the same (work, kind, version) twice is refused rather than
 * silently updated — that is what "frozen at write" means in practice.
 */
export function put(workId, kind, version, values, { sourceRef = null, sourceChars = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown embedding kind "${kind}"`);
  const vec = normalise(Array.from(values));
  run(
    `INSERT INTO embeddings (work_id, kind, version, dim, vec, source_ref, source_chars)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_id, kind, version) DO NOTHING`,
    Number(workId), kind, version, vec.length, toBlob(vec), sourceRef, sourceChars
  );
  return vec.length;
}

/** One vector, or null. Null means absent, which is a legitimate answer. */
export function vectorFor(workId, kind, version) {
  const row = get(
    'SELECT vec FROM embeddings WHERE work_id = ? AND kind = ? AND version = ?',
    Number(workId), kind, version
  );
  return row ? fromBlob(row.vec) : null;
}

/** Every vector of a kind, as a Map keyed by work_id. One query, one pass. */
export function allOf(kind, version) {
  const out = new Map();
  for (const row of all(
    'SELECT work_id, vec FROM embeddings WHERE kind = ? AND version = ?', kind, version
  )) {
    out.set(row.work_id, fromBlob(row.vec));
  }
  return out;
}

/**
 * Cosine similarity. Both vectors are normalised at write, so this is a dot
 * product — no division, no repeated square roots.
 *
 * 411 books x 384 dims is roughly 158k multiplies for a full-catalogue scan,
 * which is sub-millisecond. No vector database, no ANN index; revisit above
 * ~100,000 books, which this is not.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** The weighted mean of several vectors, renormalised. Absent vectors are
 *  skipped rather than counted as zero — see the absence rule above. */
export function centroid(vectors, weights = null) {
  const list = vectors.map((vec, i) => ({ vec, weight: weights ? weights[i] : 1 }))
    .filter(item => item.vec);
  if (!list.length) return null;
  const dim = list[0].vec.length;
  const out = new Float64Array(dim);
  let total = 0;
  list.forEach(({ vec: v, weight: w }) => {
    if (!w) return;
    total += Math.abs(w);
    for (let d = 0; d < dim; d++) out[d] += v[d] * w;
  });
  if (!total) return null;
  try { return Float32Array.from(normalise(Array.from(out))); }
  catch { return null; }   // every weight cancelled out; no defensible centre
}

/** Coverage for the audit: how many works carry a kind, and how many do not. */
export function coverage(kind, version) {
  const have = get(
    'SELECT COUNT(*) n FROM embeddings WHERE kind = ? AND version = ?', kind, version
  ).n;
  const works = get('SELECT COUNT(*) n FROM works').n;
  return { kind, version, have, works, missing: works - have };
}
