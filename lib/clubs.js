import { randomUUID } from 'node:crypto';
import { newToken, hashToken } from './crypto.js';
import { get, all, run, nowSQL, sqlTime } from '../db/index.js';
import { cleanText, toHTML, skeleton } from './markdown.js';
import * as V from './visibility.js';
import * as T from './trust.js';
import { notify } from './safety.js';
import * as audit from './audit.js';

// ── §9 — CLUBS ───────────────────────────────────────────
//
// "The warmest surface in the product and the one that will actually retain
// people."
//
// And, per §11 of the security spec, a privilege boundary: a host of a
// 5,000-member club has real power over real people. Every admin action
// here writes to the audit log, destructive ones need step-up, and removed
// members are told — "silent removal is how communities become paranoid,
// and it also hides admin abuse."

export const VISIBILITIES = ['public', 'unlisted', 'private'];
export const JOIN_POLICIES = ['open', 'request', 'invite_only'];
export const ROLES = ['host', 'admin', 'member'];

/**
 * What each role is CALLED.
 *
 * The database says `host` and will keep saying it — renaming a column to
 * change a label is how a schema accumulates synonyms. "Head" is what the
 * top of a book club is called out loud, and it is what every surface
 * prints.
 */
export const ROLE_LABEL = { host: 'HEAD', admin: 'ADMIN', member: 'MEMBER' };
export const roleLabel = (role) => ROLE_LABEL[role] || 'MEMBER';

export const DEFAULT_CAP = 500;
export const HARD_CAP = 5000;

// §13.4 — a reserved-word list, and the same confusable normalisation the
// usernames use, so a Cyrillic homograph of an existing club collides.
const RESERVED = new Set([
  'new', 'create', 'admin', 'settings', 'api', 'clubs', 'club', 'search',
  'discover', 'staff', 'moderation', 'help', 'support', 'about', 'terms',
  'privacy', 'security', 'report', 'latest', 'seasons', 'shelves', 'reading'
]);

export function validateSlug(raw) {
  const input = String(raw ?? '').trim();

  // The skeleton is taken from the RAW input, before the slug is stripped
  // down to [a-z0-9-]. Stripping first would turn a Cyrillic а into a hyphen
  // and the homograph would then compare as a different word — which is
  // exactly the impersonation the check exists to stop.
  const skel = skeleton(input);

  const slug = input.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (slug.length < 3 || slug.length > 40) return { ok: false, error: 'Three to forty characters.' };
  if (RESERVED.has(slug)) return { ok: false, error: 'That name is taken.' };
  for (const r of RESERVED) if (skeleton(r) === skel) return { ok: false, error: 'That name is taken.' };

  const clash = all('SELECT slug_skeleton FROM clubs').some((c) => c.slug_skeleton === skel);
  if (clash) return { ok: false, error: 'That name is taken.' };

  return { ok: true, slug, skeleton: skel };
}

// ── Creation ─────────────────────────────────────────────
export function create(user, { name, slug, description, visibility = 'public', joinPolicy = 'open' }) {
  // §11 of the security spec — club creation requires Trust 2.
  if (!T.can(T.levelOf(user), 'canCreateClub')) {
    return { ok: false, error: 'Clubs can be made once your account is a fortnight old.' };
  }

  const cleanName = cleanText(name, { max: 60 });
  if (cleanName.length < 3) return { ok: false, error: 'Give it a name.' };

  const s = validateSlug(slug || cleanName);
  if (!s.ok) return s;

  if (!VISIBILITIES.includes(visibility)) visibility = 'public';
  if (!JOIN_POLICIES.includes(joinPolicy)) joinPolicy = 'open';

  const id = randomUUID();
  run(
    `INSERT INTO clubs (id, slug, slug_skeleton, name, description, visibility, join_policy, host_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, s.slug, s.skeleton, cleanName,
    cleanText(description, { max: 600 }) || null,
    visibility, joinPolicy, Number(user.id)
  );

  // §9.2 — "A club must always have exactly one host."
  run(`INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'host', 'active')`,
      id, Number(user.id));

  audit.record({
    actorType: 'user', actorId: user.public_id || user.id, action: 'club.created',
    targetUserId: Number(user.id), metadata: { club: id, slug: s.slug }
  });

  return { ok: true, id, slug: s.slug };
}

// ── Reading ──────────────────────────────────────────────
//
// The club layer of visibleSQL does the work: a private club is invisible
// to a non-member, which the route turns into a 404 rather than a 403.

export function bySlug(slug, viewer) {
  const v = V.visibleSQL(viewer, {
    owner: 'c', ownerIdCol: 'c.host_id', accountGates: false, club: 'c'
  });
  return get(
    `SELECT c.*, u.username AS host_username, u.display_name AS host_name
       FROM clubs c
       LEFT JOIN users u ON u.id = c.host_id
      WHERE c.slug = ? AND ${v.sql}`,
    String(slug), ...v.params
  ) || null;
}

export const membership = (clubId, userId) =>
  (userId
    ? get('SELECT * FROM club_members WHERE club_id = ? AND user_id = ?', clubId, Number(userId))
    : null) || null;

/**
 * §2.2 of the security spec — "Role checks for club actions resolve
 * SERVER-SIDE from club_members on every request. Never trust a role claim
 * in the session, a JWT, or a client payload."
 */
export function requireRole(clubId, userId, roles) {
  const m = membership(clubId, userId);
  if (!m || m.state !== 'active' || !roles.includes(m.role)) {
    const e = new Error('Not permitted');
    e.status = 403;
    throw e;
  }
  return m;
}

/** §8 of the security spec — a member list is visible only to members. */
export function members(clubId, viewer, { limit = 200 } = {}) {
  const mine = membership(clubId, viewer?.id);
  if (!mine || mine.state !== 'active') return null;   // a count, not a roster

  // accountGates: false, for the same reason as postsIn — and with worse
  // consequences here. Filtering a club's own roster by each member's
  // PROFILE visibility hides everybody with a private account from the
  // people they are in a club with, and since the remove and promote
  // controls hang off the roster rows, it also silently removes the host's
  // ability to moderate them. A member nobody can see is a member nobody
  // can remove.
  //
  // Membership is already the boundary: this function returns null outright
  // unless the viewer is an active member. Blocks still apply.
  const v = V.visibleSQL(viewer, { owner: 'u', accountGates: false });
  return all(
    `SELECT cm.role, cm.joined_at, u.id, u.username, u.display_name, u.avatar_key
       FROM club_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.club_id = ? AND cm.state = 'active'
        AND u.deleted_at IS NULL AND u.is_tombstone = 0
        AND ${v.sql}
      ORDER BY CASE cm.role WHEN 'host' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at
      LIMIT ?`,
    clubId, ...v.params, limit
  );
}

export const memberCount = (clubId) =>
  get(`SELECT COUNT(*) n FROM club_members WHERE club_id = ? AND state = 'active'`, clubId).n;

/**
 * What a club row needs to be worth reading.
 *
 * The index used to carry a name and a member count, which is a directory
 * rather than a page: two clubs are told apart by what is on display in
 * them, not by how many people are in each. The active pick, the date it
 * started and whether it is private all come from rows already joined.
 */
const ROW_FIELDS = `
  c.id, c.slug, c.name, c.description, c.avatar_key, c.visibility, c.created_at,
  (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id AND m.state = 'active') AS members,
  (SELECT w.title FROM club_picks p JOIN works w ON w.id = p.work_id
    WHERE p.club_id = c.id AND p.finished_at IS NULL
    ORDER BY p.starts_on DESC LIMIT 1) AS on_display,
  (SELECT pe.name FROM club_picks p
     JOIN work_people wp ON wp.work_id = p.work_id AND wp.role = 'AUTHOR'
     JOIN people pe ON pe.id = wp.person_id
    WHERE p.club_id = c.id AND p.finished_at IS NULL
    ORDER BY p.starts_on DESC LIMIT 1) AS on_display_by`;

export const discover = (viewer, { limit = 40 } = {}) => {
  // §9.1 — only `public` is listed. An `unlisted` club is reachable by
  // anyone holding its link but appears in no directory, which is the whole
  // point of the state.
  const v = V.visibleSQL(viewer, {
    owner: 'c', ownerIdCol: 'c.host_id', accountGates: false, club: 'c'
  });
  return all(
    `SELECT ${ROW_FIELDS}
       FROM clubs c
      WHERE c.visibility = 'public' AND c.archived_at IS NULL AND ${v.sql}
        -- A club you are already in belongs under YOURS, not under a
        -- heading offering you the chance to join it.
        AND NOT EXISTS (SELECT 1 FROM club_members m
                         WHERE m.club_id = c.id AND m.user_id = ? AND m.state = 'active')
      ORDER BY c.created_at DESC LIMIT ?`,
    ...v.params, Number(viewer?.id) || 0, limit
  );
};

export const mine = (userId) =>
  all(
    `SELECT ${ROW_FIELDS}, cm.role
       FROM club_members cm JOIN clubs c ON c.id = cm.club_id
      WHERE cm.user_id = ? AND cm.state = 'active' AND c.archived_at IS NULL
      ORDER BY cm.joined_at DESC`,
    Number(userId)
  );

// ── Membership ───────────────────────────────────────────
export function join(user, club) {
  if (!T.can(T.levelOf(user), 'canJoinClub')) {
    return { ok: false, error: 'Verify your email and log a few books first.' };
  }
  if (club.archived_at) return { ok: false, error: 'That club has closed.' };

  // §15 — "Blocked user attempts to join a club hosted by the blocker:
  // request auto-declines, silently." A block does not, however, grant
  // control over a club where the blocker is only a member.
  if (club.host_id && V.blockedBetween(user.id, club.host_id)) {
    return { ok: true, state: 'requested' };      // silently goes nowhere
  }

  if (memberCount(club.id) >= Math.min(club.member_cap || DEFAULT_CAP, HARD_CAP)) {
    return { ok: false, error: 'That club is full.' };
  }

  const state = club.join_policy === 'open' ? 'active' : 'requested';
  run(
    `INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'member', ?)
     ON CONFLICT (club_id, user_id) DO UPDATE SET state = excluded.state`,
    club.id, Number(user.id), state
  );

  if (state === 'requested') {
    notify(club.host_id, {
      kind: 'club_request', actorId: user.id,
      subject: `asked to join ${club.name}`, url: `/clubs/${club.slug}/members`
    });
  }
  return { ok: true, state };
}

/** §9.2 — a request becomes a membership only when an admin says so. */
export function approveRequest(actor, club, targetId) {
  requireRole(club.id, actor.id, ['host', 'admin']);

  const m = membership(club.id, targetId);
  if (!m || m.state !== 'requested') return { ok: false, error: 'No such request.' };
  if (memberCount(club.id) >= Math.min(club.member_cap || DEFAULT_CAP, HARD_CAP)) {
    return { ok: false, error: 'That club is full.' };
  }

  run(`UPDATE club_members SET state = 'active', joined_at = ?
        WHERE club_id = ? AND user_id = ?`, nowSQL(), club.id, Number(targetId));

  notify(targetId, {
    kind: 'club_approved', subject: `You are in ${club.name}`, url: `/clubs/${club.slug}`
  });
  return { ok: true };
}

export function declineRequest(actor, club, targetId) {
  requireRole(club.id, actor.id, ['host', 'admin']);
  // §3's rule for follows applies here too: declining is silent.
  run(`DELETE FROM club_members WHERE club_id = ? AND user_id = ? AND state = 'requested'`,
      club.id, Number(targetId));
  return { ok: true };
}

export function leave(userId, club) {
  const m = membership(club.id, userId);
  if (!m) return { ok: true };

  // §9.2 — "A host leaving must transfer or the club archives. Never leave
  // a club ownerless."
  if (m.role === 'host') {
    const heir = get(
      `SELECT user_id FROM club_members
        WHERE club_id = ? AND role = 'admin' AND state = 'active'
        ORDER BY joined_at LIMIT 1`,
      club.id
    );

    if (heir) {
      run(`UPDATE club_members SET role = 'host' WHERE club_id = ? AND user_id = ?`,
          club.id, heir.user_id);
      run('UPDATE clubs SET host_id = ? WHERE id = ?', heir.user_id, club.id);
      notify(heir.user_id, {
        kind: 'club_hosting', subject: `You are now hosting ${club.name}`,
        url: `/clubs/${club.slug}`
      });
    } else {
      run(`UPDATE clubs SET archived_at = ?, host_id = NULL WHERE id = ?`, nowSQL(), club.id);
      audit.record({ actorType: 'user', actorId: userId, action: 'club.archived',
                     metadata: { club: club.id, reason: 'host left, no admin to inherit' } });
    }
  }

  run(`UPDATE club_members SET state = 'removed' WHERE club_id = ? AND user_id = ?`,
      club.id, Number(userId));
  return { ok: true };
}

/**
 * §11 of the security spec — a removed member is TOLD, naming the club and
 * the action, and the removal is audited. Rate limited so a compromised
 * admin account is bounded.
 */
const removals = new Map();

export function removeMember(actor, club, targetId, { reason = null } = {}) {
  requireRole(club.id, actor.id, ['host', 'admin']);

  const target = membership(club.id, targetId);
  if (!target || target.role === 'host') {
    return { ok: false, error: 'That member cannot be removed.' };
  }

  // §11 — no more than 50 member removals per hour.
  const key = `${club.id}:${actor.id}`;
  const now = Date.now();
  const recent = (removals.get(key) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= 50) return { ok: false, error: 'Too many removals in one hour.' };
  recent.push(now);
  removals.set(key, recent);

  run(`UPDATE club_members SET state = 'removed' WHERE club_id = ? AND user_id = ?`,
      club.id, Number(targetId));

  notify(targetId, {
    kind: 'club_removed',
    subject: `You were removed from ${club.name}`,
    url: `/clubs/${club.slug}`
  });

  audit.record({
    actorType: 'user', actorId: actor.public_id || actor.id, action: 'club.member_removed',
    targetUserId: Number(targetId), reason: reason || 'no reason given',
    metadata: { club: club.id }
  });

  return { ok: true };
}

export function setRole(actor, club, targetId, role) {
  requireRole(club.id, actor.id, ['host']);
  if (!['admin', 'member'].includes(role)) return { ok: false, error: 'Unknown role.' };

  // §9.2 — admin cap: 10, or 5% of members, whichever is greater. It stops
  // a takeover by mass promotion.
  if (role === 'admin') {
    const admins = get(
      `SELECT COUNT(*) n FROM club_members WHERE club_id = ? AND role = 'admin' AND state = 'active'`,
      club.id
    ).n;
    const cap = Math.max(10, Math.floor(memberCount(club.id) * 0.05));
    if (admins >= cap) return { ok: false, error: `That club can have ${cap} admins.` };

    // §11 — admin promotion requires Trust 2.
    const target = get('SELECT trust_level FROM users WHERE id = ?', Number(targetId));
    if (T.levelOf(target) < 2) {
      return { ok: false, error: 'That account is too new to be an admin.' };
    }
  }

  run(`UPDATE club_members SET role = ? WHERE club_id = ? AND user_id = ? AND state = 'active'`,
      role, club.id, Number(targetId));

  audit.record({
    actorType: 'user', actorId: actor.public_id || actor.id, action: 'club.role_changed',
    targetUserId: Number(targetId), metadata: { club: club.id, role }
  });
  return { ok: true };
}

/** §9.2 — transfer requires the recipient to accept. A host cannot dump a club. */
export function offerHosting(actor, club, targetId) {
  requireRole(club.id, actor.id, ['host']);
  notify(targetId, {
    kind: 'club_hosting_offer', actorId: actor.id,
    subject: `offered you hosting of ${club.name}`,
    url: `/clubs/${club.slug}/accept-hosting`
  });
  return { ok: true };
}

export function acceptHosting(userId, club) {
  const m = membership(club.id, userId);
  if (!m || m.state !== 'active') throw new V.NotFound();

  run(`UPDATE club_members SET role = 'admin' WHERE club_id = ? AND role = 'host'`, club.id);
  run(`UPDATE club_members SET role = 'host' WHERE club_id = ? AND user_id = ?`, club.id, Number(userId));
  run('UPDATE clubs SET host_id = ? WHERE id = ?', Number(userId), club.id);

  audit.record({ actorType: 'user', actorId: userId, action: 'club.hosting_accepted',
                 metadata: { club: club.id } });
  return { ok: true };
}

/**
 * The emblem.
 *
 * Stored through the same pipeline as a user avatar — which means it is
 * re-encoded, stripped of metadata, and served from this origin. An
 * uploaded image is the one thing on a club page that did not come from a
 * text field, so it goes through the path that has already been hardened
 * rather than a second one written for clubs.
 */
export function setEmblem(user, club, key) {
  requireRole(club.id, user.id, ['host', 'admin']);
  const previous = club.avatar_key;
  run('UPDATE clubs SET avatar_key = ? WHERE id = ?', key, club.id);
  return { ok: true, previous };
}

export function updateSettings(user, club, { name, description, visibility, joinPolicy }) {
  requireRole(club.id, user.id, ['host', 'admin']);

  const cleanName = cleanText(name, { max: 60 });
  if (cleanName.length < 3) return { ok: false, error: 'Give it a name.' };

  run(
    `UPDATE clubs SET name = ?, description = ?, visibility = ?, join_policy = ?
      WHERE id = ?`,
    cleanName, cleanText(description, { max: 600 }) || null,
    VISIBILITIES.includes(visibility) ? visibility : club.visibility,
    JOIN_POLICIES.includes(joinPolicy) ? joinPolicy : club.join_policy,
    club.id
  );
  return { ok: true };
}

// ── §9.3 — THE PICK ──────────────────────────────────────
export function setPick(actor, club, { workId, cadence = 'month', startsOn, endsOn, announcement }) {
  requireRole(club.id, actor.id, ['host', 'admin']);

  // §9.3 — one active pick at a time; the queue holds the next three.
  const queued = get(
    'SELECT COUNT(*) n FROM club_picks WHERE club_id = ? AND finished_at IS NULL AND position > 0',
    club.id
  ).n;

  const active = get(
    'SELECT id FROM club_picks WHERE club_id = ? AND position = 0 AND finished_at IS NULL',
    club.id
  );
  const position = active ? Math.min(3, queued + 1) : 0;

  const id = randomUUID();
  run(
    `INSERT INTO club_picks (id, club_id, work_id, cadence, starts_on, ends_on,
                             set_by, announcement_body, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, club.id, Number(workId), cadence, startsOn || null, endsOn || null,
    Number(actor.id), cleanText(announcement, { max: 2000 }) || null, position
  );

  // §9.3 — "Setting a pick posts an announcement automatically and notifies
  // members once."
  if (position === 0) {
    const work = get('SELECT title FROM works WHERE id = ?', Number(workId));
    const body = announcement || `The next book is ${work?.title || 'chosen'}.`;
    run(
      `INSERT INTO club_posts (id, club_id, user_id, body, body_html, kind)
       VALUES (?, ?, ?, ?, ?, 'announcement')`,
      randomUUID(), club.id, Number(actor.id), cleanText(body, { max: 2000 }),
      toHTML(body, { allowLinks: false })
    );

    for (const m of all(
      `SELECT user_id FROM club_members WHERE club_id = ? AND state = 'active' AND user_id != ?`,
      club.id, Number(actor.id)
    )) {
      notify(m.user_id, {
        kind: 'club_pick', actorId: actor.id,
        subject: `${club.name} is reading ${work?.title || 'something new'}`,
        url: `/clubs/${club.slug}`
      });
    }
  }

  audit.record({
    actorType: 'user', actorId: actor.public_id || actor.id, action: 'club.pick_set',
    metadata: { club: club.id, work: workId, position }
  });

  return { ok: true, id, position };
}

export const activePick = (clubId) =>
  get(
    `SELECT p.*, w.title, e.cover_url, e.cover_cache_key,
            (SELECT pe.name FROM work_people wp JOIN people pe ON pe.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM club_picks p
       JOIN works w ON w.id = p.work_id
       LEFT JOIN editions e ON e.id = (SELECT id FROM editions WHERE work_id = w.id ORDER BY id LIMIT 1)
      WHERE p.club_id = ? AND p.position = 0 AND p.finished_at IS NULL
      ORDER BY p.created_at DESC LIMIT 1`,
    clubId
  ) || null;

/** §9.3 — the next three, visible to members. The most requested thing in real book clubs. */
export const queue = (clubId) =>
  all(
    `SELECT p.*, w.title FROM club_picks p JOIN works w ON w.id = p.work_id
      WHERE p.club_id = ? AND p.position > 0 AND p.finished_at IS NULL
      ORDER BY p.position LIMIT 3`,
    clubId
  );

export function participate(userId, pickId, state) {
  if (!['in', 'sitting_out'].includes(state)) return { ok: false };
  run(
    `INSERT INTO pick_participation (pick_id, user_id, state) VALUES (?, ?, ?)
     ON CONFLICT (pick_id, user_id) DO UPDATE SET state = excluded.state`,
    pickId, Number(userId), state
  );
  return { ok: true };
}

/**
 * §9.3 — progress shows as an ANONYMOUS distribution. Never a per-member
 * public position: "that's surveillance and it makes slow readers quit."
 *
 * And §9 of the security spec — a minimum bucket size of five. Below that,
 * show nothing rather than a distribution that identifies individuals.
 */
export function pickProgress(pick) {
  if (!pick) return null;

  const rows = all(
    `SELECT r.current_page FROM pick_participation pp
       JOIN readings r ON r.user_id = pp.user_id AND r.work_id = ?
      WHERE pp.pick_id = ? AND pp.state = 'in' AND r.current_page > 0`,
    pick.work_id, pick.id
  ).map((r) => r.current_page);

  if (rows.length < 5) return { tooFew: true, n: rows.length };

  const sorted = [...rows].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return { tooFew: false, n: rows.length, median: Math.round(mid) };
}

// ── §9.4 — CHECKPOINTS ───────────────────────────────────
//
// "The feature that makes clubs actually work."
//
// A checkpoint's position becomes the spoiler boundary of its thread, so
// everything posted there is gated for anyone behind it and nobody has to
// remember to tag anything. That is the payoff of §6.

export function addCheckpoint(actor, club, pickId, { label, throughPage, throughChapter, opensOn }) {
  requireRole(club.id, actor.id, ['host', 'admin']);

  const ordinal = get(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM club_checkpoints WHERE pick_id = ?', pickId
  ).n;

  const id = randomUUID();
  run(
    `INSERT INTO club_checkpoints (id, pick_id, ordinal, label, through_page, through_chapter, opens_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, pickId, ordinal, cleanText(label, { max: 80 }),
    throughPage ? Number(throughPage) : null,
    throughChapter ? cleanText(throughChapter, { max: 60 }) : null,
    opensOn || null
  );
  return { ok: true, id, ordinal };
}

export const checkpointsFor = (pickId) =>
  all('SELECT * FROM club_checkpoints WHERE pick_id = ? ORDER BY ordinal', pickId);

/** §9.4 — a thread opens on its date. Before then it exists but is not posted in. */
export const checkpointOpen = (cp, { now = new Date() } = {}) =>
  !cp.opens_on || String(cp.opens_on).slice(0, 10) <= new Date(now).toISOString().slice(0, 10);

// ── §9.5 — DISCUSSION ────────────────────────────────────
export function post(user, club, { body, checkpointId = null, parentId = null }) {
  requireRole(club.id, user.id, ['host', 'admin', 'member']);

  if (T.can(T.levelOf(user), 'readOnly')) {
    return { ok: false, error: 'This account is read-only.' };
  }

  const text = cleanText(body, { max: 10_000 });
  if (!text) return { ok: false, error: 'Say something.' };

  const limit = T.withinWriteLimit(user.id, 'post', T.levelOf(user));
  if (!limit.ok) return { ok: false, error: 'Slow down.' };

  if (checkpointId) {
    const cp = get(`SELECT cp.* FROM club_checkpoints cp
      JOIN club_picks p ON p.id = cp.pick_id WHERE cp.id = ? AND p.club_id = ?`, checkpointId, club.id);
    if (!cp || !checkpointOpen(cp)) return { ok: false, error: 'That thread has not opened yet.' };
  }
  if (parentId) {
    const parent = get(`SELECT * FROM club_posts WHERE id = ? AND club_id = ?
      AND checkpoint_id IS ? AND deleted_at IS NULL`, parentId, club.id, checkpointId);
    if (!parent || V.blockedBetween(user.id, parent.user_id)) return { ok: false, error: 'That post is unavailable.' };
  }

  const id = randomUUID();
  run(
    `INSERT INTO club_posts (id, club_id, checkpoint_id, user_id, body, body_html, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, club.id, checkpointId, Number(user.id), text,
    // §9.5 — no external links below Trust 2. This is where spam arrives.
    toHTML(text, { allowLinks: T.can(T.levelOf(user), 'canLink') }),
    parentId
  );
  return { ok: true, id };
}

/**
 * Posts in a thread.
 *
 * §15 — "Checkpoint threads: hidden posts leave no gap markers, no '1
 * hidden post' affordance. A visible gap is a taunt." The scope simply
 * omits them and nothing counts what is missing.
 */
export function postsIn(clubId, viewer, { checkpointId = null } = {}) {
  // ── accountGates: false ────────────────────────────────
  //
  // Inside a club, membership is the authorization boundary — not the
  // author's profile visibility. Scoping these rows by the author's
  // profile, as every other read path correctly does, means a host with a
  // private profile cannot be seen by their own members: they set the pick,
  // the announcement is written, and every member gets a club page with an
  // empty announcement block. Most accounts are private by default, so this
  // was the normal case rather than the edge one.
  //
  // Which room a post is in is already decided before this runs: the route
  // refuses the wall to non-members, and the club layer keeps a private
  // club's contents members-only. Blocks and the trust gate still apply,
  // because those are about people and not about rooms.
  const v = V.visibleSQL(viewer, { owner: 'u', accountGates: false });
  return all(
    `SELECT p.*, u.username, u.display_name, u.avatar_key
       FROM club_posts p JOIN users u ON u.id = p.user_id
      WHERE p.club_id = ? AND p.deleted_at IS NULL
        AND ${checkpointId ? 'p.checkpoint_id = ?' : 'p.checkpoint_id IS NULL'}
        -- Dropping the account gates above drops these with them, and a
        -- deleted account's words should not outlive the account.
        AND u.deleted_at IS NULL AND u.is_tombstone = 0
        AND ${v.sql}
      ORDER BY p.created_at`,
    clubId, ...(checkpointId ? [checkpointId] : []), ...v.params
  );
}

/**
 * An announcement.
 *
 * The head and the admins can put one at the top of the club; nobody else
 * can. It is the same row as a wall post with a different `kind`, so it
 * inherits the same sanitising, the same visibility scope and the same
 * report affordance — an announcement is not a privileged kind of HTML,
 * only a privileged place to stand.
 */
export function announce(user, club, { body }) {
  requireRole(club.id, user.id, ['host', 'admin']);

  const text = cleanText(body, { max: 4000 });
  if (!text) return { ok: false, error: 'Say something.' };

  const id = randomUUID();
  run(
    `INSERT INTO club_posts (id, club_id, user_id, body, body_html, kind)
     VALUES (?, ?, ?, ?, ?, 'announcement')`,
    id, club.id, Number(user.id), text, toHTML(text, { allowLinks: true })
  );

  for (const m of all(
    `SELECT user_id FROM club_members WHERE club_id = ? AND state = 'active' AND user_id != ?`,
    club.id, Number(user.id)
  )) {
    notify(m.user_id, {
      kind: 'club_pick', actorId: user.id,
      subject: `${club.name} posted an announcement`,
      url: `/clubs/${club.slug}`
    });
  }

  audit.record({
    actorType: 'user', actorId: user.public_id || user.id, action: 'club.announced',
    metadata: { club: club.id, post: id }
  });
  return { ok: true, id };
}

/** An announcement can be taken down by the people who could post one. */
export function unannounce(user, club, postId) {
  requireRole(club.id, user.id, ['host', 'admin']);
  run(`UPDATE club_posts SET deleted_at = ? WHERE id = ? AND club_id = ? AND kind = 'announcement'`,
      nowSQL(), postId, club.id);
  return { ok: true };
}

export const REACTIONS = ['agreed', 'unsure', 'exactly', 'oof'];

export function react(userId, postId, reaction, { clubId = null } = {}) {
  if (!REACTIONS.includes(reaction)) return { ok: false };
  const post = get(`SELECT p.* FROM club_posts p
    JOIN club_members m ON m.club_id = p.club_id AND m.user_id = ? AND m.state = 'active'
    WHERE p.id = ? AND p.deleted_at IS NULL`, Number(userId), postId);
  if (!post || (clubId && post.club_id !== clubId) || V.blockedBetween(userId, post.user_id)) return { ok: false };
  if (post.checkpoint_id) {
    const cp = get('SELECT * FROM club_checkpoints WHERE id = ?', post.checkpoint_id);
    if (!cp || !checkpointOpen(cp)) return { ok: false };
  }
  const existing = get(
    'SELECT 1 AS x FROM post_reactions WHERE post_id = ? AND user_id = ? AND reaction = ?',
    postId, Number(userId), reaction
  );
  if (existing) {
    run('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND reaction = ?',
        postId, Number(userId), reaction);
  } else {
    run('INSERT OR IGNORE INTO post_reactions (post_id, user_id, reaction) VALUES (?, ?, ?)',
        postId, Number(userId), reaction);
  }
  return { ok: true };
}

/** Counts visible; reactors not listed (§9.5). */
export const reactionsFor = (postId) =>
  all(
    'SELECT reaction, COUNT(*) n FROM post_reactions WHERE post_id = ? GROUP BY reaction',
    postId
  );

// ── §9.6 — THE ARCHIVE ───────────────────────────────────
/**
 * "A club's archive is a lookbook."
 *
 * It reuses the seasons renderer wholesale — the colour signature sampled
 * from the picks, the run of show in order, the club's own colophon. A club
 * that has run two years has an object it can look at, and that is the best
 * reason for it to stay here rather than drifting back to a group chat.
 */
export function archive(clubId) {
  const picks = all(
    `SELECT p.*, w.title, e.cover_url, e.cover_cache_key,
            (SELECT pe.name FROM work_people wp JOIN people pe ON pe.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM club_picks p
       JOIN works w ON w.id = p.work_id
       LEFT JOIN editions e ON e.id = (SELECT id FROM editions WHERE work_id = w.id ORDER BY id LIMIT 1)
      WHERE p.club_id = ? AND p.finished_at IS NOT NULL
      ORDER BY p.finished_at`,
    clubId
  );

  return {
    picks,
    // No strip. It was one band per pick in the club's jacket colours, and
    // jacket colour is not what a book's colour means any more. It is not
    // rebuilt from derived colours either: a club's picks are other
    // people's readings, and the colour a book was derived to carry is a
    // fact about the book that belongs where it can be read with its
    // citation. Colour stays on the book page, the colourway and the poster.
    strip: [],
    colophon: [
      { label: 'PICKS', value: picks.length },
      { label: 'RAN FROM', value: picks[0] ? String(picks[0].starts_on || '').slice(0, 10) : null },
      { label: 'MEMBERS', value: memberCount(clubId) }
    ].filter((p) => p.value != null && p.value !== '')
  };
}

export function finishPick(actor, club, pickId) {
  requireRole(club.id, actor.id, ['host', 'admin']);
  run('UPDATE club_picks SET finished_at = ? WHERE id = ? AND club_id = ?', nowSQL(), pickId, club.id);

  // Promote the next queued pick into the active slot.
  const next = get(
    `SELECT id FROM club_picks WHERE club_id = ? AND position > 0 AND finished_at IS NULL
      ORDER BY position LIMIT 1`,
    club.id
  );
  if (next) {
    run('UPDATE club_picks SET position = 0 WHERE id = ?', next.id);
    run('UPDATE club_picks SET position = position - 1 WHERE club_id = ? AND position > 0', club.id);
  }
  return { ok: true };
}

/**
 * Wall posts, nested one level.
 *
 * `post()` has accepted a `parentId` since it was written and nothing ever
 * passed one: the wall was flat, so "SAY SOMETHING" started a new post and
 * could not answer one, and a book club where nobody can respond to anybody
 * is a bulletin board.
 *
 * One level, like review replies and for the same reason. A reply to a reply
 * is an argument, and the product has no moderation surface for one.
 */
export function threadedWall(clubId, viewer) {
  const flat = postsIn(clubId, viewer).filter((p) => p.kind !== 'announcement');

  const roots = [];
  const byId = new Map();
  for (const p of flat) {
    p.replies = [];
    byId.set(p.id, p);
  }
  for (const p of flat) {
    // A reply whose parent is not visible to this viewer — blocked, deleted
    // — is promoted to a root rather than dropped. Losing the answer because
    // the question is gone loses more than it protects.
    const parent = p.parent_id ? byId.get(p.parent_id) : null;
    if (parent) parent.replies.push(p);
    else roots.push(p);
  }
  return roots;
}

/**
 * What the members made of a past pick.
 *
 * The club's own grades, not the site's. A club that read Stoner and hated
 * it is a fact about that club, and it is the most characterful thing an
 * archive can carry.
 */
export function clubGrades(clubId, workId) {
  const row = get(
    `SELECT COUNT(*) n, AVG(r.stars) avg
       FROM readings r
      WHERE r.work_id = ? AND r.stars IS NOT NULL AND r.is_draft = 0
        AND r.user_id IN (SELECT user_id FROM club_members
                           WHERE club_id = ? AND state = 'active')`,
    Number(workId), String(clubId)
  );
  // Same floor as everywhere else: under three, a grade is a person.
  if (!row || row.n < 3) return null;
  return { n: row.n, avg: Math.round(row.avg * 10) / 10 };
}

/** Each member with what they are reading now — so a roster is people. */
export function membersWithReading(clubId, viewer) {
  const rows = members(clubId, viewer);
  if (!rows) return null;
  for (const m of rows) {
    m.reading = get(
      `SELECT w.title FROM readings r JOIN works w ON w.id = r.work_id
        WHERE r.user_id = ? AND r.status = 'READING' AND r.is_draft = 0
        ORDER BY r.started_at DESC LIMIT 1`,
      m.id
    )?.title || null;
  }
  return rows;
}

// ── INVITATIONS ──────────────────────────────────────────
//
// Club settings have offered "By invitation" as a join policy since they
// were written, and there was no invitation anywhere in the product. A club
// set to invite_only was a club nobody could ever join, including by being
// asked.
//
// The table was there too — club_invites, with a token hash, a use count, an
// expiry and a revocation column, all unused. This is the mechanism it was
// designed for.

const INVITE_TTL_DAYS = 14;

/**
 * Mint an invitation.
 *
 * The token is returned ONCE and only its hash is stored, the same contract
 * the auth tokens use: a leaked database gives an attacker no working
 * invitations. A link that cannot be recovered from the server is a link the
 * host has to actually send, which is the correct property for an invitation.
 */
export function invite(actor, club, { maxUses = 1 } = {}) {
  requireRole(club.id, actor.id, ['host', 'admin']);

  // The project's own generator, so an invitation is as strong as a
  // password reset link rather than a UUID with the dashes taken out.
  const token = newToken();
  const id = randomUUID();
  run(
    `INSERT INTO club_invites (id, club_id, token_hash, created_by, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    id, club.id, hashToken(token), Number(actor.id),
    Math.max(1, Math.min(50, Number(maxUses) || 1)),
    `+${INVITE_TTL_DAYS} day`
  );

  audit.record({
    actorType: 'user', actorId: actor.public_id || actor.id, action: 'club.invite.created',
    targetUserId: Number(actor.id), metadata: { club: club.id, maxUses }
  });

  return { ok: true, token, expiresInDays: INVITE_TTL_DAYS };
}

/** The club an invitation opens, or null. Never says WHY it failed. */
export function inviteClub(token) {
  // newToken() is base64url, not hex. A regex written for the wrong alphabet
  // rejects every genuine invitation and does it silently, which is a bug
  // that looks exactly like an expired link.
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(String(token))) return null;
  const row = get(
    `SELECT i.*, c.slug, c.name, c.description, c.avatar_key, c.visibility
       FROM club_invites i JOIN clubs c ON c.id = i.club_id
      WHERE i.token_hash = ?
        AND i.revoked_at IS NULL
        AND i.expires_at > datetime('now')
        AND (i.max_uses IS NULL OR i.uses < i.max_uses)
        AND c.archived_at IS NULL`,
    hashToken(String(token))
  );
  return row || null;
}

/**
 * Accept one.
 *
 * An invitation admits its holder DIRECTLY, whatever the join policy says —
 * that is the whole point of being invited, and it is why the token is
 * single-use by default.
 */
export function acceptInvite(user, token) {
  const inv = inviteClub(token);
  if (!inv) return { ok: false, error: 'That invitation has expired.' };

  const existing = membership(inv.club_id, user.id);
  if (existing?.state === 'active') return { ok: true, slug: inv.slug, already: true };

  run(
    `INSERT INTO club_members (club_id, user_id, role, state)
     VALUES (?, ?, 'member', 'active')
     ON CONFLICT (club_id, user_id) DO UPDATE SET state = 'active', role = 'member'`,
    inv.club_id, Number(user.id)
  );
  run('UPDATE club_invites SET uses = uses + 1 WHERE id = ?', inv.id);

  audit.record({
    actorType: 'user', actorId: user.public_id || user.id, action: 'club.invite.accepted',
    targetUserId: Number(user.id), metadata: { club: inv.club_id }
  });

  return { ok: true, slug: inv.slug };
}

/** Live invitations on a club, for the host to see and revoke. */
export const invitesFor = (clubId) =>
  all(
    `SELECT id, uses, max_uses, expires_at, created_at FROM club_invites
      WHERE club_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
      ORDER BY created_at DESC`,
    String(clubId)
  );

export function revokeInvite(actor, club, inviteId) {
  requireRole(club.id, actor.id, ['host', 'admin']);
  run(`UPDATE club_invites SET revoked_at = ? WHERE id = ? AND club_id = ?`,
      nowSQL(), String(inviteId), club.id);
  return { ok: true };
}
