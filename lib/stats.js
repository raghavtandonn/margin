import { all, get } from '../db/index.js';
import * as V from './visibility.js';

// ── FOUR FEATURES §2, §3, §4 ─────────────────────────────
// Everything here is DERIVED. Nothing is typed in. The app tells you things;
// you do not feed it.

// A reading's page count rarely comes from its own edition_id — an import
// shelves a work before editions are resolved — so fall back to the work's
// best edition, exactly as the cover pipeline does.
const RATED_BOOKS = `
  SELECT r.id, r.work_id, r.stars, r.finished_at, r.abandoned_at, r.status,
         w.title, w.first_published_year,
         COALESCE(e.page_count, (
           SELECT e2.page_count FROM editions e2
           WHERE e2.work_id = r.work_id AND e2.page_count IS NOT NULL
           ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), e2.published_year DESC LIMIT 1
         )) AS page_count,
         COALESCE(e.publisher, (
           SELECT e3.publisher FROM editions e3
           WHERE e3.work_id = r.work_id AND e3.publisher IS NOT NULL LIMIT 1
         )) AS publisher
  FROM readings r
  JOIN users u ON u.id = r.user_id
  JOIN works w ON w.id = r.work_id
  LEFT JOIN editions e ON e.id = r.edition_id
  WHERE r.user_id = ?`;

/**
 * The viewer scope for every figure in this file.
 *
 * Reading statistics follow profile access. Shelf privacy hides the
 * collection, not the fact a book was read; legacy per-read privacy flags
 * have no effect on these figures.
 *
 * Pass no viewer and nothing is scoped, which is the owner looking at their
 * own figures. Pass one and every count, mean and median is theirs.
 */
function scope(viewer) {
  if (!viewer) return { sql: '', params: [] };
  const v = V.visibleReadingSQL(viewer, { owner: 'u', entry: 'r' });
  return { sql: ` AND ${v.sql}`, params: v.params };
}

// ══ §2 — RATINGS DISTRIBUTION ════════════════════════════
// Ten buckets, one per half-star. Unrated books are excluded from the
// histogram and its count.
export const BUCKETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

export function ratingDistribution(userId, { shelfSlug = null, decade = null, viewer = null } = {}) {
  const sc = scope(viewer);
  let sql = `${RATED_BOOKS}${sc.sql} AND r.stars IS NOT NULL`;
  const params = [Number(userId), ...sc.params];

  if (shelfSlug) {
    sql += ` AND EXISTS (SELECT 1 FROM shelf_items si
                         JOIN shelves sh ON sh.id = si.shelf_id
                         WHERE si.work_id = r.work_id AND sh.user_id = ? AND sh.slug = ?)`;
    params.push(Number(userId), shelfSlug);
  }
  if (decade) {
    sql += ' AND w.first_published_year >= ? AND w.first_published_year < ?';
    params.push(Number(decade), Number(decade) + 10);
  }

  const rows = all(sql, ...params);
  if (!rows.length) return null;

  const counts = new Map(BUCKETS.map((b) => [b, 0]));
  for (const r of rows) {
    const b = Math.round(r.stars * 2) / 2;
    if (counts.has(b)) counts.set(b, counts.get(b) + 1);
  }

  const peak = Math.max(...counts.values());
  const values = rows.map((r) => r.stars).sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const median =
    values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

  let mode = null;
  let modeN = -1;
  for (const [b, n] of counts) if (n > modeN) { modeN = n; mode = b; }

  const lowest = values[0];
  // The generosity read: stated as arithmetic, never as advice.
  const topTwo = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const concentration = topTwo.reduce((s, [, n]) => s + n, 0) / values.length;

  return {
    count: values.length,
    bars: BUCKETS.map((b) => ({
      value: b,
      count: counts.get(b),
      // Empty buckets render as a stub, never as nothing — the gap is
      // information.
      height: peak ? Math.max(2, Math.round((counts.get(b) / peak) * 100)) : 2
    })),
    mean: Number(mean.toFixed(1)),
    median: Number(median.toFixed(1)),
    mode,
    lowest,
    neverBelow: lowest > 0.5 ? lowest : null,
    concentration: Math.round(concentration * 100),
    topTwo: topTwo.map(([b]) => b).sort((a, b) => a - b)
  };
}

// Books in one rating bucket — for the hover preview and the shelf filter.
export function booksAtRating(userId, stars, { limit = 6 } = {}) {
  return all(
    `${RATED_BOOKS} AND r.stars = ? ORDER BY r.finished_at DESC LIMIT ?`,
    Number(userId), Number(stars), limit
  ).map(withCover);
}

function withCover(r) {
  const cover = get(
    `SELECT cover_url, cover_cache_key, format FROM editions
     WHERE work_id = ? ORDER BY (cover_cache_key IS NULL), (cover_url IS NULL), published_year DESC LIMIT 1`,
    r.work_id
  );
  return { ...r, ...(cover || {}) };
}

// ══ §3 — WHAT YOU ACTUALLY LIKE ══════════════════════════
// Mean rating per bucket against your overall mean. Buckets under 5 rated
// books are SUPPRESSED — not greyed, not caveated. A delta computed from two
// books is noise wearing a suit.
const MIN_SAMPLE = 5;

const PAGE_BANDS = [
  { key: 'BOOKS UNDER 250PP', test: (p) => p != null && p < 250 },
  { key: 'BOOKS 250–400PP', test: (p) => p != null && p >= 250 && p < 400 },
  { key: 'BOOKS 400–600PP', test: (p) => p != null && p >= 400 && p < 600 },
  { key: 'BOOKS OVER 600PP', test: (p) => p != null && p >= 600 }
];

export function whatYouLike(userId, { viewer = null } = {}) {
  const sc = scope(viewer);
  const rows = all(`${RATED_BOOKS}${sc.sql} AND r.stars IS NOT NULL`, Number(userId), ...sc.params);
  if (rows.length < MIN_SAMPLE) return null;

  const overall = rows.reduce((s, r) => s + r.stars, 0) / rows.length;
  const buckets = [];

  const push = (label, members, filter) => {
    if (members.length < MIN_SAMPLE) return;
    const mean = members.reduce((s, r) => s + r.stars, 0) / members.length;
    buckets.push({
      label,
      mean: Number(mean.toFixed(1)),
      delta: Number((mean - overall).toFixed(1)),
      count: members.length,
      filter
    });
  };

  // Page-count bands and decade come free from the import and are completely
  // reliable, so they are what ships first.
  for (const band of PAGE_BANDS) {
    push(band.key, rows.filter((r) => band.test(r.page_count)), `pages=${encodeURIComponent(band.key)}`);
  }

  const decades = new Map();
  for (const r of rows) {
    if (!r.first_published_year) continue;
    const d = Math.floor(r.first_published_year / 10) * 10;
    if (!decades.has(d)) decades.set(d, []);
    decades.get(d).push(r);
  }
  for (const [d, members] of [...decades].sort((a, b) => a[0] - b[0])) {
    push(`PUBLISHED ${d}s`, members, `decade=${d}`);
  }

  const publishers = new Map();
  for (const r of rows) {
    if (!r.publisher) continue;
    if (!publishers.has(r.publisher)) publishers.set(r.publisher, []);
    publishers.get(r.publisher).push(r);
  }
  for (const [name, members] of publishers) {
    push(name.toUpperCase(), members, `publisher=${encodeURIComponent(name)}`);
  }

  // Biggest surprises first.
  buckets.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    overall: Number(overall.toFixed(1)),
    count: rows.length,
    above: buckets.filter((b) => b.delta > 0),
    below: buckets.filter((b) => b.delta < 0)
  };
}

// ══ §4 — WHEN YOU ACTUALLY READ ══════════════════════════
// Date Read is frequently empty in a Goodreads export. Never infer one from
// Date Added; state the coverage instead.
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTH_NAMES = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];

export function whenYouRead(userId, { mode = 'books', viewer = null } = {}) {
  const sc = scope(viewer);
  const finished = all(
    `${RATED_BOOKS}${sc.sql} AND r.status IN ('FINISHED','ABANDONED')`,
    Number(userId), ...sc.params
  );
  const dated = finished.filter((r) => r.finished_at || r.abandoned_at);

  // Fewer than 10 dated books: suppress the whole block.
  if (dated.length < 10) return null;

  const byMonth = Array.from({ length: 12 }, () => ({ books: 0, pages: 0 }));
  const byYear = new Map();

  for (const r of dated) {
    const d = String(r.finished_at || r.abandoned_at).slice(0, 10);
    const m = Number(d.slice(5, 7)) - 1;
    const y = Number(d.slice(0, 4));
    if (m < 0 || m > 11) continue;
    byMonth[m].books++;
    byMonth[m].pages += r.page_count || 0;
    if (!byYear.has(y)) byYear.set(y, { books: 0, pages: 0 });
    byYear.get(y).books++;
    byYear.get(y).pages += r.page_count || 0;
  }

  const key = mode === 'pages' ? 'pages' : 'books';
  const peak = Math.max(...byMonth.map((m) => m[key]), 1);

  const months = byMonth.map((m, i) => ({
    label: MONTHS[i],
    name: MONTH_NAMES[i],
    index: i,
    books: m.books,
    pages: m.pages,
    value: m[key],
    height: Math.max(2, Math.round((m[key] / peak) * 100))
  }));

  const ranked = [...months].filter((m) => m.value > 0).sort((a, b) => b.value - a.value);
  const yearPeak = Math.max(...[...byYear.values()].map((v) => v[key]), 1);

  const coverage = dated.length / finished.length;

  return {
    mode: key,
    months,
    // HEAVIEST and LIGHTEST are the only comparative words permitted.
    heaviest: ranked[0] || null,
    lightest: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    years: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({
      year,
      books: v.books,
      pages: v.pages,
      value: v[key],
      height: Math.max(2, Math.round((v[key] / yearPeak) * 100))
    })),
    datedCount: dated.length,
    totalCount: finished.length,
    coverage: Math.round(coverage * 100),
    // Under 40%, the caveat is more important than the chart.
    leadWithCaveat: coverage < 0.4,
    hasPageData: byMonth.some((m) => m.pages > 0)
  };
}

export function booksInMonth(userId, monthIndex, { limit = 6 } = {}) {
  return all(
    `${RATED_BOOKS} AND r.status IN ('FINISHED','ABANDONED')
       AND CAST(strftime('%m', COALESCE(r.finished_at, r.abandoned_at)) AS INTEGER) = ?
     ORDER BY COALESCE(r.finished_at, r.abandoned_at) DESC LIMIT ?`,
    Number(userId), Number(monthIndex) + 1, limit
  ).map(withCover);
}
