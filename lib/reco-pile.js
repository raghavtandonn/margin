import { all, get, run } from '../db/index.js';
import * as R from './reco.js';

// ── SURFACE A, GENERATED AND STORED ──────────────────────
//
// A run is frozen the moment it is written: its per-kind cosines and its
// neighbours are stored alongside it, so a recommendation stays explainable
// after the embeddings are versioned forward. That is the same rule colour
// cards follow, and for the same reason — an explanation recomputed later is
// an explanation of a different thing.

export const PROBE_VERSION = 'probe@2026-09-10';

/**
 * Rank the pile and store the result.
 *
 * §09's guards are applied AFTER scoring and BEFORE display, in that order,
 * because they are presentation rules rather than part of the ranking:
 * one book per author, nothing already read in any edition, and a small
 * deterministic rotation among near-equal scores so the same ten do not sit
 * there every week.
 */
export function generate(userId, { limit = 10, week = null } = {}) {
  const hist = R.history(userId);
  const prof = R.profile(userId, { rows: hist });
  if (!Object.keys(prof).length) return null;

  const pile = R.pileOf(userId).map((r) => r.work_id);
  let ranked = R.score(prof, pile);
  if (!ranked.length) return null;

  ranked = rotate(ranked, week ?? weekOf());
  const top = R.oneRowPerAuthor(ranked, { limit });

  const runId = run(
    `INSERT INTO reco_runs (surface, season_id, user_id, kinds, probe_ver)
     VALUES ('pile', NULL, ?, ?, ?)`,
    Number(userId), JSON.stringify(R.WEIGHTS), PROBE_VERSION
  ).lastInsertRowid;

  top.forEach((item, i) => {
    const neighbours = R.neighboursOf(item.work_id, hist, { limit: 2 });
    run(
      `INSERT INTO reco_items (run_id, work_id, rank, slot, score, per_kind, neighbours, rationale)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      runId, item.work_id, i + 1, item.score,
      JSON.stringify(item.per_kind),
      JSON.stringify(neighbours),
      null            // the pile surface renders its reason from neighbours
    );
  });

  return { runId, count: top.length };
}

/**
 * A small deterministic shuffle among near-equal scores.
 *
 * §09: the same ten books every week is worse than a slightly worse ten that
 * move. Seeded on the week number, so it is stable within a week and
 * reproducible afterwards — a recommendation that changes on refresh is one
 * nobody can act on.
 */
function rotate(ranked, week) {
  const EPSILON = 0.004;
  const out = [...ranked];
  let seed = week * 2654435761 % 2147483647;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < out.length - 1; i++) {
    let j = i;
    while (j + 1 < out.length && Math.abs(out[j + 1].score - out[i].score) < EPSILON) j++;
    for (let k = j; k > i; k--) {
      const m = i + Math.floor(rnd() * (k - i + 1));
      [out[k], out[m]] = [out[m], out[k]];
    }
    i = j;
  }
  return out;
}

const weekOf = (d = new Date()) => {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor(t / (7 * 86400000));
};

/** The newest stored run, hydrated for display. Never recomputes. */
export function latest(userId, { limit = 3 } = {}) {
  const runRow = get(
    `SELECT id, created_at FROM reco_runs
      WHERE surface = 'pile' AND user_id = ?
      ORDER BY id DESC LIMIT 1`,
    Number(userId)
  );
  if (!runRow) return [];

  return all(
    `SELECT ri.work_id, ri.rank, ri.score, ri.per_kind, ri.neighbours,
            w.title,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' LIMIT 1) AS author,
            e.cover_url, e.cover_cache_key,
            (SELECT si.added_at FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
              WHERE s.user_id = ? AND s.slug = 'waiting' AND si.work_id = w.id) AS added_at
       FROM reco_items ri
       JOIN works w ON w.id = ri.work_id
       LEFT JOIN editions e ON e.id = (
         SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
          ORDER BY (e2.cover_cache_key IS NULL), e2.id LIMIT 1)
      WHERE ri.run_id = ?
        AND EXISTS (SELECT 1 FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
          WHERE s.user_id = ? AND s.slug = 'waiting' AND si.work_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM readings r WHERE r.user_id = ? AND r.work_id = w.id
          AND ${R.OPENED_READING_SQL})
      ORDER BY ri.rank LIMIT ?`,
    Number(userId), runRow.id, Number(userId), Number(userId), limit
  ).map((r) => {
    let neighbours = [];
    try { neighbours = JSON.parse(r.neighbours || '[]'); } catch { /* none */ }
    const named = neighbours
      .map((n) => get('SELECT title FROM works WHERE id = ?', n.work_id)?.title)
      .filter(Boolean);
    const held = r.added_at
      ? Math.floor((Date.now() - new Date(`${String(r.added_at).slice(0, 10)}T00:00:00Z`)) / 86400000)
      : null;
    return {
      ...r,
      neighbourTitles: named,
      heldDays: Number.isFinite(held) && held > 0 ? held : null
    };
  });
}
