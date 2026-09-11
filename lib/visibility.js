// ── §10 "THE PRIVACY MODEL" ──────────────────────────────
//
// Three independent layers — account, shelf, entry — and the effective
// visibility of anything is the MOST RESTRICTIVE of the three.
//
// The rule that matters more than the model: this is enforced in the DATA
// LAYER. Every read path takes a viewer and filters in SQL. Nothing is
// fetched and then hidden in a template, because a template hides things
// only from the page — not from the JSON endpoint, not from the OG tags,
// not from the sitemap, and not from the search index.
//
// §13.4 calls broken object-level authorisation the single most likely real
// bug in an app of this shape, and it is right: one unscoped
// `SELECT * FROM readings WHERE id = ?` is the whole vulnerability class in
// a single line. Postgres would have row-level security under this as a
// backstop. SQLite has none, so this module is the only thing standing
// there, and test/visibility.test.js exists to keep it honest.

import { get } from '../db/index.js';

// private < members < public. Taking a minimum over the three layers is what
// makes "most restrictive wins" a property of the arithmetic rather than a
// rule someone has to remember at each call site.
const RANK = { private: 0, members: 1, public: 2 };

export const VISIBILITIES = ['public', 'members', 'private'];
export const ENTRY_VISIBILITIES = ['inherit', ...VISIBILITIES];

export const rank = (v) => (v in RANK ? RANK[v] : RANK.private);

// The viewer context. Anonymous is the default everywhere: a caller that
// forgets to pass a viewer gets the least privilege, not the most.
export function viewerOf(req) {
  const u = req?.user;
  if (!u || !u.id) return { id: null, isMember: false, trust: 0 };
  return { id: u.id, isMember: true, trust: u.trust_level ?? 0 };
}

export const ANONYMOUS = { id: null, isMember: false, trust: 0 };

// The minimum rank a row must reach before this viewer may see it.
const floorFor = (viewer) => (viewer?.isMember ? RANK.members : RANK.public);

// ── SQL ──────────────────────────────────────────────────
// An 'inherit' layer contributes nothing of its own, so it resolves to the
// layer above rather than to a fixed value.
const inheritable = (col, parent) =>
  `CASE ${col} WHEN 'inherit' THEN ${parent} ELSE ${col} END`;

const rankSQL = (expr) =>
  `CASE ${expr} WHEN 'public' THEN 2 WHEN 'members' THEN 1 ELSE 0 END`;

/**
 * A WHERE fragment restricting rows to what `viewer` may see.
 *
 * Pass the aliases actually used by the query. `owner` is required — there
 * is no default, because guessing the owner table is how a scope silently
 * stops scoping.
 *
 *   const v = visibleSQL(viewer, { owner: 'u', shelf: 'sh', entry: 'si' });
 *   `SELECT … FROM shelf_items si JOIN shelves sh … JOIN users u … WHERE ${v.sql}`
 *
 * community-security §2.1 — this gained block state, club membership and
 * trust when the social layer arrived, and it is still ONE function. There
 * is deliberately no visibleForClub, visibleForFeed or visibleForBookPage:
 * divergent scopes are how leaks happen, because the one nobody updated is
 * the one that keeps serving.
 *
 * Effective visibility is the MOST RESTRICTIVE of every applicable layer:
 *
 *   account ∩ shelf ∩ entry
 *           ∩ NOT blocked(viewer, owner) in EITHER direction
 *           ∩ club membership where the resource is club-scoped
 *           ∩ trust where the resource is trust-gated
 */
export function visibleSQL(viewer, {
  owner, shelf = null, entry = null, ownerIdCol = null,
  club = null, requireTrust = null, accountGates = true
}) {
  if (!owner) throw new Error('visibleSQL requires an owner alias');

  const params = [];

  // The owner sees their own rows whatever the three layers say. This is the
  // only bypass, and it compares against the session's user id — never
  // against anything from the request.
  const ownerCol = ownerIdCol || `${owner}.id`;
  // The placeholder is bound at each USE of the clause, not here — it appears
  // zero, one, or two times depending on the layers in play, and binding it
  // eagerly is how a param list silently slips out of step with its SQL.
  const selfClause = viewer?.id ? `${ownerCol} = ?` : '0';

  // Account layer. A deleted, deactivated, or unverified account publishes
  // nothing: §4 is explicit that an unverified account cannot make anything
  // public, and enforcing it here means no write path can forget to.
  let acct = `${owner}.profile_visibility`;
  if (shelf) acct = inheritable(`${shelf}.visibility`, acct);
  if (entry) acct = inheritable(`${entry}.visibility`, acct);

  const gates = [
    `${owner}.deleted_at IS NULL`,
    `${owner}.deactivated_at IS NULL`,
    `${owner}.is_tombstone = 0`,
    `${owner}.email_verified_at IS NOT NULL`
  ];

  // Every intermediate layer is also floored, so a public entry on a private
  // shelf stays private — the minimum is taken across all three, not just
  // the innermost one.
  const layers = [rankSQL(`${owner}.profile_visibility`)];
  if (shelf) layers.push(rankSQL(inheritable(`${shelf}.visibility`, `${owner}.profile_visibility`)));
  if (entry) layers.push(rankSQL(acct));

  const effective = layers.length > 1 ? `MIN(${layers.join(', ')})` : layers[0];

  // A CONTAINER row — a club — is not owned content, and its account layer
  // is nobody's. Applying one would mean a host with a private profile
  // hiding a public club from its own members, and a club vanishing the day
  // its host deletes their account. `ownerIdCol` still points at the host so
  // blocks apply; the club layer below does the actual restricting.
  let sql;
  if (accountGates) {
    sql = `(${selfClause} OR (${gates.join(' AND ')} AND ${effective} >= ${floorFor(viewer)}))`;
    if (viewer?.id) params.push(Number(viewer.id));
  } else {
    sql = '(1)';
  }

  // ── Blocks (§15) ──
  // Mutual invisibility, in BOTH directions, and applied outside the
  // self-clause so it cannot be bypassed by a resource the viewer owns.
  //
  // A half-enforced block is worse than none, because it creates false
  // confidence. This is why the check lives here rather than in a template.
  if (viewer?.id) {
    sql = `(${sql} AND NOT EXISTS (
      SELECT 1 FROM blocks b
       WHERE (b.blocker_id = ? AND b.blocked_id = ${ownerCol})
          OR (b.blocked_id = ? AND b.blocker_id = ${ownerCol})
    ))`;
    params.push(Number(viewer.id), Number(viewer.id));
  }

  // ── Club scope (§9.1) ──
  // A private club's contents are members-only; an unlisted one is readable
  // by anyone holding the link. Non-members of a private club get nothing,
  // which the route turns into a 404 rather than a 403.
  if (club) {
    if (viewer?.id) {
      sql = `(${sql} AND (
        ${club}.visibility != 'private'
        OR EXISTS (SELECT 1 FROM club_members cm
                    WHERE cm.club_id = ${club}.id AND cm.user_id = ?
                      AND cm.state = 'active')
      ))`;
      params.push(Number(viewer.id));
    } else {
      sql = `(${sql} AND ${club}.visibility != 'private')`;
    }
  }

  // ── Trust gate (§12) ──
  // Applied to the resource's AUTHOR, not to the viewer: content from an
  // account that has not reached the level is withheld from everyone but
  // its owner.
  if (requireTrust != null) {
    sql = `(${sql} AND (${selfClause} OR COALESCE(${owner}.trust_level, 0) >= ${Number(requireTrust)}))`;
    if (viewer?.id) params.push(Number(viewer.id));
  }

  return { sql, params };
}

// ── §15 — blocks, as a predicate ─────────────────────────
/**
 * Reading history follows the profile. Shelves describe collections, not
 * whether someone may know a book was read. Individual reads have no
 * privacy setting; legacy readings.visibility values are ignored.
 * Callers still exclude incomplete drafts and never select private notes.
 */
export function visibleReadingSQL(viewer, { owner }) {
  return visibleSQL(viewer, { owner });
}

/**
 * Mutual. `blocks(a, b)` is true if EITHER has blocked the other, because
 * every consequence in §15's table is symmetric: profiles 404 both ways,
 * reviews hide both ways, Latest is mutually absent.
 */
export function blockedBetween(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  return !!get(
    `SELECT 1 AS x FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?)
         OR (blocker_id = ? AND blocked_id = ?)
      LIMIT 1`,
    Number(a), Number(b), Number(b), Number(a)
  );
}

/** One-directional, and it severs nothing. */
export const hasMuted = (muter, muted) =>
  !!get('SELECT 1 AS x FROM mutes WHERE muter_id = ? AND muted_id = ?',
        Number(muter), Number(muted));

// ── Object-level checks ──────────────────────────────────
// §19: "user A requesting user B's object by id receives 404, not 403 and
// not the object." 403 confirms the object exists, which is itself the leak.
export class NotFound extends Error {
  constructor() {
    super('Not found');
    this.status = 404;
  }
}

/**
 * The guard for every user-owned row. `row.user_id` is compared against the
 * SESSION's id — the caller cannot pass an id in and have it honoured.
 */
export function assertOwner(row, viewer) {
  if (!row || !viewer?.id || Number(row.user_id) !== Number(viewer.id)) throw new NotFound();
  return row;
}

/** Whether a profile is visible at all. A private profile 404s (§9). */
export function profileVisibleTo(user, viewer) {
  if (!user) return false;
  if (viewer?.id && Number(viewer.id) === Number(user.id)) return true;
  if (user.deleted_at || user.deactivated_at || user.is_tombstone) return false;
  if (!user.email_verified_at) return false;

  // §15 — "Profile: 404 both ways." A block is checked before visibility so
  // a public profile is still invisible to someone it has blocked.
  if (viewer?.id && blockedBetween(viewer.id, user.id)) return false;

  // §3 — a private account's followers see it. Following is what makes a
  // private profile readable, and that is the whole point of the request.
  if (viewer?.id && rank(user.profile_visibility) < floorFor(viewer)) {
    const approved = get(
      `SELECT 1 AS x FROM user_follows
        WHERE follower_id = ? AND followee_id = ? AND state = 'active'`,
      Number(viewer.id), Number(user.id)
    );
    if (approved) return true;
  }

  return rank(user.profile_visibility) >= floorFor(viewer);
}

/** Effective visibility of one entry, for rendering a per-row control. */
export function effectiveVisibility({ account, shelf = 'inherit', entry = 'inherit' }) {
  const resolvedShelf = shelf === 'inherit' ? account : shelf;
  const resolvedEntry = entry === 'inherit' ? resolvedShelf : entry;
  const r = Math.min(rank(account), rank(resolvedShelf), rank(resolvedEntry));
  return VISIBILITIES.find((v) => RANK[v] === r) || 'private';
}

// ── Write-path rules ─────────────────────────────────────
// §4 and §15. Whether an account is ALLOWED to become public is a different
// question from whether a given row IS public, and it belongs on the write
// path so that no read path has to re-derive it.
export function canGoPublic(user) {
  if (!user.email_verified_at) {
    return { ok: false, reason: 'Verify your email address first.' };
  }
  // The age-and-history test used to live here, and it made a brand new
  // account unviewable. That is no longer what §15 asks for: profiles are
  // public by default now, and an account nobody can look at is not a
  // defence against impersonation — an account nobody can FIND is. See
  // isEstablished, which is where that test moved.
  return { ok: true };
}

/**
 * §15 — whether this account may be LISTED.
 *
 * The distinction this draws is the whole of the anti-impersonation
 * argument, so it is worth stating plainly:
 *
 *   VIEWABLE    somebody you gave the link to can open your profile.
 *               True from the first minute, for everyone.
 *
 *   LISTED      you appear in /readers, in reader search, and in the
 *               people surfaces where strangers encounter strangers.
 *               True once the account has some history behind it.
 *
 * An impersonator's account is worth something only if it reaches people
 * who did not go looking for it. Withholding the listing takes that away
 * and costs a real reader nothing, because a real reader on their first day
 * is sending the link to people who already know them.
 *
 * The thresholds are unchanged from the ones §15 named: seven days, or ten
 * books. Email verification is still absolute.
 */
export function isEstablished(user, { now = Date.now() } = {}) {
  if (!user || !user.email_verified_at) return false;
  const created = Date.parse(`${String(user.created_at).replace(' ', 'T')}Z`);
  const ageDays = Number.isFinite(created) ? (now - created) / 86_400_000 : 0;
  return ageDays >= 7 || (Number(user.books_logged) || 0) >= 10;
}

/** The SQL form of isEstablished, for the listing queries. */
export const ESTABLISHED_SQL = (alias = 'u') =>
  `(${alias}.email_verified_at IS NOT NULL
    AND (julianday('now') - julianday(${alias}.created_at) >= 7
         OR COALESCE(${alias}.books_logged, 0) >= 10))`;

/**
 * §10.4 — turning a shelf private must purge it from caches and from the
 * search index immediately, not on the next natural expiry. There is no CDN
 * in front of this deployment; what there IS is an in-process search index
 * and HTTP caching, and both are handled here so the call site cannot
 * forget one of them.
 */
export function onVisibilityNarrowed(userId) {
  return { purgeIndex: true, userId: Number(userId) };
}
