import { all, get } from '../db/index.js';
import * as EMB from './embeddings.js';

// ── SURFACE A — THE PILE (spec §06) ──────────────────────
//
// Of the books you own and have not opened, which should you read next?
//
// What this is, stated once so it cannot drift: **content-based similarity
// ranking, not personalization.** There is no interaction data anywhere in
// this system, and the article's own ablation is unambiguous that content
// features need interaction data somewhere to teach a model how to use them.
// This ranks books by how much they resemble what you finish. It does not
// learn your taste, and nothing in the product may say that it does.

export const TEXT_VERSION = 'bge-small-en-v1.5@1';
export const COLOUR_VERSION = 'colour-system@1.2';
export const versionFor = (kind) => kind.startsWith('colour-') ? COLOUR_VERSION : TEXT_VERSION;

/**
 * Kind weights, measured rather than chosen.
 *
 * These are the §04 probe Δaccuracies, normalised. The article's lesson on
 * canvas mixing is that hand-tuning per-source weights trades one problem
 * for a set of arbitrary hyperparameters and endless sweeps to tune them —
 * so nobody hand-tunes these. Re-run the probe and they change.
 *
 * Both colour kinds are ABSENT here, and that is a finding rather than an
 * oversight: colour-components probed at Δ+0.0 / AUC 0.473 and colour-oklab
 * at Δ+0.0 / AUC 0.359, both at or below random. The colour system remains
 * the right substrate for the lookbook and is not one for recommendation.
 * §12 asked the question; this is the answer.
 */
/*
 * MEASURED, and the measurement overruled the probe.
 *
 * The §04 probe is a CLASSIFICATION test and it ranked the kinds:
 *
 *     text-plot        Δ+4.7   AUC 0.601      (passed the gate)
 *     text-criticism   Δ+2.1   AUC 0.652      (best AUC of any kind)
 *     text-blurb       Δ+1.5   AUC 0.541
 *     colour-*         Δ+0.0   AUC 0.473 / 0.359
 *
 * §05's leave-one-out is a RANKING test, which is the actual task, and it
 * disagreed. Lift over a random ranking, by kind set:
 *
 *     text-plot alone              recall@10 3.1x   MRR 2.4x
 *     text-plot + criticism        recall@10 1.7x   MRR 1.6x
 *     text-criticism alone         recall@10 1.3x   MRR 0.9x   ← below random
 *     all three                    recall@10 1.9x   MRR 1.7x
 *
 * Criticism has the best AUC of any single kind and ranks WORSE than chance
 * by MRR. A kind can separate two classes without ordering within them, and
 * separating is not what this surface does. The spec is explicit that
 * leave-one-out "is the number that decides whether the system ships", so
 * that is the number obeyed here.
 *
 * The cost is coverage: plot alone leaves part of the pile unrankable, and
 * those books are absent from recommendations rather than badly ranked.
 * Adding a kind to reach them measurably made the recommendations worse.
 */
export const WEIGHTS = Object.freeze({
  'text-plot': 1.0
});

const KINDS = Object.keys(WEIGHTS);

/** The kinds in play, optionally narrowed — used by the evaluator to
 *  compare weightings by measurement rather than by argument. */
export const kindsOf = (weights = WEIGHTS) => Object.keys(weights);

// ── the taste profile (§06) ──────────────────────────────
//
// Rereads are the strongest taste signal a reader produces and no competing
// product uses them as one. Abandonment is a genuine negative and pushes the
// profile away rather than being ignored.
const HALF_LIFE_DAYS = 730;   // 24 months

export function signalWeight(row, now = Date.now()) {
  let w;
  if (row.status === 'ABANDONED') {
    w = (row.abandoned_page ?? 0) >= 100 ? -0.3 : -0.6;
  } else {
    const s = row.stars;
    w = s == null ? 0.5 : s >= 5 ? 1.0 : s >= 4 ? 0.8 : s >= 3 ? 0.5 : 0.2;
    if (row.pass_number > 1) w *= 1.5;      // a reread
  }
  // Taste moves. A book loved eight years ago should not weigh as much as
  // one loved last spring.
  const at = row.finished_at || row.abandoned_at;
  if (at) {
    const days = (now - new Date(String(at).replace(' ', 'T') + 'Z')) / 86400000;
    if (Number.isFinite(days) && days > 0) w *= Math.pow(0.5, days / HALF_LIFE_DAYS);
  }
  return w;
}

/** Every resolved reading for a user, with its signal weight. */
export function history(userId) {
  return all(
    `SELECT work_id, status, stars, pass_number, abandoned_page, finished_at, abandoned_at
       FROM readings
      WHERE user_id = ? AND is_draft = 0
        AND status IN ('FINISHED', 'ABANDONED')`,
    Number(userId)
  ).map((r) => ({ ...r, w: signalWeight(r) }));
}

/**
 * One centroid per kind, from the reader's own history.
 *
 * `exclude` is what makes leave-one-out possible: rebuild the profile
 * without a book, then see where that book ranks.
 */
export function profile(userId, { exclude = new Set(), rows = null, weights = WEIGHTS } = {}) {
  const hist = (rows || history(userId)).filter((r) => !exclude.has(r.work_id));
  const out = {};
  for (const kind of kindsOf(weights)) {
    const store = EMB.allOf(kind, versionFor(kind));
    const vecs = [], signals = [];
    for (const r of hist) {
      const v = store.get(r.work_id);
      if (!v) continue;                       // absent, never imputed
      vecs.push(v); signals.push(r.w);
    }
    const c = EMB.centroid(vecs, signals);
    if (c) out[kind] = { vec: c, n: vecs.length };
  }
  return out;
}

/**
 * Score candidates against a profile.
 *
 * A book is scored on the kinds it HAS, with the weights renormalised over
 * those kinds. A missing vector is never imputed — that mirrors the colour
 * system's component-attrition rule, which is already tested and understood.
 * A book with no kinds at all is unrankable and is absent from the result,
 * not scored zero.
 */
export function score(prof, candidates, { stores = null, weights = WEIGHTS } = {}) {
  const S = stores || Object.fromEntries(
    kindsOf(weights).map((k) => [k, EMB.allOf(k, versionFor(k))])
  );
  const out = [];
  for (const workId of candidates) {
    const per = {};
    let sum = 0, weight = 0;
    for (const kind of kindsOf(weights)) {
      const p = prof[kind];
      const v = S[kind]?.get(workId);
      if (!p || !v) continue;
      const cos = EMB.cosine(p.vec, v);
      if (cos == null) continue;
      per[kind] = cos;
      sum += weights[kind] * cos;
      weight += weights[kind];
    }
    if (!weight) continue;                    // unrankable: absent, not zero
    out.push({ work_id: workId, score: sum / weight, per_kind: per });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * The two or three finished books a recommendation sits closest to.
 *
 * This is the most legible explanation available — "because you finished
 * Stoner and Gilead" — and costs one extra similarity computation.
 */
export function neighboursOf(workId, hist, { limit = 3, kind = 'text-plot' } = {}) {
  const store = EMB.allOf(kind, versionFor(kind));
  const target = store.get(workId);
  if (!target) return [];
  // One row per WORK, not per reading. `history()` returns a row per pass, so
  // a reread appeared twice and the explanation read "because you finished
  // The Secret History and The Secret History". The hand review caught this;
  // no metric did, which is the argument for the hand review.
  const seen = new Set();
  return hist
    .filter((r) => r.w > 0 && store.has(r.work_id))
    .filter((r) => !seen.has(r.work_id) && seen.add(r.work_id))
    .map((r) => ({ work_id: r.work_id, cos: EMB.cosine(target, store.get(r.work_id)) }))
    .filter((r) => r.cos != null)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, limit);
}

// ── the diversity guards (§09) ───────────────────────────
//
// Applied AFTER scoring and BEFORE display, in that order, because they are
// presentation rules and not part of the ranking.

/** At most one book per author. Three Murakamis in a top ten is a failure. */
export function oneRowPerAuthor(ranked, { limit = 10 } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of ranked) {
    const a = get(
      `SELECT p.id FROM work_people wp JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = ? AND wp.role = 'AUTHOR' LIMIT 1`, item.work_id
    );
    const key = a ? `p${a.id}` : `w${item.work_id}`;   // unknown authors do not collapse
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// Shared by pile generation and stored-run display. Assumes readings alias
// `r`; an imported WAITING pass with no progress is still unopened.
export const OPENED_READING_SQL = "(r.status != 'WAITING' OR r.current_page > 0)";

/**
 * The pile: owned, unopened, never read in any edition.
 *
 * "Never read" is by WORK identity, so a different translation of something
 * already finished is excluded — it is not a recommendation.
 */
export function pileOf(userId) {
  return all(
    `SELECT si.work_id, si.added_at
       FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
      WHERE s.user_id = ? AND s.slug = 'waiting'
        AND si.work_id NOT IN (SELECT r.work_id FROM readings r WHERE r.user_id = ?
          AND ${OPENED_READING_SQL})
      ORDER BY si.added_at`,
    Number(userId), Number(userId)
  );
}
