import { randomUUID } from 'node:crypto';
import { all, run } from '../db/index.js';
import { monthDay } from './facts.js';

// ── §6 — MOVEMENTS ───────────────────────────────────────
//
// "Movements are the analysis made structural. Computed in code, named by
// the model." The model never chooses a boundary; it is handed the ones
// this file found and asked for a name.
//
// And the part that matters most:
//
//   "The empty movement is not a bug and must not be optimised away. It is
//    the single most distinctive thing in this feature. A month in which
//    someone did not read is part of their season, and naming it is more
//    honest and more interesting than hiding it. Do not add commentary, do
//    not add a prompt to read more, do not collapse it."
//
// So a gap over 28 days becomes a movement with a name, a range, a count of
// zero, and nothing beneath it but a hairline. There is no code path here
// that merges it away when it is inconvenient.

const GAP_DAYS = 21;         // a candidate boundary
const EMPTY_GAP_DAYS = 28;   // a gap that becomes its own movement
const MAX_MOVEMENTS = 4;
const MIN_BOOKS = 5;

const day = 86_400_000;
const at = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime();
const daysBetween = (a, b) => Math.round((at(b) - at(a)) / day);
const shift = (d, n) => new Date(at(d) + n * day).toISOString().slice(0, 10);

/**
 * Compute the movement structure for a season.
 *
 * Returns [] when there is no structure to report — which §12 requires for
 * a season under five books, and which is a legitimate answer rather than a
 * failure to find something.
 */
export function computeMovements(frames, facts, season) {
  // §6 — "Fewer than 5 books in the season → no movements."
  if (frames.length < MIN_BOOKS) return [];

  const ordered = [...frames].sort((a, b) =>
    String(a.finished_at || '').localeCompare(String(b.finished_at || '')));

  // ── Candidate boundaries ──
  const boundaries = [];

  // Any gap between consecutive finishes exceeding 21 days.
  for (let i = 1; i < ordered.length; i++) {
    const prev = String(ordered[i - 1].finished_at || '').slice(0, 10);
    const next = String(ordered[i].finished_at || '').slice(0, 10);
    if (!prev || !next) continue;
    const gap = daysBetween(prev, next);
    if (gap > GAP_DAYS) {
      boundaries.push({
        index: i, reason: 'gap', gap,
        from: prev, to: next,
        // A long enough silence is not a seam between movements. It is one.
        empty: gap > EMPTY_GAP_DAYS
      });
    }
  }

  // Any changepoint from §4.6 scoring above 1.2.
  for (const cp of facts.changepoints || []) {
    const idx = ordered.findIndex((f) => String(f.finished_at || '').slice(0, 10) >= cp.on);
    if (idx > 0 && idx < ordered.length) {
      boundaries.push({
        index: idx, reason: `changepoint:${cp.property}`,
        score: cp.score, on: cp.on, empty: false
      });
    }
  }

  if (!boundaries.length) return [];

  // Strongest first, then back into reading order. A gap's strength is its
  // length; a changepoint's is its separation score, scaled so the two are
  // roughly comparable.
  const strength = (b) => (b.reason === 'gap' ? b.gap / 21 : b.score);

  // The budget has to account for the EMPTY movements too. An earlier
  // version chose boundaries first and truncated the finished list to four,
  // which silently dropped whole runs of books — and §6 requires that every
  // book appear in exactly one movement. Boundaries are therefore taken one
  // at a time, and only while the movements they would produce still fit.
  const ranked = [...boundaries]
    .sort((a, b) => strength(b) - strength(a))
    .filter((b, i, arr) => arr.findIndex((x) => x.index === b.index) === i);

  const chosen = [];
  for (const b of ranked) {
    const next = [...chosen, b];
    // n boundaries make n+1 runs, plus one movement per empty gap.
    const total = next.length + 1 + next.filter((x) => x.empty).length;
    if (total > MAX_MOVEMENTS) continue;
    chosen.push(b);
  }
  chosen.sort((a, b) => a.index - b.index);

  if (!chosen.length) return [];

  // ── Build the runs ──
  const movements = [];
  let cursor = 0;

  // `side` records whether a run sits BEFORE or AFTER the boundary whose
  // reason it carries. Without it a run ending at a changepoint was named
  // for the state on the far side of that changepoint — so the stretch
  // before a turn to nonfiction was labelled "In nonfiction".
  const pushRun = (books, reason, side) => {
    if (!books.length) return;
    movements.push({
      is_empty: false,
      boundary_reason: reason,
      side,
      books,
      starts_on: String(books[0].finished_at || '').slice(0, 10),
      ends_on: String(books[books.length - 1].finished_at || '').slice(0, 10)
    });
  };

  for (const b of chosen) {
    pushRun(ordered.slice(cursor, b.index), b.reason, 'before');

    // §6 — the empty movement. It sits BETWEEN the run that ended and the
    // run that starts, covering the days nothing was finished.
    if (b.empty) {
      movements.push({
        is_empty: true,
        boundary_reason: 'gap',
        books: [],
        // The day after the last finish, to the day before the next one:
        // the span in which nothing closed.
        starts_on: shift(b.from, 1),
        ends_on: shift(b.to, -1),
        days: b.gap - 1
      });
    }

    cursor = b.index;
  }
  pushRun(ordered.slice(cursor), chosen[chosen.length - 1]?.reason || 'gap', 'after');

  // §6 — "Maximum 4 movements. Minimum 2, or none at all."
  const withBooks = movements.filter((m) => !m.is_empty);
  if (withBooks.length < 2) return [];

  // Every book is in exactly one movement, or the structure is wrong and
  // showing it would misreport the season.
  const placed = movements.reduce((n, m) => n + m.books.length, 0);
  if (placed !== ordered.length) return [];

  return movements;
}

/** §6 — numbered in lowercase roman. */
export function roman(n) {
  const table = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  let v = n;
  for (const [value, sym] of table) {
    while (v >= value) { out += sym; v -= value; }
  }
  return out;
}

/**
 * A name for an empty movement, composed rather than generated.
 *
 * §6 forbids commentary, so this is a date range and nothing else. The
 * model is never asked to name a silence — there is nothing in it to read,
 * and anything it produced would be an inference about the reader's life,
 * which §5.4 bans outright.
 */
export const emptyName = (m) => {
  const from = monthDay(m.starts_on);
  const to = monthDay(m.ends_on);
  return from === to ? from : `${from} to ${to}`;
};

/**
 * A name composed from what actually distinguishes the movement.
 *
 * §6 has the model name boundaries, but there may be no model — and a
 * movement rendered with no name at all is worse than one named from its
 * own boundary fact. Nothing here interprets: it reports the reason the
 * boundary exists, which is the Margiela rule (expose the process) rather
 * than an invented mood.
 */
export function describeMovement(m, facts) {
  if (m.is_empty) return emptyName(m);

  const reason = String(m.boundary_reason || '');
  const cp = (facts?.changepoints || []).find((c) => reason === `changepoint:${c.property}`);

  if (cp) {
    // The run BEFORE the boundary is named for the state before it; the run
    // after, for the state after. Getting this backwards labels a stretch
    // with the property it does not have.
    const rising = m.side === 'after' ? cp.after > cp.before : cp.before > cp.after;

    if (cp.property === 'translated') return rising ? 'In translation' : 'In English';
    if (cp.property === 'fiction')    return rising ? 'In fiction' : 'In nonfiction';
    if (cp.property === 'page_count') return rising ? 'The long ones' : 'The short ones';
    if (cp.property === 'pub_year')   return rising ? 'The recent ones' : 'The older ones';
    if (cp.property === 'rating')     return rising ? 'The better ones' : 'The lesser ones';
  }

  // A run bounded only by silence is named by its own span — and a run that
  // is one book on one day is named by that day, not by a range from a date
  // to itself.
  const from = monthDay(m.starts_on);
  const to = monthDay(m.ends_on);
  return from === to ? from : `${from} to ${to}`;
}

export function saveMovements(seasonId, movements, names = {}, facts = null) {
  run('DELETE FROM season_movements WHERE season_id = ?', seasonId);
  run('UPDATE season_frames SET movement_id = NULL WHERE season_id = ?', seasonId);

  movements.forEach((m, i) => {
    const id = randomUUID();
    run(
      `INSERT INTO season_movements
         (id, season_id, ordinal, name, starts_on, ends_on, is_empty, boundary_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, seasonId, i + 1,
      m.is_empty ? emptyName(m) : (names[i] || describeMovement(m, facts)),
      m.starts_on, m.ends_on, m.is_empty ? 1 : 0, m.boundary_reason
    );

    // §6 — "Every book appears in exactly one movement."
    for (const b of m.books) {
      run('UPDATE season_frames SET movement_id = ? WHERE season_id = ? AND reading_id = ?',
          id, seasonId, b.reading_id);
    }
  });
}

export const movementsOf = (seasonId) =>
  all('SELECT * FROM season_movements WHERE season_id = ? ORDER BY ordinal', seasonId);
