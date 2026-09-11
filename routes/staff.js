import { Router } from '../lib/router.js';
import { randomUUID } from 'node:crypto';
import { get, all, run, sqlTime, nowSQL, parseSQLTime } from '../db/index.js';
import * as P from '../lib/auth/passwords.js';
import * as TOTP from '../lib/auth/totp.js';
import * as RL from '../lib/auth/ratelimit.js';
import * as audit from '../lib/audit.js';
import { newToken, hashToken, hashIP, seal, open } from '../lib/crypto.js';
import { buildExport } from '../lib/export.js';
import { addressAllowlist } from '../lib/network.js';

const router = Router();

// ── §14 — admin tooling and audit ────────────────────────
//
// "This section exists because this is how Letterboxd was actually breached.
// Build it before building any staff tool at all."
//
// A staff account was compromised, and staff tooling included a per-member
// data export. It was used against members, and afterwards Letterboxd could
// not say whose data had been read. Everything below is shaped by that one
// fact — the attack surface was internal tooling, not the login form.
//
// The bar, quoted from §14: "if a staff account is compromised tomorrow, can
// we produce an exact list of affected members within an hour?"

const COOKIE = 'margin_staff';
const SESSION_HOURS = 8;
const REAUTH_WINDOW_MS = 5 * 60_000;

const parseTime = parseSQLTime;

// ── The network gate ─────────────────────────────────────
// §14 — "IP allowlist or a VPN/mesh requirement for the admin surface. It
// should not be reachable from the open internet."
//
// This runs before authentication, so an attacker holding valid staff
// credentials still cannot reach the login form from the wrong network.
const ALLOWED = (process.env.MARGIN_STAFF_ALLOWLIST || (process.env.NODE_ENV === 'production' ? '' : '127.0.0.1,::1'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const allowedAddress = addressAllowlist(ALLOWED);

router.use((req, res, next) => {
  const ip = req.ip || '';
  const ok = allowedAddress(ip);
  if (!ok) {
    audit.record({
      actorType: 'system', action: 'admin.blocked.network', ip: req.ip,
      userAgent: req.get('user-agent'), metadata: { path: req.path }
    });
    // 404, not 403: the admin surface does not confirm it exists.
    return res.status(404).render('404', { title: 'Not found' });
  }
  next();
});

// ── Session ──────────────────────────────────────────────
router.use((req, res, next) => {
  req.staff = null;
  req.staffSession = null;

  const token = req.cookies?.[COOKIE];
  if (!token) return next();

  const row = get(
    `SELECT ss.*, s.email, s.role, s.display_name, s.disabled_at
       FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
      WHERE ss.token_hash = ? AND ss.revoked_at IS NULL`,
    hashToken(token)
  );

  if (row && !row.disabled_at && parseTime(row.expires_at) > Date.now()) {
    req.staffSession = row;
    req.staff = { id: row.staff_id, email: row.email, role: row.role, display_name: row.display_name };
  }
  next();
});

const requireStaff = (req, res, next) => {
  if (!req.staff) return res.redirect('/staff/signin');
  next();
};

// §14 — "step-up re-auth for every data-reading action, not once per
// session." A staff session going unattended is the threat model.
const requireStaffFresh = (req, res, next) => {
  const fresh = req.staffSession?.reauth_at &&
    Date.now() - parseTime(req.staffSession.reauth_at) < REAUTH_WINDOW_MS;
  if (fresh) return next();
  return res.redirect(`/staff/reauth?next=${encodeURIComponent(req.originalUrl)}`);
};

// §14 — least privilege by role.
const requireRole = (...roles) => (req, res, next) => {
  if (roles.includes(req.staff?.role)) return next();
  audit.record({
    actorType: 'staff', actorId: req.staff.id, action: 'admin.denied',
    ip: req.ip, metadata: { path: req.path, role: req.staff.role }
  });
  return res.status(403).render('error', {
    title: 'Not permitted', heading: 'Not permitted.',
    detail: 'That action needs a role this account does not have.'
  });
};

// ── Sign in ──────────────────────────────────────────────
router.get('/signin', (req, res) =>
  res.render('staff/signin', { title: 'Staff', error: null, stage: 'password' })
);

router.post('/signin', async (req, res) => {
  const fail = (error, stage = 'password') =>
    res.status(401).render('staff/signin', { title: 'Staff', error, stage });

  if (!RL.check('ipAuth', `staff:${req.ip}`).ok) return fail('Too many attempts.');

  const email = String(req.body.email || '').trim().toLowerCase();
  const staff = get('SELECT * FROM staff WHERE email = ? AND disabled_at IS NULL', email);

  if (!staff) { await P.dummyVerify(req.body.password); return fail("Those details don't match."); }

  if (!(await P.verifyPassword(req.body.password, staff.password_hash))) {
    audit.record({ actorType: 'staff', actorId: staff.id, action: 'admin.login.failed', ip: req.ip });
    return fail("Those details don't match.");
  }

  // §14 — "2FA is mandatory for staff, no opt-out." An account without it
  // enrolled cannot sign in at all, rather than being nagged later.
  if (!staff.totp_secret) {
    return fail('This account has no second factor enrolled. It cannot be used until it does.');
  }

  const secret = open(staff.totp_secret);
  const step = TOTP.stepOfCode(secret, req.body.code);
  if (step == null || (staff.totp_last_step != null && step <= staff.totp_last_step)) {
    audit.record({ actorType: 'staff', actorId: staff.id, action: 'admin.login.failed_2fa', ip: req.ip });
    return fail(req.body.code ? 'That code is wrong, or already used.' : null, 'code');
  }
  run('UPDATE staff SET totp_last_step = ? WHERE id = ?', step, staff.id);

  const token = newToken();
  run(
    `INSERT INTO staff_sessions (id, staff_id, token_hash, ip_hash, expires_at, reauth_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(), staff.id, hashToken(token), hashIP(req.ip),
    sqlTime(Date.now() + SESSION_HOURS * 3600_000),
    nowSQL()
  );

  res.cookie(COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/staff', maxAge: SESSION_HOURS * 3600_000
  });

  audit.record({ actorType: 'staff', actorId: staff.id, action: 'admin.login', ip: req.ip,
                 userAgent: req.get('user-agent') });
  res.redirect('/staff');
});

router.get('/reauth', requireStaff, (req, res) =>
  res.render('staff/reauth', { title: 'Confirm', error: null, next: req.query.next || '/staff' })
);

router.post('/reauth', requireStaff, async (req, res) => {
  if (!RL.check('ipAuth', `staff-stepup:${req.ip}`).ok) return res.status(429).send('Try again later.');
  const staff = get('SELECT * FROM staff WHERE id = ?', req.staff.id);
  const ok = await P.verifyPassword(req.body.password, staff.password_hash);
  const step = ok ? TOTP.stepOfCode(open(staff.totp_secret), req.body.code) : null;

  if (!ok || step == null || (staff.totp_last_step != null && step <= staff.totp_last_step)) {
    return res.status(401).render('staff/reauth', {
      title: 'Confirm', error: "Those details don't match.",
      next: req.body.next || '/staff'
    });
  }

  run('UPDATE staff SET totp_last_step = ? WHERE id = ?', step, staff.id);
  run(`UPDATE staff_sessions SET reauth_at = ? WHERE id = ?`,
      nowSQL(), req.staffSession.id);
  res.redirect(String(req.body.next || '/staff').startsWith('/staff') ? req.body.next : '/staff');
});

router.post('/signout', requireStaff, (req, res) => {
  run(`UPDATE staff_sessions SET revoked_at = datetime('now') WHERE id = ?`, req.staffSession.id);
  res.clearCookie(COOKIE, { path: '/staff' });
  res.redirect('/staff/signin');
});

// ── The console ──────────────────────────────────────────
router.get('/', requireStaff, (req, res) =>
  res.render('staff/index', {
    title: 'Staff',
    staff: req.staff,
    anomalies: audit.anomalies(),
    pending: all(
      `SELECT sa.*, s.email AS requester FROM staff_approvals sa
         JOIN staff s ON s.id = sa.requested_by
        WHERE sa.approved_at IS NULL AND sa.consumed_at IS NULL
          AND sa.expires_at > datetime('now')
        ORDER BY sa.created_at DESC`
    ),
    reports: all(`SELECT COUNT(*) n FROM reports WHERE state = 'open'`)[0].n
  })
);

// ── Member lookup (§14, least privilege) ─────────────────
//
// "Most support work needs: does this account exist, is it verified, when
// did it last log in, what's its subscription state. It does NOT need note
// bodies, private shelf contents, or a full export."
//
// So this is the ONLY member-facing read most staff can do, and the exact
// list of fields it returns is both hard-coded and written to the audit log.
const LOOKUP_FIELDS = [
  'public_id', 'username', 'email_masked', 'email_verified_at',
  'created_at', 'last_seen_at', 'profile_visibility', 'deactivated_at',
  'deleted_at', 'books_logged'
];

router.get('/member', requireStaff, requireStaffFresh, (req, res) => {
  const q = String(req.query.q || '').trim();
  const reason = String(req.query.reason || '').trim();

  if (!q) return res.render('staff/member', { title: 'Member', member: null, q: '', reason, error: null });

  // §14 — a reason string is required. Not a dropdown: a sentence somebody
  // has to write, and that is later readable next to what they looked at.
  if (reason.length < 8) {
    return res.render('staff/member', {
      title: 'Member', member: null, q, reason,
      error: 'A written reason is required before member data is shown.'
    });
  }

  const user = q.includes('@')
    ? get('SELECT * FROM users WHERE email = ? AND is_tombstone = 0', q.toLowerCase())
    : get('SELECT * FROM users WHERE username = ? AND is_tombstone = 0', q.toLowerCase());

  if (!user) {
    audit.record({
      actorType: 'staff', actorId: req.staff.id, action: 'admin.user.lookup.miss',
      reason, ip: req.ip, userAgent: req.get('user-agent'), metadata: { query: q.includes('@') ? 'email' : 'username' }
    });
    return res.render('staff/member', { title: 'Member', member: null, q, reason, error: 'No such account.' });
  }

  // The audit row is written BEFORE the data is rendered. If the render
  // throws, the read still happened and the log still says so.
  audit.staffRead({
    staff: req.staff, targetUserId: user.id, fields: LOOKUP_FIELDS,
    reason, ip: req.ip, userAgent: req.get('user-agent'), action: 'admin.user.lookup'
  });

  res.render('staff/member', {
    title: 'Member', q, reason, error: null,
    member: {
      public_id: user.public_id,
      username: user.username,
      // §16 — never a full address, even to staff. The domain is what
      // support actually needs; the local part identifies a person.
      email_masked: maskEmail(user.email),
      email_verified_at: user.email_verified_at,
      created_at: user.created_at,
      last_seen_at: user.last_seen_at,
      profile_visibility: user.profile_visibility,
      deactivated_at: user.deactivated_at,
      deleted_at: user.deleted_at,
      books_logged: user.books_logged,
      // §11 — notes are excluded from staff tooling by default, and there is
      // no gated view of them here at all. "Most support cases never need to
      // read someone's diary" — so the tool cannot.
      notes: 'excluded'
    }
  });
});

const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '(none)';
  return `${local.slice(0, 2)}${'·'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};

// ── The crown jewel (§14) ────────────────────────────────
//
// "The bulk-export-a-member's-data tool is the crown jewel. Gate it behind a
// second staff member's approval, cap it at a low rate, and alert on every
// use."
//
// This is the exact tool that was used against Letterboxd's members. It is
// therefore a two-person operation: one requests with a reason, a DIFFERENT
// staff member approves, and only then can it run once before expiring.

router.post('/export/request', requireStaff, requireStaffFresh, requireRole('trust', 'admin'), (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 20) {
    return res.status(400).render('error', {
      title: 'Reason required', heading: 'That reason is too short.',
      detail: 'A member export is logged and reviewed. Say plainly why it is needed.'
    });
  }

  const user = get('SELECT id FROM users WHERE username = ? AND is_tombstone = 0',
                   String(req.body.username || '').toLowerCase());
  if (!user) return res.status(404).render('404', { title: 'Not found' });

  const id = randomUUID();
  run(
    `INSERT INTO staff_approvals (id, requested_by, action, target_user_id, reason, expires_at)
     VALUES (?, ?, 'admin.user.export', ?, ?, ?)`,
    id, req.staff.id, user.id, reason, sqlTime(Date.now() + 24 * 3600_000)
  );

  audit.record({
    actorType: 'staff', actorId: req.staff.id, action: 'admin.user.export.requested',
    targetUserId: user.id, reason, ip: req.ip, fields: ['(pending approval)']
  });

  res.redirect('/staff');
});

router.post('/export/:id/approve', requireStaff, requireStaffFresh, requireRole('trust', 'admin'), (req, res) => {
  const approval = get(
    `SELECT * FROM staff_approvals WHERE id = ? AND approved_at IS NULL
       AND consumed_at IS NULL AND expires_at > datetime('now')`,
    req.params.id
  );
  if (!approval) return res.status(404).render('404', { title: 'Not found' });

  // The whole point of two-person control. Self-approval would make it one.
  if (approval.requested_by === req.staff.id) {
    return res.status(403).render('error', {
      title: 'Not permitted', heading: 'You cannot approve your own request.',
      detail: 'A member export needs a second person. That is the control.'
    });
  }

  run(`UPDATE staff_approvals SET approved_by = ?, approved_at = datetime('now') WHERE id = ?`,
      req.staff.id, approval.id);
  audit.record({
    actorType: 'staff', actorId: req.staff.id, action: 'admin.user.export.approved',
    targetUserId: approval.target_user_id, reason: approval.reason, ip: req.ip
  });

  res.redirect('/staff');
});

router.post('/export/:id/run', requireStaff, requireStaffFresh, requireRole('trust', 'admin'), (req, res) => {
  const approval = get(
    `SELECT * FROM staff_approvals WHERE id = ? AND approved_at IS NOT NULL
       AND consumed_at IS NULL AND expires_at > datetime('now')`,
    req.params.id
  );
  if (!approval) return res.status(404).render('404', { title: 'Not found' });

  run(`UPDATE staff_approvals SET consumed_at = datetime('now') WHERE id = ?`, approval.id);

  const { archive, counts } = buildExport(approval.target_user_id);

  // §14 — "alert on every use." Not a metric to be noticed later.
  console.warn(
    `  ALERT — admin.user.export by ${req.staff.email} on user ${approval.target_user_id}: ${approval.reason}`
  );

  audit.record({
    actorType: 'staff', actorId: req.staff.id, action: 'admin.user.export',
    targetUserId: approval.target_user_id, reason: approval.reason,
    ip: req.ip, userAgent: req.get('user-agent'),
    // The exact fields that left the system, which is what makes the §14
    // question answerable a year later.
    fields: ['books', 'shelves', 'sessions', 'notes', 'ratings', 'dates', 'account'],
    metadata: { ...counts, approved_by: approval.approved_by }
  });

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="member-${approval.target_user_id}.zip"`);
  res.send(archive);
});

// ── The §14 question, as a route ─────────────────────────
// "Given a compromised staff account and a time window, a single query
// returns the exact list of affected members."
router.get('/incident', requireStaff, requireRole('admin'), (req, res) => {
  const staffId = String(req.query.staff || '');
  const since = String(req.query.since || sqlTime(Date.now() - 7 * 86_400_000));

  res.render('staff/incident', {
    title: 'Incident',
    staffId, since,
    accounts: all('SELECT id, email FROM staff ORDER BY email'),
    affected: staffId ? audit.affectedBy(staffId, { since }) : null
  });
});

// ── Abuse reports (§15) ──────────────────────────────────
router.get('/reports', requireStaff, (req, res) =>
  res.render('staff/reports', {
    title: 'Reports',
    reports: all(
      `SELECT r.*, u.username AS target_username
         FROM reports r LEFT JOIN users u ON u.id = r.target_user_id
        WHERE r.state = 'open' ORDER BY r.created_at`
    )
  })
);

router.post('/reports/:id/:action', requireStaff, requireRole('trust', 'admin'), (req, res) => {
  const state = req.params.action === 'action' ? 'actioned' : 'dismissed';
  run(
    `UPDATE reports SET state = ?, resolved_at = datetime('now'), resolved_by = ?
      WHERE id = ? AND state = 'open'`,
    state, req.staff.id, req.params.id
  );
  audit.record({
    actorType: 'staff', actorId: req.staff.id, action: `admin.report.${state}`,
    ip: req.ip, metadata: { report: req.params.id }
  });
  res.redirect('/staff/reports');
});

export default router;
