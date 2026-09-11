import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { get, all, run, sqlTime, nowSQL } from '../../db/index.js';

// ── §6 — passkeys, the preferred path ────────────────────
//
// "Offer passkey registration during onboarding, presented as the default,
// with password as the alternative."
//
// §6 also says not to hand-roll this: "Use a maintained library
// (@simplewebauthn/server or equivalent). Do not hand-roll CBOR/COSE
// parsing." That instruction is worth following. Attestation parsing is a
// binary format inside a binary format, signed, with a decade of accumulated
// authenticator quirks — precisely the code where a subtle bug is both
// invisible and total.

export const rpName = 'MARGIN';

// The RP ID is the registrable domain, and a passkey is bound to it forever.
// Getting it wrong means every credential registered under the old value
// stops working, so it is configuration rather than a guess from a header —
// a Host header an attacker controls must never decide it.
export const rpID = () => process.env.MARGIN_RP_ID || 'localhost';

export const origin = () =>
  process.env.MARGIN_ORIGIN || process.env.MARGIN_BASE_URL || 'http://localhost:3000';

const CHALLENGE_TTL = 5 * 60_000;

function storeChallenge(userId, challenge, purpose) {
  const id = randomUUID();
  run(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    id, userId ? Number(userId) : null, challenge, purpose,
    sqlTime(Date.now() + CHALLENGE_TTL)
  );
  return id;
}

/** Single-use. A replayed challenge is a replayed assertion. */
function takeChallenge(id, purpose) {
  const row = get(
    `SELECT * FROM webauthn_challenges
      WHERE id = ? AND purpose = ? AND expires_at > ?`,
    id, purpose, nowSQL()
  );
  if (row) run('DELETE FROM webauthn_challenges WHERE id = ?', id);
  return row;
}

export const credentialsFor = (userId) =>
  all(
    `SELECT id, credential_id, public_key, sign_count, transports, nickname,
            created_at, last_used_at
       FROM credentials_webauthn WHERE user_id = ? ORDER BY created_at`,
    Number(userId)
  );

export const hasPasskeys = (userId) => credentialsFor(userId).length > 0;

// ── Registration ─────────────────────────────────────────
export async function beginRegistration(user) {
  const existing = credentialsFor(user.id);

  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpID(),
    // The user handle must not be an email or anything else personal: it is
    // stored on the authenticator, which may be shared hardware.
    userID: Buffer.from(user.public_id),
    userName: user.username || user.email,
    userDisplayName: user.display_name || user.username || 'reader',
    attestationType: 'none',
    // Registering the same authenticator twice creates a credential that
    // silently shadows the first.
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: safeTransports(c.transports)
    })),
    authenticatorSelection: {
      // §6 — resident/discoverable credentials, user verification preferred.
      residentKey: 'preferred',
      userVerification: 'required'
    }
  });

  const challengeId = storeChallenge(user.id, options.challenge, 'register');
  return { options, challengeId };
}

export async function finishRegistration(user, { challengeId, response, nickname }) {
  if (typeof challengeId !== 'string' || !response || typeof response !== 'object') return { ok: false, error: 'Invalid passkey request.' };
  const stored = takeChallenge(challengeId, 'register');
  if (!stored || Number(stored.user_id) !== Number(user.id)) {
    return { ok: false, error: 'That request expired. Try again.' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
      requireUserVerification: true
    });
  } catch (err) {
    return { ok: false, error: 'That passkey could not be verified.' };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'That passkey could not be verified.' };
  }

  const { credential } = verification.registrationInfo;

  run(
    `INSERT INTO credentials_webauthn
       (id, user_id, credential_id, public_key, sign_count, transports, nickname)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), Number(user.id), credential.id,
    Buffer.from(credential.publicKey), credential.counter || 0,
    JSON.stringify(credential.transports || response.response?.transports || []),
    String(nickname || '').trim().slice(0, 40) || 'Passkey'
  );

  return { ok: true };
}

// ── Authentication ───────────────────────────────────────
/**
 * With no user named, this is a discoverable-credential ("usernameless")
 * flow: the authenticator says which account it is for.
 */
export async function beginAuthentication(user = null) {
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    userVerification: 'required',
    allowCredentials: user
      ? credentialsFor(user.id).map((c) => ({
          id: c.credential_id,
          transports: safeTransports(c.transports)
        }))
      : undefined
  });

  const challengeId = storeChallenge(user?.id ?? null, options.challenge, 'authenticate');
  return { options, challengeId };
}

export async function finishAuthentication({ challengeId, response }) {
  if (typeof challengeId !== 'string' || typeof response?.id !== 'string') return { ok: false, error: 'Invalid passkey request.' };
  const stored = takeChallenge(challengeId, 'authenticate');
  if (!stored) return { ok: false, error: 'That request expired. Try again.' };

  const cred = get(
    'SELECT * FROM credentials_webauthn WHERE credential_id = ?',
    response?.id
  );
  if (!cred) return { ok: false, error: 'That passkey is not registered.' };

  // A challenge issued for one account must not authenticate another.
  if (stored.user_id != null && Number(stored.user_id) !== Number(cred.user_id)) {
    return { ok: false, error: 'That passkey is not registered.' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.sign_count) || 0,
        transports: safeTransports(cred.transports)
      },
      requireUserVerification: true
    });
  } catch {
    return { ok: false, error: 'That passkey could not be verified.' };
  }

  if (!verification.verified) return { ok: false, error: 'That passkey could not be verified.' };

  // §6 — "increment/verify sign_count where the authenticator provides one".
  // A counter that goes backwards is the documented signal of a cloned
  // authenticator. Many platform authenticators always report 0, and for
  // those the check is meaningless rather than failed.
  const newCount = verification.authenticationInfo.newCounter;
  if (newCount > 0 && Number(cred.sign_count) > 0 && newCount <= Number(cred.sign_count)) {
    return { ok: false, error: 'That passkey looks cloned. It has been refused.', cloned: true };
  }

  run(
    `UPDATE credentials_webauthn SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?`,
    newCount, cred.id
  );

  return { ok: true, userId: Number(cred.user_id), credentialId: cred.id };
}

export function removeCredential(userId, id) {
  const res = run(
    'DELETE FROM credentials_webauthn WHERE id = ? AND user_id = ?',
    id, Number(userId)
  );
  return res.changes > 0;
}

export function renameCredential(userId, id, nickname) {
  run(
    'UPDATE credentials_webauthn SET nickname = ? WHERE id = ? AND user_id = ?',
    String(nickname || '').trim().slice(0, 40) || 'Passkey', id, Number(userId)
  );
}

const safeTransports = (json) => {
  try {
    const t = JSON.parse(json || '[]');
    return Array.isArray(t) && t.length ? t : undefined;
  } catch { return undefined; }
};

export function sweepChallenges() {
  return run(
    `DELETE FROM webauthn_challenges WHERE expires_at < ?`,
    nowSQL()
  ).changes;
}
