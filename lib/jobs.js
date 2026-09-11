import { rmSync } from 'node:fs';
import { all, get, run, sqlTime } from '../db/index.js';
import { sweepExpired } from './auth/tokens.js';
import { purgeUser } from './purge.js';
import * as audit from './audit.js';
import { notify } from './safety.js';

// ── Scheduled work ───────────────────────────────────────
//
// A real deployment would run these from cron or a job runner. This app is a
// single process with a local database, so they run on an interval inside it
// — which is enough for correctness, and is honest about being a single
// process (SECURITY.md lists it under scaling gaps).
//
// What matters is that they run AT ALL. §12: "Deletion must actually delete
// on a defined schedule, not soft-flag forever." Letterboxd's incident
// exposed deleted content, which means it was still there.

const HOUR = 3600_000;

/**
 * §10 — "Likes batch into a daily digest at most, and default to off."
 *
 * There is no per-like notification anywhere in the codebase, and this is
 * the only thing that ever mentions a like. It runs once a day per account
 * that has asked for it, says how many and on what, and links to the
 * reviews rather than to a counter.
 */
export function likesDigest({ now = Date.now() } = {}) {
  let sent = 0;

  for (const u of all(
    `SELECT id, username, digest_likes_at FROM users
      WHERE digest_likes = 1 AND notifications_paused = 0
        AND deleted_at IS NULL AND is_tombstone = 0
        AND (digest_likes_at IS NULL OR digest_likes_at <= ?)`,
    sqlTime(now - 24 * HOUR)
  )) {
    const since = u.digest_likes_at || sqlTime(now - 24 * HOUR);
    const rows = all(
      `SELECT COUNT(DISTINCT l.user_id) AS n, COUNT(DISTINCT l.review_id) AS reviews
         FROM review_likes l
         JOIN reviews r ON r.id = l.review_id
        WHERE r.user_id = ? AND r.deleted_at IS NULL
          AND l.user_id != r.user_id
          AND l.created_at > ? AND l.created_at <= ?`,
      u.id, since, sqlTime(now)
    );

    run('UPDATE users SET digest_likes_at = ? WHERE id = ?', sqlTime(now), u.id);

    const { n, reviews } = rows[0] || {};
    if (!n) continue;   // Nothing happened, so nothing is sent. No "quiet week" note.

    notify(u.id, {
      kind: 'likes_digest',
      subject: n === 1
        ? 'One person liked something you wrote'
        : `${n} people liked ${reviews === 1 ? 'something you wrote' : reviews + ' of your reviews'}`,
      url: u.username ? `/@${encodeURIComponent(u.username)}` : '/reviews'
    });
    sent++;
  }
  return sent;
}

export function runDue({ now = Date.now() } = {}) {
  const done = { purged: 0, unverified: 0, tokens: 0, reservations: 0, exports: 0, digests: 0 };

  try { done.digests = likesDigest({ now }); }
  catch (err) { console.error('  likes digest failed —', err.message); }

  // §12 — accounts past their 30-day grace period are hard-deleted.
  for (const u of all(
    `SELECT id FROM users WHERE purge_after IS NOT NULL AND purge_after <= ?
       AND is_tombstone = 0`,
    sqlTime(now)
  )) {
    purgeUser(u.id);
    done.purged++;
  }

  // §4 — an unverified account is removed after 7 days. Otherwise a signup
  // form is a way to reserve someone else's address indefinitely.
  for (const u of all(
    `SELECT id FROM users
      WHERE email_verified_at IS NULL AND is_tombstone = 0
        AND created_at < datetime('now', '-7 days')`
  )) {
    purgeUser(u.id, { tombstone: false });
    done.unverified++;
  }

  done.tokens = sweepExpired();

  // §9 — a released username returns to the pool after 90 days.
  done.reservations = run(
    `DELETE FROM username_reservations WHERE release_at < datetime('now')`
  ).changes;

  // §12 — an export link lasts an hour; the file should not outlive it by
  // much. A stale export sitting on disk is the same data with none of the
  // access control.
  for (const e of all(
    `SELECT id, path FROM exports WHERE expires_at < datetime('now', '-1 hour')`
  )) {
    try { rmSync(e.path, { force: true }); } catch { /* already gone */ }
    run('DELETE FROM exports WHERE id = ?', e.id);
    done.exports++;
  }

  const touched = Object.values(done).reduce((a, b) => a + b, 0);
  if (touched) {
    audit.systemAction('jobs.swept', { metadata: done });
    console.log(`  swept — ${Object.entries(done).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }

  // §3 — seasons close at 00:00 on 1 January and 1 July. The sweep runs
  // hourly and closing is idempotent, so a machine that was off over the
  // turn of the year catches up on its next boot rather than missing it.
  scheduleSeasonClose();

  // §14 — anomaly alerting is only alerting if something looks at it.
  for (const a of audit.anomalies()) {
    console.warn(`  ALERT — ${a.kind} by staff ${a.staffId}`, a);
  }

  return done;
}

let closing = false;
function scheduleSeasonClose() {
  if (closing) return;
  closing = true;

  (async () => {
    try {
      const RUN = await import('./season-run.js');
      for (const u of all(`SELECT id, settings FROM users WHERE is_tombstone = 0 AND deleted_at IS NULL`)) {
        let localOnly = true;
        try { localOnly = JSON.parse(u.settings || '{}').local_only !== false; } catch { /* default */ }
        const closed = await RUN.closeDue(u.id, { localOnly });
        for (const s of closed) {
          // §3 — "A single quiet notification: `A/W 26 closed. Nine books.`
          // No modal, no confetti, no 'your season is ready!' screen."
          const n = (await import('./seasons.js')).framesOf(s.id).length;
          console.log(`  ${s.code.toUpperCase()} closed. ${n} ${n === 1 ? 'book' : 'books'}.`);
        }
      }
    } catch (err) {
      console.error('  season close failed —', err.message);
    } finally {
      closing = false;
    }
  })();
}

export function startJobs() {
  if (process.env.NODE_ENV === 'test') return null;
  // Once at boot, so a process that has been down for a week catches up
  // rather than waiting a full interval before deleting anything.
  try { runDue(); } catch (err) { console.error('  job sweep failed —', err.message); }

  const timer = setInterval(() => {
    try { runDue(); } catch (err) { console.error('  job sweep failed —', err.message); }
  }, HOUR);
  timer.unref?.();
  return timer;
}
