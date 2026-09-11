import { get } from '../../db/index.js';
import * as S from './sessions.js';
import { isEnabled as totpEnabled } from './totp.js';
import { touchSeen } from '../accounts.js';
import { viewerOf, ANONYMOUS } from '../visibility.js';

// ── The session, resolved once per request ───────────────
//
// Everything downstream reads `req.user` and `req.viewer`. Nothing downstream
// reads a user id out of a parameter, a body, or a header — §13.4 is explicit
// that the id must come from the session, and the only way to keep that true
// across a whole codebase is for there to be exactly one place it is derived.

export function attach(req, res, next) {
  req.session = null;
  req.user = null;
  req.viewer = ANONYMOUS;

  const token = req.cookies?.[S.COOKIE];
  const session = token ? S.resolve(token) : null;

  if (session) {
    const user = get(
      'SELECT * FROM users WHERE id = ? AND is_tombstone = 0',
      session.user_id
    );

    if (user) {
      // §12 — signing in during the grace period cancels a scheduled
      // deletion. The account comes back rather than staying half-dead.
      if (user.deleted_at) {
        const { run } = req.app.locals.db;
        run(`UPDATE users SET deleted_at = NULL, purge_after = NULL, deactivated_at = NULL WHERE id = ?`, user.id);
        user.deleted_at = null;
      }

      req.session = session;
      req.user = user;
      req.viewer = viewerOf(req);
      touchSeen(user.id);
    }
  }

  res.locals.user = req.user;
  res.locals.signedIn = !!req.user;
  res.locals.settings = req.user?.settings ? safeSettings(req.user.settings) : {};
  next();
}

const safeSettings = (raw) => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { return {}; }
};

// ── Gates ────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.accepts('html')) {
    // Coming back to where they were going is the difference between a login
    // wall and a login interruption.
    const back = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/signin?next=${back}`);
  }
  return res.status(401).json({ error: 'Sign in required' });
}

/** §4 — an unverified account works privately but cannot act outward. */
export function requireVerified(req, res, next) {
  if (req.user?.email_verified_at) return next();
  if (req.accepts('html')) return res.redirect('/verify/pending');
  return res.status(403).json({ error: 'Verify your email address first' });
}

/**
 * §6 — step-up. Required before changing a password or email, disabling 2FA,
 * removing a passkey, generating a token, exporting, or deleting.
 *
 * A factor from five minutes ago is fresh; the one from this morning's login
 * is not, because the threat is an unattended session, not a stolen password.
 */
export function requireFresh(req, res, next) {
  if (S.isFresh(req.session) && (!totpEnabled(req.user?.id) || req.session?.aal >= 2)) return next();
  const back = encodeURIComponent(req.originalUrl || '/settings');
  if (req.accepts('html')) return res.redirect(`/reauth?next=${back}`);
  return res.status(403).json({ error: 'Re-authentication required' });
}

/** §6 — AAL2: a second factor was actually presented for this session. */
export function requireAAL2(req, res, next) {
  if ((req.session?.aal || 1) >= 2) return next();
  return res.status(403).json({ error: 'Two-factor required' });
}
