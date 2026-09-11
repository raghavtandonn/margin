import { Router } from '../lib/router.js';
import { get, all, run } from '../db/index.js';
import * as R from '../lib/reviews.js';
import * as F from '../lib/following.js';
import * as READERS from '../lib/readers.js';
import * as ACCT from '../lib/accounts.js';
import * as SAFE from '../lib/safety.js';
import * as AGG from '../lib/aggregates.js';
import * as T from '../lib/trust.js';
import * as V from '../lib/visibility.js';
import { findByUsername } from '../lib/accounts.js';
import { requireAuth, requireVerified } from '../lib/auth/middleware.js';
import * as audit from '../lib/audit.js';

const router = Router();

// ── §8 — LATEST ──────────────────────────────────────────
//
// The feed is the home page. It had its own destination for exactly as long
// as home was a dashboard reproducing the nav; once the feed became the
// lead, a second URL rendering the same thing was just the duplication
// problem again. The route stays as a redirect so nothing that already
// points here breaks.
router.get('/latest', requireAuth, (req, res) => res.redirect(301, '/'));

// ── §4 — REVIEWS ─────────────────────────────────────────

/** The composer. Pre-filled from a note only when asked for explicitly. */
router.get('/work/:id/review', requireAuth, requireVerified, (req, res) => {
  const work = get('SELECT * FROM works WHERE id = ?', req.params.id);
  if (!work) return res.status(404).render('404', { title: 'Not found' });

  const pass = Number(req.query.pass) || 1;
  const existing = get(
    'SELECT * FROM reviews WHERE user_id = ? AND work_id = ? AND pass = ?',
    req.user.id, work.id, pass
  );

  // §4.1 — the note is COPIED into the composer, and only when the reader
  // followed the "promote a note" affordance. Nothing is published by
  // arriving here.
  const seed = (!existing && req.query.from === 'note')
    ? R.composerFromNote(req.user.id, work.id, pass)
    : null;

  res.render('review-composer', {
    title: `Review — ${work.title}`,
    work, pass, existing,
    body: existing?.body ?? seed?.body ?? '',
    rating: existing?.rating ?? seed?.rating ?? null,
    fromNote: !!seed?.fromNote,
    hasNote: !!R.composerFromNote(req.user.id, work.id, pass).body,
    canLink: T.can(T.levelOf(req.user), 'canLink'),
    error: null
  });
});

router.post('/work/:id/review', requireAuth, requireVerified, (req, res) => {
  const work = get('SELECT * FROM works WHERE id = ?', req.params.id);
  if (!work) return res.status(404).render('404', { title: 'Not found' });

  const pass = Number(req.body.pass) || 1;

  // §6 — "The composer asks once, plainly. Default is No."
  const spoils = req.body.spoilers === 'yes';
  const throughPage = spoils && req.body.through_page ? Number(req.body.through_page) : null;

  const result = R.publish(req.user, {
    workId: work.id, pass,
    body: req.body.body,
    rating: req.body.rating ? Number(req.body.rating) : null,
    containsSpoilers: spoils,
    throughPage,
    throughChapter: spoils && !throughPage && req.body.through_chapter
      ? String(req.body.through_chapter).slice(0, 60) : null
  });

  if (!result.ok) {
    return res.status(400).render('review-composer', {
      title: `Review — ${work.title}`,
      work, pass, existing: null,
      body: req.body.body || '', rating: req.body.rating || null,
      fromNote: false, hasNote: false,
      canLink: T.can(T.levelOf(req.user), 'canLink'),
      error: result.error
    });
  }

  AGG.recompute(work.id);
  res.redirect(`/work/${work.id}#reviews`);
});

router.post('/review/:id/delete', requireAuth, (req, res) => {
  try {
    R.remove(req.params.id, req.user.id);
  } catch (e) {
    if (e.status === 404) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(req.get('referer') || '/');
});

router.post('/review/:id/like', requireAuth, (req, res) => {
  try {
    if (req.body.on === '0') R.unlike(req.params.id, req.user.id);
    else R.like(req.params.id, req.user.id);
  } catch (e) {
    if (e.status === 404) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(req.get('referer') || '/');
});

// ── §4 — REPLIES ─────────────────────────────────────────
//
// One level deep. `reply()` takes a review and never another reply: two
// levels is an argument, and the moderation cost of an argument is the
// reason a product this size should not carry threading.

router.post('/review/:id/reply', requireAuth, requireVerified, (req, res) => {
  const out = R.reply(req.user, req.params.id, req.body.body);

  if (!out.ok) {
    return res.status(out.status === 404 ? 404 : 400).render('error', {
      title: 'Not posted', heading: out.error, detail: null,
      back: req.get('referer') || '/'
    });
  }
  res.redirect(`${req.get('referer') || '/'}#reviews`);
});

/** Its author, or the review's author, may take a reply down. */
router.post('/review/reply/:id/delete', requireAuth, (req, res) => {
  const out = R.removeReply(req.params.id, req.user.id);

  if (!out.ok) {
    return res.status(400).render('error', {
      title: 'Not removed', heading: out.error, detail: null,
      back: req.get('referer') || '/'
    });
  }
  res.redirect(req.get('referer') || '/');
});

// ── THE CRITICISM ────────────────────────────────────────
//
// The missing step in the whole funnel. The product asked you to follow
// people and gave you no way to find out what anybody was like: a review
// appeared at the foot of one work page and nowhere else, so the only
// evidence available about a stranger was their shelves.
//
// Two filters, no algorithm, newest first. Everything goes through
// visibleSQL, so this index can never surface a review the reader could not
// already read on the book itself.
router.get('/reviews', requireAuth, (req, res) => {
  const rail = req.query.from === 'rail';
  res.render('criticism', {
    title: 'The criticism',
    rail,
    rows: R.recent(req.viewer, { limit: 30, rail })
  });
});

// ── §3 — FOLLOWING ───────────────────────────────────────

router.post('/@:username/follow', requireAuth, requireVerified, (req, res) => {
  const target = findByUsername(req.params.username);
  if (!target) return res.status(404).render('404', { title: 'Not found' });

  try {
    if (req.body.on === '0') F.unfollow(req.user.id, target.id);
    else F.follow(req.user, target.id, { req });
  } catch (e) {
    // §15 — a follow across a block fails as if the account does not exist.
    if (e.status === 404) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  res.redirect(`/@${target.username}`);
});

router.get('/@:username/followers', (req, res) => {
  const target = findByUsername(req.params.username);
  if (!V.profileVisibleTo(target, req.viewer)) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  const page = Number(req.query.page) || 0;
  const list = F.followers(target.id, req.viewer, { cursor: req.query.after || null, page });
  res.render('graph-list', {
    title: `Followers — @${target.username}`,
    heading: 'Followers', target, list, page, kind: 'followers'
  });
});

router.get('/@:username/following', (req, res) => {
  const target = findByUsername(req.params.username);
  if (!V.profileVisibleTo(target, req.viewer)) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  const page = Number(req.query.page) || 0;
  const list = F.following(target.id, req.viewer, { cursor: req.query.after || null, page });
  res.render('graph-list', {
    title: `Following — @${target.username}`,
    heading: 'Following', target, list, page, kind: 'following'
  });
});

router.get('/settings/requests', requireAuth, (req, res) =>
  res.render('settings/requests', {
    title: 'Follow requests',
    requests: F.pendingRequests(req.user.id),
    error: null, notice: null
  })
);

router.post('/settings/requests/:followerId/:decision', requireAuth, (req, res) => {
  const id = Number(req.params.followerId);
  try {
    if (req.params.decision === 'approve') F.approve(req.user.id, id);
    else F.decline(req.user.id, id);        // §3 — declining is silent
  } catch (e) {
    if (e.status === 404) return res.status(404).render('404', { title: 'Not found' });
    throw e;
  }
  // Back to wherever the decision was made. Requests are answered from the
  // front page now; the settings page still works for anyone who has it
  // bookmarked. 'pigeonhole' is kept as an alias because a form rendered
  // before this change may still be open in somebody's browser.
  const from = req.body.from;
  res.redirect(from === 'home' || from === 'pigeonhole' ? '/' : '/settings/requests');
});

// ── §11 — BLOCK, MUTE, REPORT ────────────────────────────

router.post('/@:username/block', requireAuth, (req, res) => {
  const target = findByUsername(req.params.username);
  if (!target) return res.status(404).render('404', { title: 'Not found' });

  if (req.body.on === '0') SAFE.unblock(req.user.id, target.id);
  else SAFE.block(req.user.id, target.id, { req });

  // A blocked profile 404s afterwards, so there is nowhere to go back to.
  res.redirect(req.body.on === '0' ? `/@${target.username}` : '/settings/blocked');
});

router.post('/@:username/mute', requireAuth, (req, res) => {
  const target = findByUsername(req.params.username);
  if (!target) return res.status(404).render('404', { title: 'Not found' });

  if (req.body.on === '0') SAFE.unmute(req.user.id, target.id);
  else SAFE.mute(req.user.id, target.id);

  res.redirect(`/@${target.username}`);
});

router.get('/settings/blocked', requireAuth, (req, res) =>
  res.render('settings/blocked', {
    title: 'Blocked & muted',
    blocked: SAFE.blocksBy(req.user.id),
    muted: SAFE.mutesBy(req.user.id),
    error: null, notice: null
  })
);

router.get('/report', requireAuth, (req, res) => {
  const { type, ref } = req.query;
  if (!SAFE.TARGETS.includes(type) || !ref) {
    return res.status(400).render('404', { title: 'Not found' });
  }
  res.render('report', {
    title: 'Report',
    targetType: type, targetRef: ref,
    categories: SAFE.CATEGORIES,
    error: null
  });
});

router.post('/report', requireAuth, (req, res) => {
  const targetUserId = resolveTargetUser(req.body.target_type, req.body.target_ref);

  const out = SAFE.report(req.user, {
    targetType: req.body.target_type,
    targetRef: req.body.target_ref,
    targetUserId,
    category: req.body.category,
    detail: req.body.detail
  });

  if (!out.ok) {
    return res.status(400).render('report', {
      title: 'Report',
      targetType: req.body.target_type, targetRef: req.body.target_ref,
      categories: SAFE.CATEGORIES, error: out.error
    });
  }

  res.render('error', {
    title: 'Reported',
    heading: 'That is with a person now.',
    // §11 — reporters see an outcome. Saying where it went is the start of
    // that; /settings/reports carries the rest.
    detail: 'You will see the outcome in your settings, whichever way it goes.'
  });
});

function resolveTargetUser(type, ref) {
  if (type === 'user') return Number(ref) || null;
  if (type === 'review') return get('SELECT user_id FROM reviews WHERE id = ?', ref)?.user_id ?? null;
  if (type === 'post') return get('SELECT user_id FROM club_posts WHERE id = ?', ref)?.user_id ?? null;
  if (type === 'club') return get('SELECT host_id FROM clubs WHERE id = ?', ref)?.host_id ?? null;
  return null;
}

/** §11 — "Reporters see an outcome … Silence is what convinces people it is pointless." */
router.get('/settings/reports', requireAuth, (req, res) =>
  res.render('settings/reports', {
    title: 'Reports',
    reports: SAFE.reportsBy(req.user.id),
    error: null, notice: null
  })
);

// ── §10 — NOTIFICATIONS ──────────────────────────────────
/**
 * NOTIFICATIONS.
 *
 * Eleven event types were configurable and none of them had anywhere to
 * arrive. Two changes make this an inbox rather than a log:
 *
 *   REQUESTS AT THE TOP. A person asking to follow you is the only item
 *   here waiting on an answer, and it used to live three clicks deep in the
 *   settings panel, under the controls for making people stop.
 *
 *   GROUPED BY KIND. "Four people replied to your review of Stoner" is one
 *   row, not four. Grouping is the difference between a pigeonhole and a
 *   feed, and a feed is something you check.
 */
/**
 * THE ROLL — a directory that explains itself.
 *
 * The product had no way to find a reader. Home said the feed fills up when
 * you follow people and that sentence was not a link, because there was
 * nothing on the site it could point at.
 *
 * Four sections, each derivable and each stating its own rule in its
 * heading. No "suggested for you": that needs behavioural inference this
 * product has refused everywhere else, and a stranger you cannot explain is
 * worse than no stranger at all.
 */
router.get('/readers', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();

  res.render('readers', {
    title: 'The roll',
    nav: 'readers',
    q,
    results: q ? READERS.search(req.viewer, q, { limit: 40 }) : null,
    alongside: READERS.alongside(req.viewer),
    clubs: READERS.inYourClubs(req.viewer),
    fresh: READERS.newHere(req.viewer),
    widest: READERS.widestShelves(req.viewer)
  });
});

// The notifications PAGE is gone; its contents live on the front page, which
// was already a list of things that have happened. The route stays as a
// redirect because links to it exist — in settings copy, in old sessions,
// and in anything a reader bookmarked.
router.get('/notifications', requireAuth, (req, res) => res.redirect(301, '/'));

export default router;
