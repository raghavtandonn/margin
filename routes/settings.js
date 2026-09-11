import { Router } from '../lib/router.js';
import { get, all, run } from '../db/index.js';
import * as A from '../lib/accounts.js';
import * as P from '../lib/auth/passwords.js';
import * as S from '../lib/auth/sessions.js';
import * as T from '../lib/auth/tokens.js';
import * as TOTP from '../lib/auth/totp.js';
import * as WA from '../lib/auth/webauthn.js';
import * as RL from '../lib/auth/ratelimit.js';
import * as V from '../lib/visibility.js';
import * as EX from '../lib/export.js';
import * as PURGE from '../lib/purge.js';
import * as AV from '../lib/avatars.js';
import * as audit from '../lib/audit.js';
import * as SAFE from '../lib/safety.js';
import { mail } from '../lib/mailer.js';
import { requireAuth, requireVerified, requireFresh } from '../lib/auth/middleware.js';
import * as IMPORT from '../lib/import.js';
import * as GX from '../lib/goodreads-export.js';
import * as SUP from '../lib/supplement.js';
import { runImport } from '../lib/import-run.js';
import { boundaryOf, readBody, firstFile, fields as multipartFields } from '../lib/multipart.js';
import { randomUUID } from 'node:crypto';

const router = Router();

router.use('/settings', requireAuth);

const settingsOf = (user) => {
  try { return typeof user.settings === 'string' ? JSON.parse(user.settings) : (user.settings || {}); }
  catch { return {}; }
};

const flash = (res, view, opts) =>
  res.render(`settings/${view}`, { error: null, notice: null, ...opts });

// ── ACCOUNT ──────────────────────────────────────────────
router.get('/settings', (req, res) =>
  flash(res, 'index', {
    title: 'Settings',
    totp: TOTP.isEnabled(req.user.id),
    passkeys: WA.credentialsFor(req.user.id).length,
    recovery: TOTP.recoveryCodesRemaining(req.user.id),
    sessionCount: S.list(req.user.id, req.session?.id).length,
    paused: SAFE.isPaused(req.user.id),
    // §3 — pending follow requests, and §11 — reports the reader filed, both
    // need a way back to them from here. A report you cannot find the
    // outcome of is the same as one nobody read.
    pendingRequests: get(
      `SELECT COUNT(*) n FROM user_follows WHERE followee_id = ? AND state = 'requested'`,
      req.user.id
    ).n,
    openReports: get(
      `SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND resolved_at IS NULL`,
      req.user.id
    ).n,
    blockedCount: get('SELECT COUNT(*) n FROM blocks WHERE blocker_id = ?', req.user.id).n,
    notice: req.query.done || null
  })
);

// ── PROFILE (§9) ─────────────────────────────────────────
router.get('/settings/profile', (req, res) =>
  flash(res, 'profile', { title: 'Profile', values: req.user, bioMax: A.BIO_MAX })
);

router.post('/settings/profile', (req, res) => {
  const user = A.updateProfile(req.user.id, {
    displayName: req.body.display_name,
    bio: req.body.bio,
    location: req.body.location,
    link: req.body.link
  });
  audit.userAction(req, 'account.profile.updated', { fields: ['display_name', 'bio', 'location', 'link'] });
  flash(res, 'profile', { title: 'Profile', values: user, bioMax: A.BIO_MAX, notice: 'Saved.' });
});

router.post('/settings/username', (req, res) => {
  const result = A.setUsername(req.user.id, req.body.username);
  const values = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!result.ok) {
    return flash(res.status(400), 'profile', {
      title: 'Profile', values, bioMax: A.BIO_MAX, error: result.error
    });
  }
  audit.userAction(req, 'account.username.changed', { fields: ['username'] });
  flash(res, 'profile', { title: 'Profile', values, bioMax: A.BIO_MAX, notice: 'Saved.' });
});

// ── AVATAR (§9) ──────────────────────────────────────────
router.post('/settings/avatar', requireVerified, async (req, res) => {
  const boundary = boundaryOf(req.get('content-type'));
  if (!boundary) return res.status(400).json({ error: 'Expected a file upload.' });

  let body;
  try {
    body = await readBody(req, AV.MAX_BYTES);
  } catch (err) {
    if (err.tooLarge) return res.status(413).json({ error: 'Images are at most 5 MB.' });
    return res.status(400).json({ error: 'That upload did not complete.' });
  }

  const file = firstFile(body, boundary);
  if (!file) return res.status(400).json({ error: 'No file was uploaded.' });

  const result = await AV.processAvatar(file.data);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const previous = req.user.avatar_key;
  run(`UPDATE users SET avatar_key = ?, updated_at = datetime('now') WHERE id = ?`,
      result.key, req.user.id);
  if (previous) AV.removeAvatar(previous);

  audit.userAction(req, 'account.avatar.updated', { fields: ['avatar_key'] });
  res.json({ ok: true, url: `/avatar/${result.key}/256` });
});

router.post('/settings/avatar/remove', (req, res) => {
  if (req.user.avatar_key) {
    AV.removeAvatar(req.user.avatar_key);
    run(`UPDATE users SET avatar_key = NULL WHERE id = ?`, req.user.id);
    audit.userAction(req, 'account.avatar.removed', { fields: ['avatar_key'] });
  }
  res.redirect('/settings/profile');
});

// Served from outside the static root, with a pinned content type and a
// sandbox policy of its own. See lib/avatars.js AVATAR_HEADERS.
router.get('/avatar/:key/:size', (req, res) => {
  const file = AV.avatarFile(req.params.key, req.params.size);
  res.set(AV.AVATAR_HEADERS);
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// ── PRIVACY (§10) ────────────────────────────────────────
router.get('/settings/privacy', (req, res) =>
  flash(res, 'privacy', {
    title: 'Privacy',
    values: { ...req.user, local_only: settingsOf(req.user).local_only !== false },
    shelves: all(
      `SELECT id, name, slug, visibility,
              (SELECT COUNT(*) FROM shelf_items si WHERE si.shelf_id = shelves.id) AS n
         FROM shelves WHERE user_id = ? ORDER BY is_system DESC, name`,
      req.user.id
    ),
    canPublic: V.canGoPublic(req.user)
  })
);

router.post('/settings/privacy', (req, res) => {
  const wanted = String(req.body.profile_visibility || 'private');
  if (!V.VISIBILITIES.includes(wanted)) return res.status(400).end();

  // §4 and §15 — the gate on becoming public lives on the write path, so no
  // read path has to re-derive it and none of them can disagree.
  if (wanted === 'public') {
    const gate = V.canGoPublic(req.user);
    if (!gate.ok) {
      return flash(res.status(403), 'privacy', {
        title: 'Privacy', values: req.user, canPublic: gate, error: gate.reason,
        shelves: all(`SELECT id, name, slug, visibility, 0 AS n FROM shelves WHERE user_id = ?`, req.user.id)
      });
    }
  }

  const indexable = wanted === 'public' && req.body.search_indexable === 'on' ? 1 : 0;

  // Local-only defaults to ON, so an unchecked box means "off" only when
  // the form that could have checked it was actually submitted.
  const settings = { ...settingsOf(req.user), local_only: req.body.local_only === 'on' };

  run(
    `UPDATE users SET profile_visibility = ?, search_indexable = ?, settings = ?,
                      deadstock_visible = ?, taste_public = ?, updated_at = datetime('now')
      WHERE id = ?`,
    wanted, indexable, JSON.stringify(settings),
    req.body.deadstock === '1' ? 1 : 0,
    // Opt in, and off unless the box was ticked on the form that could tick
    // it. The taste analysis is derived from every rating this reader has
    // ever given; turning that outward is their decision to make.
    req.body.taste_public === 'on' ? 1 : 0,
    req.user.id
  );

  audit.userAction(req, 'account.privacy.updated', {
    fields: ['profile_visibility', 'search_indexable'],
    metadata: { profile_visibility: wanted, search_indexable: !!indexable }
  });

  res.redirect('/settings/privacy');
});

router.post('/settings/privacy/shelf/:id', (req, res) => {
  const wanted = String(req.body.visibility || 'inherit');
  if (!V.ENTRY_VISIBILITIES.includes(wanted)) return res.status(400).end();

  // §13.4 — the ownership predicate is in the UPDATE itself. A shelf id from
  // the URL never selects a row that is not this session's.
  const changed = run(
    'UPDATE shelves SET visibility = ? WHERE id = ? AND user_id = ?',
    wanted, req.params.id, req.user.id
  ).changes;

  if (!changed) return res.status(404).render('404', { title: 'Not found' });

  audit.userAction(req, 'shelf.visibility.updated', {
    fields: ['visibility'], metadata: { shelf: req.params.id, visibility: wanted }
  });
  res.redirect('/settings/privacy');
});

// ── PASSWORD (§8) ────────────────────────────────────────
router.get('/settings/password', requireFresh, (req, res) =>
  flash(res, 'password', { title: 'Password' })
);

router.post('/settings/password', requireFresh, async (req, res) => {
  const pw = await P.checkPassword(req.body.password, {
    email: req.user.email, username: req.user.username
  });
  if (!pw.ok) return flash(res.status(400), 'password', { title: 'Password', error: pw.error });

  run(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      await P.hashPassword(req.body.password), req.user.id);

  // §7 — revoke every OTHER session, and rotate this one. Someone changing a
  // password usually means to end whatever else is signed in.
  const revoked = S.revokeAll(req.user.id, { except: req.session.id });
  T.invalidate(req.user.id, 'login_link');
  T.invalidate(req.user.id, 'email_change');
  const { token } = S.rotate(req.session, {
    ip: req.ip, userAgent: req.get('user-agent'), reauth: true
  });
  res.cookie(S.COOKIE, token, S.cookieOptions());

  await mail.passwordChanged(req.user.email);
  audit.userAction(req, 'account.password.changed', {
    fields: ['password_hash'], metadata: { sessions_revoked: revoked }
  });

  res.redirect('/settings?done=Password+changed.');
});

// ── EMAIL (§8) ───────────────────────────────────────────
router.get('/settings/email', requireFresh, (req, res) =>
  flash(res, 'email', { title: 'Email', values: req.user })
);

router.post('/settings/email', requireFresh, async (req, res) => {
  const e = A.validateEmail(req.body.email);
  if (!e.ok) {
    return flash(res.status(400), 'email', { title: 'Email', values: req.user, error: e.error });
  }
  if (e.email === req.user.email) {
    return flash(res, 'email', { title: 'Email', values: req.user, notice: 'That is already the address.' });
  }

  // Taken addresses are not reported as taken — that would make this form an
  // account oracle exactly as the signup form would be (§5).
  if (!A.findByEmail(e.email)) {
    T.invalidate(req.user.id, 'email_change');
    const changeToken = T.issue(req.user.id, 'email_change', { newEmail: e.email });
    const revokeToken = T.issue(req.user.id, 'revoke_email_change', { oldEmail: req.user.email });

    // §8 — the new address gets the confirmation, and the OLD address gets a
    // notice with a revoke link. The second one is what catches a takeover
    // in progress.
    await mail.emailChange(e.email, changeToken);
    await mail.emailChangeNotice(req.user.email, e.email, revokeToken);

    audit.userAction(req, 'account.email.change_requested', { fields: ['email'] });
  }

  flash(res, 'email', {
    title: 'Email', values: req.user,
    notice: 'Check the new address for a confirmation link.'
  });
});

router.get('/settings/email/confirm', (req, res) => {
  const row = T.consume(req.query.token, 'email_change');
  if (!row?.new_email) {
    return res.status(400).render('error', {
      title: 'Link expired', heading: 'That link has expired.',
      detail: 'Email change links last 24 hours. Start again from settings.'
    });
  }

  // The address may have been claimed while the link sat in an inbox.
  if (A.findByEmail(row.new_email)) {
    return res.status(409).render('error', {
      title: 'Unavailable', heading: 'That address is no longer available.',
      detail: 'Nothing was changed.'
    });
  }

  run(
    `UPDATE users SET email = ?, email_hash = NULL, email_verified_at = datetime('now'),
                      updated_at = datetime('now')
      WHERE id = ?`,
    row.new_email, row.user_id
  );
  audit.record({ actorType: 'user', actorId: row.user_id, action: 'account.email.changed',
                 targetUserId: row.user_id, fields: ['email'], ip: req.ip });

  res.render('error', {
    title: 'Address changed', heading: 'That is done.',
    detail: 'The account now uses the new address.'
  });
});

// §8 — the 72-hour undo, sent to the old address.
router.get('/settings/email/revoke', async (req, res) => {
  const row = T.consume(req.query.token, 'revoke_email_change');
  if (!row) {
    return res.status(400).render('error', {
      title: 'Link expired', heading: 'That link has expired.',
      detail: 'If you are worried about the account, reset the password.'
    });
  }

  T.invalidate(row.user_id, 'email_change');
  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);

  // Restore the old address if the change already went through, then treat
  // it as a compromise: every session out, password reset forced.
  if (row.old_email && user && user.email !== row.old_email) {
    run(`UPDATE users SET email = ? WHERE id = ?`, row.old_email, row.user_id);
  }
  S.revokeAll(row.user_id);
  const resetToken = T.issue(row.user_id, 'reset');
  await mail.reset(row.old_email || user.email, resetToken);

  audit.record({ actorType: 'user', actorId: row.user_id, action: 'account.email.change_revoked',
                 targetUserId: row.user_id, ip: req.ip });

  res.clearCookie(S.COOKIE, { path: '/' });
  res.redirect(`/reset/${resetToken}`);
});

// ── SESSIONS (§7) ────────────────────────────────────────
router.get('/settings/sessions', (req, res) =>
  flash(res, 'sessions', {
    title: 'Signed in',
    sessions: S.list(req.user.id, req.session?.id)
  })
);

router.post('/settings/sessions/:id/revoke', (req, res) => {
  // Scoped to this user's sessions: an id alone must not revoke a stranger's.
  const owned = get(
    'SELECT id FROM auth_sessions WHERE id = ? AND user_id = ?',
    req.params.id, req.user.id
  );
  if (!owned) return res.status(404).render('404', { title: 'Not found' });

  S.revoke(owned.id);
  audit.userAction(req, 'auth.session.revoked', { metadata: { session: owned.id } });

  if (owned.id === req.session?.id) {
    res.clearCookie(S.COOKIE, { path: '/' });
    return res.redirect('/signin');
  }
  res.redirect('/settings/sessions');
});

router.post('/settings/sessions/revoke-all', (req, res) => {
  const n = S.revokeAll(req.user.id, { except: req.session.id });
  audit.userAction(req, 'auth.sessions.revoked_all', { metadata: { count: n } });
  res.redirect('/settings/sessions');
});

// ── SECURITY: 2FA and passkeys (§6) ──────────────────────
router.get('/settings/security', (req, res) =>
  flash(res, 'security', {
    title: 'Security',
    totp: TOTP.isEnabled(req.user.id),
    recovery: TOTP.recoveryCodesRemaining(req.user.id),
    passkeys: WA.credentialsFor(req.user.id),
    fresh: S.isFresh(req.session),
    codes: null
  })
);

router.get('/settings/security/totp', requireFresh, requireVerified, (req, res) => {
  const enrollment = TOTP.beginEnrollment(req.user);
  // The secret is rendered once, into a form field, and never stored until
  // a valid code proves the authenticator actually has it.
  flash(res, 'totp-setup', {
    title: 'Two-factor',
    secret: enrollment.secret,
    uri: enrollment.uri
  });
});

router.post('/settings/security/totp', requireFresh, requireVerified, async (req, res) => {
  const secret = String(req.body.secret || '');
  const result = TOTP.confirmEnrollment(req.user.id, secret, req.body.code);

  if (!result.ok) {
    return flash(res.status(400), 'totp-setup', {
      title: 'Two-factor', secret,
      uri: TOTP.beginEnrollment(req.user).uri.replace(/secret=[^&]+/, `secret=${secret}`),
      error: result.error
    });
  }

  // §6 — ten codes, generated at enrollment, shown once.
  const codes = await TOTP.generateRecoveryCodes(req.user.id);

  S.setAAL(req.session.id, 2);
  const { token } = S.rotate(req.session, { ip: req.ip, userAgent: req.get('user-agent'), aal: 2 });
  res.cookie(S.COOKIE, token, S.cookieOptions());

  audit.userAction(req, 'account.totp.enabled');

  flash(res, 'recovery-codes', { title: 'Recovery codes', codes, first: true });
});

router.post('/settings/security/totp/disable', requireFresh, (req, res) => {
  TOTP.disable(req.user.id);
  run('DELETE FROM recovery_codes WHERE user_id = ?', req.user.id);
  S.setAAL(req.session.id, 1);
  const { token } = S.rotate(req.session, { ip: req.ip, userAgent: req.get('user-agent'), aal: 1 });
  res.cookie(S.COOKIE, token, S.cookieOptions());
  audit.userAction(req, 'account.totp.disabled');
  res.redirect('/settings/security');
});

router.post('/settings/security/recovery', requireFresh, async (req, res) => {
  const codes = await TOTP.generateRecoveryCodes(req.user.id);
  audit.userAction(req, 'account.recovery_codes.regenerated');
  flash(res, 'recovery-codes', { title: 'Recovery codes', codes, first: false });
});

// ── Passkeys ─────────────────────────────────────────────
router.post('/settings/security/passkey/options', requireFresh, requireVerified, async (req, res) => {
  const { options, challengeId } = await WA.beginRegistration(req.user);
  res.json({ options, challengeId });
});

router.post('/settings/security/passkey', requireFresh, requireVerified, async (req, res) => {
  const result = await WA.finishRegistration(req.user, {
    challengeId: req.body.challengeId,
    response: req.body.response,
    nickname: req.body.nickname
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Enrollment changes account access, but is not a login.
  const { token } = S.rotate(req.session, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(S.COOKIE, token, S.cookieOptions());
  audit.userAction(req, 'account.passkey.added');
  res.json({ ok: true });
});

router.post('/settings/security/passkey/:id/remove', requireFresh, (req, res) => {
  WA.removeCredential(req.user.id, req.params.id);
  audit.userAction(req, 'account.passkey.removed');
  res.redirect('/settings/security');
});

// ── IMPORT (§12) ─────────────────────────────────────────
//
// Three states on one page: a drop zone, a preview, and a result. The
// preview is not optional — §12: "Show a preview and a confirm step before
// writing. Never silently merge into an existing library."
//
// The jobs are held in memory alongside their database row, because the
// parsed rows are somebody's whole library and there is no reason to write
// them to disk twice before they have said yes.
const parsedJobs = new Map();
let importsInFlight = 0;
setInterval(() => {
  for (const [id, job] of parsedJobs) {
    if (job.state !== 'running' && Date.now() - job.createdAt > 20 * 60_000) parsedJobs.delete(id);
  }
}, 60_000).unref();

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;   // §12 — 50 MB, 50,000 rows

/**
 * A zipped or JSON upload, which the CSV parser has no business seeing.
 *
 * Sniffed from the bytes and not from the extension: a browser that
 * helpfully unzips a download leaves review.json with the wrong name about
 * as often as it leaves it with the right one.
 */
const looksLikeDataExport = (file) => {
  const d = file.data;
  if (d.length > 4 && d[0] === 0x50 && d[1] === 0x4b) return true;      // PK
  const head = d.subarray(0, 64).toString('utf8').trimStart();
  return head.startsWith('[') || head.startsWith('{');
};

const importView = (res, opts) =>
  flash(res, 'import', {
    title: 'Import',
    job: null, analysis: null, error: null, notice: null,
    sources: IMPORT.SOURCE_CHOICES,
    statuses: IMPORT.STATUSES,
    // The four files in a Goodreads data export that carry any reading.
    files: GX.EXPORT_FILES,
    ...opts
  });

router.get('/settings/import', (req, res) => importView(res, {}));

router.post('/settings/import', requireVerified, async (req, res) => {
  if (!RL.check('importUpload', req.user.id).ok ||
      parsedJobs.size + importsInFlight >= 8 ||
      [...parsedJobs.values()].filter(j => j.userId === req.user.id && j.state === 'parsed').length >= 2) {
    return importView(res.status(429), { error: 'Finish an existing import or try again later.' });
  }
  importsInFlight++;
  let released = false;
  const release = () => { if (!released) { importsInFlight--; released = true; } };
  res.once('finish', release);
  res.once('close', release);
  const boundary = boundaryOf(req.get('content-type'));
  if (!boundary) return importView(res.status(400), { error: 'Expected a file.' });

  let body;
  try {
    body = await readBody(req, MAX_IMPORT_BYTES);
  } catch (err) {
    return importView(res.status(err.tooLarge ? 413 : 400), {
      error: err.tooLarge ? 'Files are at most 50 MB.' : 'That upload did not complete.'
    });
  }

  // The CSRF token travelled in the query string and has already been
  // checked by lib/security.js. These are the ordinary fields.
  const posted = multipartFields(body, boundary);

  // ── Two ways in, one path through ──────────────────────
  //
  // A chosen file and a pasted list arrive in the same submission and are
  // the same thing by the time they reach analyse(): some text, and a name
  // to call it. Keeping them one path is why a pasted list gets the preview,
  // the shelf mapping and the confirm step rather than a shortcut around
  // them. A file wins if somebody has managed to fill in both, because
  // choosing a file is the more deliberate of the two acts.
  const chosen = firstFile(body, boundary);
  const pasted = String(posted.pasted || '').trim();

  if ((!chosen || !chosen.data.length) && !pasted) {
    return importView(res.status(400), {
      error: 'Nothing to read. Choose a file, or paste some titles.'
    });
  }

  const file = chosen && chosen.data.length
    ? chosen
    : { filename: null, data: Buffer.from(pasted, 'utf8'), pasted: true };

  // ── A Goodreads data export ────────────────────────────
  //
  // Not the CSV everybody means by "my Goodreads export": the folder of
  // zipped JSON that "Request my data" actually sends. Four of its 44 files
  // hold reading, and this is where they are recognised — by their contents,
  // before the CSV parser gets a look at bytes that would make no sense to
  // it.
  //
  // Only the library takes the ordinary import path. The other three attach
  // to books that are already here, so they get the supplement flow, which
  // creates nothing.
  if (!file.pasted && looksLikeDataExport(file)) {
    let read;
    try {
      read = GX.readExport(file.data, file.filename);
    } catch (err) {
      return importView(res.status(400), { error: err.message });
    }

    if (read.kind !== 'library') {
      const items =
        read.kind === 'notes' ? GX.notesOf(read.parsed)
        : read.kind === 'activity' ? GX.datesOf(read.parsed)
        : GX.quotesOf(read.parsed);

      const plan = SUP.planSupplement(req.user.id, read.kind, items);
      const supId = randomUUID();
      parsedJobs.set(supId, {
        userId: req.user.id, kind: 'supplement', plan,
        filename: read.filename, state: 'parsed', createdAt: Date.now()
      });
      return res.redirect(`/settings/import/${supId}`);
    }

    // The library half, converted to the CSV shape so that it goes through
    // the same preview, the same shelf mapping and the same commit as every
    // other import rather than through a second path nobody maintains.
    file.data = Buffer.from(GX.libraryCSV(read.parsed), 'utf8');
    file.filename = read.filename;
    posted.source = 'goodreads';
  }

  let analysis;
  try {
    analysis = IMPORT.analyse(file.data.toString('utf8'), { sourceId: posted.source || null });
  } catch (err) {
    return importView(res.status(400), { error: `That file could not be read. ${err.message}` });
  }

  // The only branch that asks which service a file came from.
  if (analysis.needsSource) {
    return importView(res, {
      askSource: true,
      filename: file.filename,
      // So a paste survives the one question this screen asks. A file
      // cannot: no browser lets a page refill a file input, and nothing
      // about the upload was kept.
      pastedText: file.pasted ? pasted : null,
      rowCount: analysis.rowCount,
      header: analysis.header.slice(0, 12)
    });
  }
  if (!analysis.ok) return importView(res.status(400), { error: analysis.error });

  const id = randomUUID();
  parsedJobs.set(id, {
    userId: req.user.id, analysis, filename: file.filename,
    state: 'parsed', done: 0, total: analysis.rows.length, result: null,
    createdAt: Date.now()
  });

  run(
    `INSERT INTO import_jobs (id, user_id, state, total, preview)
     VALUES (?, ?, 'parsed', ?, ?)`,
    id, req.user.id, analysis.rows.length,
    JSON.stringify({ counts: analysis.counts, source: analysis.source, filename: file.filename })
  );

  audit.userAction(req, 'account.import.parsed', {
    metadata: { source: analysis.source.id, rows: analysis.counts.rows }
  });

  res.redirect(`/settings/import/${id}`);
});

// A job belongs to the session that made it, and to nothing else.
//
// The parsed rows live in memory — they are somebody's whole library and
// there is no reason to write them to disk twice before they have said yes.
// But the RESULT is a page somebody may reload, bookmark, or come back to
// after a restart, so a finished job is reconstructed from its database row
// rather than 404ing once the map is empty.
function jobFor(req, res) {
  const live = parsedJobs.get(req.params.id);
  if (live) {
    if (Number(live.userId) !== Number(req.user.id)) {
      res.status(404).render('404', { title: 'Not found' });
      return null;
    }
    return live;
  }

  const row = get(
    'SELECT * FROM import_jobs WHERE id = ? AND user_id = ?',
    req.params.id, req.user.id
  );

  // A preview cannot be resumed: the rows it was about are gone, and the
  // file would have to be chosen again. A finished one can.
  if (!row || row.state === 'parsed' || row.state === 'running') {
    res.status(404).render('404', { title: 'Not found' });
    return null;
  }

  const preview = JSON.parse(row.preview || '{}');
  return {
    userId: row.user_id,
    state: row.state,
    done: row.done_count,
    total: row.total,
    result: { imported: row.done_count, failed: [] },
    // Enough for the result line and the unmatched link, and nothing more.
    analysis: { counts: preview.counts || { unmatched: 0 }, unmatched: [], mapping: [], rows: [] },
    restored: true
  };
}

router.get('/settings/import/:id', (req, res) => {
  const job = jobFor(req, res);
  if (!job) return;
  if (job.kind === 'supplement') {
    return importView(res, { supplement: job.plan, filename: job.filename, jobId: req.params.id,
                             done: job.state === 'done', written: job.written || 0 });
  }
  importView(res, { job, analysis: job.analysis, jobId: req.params.id });
});

// The one line the screen prints while it runs. No bar, no spinner.
router.get('/settings/import/:id/progress', (req, res) => {
  const job = jobFor(req, res);
  if (!job) return;
  res.json({ state: job.state, done: job.done, total: job.total, result: job.result });
});

router.post('/settings/import/:id', (req, res) => {
  const job = jobFor(req, res);
  if (!job) return;
  if (job.state !== 'parsed') return res.redirect(`/settings/import/${req.params.id}`);

  // A supplement is small enough to write inside the request: thirteen notes
  // and two dates, against a library that is already here. There is no job
  // to watch and nothing to show progress for.
  if (job.kind === 'supplement') {
    job.written = SUP.applySupplement(req.user.id, job.plan);
    job.state = 'done';
    audit.userAction(req, 'account.import.supplement', {
      metadata: { kind: job.plan.kind, written: job.written }
    });
    return res.redirect(`/settings/import/${req.params.id}`);
  }

  // The mapping as confirmed on the preview — their words on the left.
  const mapping = {};
  for (const row of job.analysis.mapping) {
    const posted = req.body[`map:${row.value}`];
    mapping[row.value] = IMPORT.STATUSES.includes(posted) ? posted : row.status;
  }

  job.state = 'running';
  run(`UPDATE import_jobs SET state = 'running' WHERE id = ?`, req.params.id);

  // §12 — "Process asynchronously in a job with progress, not in the
  // request." The response returns immediately; the page reads /progress.
  setImmediate(async () => {
    try {
      job.result = await runImport(job.userId, job.analysis.rows, mapping, {
        onProgress: (done) => { job.done = done; }
      });
      job.state = 'done';
      run(
        `UPDATE import_jobs SET state = 'done', done_count = ?, finished_at = ? WHERE id = ?`,
        job.result.imported, new Date().toISOString().replace('T', ' ').slice(0, 19), req.params.id
      );
    } catch (err) {
      job.state = 'failed';
      job.result = { error: err.message };
      run(`UPDATE import_jobs SET state = 'failed', error = ? WHERE id = ?`, err.message, req.params.id);
      console.error('  import failed —', err.message);
    }
  });

  res.redirect(`/settings/import/${req.params.id}`);
});

// §12 — "a link to the unmatched row so they can fix it by hand."
router.get('/settings/import/:id/unmatched', (req, res) => {
  const job = jobFor(req, res);
  if (!job) return;
  flash(res, 'import-unmatched', {
    title: 'Unmatched',
    rows: job.analysis.unmatched,
    failed: job.result?.failed || [],
    restored: !!job.restored,
    jobId: req.params.id
  });
});

// ── EXPORT (§12) ─────────────────────────────────────────
router.get('/settings/export', requireFresh, (req, res) =>
  flash(res, 'export', {
    title: 'Export',
    today: EX.exportsToday(req.user.id),
    limit: RL.LIMITS.exportRun.limit
  })
);

router.post('/settings/export', requireFresh, async (req, res) => {
  const limit = RL.check('exportRun', req.user.id);
  if (!limit.ok || EX.exportsToday(req.user.id) >= RL.LIMITS.exportRun.limit) {
    return flash(res.status(429), 'export', {
      title: 'Export', today: EX.exportsToday(req.user.id), limit: RL.LIMITS.exportRun.limit,
      error: 'Two exports a day. Try again tomorrow.'
    });
  }

  const { token, counts } = EX.stageExport(req.user.id);
  await mail.exportReady(req.user.email, token);

  audit.userAction(req, 'account.export.created', {
    fields: ['books', 'shelves', 'notes', 'ratings', 'dates', 'account'],
    metadata: counts
  });

  flash(res, 'export', {
    title: 'Export', today: EX.exportsToday(req.user.id), limit: RL.LIMITS.exportRun.limit,
    notice: 'Ready. The link is in your email and lasts an hour.',
    link: `/settings/export/${token}`
  });
});

router.get('/settings/export/:token', (req, res) => {
  const row = EX.claimExport(req.params.token, req.user.id);
  if (!row) {
    return res.status(404).render('error', {
      title: 'Link expired', heading: 'That link has expired.',
      detail: 'Export links last an hour and work once. Make another.'
    });
  }
  audit.userAction(req, 'account.export.downloaded');
  res.download(row.path, 'margin-library.zip');
});

// ── DELETION (§12) ───────────────────────────────────────
router.get('/settings/delete', requireFresh, (req, res) =>
  flash(res, 'delete', {
    title: 'Delete',
    graceDays: PURGE.GRACE_DAYS,
    scheduled: req.user.purge_after
  })
);

router.post('/settings/deactivate', requireFresh, (req, res) => {
  PURGE.deactivate(req.user.id);
  res.clearCookie(S.COOKIE, { path: '/' });
  res.redirect('/signin');
});

router.post('/settings/delete', requireFresh, async (req, res) => {
  // Typing the username is the confirmation. A checkbox is not one.
  if (String(req.body.confirm || '').toLowerCase() !== String(req.user.username || '').toLowerCase()) {
    return flash(res.status(400), 'delete', {
      title: 'Delete', graceDays: PURGE.GRACE_DAYS, scheduled: null,
      error: 'Type your username exactly to confirm.'
    });
  }

  const when = PURGE.scheduleDeletion(req.user.id);
  await mail.deletionScheduled(req.user.email, when.toISOString().slice(0, 10));

  res.clearCookie(S.COOKIE, { path: '/' });
  res.render('error', {
    title: 'Scheduled',
    heading: 'Your account will be deleted.',
    detail: `On ${when.toISOString().slice(0, 10)}. Signing in before then cancels it.`
  });
});

// ── §10 — NOTIFICATIONS ──────────────────────────────────
router.get('/settings/notifications', requireAuth, (req, res) => {
  res.render('settings/notifications', {
    title: 'Notifications',
    kinds: SAFE.prefsFor(req.user.id).filter((k) => k.label),
    paused: SAFE.isPaused(req.user.id),
    error: null, notice: null
  });
});

router.post('/settings/notifications', requireAuth, (req, res) => {
  const on = [].concat(req.body.kind || []);
  SAFE.setPrefs(req.user.id, on);
  SAFE.setPaused(req.user.id, req.body.paused === '1');

  // §10 — the likes digest is the one preference with a second effect: it
  // decides whether the daily job looks at this account at all.
  run('UPDATE users SET digest_likes = ? WHERE id = ?',
      on.includes('likes_digest') ? 1 : 0, req.user.id);

  res.render('settings/notifications', {
    title: 'Notifications',
    kinds: SAFE.prefsFor(req.user.id).filter((k) => k.label),
    paused: SAFE.isPaused(req.user.id),
    error: null, notice: 'Saved.'
  });
});

export default router;
