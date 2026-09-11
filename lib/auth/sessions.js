import { randomUUID } from 'node:crypto';
import { get, all, run, sqlTime, nowSQL, parseSQLTime } from '../../db/index.js';
import { newToken, hashToken, hashIP, deviceKey } from '../crypto.js';

// ── §7 — sessions ────────────────────────────────────────
//
// Opaque random tokens, not JWTs. The reason is one sentence long: a JWT
// cannot be revoked, and revocation is the entire point of a session list.
//
// The token is stored as a SHA-256 hash. A stolen database gives an attacker
// no usable session, the same way it gives them no usable password.

const IDLE_DAYS = 30;
const ABSOLUTE_DAYS = 90;

// `__Host-` is not decoration. It forbids a Domain attribute and requires
// Secure and Path=/, so a subdomain — including one taken over by someone
// else — cannot write a cookie that this app will read.
export const COOKIE = process.env.NODE_ENV === 'production' ? '__Host-margin' : 'margin_session';

export const cookieOptions = ({ maxAge } = {}) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: maxAge ?? IDLE_DAYS * 86_400_000
});

const iso = sqlTime;
const parseTime = parseSQLTime;

/**
 * Issue a session. Every caller that changes privilege issues a NEW one and
 * discards the old — see `rotate`, which is what closes session fixation.
 */
export function create(userId, { ip, userAgent, aal = 1, reauth = true } = {}) {
  const token = newToken();
  const id = randomUUID();

  run(
    `INSERT INTO auth_sessions
       (id, user_id, token_hash, user_agent, ip_hash, expires_at, aal, reauth_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, Number(userId), hashToken(token),
    String(userAgent || '').slice(0, 300), hashIP(ip),
    iso(Date.now() + IDLE_DAYS * 86_400_000),
    aal,
    reauth ? iso(Date.now()) : null
  );

  return { id, token };
}

/** Resolve a cookie to a live session, sliding its idle window forward. */
export function resolve(token) {
  if (!token) return null;

  const row = get(
    `SELECT s.*, u.id AS uid FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
        AND u.deleted_at IS NULL AND u.is_tombstone = 0`,
    hashToken(token)
  );
  if (!row) return null;

  const now = Date.now();
  if (parseTime(row.expires_at) < now) return null;

  // §7 — idle timeout 30 days, absolute maximum 90. A session that has been
  // continuously active for three months still ends.
  if (now - parseTime(row.created_at) > ABSOLUTE_DAYS * 86_400_000) {
    revoke(row.id);
    return null;
  }

  run(
    `UPDATE auth_sessions SET last_active_at = datetime('now'), expires_at = ? WHERE id = ?`,
    iso(now + IDLE_DAYS * 86_400_000), row.id
  );

  return row;
}

/**
 * §7 — "rotate the session token on every privilege change". Login, password
 * change, 2FA enable/disable, and step-up all land here. The old token stops
 * working the instant the new one is issued.
 */
export function rotate(session, { ip, userAgent, aal, reauth = false } = {}) {
  const token = newToken();
  run(
    `UPDATE auth_sessions
        SET token_hash = ?, ip_hash = ?, user_agent = ?, aal = ?, reauth_at = ?,
            last_active_at = datetime('now')
      WHERE id = ?`,
    hashToken(token), hashIP(ip), String(userAgent || '').slice(0, 300),
    aal ?? session.aal,
    reauth ? iso(Date.now()) : session.reauth_at,
    session.id
  );
  return { id: session.id, token };
}

export function revoke(sessionId) {
  run(`UPDATE auth_sessions SET revoked_at = datetime('now') WHERE id = ?`, sessionId);
}

/**
 * §7, §8 — a password change or a "this wasn't me" revokes EVERY session.
 * `except` keeps the one doing the changing, so the reader is not signed out
 * of the device they are holding.
 */
export function revokeAll(userId, { except = null } = {}) {
  const rows = all(
    `SELECT id FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
    Number(userId), except
  );
  for (const r of rows) revoke(r.id);
  return rows.length;
}

/** The settings list: device, place, last active, and a revoke per row. */
export function list(userId, currentId) {
  return all(
    `SELECT id, user_agent, ip_hash, created_at, last_active_at, expires_at, aal
       FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
      ORDER BY last_active_at DESC`,
    Number(userId)
  ).map((s) => ({
    ...s,
    current: s.id === currentId,
    device: describe(s.user_agent)
  }));
}

// A user agent string is unreadable and a browser name is what someone
// actually needs to recognise their own laptop.
function describe(ua = '') {
  const s = String(ua);
  const browser =
    /Firefox\/(\d+)/.test(s) ? 'Firefox' :
    /Edg\//.test(s) ? 'Edge' :
    /Chrome\/(\d+)/.test(s) && !/Chromium/.test(s) ? 'Chrome' :
    /Safari\//.test(s) && !/Chrome/.test(s) ? 'Safari' :
    /curl\//i.test(s) ? 'curl' : 'Unknown browser';
  const os =
    /iPhone|iPad/.test(s) ? 'iOS' :
    /Android/.test(s) ? 'Android' :
    /Mac OS X/.test(s) ? 'macOS' :
    /Windows/.test(s) ? 'Windows' :
    /Linux/.test(s) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

// ── §6 — step-up re-authentication ───────────────────────
// A factor presented five minutes ago is fresh; one presented at login this
// morning is not. Changing a password, disabling 2FA, or exporting a library
// all require the fresh one.
const REAUTH_WINDOW_MS = 5 * 60_000;

export const isFresh = (session) =>
  !!session?.reauth_at && Date.now() - parseTime(session.reauth_at) < REAUTH_WINDOW_MS;

export function markFresh(sessionId) {
  run(`UPDATE auth_sessions SET reauth_at = ? WHERE id = ?`, iso(Date.now()), sessionId);
}

export function setAAL(sessionId, aal) {
  run(`UPDATE auth_sessions SET aal = ? WHERE id = ?`, aal, sessionId);
}

// ── §5 — new device notice ───────────────────────────────
/** Records the device and reports whether it had been seen before. */
export function seenDevice(userId, ip, userAgent) {
  const key = deviceKey(ip, userAgent);
  const known = get(
    'SELECT id FROM known_devices WHERE user_id = ? AND device_key = ?',
    Number(userId), key
  );

  if (known) {
    run(`UPDATE known_devices SET last_seen = datetime('now') WHERE id = ?`, known.id);
    return { isNew: false };
  }

  run(
    'INSERT INTO known_devices (id, user_id, device_key) VALUES (?, ?, ?)',
    randomUUID(), Number(userId), key
  );
  // A first-ever device is not "unrecognised" in the alarming sense — it is
  // simply the account's first login, and mailing about it is noise.
  const count = get('SELECT COUNT(*) n FROM known_devices WHERE user_id = ?', Number(userId)).n;
  return { isNew: count > 1 };
}
