import { get, all, run, nowSQL, parseSQLTime } from '../db/index.js';

// ── §12 — TRUST LEVELS ───────────────────────────────────
//
// Progressive privilege rather than a binary ban. It defuses most abuse
// without punishing anyone, because the account that has done nothing wrong
// simply keeps rising.
//
// The rule that matters more than the ladder: **never display a level on a
// profile.** It becomes a status game the moment it is visible, and a status
// game is precisely what farmed Goodreads' reviewer ranks into a bot
// economy. Nothing in this file returns a badge, and nothing renders one.
//
//   0  New          signup                Read. Rate (excluded from
//                                          aggregates). 3 reviews/day. No
//                                          links. No clubs. Max 50 followers.
//   1  Verified     email + 3d + 5 books  10 reviews/day. Join clubs. Comment.
//   2  Member       14d + 20 books        Ratings count. Links. Create clubs.
//                   + 3 reviews            Unlimited follows.
//                   + no upheld reports
//   3  Established  90d + 50 books        Higher limits. Reports weighted
//                   + none upheld in 60d   more. No new-review penalty.
//  −1  Limited      moderator action      Read-only. Content hidden. Appealable.

export const LIMITED = -1;

const DAY = 86_400_000;

/** What each level is allowed to do. Read by the routes, never by a view. */
export const CAPABILITIES = {
  [-1]: { reviewsPerDay: 0, canLink: false, canCreateClub: false, canJoinClub: false,
          canComment: false, ratingsCount: false, maxFollowers: 0, readOnly: true },
  0:    { reviewsPerDay: 3, canLink: false, canCreateClub: false, canJoinClub: false,
          canComment: false, ratingsCount: false, maxFollowers: 50, readOnly: false },
  1:    { reviewsPerDay: 10, canLink: false, canCreateClub: false, canJoinClub: true,
          canComment: true, ratingsCount: false, maxFollowers: 50, readOnly: false },
  2:    { reviewsPerDay: 25, canLink: true, canCreateClub: true, canJoinClub: true,
          canComment: true, ratingsCount: true, maxFollowers: Infinity, readOnly: false },
  3:    { reviewsPerDay: 60, canLink: true, canCreateClub: true, canJoinClub: true,
          canComment: true, ratingsCount: true, maxFollowers: Infinity, readOnly: false }
};

export const can = (level, capability) =>
  (CAPABILITIES[level] ?? CAPABILITIES[0])[capability];

/**
 * Compute a level from the account's own history.
 *
 * Deliberately a pure function of facts the account can see about itself:
 * age, books logged, reviews published, upheld reports. Nothing here is
 * discretionary, so nobody can be told they were held back by a judgement.
 */
export function computeLevel(user, { now = Date.now() } = {}) {
  if (!user) return 0;

  // A moderator's limit is the one thing that is not automatic, and it
  // outranks everything below.
  if (Number(user.trust_level) === LIMITED) return LIMITED;

  // The instance operator. Not a probationary account, and never was.
  if (user.is_owner) return 3;

  const ageDays = user.created_at
    ? (now - parseSQLTime(user.created_at)) / DAY
    : 0;

  const books = Number(user.books_logged) || 0;
  const reviews = Number(user.reviews_published) || 0;
  const upheld = Number(user.upheld_reports) || 0;
  const verified = !!user.email_verified_at;

  const upheldRecently = user.last_upheld_at
    ? (now - parseSQLTime(user.last_upheld_at)) < 60 * DAY
    : false;

  if (ageDays >= 90 && books >= 50 && upheld === 0 || (ageDays >= 90 && books >= 50 && !upheldRecently)) {
    return 3;
  }
  if (ageDays >= 14 && books >= 20 && reviews >= 3 && upheld === 0) return 2;
  if (verified && ageDays >= 3 && books >= 5) return 1;
  return 0;
}

/**
 * Recompute and store. §12 — "Levels rise automatically and silently."
 * Silently means no notification and no interface change: the account simply
 * finds that something it could not do before now works.
 */
export function refresh(userId, { now = Date.now() } = {}) {
  const user = get('SELECT * FROM users WHERE id = ?', Number(userId));
  if (!user) return 0;

  const level = computeLevel(user, { now });

  if (level !== Number(user.trust_level)) {
    run('UPDATE users SET trust_level = ? WHERE id = ?', level, Number(userId));
    run(
      `INSERT INTO user_trust (user_id, level, computed_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         level = excluded.level, computed_at = excluded.computed_at, reason = excluded.reason`,
      Number(userId), level, nowSQL(), 'automatic'
    );
  }
  return level;
}

/**
 * The level a capability check reads.
 *
 * The stored column is a cache that a scheduled job refreshes, so it can be
 * a day stale. Ownership cannot be stale and cannot be earned, so it is
 * answered here rather than waiting for a sweep to notice — otherwise the
 * operator of a brand-new instance is locked out of their own product until
 * a job they have never heard of happens to run.
 */
export const levelOf = (user) =>
  user?.is_owner ? 3 : Number(user?.trust_level ?? 0);

/**
 * §12 — demotion on upheld reports, with the reason sent to the user.
 *
 * This is the one path that is NOT automatic, so it takes a reason and
 * records who did it. Silent enforcement is what makes communities paranoid.
 */
export function limit(userId, { reason, by = null }) {
  run('UPDATE users SET trust_level = ? WHERE id = ?', LIMITED, Number(userId));
  run(
    `INSERT INTO user_trust (user_id, level, computed_at, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       level = excluded.level, computed_at = excluded.computed_at, reason = excluded.reason`,
    Number(userId), LIMITED, nowSQL(), String(reason || '').slice(0, 400)
  );
  return LIMITED;
}

export function restore(userId, { reason = 'appeal upheld' } = {}) {
  run('UPDATE users SET trust_level = 0 WHERE id = ?', Number(userId));
  run(`UPDATE user_trust SET level = 0, computed_at = ?, reason = ? WHERE user_id = ?`,
      nowSQL(), reason, Number(userId));
  return refresh(userId);
}

/** Records an upheld report against an account, which blocks Trust 2 and 3. */
export function recordUpheld(userId) {
  run(
    `UPDATE users SET upheld_reports = COALESCE(upheld_reports, 0) + 1, last_upheld_at = ?
      WHERE id = ?`,
    nowSQL(), Number(userId)
  );
  return refresh(userId);
}

// ── Rate limiting by level (§12, §10 of the security spec) ──
//
// Layered ON TOP of the per-IP limits in lib/auth/ratelimit.js, never
// instead of them: an attacker with many accounts is bounded by the IP
// limit, and an attacker with one high-trust account is bounded by this.
const writes = new Map();

export function withinWriteLimit(userId, kind, level) {
  const cap = kind === 'review'
    ? can(level, 'reviewsPerDay')
    : kind === 'post' ? 200
    : kind === 'follow' ? 100
    : 50;

  if (!cap) return { ok: false, cap: 0 };

  const key = `${kind}:${userId}`;
  const now = Date.now();
  const hits = (writes.get(key) || []).filter((t) => now - t < DAY);

  if (hits.length >= cap) {
    writes.set(key, hits);
    return { ok: false, cap, retryAfter: Math.ceil((hits[0] + DAY - now) / 1000) };
  }

  hits.push(now);
  writes.set(key, hits);
  return { ok: true, cap, remaining: cap - hits.length };
}

export function __resetLimits() { writes.clear(); }

/**
 * §12 — a Trust 0 account cannot be followed by more than 50 accounts.
 *
 * The cap exists so a brand-new account cannot be inflated into an
 * authority overnight; it is not a punishment and it lifts on its own.
 */
export function followerCapReached(userId) {
  const user = get('SELECT trust_level FROM users WHERE id = ?', Number(userId));
  const cap = can(levelOf(user), 'maxFollowers');
  if (cap === Infinity) return false;

  const n = get(
    `SELECT COUNT(*) n FROM user_follows WHERE followee_id = ? AND state = 'active'`,
    Number(userId)
  ).n;
  return n >= cap;
}

/** Recompute everybody — run after an import, or nightly. */
export function refreshAll({ now = Date.now() } = {}) {
  const users = all('SELECT id FROM users WHERE is_tombstone = 0 AND deleted_at IS NULL');
  for (const u of users) refresh(u.id, { now });
  return users.length;
}

// ── WHY NOT ──────────────────────────────────────────────
/**
 * What a capability is still waiting on.
 *
 * §12 says levels "rise automatically and silently" and that a level must
 * never appear on a profile — it becomes a status game the moment it is
 * visible. Neither of those means a locked door should be unlabelled.
 * Hiding the affordance entirely is what makes somebody ask whether the
 * feature exists at all, and the answer to that question is worse than the
 * answer to "not yet, and here is what it takes".
 *
 * So: nothing here is shown on a profile, nothing here is a number to
 * climb, and it is only ever said to the account it is about.
 */
export function whyNot(user, capability, { now = Date.now() } = {}) {
  if (can(levelOf(user), capability)) return null;
  if (levelOf(user) === LIMITED) return 'This account is read-only.';

  const RULES = {
    canCreateClub: [
      ['a fortnight old', DAY_MS(user, now) >= 14],
      ['twenty books logged', (Number(user.books_logged) || 0) >= 20],
      ['three reviews written', (Number(user.reviews_published) || 0) >= 3]
    ],
    canJoinClub: [
      ['a confirmed email', !!user.email_verified_at],
      ['three days old', DAY_MS(user, now) >= 3],
      ['five books logged', (Number(user.books_logged) || 0) >= 5]
    ],
    canLink: [
      ['a fortnight old', DAY_MS(user, now) >= 14],
      ['twenty books logged', (Number(user.books_logged) || 0) >= 20],
      ['three reviews written', (Number(user.reviews_published) || 0) >= 3]
    ]
  };

  const outstanding = (RULES[capability] || []).filter(([, met]) => !met).map(([label]) => label);
  if (!outstanding.length) return 'Not yet.';

  const list = outstanding.length === 1
    ? outstanding[0]
    : outstanding.slice(0, -1).join(', ') + ' and ' + outstanding.at(-1);
  return `Waiting on an account that is ${list}.`;
}

const DAY_MS = (user, now) =>
  user.created_at ? (now - Date.parse(String(user.created_at).replace(' ', 'T'))) / 86_400_000 : 0;
