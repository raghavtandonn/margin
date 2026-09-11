import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { get, all, run, db } from '../../db/index.js';
import { seal, open } from '../crypto.js';
import { hashPassword, verifyPassword } from './passwords.js';

// ── §6 — TOTP ────────────────────────────────────────────
//
// RFC 6238, SHA-1, 6 digits, 30-second step. Those are not choices — they are
// what every authenticator app implements, and deviating buys nothing but
// support tickets.
//
// The part that IS a choice, and the reason this file is not thirty lines
// long, is `last_used_step`. §6: "Store last_used_step and reject any code at
// or below it. Without this, a phished code is replayable for its full
// window." Letterboxd-style TOTP without it is a real gap, so it is enforced
// here inside the same transaction that accepts the code.

const STEP_SECONDS = 30;
const DIGITS = 6;
// ±1 step of drift and no more. Wider windows are how a 30-second code
// quietly becomes a five-minute one.
const DRIFT = 1;

// ── base32, RFC 4648 without padding ─────────────────────
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/[\s=-]/g, '')) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── The algorithm ────────────────────────────────────────
export const stepFor = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

export function codeFor(secret, step) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

const constantEquals = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * Which step, if any, this code belongs to. Returns null rather than a
 * boolean because the caller needs the step number to store it.
 */
export function stepOfCode(secret, code, { at = Date.now() } = {}) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;

  const now = stepFor(at);
  for (let d = -DRIFT; d <= DRIFT; d++) {
    if (constantEquals(codeFor(secret, now + d), clean)) return now + d;
  }
  return null;
}

// ── Enrollment ───────────────────────────────────────────
export function beginEnrollment(user, { issuer = 'MARGIN' } = {}) {
  const secret = randomBytes(20);
  const b32 = base32Encode(secret);
  const label = encodeURIComponent(`${issuer}:${user.username || user.email}`);
  return {
    secret: b32,
    // The URI an authenticator scans. It carries the secret, so it is
    // rendered once and never stored or logged.
    uri: `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(issuer)}` +
         `&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
  };
}

/**
 * §6 — "confirm enrollment by requiring one valid code before switching it
 * on". An unconfirmed secret is never written, so a half-finished setup
 * cannot lock anyone out of their own account.
 */
export function confirmEnrollment(userId, secret, code) {
  if (!/^[A-Z2-7]{32}$/.test(String(secret))) return { ok: false, error: 'Invalid authenticator secret. Start setup again.' };
  const step = stepOfCode(secret, code);
  if (step == null) return { ok: false, error: 'That code is wrong, or the clock has drifted.' };

  run(
    `INSERT INTO credentials_totp (user_id, secret_encrypted, confirmed_at, last_used_step)
       VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_encrypted = excluded.secret_encrypted,
       confirmed_at = excluded.confirmed_at,
       last_used_step = excluded.last_used_step`,
    Number(userId), seal(secret), step
  );

  return { ok: true };
}

export const isEnabled = (userId) =>
  !!get('SELECT user_id FROM credentials_totp WHERE user_id = ?', Number(userId));

export function disable(userId) {
  run('DELETE FROM credentials_totp WHERE user_id = ?', Number(userId));
}

/**
 * Verify a code at sign-in, and burn its step.
 *
 * The read of `last_used_step`, the comparison, and the write all happen
 * inside one immediate transaction. Outside a transaction, two requests
 * carrying the same phished code can both read the old step and both pass —
 * which is precisely the replay this is meant to stop.
 */
export function verify(userId, code, { at = Date.now() } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = get('SELECT * FROM credentials_totp WHERE user_id = ?', Number(userId));
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Two-factor is not set up.' }; }

    const secret = open(row.secret_encrypted);
    if (!secret) { db.exec('ROLLBACK'); return { ok: false, error: 'Two-factor is unavailable.' }; }

    const step = stepOfCode(secret, code, { at });
    if (step == null) { db.exec('ROLLBACK'); return { ok: false, error: 'That code is wrong.' }; }

    if (row.last_used_step != null && step <= row.last_used_step) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That code has already been used. Wait for the next one.' };
    }

    run('UPDATE credentials_totp SET last_used_step = ? WHERE user_id = ?', step, Number(userId));
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── §6 — recovery codes ──────────────────────────────────
// "This is what stops 'lost my phone' from becoming a support-ticket
// social-engineering channel." Letterboxd does not have these; that is the
// one part of their 2FA this deliberately does not copy.
const CODE_COUNT = 10;

// No vowels and no 0/1/O/I: a code is read off a printout and typed, and
// every removed character is a support ticket that never happens.
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

const oneCode = () => {
  const pick = () =>
    Array.from(randomBytes(5))
      .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
      .join('');
  return `${pick()}-${pick()}`;
};

/** Generates a fresh set, invalidating any previous one. Shown exactly once. */
export async function generateRecoveryCodes(userId) {
  const codes = Array.from({ length: CODE_COUNT }, oneCode);

  run('DELETE FROM recovery_codes WHERE user_id = ?', Number(userId));
  for (const code of codes) {
    run(
      'INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
      randomUUID(), Number(userId), await hashPassword(code)
    );
  }
  return codes;
}

export const recoveryCodesRemaining = (userId) =>
  get(
    'SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
    Number(userId)
  ).n;

/**
 * Consume one recovery code. Hashed with Argon2id exactly like a password,
 * so this walks the unused set rather than looking one up — the cost is ten
 * verifications at worst, once, on a path taken when someone has lost a phone.
 */
export async function useRecoveryCode(userId, code) {
  const clean = String(code ?? '').trim().toUpperCase().replace(/\s/g, '');
  if (!clean) return { ok: false };

  const rows = all(
    'SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
    Number(userId)
  );

  for (const row of rows) {
    if (await verifyPassword(clean, row.code_hash)) {
      const res = run(
        `UPDATE recovery_codes SET used_at = datetime('now')
          WHERE id = ? AND used_at IS NULL`,
        row.id
      );
      // Lost the race with another redemption of the same code.
      if (!res.changes) return { ok: false };
      return { ok: true, remaining: recoveryCodesRemaining(userId) };
    }
  }

  return { ok: false };
}
