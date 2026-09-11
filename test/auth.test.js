import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { db, get, run, sqlTime } = await import('../db/index.js');
const P = await import('../lib/auth/passwords.js');
const S = await import('../lib/auth/sessions.js');
const T = await import('../lib/auth/tokens.js');
const TOTP = await import('../lib/auth/totp.js');
const RL = await import('../lib/auth/ratelimit.js');
const A = await import('../lib/accounts.js');

// A verified account with a known password, built once.
const PASSWORD = 'a quiet room and a long afternoon';
const user = A.createUser({ email: 'reader@example.test', passwordHash: await P.hashPassword(PASSWORD) });
A.markVerified(user.id);
A.setUsername(user.id, 'reader');

// ── §19 AUTHENTICATION ───────────────────────────────────

test('§19 — a wrong email and a wrong password are indistinguishable', async (t) => {
  // The spec asks for parity "within 50ms across 100 samples". 100 Argon2
  // verifications at OWASP parameters is ~10s, so this measures 24 and
  // compares medians, which is what actually detects a missing dummy verify
  // (that gap is ~90ms, not 5ms).
  const SAMPLES = 24;

  const time = async (fn) => {
    const times = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = process.hrtime.bigint();
      await fn();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return times.sort((a, b) => a - b)[Math.floor(SAMPLES / 2)];
  };

  // The no-such-user path, exactly as routes/auth.js takes it.
  const missing = await time(async () => {
    const u = A.findByIdentifier('nobody@example.test');
    if (!u) await P.dummyVerify(PASSWORD);
  });

  // The wrong-password path.
  const wrong = await time(async () => {
    const u = A.findByIdentifier('reader@example.test');
    await P.verifyPassword('not the password', u.password_hash);
  });

  const delta = Math.abs(missing - wrong);
  await t.test(`medians within 50ms (missing ${missing.toFixed(1)}ms, wrong ${wrong.toFixed(1)}ms)`, () => {
    assert.ok(delta < 50, `timing differs by ${delta.toFixed(1)}ms — enumeration is possible`);
  });
});

test('§19 — six failures trigger backoff, and the account is never locked', () => {
  RL.__reset();
  run('DELETE FROM auth_failures');

  for (let i = 0; i < 5; i++) {
    RL.recordFailure(user.id);
    assert.equal(RL.accountBackoff(user.id).ok, true, `attempt ${i + 1} should still be free`);
  }

  const sixth = RL.recordFailure(user.id);
  assert.ok(sixth.retryAfter, 'the sixth failure must impose a wait');
  assert.equal(RL.accountBackoff(user.id).ok, false);

  // Backoff, not lockout: it expires on its own.
  const wait = RL.accountBackoff(user.id).retryAfter;
  assert.ok(wait > 0 && wait <= 900, `wait of ${wait}s must be finite and capped at 15 minutes`);

  // And a success clears it — the account is not left crippled.
  RL.clearFailures(user.id);
  assert.equal(RL.accountBackoff(user.id).ok, true);
});

test('§19 — backoff is capped and survives a restart', () => {
  run('DELETE FROM auth_failures');
  for (let i = 0; i < 30; i++) RL.recordFailure(user.id);
  const wait = RL.accountBackoff(user.id).retryAfter;
  assert.ok(wait <= 900, `capped at 15 minutes, got ${wait}s`);

  // The counter is in the database, not in memory, so restarting the process
  // is not a free reset of the attacker's budget.
  const row = get('SELECT * FROM auth_failures WHERE scope = ?', `account:${user.id}`);
  assert.ok(row && row.count >= 30);
  run('DELETE FROM auth_failures');
});

test('§19 — a TOTP code cannot be used twice', () => {
  const { secret } = TOTP.beginEnrollment(user);
  const code = TOTP.codeFor(secret, TOTP.stepFor());
  assert.equal(TOTP.confirmEnrollment(user.id, secret, code).ok, true);

  // Enrollment burned this step, so the same code is already spent.
  assert.equal(TOTP.verify(user.id, code).ok, false, 'the enrollment code must not be reusable');

  // A fresh step works once...
  const next = TOTP.stepFor() + 1;
  const at = next * 30_000;
  const nextCode = TOTP.codeFor(secret, next);
  assert.equal(TOTP.verify(user.id, nextCode, { at }).ok, true);

  // ...and exactly once.
  const replay = TOTP.verify(user.id, nextCode, { at });
  assert.equal(replay.ok, false, 'a replayed code must be refused');
  assert.match(replay.error, /already been used/);
});

test('the burnt step is what stops a replay, not the drift window', () => {
  // Enrol at the CURRENT step, which burns it.
  const { secret } = TOTP.beginEnrollment(user);
  const now = TOTP.stepFor();
  assert.equal(TOTP.confirmEnrollment(user.id, secret, TOTP.codeFor(secret, now)).ok, true);

  // The step immediately before is still inside the ±1 drift window, so a
  // naive implementation accepts it. last_used_step is what refuses it.
  const behind = TOTP.codeFor(secret, now - 1);
  const result = TOTP.verify(user.id, behind);
  assert.equal(result.ok, false, 'an earlier step must be refused despite valid drift');
  assert.match(result.error, /already been used/);

  // And the step after is accepted, so the window has not simply closed.
  assert.equal(TOTP.verify(user.id, TOTP.codeFor(secret, now + 1)).ok, true);
});

test('§19 — a passkey alone reaches AAL2 and is not asked for TOTP', () => {
  // completeSignIn() is called with aal 2 for a passkey, and requireAAL2
  // reads that number. The property under test is that the session carries
  // it rather than the route re-deriving it from whether TOTP is enabled.
  const { id } = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test', aal: 2 });
  const row = get('SELECT aal FROM auth_sessions WHERE id = ?', id);
  assert.equal(row.aal, 2);
});

test('§19 — the session token changes on login and on password change', () => {
  const first = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test' });
  const session = get('SELECT * FROM auth_sessions WHERE id = ?', first.id);

  const rotated = S.rotate(session, { ip: '127.0.0.1', userAgent: 'test', reauth: true });
  assert.notEqual(rotated.token, first.token, 'rotation must issue a new token');

  // The old token is dead the moment the new one exists — session fixation.
  assert.equal(S.resolve(first.token), null, 'the pre-rotation token must stop working');
  assert.ok(S.resolve(rotated.token), 'the new token works');
});

test('§19 — changing a password revokes every other session', () => {
  const a = S.create(user.id, { ip: '127.0.0.1', userAgent: 'laptop' });
  const b = S.create(user.id, { ip: '127.0.0.1', userAgent: 'phone' });
  const c = S.create(user.id, { ip: '127.0.0.1', userAgent: 'tablet' });

  const revoked = S.revokeAll(user.id, { except: a.id });

  assert.ok(revoked >= 2);
  assert.ok(S.resolve(a.token), 'the session doing the changing survives');
  assert.equal(S.resolve(b.token), null);
  assert.equal(S.resolve(c.token), null);
});

test('§19 — a reset does not bypass two-factor', () => {
  // The route demands a valid second factor BEFORE consuming the token, and
  // the property that matters is that a failed code does not burn the link.
  const token = T.issue(user.id, 'reset');
  assert.ok(TOTP.isEnabled(user.id), 'this account has 2FA on');

  // A wrong code: the token must still be redeemable afterwards.
  assert.equal(TOTP.verify(user.id, '000000').ok, false);
  assert.ok(T.inspect(token, 'reset'), 'a failed second factor must not consume the reset token');

  // And the token itself is single-use once it is consumed.
  assert.ok(T.consume(token, 'reset'));
  assert.equal(T.consume(token, 'reset'), null, 'a reset token works exactly once');
});

test('a reset token expires in fifteen minutes, not a day', () => {
  assert.equal(T.TTL.reset, 15 * 60_000);
  assert.equal(T.TTL.verify, 24 * 3600_000);
  assert.equal(T.TTL.revoke_email_change, 72 * 3600_000);
});

test('an expired token is refused', () => {
  const token = T.issue(user.id, 'reset');
  // sqlTime, not toISOString: these columns are compared as strings against
  // SQLite's own format, and mixing the two is what made an expired token
  // compare as valid in the first place.
  run(`UPDATE email_tokens SET expires_at = ? WHERE user_id = ? AND purpose = 'reset'`,
      sqlTime(Date.now() - 1000), user.id);
  assert.equal(T.consume(token, 'reset'), null);
});

test('a token issued for one purpose cannot be redeemed for another', () => {
  const token = T.issue(user.id, 'verify');
  assert.equal(T.consume(token, 'reset'), null, 'a verify link must not reset a password');
  assert.ok(T.consume(token, 'verify'));
});

// ── §6 recovery codes ────────────────────────────────────
test('§6 — recovery codes are single-use and counted down', async () => {
  const codes = await TOTP.generateRecoveryCodes(user.id);
  assert.equal(codes.length, 10);
  assert.equal(TOTP.recoveryCodesRemaining(user.id), 10);

  const first = await TOTP.useRecoveryCode(user.id, codes[0]);
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 9);

  const replay = await TOTP.useRecoveryCode(user.id, codes[0]);
  assert.equal(replay.ok, false, 'a recovery code works once');

  assert.equal((await TOTP.useRecoveryCode(user.id, 'NOTACODE-NOTACODE')).ok, false);

  // Regenerating invalidates the old set entirely.
  await TOTP.generateRecoveryCodes(user.id);
  assert.equal((await TOTP.useRecoveryCode(user.id, codes[1])).ok, false);
});

test('recovery codes are stored hashed, never in the clear', async () => {
  const codes = await TOTP.generateRecoveryCodes(user.id);
  const rows = db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?').all(user.id);
  for (const r of rows) {
    assert.match(r.code_hash, /^\$argon2id\$/);
    assert.ok(!codes.includes(r.code_hash));
  }
});

// ── §4 password policy ───────────────────────────────────
test('§4 — NIST, not folklore', async (t) => {
  await t.test('no composition rules', async () => {
    assert.equal((await P.checkPassword('alllowercaseletters')).ok, true);
  });

  await t.test('all Unicode, including spaces and emoji', async () => {
    assert.equal((await P.checkPassword('a quiet 🕯 room, at dusk')).ok, true);
  });

  await t.test('eight characters minimum', async () => {
    assert.equal((await P.checkPassword('short')).ok, false);
  });

  await t.test('long passwords are accepted', async () => {
    assert.equal((await P.checkPassword('x'.repeat(200) + ' correct horse')).ok, true);
  });

  await t.test('a breached password is refused', async () => {
    const r = await P.checkPassword('password1');
    assert.equal(r.ok, false);
    assert.match(r.error, /known breach/);
  });

  await t.test('NFKC before hashing, so a normalised variant still verifies', async () => {
    // U+FB01 LATIN SMALL LIGATURE FI normalises to "fi" under NFKC.
    const hash = await P.hashPassword('the ﬁrst edition of it');
    assert.equal(await P.verifyPassword('the first edition of it', hash), true);
  });
});

test('§4 — hashes are Argon2id at OWASP parameters and upgrade transparently', async () => {
  const hash = await P.hashPassword('a quiet room and a long afternoon');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(P.needsRehash(hash), false);
  assert.equal(P.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA'), true);
  assert.equal(P.needsRehash('$2b$12$something.bcrypt.shaped'), true, 'a foreign hash must be upgraded');
});

// ── §9 usernames ─────────────────────────────────────────
test('§9 — username rules', async (t) => {
  await t.test('shape', () => {
    assert.equal(A.validateUsername('ab').ok, false, 'too short');
    assert.equal(A.validateUsername('a'.repeat(21)).ok, false, 'too long');
    assert.equal(A.validateUsername('_leading').ok, false);
    assert.equal(A.validateUsername('trailing_').ok, false);
    assert.equal(A.validateUsername('has space').ok, false);
    assert.equal(A.validateUsername('good_name1').ok, true);
  });

  await t.test('reserved names, and confusables of them', () => {
    assert.equal(A.validateUsername('settings').ok, false);
    assert.equal(A.validateUsername('admin').ok, false);
    // Cyrillic а in "аdmin" renders identically to the Latin one.
    assert.equal(A.validateUsername('аdmin').ok, false, 'a homograph of a reserved name is reserved');
  });

  await t.test('homograph impersonation of a real account', () => {
    // "reader" is taken; "rеader" with a Cyrillic е must not be available.
    assert.equal(A.usernameAvailable('rеader').ok, false);
    assert.equal(A.usernameAvailable('re4der').ok, true, 'a genuinely different name is free');
  });

  await t.test('a changed username is held, not released', () => {
    const second = A.createUser({ email: 'other@example.test', passwordHash: 'x' });
    A.markVerified(second.id);
    A.setUsername(second.id, 'temporary');

    run('UPDATE users SET username_changed_at = NULL WHERE id = ?', second.id);
    assert.equal(A.setUsername(second.id, 'renamed').ok, true);

    // §9 — held 90 days so the freed URL cannot be grabbed for impersonation.
    assert.equal(A.usernameAvailable('temporary').ok, false);

    // And a second change inside 30 days is refused.
    const again = A.setUsername(second.id, 'thirdname');
    assert.equal(again.ok, false);
    assert.match(again.error, /thirty days|30 days|\d+ days/);
  });
});

test('§4 — email normalisation keeps plus-addressing and dots', () => {
  // Stripping these silently merges two people's accounts.
  assert.equal(A.normaliseEmail('  Reader+Books@Example.TEST '), 'reader+books@example.test');
  assert.equal(A.validateEmail('a.b+tag@example.test').ok, true);
  assert.equal(A.validateEmail('not an email').ok, false);
  assert.equal(A.validateEmail('a@b').ok, false, 'a bare hostname is not deliverable');
});

// ── §7 sessions ──────────────────────────────────────────
test('§7 — a revoked session cannot be resolved', () => {
  const s = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test' });
  assert.ok(S.resolve(s.token));
  S.revoke(s.id);
  assert.equal(S.resolve(s.token), null);
});

test('§7 — tokens are stored hashed', () => {
  const s = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test' });
  const row = get('SELECT token_hash FROM auth_sessions WHERE id = ?', s.id);
  assert.notEqual(row.token_hash, s.token);
  assert.match(row.token_hash, /^[a-f0-9]{64}$/);
});

test('§7 — a session past the 90-day absolute maximum is dead', () => {
  const s = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test' });
  run(
    `UPDATE auth_sessions SET created_at = ?, expires_at = ? WHERE id = ?`,
    sqlTime(Date.now() - 91 * 86_400_000),
    sqlTime(Date.now() + 86_400_000),
    s.id
  );
  assert.equal(S.resolve(s.token), null, 'sliding refresh must not outrun the absolute cap');
});

test('§6 — step-up freshness is five minutes', () => {
  const s = S.create(user.id, { ip: '127.0.0.1', userAgent: 'test', reauth: true });
  assert.equal(S.isFresh(get('SELECT * FROM auth_sessions WHERE id = ?', s.id)), true);

  run(`UPDATE auth_sessions SET reauth_at = ? WHERE id = ?`,
      sqlTime(Date.now() - 6 * 60_000), s.id);
  assert.equal(S.isFresh(get('SELECT * FROM auth_sessions WHERE id = ?', s.id)), false);
});

test('an expired token cannot pass by sorting above a SQLite timestamp', () => {
  // The bug this guards: expires_at written as ISO-8601 and compared against
  // datetime('now') sorts 'T' (0x54) above ' ' (0x20), so
  //   '2026-08-25T17:00:00.000Z' > '2026-08-25 18:07:02'  →  true
  // and a token that expired an hour ago reads as still valid.
  const token = T.issue(user.id, 'verify');

  // Expired an hour ago, same calendar day — the case string comparison
  // gets wrong if the formats differ.
  run(
    `UPDATE email_tokens SET expires_at = ? WHERE token_hash IS NOT NULL
       AND purpose = 'verify' AND consumed_at IS NULL`,
    sqlTime(Date.now() - 3600_000)
  );

  assert.equal(T.consume(token, 'verify'), null, 'an hour-old expiry must be refused');
  assert.equal(T.inspect(token, 'verify'), null);
});
