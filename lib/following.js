import { get, all, run, nowSQL } from '../db/index.js';
import * as V from './visibility.js';
import * as T from './trust.js';
import { notify } from './safety.js';
import * as audit from './audit.js';

// ── §3 — FOLLOWING ───────────────────────────────────────
//
// Asymmetric follows, not symmetric friendship.
//
// "Goodreads' mutual-friend model creates social obligation and makes
// declining awkward. Following someone whose taste you like should carry no
// reciprocity."
//
// So there is ONE relationship type. No mutual-follow special status, no
// friends tier, no close-friends list — "anything more becomes a hierarchy
// people manage instead of a tool they use."

export function follow(follower, followeeId, { req = null } = {}) {
  if (Number(follower.id) === Number(followeeId)) {
    return { ok: false, error: 'You cannot follow yourself.' };
  }

  const followee = get('SELECT * FROM users WHERE id = ? AND is_tombstone = 0', Number(followeeId));

  // §15 — "Follow attempt: fails as if the account does not exist." Not an
  // error that confirms a block, because a block is never disclosed.
  if (!followee || V.blockedBetween(follower.id, followeeId)) throw new V.NotFound();

  if (T.can(T.levelOf(follower), 'readOnly')) {
    return { ok: false, error: 'This account is read-only.' };
  }

  // §12 — a Trust 0 account cannot be followed by more than 50, so it
  // cannot be inflated into an authority overnight.
  if (T.followerCapReached(followeeId)) {
    return { ok: false, error: 'That account is not accepting more followers yet.' };
  }

  const limit = T.withinWriteLimit(follower.id, 'follow', T.levelOf(follower));
  if (!limit.ok) return { ok: false, error: 'Slow down.' };

  // §3 — a public account is followed instantly; a private one generates a
  // request. The account's own setting can narrow this further.
  const isPublic = followee.profile_visibility === 'public';
  const wantsRequests = followee.who_can_follow === 'approved';
  const state = isPublic && !wantsRequests ? 'active' : 'requested';

  run(
    `INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, ?)
     ON CONFLICT (follower_id, followee_id) DO UPDATE SET state = excluded.state`,
    Number(follower.id), Number(followeeId), state
  );

  notify(followeeId, {
    kind: state === 'active' ? 'followed' : 'follow_request',
    actorId: follower.id,
    subject: state === 'active' ? 'started following you' : 'asked to follow you',
    url: state === 'active' ? `/@${follower.username}` : '/settings/requests'
  });

  audit.record({
    actorType: 'user', actorId: follower.public_id || follower.id,
    action: state === 'active' ? 'user.followed' : 'user.follow_requested',
    targetUserId: Number(followeeId), ip: req?.ip
  });

  return { ok: true, state };
}

export function unfollow(followerId, followeeId) {
  run('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?',
      Number(followerId), Number(followeeId));
  return { ok: true };
}

/** §3 — approving is a notification; declining is silent. */
export function approve(userId, followerId) {
  const changed = run(
    `UPDATE user_follows SET state = 'active'
      WHERE follower_id = ? AND followee_id = ? AND state = 'requested'`,
    Number(followerId), Number(userId)
  ).changes;
  if (!changed) throw new V.NotFound();

  notify(followerId, {
    kind: 'follow_approved', actorId: userId,
    subject: 'approved your request', url: null
  });
  return { ok: true };
}

/**
 * §3 — "Declining is silent — no notification to the requester."
 *
 * Somebody who is declined should not be handed a moment to react to.
 */
export function decline(userId, followerId) {
  run(
    `DELETE FROM user_follows
      WHERE follower_id = ? AND followee_id = ? AND state = 'requested'`,
    Number(followerId), Number(userId)
  );
  return { ok: true };
}

/** §3 — removing a follower is possible without blocking, and is silent. */
export function removeFollower(userId, followerId) {
  run('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?',
      Number(followerId), Number(userId));
  return { ok: true };
}

// ── Reading the graph ────────────────────────────────────
//
// §8 of the security spec — "the social graph is the asset most worth
// stealing and the one people most expect to be protected." So lists
// paginate with opaque cursors rather than offsets, and depth is capped for
// anyone who is not the owner.

const PAGE = 40;
const MAX_DEPTH_FOR_OTHERS = 5;   // pages

const encodeCursor = (row) =>
  row ? Buffer.from(`${row.created_at}|${row.follower_id ?? row.followee_id}`).toString('base64url') : null;

const decodeCursor = (c) => {
  if (!c) return null;
  try {
    const [at, id] = Buffer.from(String(c), 'base64url').toString('utf8').split('|');
    return at && id ? { at, id: Number(id) } : null;
  } catch { return null; }
};

export function followers(userId, viewer, { cursor = null, page = 0 } = {}) {
  const isOwner = Number(viewer?.id) === Number(userId);

  // §8 — "Cap list depth for non-owners. A viewer can page a reasonable
  // distance; a scraper cannot walk 100,000 followers."
  if (!isOwner && page >= MAX_DEPTH_FOR_OTHERS) return { rows: [], next: null, capped: true };

  const after = decodeCursor(cursor);
  const v = V.visibleSQL(viewer, { owner: 'u' });

  const rows = all(
    `SELECT f.follower_id, f.created_at, u.username, u.display_name, u.avatar_key
       FROM user_follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ? AND f.state = 'active'
        ${after ? 'AND (f.created_at, f.follower_id) < (?, ?)' : ''}
        AND ${v.sql}
      ORDER BY f.created_at DESC, f.follower_id DESC
      LIMIT ?`,
    Number(userId), ...(after ? [after.at, after.id] : []), ...v.params, PAGE + 1
  );

  const hasMore = rows.length > PAGE;
  const out = rows.slice(0, PAGE);
  return { rows: out, next: hasMore ? encodeCursor(out[out.length - 1]) : null, capped: false };
}

export function following(userId, viewer, { cursor = null, page = 0 } = {}) {
  const isOwner = Number(viewer?.id) === Number(userId);
  if (!isOwner && page >= MAX_DEPTH_FOR_OTHERS) return { rows: [], next: null, capped: true };

  const after = decodeCursor(cursor);
  const v = V.visibleSQL(viewer, { owner: 'u' });

  const rows = all(
    `SELECT f.followee_id, f.created_at, u.username, u.display_name, u.avatar_key
       FROM user_follows f JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ? AND f.state = 'active'
        ${after ? 'AND (f.created_at, f.followee_id) < (?, ?)' : ''}
        AND ${v.sql}
      ORDER BY f.created_at DESC, f.followee_id DESC
      LIMIT ?`,
    Number(userId), ...(after ? [after.at, after.id] : []), ...v.params, PAGE + 1
  );

  const hasMore = rows.length > PAGE;
  const out = rows.slice(0, PAGE);
  return { rows: out, next: hasMore ? encodeCursor(out[out.length - 1]) : null, capped: false };
}

export const pendingRequests = (userId) =>
  all(
    `SELECT f.follower_id, f.created_at, u.username, u.display_name, u.avatar_key
       FROM user_follows f JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = ? AND f.state = 'requested'
      ORDER BY f.created_at DESC`,
    Number(userId)
  );

export const relationship = (viewerId, otherId) => {
  if (!viewerId || Number(viewerId) === Number(otherId)) return { self: true };
  const out = get(
    'SELECT state FROM user_follows WHERE follower_id = ? AND followee_id = ?',
    Number(viewerId), Number(otherId)
  );
  const back = get(
    `SELECT state FROM user_follows WHERE follower_id = ? AND followee_id = ? AND state = 'active'`,
    Number(otherId), Number(viewerId)
  );
  return {
    self: false,
    following: out?.state === 'active',
    requested: out?.state === 'requested',
    // Shown as a fact, not as a tier: §3 forbids a mutual-follow status.
    followsYou: !!back
  };
};

/**
 * §2.1 — "Counts are shown but never celebrated." Rendered in mono at 10px
 * alongside everything else: no large numerals, no badges, no checks.
 */
export const counts = (userId) => ({
  followers: get(
    `SELECT COUNT(*) n FROM user_follows WHERE followee_id = ? AND state = 'active'`,
    Number(userId)
  ).n,
  following: get(
    `SELECT COUNT(*) n FROM user_follows WHERE follower_id = ? AND state = 'active'`,
    Number(userId)
  ).n
});
