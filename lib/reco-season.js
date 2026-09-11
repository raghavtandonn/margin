import { all, get, run } from '../db/index.js';
import * as EMB from './embeddings.js';
import * as R from './reco.js';
import { PALETTE, colourOf } from './palette.js';

// ── SURFACE B — SEASON COMPLEMENTS (spec §07) ────────────
//
// Three books per closed season, printed as a page in the lookbook.
//
// "Complement" is the entire design problem. Nearest-neighbours-to-the-
// centroid returns more of what the season already contains, which is both
// boring and redundant — the reader has just read those. So each slot stands
// in a DIFFERENT, DEFINED relation to the season's shape, and each rationale
// is arithmetic rather than interpretation.
//
// Frozen at generation. A season's complements are computed once, at close,
// and stored. They are a printed page in a lookbook, not a live query: if the
// pile changes next month, the A/W 25 lookbook does not.

export const SLOTS = Object.freeze(['near', 'absence', 'thread']);
const KIND = 'text-plot';        // the only kind that survived §05

/**
 * The season's shape, from the books in it.
 *
 * Centroid and outlier come from the text vectors; the emotional profile and
 * its absences come from the derived colour components, which is the one
 * thing colour is still used for here — naming a gap, not ranking.
 */
export function shapeOf(seasonId) {
  const books = all(
    `SELECT sf.work_id, w.title, w.colour_components
       FROM season_frames sf JOIN works w ON w.id = sf.work_id
      WHERE sf.season_id = ?`,
    String(seasonId)
  );
  if (!books.length) return null;

  const store = EMB.allOf(KIND, R.versionFor(KIND));
  const withVec = books.filter((b) => store.has(b.work_id));
  const centroid = EMB.centroid(withVec.map((b) => store.get(b.work_id)));

  // The outlier: the season's book sharing least with the rest. Every season
  // has one, and following its thread is slot 03.
  let outlier = null;
  if (withVec.length >= 3) {
    let worst = Infinity;
    for (const b of withVec) {
      const mine = store.get(b.work_id);
      const others = withVec.filter((o) => o.work_id !== b.work_id);
      const mean = others.reduce((s, o) => s + EMB.cosine(mine, store.get(o.work_id)), 0) / others.length;
      if (mean < worst) { worst = mean; outlier = { ...b, mean }; }
    }
  }

  // Aggregate anchor weight across every component in the season.
  const profile = {};
  for (const b of books) {
    let comps = [];
    try { comps = JSON.parse(b.colour_components || '[]'); } catch { continue; }
    for (const c of comps) profile[c.id] = (profile[c.id] || 0) + (Number(c.weight) || 0);
  }
  const coloured = books.filter((b) => b.colour_components).length;

  return { books, withVec, centroid, outlier, profile, coloured };
}

/** Aggregate anchor weight across the whole library — the baseline an
 *  absence is measured against. A season lacking something the library also
 *  lacks is not an absence, it is a preference. */
export function libraryProfile() {
  const out = {};
  for (const row of all(
    `SELECT colour_components FROM works WHERE colour_components IS NOT NULL`
  )) {
    let comps = [];
    try { comps = JSON.parse(row.colour_components) || []; } catch { continue; }
    for (const c of comps) out[c.id] = (out[c.id] || 0) + (Number(c.weight) || 0);
  }
  return out;
}

const heaviestOf = (json) => {
  let comps = [];
  try { comps = JSON.parse(json || '[]'); } catch { return null; }
  return comps.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0))[0] || null;
};

/**
 * The three slots. Any of them may be empty, and an empty slot prints as a
 * hatch rather than being filled with a worse answer — exactly as the
 * colourway voids do.
 */
export function complementsFor(userId, seasonId) {
  const shape = shapeOf(seasonId);
  if (!shape) return [];

  const store = EMB.allOf(KIND, R.versionFor(KIND));

  // Every kind the season and the book both carry, for the derivation panel.
  //
  // These are AGREEMENTS, not contributions: only text-plot survived §05 and
  // only text-plot moves the ranking. Showing the others is what makes the
  // panel a derivation rather than a score — you can see that a book the
  // plot summaries picked is also close on its criticism, or that it is not.
  // The one that actually decided is marked, so nothing here implies that
  // colour ranked anything.
  const AGREE = ['text-plot', 'text-criticism', 'text-blurb', 'colour-components'];
  const agreeStores = {};
  const agreeCentroids = {};
  for (const k of AGREE) {
    const st = EMB.allOf(k, R.versionFor(k));
    agreeStores[k] = st;
    const vecs = shape.books.map((b) => st.get(b.work_id)).filter(Boolean);
    if (vecs.length) agreeCentroids[k] = EMB.centroid(vecs);
  }
  const agreementFor = (workId) => {
    const out = {};
    for (const k of AGREE) {
      const c = agreeCentroids[k], v = agreeStores[k]?.get(workId);
      if (!c || !v) continue;
      const cos = EMB.cosine(c, v);
      if (cos != null) out[k] = cos;
    }
    return out;
  };

  const inSeason = new Set(shape.books.map((b) => b.work_id));
  const pile = R.pileOf(userId).map((r) => r.work_id).filter((w) => !inSeason.has(w) && store.has(w));
  if (!pile.length) return [];

  // No author may appear twice across the three slots, or appear at all if
  // they are already in the season.
  const authorOf = (workId) => get(
    `SELECT p.id, p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
      WHERE wp.work_id = ? AND wp.role = 'AUTHOR' LIMIT 1`, workId
  );
  const taken = new Set();
  for (const b of shape.books) { const a = authorOf(b.work_id); if (a) taken.add(a.id); }

  const claim = (workId) => {
    const a = authorOf(workId);
    if (a && taken.has(a.id)) return false;
    if (a) taken.add(a.id);
    return true;
  };

  // The season's heaviest note, so the NEAR slot can say what this season
  // was mostly made of rather than only that a book is near its centre.
  const seasonTop = Object.entries(shape.profile).sort((a, b) => b[1] - a[1])[0];
  const seasonTotalW = Object.values(shape.profile).reduce((s, v) => s + v, 0) || 1;

  const out = [];

  // ── 01 THE NEAR ────────────────────────────────────────
  // The straightforward one: the closest thing to this season you have not
  // read.
  if (shape.centroid) {
    const ranked = pile
      .map((w) => ({ work_id: w, cos: EMB.cosine(shape.centroid, store.get(w)) }))
      .filter((r) => r.cos != null)
      .sort((a, b) => b.cos - a.cos);
    const pick = ranked.find((r) => claim(r.work_id));
    if (pick) {
      const note = seasonTop
        ? ` **${colourOf(seasonTop[0])?.emotion || seasonTop[0]} at ${Math.round(seasonTop[1] / seasonTotalW * 100)}%**, the season's heaviest note.`
        : '';
      // How far ahead of the field, in the field's own terms. A cosine on
      // its own is a number nobody can size; the gap to the runner-up is
      // what says whether this was a clear win or a coin toss.
      const second = ranked.filter((r) => r.work_id !== pick.work_id)[0];
      out.push({
        slot: 'near', work_id: pick.work_id, score: pick.cos,
        per_kind: agreementFor(pick.work_id),
        lead: KIND,
        // No cosines. A reader has no scale for ".84" and no way to know
        // whether higher means closer — the number was measured honestly and
        // communicated nothing. Rank against the shelf is the same fact in a
        // unit anybody reads.
        detail: `Every unread book on your shelf was compared with what this ` +
                `season was about. Of all ${pile.length}, this one came closest` +
                (second && (pick.cos - second.cos) < 0.01
                  ? ' — though the next one was very nearly as close.'
                  : '.'),
        rationale: `Nearest to this season's centre, of ${pile.length} unread.${note}`
      });
    }
  }

  // ── 02 THE ABSENCE ─────────────────────────────────────
  // The anchor heaviest in the library at large and near-absent from this
  // season. It names a gap the reader did not know the season had, and the
  // gap is arithmetic rather than interpretation.
  //
  // Measured against the LIBRARY baseline, not against zero: a season with
  // no boredom in it is unremarkable if the library has almost none either.
  const lib = libraryProfile();
  const libTotal = Object.values(lib).reduce((s, v) => s + v, 0);
  const seasonTotal = Object.values(shape.profile).reduce((s, v) => s + v, 0) || 1;
  if (libTotal && shape.coloured >= 3) {
    const gaps = Object.entries(lib)
      .map(([id, v]) => ({
        id,
        libShare: v / libTotal,
        seasonShare: (shape.profile[id] || 0) / seasonTotal
      }))
      .filter((g) => g.seasonShare < 0.02 && g.libShare > 0.03)
      .sort((a, b) => b.libShare - a.libShare);

    for (const gap of gaps) {
      const candidates = pile
        .map((w) => {
          const comps = get('SELECT colour_components FROM works WHERE id = ?', w)?.colour_components;
          const top = heaviestOf(comps);
          if (!top || top.id !== gap.id) return null;
          return {
            work_id: w,
            weight: Number(top.weight) || 0,
            cos: shape.centroid ? EMB.cosine(shape.centroid, store.get(w)) : 0
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.cos - a.cos);
      const pick = candidates.find((c) => claim(c.work_id));
      if (pick) {
        const name = colourOf(gap.id)?.emotion || gap.id;
        out.push({
          slot: 'absence', work_id: pick.work_id, score: pick.cos,
          per_kind: agreementFor(pick.work_id),
          lead: KIND,
          detail: `${name} runs through ${Math.round(gap.libShare * 100)}% of your library, ` +
                  `and through ${gap.seasonShare < 0.005 ? 'none' : 'almost none'} of this season. ` +
                  `${candidates.length} unread ${candidates.length === 1 ? 'book leads' : 'books lead'} with it — ` +
                  `of those, this is the one that otherwise fits the season best.`,
          rationale: `No book this season carried ${name.toLowerCase()}. **This one does, at ${Math.round(pick.weight * 100)}%** — and sits closest to the centre of everything else you read.`
        });
        break;
      }
    }
  }

  // ── 03 THE THREAD ──────────────────────────────────────
  // Nearest neighbour to the season's OUTLIER rather than its centroid.
  // Follows the one book that sat apart instead of the consensus.
  if (shape.outlier && store.has(shape.outlier.work_id)) {
    const target = store.get(shape.outlier.work_id);
    const ranked = pile
      .map((w) => ({ work_id: w, cos: EMB.cosine(target, store.get(w)) }))
      .filter((r) => r.cos != null)
      .sort((a, b) => b.cos - a.cos);
    const pick = ranked.find((r) => claim(r.work_id));
    if (pick) {
      out.push({
        slot: 'thread', work_id: pick.work_id, score: pick.cos,
        per_kind: agreementFor(pick.work_id),
        lead: KIND,
        detail: `${shape.outlier.title} had less in common with the other ` +
                `${shape.withVec.length - 1} books here than any of them had with each other. ` +
                `Of your ${pile.length} unread, this is the closest match to that one.`,
        rationale: `One book sat apart from the rest of this season. This is what sits next to **${shape.outlier.title}**, which shared least with the other ${shape.withVec.length - 1}.`
      });
    }
  }

  return out;
}

/** Generate and freeze a season's complements. Idempotent per season. */
export function generate(userId, seasonId, { force = false } = {}) {
  const existing = get(
    `SELECT id FROM reco_runs WHERE surface = 'season' AND season_id = ? AND user_id = ?`,
    String(seasonId), Number(userId)
  );
  if (existing && !force) return { runId: existing.id, reused: true };

  const items = complementsFor(userId, seasonId);
  if (!items.length) return null;

  const hist = R.history(userId);
  const runId = run(
    `INSERT INTO reco_runs (surface, season_id, user_id, kinds, probe_ver)
     VALUES ('season', ?, ?, ?, ?)`,
    String(seasonId), Number(userId), JSON.stringify(R.WEIGHTS), 'probe@2026-09-10'
  ).lastInsertRowid;

  items.forEach((item, i) => {
    run(
      `INSERT INTO reco_items (run_id, work_id, rank, slot, score, per_kind, neighbours, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runId, item.work_id, i + 1, item.slot, item.score,
      JSON.stringify(item.per_kind),
      JSON.stringify({ lead: item.lead || KIND, detail: item.detail || null,
                       neighbours: R.neighboursOf(item.work_id, hist, { limit: 3 }) }),
      item.rationale
    );
  });
  return { runId, count: items.length };
}

/**
 * The stored complements for a season, hydrated for the lookbook.
 *
 * Always returns three entries in slot order. A slot with no defensible
 * answer comes back with `work_id: null` so the page can print the hatch —
 * empty slots will be common and must look composed.
 */
export function forSeason(userId, seasonId) {
  const runRow = get(
    `SELECT id FROM reco_runs WHERE surface = 'season' AND season_id = ? AND user_id = ?
      ORDER BY id DESC LIMIT 1`,
    String(seasonId), Number(userId)
  );
  const rows = runRow ? all(
    `SELECT ri.slot, ri.work_id, ri.score, ri.per_kind, ri.neighbours, ri.rationale,
            w.title, w.first_published_year AS year,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' LIMIT 1) AS author,
            e.cover_url, e.cover_cache_key
       FROM reco_items ri
       JOIN works w ON w.id = ri.work_id
       LEFT JOIN editions e ON e.id = (
         SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
          ORDER BY (e2.cover_cache_key IS NULL), e2.id LIMIT 1)
      WHERE ri.run_id = ?`,
    runRow.id
  ) : [];

  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return SLOTS.map((slot, i) => {
    const r = bySlot.get(slot);
    if (!r) return { slot, no: String(i + 1).padStart(2, '0'), work_id: null };
    let blob = {};
    try { blob = JSON.parse(r.neighbours || '{}'); } catch { /* none */ }
    const neighbours = Array.isArray(blob) ? blob : (blob.neighbours || []);
    const lead = Array.isArray(blob) ? KIND : (blob.lead || KIND);
    const detail = Array.isArray(blob) ? null : (blob.detail || null);
    let perKind = {};
    try { perKind = JSON.parse(r.per_kind || '{}'); } catch { /* none */ }

    // The books you finished that this one sits nearest, AS JACKETS. A row
    // of covers is read in one glance; the same three as truncated titles is
    // a list to be parsed, which is what the mockup was showing and what the
    // first pass of this page lost.
    const neighbourBooks = neighbours.map((n) => get(
      `SELECT w.id AS work_id, w.title,
              (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
                WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' LIMIT 1) AS author,
              e.cover_url, e.cover_cache_key
         FROM works w
         LEFT JOIN editions e ON e.id = (
           SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
            ORDER BY (e2.cover_cache_key IS NULL), e2.id LIMIT 1)
        WHERE w.id = ?`, n.work_id
    )).filter(Boolean);

    // Heaviest agreement first, so the panel reads top-down.
    const kinds = Object.entries(perKind)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, cos]) => ({ kind, cos, lead: kind === lead }));

    return {
      ...r,
      no: String(i + 1).padStart(2, '0'),
      kinds,
      detail,
      neighbourBooks
    };
  });
}
