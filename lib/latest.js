import { all, sqlTime } from '../db/index.js';
import * as V from './visibility.js';

// ── §8 — LATEST ──────────────────────────────────────────
//
// "The riskiest thing in this document is a feed. Feeds are where products
// go to become slot machines. Build a bounded one."
//
// So every property of this file is a refusal:
//
//   reverse-chronological     no ranking, no engagement weighting, ever
//   people you follow only    no discovery, no suggested accounts
//   seven days, 100 entries   it ENDS; there is no infinite scroll
//   no like counts here       you see those on the review
//   no reshares               frictionless amplification is what drives
//                             pile-ons, so the mechanic does not exist
//
// And read-time fanout, per §10 of the security spec: the follow graph is
// queried when the page loads. Write-time push would mean one action by a
// widely-followed account writing hundreds of thousands of rows, which is
// both a cost problem and a denial-of-service primitive.

const DAYS = 7;
const MAX_ENTRIES = 100;

/**
 * §8 — entry types are a closed list.
 *
 * Deliberately absent: "started reading" and "added to Waiting". Shelving
 * activity is noise, and it is exactly how Goodreads' feed became
 * unreadable.
 */
export function latestFor(viewer, { now = Date.now() } = {}) {
  if (!viewer?.id) return { entries: [], ended: true };

  const since = sqlTime(now - DAYS * 86_400_000);

  // The scope carries blocks, so a blocked account is mutually absent from
  // Latest without this file knowing anything about blocks.
  const v = V.visibleReadingSQL(viewer, { owner: 'u', entry: 'r' });
  const vr = V.visibleSQL(viewer, { owner: 'u', entry: 'rev' });
  const vs = V.visibleSQL(viewer, { owner: 'u' });

  // §8 — "Only people you follow, plus clubs you're in." Not yourself:
  // your own reading is in the rail beside this, and a feed that reports
  // your activity back to you is the shape that turns into a scoreboard.
  const followed = `
    EXISTS (SELECT 1 FROM user_follows f
             WHERE f.follower_id = ? AND f.followee_id = u.id AND f.state = 'active')`;
  const me = [Number(viewer.id)];

  // Muted accounts are absent from the feed and from nowhere else — a mute
  // severs nothing, it just stops you seeing them here.
  const notMuted = `NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = ? AND m.muted_id = u.id)`;

  const finished = all(
    `SELECT 'finished' AS kind, u.id AS user_id, u.username, u.display_name, u.avatar_key,
            w.id AS work_id, w.title, r.stars, r.finished_at AS at,
            e.cover_url, e.cover_cache_key, e.season_colour,
            -- §8 — "finished a book (with rating and caption if public)".
            -- The review column is the short public line. private_note is
            -- never read here and never will be.
            r.review AS caption
       FROM readings r
       JOIN users u ON u.id = r.user_id
       JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.season_colour IS NULL), (e2.cover_cache_key IS NULL), e2.id LIMIT 1))
      WHERE r.status = 'FINISHED' AND r.is_draft = 0
        AND r.finished_at >= ? AND ${followed} AND ${notMuted} AND ${v.sql}`,
    since, ...me, Number(viewer.id), ...v.params
  );

  const reviewed = all(
    `SELECT 'review' AS kind, u.id AS user_id, u.username, u.display_name, u.avatar_key,
            w.id AS work_id, w.title, rev.rating AS stars, rev.published_at AS at,
            rev.id AS review_id, rev.body AS caption, e.season_colour
       FROM reviews rev
       JOIN users u ON u.id = rev.user_id
       JOIN works w ON w.id = rev.work_id
       LEFT JOIN editions e ON e.id =
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.season_colour IS NULL), e2.id LIMIT 1)
      WHERE rev.deleted_at IS NULL AND rev.published_at >= ?
        AND rev.contains_spoilers = 0
        AND ${followed} AND ${notMuted} AND ${vr.sql}`,
    since, ...me, Number(viewer.id), ...vr.params
  );

  const seasons = all(
    `SELECT 'season' AS kind, u.id AS user_id, u.username, u.display_name, u.avatar_key,
            s.code, s.label AS title, s.closed_at AS at
       FROM seasons s
       JOIN users u ON u.id = s.user_id
      WHERE s.state = 'closed' AND s.closed_at >= ? AND s.note IS NOT NULL
        AND ${followed} AND ${notMuted} AND ${vs.sql}`,
    since, ...me, Number(viewer.id), ...vs.params
  );

  const clubs = all(
    `SELECT 'club' AS kind, u.id AS user_id, u.username, u.display_name, u.avatar_key,
            c.slug, c.name AS title, cm.joined_at AS at
       FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id
       JOIN users u ON u.id = cm.user_id
      WHERE cm.state = 'active' AND cm.joined_at >= ?
        AND c.visibility = 'public' AND c.archived_at IS NULL
        AND ${followed} AND ${notMuted} AND ${vs.sql}`,
    since, ...me, Number(viewer.id), ...vs.params
  );

  // Announcements and pick changes from clubs the VIEWER is in — these come
  // from a club rather than from a followed person.
  const va = V.visibleSQL(viewer, { owner: 'u', accountGates: false });
  const announcements = all(
    `SELECT 'announcement' AS kind, u.id AS user_id, u.username, u.display_name, u.avatar_key,
            c.slug, c.name AS club_name, p.body AS title, p.created_at AS at
       FROM club_posts p
       JOIN clubs c ON c.id = p.club_id
       JOIN users u ON u.id = p.user_id
       JOIN club_members mine ON mine.club_id = c.id AND mine.user_id = ? AND mine.state = 'active'
      WHERE p.kind = 'announcement' AND p.deleted_at IS NULL AND p.created_at >= ?
        AND u.deleted_at IS NULL AND u.deactivated_at IS NULL AND u.is_tombstone = 0 AND ${va.sql}`,
    Number(viewer.id), since, ...va.params
  );

  const all_ = [...finished, ...reviewed, ...seasons, ...clubs, ...announcements]
    .filter((e) => e.at)
    .map((e) => ({ ...e, caption: firstSentence(e.caption) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return {
    entries: group(all_).slice(0, MAX_ENTRIES),
    // §8 — "the page finishes." There is nothing below the end.
    ended: true,
    days: DAYS
  };
}

/**
 * §8 — "Group multiple entries from one person in one day into a single
 * entry." Six books finished on a Sunday is one line, not six.
 */
function group(entries) {
  const out = [];
  const byKey = new Map();

  for (const e of entries) {
    const day = String(e.at).slice(0, 10);
    const key = `${e.user_id}:${e.kind}:${day}`;

    if (byKey.has(key)) {
      byKey.get(key).items.push(e);
      continue;
    }
    const entry = { ...e, day, items: [e] };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

/**
 * One sentence, or nothing.
 *
 * A feed entry carries a line, not an essay — the review itself is one click
 * away and that is where it should be read. Cutting at a sentence boundary
 * rather than at a character count means nothing ever ends mid-word with an
 * ellipsis, which always reads as a truncation bug.
 */
function firstSentence(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const m = /^.{20,180}?[.?!](?=\s|$)/.exec(t);
  if (m) return m[0];
  return t.length <= 180 ? t : null;
}
