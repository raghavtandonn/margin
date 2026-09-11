import { Router } from '../lib/router.js';
import { createHash } from 'node:crypto';
import * as h from '../lib/view-helpers.js';
import { stripFrom } from '../lib/colour.js';
import * as BC from '../lib/book-colour.js';
import * as W from '../lib/works.js';
import * as L from '../lib/library.js';
import * as OL from '../lib/openlibrary.js';
import * as READERS from '../lib/readers.js';
import * as COVERS from '../lib/covers.js';
import { get, all, run } from '../db/index.js';
import { normalizeISBN } from '../lib/artifacts.js';
import { shortBlurb } from '../lib/blurb.js';
import * as WALL from '../lib/wall.js';
import * as DESK from '../lib/desk.js';
import * as GAP from '../lib/gap.js';
import * as PACE from '../lib/pace.js';
import * as SEASONS from '../lib/seasons.js';
import * as STATS from '../lib/stats.js';
import { latestFor } from '../lib/latest.js';
import * as CLUBS from '../lib/clubs.js';
import * as PILE from '../lib/reco-pile.js';
import { requireAuth } from '../lib/auth/middleware.js';
import * as TRUST from '../lib/trust.js';
import * as LIMITS from '../lib/auth/ratelimit.js';
import { setNote, noteOf } from '../lib/notes.js';
import * as REVIEWS from '../lib/reviews.js';
import * as AGG from '../lib/aggregates.js';
import * as SAFE from '../lib/safety.js';
import * as FOLLOW from '../lib/following.js';
import * as audit from '../lib/audit.js';

const router = Router();

// The library is the signed-in reader's. `req.user` is set once, in
// lib/auth/middleware.js, from the session cookie — §13.4: the user id
// derives from the session and never from a parameter, a body, or a header.
//
// Every route below this point requires a signed-in reader. The public
// surface is routes/profile.js, which does its own visibility filtering;
// nothing here is reachable without an account.
router.use(requireAuth, (req, res, next) => {
  res.locals.settings = req.user.settings;
  res.locals.user = req.user;
  // B3 — the spine carries what is on press, on every screen.
  next();
});

// Shared catalogue corrections affect every reader and need established trust.
function requireCatalogueEditor(req, res, next) {
  if (!req.user.email_verified_at || TRUST.levelOf(req.user) < 2) {
    return res.status(403).render('error', { title: 'Not permitted', heading: 'Catalogue corrections need an established account.', detail: null });
  }
  if (!LIMITS.check('writeHourly', req.user.id).ok) return res.status(429).send('Try again later.');
  next();
}

// ── HOME / PROFILE ───────────────────────────────────────
/**
 * The jacket for the front page's lead plate.
 *
 * The book furthest in, because that is the one being read today. A book
 * with no jacket is skipped rather than shown as a galley plate: the whole
 * point of this slot is that it is a photograph, and standing a typographic
 * placeholder in the one image position on the page would be worse than
 * leaving it empty.
 */
function leadOf(reading) {
  const withCover = reading.filter((b) => b.cover_cache_key || b.cover_url);
  if (!withCover.length) return null;

  const measured = withCover.filter((b) => b.percent != null);
  if (measured.length) {
    return measured.reduce((a, b) => (b.percent > a.percent ? b : a));
  }
  // Nothing has a position logged, so "furthest in" is unanswerable and the
  // list order — most recently logged first — is the honest fallback.
  return withCover[0];
}

router.get('/', (req, res) => {
  // ── HOME ─────────────────────────────────────────────────
  //
  // Home and the profile are two pages with two different readers, and this
  // one used to try to be both. It was a stack of every other page in
  // miniature — in progress duplicated Reading, the shelf strips duplicated
  // Shelves, then stats and the receipt — which is why it was long without
  // being useful. A dashboard that reproduces the nav is just the nav again,
  // set larger.
  //
  // So: what is new, and what am I in the middle of. Everything else moved
  // to the page that already owned it. Who someone IS lives at /@handle,
  // where a visitor can actually reach it.

  const pace = PACE.getPace(req.user.id);
  const reading = L.getCurrentlyReading(req.user.id).map((b) => ({
    ...b,
    finishBy: PACE.finishBy(pace, b.current_page, b.totalPositions)
  }));

  // ── THE PIGEONHOLE, FOLDED IN ────────────────────────────
  //
  // Notifications had a nav item and a page of their own, and the page was
  // a list of things that happened, above a front page that is already a
  // list of things that happened. Two destinations for one idea, and the
  // one with your name on it was the one nobody visits.
  //
  // So they live here, in the order a person actually needs them:
  //
  //   waiting on you   somebody asked to follow you — the only thing in
  //                    the product that is blocked on an answer
  //   about you        replies, checkpoints, likes, grouped
  //   latest           what everyone else has been doing
  //
  // §10 still governs the contents: no streaks, no nudges, no count in the
  // navigation, and no "mark all as read". Reading them is what clears
  // them, which is now a side effect of opening the front page — which is
  // the correct behaviour for a thing you were never meant to tend.
  const notices = SAFE.groupNotifications(SAFE.notificationsFor(req.user.id));
  const requests = FOLLOW.pendingRequests(req.user.id);

  // Marked read AFTER the rows are read out, so the page you are looking at
  // still shows what was new when you opened it.
  SAFE.markRead(req.user.id);

  // ── WHAT IS WAITING ──────────────────────────────────────
  //
  // The pile, as one figure and a row of spines. It is the largest single
  // fact about this library — 337 books against 3 on press — and the front
  // page said nothing about it at all.
  //
  // Spines come from the editions that have a sampled colour; the rest are
  // simply not drawn, because a made-up colour on a shelf of real ones is a
  // lie about which books are which.
  const waitingRow = get(
    `SELECT COUNT(*) n, MIN(si.added_at) oldest
       FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
      WHERE s.user_id = ? AND s.slug = 'waiting'`,
    req.user.id
  );
  const waiting = waitingRow?.n ? {
    count: waitingRow.n,
    heldDays: waitingRow.oldest
      ? Math.floor((Date.now() - new Date(`${waitingRow.oldest}T00:00:00Z`)) / 86400000)
      : null,
    spines: all(
      `SELECT e.spine_color c
         FROM shelf_items si
         JOIN shelves s ON s.id = si.shelf_id
         JOIN editions e ON e.work_id = si.work_id
        WHERE s.user_id = ? AND s.slug = 'waiting' AND e.spine_color IS NOT NULL
        GROUP BY si.work_id
        ORDER BY si.added_at DESC LIMIT 12`,
      req.user.id
    ).map((r) => r.c)
  } : null;

  // ── NEXT FROM THE PILE ───────────────────────────────────
  //
  // The stored run, never a live query. Recommendations are generated by
  // `npm run reco:run` and frozen with their explanation; recomputing them on
  // page load would make the reason drift from the recommendation.
  //
  // This is content-based similarity ranking, NOT personalization — there is
  // no interaction data in this system to learn from. The card says what it
  // ranked on and never claims to have learned anything.
  const recos = PILE.latest(req.user.id, { limit: 3 });

  // The clubs you are in, with what each has on display. Two at most: this
  // is a pointer to the clubs page, not a second copy of it.
  const clubs = CLUBS.mine(req.user.id).slice(0, 2);

  // The open season, as one quiet line. Not a card, not a count-up: the
  // season page is where a season is looked at.
  const code = SEASONS.currentSeason().code;
  const season = SEASONS.seasonByCode(req.user.id, code);
  // From the frames, not from `seasons.colour_strip` — that cache predates
  // the colour system on every closed season and holds jacket hexes.
  let strip = [];
  try { strip = season ? stripFrom(SEASONS.framesOf(season.id)) : []; } catch { strip = []; }

  res.render('home', {
    title: 'Home',
    user: req.user,
    today: new Date(),
    // §8 — the feed is the lead. It is finite, it is chronological, and on a
    // single-reader install it says so rather than pretending to be busy.
    // Each entry carries how long ago it happened, as a phrase. The
    // template does no date arithmetic — it never has the timezone context
    // to do it correctly, and a feed that says TODAY for everything because
    // a helper was missing is worse than one with no timestamps at all.
    feed: latestFor(req.viewer).entries.map((e) => {
      const days = e.at ? Math.floor((Date.now() - new Date(String(e.at).replace(' ', 'T') + 'Z')) / 86400000) : null;
      return {
        ...e,
        ago: days == null ? '' : days <= 0 ? 'TODAY' : days === 1 ? 'YESTERDAY' : `${days} DAYS`
      };
    }),
    reading,
    notices,
    requests,
    // §3.1 — one jacket on the front page, at plate size. The book furthest
    // in, because that is the one being read today; ties and unknowns fall
    // back to the most recently logged, which `getCurrentlyReading` already
    // orders by. A book with no jacket is skipped rather than shown as a
    // galley: the point of this slot is that it is a photograph.
    lead: leadOf(reading),
    waiting,
    recos,
    clubs,
    // FOUR FEATURES §2, §3, §4 moved to the profile. They are an analysis
    // of one reader's library, and the profile is the page that is about a
    // reader; a front page that also carries a statistical read-out of its
    // own owner is the dashboard this page was rebuilt to stop being.
    season: season ? {
      ...season,
      short: SEASONS.parseCode(season.code)?.short || season.code.toUpperCase(),
      strip,
      // Counted from the readings themselves rather than from the season's
      // synced frames. Frames are written when a season is refreshed, so on
      // an OPEN season the frame count lags whatever was finished since —
      // and a line on the front page saying "three so far" when it is four
      // is worse than no line.
      count: get(
        `SELECT COUNT(*) n FROM readings
          WHERE user_id = ? AND status = 'FINISHED' AND is_draft = 0
            AND date(finished_at) BETWEEN ? AND ?`,
        req.user.id, season.starts_on, season.ends_on
      ).n
    } : null
  });
});

// ── THE BOOK PAGE (§09.1) ────────────────────────────────
router.get('/work/:id', (req, res) => {
  const work = W.getWork(req.params.id);
  if (!work) return res.status(404).render('404', { title: 'No such work' });

  const editions = W.getEditions(work.id);
  const reading = L.getReading(req.user.id, work.id);

  // A work can legitimately have no edition: an import that could not be
  // resolved still has a title, an author, and a rating.
  // §10 — "EDITION DATA UNAVAILABLE. WORK DATA SHOWN."
  const NO_EDITION = {
    id: null, isbn13: null, isbn10: null, publisher: null, published_year: null,
    page_count: null, format: null, cover_url: null, isbnFormatted: null,
    colophon: { credits: [] }
  };

  // The edition shown is, in order: the one asked for, the one you are
  // reading, the one you own, then the newest.
  const owned = get(
    `SELECT si.edition_id FROM shelf_items si
     JOIN shelves s ON s.id = si.shelf_id
     WHERE s.user_id = ? AND si.work_id = ? AND si.edition_id IS NOT NULL`,
    req.user.id,
    work.id
  );

  const requested = req.query.edition && editions.find((e) => e.id === Number(req.query.edition));
  const edition =
    requested ||
    editions.find((e) => e.id === reading?.edition_id) ||
    editions.find((e) => e.id === owned?.edition_id) ||
    // A2 — covers lead. With nothing else to go on, show an edition that
    // actually has one rather than the newest blank record.
    editions.find((e) => e.cover_url && e.page_count) ||
    editions.find((e) => e.cover_url) ||
    editions[0] ||
    NO_EDITION;

  // Only the colophon fields that exist. A heading over one blank row
  // announces its own emptiness.
  const c = edition.colophon || { credits: [] };
  const jacket = (c.credits || []).find(
    (x) => x.role === 'JACKET_DESIGN' || x.role === 'COVER_ILLUSTRATION'
  );
  const colophonRows = [
    edition.format && { label: 'FORMAT', value: edition.format },
    edition.page_count && { label: 'PAGES', value: edition.page_count },
    work.first_published_year && { label: 'FIRST', value: work.first_published_year },
    edition.publisher && { label: 'PUBLISHER', value: edition.publisher },
    edition.published_year && { label: 'PRINTED', value: edition.published_year },
    c.set_in && { label: 'SET IN', value: c.set_in },
    c.paper && { label: 'PAPER', value: c.paper },
    c.printer && { label: 'PRINTER', value: c.printer },
    ...(c.credits || [])
      .filter((x) => x !== jacket)
      .map((x) => ({ label: x.role.replace(/_/g, ' '), value: x.name }))
  ].filter(Boolean);

  // Sixty words or three sentences — enough to remember what a book is.
  // Nothing here writes one: no description means no slot.
  const blurb = shortBlurb(work.blurb);

  // §5 — the distribution is the evidence; the median is the number.
  const aggregate = AGG.display(work.id);
  aggregate.max = Math.max(1, ...aggregate.distribution);

  // Who else is on this book. The aggregate was already being computed and
  // was never rendered; the counts, the rail and the clubs are new.
  const here = READERS.onWork(work.id, req.viewer);

  // §7 — ranked per viewer, so there is no single top slot to attack.
  const ranked = REVIEWS.topForWork(work.id, req.viewer, { limit: 5 });
  const liked = new Set(
    all(`SELECT review_id FROM review_likes WHERE user_id = ?`, req.user.id).map((r) => r.review_id)
  );
  // Replies are fetched per review rather than counted and lazily loaded:
  // one level deep and five reviews to a page means the whole thread is
  // smaller than the page it sits on.
  for (const r of [...ranked.following, ...ranked.top]) {
    r.liked = liked.has(r.id);
    r.replies = REVIEWS.repliesFor(r.id, req.viewer);
  }

  // Which shelves this book is on, and all the shelves it could be on.
  const shelves = L.getShelves(req.user.id).map((sh) => ({
    ...sh,
    on: !!get('SELECT 1 AS x FROM shelf_items WHERE shelf_id = ? AND work_id = ?', sh.id, work.id)
  }));

  res.render('book', {
    shelves,
    agg: aggregate,
    here,
    reviews: ranked,
    // §6 — how far this reader has got, for the spoiler comparison.
    viewerProgress: REVIEWS.progressOf(req.user.id, work.id),
    myReview: get('SELECT id FROM reviews WHERE user_id = ? AND work_id = ? AND deleted_at IS NULL',
                  req.user.id, work.id),
    hasNote: !!(reading && noteOf(reading)),
    work,
    editions,
    edition,
    jacket,
    colophonRows,
    blurb,
    blurbSourceLabel: work.blurb_source === 'reader'
      ? 'YOUR DESCRIPTION'
      : `FROM ${(edition.publisher || 'THE PUBLISHER').toUpperCase()}${edition.published_year ? ' ' + edition.published_year : ''}`,
    ownedEditionId: owned?.edition_id ?? null,
    pressings: L.getPassages(req.user.id, work.id),
    reading,
    // The colour system: the blend, its components, and each one's citation.
    // Resolved in one place so no template ever decides what a book shows.
    colour: BC.effective(work),
    justFinished: req.query.finished === '1',
    permalink: `${req.protocol}://${req.get('host')}/work/${work.id}`
  });
});

// ── SHELVES (§09.2) ──────────────────────────────────────
router.get('/shelves', (req, res) => {
  const shelves = L.getShelves(req.user.id);
  const previews = {};
  for (const s of shelves) {
    previews[s.slug] = L.getShelfItems(req.user.id, s.id, 'ADDED').slice(0, 24);
  }
  res.render('shelves', { shelves, previews });
});

router.post('/shelves', (req, res) => {
  // Every failure here used to be silent: INSERT OR IGNORE swallowed a
  // duplicate, and a name with no ASCII letters slugged to the empty string
  // and redirected to /shelf/ — a 404 on a shelf that had in fact been
  // created. Both read as "it did not save".
  const out = L.createShelf(req.user.id, req.body.name);

  if (!out.ok) {
    const shelves = L.getShelves(req.user.id);
    const previews = {};
    for (const sh of shelves) previews[sh.slug] = L.getShelfItems(req.user.id, sh.id, 'ADDED').slice(0, 24);
    return res.status(400).render('shelves', {
      shelves, previews, error: out.error, name: req.body.name || ''
    });
  }

  res.redirect(`/shelf/${out.shelf.slug}`);
});

/** Make a shelf and put this book on it, from the book's own page. */
router.post('/work/:id/shelve/new', (req, res) => {
  const back = req.get('referer') || `/work/${req.params.id}`;
  const out = L.createShelf(req.user.id, req.body.name);

  // An existing shelf by that name is not an error here — it is what the
  // reader meant. Put the book on it.
  const shelf = out.ok ? out.shelf : out.shelf;
  if (!shelf) return res.redirect(back);

  L.addToShelf(req.user.id, shelf.slug, req.params.id, null);
  res.redirect(back);
});

router.post('/shelf/:slug/rename', (req, res) => {
  L.renameShelf(req.user.id, req.params.slug, req.body.name);
  res.redirect(`/shelf/${req.params.slug}`);
});

router.post('/shelf/:slug/delete', (req, res) => {
  const out = L.deleteShelf(req.user.id, req.params.slug);
  res.redirect(out.ok ? '/shelves' : `/shelf/${req.params.slug}`);
});

router.get('/shelf/:slug', (req, res) => {
  const shelf = L.getShelf(req.user.id, req.params.slug);
  if (!shelf) return res.status(404).render('404', { title: 'No such shelf' });

  const sort = L.SORT_KEYS.includes(req.query.sort) ? req.query.sort : 'ADDED';
  const views = ['COVERS', 'LIST'];
  const view = views.includes(req.query.view) ? req.query.view : 'COVERS';
  let items = L.getShelfItems(req.user.id, shelf.id, sort);

  // Filters arriving from the derived blocks (§2 histogram, §3 deltas).
  const filters = [];
  if (req.query.rating) {
    const v = Number(req.query.rating);
    items = items.filter((i) => Number(i.stars) === v);
    filters.push(`${v}★`);
  }
  if (req.query.decade) {
    const d = Number(req.query.decade);
    items = items.filter((i) => i.first_published_year >= d && i.first_published_year < d + 10);
    filters.push(`${d}s`);
  }
  if (req.query.pages) {
    const band = String(req.query.pages);
    const inBand = (p) =>
      p == null ? false
      : band.includes('UNDER 250') ? p < 250
      : band.includes('250') ? p >= 250 && p < 400
      : band.includes('400') ? p >= 400 && p < 600
      : band.includes('600') ? p >= 600
      : true;
    items = items.filter((i) => inBand(i.page_count));
    filters.push(band);
  }
  if (req.query.publisher) {
    const pub = String(req.query.publisher).toLowerCase();
    items = items.filter((i) => String(i.publisher || '').toLowerCase() === pub);
    filters.push(req.query.publisher);
  }

  const pace = PACE.getPace(req.user.id);

  res.render('shelf', {
    // Surface C — the shelf clock (§1).
    clock: PACE.shelfClock(pace, items),
    pace,
    filters,
    shelf,
    shelves: L.getShelves(req.user.id),
    items,
    sort,
    view,
    sortKeys: L.SORT_KEYS
  });
});

// ── "THE WALL" (§5) ──────────────────────────────────────
router.get('/wall', (req, res) => {
  const scope = WALL.WALL_SCOPES.includes(req.query.scope) ? req.query.scope : 'FINISHED';
  const group = WALL.WALL_GROUPS.includes(req.query.group) ? req.query.group : 'NONE';
  const sort = WALL.WALL_SORTS.includes(req.query.sort) ? req.query.sort : 'ADDED';

  const books = WALL.wallBooks(req.user.id, { sort, scope });

  // Rows wrap at container width, left to right, last row ragged. Packed
  // here so the shelf boards land in the right places without a layout pass
  // in the browser.
  const ROW_WIDTH = 1160;
  const pack = (list) => {
    const rows = [];
    let row = [];
    let used = 0;
    for (const b of list) {
      const w = (b.state === 'READING' ? b.geometry.height : b.geometry.width) + 2;
      if (used + w > ROW_WIDTH && row.length) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push(b);
      used += w;
    }
    if (row.length) rows.push(row);
    return rows;
  };

  const shelves = WALL.groupWall(books, group).map((g) => ({
    label: g.label,
    rows: pack(g.books)
  }));

  res.render('wall', {
    books,
    shelves,
    scope,
    group,
    sort,
    scopes: WALL.WALL_SCOPES,
    groups: WALL.WALL_GROUPS,
    sorts: WALL.WALL_SORTS,
    asList: req.query.view === 'list'
  });
});

// ── READING (§09.3) ──────────────────────────────────────
router.get('/reading', (req, res) => {
  res.render('reading', { books: L.getCurrentlyReading(req.user.id) });
});

// ── "THE GAP" ────────────────────────────────────────────
// One book per month. There is no refresh, and a dismissed Gap does not
// return until next month — the constraint is the feature.
router.get('/gap', (req, res) => {
  res.render('gap', { gap: GAP.currentGap(req.user.id) });
});

router.post('/gap/add', (req, res) => {
  const g = GAP.currentGap(req.user.id);
  if (g) {
    // Bringing it in is the one action; resolving it properly is the
    // existing import path, not a special case.
    OL.importWork(g.book.ol_key)
      .then((r) => { if (r.ok) L.addToShelf(req.user.id, 'waiting', r.workId, null); })
      .catch(() => {});
    GAP.markAdded();
  }
  res.redirect('/gap');
});

router.post('/gap/dismiss', (req, res) => {
  GAP.dismissGap();
  res.redirect('/');
});

// ── "THE DESK" ───────────────────────────────────────────
// Browser history is the transcript: every query pushes /desk?q=… and Back
// returns through previous states. That is why there is no history panel —
// and why one must not be built.
router.get('/desk', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const views = ['COVERS', 'LIST'];
  const view = views.includes(req.query.view) ? req.query.view : (req.user.settings.deskView || 'COVERS');

  // Readers, alongside works. The desk was labelled "Search the library"
  // and returned books only, so a query that was plainly a person — a
  // handle, a name — came back as books or as nothing. A leading @ means
  // the reader already knows who they want.
  const readers = q.length >= 2 ? READERS.search(req.viewer, q, { limit: 5 }) : [];

  if (!q) {
    return res.render('desk', { q: '', rows: [], view, candidates: [], readers: [] });
  }

  // Local only is the default. Tiers 0–2 never leave the machine.
  const localOnly = req.user.settings.local_only !== false;
  const result = await DESK.searchAsync(req.user.id, q, { localOnly });

  // The one thing the desk cannot do is bring a book in, so a miss offers
  // exactly that and nothing else.
  let candidates = [];
  if (!result.rows.length && !result.query.unsupportedField && !result.query.isCommand && q.length > 2) {
    try {
      candidates = await OL.search(q, { limit: 5 });
      const known = new Set(
        candidates.map((c) => c.isbn13).filter(Boolean)
          .filter((i) => get('SELECT 1 AS x FROM editions WHERE isbn13 = ?', i))
      );
      candidates = candidates.filter((c) => !c.isbn13 || !known.has(c.isbn13));
    } catch { /* offline: the miss simply stays a miss */ }
  }

  res.render('desk', {
    q,
    rows: result.rows,
    view,
    caption: result.caption,
    // What the sentence was actually understood to mean. A result that
    // looks wrong is either a misread query or bad catalogue data, and
    // without this the reader cannot tell which.
    filters: DESK.appliedFilters(result.query),
    candidates
  });
});

// Tier 0 as you type. No dropdown is rendered from this — it exists so the
// field can be answered without a round trip when the reader wants it.
router.get('/desk/suggest', (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(
    DESK.tier0(req.user.id, q, { limit: 8 }).map((r) => ({
      id: r.work_id, title: r.title, author: r.authorLine
    }))
  );
});

// Pull a work out of Open Library and into the graph.
router.post('/add', async (req, res) => {
  const result = await OL.importWork(req.body.workKey);
  if (!result.ok) return res.redirect(`/search?q=${encodeURIComponent(req.body.q || '')}`);

  if (req.body.shelf) {
    L.addToShelf(req.user.id, req.body.shelf, result.workId, null);
  }
  res.redirect(`/work/${result.workId}`);
});

// ── COVER PROXY (§3.3) ───────────────────────────────────
// Covers are served from our own origin rather than hotlinked, so a slow day
// at Open Library does not leave the app with no visuals — and so "THE WALL"
// can read cover pixels on a canvas without CORS tainting.
router.get('/cover/:key.jpg', async (req, res) => {
  const key = req.params.key;
  const cached = COVERS.readCached(key);

  if (cached) {
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(cached.buf);
  }

  // Not on disk yet: fetch it once from the recorded source, then serve.
  const ed = get('SELECT cover_url FROM editions WHERE cover_cache_key = ? LIMIT 1', key);
  if (ed?.cover_url) {
    const stored = await COVERS.cacheFromURL(ed.cover_url);
    const now = stored && COVERS.readCached(stored);
    if (now) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(now.buf);
    }
  }

  // The galley plate is the terminal state; a 404 lets the img onerror fire.
  res.status(404).end();
});

// A proxy for Open Library covers that are not yet in the local cache —
// the Gap's monthly pick, and anything imported but not yet enriched.
//
// The id is the ONLY thing accepted. Taking a URL here and fetching it would
// be a server-side request forgery hole with a friendly name: an attacker
// posts `?url=http://169.254.169.254/…` and the server fetches it from
// inside the network.
const olCoverProxy = (build) => async (req, res) => {
  const url = build(req.params);
  if (!url) return res.status(404).end();

  const key = COVERS.cacheKey(url);
  const cached = COVERS.readCached(key) || (await COVERS.cacheFromURL(url), COVERS.readCached(key));

  if (!cached) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cached.buf);
};

router.get('/cover/ol/:id.jpg', olCoverProxy(({ id }) =>
  /^\d{1,12}$/.test(id) ? `https://covers.openlibrary.org/b/id/${id}-L.jpg?default=false` : null));

router.get('/cover/isbn/:isbn.jpg', olCoverProxy(({ isbn }) =>
  /^[0-9]{9}[0-9Xx]$|^[0-9]{13}$/.test(isbn)
    ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false` : null));

// ── B2 CAPTURE ───────────────────────────────────────────
// Scan → resolve → shelved. Two interactions, no page change.
router.post('/capture/isbn', async (req, res) => {
  const isbn = normalizeISBN(req.body.isbn);
  if (!isbn) return res.json({ ok: false, error: 'NOT A VALID ISBN' });

  try {
    let ed = get('SELECT * FROM editions WHERE isbn13 = ?', isbn);

    if (!ed) {
      const data = await OL.byISBN(isbn);
      if (!data) {
        return res.json({ ok: false, error: 'NOT ON OPEN LIBRARY' });
      }
      let workId = data.workKey
        ? get('SELECT id FROM works WHERE ol_key = ?', data.workKey)?.id
        : null;

      if (!workId && data.workKey) {
        const imported = await OL.importWork(data.workKey);
        workId = imported.ok ? imported.workId : null;
      }
      if (!workId) {
        workId = W.createWork({ title: data.title, authors: [] });
      }
      if (!get('SELECT id FROM editions WHERE isbn13 = ?', isbn)) {
        W.addEdition(workId, data);
      }
      ed = get('SELECT * FROM editions WHERE isbn13 = ?', isbn);
    }

    const work = W.getWork(ed.work_id);
    // Default shelf is WAITING (B2's confirmation sheet defaults).
    L.addToShelf(req.user.id, req.body.shelf || 'waiting', work.id, ed.id);

    res.json({
      ok: true,
      workId: work.id,
      title: work.title,
      author: work.authorLine,
      cover: ed.cover_url,
      shelf: req.body.shelf || 'waiting'
    });
  } catch (err) {
    res.json({ ok: false, error: 'LOOKUP FAILED' });
  }
});

// "REGISTER" — manual entry, immediately usable by its creator.
router.post('/capture/register', (req, res) => {
  const title = String(req.body.title || '').trim();
  const author = String(req.body.author || '').trim();
  // Back to the desk, which is where the form is. This used to redirect to
  // `/capture`, a page that has never existed — so the one way to see this
  // branch was to get a 404 for filling the form in wrong.
  if (!title || !author) {
    return res.redirect('/desk?q=' + encodeURIComponent(title || author || ''));
  }

  const workId = W.createWork({ title, authors: [author] });
  const editionId = W.addEdition(workId, {
    isbn13: req.body.isbn13 || null,
    publisher: req.body.publisher || null,
    page_count: req.body.pageCount ? Number(req.body.pageCount) : null,
    format: 'PAPERBACK'
  });

  // Any shelf of THEIRS, not just the three built-in ones. Hard-coding the
  // system slugs here meant a book registered by hand could never land on a
  // shelf the reader had made — it silently went to WAITING instead.
  const asked = String(req.body.shelf || '').trim();
  const shelf = asked && L.getShelf(req.user.id, asked) ? asked : 'waiting';

  if (shelf === 'reading') {
    L.startReading(req.user.id, workId, editionId, { format: req.body.format || 'print' });
  } else {
    L.addToShelf(req.user.id, shelf, workId, editionId);
  }

  res.redirect(`/work/${workId}?stamped=1`);
});

// ── PEOPLE ───────────────────────────────────────────────
router.get('/person/:id', (req, res) => {
  const person = W.getPerson(req.params.id);
  if (!person) return res.status(404).render('404', { title: 'No such person' });

  const roles = [
    ...new Set([
      ...(person.written.length ? ['AUTHOR'] : []),
      ...person.credits.map((c) => c.role.replace(/_/g, ' '))
    ])
  ];

  const following = !!get(
    `SELECT 1 AS x FROM follows WHERE user_id = ? AND entity = 'person' AND entity_id = ?`,
    req.user.id,
    person.id
  );

  res.render('person', { person, roles, following });
});

router.post('/person/:id/follow', (req, res) => {
  const id = Number(req.params.id);
  const existing = get(
    `SELECT 1 AS x FROM follows WHERE user_id = ? AND entity = 'person' AND entity_id = ?`,
    req.user.id,
    id
  );
  if (existing) {
    run(`DELETE FROM follows WHERE user_id = ? AND entity = 'person' AND entity_id = ?`, req.user.id, id);
  } else {
    run(`INSERT INTO follows (user_id, entity, entity_id) VALUES (?, 'person', ?)`, req.user.id, id);
  }
  res.redirect(`/person/${id}`);
});

// ── ACTIONS ──────────────────────────────────────────────
//
// The rating is stars on the pass, and it is still never a colour. That
// constraint has not been relaxed by the colour system: a rating is a
// verdict on the reading and the colour is the residue the book left, and
// they are stored, rendered and edited apart so that neither can be mistaken
// for the other. POST /work/:id/colour is the other one.
router.post('/work/:id/rate', (req, res) => {
  // 0 from the range control means UNRATED, exactly as a Goodreads 0 does.
  const stars = Number(req.body.stars) > 0 ? Number(req.body.stars) : null;
  L.rate(req.user.id, req.params.id, stars, { review: req.body.review });
  res.redirect(`/work/${req.params.id}`);
});

// §1.2 - a private note on the pass. Yours only.
router.post('/work/:id/note', (req, res) => {
  L.setPrivateNote(req.user.id, req.params.id, req.body.note);
  res.redirect(`/work/${req.params.id}`);
});

router.post('/work/:id/start', (req, res) => {
  L.startReading(req.user.id, req.params.id, W.editionBelongsTo(req.params.id, req.body.editionId));
  res.redirect(`/work/${req.params.id}?stamped=1`);
});

// ── B3 "THE IMPRESSION COUNTER" ──────────────────────────
router.post('/work/:id/log', (req, res) => {
  const requestId = req.get('x-reading-request-id');
  const queueOwner = req.get('x-reading-owner');
  if (requestId || queueOwner) {
    if (queueOwner !== req.user.public_id) return res.status(409).json({ ok: false, error: 'ACCOUNT_CHANGED' });
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) return res.status(400).json({ ok: false });
  }
  const requestHash = requestId ? createHash('sha256').update(JSON.stringify([
    String(req.params.id), String(req.body.position ?? ''), String(req.body.advance ?? ''), String(req.body.when ?? '')
  ])).digest('hex') : null;
  const back = req.get('referer') || `/work/${req.params.id}`;
  try {
    const current = L.getReading(req.user.id, req.params.id);
    // The +10/+25/+50 estimate buttons advance from the last position rather
    // than asking for a delta — position is always stored cumulatively.
    const advance = Number(req.body.advance);
    const position = Number.isFinite(advance) && advance > 0
      ? (current?.current_page || 0) + advance
      : req.body.position;

    // Backdating is a primary path (B7).
    let occurredAt = null;
    const when = Number(req.body.when);
    if (Number.isFinite(when) && when < 0) {
      const d = new Date();
      d.setDate(d.getDate() + when);
      occurredAt = d.toISOString().slice(0, 19).replace('T', ' ');
    }

    L.logSession(req.user.id, req.params.id, position, {
      occurredAt, clientRequestId: requestId, clientRequestHash: requestHash
    });
    PACE.refreshPace(req.user.id);

    // "On press" saves on blur, so it wants an answer rather than a page.
    if (requestId || req.get('x-requested-with') === 'fetch') {
      const after = L.getReading(req.user.id, req.params.id);
      return res.json({
        ok: true,
        requestId: requestId || null,
        position: after ? String(Math.round(after.current_page)) : null,
        percent: after ? after.percent : null
      });
    }
  } catch (err) {
    if (requestId || req.get('x-requested-with') === 'fetch') {
      return res.status(400).json({ ok: false });
    }
    /* the screen re-renders whatever state actually holds */
  }
  res.redirect(back);
});

/** Correct a work's first-published year. See lib/works.js for why. */
router.post('/work/:id/first-published', requireCatalogueEditor, (req, res) => {
  const back = req.get('referer') || `/work/${req.params.id}`;
  try {
    const year = W.setFirstPublished(req.params.id, req.body.year ?? '');
    if (req.get('x-requested-with') === 'fetch') return res.json({ ok: true, year });
  } catch (err) {
    if (req.get('x-requested-with') === 'fetch') {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
  res.redirect(back);
});

/**
 * How long this copy is.
 *
 * Saved the same way the page number is — blur, JSON, no reload — because
 * it sits beside the page number and behaves like it. The clamp lives in
 * the library layer, so a hand-written POST is bounded exactly as the
 * interface is.
 */
router.post('/work/:id/extent', (req, res) => {
  const back = req.get('referer') || `/work/${req.params.id}`;
  try {
    const after = L.setExtent(req.user.id, req.params.id, req.body.total ?? '');
    if (req.get('x-requested-with') === 'fetch') {
      return res.json({
        ok: true,
        total: after?.totalPositions ?? null,
        position: after ? String(Math.round(after.current_page)) : null,
        percent: after ? after.percent : null
      });
    }
  } catch (err) {
    if (req.get('x-requested-with') === 'fetch') {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }
  res.redirect(back);
});

// Kept as an alias: the book page still posts a plain position.
router.post('/work/:id/progress', (req, res) => {
  try {
    L.logSession(req.user.id, req.params.id, req.body.page);
  } catch { /* not reading */ }
  res.redirect(req.get('referer') || `/work/${req.params.id}`);
});

/** Throw away a pass that should not have been started. */
router.post('/work/:id/discard', (req, res) => {
  const back = req.get('referer') || `/work/${req.params.id}`;
  const out = L.discardPass(req.user.id, req.params.id, req.body.pass ?? null);

  if (!out.ok) {
    return res.status(400).render('error', {
      title: 'Kept', heading: 'That one stays.', detail: out.error, back
    });
  }
  res.redirect(`/work/${req.params.id}`);
});

router.post('/work/:id/finish', (req, res) => {
  try {
    L.finishReading(req.user.id, req.params.id);
  } catch { /* no open pass */ }
  // The rating is offered on arrival, never demanded. Skipping leaves the
  // book finished and unrated, which is a permanently valid state.
  res.redirect(`/work/${req.params.id}?finished=1`);
});

router.post('/work/:id/abandon', (req, res) => {
  L.abandonReading(req.user.id, req.params.id, req.body.page);
  res.redirect(`/work/${req.params.id}?stamped=1`);
});

router.post('/work/:id/due', (req, res) => {
  try {
    L.setDue(req.user.id, req.params.id, req.body.date);
  } catch { /* not reading; the page reflects current state */ }
  res.redirect('/reading');
});

/**
 * Put a book on a shelf, or take it off.
 *
 * This route existed and NOTHING POSTED TO IT. There was no control
 * anywhere in the product for putting a book you already own onto a shelf
 * you made — the only ways onto a shelf were importing from Open Library,
 * scanning an ISBN, or registering a book by hand, and two of those three
 * accepted only the built-in shelves. Making a shelf and then adding a book
 * to it was not a thing the interface could do.
 */
router.post('/work/:id/shelve', (req, res) => {
  const back = req.get('referer') || `/work/${req.params.id}`;
  const slug = String(req.body.shelf || '').trim();

  // The shelf has to be one of THEIRS. getShelf is already scoped by user,
  // so a slug from another account resolves to nothing and this refuses.
  const shelf = L.getShelf(req.user.id, slug);
  if (!shelf) {
    if (req.get('x-requested-with') === 'fetch') return res.status(404).json({ ok: false });
    return res.redirect(back);
  }

  const on = req.body.on !== '0';
  if (on) {
    L.addToShelf(req.user.id, shelf.slug, req.params.id,
                 W.editionBelongsTo(req.params.id, req.body.editionId));
  } else {
    L.removeFromShelf(req.user.id, shelf.slug, req.params.id);
  }

  if (req.get('x-requested-with') === 'fetch') {
    return res.json({ ok: true, shelf: shelf.slug, on });
  }
  res.redirect(back);
});

// ── SETTINGS ─────────────────────────────────────────────
//
// Served by routes/settings.js, which is mounted ahead of this file and has
// been answering /settings for a while. The version that used to live here
// rendered views/settings.ejs, whose form posted to a POST /settings that
// does not exist — so had the mount order ever changed, the settings page
// would have become a form that silently 404s on save. Both are gone.
//
// Three toggles went with them and have no home on the current settings
// pages: library card, log duration, and ragged right. `local only` is on
// /settings/privacy. Whether the other three come back is a product
// decision, not something to leave behind a dead route.

// ── EXPORT (§12) ─────────────────────────────────────────
// One click, open format. Your reading life is not a hostage.
router.get('/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="margin-export.json"');
  res.json(L.exportAll(req.user.id));
});

router.get('/export.csv', (req, res) => {
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="margin-export.csv"');
  res.send(L.exportCSV(req.user.id));
});

// ── API DOCS ─────────────────────────────────────────────
router.get('/api', (req, res) => {
  res.render('api', {
    endpoints: [
      {
        name: '"WORKS"',
        routes: [
          { method: 'GET', path: '/api/search?q=wuthering', desc: 'Typo-tolerant trigram search. Returns the ranking reason with every hit.' },
          { method: 'GET', path: '/api/work/1', desc: 'A work: title, authors, series position, aggregate print.' },
          { method: 'GET', path: '/api/work/1/editions', desc: 'Every edition, with its colophon and credits.' },
          { method: 'GET', path: '/api/work/1/prints', desc: 'Every reader print, with imports flagged as imports.' },
          { method: 'GET', path: '/api/work/1/passes', desc: 'Every reading pass, each with its own dates and rating.' }
        ]
      },
      {
        name: '"PEOPLE"',
        routes: [
          { method: 'GET', path: '/api/person/1', desc: 'A person and their catalog — including jacket design credits.' },
          { method: 'GET', path: '/api/series/1', desc: 'A series in correct reading order.' }
        ]
      },
      {
        name: '"READERS"',
        routes: [
          { method: 'GET', path: '/api/user/you/shelves', desc: 'Public shelves for a reader.' },
          { method: 'GET', path: '/api/user/you/receipt', desc: 'The receipt: line items and totals for a year.' }
        ]
      },
      {
        name: '"DROPS"',
        routes: [{ method: 'GET', path: '/api/drops', desc: 'The release schedule, grouped by month.' }]
      }
    ]
  });
});

export default router;
