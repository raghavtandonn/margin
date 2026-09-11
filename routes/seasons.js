import { seal } from '../lib/crypto.js';
import { Router } from '../lib/router.js';
import { get, all, run, nowSQL } from '../db/index.js';
import * as S from '../lib/seasons.js';
import * as RUN from '../lib/season-run.js';
import * as M from '../lib/movements.js';
import * as V from '../lib/visibility.js';
import { stripFrom } from '../lib/colour.js';
import { findByUsername } from '../lib/accounts.js';
import { noindex } from '../lib/security.js';
import { requireAuth } from '../lib/auth/middleware.js';
import * as audit from '../lib/audit.js';
import { posterPNG } from '../lib/poster.js';

const router = Router();

const localOnlyFor = (user) => user?.settings?.local_only !== false;

// Everything the lookbook needs, assembled once.
function lookbook(userId, row, { viewer = null } = {}) {
  // Never reuse owner-only generated text or aggregate facts publicly.
  if (viewer) row = { ...row, given_title: null, note: null, facts: null, colour_strip: null };
  const meta = S.parseCode(row.code);
  const facts = safeJSON(row.facts) || {};
  const frames = S.framesOf(row.id, { viewer }).filter((f) => !f.hidden);
  const movements = viewer ? [] : M.movementsOf(row.id);

  const byMovement = movements.map((m) => ({
    ...m,
    roman: M.roman(m.ordinal),
    books: frames.filter((f) => f.movement_id === m.id)
  }));

  // §7.5 — abandonments listed plainly after the last movement.
  const absences = (facts.behaviour?.abandonments?.books) || [];

  return {
    row, meta, facts, frames,
    movements: byMovement,
    // Frames not in any movement — an open season, or one with no structure.
    loose: movements.length ? frames.filter((f) => !f.movement_id) : frames,
    absences,
    colophon: RUN.colophon(facts, frames),
    // Computed from the frames, never read back from `seasons.colour_strip`.
    //
    // The stored strip is written once when a season closes, and every
    // closed season here was closed before the colour system existed — so
    // it holds jacket-extraction hexes. The poster read that cache while the
    // lookbook computed live, and the two drew completely different
    // pictures of S/S 25: green, navy, black and olive on the printed sheet
    // against purple, slate and a hatch on the page.
    //
    // A strip is derived data. Caching it bought nothing and went stale the
    // moment the thing it derives from changed.
    strip: stripFrom(frames),
    shape: RUN.shapeOf(frames.length, facts.ranked?.length || 0),
    canRegenerate: RUN.canRegenerate(row)
  };
}

const safeJSON = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

// ── THE INDEX ────────────────────────────────────────────
router.get('/seasons', requireAuth, async (req, res) => {
  // Keeps the open season current, and closes anything whose end has passed.
  await RUN.closeDue(req.user.id, { localOnly: localOnlyFor(req.user) });

  const rows = S.listSeasons(req.user.id).map((r) => {
    const frames = S.framesOf(r.id);
    return {
      ...r,
      short: S.parseCode(r.code)?.short || r.code,
      count: frames.length,
      // Live, for the same reason the season page is. A stale cache on the
      // index would have shown one set of colours in the contact sheet and
      // another on the page it links to.
      strip: stripFrom(frames),
      // §3.2 — the seasons index had zero images on it: thirteen seasons of
      // reading, rendered as thirteen rows of type and a colour bar. These
      // are the jackets, so the page becomes a contact sheet of the years
      // rather than a table of contents for them.
      //
      // Frames without a jacket are dropped rather than shown as galley
      // plates. At this size a plate is a grey rectangle with unreadable
      // type on it, and a row of those reads as loading, not as design.
      plates: frames.filter((f) => f.cover_cache_key || f.cover_url).slice(0, 8)
    };
  });

  res.render('seasons', {
    title: 'Seasons',
    seasons: rows,
    undated: S.undatedCount(req.user.id),
    current: S.currentSeason().code
  });
});

// ── ONE SEASON ───────────────────────────────────────────
router.get('/season/:code', requireAuth, async (req, res) => {
  const meta = S.parseCode(req.params.code);
  if (!meta) return res.status(404).render('404', { title: 'Not found' });

  // An open season is kept live; a closed one is served as it was written.
  const existing = S.seasonByCode(req.user.id, meta.code);
  if (!existing || existing.state === 'open') {
    await RUN.refresh(req.user.id, meta.code, { localOnly: localOnlyFor(req.user) });
  }

  const row = S.seasonByCode(req.user.id, meta.code);
  if (!row) return res.status(404).render('404', { title: 'Not found' });

  res.render('season', {
    title: meta.label, ...lookbook(req.user.id, row),
    isOwner: true, viewerIsPublic: false,
  });
});

// ── §11 — EDITING ────────────────────────────────────────
// "Four controls, no more."

// 1. Hide a book from the lookbook.
router.post('/season/:code/frame/:readingId/hide', requireAuth, (req, res) => {
  const row = S.seasonByCode(req.user.id, req.params.code);
  if (!row) return res.status(404).render('404', { title: 'Not found' });

  const wanted = req.body.hidden === '0' ? 0 : 1;
  run('UPDATE season_frames SET hidden = ? WHERE season_id = ? AND reading_id = ?',
      wanted, row.id, Number(req.params.readingId));

  audit.userAction(req, 'season.frame.hidden', { metadata: { code: row.code, hidden: !!wanted } });
  res.redirect(`/season/${row.code}`);
});

// 2. Pin which note line is the caption.
router.post('/season/:code/frame/:readingId/caption', requireAuth, (req, res) => {
  const row = S.seasonByCode(req.user.id, req.params.code);
  if (!row) return res.status(404).render('404', { title: 'Not found' });

  // §7 — verbatim, never rewritten. Only the cap is applied.
  const line = String(req.body.caption || '').split(/\n/)[0].trim().slice(0, 120) || null;
  run('UPDATE season_frames SET caption = ? WHERE season_id = ? AND reading_id = ?',
      seal(line), row.id, Number(req.params.readingId));

  res.redirect(`/season/${row.code}`);
});

/**
 * The poster, as a PNG.
 *
 * `?shape=` picks the trim: story, feed or square. The season page and the
 * lookbook both link here, and the file is generated on request rather than
 * stored, because a poster is derived from the season and a stored one goes
 * stale the moment a frame is hidden.
 */
const SHAPES = new Set(['story', 'feed', 'square']);
const shapeParam = (req) => {
  const want = String(req.query.shape || req.query.size || 'story').toLowerCase();
  return SHAPES.has(want) ? want : 'story';
};

router.get('/season/:code/poster.png', requireAuth, async (req, res) => {
  const meta = S.parseCode(req.params.code);
  const row = meta && S.seasonByCode(req.user.id, meta.code);
  if (!row || row.state !== 'closed') return res.status(404).end();

  const data = lookbook(req.user.id, row);
  const png = await posterPNG({
    // No fallback to the label here: the poster prints AUTUMN / WINTER 25
    // above the title now, and setting it twice — once at 22px and once at
    // 128 — was the first thing that looked wrong. An untitled season gets
    // its count spelled out instead.
    title: row.given_title || '',
    code: meta.short,
    label: meta.label,
    count: data.frames.length,
    // The whole note, not its first sentence: the poster does its own
    // reading, and it sets the last sentence it keeps in full ink.
    note: row.note,
    strip: data.strip,
    shape: shapeParam(req)
  });

  if (!png) return res.status(503).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(png);
});

// ── §10 — THE PUBLIC URL ─────────────────────────────────
// `/@username/aw26`, respecting the same visibleTo scope as everything else.
export const publicRouter = Router();

/**
 * Mounted before the profile router, so these have to be excluded by hand:
 * `/@you/following` would otherwise be read as a season code, fail to parse,
 * and 404 a page that exists. `next()` rather than a 404 hands it on to the
 * router that does own it.
 */
const RESERVED = new Set(['followers', 'following', 'reviews', 'shelves', 'clubs']);

publicRouter.get('/@:username/:code', (req, res, next) => {
  if (RESERVED.has(req.params.code)) return next();

  const meta = S.parseCode(req.params.code);
  if (!meta) return next();

  const user = findByUsername(req.params.username);
  if (!V.profileVisibleTo(user, req.viewer)) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const isSelf = Number(req.viewer?.id) === Number(user.id);
  const row = S.seasonByCode(user.id, meta.code);

  // A season is only a collection once it has closed; a visitor gets no
  // catalogue of a show still running.
  if (!row || (row.state !== 'closed' && !isSelf)) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  noindex(res);
  res.render('season', {
    title: meta.label, ...lookbook(user.id, row, { viewer: isSelf ? null : req.viewer }),
    isOwner: isSelf, viewerIsPublic: !isSelf,
    username: user.username
  });
});

export default router;
