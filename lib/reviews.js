import { randomUUID } from 'node:crypto';
import { get, all, run, nowSQL, sqlTime } from '../db/index.js';
import { toHTML, cleanText } from './markdown.js';
import * as V from './visibility.js';
import * as T from './trust.js';
import { noteOf } from './notes.js';
import * as audit from './audit.js';

// ── §4 — REVIEWS ─────────────────────────────────────────
//
// §4.1 is "the most important boundary in the product", and it is one
// sentence long: **notes are private writing; reviews are public.**
//
// A note NEVER becomes a review automatically. There is no default, no
// toggle in settings, no bulk migration, and no exception. The only path is
// `composerFromNote`, which COPIES the text into a composer that somebody
// then edits and publishes deliberately — creating a new record and leaving
// the note untouched.
//
// The import path is where this matters most: a reader who imports 400
// reviews from another service has not consented to publishing 400 reviews,
// so those land as notes and stay there. lib/import-run.js writes them with
// note_imported = 1 and never touches this file.

export const MIN_LENGTH = 1;
export const MAX_LENGTH = 10_000;

/** §4.1 — the composer is pre-filled from a note. Nothing is published. */
export function composerFromNote(userId, workId, pass = 1) {
  const reading = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ? AND pass_number = ?`,
    Number(userId), Number(workId), Number(pass)
  );
  if (!reading) return { body: '', rating: null };

  return {
    // A copy. The note is not read again after this and is never modified.
    body: noteOf(reading) || '',
    rating: reading.stars ?? null,
    fromNote: true
  };
}

// ── Writing ──────────────────────────────────────────────

export function publish(user, { workId, pass = 1, body, rating = null,
                                containsSpoilers = false, throughPage = null,
                                throughChapter = null, visibility = 'inherit' }) {
  const level = T.levelOf(user);

  if (T.can(level, 'readOnly')) {
    return { ok: false, error: 'This account is read-only while a report is reviewed.' };
  }

  const text = cleanText(body, { max: MAX_LENGTH });
  if (text.length < MIN_LENGTH) return { ok: false, error: 'A review needs some words in it.' };

  const limit = T.withinWriteLimit(user.id, 'review', level);
  if (!limit.ok) {
    return { ok: false, error: `That is ${limit.cap} reviews today. Try again tomorrow.` };
  }

  // §13.3 — "An account may not rate or review a book it is credited on."
  // Enforced at write time by matching the author record, not by policy.
  if (isCreditedOn(user, workId)) {
    return { ok: false, error: 'You are credited on this book, so you cannot review it.' };
  }

  // §7 — no links below Trust 2. The render drops them to their label text
  // rather than refusing the review, so nobody loses what they wrote.
  const html = toHTML(text, { allowLinks: T.can(level, 'canLink') });

  const existing = get(
    'SELECT * FROM reviews WHERE user_id = ? AND work_id = ? AND pass = ?',
    Number(user.id), Number(workId), Number(pass)
  );

  const id = existing?.id || randomUUID();

  if (existing) {
    // §4.2 — full revision history retained internally for moderation.
    run(`INSERT INTO review_revisions (id, review_id, body) VALUES (?, ?, ?)`,
        randomUUID(), id, existing.body);

    run(
      `UPDATE reviews SET body = ?, body_html = ?, rating = ?, contains_spoilers = ?,
                          spoiler_through_page = ?, spoiler_through_chapter = ?,
                          visibility = ?, edited_at = ?, deleted_at = NULL
        WHERE id = ?`,
      text, html, rating, containsSpoilers ? 1 : 0,
      throughPage, throughChapter, visibility, nowSQL(), id
    );
  } else {
    run(
      `INSERT INTO reviews (id, user_id, work_id, pass, body, body_html, rating,
                            contains_spoilers, spoiler_through_page, spoiler_through_chapter,
                            visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, Number(user.id), Number(workId), Number(pass), text, html, rating,
      containsSpoilers ? 1 : 0, throughPage, throughChapter, visibility
    );

    run(`UPDATE users SET reviews_published = COALESCE(reviews_published, 0) + 1 WHERE id = ?`,
        Number(user.id));
    T.refresh(user.id);
  }

  audit.record({
    actorType: 'user', actorId: user.public_id || user.id,
    action: existing ? 'review.edited' : 'review.published',
    targetUserId: Number(user.id), metadata: { work: workId, pass }
  });

  return { ok: true, id };
}

/**
 * §13.3 — an account credited on a book may not rate or review it.
 *
 * Matched on the author record rather than on a claim, so it holds even
 * when nobody has told the system that this account is an author.
 */
export function isCreditedOn(user, workId) {
  if (!user?.display_name && !user?.username) return false;
  const names = [user.display_name, user.username].filter(Boolean).map((n) => n.toLowerCase());

  const credited = all(
    `SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
      WHERE wp.work_id = ?`,
    Number(workId)
  ).map((r) => String(r.name).toLowerCase());

  return credited.some((c) => names.includes(c));
}

/** §4.2 — the body goes; a tombstone stays so counts and replies do not orphan. */
export function remove(reviewId, userId) {
  const r = get('SELECT * FROM reviews WHERE id = ? AND user_id = ?', reviewId, Number(userId));
  if (!r) throw new V.NotFound();

  run(
    `UPDATE reviews SET body = '', body_html = NULL, deleted_at = ?
      WHERE id = ?`,
    nowSQL(), reviewId
  );
  return { ok: true };
}

// ── §6 — SPOILERS ────────────────────────────────────────
//
// Position-aware gating, which is the thing Goodreads handles badly and
// therefore the thing worth doing well.
//
// A viewer at or beyond the declared point sees the text normally. A viewer
// behind it sees one line saying how far it goes, and taps to reveal. A
// viewer with nothing logged is treated as at page zero — not as
// "unknown", because unknown would mean showing them everything.

export function spoilerState(review, viewerProgress) {
  if (!review.contains_spoilers && !review.spoiler_through_page && !review.spoiler_through_chapter) {
    return { masked: false };
  }

  // §6 — "Blanket contains_spoilers with no position is allowed and always
  // masked." There is nothing to compare against, so it never opens.
  if (!review.spoiler_through_page && !review.spoiler_through_chapter) {
    return { masked: true, label: 'Gives something away.' };
  }

  if (review.spoiler_through_chapter) {
    return {
      masked: true,
      label: `Discusses events through ${review.spoiler_through_chapter}.`,
      // A chapter cannot be compared with a page number, so a chapter-gated
      // review opens only on a deliberate tap.
      comparable: false
    };
  }

  const at = Number(viewerProgress || 0);
  if (at >= Number(review.spoiler_through_page)) return { masked: false };

  // The gate reads against the READER's own position, not just the
  // reviewer's declaration. "Through page 240. You are on page 212." is a
  // sentence no other reading product can write, and it costs nothing: both
  // numbers were already being collected.
  //
  // The reader's page is only mentioned when there IS one. Somebody who has
  // not opened the book is told how far the review goes and nothing about
  // themselves, which is the honest version for a stranger.
  return {
    masked: true,
    label: at > 0
      ? `Discusses events through page ${review.spoiler_through_page}. You are on page ${Math.round(at)}.`
      : `Discusses events through page ${review.spoiler_through_page}.`,
    comparable: true,
    viewerPage: at > 0 ? Math.round(at) : null,
    through: Number(review.spoiler_through_page)
  };
}

/** How far the viewer has got in this book, for the comparison above. */
export const progressOf = (userId, workId) => {
  if (!userId) return 0;
  const r = get(
    `SELECT current_page, status FROM readings
      WHERE user_id = ? AND work_id = ? ORDER BY pass_number DESC LIMIT 1`,
    Number(userId), Number(workId)
  );
  if (!r) return 0;
  // Somebody who has finished it is past every point in it.
  return r.status === 'FINISHED' ? Number.MAX_SAFE_INTEGER : Number(r.current_page || 0);
};

// ── Reading ──────────────────────────────────────────────
//
// Every read goes through visibleSQL, which now carries blocks and account
// visibility. §15: "Reviews on a book page: mutually hidden."

const REVIEW_COLUMNS = `
  r.id, r.user_id, r.work_id, r.pass, r.body, r.body_html, r.rating,
  r.contains_spoilers, r.spoiler_through_page, r.spoiler_through_chapter,
  r.published_at, r.edited_at, r.deleted_at, r.like_count,
  u.username, u.display_name, u.avatar_key`;

export function forWork(workId, viewer, { limit = 50 } = {}) {
  const v = V.visibleSQL(viewer, { owner: 'u', entry: 'r' });

  return all(
    `SELECT ${REVIEW_COLUMNS}
       FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.work_id = ? AND r.deleted_at IS NULL AND ${v.sql}
      ORDER BY r.published_at DESC LIMIT ?`,
    Number(workId), ...v.params, limit
  );
}

export const byUser = (userId, viewer, { limit = 20 } = {}) => {
  const v = V.visibleSQL(viewer, { owner: 'u', entry: 'r' });
  return all(
    `SELECT ${REVIEW_COLUMNS}, w.title
       FROM reviews r JOIN users u ON u.id = r.user_id JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND r.deleted_at IS NULL AND ${v.sql}
      ORDER BY r.published_at DESC LIMIT ?`,
    Number(userId), ...v.params, limit
  );
};

export const byId = (id, viewer) => {
  const v = V.visibleSQL(viewer, { owner: 'u', entry: 'r' });
  return get(
    `SELECT ${REVIEW_COLUMNS}, w.title
       FROM reviews r JOIN users u ON u.id = r.user_id JOIN works w ON w.id = r.work_id
      WHERE r.id = ? AND ${v.sql}`,
    id, ...v.params
  ) || null;
};

// ── §7 — LIKES AND RANKING ───────────────────────────────

export function like(reviewId, userId) {
  const r = get('SELECT user_id FROM reviews WHERE id = ?', reviewId);
  if (!r) throw new V.NotFound();
  // §15 — "Likes: cannot like" across a block.
  if (V.blockedBetween(userId, r.user_id)) throw new V.NotFound();

  run('INSERT OR IGNORE INTO review_likes (review_id, user_id) VALUES (?, ?)', reviewId, Number(userId));
  run(`UPDATE reviews SET like_count = (SELECT COUNT(*) FROM review_likes WHERE review_id = ?)
        WHERE id = ?`, reviewId, reviewId);
  return { ok: true };
}

export function unlike(reviewId, userId) {
  run('DELETE FROM review_likes WHERE review_id = ? AND user_id = ?', reviewId, Number(userId));
  run(`UPDATE reviews SET like_count = (SELECT COUNT(*) FROM review_likes WHERE review_id = ?)
        WHERE id = ?`, reviewId, reviewId);
  return { ok: true };
}

/**
 * §7 — "Likes are private counts, publicly aggregated. You can see how many
 * people liked a review; you cannot see who unless they're someone you
 * follow."
 *
 * And §9 of the security spec: the count must not leak a private account.
 * "Showing 'liked by 3' where the viewer can see 2 reveals that a third,
 * hidden account exists" — so the NAMES shown are only those the viewer may
 * see, and the COUNT is the true total, which reveals nothing about who.
 */
export function likersVisibleTo(reviewId, viewer) {
  if (!viewer?.id) return [];
  return all(
    `SELECT u.username, u.display_name FROM review_likes rl
       JOIN users u ON u.id = rl.user_id
       JOIN user_follows f ON f.followee_id = u.id AND f.follower_id = ? AND f.state = 'active'
      WHERE rl.review_id = ? LIMIT 10`,
    Number(viewer.id), reviewId
  );
}

/**
 * §7 — top reviews, ranked per viewer.
 *
 *   0.45 normalized_likes + 0.25 affinity + 0.15 recency + 0.15 substance
 *   minus penalties for flags, low trust, and being under a day old
 *
 * "Affinity matters more than raw popularity." The consequence is the point:
 * there is no single top slot to attack, because the ordering differs for
 * every viewer.
 */
export function topForWork(workId, viewer, { limit = 5 } = {}) {
  const reviews = forWork(workId, viewer, { limit: 200 });
  if (!reviews.length) return { following: [], top: [] };

  const maxLikes = Math.max(1, ...reviews.map((r) => r.like_count || 0));
  const now = Date.now();
  const HALF_LIFE = 180 * 86_400_000;

  const followed = viewer?.id
    ? new Set(all(
        `SELECT followee_id FROM user_follows WHERE follower_id = ? AND state = 'active'`,
        Number(viewer.id)
      ).map((r) => r.followee_id))
    : new Set();

  const scored = reviews.map((r) => {
    const age = now - Date.parse(`${String(r.published_at).replace(' ', 'T')}Z`);

    const likes = (r.like_count || 0) / maxLikes;
    const affinity = followed.has(r.user_id) ? 1 : tasteOverlap(viewer, r.user_id);
    const recency = Math.pow(0.5, age / HALF_LIFE);
    const substance = Math.min(1, (r.body?.length || 0) / 1200);

    let score = 0.45 * likes + 0.25 * affinity + 0.15 * recency + 0.15 * substance;

    // Penalties.
    const author = get('SELECT trust_level FROM users WHERE id = ?', r.user_id);
    if (T.levelOf(author) < 2) score -= 0.3;
    if (age < 86_400_000 && T.levelOf(author) < 3) score -= 0.2;

    return { ...r, score };
  });

  // §7 — reviews from people you follow sit in their own small section
  // ABOVE top reviews, labelled plainly rather than silently promoted.
  const following = scored.filter((r) => followed.has(r.user_id))
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const followingIds = new Set(following.map((r) => r.id));

  const top = scored.filter((r) => !followingIds.has(r.id))
    .sort((a, b) => b.score - a.score).slice(0, limit);

  return { following, top, total: reviews.length };
}

/**
 * Taste overlap — how often two readers rate the same books similarly.
 *
 * §15 of the community spec: notes never enter any community computation,
 * so this reads ratings only.
 */
function tasteOverlap(viewer, otherId) {
  if (!viewer?.id) return 0;

  const rows = all(
    `SELECT a.stars AS mine, b.stars AS theirs
       FROM readings a JOIN readings b ON b.work_id = a.work_id
      WHERE a.user_id = ? AND b.user_id = ?
        AND a.stars IS NOT NULL AND b.stars IS NOT NULL`,
    Number(viewer.id), Number(otherId)
  );
  if (rows.length < 3) return 0;

  const diff = rows.reduce((s, r) => s + Math.abs(r.mine - r.theirs), 0) / rows.length;
  // Four stars apart is no agreement at all; identical is total.
  return Math.max(0, 1 - diff / 4);
}

// ── REPLIES ──────────────────────────────────────────────
//
// The spoiler gate was built for an audience that had no way to arrive, and
// a review had no way to be answered. Notification settings promised
// "someone replies to your review" for a reply nobody could write.
//
// One level. `reply()` takes a review, never another reply: two levels is an
// argument, and the moderation cost of an argument is the reason most
// products of this size should not have threading.

/** Write a reply. Same gates as a club post: trust, rate limit, sanitising. */
export function reply(user, reviewId, body) {
  if (T.can(T.levelOf(user), 'readOnly')) {
    return { ok: false, error: 'This account is read-only.' };
  }
  if (!T.can(T.levelOf(user), 'canComment')) {
    return { ok: false, error: 'Replies open up once your account is a little older.' };
  }

  const review = get(
    'SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL',
    String(reviewId)
  );
  if (!review) return { ok: false, error: 'That review is gone.' };

  // §15 — a block is mutual invisibility. Neither party can reach the other,
  // and the refusal says nothing about which direction it runs in.
  const blocked = get(
    `SELECT 1 AS x FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    Number(user.id), review.user_id, review.user_id, Number(user.id)
  );
  if (blocked) return { ok: false, error: 'That review is gone.' };

  const text = cleanText(body, { max: 4000 });
  if (!text) return { ok: false, error: 'Say something.' };

  const limit = T.withinWriteLimit(user.id, 'post', T.levelOf(user));
  if (!limit.ok) return { ok: false, error: 'Slow down.' };

  const id = randomUUID();
  run(
    `INSERT INTO review_replies (id, review_id, user_id, body, body_html)
     VALUES (?, ?, ?, ?, ?)`,
    id, review.id, Number(user.id), text,
    // §9.5 — no external links below Trust 2. This is where spam arrives.
    toHTML(text, { allowLinks: T.can(T.levelOf(user), 'canLink') })
  );

  return { ok: true, id, review };
}

/**
 * The replies on a review, scoped to the viewer.
 *
 * A reply from somebody whose account is gone, deactivated or blocked is not
 * shown — the same rule the review itself obeys.
 */
export function repliesFor(reviewId, viewer) {
  const v = V.visibleSQL(viewer, { owner: 'u', accountGates: false });
  return all(
    `SELECT rr.id, rr.body_html, rr.created_at, rr.user_id,
            u.username, u.display_name, u.avatar_key
       FROM review_replies rr JOIN users u ON u.id = rr.user_id
      WHERE rr.review_id = ? AND rr.deleted_at IS NULL
        AND u.deleted_at IS NULL AND u.is_tombstone = 0
        AND ${v.sql}
      ORDER BY rr.created_at`,
    String(reviewId), ...v.params
  );
}

/** Counts for a set of reviews, so a list does not run one query per row. */
export function replyCounts(reviewIds) {
  const ids = (reviewIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT review_id, COUNT(*) n FROM review_replies
      WHERE deleted_at IS NULL AND review_id IN (${marks})
      GROUP BY review_id`,
    ...ids
  );
  return new Map(rows.map((r) => [r.review_id, r.n]));
}

/** Its author, or the review's author, may take a reply down. */
export function removeReply(replyId, userId) {
  const row = get(
    `SELECT rr.*, r.user_id AS review_owner
       FROM review_replies rr JOIN reviews r ON r.id = rr.review_id
      WHERE rr.id = ?`,
    String(replyId)
  );
  if (!row) return { ok: false, error: 'Gone already.' };
  if (Number(row.user_id) !== Number(userId) && Number(row.review_owner) !== Number(userId)) {
    return { ok: false, error: 'Not yours.' };
  }
  // A tombstone, not a delete: §9.2 — counts and threads must not orphan.
  run(`UPDATE review_replies SET deleted_at = ?, body = '', body_html = '' WHERE id = ?`,
      nowSQL(), String(replyId));
  return { ok: true };
}

// ── THE CRITICISM ────────────────────────────────────────
/**
 * Reviews across the whole house, newest first.
 *
 * This is the page that lets somebody read a reader before deciding to
 * follow them, which was the missing step in the entire funnel: the product
 * asked you to follow people and gave you no way to find out what anybody
 * was like.
 */
export function recent(viewer, { limit = 30, rail = false } = {}) {
  const v = V.visibleSQL(viewer, { owner: 'u', entry: 'r' });

  const railOnly = rail && viewer?.id
    ? `AND EXISTS (SELECT 1 FROM user_follows f
                    WHERE f.follower_id = ${Number(viewer.id)}
                      AND f.followee_id = r.user_id AND f.state = 'active')`
    : '';

  return all(
    `SELECT r.*, u.username, u.display_name, u.avatar_key,
            w.title, w.id AS work_id,
            (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS likes
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN works w ON w.id = r.work_id
      WHERE r.deleted_at IS NULL AND ${v.sql} ${railOnly}
      ORDER BY r.published_at DESC LIMIT ?`,
    ...v.params, limit
  );
}
