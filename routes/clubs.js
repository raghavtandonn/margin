import { Router } from '../lib/router.js';
import { get, all } from '../db/index.js';
import * as C from '../lib/clubs.js';
import * as T from '../lib/trust.js';
import * as V from '../lib/visibility.js';
import { requireAuth, requireVerified } from '../lib/auth/middleware.js';
import * as AV from '../lib/avatars.js';
import { boundaryOf, readBody, firstFile } from '../lib/multipart.js';

const router = Router();

// ── §9 — CLUBS ───────────────────────────────────────────
//
// Every handler that touches a club resolves membership from club_members
// server-side (security §2.2). Nothing here trusts a role that arrived in a
// request, and a club the viewer may not see 404s rather than 403s so the
// existence of a private club is not confirmed.

/** Resolve `:slug` through the scope, or 404. */
function load(req, res) {
  const club = C.bySlug(req.params.slug, req.viewer);
  if (!club) {
    res.status(404).render('404', { title: 'Not found' });
    return null;
  }
  return club;
}

router.get('/clubs', (req, res) => {
  res.render('clubs', {
    title: 'Clubs',
    nav: 'clubs',
    mine: req.user ? C.mine(req.user.id) : [],
    discover: C.discover(req.viewer),
    roleLabel: C.roleLabel,
    canCreate: req.user ? T.can(T.levelOf(req.user), 'canCreateClub') : false,
    // A locked door that says nothing is indistinguishable from a feature
    // that does not exist. This is the sentence that tells them apart.
    whyNot: req.user ? T.whyNot(req.user, 'canCreateClub') : null
  });
});

router.get('/clubs/new', requireAuth, requireVerified, (req, res) => {
  // Refuse at the door, not after the form has been filled in. Rendering a
  // composer that is going to be rejected on submit is the rudest possible
  // ordering of the same two facts.
  const why = T.whyNot(req.user, 'canCreateClub');
  if (why) {
    return res.status(403).render('error', {
      title: 'Not yet',
      heading: 'Clubs are not open on this account yet.',
      detail: why,
      back: '/clubs'
    });
  }
  res.render('club-new', { title: 'New club', nav: 'clubs', error: null, form: {} });
});

router.post('/clubs/new', requireAuth, requireVerified, (req, res) => {
  const out = C.create(req.user, {
    name: req.body.name,
    slug: req.body.slug,
    description: req.body.description,
    visibility: req.body.visibility,
    joinPolicy: req.body.join_policy
  });

  if (!out.ok) {
    return res.status(400).render('club-new', {
      title: 'New club', nav: 'clubs', error: out.error, form: req.body
    });
  }
  res.redirect(`/clubs/${out.slug}`);
});

// ── The club page ────────────────────────────────────────
router.get('/clubs/:slug', (req, res) => {
  const club = load(req, res); if (!club) return;

  const me = C.membership(club.id, req.user?.id);
  const isMember = me?.state === 'active';
  const pick = C.activePick(club.id);

  res.render('club', {
    title: club.name,
    nav: 'clubs',
    club,
    me,
    isMember,
    isAdmin: isMember && (me.role === 'host' || me.role === 'admin'),
    isHost: isMember && me.role === 'host',
    memberCount: C.memberCount(club.id),
    pick,
    // §9.3 — an anonymous distribution, and nothing at all below five
    // readers. A per-member position is surveillance.
    progress: isMember ? C.pickProgress(pick) : null,
    participation: pick && req.user
      ? get('SELECT state FROM pick_participation WHERE pick_id = ? AND user_id = ?',
            pick.id, req.user.id)?.state ?? null
      : null,
    queue: isMember ? C.queue(club.id) : [],
    checkpoints: pick ? C.checkpointsFor(pick.id).map((cp) => ({
      ...cp, open: C.checkpointOpen(cp),
      posts: get('SELECT COUNT(*) n FROM club_posts WHERE checkpoint_id = ? AND deleted_at IS NULL', cp.id).n
    })) : [],
    // The wall: posts not attached to a checkpoint, so no spoiler boundary
    // applies and none is implied. Announcements are the same rows standing
    // in a different place, so they are split out rather than queried twice.
    // Nested one level. post() has accepted a parentId since it was
    // written and nothing ever passed one, so the wall was flat and
    // "SAY SOMETHING" could start a post but never answer one.
    wall: isMember ? C.threadedWall(club.id, req.viewer) : [],
    announcements: C.postsIn(club.id, req.viewer).filter((p) => p.kind === 'announcement'),
    roleLabel: C.roleLabel,
    // A short roster for the rail. The full list is a page of its own, and
    // §8 of the security spec keeps both members-only.
    roster: isMember ? (C.members(club.id, req.viewer, { limit: 8 }) || []) : null,
    archive: C.archive(club.id),
    // What the members made of each past pick. A club that read Stoner and
    // hated it is a fact about that club — and the most characterful thing
    // an archive can carry. Suppressed under three graders, like every
    // other aggregate here.
    grades: Object.fromEntries(
      C.archive(club.id).picks.map((p) => [p.work_id, C.clubGrades(club.id, p.work_id)])
    )
  });
});

// ── The emblem ───────────────────────────────────────────
router.post('/clubs/:slug/emblem', requireAuth, requireVerified, async (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.requireRole(club.id, req.user.id, ['host', 'admin']); }
  catch { return res.status(404).json({ error: 'Not found' }); }

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

  // The same pipeline as a user avatar: re-encoded, metadata stripped,
  // served from this origin.
  const result = await AV.processAvatar(file.data);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const { previous } = C.setEmblem(req.user, club, result.key);
  if (previous) AV.removeAvatar(previous);

  res.json({ ok: true, url: `/avatar/${result.key}/256` });
});

// ── Announcements ────────────────────────────────────────
router.post('/clubs/:slug/announce', requireAuth, requireVerified, (req, res) => {
  const club = load(req, res); if (!club) return;

  let out;
  try { out = C.announce(req.user, club, { body: req.body.body }); }
  catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  if (!out.ok) return res.status(400).render('error', {
    title: 'Not posted', heading: out.error, detail: null, back: `/clubs/${club.slug}`
  });
  res.redirect(`/clubs/${club.slug}`);
});

router.post('/clubs/:slug/announce/:id/remove', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.unannounce(req.user, club, req.params.id); }
  catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(`/clubs/${club.slug}`);
});

// ── Club settings ────────────────────────────────────────
router.get('/clubs/:slug/settings', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.requireRole(club.id, req.user.id, ['host', 'admin']); }
  catch { return res.status(404).render('404', { title: 'Not found' }); }

  res.render('club-settings', {
    title: `Settings — ${club.name}`, nav: 'clubs', club, error: null,
    isAdmin: true,                       // the requireRole above proved it
    invites: C.invitesFor(club.id)
  });
});

router.post('/clubs/:slug/settings', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;

  let out;
  try {
    out = C.updateSettings(req.user, club, {
      name: req.body.name, description: req.body.description,
      visibility: req.body.visibility, joinPolicy: req.body.join_policy
    });
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }

  if (!out.ok) return res.status(400).render('club-settings', {
    title: `Settings — ${club.name}`, nav: 'clubs', club, error: out.error
  });
  res.redirect(`/clubs/${club.slug}`);
});

// ── §9.4 — a checkpoint thread ───────────────────────────
router.get('/clubs/:slug/c/:cp', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  const me = C.membership(club.id, req.user.id);
  if (me?.state !== 'active') return res.status(404).render('404', { title: 'Not found' });

  const cp = get('SELECT * FROM club_checkpoints WHERE id = ?', req.params.cp);
  if (!cp) return res.status(404).render('404', { title: 'Not found' });

  const pick = C.activePick(club.id);

  // §9.4 — "Posts inside a checkpoint thread inherit its spoiler boundary
  // automatically. No one has to remember to tag anything."
  //
  // The gate is the reader's own page against the checkpoint's, from the
  // same readings row the reading page writes to. A reader who is behind
  // sees the thread masked; nobody had to declare anything.
  const mine = pick && get(
    'SELECT current_page FROM readings WHERE user_id = ? AND work_id = ? AND is_draft = 0',
    req.user.id, pick.work_id
  );
  const behind = cp.through_page != null
    && (!mine || (mine.current_page || 0) < cp.through_page);

  res.render('club-thread', {
    title: `${cp.label} — ${club.name}`,
    nav: 'clubs',
    club, cp, pick, behind,
    open: C.checkpointOpen(cp),
    posts: C.postsIn(club.id, req.viewer, { checkpointId: cp.id }).map((p) => ({
      ...p, reactions: C.reactionsFor(p.id)
    })),
    reactions: C.REACTIONS,
    error: null
  });
});

router.post('/clubs/:slug/post', requireAuth, requireVerified, (req, res) => {
  const club = load(req, res); if (!club) return;

  let out;
  try {
    out = C.post(req.user, club, {
      body: req.body.body,
      checkpointId: req.body.checkpoint_id || null,
      parentId: req.body.parent_id || null
    });
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }

  const back = req.body.checkpoint_id
    ? `/clubs/${club.slug}/c/${req.body.checkpoint_id}`
    : `/clubs/${club.slug}`;

  if (!out.ok) return res.status(400).render('error', {
    title: 'Not posted', heading: out.error, detail: null, back
  });

  res.redirect(back);
});

router.post('/clubs/:slug/react/:post', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try {
    C.requireRole(club.id, req.user.id, C.ROLES);
  } catch { return res.status(404).render('404', { title: 'Not found' }); }

  const result = C.react(req.user.id, req.params.post, req.body.reaction, { clubId: club.id });
  if (!result.ok) return res.status(404).render('404', { title: 'Not found' });
  res.redirect(req.get('referer') || `/clubs/${club.slug}`);
});

// ── Membership ───────────────────────────────────────────
/**
 * Mint an invitation.
 *
 * Club settings have offered "By invitation" since they were written with no
 * invitation anywhere in the product — so a club set to invite_only was a
 * club nobody could join, including by being asked.
 *
 * The token is shown ONCE. Only its hash is stored, so it cannot be
 * recovered from the server and the host has to actually send it.
 */
router.post('/clubs/:slug/invite', requireAuth, requireVerified, (req, res) => {
  const club = load(req, res); if (!club) return;
  let out;
  try {
    out = C.invite(req.user, club, { maxUses: req.body.uses });
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.render('club-invite', {
    title: `Invite — ${club.name}`, nav: 'clubs',
    club, token: out.token, days: out.expiresInDays,
    invites: C.invitesFor(club.id)
  });
});

router.post('/clubs/:slug/invite/:id/revoke', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.revokeInvite(req.user, club, req.params.id); }
  catch (e) { if (e.status === 403) return res.status(404).render('404', { title: 'Not found' }); throw e; }
  res.redirect(`/clubs/${club.slug}/settings`);
});

/**
 * An invitation, opened.
 *
 * Shows the club — its head, its current pick, its size — BEFORE asking for
 * a decision, and works for a signed-out visitor: it renders, then routes
 * through sign-up. That is the one invitation flow that can grow the house,
 * and it is why this route does not require auth.
 */
router.get('/join/:token', (req, res) => {
  const inv = C.inviteClub(req.params.token);
  // An expired, revoked or spent invitation is indistinguishable from one
  // that never existed. Saying which would confirm the club is real.
  if (!inv) return res.status(404).render('404', { title: 'Not found' });

  const pick = C.activePick(inv.club_id);
  res.render('club-join', {
    title: `Join ${inv.name}`,
    invite: inv, token: req.params.token, pick,
    memberCount: C.memberCount(inv.club_id),
    already: req.user ? C.membership(inv.club_id, req.user.id)?.state === 'active' : false
  });
});

router.post('/join/:token', requireAuth, requireVerified, (req, res) => {
  const out = C.acceptInvite(req.user, req.params.token);
  if (!out.ok) {
    return res.status(400).render('error', {
      title: 'Not joined', heading: out.error, detail: null, back: '/clubs'
    });
  }
  res.redirect(`/clubs/${out.slug}`);
});

router.post('/clubs/:slug/join', requireAuth, requireVerified, (req, res) => {
  const club = load(req, res); if (!club) return;

  const out = C.join(req.user, club);
  if (!out.ok) return res.status(400).render('error', {
    title: 'Not joined', heading: out.error, detail: null, back: `/clubs/${club.slug}`
  });
  res.redirect(`/clubs/${club.slug}`);
});

router.post('/clubs/:slug/leave', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  C.leave(req.user.id, club);
  res.redirect('/clubs');
});

router.get('/clubs/:slug/members', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;

  const list = C.members(club.id, req.viewer);
  // §8 of the security spec — a member list is for members. A non-member
  // gets the count and nothing else.
  if (!list) return res.status(404).render('404', { title: 'Not found' });

  const me = C.membership(club.id, req.user.id);
  res.render('club-members', {
    title: `Members — ${club.name}`,
    nav: 'clubs',
    club, members: C.membersWithReading(club.id, req.viewer) || list, me,
    roleLabel: C.roleLabel,
    isAdmin: me.role === 'host' || me.role === 'admin',
    isHost: me.role === 'host',
    requests: (me.role === 'host' || me.role === 'admin')
      ? all(`SELECT cm.user_id, cm.joined_at, u.username, u.display_name
               FROM club_members cm JOIN users u ON u.id = cm.user_id
              WHERE cm.club_id = ? AND cm.state = 'requested' ORDER BY cm.joined_at`, club.id)
      : [],
    error: null
  });
});

router.post('/clubs/:slug/members/:id/:action', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  const id = Number(req.params.id);
  let out = { ok: true };

  try {
    switch (req.params.action) {
      case 'approve': out = C.approveRequest(req.user, club, id); break;
      case 'decline': out = C.declineRequest(req.user, club, id); break;
      case 'remove': out = C.removeMember(req.user, club, id, { reason: req.body.reason }); break;
      case 'promote': out = C.setRole(req.user, club, id, 'admin'); break;
      case 'demote':  out = C.setRole(req.user, club, id, 'member'); break;
      case 'offer-hosting': out = C.offerHosting(req.user, club, id); break;
      default: return res.status(400).render('404', { title: 'Not found' });
    }
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }

  if (!out.ok) return res.status(400).render('error', {
    title: 'Not done', heading: out.error, detail: null, back: `/clubs/${club.slug}/members`
  });
  res.redirect(`/clubs/${club.slug}/members`);
});

router.post('/clubs/:slug/accept-hosting', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.acceptHosting(req.user.id, club); }
  catch { return res.status(404).render('404', { title: 'Not found' }); }
  res.redirect(`/clubs/${club.slug}`);
});

// ── §9.3 — the pick ──────────────────────────────────────
router.get('/clubs/:slug/pick', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.requireRole(club.id, req.user.id, ['host', 'admin']); }
  catch { return res.status(404).render('404', { title: 'Not found' }); }

  const q = String(req.query.q || '').trim();
  res.render('club-pick', {
    title: `Set the pick — ${club.name}`,
    nav: 'clubs', club, q,
    results: q ? all(
      `SELECT w.id, w.title,
              (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
                WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
         FROM works w WHERE w.title LIKE ? ORDER BY w.title LIMIT 20`, `%${q}%`) : [],
    pick: C.activePick(club.id),
    checkpoints: (() => { const p = C.activePick(club.id); return p ? C.checkpointsFor(p.id) : []; })(),
    error: null
  });
});

router.post('/clubs/:slug/pick', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try {
    C.setPick(req.user, club, {
      workId: req.body.work_id,
      cadence: req.body.cadence,
      startsOn: req.body.starts_on,
      endsOn: req.body.ends_on,
      announcement: req.body.announcement
    });
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(`/clubs/${club.slug}`);
});

router.post('/clubs/:slug/pick/:id/checkpoint', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try {
    C.addCheckpoint(req.user, club, req.params.id, {
      label: req.body.label,
      throughPage: req.body.through_page,
      throughChapter: req.body.through_chapter,
      opensOn: req.body.opens_on
    });
  } catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(`/clubs/${club.slug}/pick`);
});

router.post('/clubs/:slug/pick/:id/finish', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.finishPick(req.user, club, req.params.id); }
  catch (e) {
    if (e.status === 403) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(`/clubs/${club.slug}`);
});

/** §9.3 — "Sitting out is a first-class state, not a failure state." */
router.post('/clubs/:slug/pick/:id/participate', requireAuth, (req, res) => {
  const club = load(req, res); if (!club) return;
  try { C.requireRole(club.id, req.user.id, C.ROLES); }
  catch { return res.status(404).render('404', { title: 'Not found' }); }

  C.participate(req.user.id, req.params.id, req.body.state);
  res.redirect(`/clubs/${club.slug}`);
});

export default router;
