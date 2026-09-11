// ── PHASE 4: LEAVE-ONE-OUT (spec §05) ────────────────────
//
//   npm run reco:eval
//   npm run reco:eval -- --kinds text-plot,text-criticism
//
// "This is the number that decides whether the system ships."
//
// For each finished book f: remove f from the profile, rebuild, rank f
// against the pile, record where it landed. A system that cannot rank the
// books you actually read above the books you did not is not recommending,
// it is shuffling.
import { db, all, get } from '../db/index.js';
import * as EMB from '../lib/embeddings.js';
import * as R from '../lib/reco.js';

const args = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const USER = Number(argOf('user', 1));

// Allow a subset of kinds, so the weighting question can be settled by
// measurement instead of argued about.
const only = argOf('kinds', null);
const WEIGHTS = only
  ? Object.fromEntries(only.split(',').map((s) => s.trim())
      .filter((k) => R.WEIGHTS[k]).map((k) => [k, R.WEIGHTS[k]]))
  : R.WEIGHTS;

const kinds = Object.keys(WEIGHTS);
console.log(`\n  kinds        ${kinds.map((k) => `${k} (${R.WEIGHTS[k]})`).join(', ')}`);

const stores = Object.fromEntries(kinds.map((k) => [k, EMB.allOf(k, R.versionFor(k))]));
const hist = R.history(USER);
const pile = R.pileOf(USER).map((r) => r.work_id);

// Only pile books that can be ranked at all take part. A book with no vector
// in any surviving kind is unrankable and absent — reporting how many is a
// coverage metric in its own right (§09).
const rankable = pile.filter((w) => kinds.some((k) => stores[k].has(w)));

const finished = hist.filter((r) => r.status === 'FINISHED' && r.w > 0);
const trials = finished.filter((r) => kinds.some((k) => stores[k].has(r.work_id)));

console.log(`  pile         ${pile.length} unopened, ${rankable.length} rankable`);
console.log(`  unrankable   ${pile.length - rankable.length}  (absent, not zero-scored)`);
console.log(`  finished     ${finished.length}, of which ${trials.length} carry a vector\n`);

if (trials.length < 10) {
  console.log('  too few trials to evaluate.\n');
  process.exit(1);
}

const ranks = [];
for (const f of trials) {
  // The held-out book is removed from the profile AND ranked against the
  // pile it does not belong to — inserting it into the candidate set is the
  // whole trick, and forgetting to remove it from the profile is how a
  // leave-one-out silently becomes a self-similarity check.
  const prof = R.profile(USER, { exclude: new Set([f.work_id]), rows: hist, weights: WEIGHTS });
  if (!Object.keys(prof).length) continue;

  const ranked = R.score(prof, [f.work_id, ...rankable], { stores, weights: WEIGHTS });
  const at = ranked.findIndex((x) => x.work_id === f.work_id);
  if (at >= 0) ranks.push({ work_id: f.work_id, rank: at + 1, of: ranked.length });
}

const n = ranks.length;
const recallAt = (k) => ranks.filter((r) => r.rank <= k).length / n;
const mrr = ranks.reduce((s, r) => s + 1 / r.rank, 0) / n;
const meanOf = ranks.reduce((s, r) => s + r.of, 0) / n;

// The random baseline is not a guess: ranking uniformly at random among N
// candidates puts the held-out book in the top k with probability k/N, and
// gives an expected MRR of H(N)/N.
const H = (m) => { let s = 0; for (let i = 1; i <= m; i++) s += 1 / i; return s; };
const randRecall = (k) => k / meanOf;
const randMRR = H(Math.round(meanOf)) / meanOf;

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`  ── LEAVE-ONE-OUT ─────────────────────────────`);
console.log(`  trials       ${n}, each against ~${Math.round(meanOf)} candidates\n`);
console.log(`               measured     random     lift`);
console.log(`  recall@10    ${pct(recallAt(10)).padEnd(12)} ${pct(randRecall(10)).padEnd(10)} ${(recallAt(10) / randRecall(10)).toFixed(1)}x`);
console.log(`  recall@25    ${pct(recallAt(25)).padEnd(12)} ${pct(randRecall(25)).padEnd(10)} ${(recallAt(25) / randRecall(25)).toFixed(1)}x`);
console.log(`  MRR          ${mrr.toFixed(4).padEnd(12)} ${randMRR.toFixed(4).padEnd(10)} ${(mrr / randMRR).toFixed(1)}x`);
console.log(`  median rank  ${ranks.map((r) => r.rank).sort((a, b) => a - b)[Math.floor(n / 2)]} of ~${Math.round(meanOf)}\n`);

// ── the source-kind distribution guard (§09) ─────────────
// Coverage bias masquerading as taste: criticism exists for canonical
// literature, so a ranking dominated by it recommends the canon and calls it
// taste. If one kind drives more than 60% of the top 20, that is flagged.
const prof = R.profile(USER, { rows: hist, weights: WEIGHTS });
const top = R.score(prof, rankable, { stores, weights: WEIGHTS }).slice(0, 20);
const drive = {};
for (const item of top) {
  const best = Object.entries(item.per_kind).sort((a, b) => b[1] - a[1])[0];
  if (best) drive[best[0]] = (drive[best[0]] || 0) + 1;
}
console.log(`  ── TOP 20: WHICH KIND DROVE IT ───────────────`);
for (const [k, c] of Object.entries(drive).sort((a, b) => b[1] - a[1])) {
  const share = c / top.length;
  // With a single kind in play the 60% rule is trivially true and measures
  // nothing — the flag is about one kind crowding out others that exist.
  const flag = kinds.length > 1 && share > 0.6;
  console.log(`  ${k.padEnd(16)} ${c}/20  ${pct(share)}${flag ? '   FLAG — one kind dominates' : ''}`);
}

// ── length bias (§09) ────────────────────────────────────
const chars = new Map(
  all(`SELECT work_id, MAX(source_chars) c FROM embeddings
        WHERE source_chars IS NOT NULL GROUP BY work_id`).map((r) => [r.work_id, r.c])
);
const paired = top.map((t, i) => ({ rank: i + 1, c: chars.get(t.work_id) })).filter((x) => x.c);
if (paired.length > 5) {
  const mx = paired.reduce((s, p) => s + p.rank, 0) / paired.length;
  const my = paired.reduce((s, p) => s + p.c, 0) / paired.length;
  let num = 0, dx = 0, dy = 0;
  for (const p of paired) { num += (p.rank - mx) * (p.c - my); dx += (p.rank - mx) ** 2; dy += (p.c - my) ** 2; }
  console.log(`\n  ── LENGTH BIAS ───────────────────────────────`);
  // dy === 0 means every input hit the truncation ceiling, so there is no
  // variation left to correlate against. Saying "no correlation" there would
  // report a measurement that was never taken — the guard is satisfied by
  // the truncation itself, and the honest line says so.
  if (dy === 0) {
    console.log(`  every input at the ${'2000'}-char ceiling — no variance to correlate.`);
    console.log(`  length bias is precluded by truncation rather than measured.`);
  } else {
    const r = num / Math.sqrt(dx * dy);
    console.log(`  rank vs source_chars  r = ${r.toFixed(3)}  ${Math.abs(r) > 0.4 ? 'FLAG — truncate inputs further' : 'no meaningful correlation'}`);
  }
}
console.log();
db.exec('PRAGMA optimize');
