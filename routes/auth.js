import { Router } from '../lib/router.js';
import { get, run, tx } from '../db/index.js';
import * as A from '../lib/accounts.js';
import * as P from '../lib/auth/passwords.js';
import * as S from '../lib/auth/sessions.js';
import * as T from '../lib/auth/tokens.js';
import * as TOTP from '../lib/auth/totp.js';
import * as RL from '../lib/auth/ratelimit.js';
import * as audit from '../lib/audit.js';
import { mail } from '../lib/mailer.js';
import { requireAuth } from '../lib/auth/middleware.js';

const router = Router();

// §17 — one error line, mono, beneath the field. No toast, no icon, no box.
const screen = (res, view, opts = {}) =>
  res.render(`auth/${view}`, { title: opts.title || '', error: null, ...opts });

// The one message every failed sign-in gets. §5: a wrong email and a wrong
// password must be indistinguishable — in the body, in the status, and in
// the time taken.
const GENERIC = "Those details don't match.";

// A local redirect only. `?next=https://evil.example` would otherwise turn
// the sign-in form into an open redirect, which is how a convincing phish
// gets its plausible starting URL.
const safeNext = (next) => {
  const n = String(next || '');
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(n) ? n : '/';
};

// ── REGISTRATION (§4) ────────────────────────────────────
router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  screen(res, 'signup', { title: 'Sign up', values: {} });
});

router.post('/signup', async (req, res) => {
  const { email: rawEmail, password } = req.body;
  const values = { email: String(rawEmail || '') };
  const fail = (error) => screen(res.status(400), 'signup', { title: 'Sign up', error, values });

  const ip = RL.check('ipRegister', req.ip);
  if (!ip.ok) return fail('Too many accounts from here. Try again later.');

  const e = A.validateEmail(rawEmail);
  if (!e.ok) return fail(e.error);

  const pw = await P.checkPassword(password, { email: e.email });
  if (!pw.ok) return fail(pw.error);

  const existing = A.findByEmail(e.email);

  if (existing) {
    // §5 — "signing up with an existing address returns the same 'check your
    // email' screen, and sends that address a 'someone tried to register'
    // message instead." The form must not become an account oracle.
    await mail.alreadyRegistered(e.email);
    audit.record({ actorType: 'system', action: 'auth.signup.duplicate', targetUserId: existing.id, ip: req.ip });
  } else {
    const hash = await P.hashPassword(password);
    const user = A.createUser({ email: e.email, passwordHash: hash });
    const token = T.issue(user.id, 'verify');
    await mail.verify(e.email, token);
    audit.record({ actorType: 'system', action: 'auth.signup', targetUserId: user.id, ip: req.ip,
                   userAgent: req.get('user-agent') });
  }

  // Identical screen either way.
  return screen(res, 'check-email', { title: 'Check your email', email: e.email });
});

// ── VERIFICATION ─────────────────────────────────────────
router.get('/verify', async (req, res) => {
  const row = T.consume(req.query.token, 'verify');
  if (!row) {
    return screen(res.status(400), 'message', {
      title: 'Link expired',
      heading: 'That link has expired.',
      detail: 'Verification links last 24 hours. Sign in to send a new one.',
      action: { href: '/signin', label: 'SIGN IN' }
    });
  }

  A.markVerified(row.user_id);
  audit.record({ actorType: 'user', actorId: row.user_id, action: 'auth.email.verified',
                 targetUserId: row.user_id, ip: req.ip });

  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);

  // A verified account with no username goes straight to choosing one — §4
  // puts that step after verification precisely so throwaway signups cannot
  // squat names.
  const { token } = S.create(user.id, { ip: req.ip, userAgent: req.get('user-agent'), aal: 1 });
  res.cookie(S.COOKIE, token, S.cookieOptions());

  return res.redirect(user.username && !user.username.startsWith('u') ? '/' : '/username');
});

router.get('/verify/pending', requireAuth, (req, res) =>
  screen(res, 'message', {
    title: 'Check your email',
    heading: 'Confirm your address.',
    detail: 'Until you do, your library stays private and nothing can be published from it.',
    action: { href: '/verify/resend', label: 'SEND IT AGAIN', post: true }
  })
);

router.post('/verify/resend', requireAuth, async (req, res) => {
  const limit = RL.check('emailVerify', req.user.email);
  if (limit.ok && !req.user.email_verified_at) {
    T.invalidate(req.user.id, 'verify');
    await mail.verify(req.user.email, T.issue(req.user.id, 'verify'));
  }
  // Same screen whether or not it actually sent, so the rate limit does not
  // become a signal either.
  screen(res, 'message', {
    title: 'Check your email',
    heading: 'Sent.',
    detail: 'If it does not arrive within a few minutes, check the spam folder.'
  });
});

// ── USERNAME (§9) ────────────────────────────────────────
router.get('/username', requireAuth, (req, res) => {
  if (!req.user.email_verified_at) return res.redirect('/verify/pending');
  screen(res, 'username', { title: 'Choose a username', values: {} });
});

router.post('/username', requireAuth, (req, res) => {
  if (!req.user.email_verified_at) return res.redirect('/verify/pending');

  const result = A.setUsername(req.user.id, req.body.username);
  if (!result.ok) {
    return screen(res.status(400), 'username', {
      title: 'Choose a username',
      error: result.error,
      values: { username: String(req.body.username || '') }
    });
  }

  audit.userAction(req, 'account.username.set', { fields: ['username'] });
  res.redirect('/');
});

// ── SIGN IN (§5) ─────────────────────────────────────────
router.get('/signin', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  screen(res, 'signin', { title: 'Sign in', values: {}, next: safeNext(req.query.next) });
});

router.post('/signin', async (req, res) => {
  const { identifier, password } = req.body;
  const next = safeNext(req.body.next);
  const values = { identifier: String(identifier || '') };
  const fail = (error = GENERIC) =>
    screen(res.status(401), 'signin', { title: 'Sign in', error, values, next });

  RL.observeAuthAttempt();

  const ipLimit = RL.check('ipAuth', req.ip);
  if (!ipLimit.ok) {
    res.set('Retry-After', String(ipLimit.retryAfter));
    return screen(res.status(429), 'signin', {
      title: 'Sign in', error: 'Too many attempts. Wait a moment.', values, next
    });
  }

  const user = A.findByIdentifier(identifier);

  if (!user) {
    // §5 — the dummy verification is the whole enumeration defence. Without
    // it, a missing account answers in microseconds and a real one in ~90ms,
    // and the timing alone enumerates the user table.
    await P.dummyVerify(password);
    return fail();
  }

  // §5 — backoff, never lockout. A permanent lock on failures is a
  // denial-of-service weapon pointed at any known username.
  const backoff = RL.accountBackoff(user.id);
  if (!backoff.ok) {
    await P.dummyVerify(password);
    res.set('Retry-After', String(backoff.retryAfter));
    return fail(`Too many attempts. Try again in ${backoff.retryAfter} seconds.`);
  }

  const ok = await P.verifyPassword(password, user.password_hash);
  if (!ok) {
    RL.recordFailure(user.id);
    audit.record({ actorType: 'system', action: 'auth.login.failed', targetUserId: user.id, ip: req.ip });
    return fail();
  }

  // §4 — parameters live in the hash, so an upgrade applies transparently on
  // the next successful sign-in rather than needing a reset.
  if (P.needsRehash(user.password_hash)) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', await P.hashPassword(password), user.id);
  }

  if (TOTP.isEnabled(user.id)) return startSecondFactor(req, res, user, next);
  return completeSignIn(req, res, user, { aal: 1, next });
});

// ── SECOND FACTOR ────────────────────────────────────────
// The half-authenticated state lives in a short signed cookie rather than in
// a server session, so a password that was right but a code that never
// arrived leaves nothing behind to resume.
const PENDING = 'margin_2fa';

function startSecondFactor(req, res, user, next) {
  const token = T.issue(user.id, 'login_link');
  res.cookie(PENDING, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: 10 * 60_000
  });
  return screen(res, 'two-factor', { title: 'Two-factor', next, recovery: false });
}

router.get('/signin/2fa', (req, res) => {
  if (!req.cookies?.[PENDING]) return res.redirect('/signin');
  screen(res, 'two-factor', {
    title: 'Two-factor',
    next: safeNext(req.query.next),
    recovery: req.query.recovery === '1'
  });
});

router.post('/signin/2fa', async (req, res) => {
  const pending = req.cookies?.[PENDING];
  const next = safeNext(req.body.next);
  const useRecovery = !!req.body.recovery_code;

  const row = T.inspect(pending, 'login_link');
  if (!row) return res.redirect('/signin');

  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return res.redirect('/signin');

  const backoff = RL.accountBackoff(user.id);
  if (!backoff.ok) {
    return screen(res.status(429), 'two-factor', {
      title: 'Two-factor', next, recovery: useRecovery,
      error: `Too many attempts. Try again in ${backoff.retryAfter} seconds.`
    });
  }

  let ok = false;

  if (useRecovery) {
    const result = await TOTP.useRecoveryCode(user.id, req.body.recovery_code);
    ok = result.ok;
    if (ok) {
      // §6 — using one warns by email, and below three prompts to regenerate.
      await mail.recoveryCodeUsed(user.email, result.remaining);
      audit.record({ actorType: 'user', actorId: user.id, action: 'auth.recovery_code.used',
                     targetUserId: user.id, ip: req.ip, metadata: { remaining: result.remaining } });
    }
  } else {
    ok = TOTP.verify(user.id, req.body.code).ok;
  }

  if (!ok) {
    RL.recordFailure(user.id);
    return screen(res.status(401), 'two-factor', {
      title: 'Two-factor', next, recovery: useRecovery,
      error: useRecovery ? 'That code is not valid.' : 'That code is wrong, or already used.'
    });
  }

  if (!T.consume(pending, 'login_link')) return res.redirect('/signin');
  res.clearCookie(PENDING, { path: '/' });
  RL.clearFailures(user.id);

  return completeSignIn(req, res, user, { aal: 2, next });
});

// ── Completing a sign-in ─────────────────────────────────
async function completeSignIn(req, res, user, { aal, next }) {
  RL.clearFailures(user.id);
  // §7 — a NEW session token on every privilege change. Reusing a
  // pre-authentication token is session fixation.
  const { token } = S.create(user.id, {
    ip: req.ip, userAgent: req.get('user-agent'), aal, reauth: true
  });
  res.cookie(S.COOKIE, token, S.cookieOptions());

  audit.record({ actorType: 'user', actorId: user.public_id, action: 'auth.login',
                 targetUserId: user.id, ip: req.ip, userAgent: req.get('user-agent'),
                 metadata: { aal } });

  // §5 — a login from a device we have not seen gets a message with a
  // one-click way to undo it.
  const { isNew } = S.seenDevice(user.id, req.ip, req.get('user-agent'));
  if (isNew && user.email_verified_at) {
    await mail.newDevice(user.email, {
      when: new Date().toUTCString(),
      device: req.get('user-agent')?.slice(0, 80) || 'unknown',
      place: 'unknown',       // no IP geolocation service is wired up
      token: T.issue(user.id, 'not_me')
    });
  }

  A.recountBooks(user.id);

  if (!user.email_verified_at) return res.redirect('/verify/pending');
  if (!user.username || user.username.startsWith('u')) return res.redirect('/username');
  return res.redirect(next);
}

// ── SIGN OUT ─────────────────────────────────────────────
router.post('/signout', (req, res) => {
  if (req.session) {
    S.revoke(req.session.id);
    audit.userAction(req, 'auth.logout');
  }
  res.clearCookie(S.COOKIE, { path: '/' });
  res.redirect('/signin');
});

// ── STEP-UP (§6) ─────────────────────────────────────────
router.get('/reauth', requireAuth, (req, res) =>
  screen(res, 'reauth', { title: 'Confirm it is you', next: safeNext(req.query.next) })
);

router.post('/reauth', requireAuth, async (req, res) => {
  const next = safeNext(req.body.next);
  const backoff = RL.accountBackoff(req.user.id);
  if (!backoff.ok) {
    return screen(res.status(429), 'reauth', {
      title: 'Confirm it is you', next,
      error: `Too many attempts. Try again in ${backoff.retryAfter} seconds.`
    });
  }

  const ok = await P.verifyPassword(req.body.password, req.user.password_hash);
  if (!ok) {
    RL.recordFailure(req.user.id);
    return screen(res.status(401), 'reauth', {
      title: 'Confirm it is you', next, error: GENERIC
    });
  }

  if (TOTP.isEnabled(req.user.id) && !TOTP.verify(req.user.id, req.body.code).ok) {
    RL.recordFailure(req.user.id);
    return screen(res.status(401), 'reauth', {
      title: 'Confirm it is you', next, error: 'Enter a valid authenticator code.'
    });
  }
  RL.clearFailures(req.user.id);
  // Step-up is a privilege change, so the token rotates here too.
  const { token } = S.rotate(req.session, {
    ip: req.ip, userAgent: req.get('user-agent'), reauth: true,
    aal: TOTP.isEnabled(req.user.id) ? 2 : req.session.aal
  });
  res.cookie(S.COOKIE, token, S.cookieOptions());
  audit.userAction(req, 'auth.reauth');
  res.redirect(next);
});

// ── PASSWORD RESET (§8) ──────────────────────────────────
router.get('/reset', (req, res) => screen(res, 'reset-request', { title: 'Reset your password' }));

router.post('/reset', async (req, res) => {
  const e = A.validateEmail(req.body.email);

  // §8 — "always respond identically whether or not the address exists".
  // The screen below is returned in every branch, including the invalid one.
  if (e.ok && RL.check('emailReset', e.email).ok) {
    const user = A.findByEmail(e.email);
    if (user) {
      T.invalidate(user.id, 'reset');
      await mail.reset(user.email, T.issue(user.id, 'reset'));
      audit.record({ actorType: 'system', action: 'auth.reset.requested',
                     targetUserId: user.id, ip: req.ip });
    }
  }

  screen(res, 'message', {
    title: 'Check your email',
    heading: 'If that address has an account, a link is on its way.',
    detail: 'The link lasts fifteen minutes.'
  });
});

router.get('/reset/:token', (req, res) => {
  const row = T.inspect(req.params.token, 'reset');
  if (!row) {
    return screen(res.status(400), 'message', {
      title: 'Link expired',
      heading: 'That link has expired.',
      detail: 'Reset links last fifteen minutes. Ask for another.',
      action: { href: '/reset', label: 'START AGAIN' }
    });
  }
  screen(res, 'reset-confirm', { title: 'Choose a new password', token: req.params.token });
});

router.post('/reset/:token', async (req, res) => {
  const ipLimit = RL.check('ipAuth', req.ip);
  if (!ipLimit.ok) return res.status(429).set('Retry-After', String(ipLimit.retryAfter)).send('Try again later.');
  const token = req.params.token;
  const row = T.inspect(token, 'reset');
  if (!row) return res.redirect('/reset');

  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return res.redirect('/reset');
  const backoff = RL.accountBackoff(user.id);
  if (!backoff.ok) return res.status(429).set('Retry-After', String(backoff.retryAfter)).send('Try again later.');

  const pw = await P.checkPassword(req.body.password, { email: user.email, username: user.username });
  if (!pw.ok) {
    return screen(res.status(400), 'reset-confirm', {
      title: 'Choose a new password', token, error: pw.error
    });
  }

  // §8 — "reset does not bypass 2FA. Otherwise email compromise equals full
  // account takeover and 2FA is decorative." The second factor is demanded
  // BEFORE the token is consumed, so a failed code does not burn the link.
  if (TOTP.isEnabled(user.id)) {
    const code = String(req.body.code || '').trim();
    const recovery = String(req.body.recovery_code || '').trim();

    let ok = false;
    if (recovery) {
      const r = await TOTP.useRecoveryCode(user.id, recovery);
      ok = r.ok;
      if (ok) await mail.recoveryCodeUsed(user.email, r.remaining);
    } else if (code) {
      ok = TOTP.verify(user.id, code).ok;
    }

    if (!ok) {
      RL.recordFailure(user.id);
      return screen(res.status(401), 'reset-confirm', {
        title: 'Choose a new password', token, needsCode: true,
        error: code || recovery ? 'That code is not valid.' : null
      });
    }
  }

  // Consumed only now that everything else has passed.
  if (!T.consume(token, 'reset')) return res.redirect('/reset');

  run(
    `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    await P.hashPassword(req.body.password), user.id
  );

  // §8 — revoke EVERY session. A reset is what someone does when they think
  // an account is compromised; leaving the attacker signed in defeats it.
  S.revokeAll(user.id);
  T.invalidate(user.id, 'login_link');
  T.invalidate(user.id, 'email_change');
  RL.clearFailures(user.id);
  await mail.passwordChanged(user.email);
  audit.record({ actorType: 'user', actorId: user.public_id, action: 'auth.password.reset',
                 targetUserId: user.id, ip: req.ip, fields: ['password_hash'] });

  screen(res, 'message', {
    title: 'Password changed',
    heading: 'That is done.',
    detail: 'Every signed-in device has been signed out.',
    action: { href: '/signin', label: 'SIGN IN' }
  });
});

// ── "THIS WASN'T ME" (§5) ────────────────────────────────
router.get('/security/not-me', async (req, res) => {
  const row = T.consume(req.query.token, 'not_me');
  if (!row) {
    return screen(res.status(400), 'message', {
      title: 'Link expired',
      heading: 'That link has expired.',
      detail: 'If you are worried about the account, reset the password.',
      action: { href: '/reset', label: 'RESET PASSWORD' }
    });
  }

  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  const token = tx(() => {
    // Revoking sessions alone lets someone who knows the compromised
    // password sign straight back in. Require a new password first.
    run('UPDATE users SET password_hash = NULL WHERE id = ?', row.user_id);
    S.revokeAll(row.user_id);
    for (const purpose of ['reset', 'login_link', 'email_change', 'verify']) T.invalidate(row.user_id, purpose);
    return T.issue(row.user_id, 'reset');
  });
  await mail.reset(user.email, token);

  audit.record({ actorType: 'user', actorId: user.public_id, action: 'auth.not_me',
                 targetUserId: user.id, ip: req.ip });

  res.clearCookie(S.COOKIE, { path: '/' });
  res.redirect(`/reset/${token}`);
});

export default router;
