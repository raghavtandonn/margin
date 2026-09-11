import { all, get, run } from '../db/index.js';
import { parseSQLiteTime } from './artifacts.js';

// ── "AT YOUR PACE" (FOUR FEATURES §1) ────────────────────
// Real time estimates in your own units, not a generic 250wpm.
//
// Nothing is typed in: the pace is the median of intervals between session
// logs you made while reading anyway.

// Below this there is not enough evidence to project anything, and one data
// point must never become a forecast.
const MIN_INTERVALS = 5;
const MIN_BOOKS = 3;
// A stall would poison the median.
const MAX_GAP_DAYS = 14;

// Format normalisation — audio and ebook sessions convert before entering
// the median. Anything that passed through a conversion is labelled EST.
const WORDS_PER_HOUR = 9000;
const WORDS_PER_PAGE = 275;

function toPages(position, positionType, totalPages) {
  if (positionType === 'minute') {
    return { pages: (position / 60) * WORDS_PER_HOUR / WORDS_PER_PAGE, converted: true };
  }
  if (positionType === 'percent') {
    if (!totalPages) return null;
    return { pages: (position / 100) * totalPages, converted: true };
  }
  // 'page' and 'location' are treated as-is; a Kindle location is not a page
  // but it is at least a consistent unit within one book.
  return { pages: position, converted: false };
}

export function computePace(userId) {
  const readings = all(
    `SELECT r.id, r.position_type, r.total_positions, r.work_id
     FROM readings r WHERE r.user_id = ?`,
    Number(userId)
  );

  const intervals = [];
  const booksContributing = new Set();
  let anyConverted = false;

  for (const r of readings) {
    const sessions = all(
      'SELECT position, position_type, occurred_at FROM sessions WHERE reading_id = ? ORDER BY occurred_at',
      r.id
    );
    if (sessions.length < 2) continue;

    for (let i = 1; i < sessions.length; i++) {
      const a = sessions[i - 1];
      const b = sessions[i];

      const ta = parseSQLiteTime(a.occurred_at);
      const tb = parseSQLiteTime(b.occurred_at);
      if (!ta || !tb) continue;

      const days = Math.max(1, (tb - ta) / 86400000);
      if (days > MAX_GAP_DAYS) continue; // a stall, not a pace

      const pa = toPages(a.position, a.position_type || r.position_type, r.total_positions);
      const pb = toPages(b.position, b.position_type || r.position_type, r.total_positions);
      if (!pa || !pb) continue;
      if (pa.converted || pb.converted) anyConverted = true;

      const pages = pb.pages - pa.pages;
      if (pages <= 0) continue; // a re-read of a chapter, or a correction

      intervals.push(pages / days);
      booksContributing.add(r.work_id);
    }
  }

  if (intervals.length < MIN_INTERVALS || booksContributing.size < MIN_BOOKS) {
    return {
      known: false,
      intervals: intervals.length,
      books: booksContributing.size,
      needIntervals: MIN_INTERVALS,
      needBooks: MIN_BOOKS
    };
  }

  // Median, not mean — one 200-page Sunday would wreck a mean.
  const sorted = intervals.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    known: true,
    pagesPerDay: Math.max(1, Math.round(median)),
    intervals: intervals.length,
    books: booksContributing.size,
    estimated: anyConverted
  };
}

// Cached on the user record; recomputed on session write.
export function getPace(userId) {
  const u = get('SELECT settings FROM users WHERE id = ?', Number(userId));
  if (!u) return { known: false, intervals: 0, books: 0 };
  try {
    const s = JSON.parse(u.settings || '{}');
    if (s.pace && s.paceComputedAt) {
      const age = Date.now() - new Date(s.paceComputedAt).getTime();
      if (age < 7 * 86400000) return s.pace;
    }
  } catch { /* recompute below */ }
  return refreshPace(userId);
}

export function refreshPace(userId) {
  const pace = computePace(userId);
  const u = get('SELECT settings FROM users WHERE id = ?', Number(userId));
  let settings = {};
  try { settings = JSON.parse(u?.settings || '{}'); } catch { /* start clean */ }
  settings.pace = pace;
  settings.paceComputedAt = new Date().toISOString();
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(settings), Number(userId));
  return pace;
}

// ── Surfaces ─────────────────────────────────────────────

// Surface A — an unread book: "416PP · ≈ 23 DAYS AT YOUR PACE"
export function daysToRead(pace, pageCount) {
  if (!pace?.known || !pageCount) return null;
  return Math.max(1, Math.ceil(pageCount / pace.pagesPerDay));
}

// Surface B — in progress: "ON PACE FOR MARCH 14"
export function finishBy(pace, current, total) {
  if (!pace?.known || !total) return null;
  const remaining = total - (current || 0);
  if (remaining <= 0) return { days: 0, label: 'TODAY' };

  const days = Math.ceil(remaining / pace.pagesPerDay);
  if (days <= 0) return { days: 0, label: 'TODAY' };

  const d = new Date();
  d.setDate(d.getDate() + days);
  return {
    days,
    date: d.toISOString().slice(0, 10),
    label: d
      .toLocaleDateString('en-GB', { month: 'long', day: 'numeric' })
      .toUpperCase()
  };
}

// Surface C — the shelf clock. Books with no page count are excluded from
// the sum and counted separately rather than silently undercounting.
export function shelfClock(pace, items) {
  const withPages = items.filter((i) => i.page_count);
  const pages = withPages.reduce((s, i) => s + i.page_count, 0);
  const unknown = items.length - withPages.length;

  if (!pace?.known || !pages) return { unknown, known: false };

  const days = Math.ceil(pages / pace.pagesPerDay);
  return { known: true, days, pages, unknown, label: humanDuration(days) };
}

export function humanDuration(days) {
  if (days <= 0) return 'TODAY';
  if (days < 31) return `${days} DAY${days === 1 ? '' : 'S'}`;

  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} MONTH${months === 1 ? '' : 'S'}`;

  const years = Math.floor(months / 12);
  const rem = months % 12;
  const y = `${years} YEAR${years === 1 ? '' : 'S'}`;
  return rem ? `${y} ${rem} MONTH${rem === 1 ? '' : 'S'}` : y;
}
