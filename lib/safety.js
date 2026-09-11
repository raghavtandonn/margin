import { randomUUID } from 'node:crypto';
import { get, all, run, sqlTime, nowSQL, parseSQLTime } from '../db/index.js';
import * as audit from './audit.js';
import { levelOf } from './trust.js';

// ── §11 / §14 — BLOCKING, MUTING, REPORTING ──────────────
//
// community-spec §18 puts this before the features it protects, and the
// reason is in §11: "Goodreads' central failure is not that it lacks a
// report button — it is that reports go nowhere."
//
// So the queue, the outcomes, and the audit trail are built first, and the
// features that generate reports arrive afterwards into a system that
// already answers.

const DAY = 86_400_000;

// ── BLOCK (§11, §15) ─────────────────────────────────────
/**
 * Mutual invisibility.
 *
 * The enforcement itself lives in lib/visibility.js so that every read path
 * gets it for free. What happens HERE is the consequences that cannot be
 * expressed as a filter: severing follows, and the club rules in §15.
 */
export function block(blockerId, blockedId, { req = null } = {}) {
  if (Number(blockerId) === Number(blockedId)) return { ok: false, error: 'You cannot block yourself.' };

  run(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)`,
      Number(blockerId), Number(blockedId));

  // §15 — "Follows: severed both directions on block."
  run(
    `DELETE FROM user_follows
      WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)`,
    Number(blockerId), Number(blockedId), Number(blockedId), Number(blockerId)
  );

  // §15 — "Blocker is host or admin: the blocked member is REMOVED from the
  // club on block. A moderator cannot be forced to moderate someone they
  // have blocked."
  const theirClubs = all(
    `SELECT club_id FROM club_members
      WHERE user_id = ? AND role IN ('host', 'admin') AND state = 'active'`,
    Number(blockerId)
  );
  for (const c of theirClubs) {
    run(
      `UPDATE club_members SET state = 'removed'
        WHERE club_id = ? AND user_id = ? AND role = 'member'`,
      c.club_id, Number(blockedId)
    );
  }

  // §15 — "Notifications: suppressed both directions." Anything already
  // queued is suppressed at delivery rather than left to arrive.
  run(
    `UPDATE notifications SET suppressed = 1
      WHERE read_at IS NULL
        AND ((user_id = ? AND actor_id = ?) OR (user_id = ? AND actor_id = ?))`,
    Number(blockerId), Number(blockedId), Number(blockedId), Number(blockerId)
  );

  // §11 — blocks are never disclosed to the blocked user, so this is
  // audited but generates no notification of any kind.
  audit.record({
    actorType: 'user', actorId: blockerId, action: 'user.blocked',
    targetUserId: Number(blockedId), ip: req?.ip
  });

  return { ok: true, clubsAffected: theirClubs.length };
}

export function unblock(blockerId, blockedId) {
  run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?',
      Number(blockerId), Number(blockedId));
  return { ok: true };
}

export const blocksBy = (userId) =>
  all(
    `SELECT b.blocked_id AS user_id, b.created_at, u.username, u.display_name, u.avatar_key
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
    Number(userId)
  );

// ── MUTE (§11) ───────────────────────────────────────────
// "Lower-stakes and the one people actually use." Nothing is severed and
// the muted account is never told.
export function mute(muterId, mutedId) {
  if (Number(muterId) === Number(mutedId)) return { ok: false };
  run('INSERT OR IGNORE INTO mutes (muter_id, muted_id) VALUES (?, ?)',
      Number(muterId), Number(mutedId));
  return { ok: true };
}

export const unmute = (muterId, mutedId) => {
  run('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?', Number(muterId), Number(mutedId));
  return { ok: true };
};

export const mutesBy = (userId) =>
  all(
    `SELECT m.muted_id AS user_id, m.created_at, u.username, u.display_name, u.avatar_key
       FROM mutes m JOIN users u ON u.id = m.muted_id
      WHERE m.muter_id = ? ORDER BY m.created_at DESC`,
    Number(userId)
  );

// ── REPORT (§11, §14) ────────────────────────────────────

export const CATEGORIES = [
  'spam', 'harassment', 'hate', 'spoilers', 'impersonation',
  'self_promotion', 'off_topic', 'other'
];

export const TARGETS = ['user', 'review', 'club', 'post', 'comment'];

// §14 — "Rate limit reports: 20 per day per account, 3 per target per
// account." Mass-reporting is a standard harassment technique and the queue
// is itself attackable.
const PER_DAY = 20;
const PER_TARGET = 3;

/**
 * §14 — reports are WEIGHTED by the reporter's trust and history. An
 * account whose reports have never been upheld carries less; one with a
 * good record carries more.
 *
 * Weight affects triage order only. It never triggers an action: §14 is
 * explicit that "every action against a user is taken by a human", and that
 * is the single rule that prevents brigading from working.
 */
export function reporterWeight(user) {
  const level = levelOf(user);
  const filed = get(
    'SELECT COUNT(*) n FROM reports WHERE reporter_id = ?', Number(user.id)
  ).n;
  const upheld = get(
    `SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND state = 'actioned'`,
    Number(user.id)
  ).n;

  let w = 1 + (level >= 3 ? 0.5 : level >= 2 ? 0.25 : 0);

  // A record, once there is enough of one to mean anything.
  if (filed >= 5) {
    const accuracy = upheld / filed;
    w *= 0.5 + accuracy;          // 0.5× for never upheld, 1.5× for always
  }
  return Number(Math.max(0.1, Math.min(3, w)).toFixed(2));
}

export function report(reporter, { targetType, targetRef, targetUserId, category, detail }) {
  if (!TARGETS.includes(targetType)) return { ok: false, error: 'Unknown target.' };
  if (!CATEGORIES.includes(category)) return { ok: false, error: 'Pick a category.' };

  const today = get(
    `SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND created_at > ?`,
    Number(reporter.id), sqlTime(Date.now() - DAY)
  ).n;
  if (today >= PER_DAY) return { ok: false, error: 'That is enough reports for one day.' };

  const onTarget = get(
    `SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND target_type = ? AND target_ref = ?`,
    Number(reporter.id), targetType, String(targetRef)
  ).n;
  if (onTarget >= PER_TARGET) {
    return { ok: false, error: 'You have already reported this. It is in the queue.' };
  }

  const id = randomUUID();
  run(
    `INSERT INTO reports (id, reporter_id, target_user_id, target_type, target_ref,
                          kind, detail, weight, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    id, Number(reporter.id), targetUserId ? Number(targetUserId) : null,
    targetType, String(targetRef), category,
    String(detail || '').slice(0, 2000) || null,
    reporterWeight(reporter)
  );

  audit.record({
    actorType: 'user', actorId: reporter.public_id || reporter.id, action: 'report.filed',
    targetUserId: targetUserId ? Number(targetUserId) : null,
    metadata: { target_type: targetType, category }
  });

  return { ok: true, id };
}

/**
 * §11 — "Reporters see an outcome: reviewed and actioned, reviewed and no
 * action, or still open. Silence is what convinces people reporting is
 * pointless."
 */
export const reportsBy = (userId) =>
  all(
    `SELECT id, target_type, kind, state, resolution, created_at, resolved_at
       FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 50`,
    Number(userId)
  );

// ── §14 — coordinated reporting ──────────────────────────
/**
 * "Detect coordinated reporting: many reports on one target inside a short
 * window from accounts with high follow-graph overlap or shared signup
 * characteristics. Flag the REPORTERS for review, and do not let volume
 * alone trigger any automated action."
 *
 * So this returns a finding for a human. It changes nothing by itself.
 */
export function coordinatedReporting({ windowHours = 6, threshold = 8 } = {}) {
  const since = sqlTime(Date.now() - windowHours * 3600_000);

  const clusters = all(
    `SELECT target_type, target_ref, COUNT(*) n, COUNT(DISTINCT reporter_id) reporters
       FROM reports
      WHERE created_at >= ? AND state = 'open'
      GROUP BY target_type, target_ref
     HAVING reporters >= ?`,
    since, threshold
  );

  const findings = [];
  for (const c of clusters) {
    const reporters = all(
      `SELECT DISTINCT reporter_id FROM reports
        WHERE target_type = ? AND target_ref = ? AND created_at >= ?`,
      c.target_type, c.target_ref, since
    ).map((r) => r.reporter_id);

    // Follow-graph overlap: how interconnected the reporters are. A group
    // that all follow each other is a brigade; a group of strangers who all
    // saw the same thing is a signal.
    let edges = 0;
    for (const a of reporters) {
      for (const b of reporters) {
        if (a === b) continue;
        if (get(`SELECT 1 AS x FROM user_follows WHERE follower_id = ? AND followee_id = ?`, a, b)) edges++;
      }
    }
    const possible = reporters.length * (reporters.length - 1);
    const overlap = possible ? edges / possible : 0;

    // Signup clustering: accounts created within a day of each other.
    const created = all(
      `SELECT created_at FROM users WHERE id IN (${reporters.map(() => '?').join(',')})`,
      ...reporters
    ).map((r) => parseSQLTime(r.created_at)).sort();
    const span = created.length > 1 ? (created[created.length - 1] - created[0]) / DAY : Infinity;

    if (overlap > 0.3 || span < 2) {
      findings.push({
        target_type: c.target_type, target_ref: c.target_ref,
        reporters, reports: c.n, overlap: Number(overlap.toFixed(2)),
        signup_span_days: Number.isFinite(span) ? Number(span.toFixed(1)) : null,
        note: 'flag the reporters, not the target'
      });
    }
  }
  return findings;
}

// ── §14 — the queue ──────────────────────────────────────
/** Triaged by weight × severity, so the worst thing waits least. */
const SEVERITY = {
  hate: 3, harassment: 3, impersonation: 2.5, spam: 1.5,
  self_promotion: 1, spoilers: 0.8, off_topic: 0.6, other: 1
};

export const queue = ({ limit = 100 } = {}) =>
  all(
    `SELECT r.*, u.username AS target_username, ru.username AS reporter_username
       FROM reports r
       LEFT JOIN users u ON u.id = r.target_user_id
       LEFT JOIN users ru ON ru.id = r.reporter_id
      WHERE r.state = 'open'
      ORDER BY r.created_at`
  )
    .map((r) => ({ ...r, priority: (r.weight || 1) * (SEVERITY[r.kind] || 1) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

export const ACTIONS = [
  'no_action', 'hide_content', 'remove_content', 'warn',
  'limit_user', 'suspend', 'ban', 'freeze_aggregate', 'archive_club'
];

/**
 * §14 — "Every moderator action writes to the audit log with actor, target,
 * action, reason, and timestamp" and "the user is told what was actioned
 * and under which rule."
 *
 * Both are enforced here rather than left to the caller: a reason is
 * required and a notification is always written.
 */
export function resolve(reportId, { staff, action, reason, rule = null }) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`);
  if (!reason || String(reason).trim().length < 8) {
    throw new Error('a moderator action requires a written reason');
  }

  const r = get('SELECT * FROM reports WHERE id = ?', reportId);
  if (!r) return { ok: false };

  const state = action === 'no_action' ? 'dismissed' : 'actioned';

  run(
    `UPDATE reports SET state = ?, resolution = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ?`,
    state, `${action}: ${String(reason).trim()}`, staff.id, nowSQL(), reportId
  );

  audit.record({
    actorType: 'staff', actorId: staff.id, action: `moderation.${action}`,
    targetUserId: r.target_user_id, reason: String(reason).trim(),
    fields: [r.target_type], metadata: { report: reportId, rule }
  });

  // §14 — the reporter learns the outcome. Silence teaches people not to
  // report, which is how a queue becomes decorative.
  notify(r.reporter_id, {
    kind: 'report_resolved',
    subject: state === 'actioned' ? 'Reviewed and actioned.' : 'Reviewed, no action taken.',
    url: '/settings/reports'
  });

  // And the person acted against is told what and under which rule. Never
  // a silent removal — that is what makes communities paranoid.
  if (r.target_user_id && state === 'actioned') {
    notify(r.target_user_id, {
      kind: 'moderation_action',
      subject: rule ? `Action taken under: ${rule}` : 'Action taken on your content.',
      url: '/settings/appeals'
    });
  }

  return { ok: true, state };
}

// ── Notifications (§10) ──────────────────────────────────
/**
 * §13 of the security spec — notifications respect blocks at SEND time and
 * at READ time, and never carry note text, private shelf names, or private
 * club names.
 */
// ── §10 — NOTIFICATION PREFERENCES ───────────────────────
//
// "Keep them boring. Every product ruins itself here."
//
// The closed list below is also the whole vocabulary of the settings page:
// a kind that is not here cannot be sent, and a kind that is here cannot be
// sent without passing the gate in notify(). That is deliberate — the way
// this feature rots is a new call site that quietly skips the check.

export const NOTIFY_KINDS = [
  { kind: 'follow',          label: 'Someone follows you',                 default: true },
  { kind: 'follow_request',  label: 'Someone asks to follow you',          default: true },
  { kind: 'follow_approved', label: 'A follow request is approved',        default: true },
  { kind: 'review_reply',    label: 'Someone replies to your review',      default: true },
  { kind: 'club_pick',       label: "A club's pick changes",               default: true },
  { kind: 'club_checkpoint', label: 'A checkpoint thread opens',           default: true },
  { kind: 'club_request',    label: 'Someone asks to join your club',      default: true },
  { kind: 'club_approved',   label: 'You are let into a club',             default: true },
  { kind: 'club_hosting',    label: 'Hosting is offered or handed to you', default: true },
  { kind: 'moderation',      label: 'An admin action affects your content', default: true },
  // §10 — "Likes batch into a daily digest at most, and default to off."
  { kind: 'likes_digest',    label: 'A daily summary of likes',            default: false }
];

/**
 * Several kinds are the same thing to a reader and should not be two rows on
 * the settings page. They resolve to one preference key, so switching
 * "hosting" off switches off the offer as well as the handover — which is
 * what anybody reading that row would expect it to do.
 */
const GROUPS = {
  club_hosting_offer: 'club_hosting',
  club_removed: 'moderation',
  club_role_changed: 'moderation',
  moderation_action: 'moderation'
};
const groupOf = (kind) => GROUPS[kind] || kind;

/**
 * Kinds that exist outside the preference system entirely.
 *
 * A new sign-in, a password change, a session revoked: these are how
 * somebody finds out their account has been taken. §10 of the accounts spec
 * is explicit that they are not optional, so there is no key for them in
 * notification_prefs and the pause switch does not reach them either.
 */
export const ALWAYS_ON = new Set([
  'security', 'account', 'deletion', 'export_ready',
  // §11 — "Reporters see an outcome … Silence is what convinces people it
  // is pointless." That promise cannot be switchable, so it is not.
  'report_resolved'
]);

const DEFAULTS = new Map(NOTIFY_KINDS.map((k) => [k.kind, k.default]));

export function prefsFor(userId) {
  const rows = all('SELECT kind, enabled FROM notification_prefs WHERE user_id = ?', Number(userId));
  const set = new Map(rows.map((r) => [r.kind, !!r.enabled]));
  return NOTIFY_KINDS.map((k) => ({ ...k, on: set.has(k.kind) ? set.get(k.kind) : k.default }));
}

export function setPrefs(userId, enabledKinds) {
  const on = new Set(enabledKinds || []);
  for (const { kind } of NOTIFY_KINDS) {
    run(
      `INSERT INTO notification_prefs (user_id, kind, enabled) VALUES (?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET enabled = excluded.enabled`,
      Number(userId), kind, on.has(kind) ? 1 : 0
    );
  }
}

/** §10 — "One global `pause everything` switch." */
export function setPaused(userId, paused) {
  run('UPDATE users SET notifications_paused = ? WHERE id = ?', paused ? 1 : 0, Number(userId));
}

export const isPaused = (userId) =>
  !!get('SELECT notifications_paused FROM users WHERE id = ?', Number(userId))?.notifications_paused;

/** The one gate. Callers pass a kind; whether it is delivered is decided here. */
export function wants(userId, kind) {
  if (ALWAYS_ON.has(kind)) return true;
  if (isPaused(userId)) return false;

  const key = groupOf(kind);
  const row = get('SELECT enabled FROM notification_prefs WHERE user_id = ? AND kind = ?',
                  Number(userId), key);
  if (row) return !!row.enabled;
  // An unknown kind is not deliverable. A typo in a call site becomes silence
  // rather than an unstoppable notification with no switch on the settings page.
  return DEFAULTS.get(key) ?? false;
}

export function notify(userId, { kind, actorId = null, subject = null, url = null }) {
  if (!userId) return null;

  // §10 — the per-type toggles and the pause switch are honoured HERE, not at
  // each call site, so nothing can be added later that forgets to ask.
  if (!wants(userId, kind)) return null;

  // Suppressed at generation if a block already stands.
  if (actorId) {
    const blocked = get(
      `SELECT 1 AS x FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
      Number(userId), Number(actorId), Number(actorId), Number(userId)
    );
    if (blocked) return null;
  }

  const id = randomUUID();
  run(
    `INSERT INTO notifications (id, user_id, kind, actor_id, subject, url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, Number(userId), kind, actorId ? Number(actorId) : null,
    String(subject || '').slice(0, 200) || null, url
  );
  return id;
}

/** Read time: a block created after generation still suppresses delivery. */
export const notificationsFor = (userId, { limit = 50 } = {}) =>
  all(
    `SELECT n.*, u.username AS actor_username, u.display_name AS actor_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? AND n.suppressed = 0
        AND (n.actor_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id)
              OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id)
        ))
      ORDER BY n.created_at DESC LIMIT ?`,
    Number(userId), limit
  );

export const unreadCount = (userId) =>
  get(
    `SELECT COUNT(*) n FROM notifications
      WHERE user_id = ? AND read_at IS NULL AND suppressed = 0`,
    Number(userId)
  ).n;

export const markRead = (userId) =>
  run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`,
      nowSQL(), Number(userId));

/**
 * Notifications, folded into one row per thing that happened.
 *
 * Four people replying to the same review is one event with four names on
 * it, not four events. Ungrouped, an inbox becomes a feed, and a feed is
 * something you check — the behaviour that "keep them boring" and the NEVER
 * SENT list are both written to avoid.
 *
 * Grouping is by kind AND subject, so two different reviews of yours stay
 * two rows. Order is by the most recent member of each group.
 */
export function groupNotifications(items) {
  const groups = new Map();

  for (const n of items || []) {
    const key = `${n.kind} ${n.subject || ''} ${n.url || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kind: n.kind,
        subject: n.subject,
        url: n.url,
        at: n.created_at,
        unread: !n.read_at,
        actors: []
      });
    }
    const g = groups.get(key);
    // Newest wins for the timestamp; unread anywhere makes the group unread.
    if (String(n.created_at) > String(g.at)) g.at = n.created_at;
    if (!n.read_at) g.unread = true;
    if (n.actor_username && !g.actors.some((a) => a.username === n.actor_username)) {
      g.actors.push({ username: n.actor_username, name: n.actor_name });
    }
  }

  return [...groups.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** "Ida", "Ida and Jonas", "Ida and 3 others" — never a bare number alone. */
export function actorLine(actors) {
  const names = (actors || []).map((a) => a.name || '@' + a.username);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}
