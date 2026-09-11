import { randomUUID } from 'node:crypto';
import { get, run, db, sqlTime, nowSQL } from '../../db/index.js';
import { newToken, hashToken } from '../crypto.js';

// ── §4, §8 — single-use email tokens ─────────────────────
//
// Every one of these is 32 bytes of CSPRNG, stored hashed, and consumed
// atomically. The atomicity is not fussiness: a reset link that can be
// redeemed twice by two racing requests is a reset link that can be redeemed
// by an attacker who saw it once.

export const TTL = {
  verify: 24 * 3600_000,
  // §8 — fifteen minutes, not twenty-four hours. This is the highest-value
  // token in the system: it converts inbox access into account access.
  reset: 15 * 60_000,
  email_change: 24 * 3600_000,
  // The revoke link has to outlive a weekend, because catching a takeover
  // in progress is exactly what it is for.
  revoke_email_change: 72 * 3600_000,
  login_link: 15 * 60_000,
  not_me: 72 * 3600_000,
  export: 3600_000
};

export function issue(userId, purpose, { newEmail = null, oldEmail = null } = {}) {
  const ttl = TTL[purpose];
  if (!ttl) throw new Error(`unknown token purpose: ${purpose}`);

  const token = newToken();
  run(
    `INSERT INTO email_tokens (id, user_id, purpose, token_hash, new_email, old_email, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), Number(userId), purpose, hashToken(token),
    newEmail, oldEmail, sqlTime(Date.now() + ttl)
  );
  return token;
}

/**
 * Consume a token, atomically. Returns the row or null — never a "valid but
 * already used" state, because there is nothing a caller should do with one.
 *
 * The UPDATE carries the whole predicate, so two concurrent redemptions
 * cannot both see an unconsumed row: SQLite serialises the writes and the
 * second one matches zero rows.
 */
export function consume(token, purpose) {
  if (!token) return null;
  const hash = hashToken(token);

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = get(
      `SELECT * FROM email_tokens
        WHERE token_hash = ? AND purpose = ?
          AND consumed_at IS NULL AND expires_at > ?`,
      hash, purpose, nowSQL()
    );
    if (!row) { db.exec('ROLLBACK'); return null; }

    const res = run(
      `UPDATE email_tokens SET consumed_at = datetime('now')
        WHERE id = ? AND consumed_at IS NULL`,
      row.id
    );
    if (!res.changes) { db.exec('ROLLBACK'); return null; }

    db.exec('COMMIT');
    return row;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Peek without consuming — for a confirm screen that renders before a POST.
 * Returns null, never undefined, so callers can compare against one absent
 * value rather than two.
 */
export const inspect = (token, purpose) =>
  (token
    ? get(
        `SELECT * FROM email_tokens
          WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`,
        hashToken(token), purpose, nowSQL()
      )
    : null) ?? null;

/** Issuing a new token of a kind invalidates the outstanding ones. */
export function invalidate(userId, purpose) {
  run(
    `UPDATE email_tokens SET consumed_at = datetime('now')
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`,
    Number(userId), purpose
  );
}

export function sweepExpired() {
  const r = run(`DELETE FROM email_tokens WHERE expires_at < datetime('now', '-7 days')`);
  return r.changes;
}
