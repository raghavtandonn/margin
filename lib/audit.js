import { all, get, run, sqlTime, nowSQL } from '../db/index.js';
import { hashIP } from './crypto.js';

// ── §14 — the audit log ──────────────────────────────────
//
// This module exists because of one sentence in the Letterboxd disclosure:
// they could not determine which accounts had their data accessed.
//
// The bar it has to clear is stated in §14 as a question — "if a staff
// account is compromised tomorrow, can we produce an exact list of affected
// members within an hour?" — and `affectedBy()` at the bottom of this file is
// the answer to it. It is a single query, and test/audit.test.js runs it.
//
// The table is append-only, enforced by triggers in schema-auth.sql rather
// than by everybody remembering not to write an UPDATE.

const json = (v) => (v == null ? null : JSON.stringify(v));

/**
 * Record an action. Never throws into the caller: an audit write failing must
 * not take down the request that was being audited, but it must be loud.
 */
export function record({
  actorType, actorId = null, action, targetUserId = null,
  fields = null, reason = null, ip = null, userAgent = null, metadata = null
}) {
  try {
    run(
      `INSERT INTO audit_log
         (actor_type, actor_id, action, target_user_id, fields, reason, ip_hash, user_agent, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      actorType, actorId == null ? null : String(actorId), action,
      targetUserId == null ? null : Number(targetUserId),
      json(fields), reason, hashIP(ip), String(userAgent || '').slice(0, 300), json(metadata)
    );
  } catch (err) {
    console.error('  AUDIT WRITE FAILED —', action, err.message);
  }
}

// Convenience wrappers, so a call site says what happened rather than
// assembling a row.
export const userAction = (req, action, extra = {}) =>
  record({
    actorType: 'user',
    actorId: req.user?.public_id || req.user?.id,
    action,
    targetUserId: req.user?.id ?? null,
    ip: req.ip,
    userAgent: req.get?.('user-agent'),
    ...extra
  });

export const systemAction = (action, extra = {}) =>
  record({ actorType: 'system', action, ...extra });

/**
 * §14 — "every staff read of member data writes an audit_log row naming
 * actor, target user, the exact fields returned, reason string, IP, and
 * timestamp."
 *
 * `fields` is not optional and neither is `reason`. A staff read that cannot
 * say what it looked at or why is not a read this system performs.
 */
export function staffRead({ staff, targetUserId, fields, reason, ip, userAgent, action = 'admin.user.read' }) {
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error('staffRead requires the exact list of fields returned');
  }
  if (!reason || String(reason).trim().length < 8) {
    throw new Error('staffRead requires a written reason');
  }
  record({
    actorType: 'staff', actorId: staff.id, action,
    targetUserId, fields, reason: String(reason).trim(), ip, userAgent
  });
}

// ── The question §14 asks ────────────────────────────────
/**
 * Given a compromised staff account and a window, exactly which members had
 * data read, and which fields.
 */
export function affectedBy(staffId, { since, until = nowSQL() } = {}) {
  const rows = all(
    `SELECT target_user_id, action, fields, reason, created_at
       FROM audit_log
      WHERE actor_type = 'staff' AND actor_id = ?
        AND target_user_id IS NOT NULL
        AND created_at >= ? AND created_at <= ?
      ORDER BY created_at`,
    String(staffId), sqlTime(since), sqlTime(until)
  );

  const byUser = new Map();
  for (const r of rows) {
    const entry = byUser.get(r.target_user_id) || { userId: r.target_user_id, fields: new Set(), actions: [] };
    for (const f of JSON.parse(r.fields || '[]')) entry.fields.add(f);
    entry.actions.push({ action: r.action, at: r.created_at, reason: r.reason });
    byUser.set(r.target_user_id, entry);
  }

  return [...byUser.values()].map((e) => ({ ...e, fields: [...e.fields].sort() }));
}

// ── §14 — anomaly alerting ───────────────────────────────
const WORKING_HOURS = [8, 20];

export function anomalies({ windowHours = 1, threshold = 20 } = {}) {
  const since = sqlTime(Date.now() - windowHours * 3_600_000);
  const out = [];

  // More than N member records touched by one staff account in an hour.
  for (const r of all(
    `SELECT actor_id, COUNT(DISTINCT target_user_id) n
       FROM audit_log
      WHERE actor_type = 'staff' AND created_at >= ? AND target_user_id IS NOT NULL
      GROUP BY actor_id HAVING n >= ?`,
    since, threshold
  )) {
    out.push({ kind: 'bulk_access', staffId: r.actor_id, count: r.n });
  }

  // Any access outside working hours.
  for (const r of all(
    `SELECT actor_id, target_user_id, action, created_at
       FROM audit_log
      WHERE actor_type = 'staff' AND created_at >= ? AND target_user_id IS NOT NULL`,
    since
  )) {
    const hour = new Date(`${r.created_at.replace(' ', 'T')}Z`).getUTCHours();
    if (hour < WORKING_HOURS[0] || hour >= WORKING_HOURS[1]) {
      out.push({ kind: 'out_of_hours', staffId: r.actor_id, at: r.created_at, action: r.action });
    }
  }

  // Every use of the crown-jewel export, without exception.
  for (const r of all(
    `SELECT actor_id, target_user_id, created_at FROM audit_log
      WHERE action = 'admin.user.export' AND created_at >= ?`,
    since
  )) {
    out.push({ kind: 'export', staffId: r.actor_id, targetUserId: r.target_user_id, at: r.created_at });
  }

  return out;
}

/** What a reader can see about their own account's history (§9 trust). */
export const forUser = (userId, limit = 50) =>
  all(
    `SELECT action, created_at, metadata FROM audit_log
      WHERE target_user_id = ? AND actor_type IN ('user', 'system')
      ORDER BY created_at DESC LIMIT ?`,
    Number(userId), limit
  );
