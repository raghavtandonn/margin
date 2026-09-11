import { all, get } from '../db/index.js';
import * as V from './visibility.js';

// ── FINDING A PERSON ─────────────────────────────────────
//
// The sharpest gap in the product: a reader who wants what the site asks for
// — follow people — has no move available except knowing a URL by heart.
// Home's empty state says the feed fills up when you follow people and is
// not a link, because there was nothing on the site it could link to.
//
// ── §15, AND WHERE IT APPLIES ────────────────────────────
//
// Profiles are public by default, so the protection against a throwaway
// impersonation account is no longer "you cannot be looked at" — it is "you
// cannot be STUMBLED ON". Three of the surfaces below are stranger-facing
// and carry ESTABLISHED_SQL:
//
//   search          somebody types a name they know. This is the
//                   impersonation vector, exactly.
//   newHere         a list of accounts that just appeared.
//   widestShelves   a list of accounts with big libraries.
//
// Two do not, on purpose:
//
//   alongside       you are both in the middle of the same book, right now
//   inYourClubs     you are both in a room you chose to be in
//
// Those two are not distribution — the viewer supplied the connection, and
// the row names the book or the club that produced it. Gating them would
// hide precisely the readers a genuine new arrival should meet, in exchange
// for closing a route an impersonator can only reach by reading the same
// book as their target or joining their club, where a moderator is already
// standing.
//
// Everything here goes through visibleSQL. A directory is exactly where a
// private profile leaks: the profile page refuses a stranger correctly, and
// then a search index hands over the same name, handle and avatar anyway.
// Unlike a club — a container, not owned content — a PROFILE is owned, so
// the account gates stay on and an unverified or deactivated account
// publishes nothing.

const publicCountScope = V.visibleReadingSQL(V.ANONYMOUS, { owner: 'u', entry: 'rc' });
const SELECT = `
  SELECT u.id, u.username, u.display_name, u.avatar_key, u.bio, u.location,
         (SELECT COUNT(*) FROM readings rc WHERE rc.user_id = u.id AND rc.status = 'FINISHED' AND rc.is_draft = 0 AND ${publicCountScope.sql}) AS books_logged, u.created_at`;

/**
 * Readers matching a query.
 *
 * Match order is exact handle, then display-name prefix, then anything in
 * the bio. A leading @ means handles only — somebody typing "@ida" knows who
 * they are looking for and should not have to read past four bios.
 */
export function search(viewer, text, { limit = 12 } = {}) {
  const raw = String(text || '').trim();
  if (raw.length < 2) return [];

  const handleOnly = raw.startsWith('@');
  const q = raw.replace(/^@/, '').toLowerCase();
  if (!q) return [];

  const v = V.visibleSQL(viewer, { owner: 'u' });
  const like = `${q}%`;
  const anywhere = `%${q}%`;

  // Ranked in SQL rather than in three queries, so paging and the limit
  // apply to the whole result rather than to each tier.
  const rows = all(
    `${SELECT},
            CASE
              WHEN lower(u.username) = ?              THEN 0
              WHEN lower(u.username) LIKE ?           THEN 1
              WHEN lower(u.display_name) LIKE ?       THEN 2
              WHEN lower(u.display_name) LIKE ?       THEN 3
              ELSE 4
            END AS rank
       FROM users u
      WHERE ${v.sql}
        AND ${V.ESTABLISHED_SQL('u')}
        AND (lower(u.username) LIKE ?
             ${handleOnly ? '' : "OR lower(u.display_name) LIKE ? OR lower(u.bio) LIKE ?"})
      ORDER BY rank, books_logged DESC, u.username
      LIMIT ?`,
    q, like, like, anywhere,
    ...v.params,
    anywhere,
    ...(handleOnly ? [] : [anywhere, anywhere]),
    limit
  );

  return rows;
}

// ── THE ROLL ─────────────────────────────────────────────
//
// A directory, and the honest kind.
//
// No "suggested for you". That needs behavioural inference the product has
// refused everywhere else, and it is unexplainable by construction — the
// reader cannot tell why they are being shown a stranger. Every section
// below states its own rule in its heading, and a reader could verify any of
// them by hand.

/** Public accounts that appeared recently. */
export function newHere(viewer, { limit = 8 } = {}) {
  const v = V.visibleSQL(viewer, { owner: 'u' });
  return all(
    `${SELECT} FROM users u
      WHERE ${v.sql}
        AND ${V.ESTABLISHED_SQL('u')}
        AND u.profile_visibility = 'public'
        AND u.created_at >= date('now', '-30 day')
      ORDER BY u.created_at DESC LIMIT ?`,
    ...v.params, limit
  );
}

/**
 * Anyone with an open pass on a book you have an open pass on.
 *
 * The strongest tie in a reading product and it costs one join. Not a model,
 * not a score: you are both, right now, in the middle of the same book.
 */
export function alongside(viewer, { limit = 8 } = {}) {
  if (!viewer?.id) return [];
  const v = V.visibleSQL(viewer, { owner: 'u' });
  const titleScope = V.visibleReadingSQL(viewer, { owner: 'u', entry: 'r2' });
  const readingScope = V.visibleReadingSQL(viewer, { owner: 'u', entry: 'r' });
  return all(
    `${SELECT},
            (SELECT w.title FROM readings r2
               JOIN works w ON w.id = r2.work_id
              WHERE r2.user_id = u.id AND r2.status = 'READING' AND r2.is_draft = 0 AND ${titleScope.sql}
                AND r2.work_id IN (SELECT work_id FROM readings
                                    WHERE user_id = ? AND status = 'READING')
              LIMIT 1) AS shared_title
       FROM users u
      WHERE ${v.sql}
        AND u.id != ?
        AND EXISTS (
          SELECT 1 FROM readings r
           WHERE r.user_id = u.id AND r.status = 'READING' AND r.is_draft = 0 AND ${readingScope.sql}
             AND r.work_id IN (SELECT work_id FROM readings
                                WHERE user_id = ? AND status = 'READING'))
        AND NOT EXISTS (
          SELECT 1 FROM user_follows f
           WHERE f.follower_id = ? AND f.followee_id = u.id AND f.state = 'active')
      ORDER BY u.username LIMIT ?`,
    ...titleScope.params, Number(viewer.id), ...v.params, Number(viewer.id),
    ...readingScope.params, Number(viewer.id), Number(viewer.id), limit
  );
}

/** People already in a room with you, whom you have not put on your rail. */
export function inYourClubs(viewer, { limit = 8 } = {}) {
  if (!viewer?.id) return [];
  // accountGates stays ON: this is a person, not a container. But club
  // membership is the reason they are listed, so a private profile you share
  // a club with is still not exposed here unless the gate allows it.
  const v = V.visibleSQL(viewer, { owner: 'u' });
  return all(
    `${SELECT},
            (SELECT c.name FROM club_members cm2
               JOIN clubs c ON c.id = cm2.club_id
              WHERE cm2.user_id = u.id AND cm2.state = 'active'
                AND cm2.club_id IN (SELECT club_id FROM club_members
                                     WHERE user_id = ? AND state = 'active')
              LIMIT 1) AS shared_club
       FROM users u
      WHERE ${v.sql}
        AND u.id != ?
        AND EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.user_id = u.id AND cm.state = 'active'
             AND cm.club_id IN (SELECT club_id FROM club_members
                                 WHERE user_id = ? AND state = 'active'))
        AND NOT EXISTS (
          SELECT 1 FROM user_follows f
           WHERE f.follower_id = ? AND f.followee_id = u.id AND f.state = 'active')
      ORDER BY u.username LIMIT ?`,
    Number(viewer.id), ...v.params, Number(viewer.id),
    Number(viewer.id), Number(viewer.id), limit
  );
}

/**
 * Public accounts with the most public finished books.
 *
 * §2.1 — "counts are shown but never celebrated." So this is ordered and
 * deliberately UNNUMBERED, and the heading says widest rather than most. A
 * ranked list with the figures printed beside it is a leaderboard, and a
 * leaderboard is the thing that creates the behaviour this product refuses.
 */
export function widestShelves(viewer, { limit = 8 } = {}) {
  const v = V.visibleSQL(viewer, { owner: 'u' });
  return all(
    `${SELECT} FROM users u
      WHERE ${v.sql}
        AND ${V.ESTABLISHED_SQL('u')}
        AND u.profile_visibility = 'public'
        AND EXISTS (SELECT 1 FROM readings rc WHERE rc.user_id = u.id AND rc.status = 'FINISHED' AND rc.is_draft = 0 AND ${publicCountScope.sql})
      ORDER BY books_logged DESC, u.username LIMIT ?`,
    ...v.params, limit
  );
}

/**
 * Books this viewer and another reader both have.
 *
 * The overlap is the obvious half. The DISAGREEMENT is the interesting one,
 * and no reading product surfaces it: two people who both rated a book and
 * are three stars apart have more to say to each other than two who agree.
 */
export function sharedGround(viewerId, otherId) {
  if (!viewerId || Number(viewerId) === Number(otherId)) return null;

  const scope = V.visibleReadingSQL({ id: Number(viewerId), isMember: true }, { owner: 'u', entry: 'b' });
  const row = get(
    `SELECT COUNT(*) AS common,
            SUM(CASE WHEN a.stars IS NOT NULL AND b.stars IS NOT NULL
                      AND a.stars = b.stars THEN 1 ELSE 0 END) AS agreed
       FROM readings a JOIN readings b ON b.work_id = a.work_id
       JOIN users u ON u.id = b.user_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.is_draft = 0 AND b.is_draft = 0 AND ${scope.sql}`,
    Number(viewerId), Number(otherId), ...scope.params
  );

  const argument = get(
    `SELECT w.id, w.title, a.stars AS yours, b.stars AS theirs,
            ABS(a.stars - b.stars) AS gap
       FROM readings a JOIN readings b ON b.work_id = a.work_id
       JOIN users u ON u.id = b.user_id
       JOIN works w ON w.id = a.work_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.is_draft = 0 AND b.is_draft = 0 AND ${scope.sql}
        AND a.stars IS NOT NULL AND b.stars IS NOT NULL
      ORDER BY gap DESC LIMIT 1`,
    Number(viewerId), Number(otherId), ...scope.params
  );

  if (!row?.common) return null;
  return {
    common: row.common,
    agreed: row.agreed || 0,
    // Only worth printing when they actually disagree.
    argument: argument && argument.gap >= 2 ? argument : null
  };
}

// ── WHO ELSE IS ON THIS BOOK ─────────────────────────────
//
// The most-visited page type in the product was, by construction, a page
// where the reader was the only person who had ever been. Everything here
// is scoped per viewer, so a private reader cannot be inferred by
// subtracting one page view from another.

/**
 * Below this, a count is a name.
 *
 * "1 reading now" on a small install identifies the person and makes the
 * room look empty at the same time. Under the floor it reads as "a few",
 * which is true and says nothing about anybody.
 */
export const COUNT_FLOOR = 3;

export function onWork(workId, viewer) {
  const v = V.visibleReadingSQL(viewer, { owner: 'u', entry: 'r' });

  const counts = get(
    `SELECT
       SUM(CASE WHEN r.status = 'READING'  THEN 1 ELSE 0 END) AS reading,
       SUM(CASE WHEN r.status = 'FINISHED' THEN 1 ELSE 0 END) AS finished
       FROM readings r JOIN users u ON u.id = r.user_id
      WHERE r.work_id = ? AND r.is_draft = 0 AND ${v.sql}`,
    Number(workId), ...v.params
  ) || {};

  const vw = V.visibleSQL(viewer, { owner: 'u', shelf: 's', entry: 'si' });
  const waiting = get(
    `SELECT COUNT(*) n FROM shelf_items si
       JOIN shelves s ON s.id = si.shelf_id
       JOIN users u ON u.id = s.user_id
      WHERE si.work_id = ? AND s.name = 'WAITING' AND ${vw.sql}`,
    Number(workId), ...vw.params
  );

  // People on the reader's own rail who have this book. This is the section
  // that earns a follow, so it is gathered even when the aggregate is
  // suppressed.
  const rail = viewer?.id ? all(
    `SELECT u.username, u.display_name, r.status, r.stars, r.finished_at, r.current_page
       FROM readings r
       JOIN users u ON u.id = r.user_id
       JOIN user_follows f ON f.followee_id = u.id
      WHERE r.work_id = ? AND r.is_draft = 0
        AND f.follower_id = ? AND f.state = 'active' AND ${v.sql}
      ORDER BY (r.status = 'READING') DESC, r.finished_at DESC
      LIMIT 6`,
    Number(workId), Number(viewer.id), ...v.params
  ) : [];

  // Clubs that have picked it. A public club is listed; a private one is not
  // unless the viewer is in it — the club layer of visibleSQL does that.
  const vc = V.visibleSQL(viewer, {
    owner: 'c', ownerIdCol: 'c.host_id', accountGates: false, club: 'c'
  });
  const clubs = all(
    `SELECT DISTINCT c.slug, c.name, p.finished_at
       FROM club_picks p JOIN clubs c ON c.id = p.club_id
      WHERE p.work_id = ? AND c.archived_at IS NULL AND ${vc.sql}
      ORDER BY (p.finished_at IS NULL) DESC, p.created_at DESC LIMIT 4`,
    Number(workId), ...vc.params
  );

  return {
    reading: counts.reading || 0,
    finished: counts.finished || 0,
    waiting: waiting?.n || 0,
    rail,
    clubs,
    // True when there is anything at all worth drawing the band for.
    any: (counts.reading || 0) + (counts.finished || 0) + (waiting?.n || 0) +
         rail.length + clubs.length > 0
  };
}

/** "a few" under the floor, the number above it, nothing at zero. */
export const countWord = (n) =>
  !n ? null : n < COUNT_FLOOR ? 'a few' : String(n);
