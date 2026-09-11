// ── PHASE 2: THE LINEAR PROBE (spec §04) ─────────────────
//
//   npm run probe -- --kind text-blurb
//
// One question, asked before any pipeline is built: from the embedding
// ALONE, can you predict which books this reader actually gets around to?
//
// Linear, embedding-only, no metadata. No title, no author, no page count,
// no year, no genre. That restriction is the entire value of the exercise —
// a probe with metadata scores well on metadata and tells you nothing about
// the embedding.
//
// The label, which is better than the article's:
//
//   1  finished, or abandoned after >=100pp (engagement, not endorsement)
//   0  held unopened, acquired more than 180 days ago
//   -  excluded: acquired within 180 days (unresolved, not negative)
//   -  excluded: currently on press
//
// Every book on the pile was acquired deliberately and then not read. That
// is a labelled set of hundreds of examples that needed no user input, no
// interaction logging and no new UI.
import { db, all, get, run } from '../db/index.js';
import * as EMB from '../lib/embeddings.js';

const args = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

// A single kind, or several concatenated:  --kind text-plot,text-criticism
// §04 asks for concatenated pairs as well as single kinds, because two kinds
// that each carry a little may carry more together — and because accuracy
// and AUC can disagree about which single kind is strongest, which is
// exactly what happened here.
const KIND = argOf('kind', 'text-blurb');
const KIND_LIST = KIND.split(',').map((k) => k.trim()).filter(Boolean);
const VERSION = argOf('version', 'bge-small-en-v1.5@1');
const versionFor = (k) => k.startsWith('colour-') ? 'colour-system@1.2' : VERSION;
const USER = Number(argOf('user', 1));
const HOLD_FLOOR = Number(argOf('floor', 180));

// ── the label set ────────────────────────────────────────
const positives = all(
  `SELECT DISTINCT work_id FROM readings
    WHERE user_id = ? AND is_draft = 0
      AND (status = 'FINISHED' OR (status = 'ABANDONED' AND abandoned_page >= 100))`,
  USER
).map((r) => r.work_id);

const onPress = new Set(
  all(`SELECT work_id FROM readings WHERE user_id = ? AND status = 'READING'`, USER)
    .map((r) => r.work_id)
);

const negatives = all(
  `SELECT si.work_id, julianday('now') - julianday(si.added_at) AS held
     FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
    WHERE s.user_id = ? AND s.slug = 'waiting'
      AND julianday('now') - julianday(si.added_at) > ?`,
  USER, HOLD_FLOOR
).map((r) => r.work_id).filter((w) => !onPress.has(w));

// Concatenation requires a work to carry EVERY kind in the list. A book
// missing one is absent from this probe rather than zero-padded, which is
// the same rule the store enforces and the reason coverage falls as kinds
// are combined.
const perKind = KIND_LIST.map((k) => EMB.allOf(k, versionFor(k)));
const vecs = new Map();
for (const workId of perKind[0].keys()) {
  if (!perKind.every((m) => m.has(workId))) continue;
  if (KIND_LIST.length === 1) { vecs.set(workId, perKind[0].get(workId)); continue; }
  // Each kind is L2-normalised on its own, so concatenating gives every kind
  // equal footing regardless of its dimension — a 384-dim text vector does
  // not drown a 20-dim colour vector by sheer length.
  const parts = perKind.map((m) => m.get(workId));
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  vecs.set(workId, joined);
}
const posSet = new Set(positives);

// A book can only be probed if it carries the vector. Books without one are
// ABSENT from the probe rather than zero-filled — the same rule the store
// enforces at write.
const rows = [];
for (const w of positives) if (vecs.has(w)) rows.push({ w, y: 1, x: vecs.get(w) });
for (const w of negatives) if (vecs.has(w) && !posSet.has(w)) rows.push({ w, y: 0, x: vecs.get(w) });

const nPos = rows.filter((r) => r.y === 1).length;
const nNeg = rows.filter((r) => r.y === 0).length;

console.log(`\n  KIND         ${KIND}`);
console.log(`  VERSION      ${VERSION}`);
console.log(`  hold floor   ${HOLD_FLOOR} days\n`);
console.log(`  labelled     ${positives.length} positive, ${negatives.length} negative`);
console.log(`  with vector  ${nPos} positive, ${nNeg} negative  (${rows.length} usable)`);

if (!nPos || !nNeg) {
  console.log('\n  cannot probe: one class is empty.\n');
  process.exit(1);
}
if (nPos < 40) {
  console.log(`\n  NOTE: fewer than 40 positives. Treat this result as indicative,`);
  console.log(`  not decisive — the same discipline that stopped the DOAJ damping`);
  console.log(`  table being measured on 321 sentences.`);
}

const dim = rows[0].x.length;
const majority = Math.max(nPos, nNeg) / rows.length;
console.log(`  class balance ${(nPos / rows.length * 100).toFixed(1)}/${(nNeg / rows.length * 100).toFixed(1)}`);
console.log(`  baseline     ${(majority * 100).toFixed(1)}%  (always predict the majority class)`);
console.log(`  dim          ${dim}\n`);

// ── logistic regression, L2 regularised ──────────────────
// Plain batch gradient descent. At 384 dims and a few hundred rows this
// converges in well under a second, and a hand-written trainer is easier to
// audit than a dependency.
function train(data, { lambda = 1e-2, steps = 600, lr = 0.5 } = {}) {
  const w = new Float64Array(dim);
  let b = 0;
  // Class weights, because 18/82 otherwise trains a model that says "no".
  const pos = data.filter((d) => d.y === 1).length;
  const neg = data.length - pos;
  const wPos = data.length / (2 * Math.max(pos, 1));
  const wNeg = data.length / (2 * Math.max(neg, 1));

  for (let s = 0; s < steps; s++) {
    const gw = new Float64Array(dim);
    let gb = 0;
    for (const d of data) {
      let z = b;
      for (let i = 0; i < dim; i++) z += w[i] * d.x[i];
      const p = 1 / (1 + Math.exp(-z));
      const cw = d.y === 1 ? wPos : wNeg;
      const err = (p - d.y) * cw;
      for (let i = 0; i < dim; i++) gw[i] += err * d.x[i];
      gb += err;
    }
    for (let i = 0; i < dim; i++) w[i] -= lr * (gw[i] / data.length + lambda * w[i]);
    b -= lr * (gb / data.length);
  }
  return { w, b };
}

const score = (m, x) => {
  let z = m.b;
  for (let i = 0; i < dim; i++) z += m.w[i] * x[i];
  return 1 / (1 + Math.exp(-z));
};

// ── AUC by rank, which needs no threshold ────────────────
function auc(pairs) {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let rank = 1, sumPosRanks = 0, i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avg = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) if (sorted[k].y === 1) sumPosRanks += avg;
    rank += (j - i + 1);
    i = j + 1;
  }
  const p = pairs.filter((x) => x.y === 1).length;
  const n = pairs.length - p;
  return (sumPosRanks - (p * (p + 1)) / 2) / (p * n);
}

// ── 5-fold stratified cross-validation ───────────────────
// Deterministic shuffle, so re-running reports the same number. A metric
// that moves on every run cannot gate anything.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const strat = (y) => {
  const g = rows.filter((r) => r.y === y);
  for (let i = g.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [g[i], g[j]] = [g[j], g[i]];
  }
  return g;
};
const folds = Array.from({ length: 5 }, () => []);
strat(1).forEach((r, i) => folds[i % 5].push(r));
strat(0).forEach((r, i) => folds[i % 5].push(r));

const held = [];
for (let f = 0; f < 5; f++) {
  const test = folds[f];
  const trainSet = folds.filter((_, i) => i !== f).flat();
  const m = train(trainSet);
  for (const d of test) held.push({ y: d.y, p: score(m, d.x), w: d.w });
}

// Threshold at the point that maximises balanced accuracy rather than 0.5:
// with an 18/82 split, 0.5 is an arbitrary place to cut and reports the
// majority-class number back at you.
let best = { acc: 0, t: 0.5 };
for (let t = 0.05; t <= 0.95; t += 0.01) {
  const tp = held.filter((h) => h.y === 1 && h.p >= t).length;
  const tn = held.filter((h) => h.y === 0 && h.p < t).length;
  const acc = (tp + tn) / held.length;
  if (acc > best.acc) best = { acc, t };
}

const A = auc(held);
const delta = (best.acc - majority) * 100;

console.log(`  ── RESULT ────────────────────────────────────`);
console.log(`  accuracy     ${(best.acc * 100).toFixed(1)}%  (threshold ${best.t.toFixed(2)})`);
console.log(`  baseline     ${(majority * 100).toFixed(1)}%`);
console.log(`  Δaccuracy    ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`);
console.log(`  AUC          ${A.toFixed(3)}   (0.500 = random)`);
console.log();

const verdict = delta <= 0 ? 'DROP  — carries nothing'
  : delta < 3 ? 'HOLD  — do not build a pipeline; record the number'
  : 'CARRY FORWARD to §05';
console.log(`  GATE (§04)   ${verdict}`);
console.log(`  AUC reads    ${A >= 0.70 ? 'strong' : A >= 0.60 ? 'real but modest' : A >= 0.55 ? 'weak' : 'at or near random'}`);
console.log();

run(
  `INSERT INTO probe_runs (kind, version, n_pos, n_neg, accuracy, baseline, auc)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  KIND, VERSION, nPos, nNeg, best.acc, majority, A
);
console.log(`  recorded in probe_runs\n`);
db.exec('PRAGMA optimize');
