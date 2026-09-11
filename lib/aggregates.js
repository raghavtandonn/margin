import { randomUUID } from 'node:crypto';
import { get, all, run, nowSQL, sqlTime, parseSQLTime } from '../db/index.js';
import * as T from './trust.js';
import * as audit from './audit.js';

// ── §5 — RATINGS AND AGGREGATES ──────────────────────────
//
// "A public aggregate is the thing bombing attacks. Build it to be hard to
// move."
//
// Three decisions do most of the work, and none of them is a filter on
// opinion:
//
//   1. Only ratings from mature, trusted accounts count. A throwaway
//      account's rating is recorded and shown on its own profile, and
//      contributes nothing here until the account matures — at which point
//      it is backfilled. Bombing with fresh accounts is therefore pointless
//      rather than blocked, and nobody is stopped from participating.
//
//   2. The number shown is a MEDIAN with the full distribution beside it.
//      A bombed book shows a bimodal spike any human can see, which is far
//      more informative than "3.87" and visibly harder to fake.
//
//   3. Below 20 eligible ratings there is no aggregate at all. Small
//      numbers are meaningless, trivially manipulated, and — per §9 of the
//      security spec — a privacy leak: with five ratings and a known small
//      club, individual ratings become inferable.
//
// And the rule that removes the incentive: **nothing in this product is
// ever ranked by aggregate.** No bestseller list, no "highest rated", no
// trending. A leaderboard is a target, so there is no leaderboard.

export const SUPPRESS_BELOW = 20;
export const MATURE_DAYS = 14;

const DAY = 86_400_000;

/**
 * The ratings that count.
 *
 * A rating is eligible when its author is at Trust 2 or above, the account
 * is at least 14 days old, and the rating is not from an account the viewer
 * has blocked. The viewer clause is applied by the caller, because the
 * stored aggregate is viewer-independent by design — see §3 of the security
 * spec on caching: a viewer-dependent aggregate could not be cached at all.
 */
export function eligibleRatings(workId, { now = Date.now() } = {}) {
  return all(
    `SELECT r.stars, r.user_id, r.finished_at, u.created_at, u.trust_level
       FROM readings r JOIN users u ON u.id = r.user_id
      WHERE r.work_id = ? AND r.stars IS NOT NULL
        AND u.is_tombstone = 0 AND u.deleted_at IS NULL
        AND r.is_draft = 0`,
    Number(workId)
  ).filter((r) => {
    if (T.levelOf(r) < 2) return false;
    const age = (now - parseSQLTime(r.created_at)) / DAY;
    return age >= MATURE_DAYS;
  });
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** §5 — a trimmed mean, discarding the top and bottom 5%. */
function trimmedMean(values) {
  if (values.length < 3) return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.05);
  const kept = s.slice(cut, s.length - cut);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function recompute(workId, { now = Date.now() } = {}) {
  const ratings = eligibleRatings(workId, { now });
  const values = ratings.map((r) => r.stars);

  // Five buckets, by whole star.
  const distribution = [0, 0, 0, 0, 0];
  for (const v of values) {
    const bucket = Math.min(4, Math.max(0, Math.round(v) - 1));
    distribution[bucket]++;
  }

  const existing = get('SELECT * FROM book_rating_stats WHERE work_id = ?', Number(workId));

  // A frozen aggregate does not move while a human looks at it (§13.1).
  // The distribution keeps updating, because the distribution is the
  // evidence — it is what makes a bimodal spike visible.
  const frozen = existing?.frozen ? 1 : 0;

  run(
    `INSERT INTO book_rating_stats
       (work_id, distribution, median, trimmed_mean, eligible_count, frozen, frozen_value, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (work_id) DO UPDATE SET
       distribution = excluded.distribution,
       median = excluded.median,
       trimmed_mean = excluded.trimmed_mean,
       eligible_count = excluded.eligible_count,
       computed_at = excluded.computed_at`,
    Number(workId), JSON.stringify(distribution),
    median(values), trimmedMean(values), values.length,
    frozen, existing?.frozen_value ?? null, nowSQL()
  );

  return get('SELECT * FROM book_rating_stats WHERE work_id = ?', Number(workId));
}

/**
 * What a book page shows.
 *
 * Under the threshold this returns the distribution and the count and NO
 * number — not a number with a caveat beside it, because a number with a
 * caveat is still a number people quote.
 */
export function display(workId, { now = Date.now() } = {}) {
  let stats = get('SELECT * FROM book_rating_stats WHERE work_id = ?', Number(workId));
  if (!stats) stats = recompute(workId, { now });

  const distribution = JSON.parse(stats.distribution || '[0,0,0,0,0]');
  const n = stats.eligible_count;

  if (stats.frozen) {
    return {
      suppressed: false, frozen: true,
      // §13.1 — the pre-spike value, held while a human decides.
      median: stats.frozen_value,
      distribution, count: n,
      notice: 'Ratings on this title are under review.'
    };
  }

  if (n < SUPPRESS_BELOW) {
    return { suppressed: true, distribution, count: n, median: null };
  }

  return { suppressed: false, frozen: false, median: stats.median, distribution, count: n };
}

// ── §13.1 — REVIEW BOMBING ───────────────────────────────
//
// "Detect the pattern, not the opinion."
//
//   velocity vs the book's own 30-day baseline
//   share from accounts under 30 days old
//   share at the extremes vs baseline
//   clustering by signup date
//
// Freezing rather than deleting is deliberate: legitimate spikes happen —
// an adaptation, an award, a viral post. A human decides; the automation
// only buys time.

export function detectBombing(workId, { now = Date.now(), windowHours = 24 } = {}) {
  const since = sqlTime(now - windowHours * 3600_000);
  const baselineFrom = sqlTime(now - 30 * DAY);

  const recent = all(
    `SELECT r.stars, r.user_id, u.created_at
       FROM readings r JOIN users u ON u.id = r.user_id
      WHERE r.work_id = ? AND r.stars IS NOT NULL AND r.created_at >= ?`,
    Number(workId), since
  );
  if (recent.length < 10) return null;

  const baseline = get(
    `SELECT COUNT(*) n FROM readings
      WHERE work_id = ? AND stars IS NOT NULL AND created_at >= ? AND created_at < ?`,
    Number(workId), baselineFrom, since
  ).n;

  // Per-window rate over the prior thirty days, floored so a book with no
  // history does not divide by zero into infinity.
  const perWindow = Math.max(0.5, baseline / (30 * 24 / windowHours));
  const velocity = recent.length / perWindow;

  const newAccounts = recent.filter(
    (r) => (now - parseSQLTime(r.created_at)) / DAY < 30
  ).length;
  const newShare = newAccounts / recent.length;

  const extremes = recent.filter((r) => r.stars <= 1 || r.stars >= 5).length;
  const extremeShare = extremes / recent.length;

  // §13.1's own threshold, unchanged.
  const bombing = velocity > 5 && (newShare > 0.4 || extremeShare > 0.8);
  if (!bombing) return null;

  return {
    work_id: Number(workId),
    velocity: Number(velocity.toFixed(2)),
    new_share: Number(newShare.toFixed(2)),
    extreme_share: Number(extremeShare.toFixed(2)),
    accounts: [...new Set(recent.map((r) => r.user_id))]
  };
}

/**
 * Freeze — the aggregate stops at its pre-spike value, the book is queued
 * for a human with the contributing accounts listed, and the page says so.
 * Nothing is deleted and nobody is banned.
 */
export function freeze(workId, finding) {
  const stats = get('SELECT * FROM book_rating_stats WHERE work_id = ?', Number(workId));
  const preSpike = stats?.frozen_value ?? stats?.median ?? null;

  run(
    `UPDATE book_rating_stats SET frozen = 1, frozen_value = ?, frozen_at = ? WHERE work_id = ?`,
    preSpike, nowSQL(), Number(workId)
  );

  const id = randomUUID();
  run(
    `INSERT INTO bombing_flags (id, work_id, velocity, new_share, extreme_share, accounts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, Number(workId), finding.velocity, finding.new_share, finding.extreme_share,
    JSON.stringify(finding.accounts)
  );

  audit.record({
    actorType: 'system', action: 'aggregate.frozen',
    metadata: { work: workId, ...finding, accounts: finding.accounts.length }
  });

  console.warn(`  ALERT — ratings on work ${workId} frozen: velocity ${finding.velocity}×`);
  return id;
}

export function unfreeze(workId, { staff, reason }) {
  run(`UPDATE book_rating_stats SET frozen = 0, frozen_value = NULL WHERE work_id = ?`, Number(workId));
  run(`UPDATE bombing_flags SET state = 'dismissed', resolved_by = ?, resolved_at = ?
        WHERE work_id = ? AND state = 'open'`, staff.id, nowSQL(), Number(workId));

  audit.record({
    actorType: 'staff', actorId: staff.id, action: 'aggregate.unfrozen',
    reason, fields: ['book_rating_stats'], metadata: { work: workId }
  });
  recompute(workId);
  return { ok: true };
}

/** The hourly sweep. Books that have been rated recently, and only those. */
export function sweep({ now = Date.now() } = {}) {
  const active = all(
    `SELECT DISTINCT work_id FROM readings
      WHERE stars IS NOT NULL AND created_at >= ?`,
    sqlTime(now - 24 * 3600_000)
  );

  const flagged = [];
  for (const { work_id } of active) {
    recompute(work_id, { now });
    const already = get(
      `SELECT 1 AS x FROM book_rating_stats WHERE work_id = ? AND frozen = 1`, work_id
    );
    if (already) continue;

    const finding = detectBombing(work_id, { now });
    if (finding) { freeze(work_id, finding); flagged.push(work_id); }
  }
  return flagged;
}

/**
 * §12 — "Ratings from accounts under 14 days old are recorded, shown on
 * their own profile, and excluded from aggregates until the account matures
 * — then backfilled."
 *
 * Backfilling is just a recompute of every book the account has rated, once
 * it crosses the line.
 */
export function backfillFor(userId) {
  const works = all(
    'SELECT DISTINCT work_id FROM readings WHERE user_id = ? AND stars IS NOT NULL',
    Number(userId)
  );
  for (const w of works) recompute(w.work_id);
  return works.length;
}
