import { Router } from '../lib/router.js';
import { get, all } from '../db/index.js';
import * as V from '../lib/visibility.js';
import { findByUsername } from '../lib/accounts.js';
import { noindex } from '../lib/security.js';
import * as F from '../lib/following.js';
import * as R from '../lib/reviews.js';
import * as READERS from '../lib/readers.js';
import * as STATS from '../lib/stats.js';
import * as A from '../lib/accounts.js';
import * as SEASONS from '../lib/seasons.js';

const router = Router();

// ── §9 / §10 — the public profile ────────────────────────
//
// Mounted last, after every real route, so a username can never shadow one.
// The reserved list in lib/accounts.js is the first defence; ordering is the
// second, because a route added later would otherwise silently become
// reachable as somebody's profile.
//
// Every query on this page goes through visibleSQL. §10.2 is the reason:
// "Never fetch everything and hide in the template — that leaks through the
// API, through JSON endpoints, through OG tags, and through the search index."

router.get('/@:username', (req, res) => {
  const user = findByUsername(req.params.username);

  // §9 — "Returns 404 — not 403 — for private profiles, so existence isn't
  // leaked." A 403 is itself the answer to "does this person have an account".
  if (!V.profileVisibleTo(user, req.viewer)) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // §10 — public and indexable are different states. Anything not explicitly
  // marked indexable carries the header and stays out of the sitemap.
  const indexable = user.profile_visibility === 'public' && !!user.search_indexable;
  if (!indexable) noindex(res);

  const vShelf = V.visibleSQL(req.viewer, { owner: 'u', shelf: 'sh' });
  const shelves = all(
    `SELECT sh.id, sh.name, sh.slug, sh.visibility,
            (SELECT COUNT(*) FROM shelf_items si2
              JOIN shelves sh2 ON sh2.id = si2.shelf_id
             WHERE si2.shelf_id = sh.id) AS total
       FROM shelves sh
       JOIN users u ON u.id = sh.user_id
      WHERE u.id = ? AND ${vShelf.sql}
      ORDER BY sh.is_system DESC, sh.name`,
    user.id, ...vShelf.params
  );

  const vItem = V.visibleSQL(req.viewer, { owner: 'u', shelf: 'sh', entry: 'si' });

  // §10.5 — "never render private counts, even aggregated, on a public
  // page." So the count on each shelf is the count of what THIS viewer may
  // see, not the true total. A shelf reading "12 books" to a stranger and
  // "40" to the owner would leak the 28 by subtraction.
  for (const s of shelves) {
    s.count = get(
      `SELECT COUNT(*) n FROM shelf_items si
         JOIN shelves sh ON sh.id = si.shelf_id
         JOIN users u ON u.id = sh.user_id
        WHERE si.shelf_id = ? AND ${vItem.sql}`,
      s.id, ...vItem.params
    ).n;
    delete s.total;
  }

  const recent = all(
    `SELECT w.id, w.title, e.cover_url, e.cover_cache_key,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM readings r
       JOIN users u ON u.id = r.user_id
       JOIN works w ON w.id = r.work_id
       -- Most readings never named an edition, and the lowest-id one is
       -- usually the one without artwork — which is why this page was a
       -- wall of text plates instead of jackets. Prefer the edition that
       -- actually has a cover, the same way every other surface does.
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), e2.id LIMIT 1))
       LEFT JOIN shelves sh ON sh.user_id = u.id AND sh.slug = 'finished'
      WHERE u.id = ? AND r.status = 'FINISHED' AND r.is_draft = 0
        AND ${V.visibleReadingSQL(req.viewer, { owner: 'u', entry: 'r' }).sql}
      -- Five. It was twelve, which at this cover size wrapped to a row and
      -- a half — a shape that reads as a grid that ran out rather than as a
      -- decision. Five is one row, and "lately" is a glance, not an
      -- archive: the whole library is one click away on the Finished shelf.
      ORDER BY r.finished_at DESC LIMIT 5`,
    user.id, ...V.visibleReadingSQL(req.viewer, { owner: 'u', entry: 'r' }).params
  );

  // §2.1.2 — what they are reading now, subject to the same scope as
  // everything else on the page.
  const vPress = V.visibleReadingSQL(req.viewer, { owner: 'u', entry: 'r' });
  const onPressPublic = all(
    `SELECT w.id, w.title, e.cover_url, e.cover_cache_key,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM readings r
       JOIN users u ON u.id = r.user_id
       JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), e2.id LIMIT 1))
      WHERE u.id = ? AND r.status = 'READING' AND r.is_draft = 0 AND ${vPress.sql}
      ORDER BY r.started_at DESC LIMIT 4`,
    user.id, ...vPress.params
  );

  // ── FAVOURITES ──────────────────────────────────────────
  //
  // This replaces THE STATEMENT — a separate table of hand-pinned works
  // with its own controls on every book page. The argument for it was that
  // a Favourites shelf is "a filing decision, not a sentence about who
  // somebody is". That was wrong twice over: readers already keep a
  // favourites shelf and already mean exactly that by it, and the pins
  // table held zero rows because nobody is going to curate a second,
  // parallel list of their favourite books to satisfy a distinction the
  // product invented.
  //
  // So: the shelf they already keep, shown at plate size at the top of
  // their profile. Matched on slug, so "FAVORITES" and "FAVOURITES" both
  // find it, and absent entirely for anyone who does not keep one.
  const favShelf = get(
    `SELECT id, name, slug FROM shelves
      WHERE user_id = ? AND slug IN ('favorites', 'favourites') LIMIT 1`,
    user.id
  );

  const vFav = V.visibleSQL(req.viewer, { owner: 'u', shelf: 'sh', entry: 'si' });
  const favourites = favShelf ? all(
    `SELECT w.id, w.title, e.cover_url, e.cover_cache_key,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM shelf_items si
       JOIN shelves sh ON sh.id = si.shelf_id
       JOIN users u ON u.id = sh.user_id
       JOIN works w ON w.id = si.work_id
       LEFT JOIN editions e ON e.id = COALESCE(si.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), e2.id LIMIT 1))
      WHERE si.shelf_id = ? AND ${vFav.sql}
      ORDER BY si.added_at DESC, si.id DESC LIMIT 6`,
    favShelf.id, ...vFav.params
  ) : [];

  // §2.1.4 — closed seasons only. An open one is not reviewable mid-show.
  const seasons = all(
    `SELECT code, label, given_title FROM seasons
      WHERE user_id = ? AND state = 'closed' AND note IS NOT NULL
      ORDER BY starts_on DESC LIMIT 6`,
    user.id
  ).map((s) => ({ ...s, given_title: Number(req.viewer?.id) === Number(user.id) ? s.given_title : null, short: SEASONS.parseCode(s.code)?.short || s.code }));

  let host = null;
  try { host = user.link ? new URL(user.link).host : null; } catch { host = null; }

  // ── The stat row ─────────────────────────────────────
  //
  // Letterboxd puts FILMS / THIS YEAR / FOLLOWING / FOLLOWERS across the top
  // of a profile and it is the fastest read on the page: four numbers that
  // say what kind of reader this is before you scroll.
  //
  // Both book counts go through the SAME scope as everything else here, so
  // they are counts of what THIS viewer may see. §10.5 — "never render
  // private counts, even aggregated, on a public page." A profile reading
  // 411 to its owner and 40 to a stranger would leak 371 by subtraction, and
  // a headline number is the easiest place in the world to leak one.
  const vCount = V.visibleReadingSQL(req.viewer, { owner: 'u', entry: 'r' });
  const booksVisible = get(
    `SELECT COUNT(*) n FROM readings r JOIN users u ON u.id = r.user_id
      WHERE u.id = ? AND r.status = 'FINISHED' AND r.is_draft = 0 AND ${vCount.sql}`,
    user.id, ...vCount.params
  ).n;
  const thisYear = get(
    `SELECT COUNT(*) n FROM readings r JOIN users u ON u.id = r.user_id
      WHERE u.id = ? AND r.status = 'FINISHED' AND r.is_draft = 0
        AND strftime('%Y', r.finished_at) = strftime('%Y', 'now') AND ${vCount.sql}`,
    user.id, ...vCount.params
  ).n;

  const isSelf = Number(req.viewer?.id) === Number(user.id);

  // ── THE DATA STRIP ────────────────────────────────────────
  //
  // These three figures used to sit across the foot of the front page. They
  // are an analysis of one reader's library, and the profile is the page
  // that is about a reader, so this is where they belong.
  //
  // THEY ARE PUBLIC, AND §10.5 STILL HOLDS.
  //
  // The rule is "never render private counts, even aggregated, on a public
  // page", and these were owner-only because they counted the whole library,
  // private shelves included. Hiding the panel was one way to obey that.
  // Scoping the query is the better one: every figure is now computed
  // through the same `visibleSQL` scope as the rest of this page, so a
  // stranger's histogram is drawn only from the entries that stranger is
  // already allowed to read, and the owner still sees their own whole
  // library. Nothing is withheld, and nothing private is counted.
  //
  // The consequence worth stating: two people can see different numbers on
  // the same profile, and both are correct. A count of what you may see is
  // the only count that can be shown to everyone.
  const viewerScope = isSelf ? null : (req.viewer || V.ANONYMOUS);

  res.render('profile', {
    title: user.display_name || `@${user.username}`,
    counts: F.counts(user.id),
    isSelf,
    // ── THE STATEMENT ──
    // Four books at plate size, chosen by hand. The Favourites shelf was
    // never this: a row in a list next to "TESTING" is a filing decision,
    // not a claim about who somebody is.
    favourites,
    favShelf,
    // ── WHAT THEY LIKE ──
    // The most characterful thing the product computes, and it lived on a
    // private home page where only its subject could see it. Opt-in, off by
    // default, and shown to the owner even when it is off so they can see
    // what they would be publishing.
    taste: STATS.whatYouLike(user.id, { viewer: viewerScope }),
    tastePublic: !!user.taste_public,
    dist: STATS.ratingDistribution(user.id, { viewer: viewerScope }),
    when: STATS.whenYouRead(user.id, { viewer: viewerScope }),
    // ── SHARED GROUND ──
    // The overlap is the obvious half. The DISAGREEMENT is the interesting
    // one, and no reading product surfaces it.
    ground: req.viewer?.id && !isSelf ? READERS.sharedGround(req.viewer.id, user.id) : null,
    rel: F.relationship(req.viewer?.id, user.id),
    muted: req.viewer?.id ? V.hasMuted(req.viewer.id, user.id) : false,
    onPressPublic,
    seasons,
    reviews: R.byUser(user.id, req.viewer, { limit: 4 }),
    profile: {
      username: user.username,
      display_name: user.display_name,
      bio: user.bio,
      location: user.location,
      link: user.link,
      avatar_key: user.avatar_key,
      id: user.id,
      pronouns: user.pronouns,
      host,
      // §9 — "never notes, never email, never real name unless typed into
      // display name, never counts of private items." Nothing else is
      // carried onto this page, so nothing else can be rendered by mistake.
      joined: String(user.created_at || '').slice(0, 4)
    },
    isSelf,
    stat: { books: booksVisible, thisYear },
    shelves,
    recent,
    robots: indexable ? null : 'noindex, nofollow'
  });
});

// ── §10 / §15 — robots ───────────────────────────────────
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    [
      'User-agent: *',
      // Everything that is not a profile is private by nature.
      'Disallow: /settings',
      'Disallow: /staff',
      'Disallow: /api/',
      'Disallow: /desk',
      'Disallow: /export',
      'Disallow: /signin',
      'Disallow: /signup',
      'Disallow: /reset',
      'Disallow: /verify',
      '',
      '# §15 — profiles are crawlable only when their owner has asked for it.',
      '# The allowlist below is generated from accounts that are both public',
      '# and explicitly indexable; everything else under /@ is disallowed.',
      'Disallow: /@',
      ...all(
        `SELECT username FROM users
          WHERE profile_visibility = 'public' AND search_indexable = 1
            AND email_verified_at IS NOT NULL AND deleted_at IS NULL
            AND deactivated_at IS NULL AND is_tombstone = 0
            AND username IS NOT NULL
          ORDER BY username`
      ).map((u) => `Allow: /@${u.username}`),
      '',
      `Sitemap: ${(process.env.MARGIN_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/sitemap.xml`
    ].join('\n')
  );
});

router.get('/sitemap.xml', (req, res) => {
  const base = (process.env.MARGIN_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  // §10 — only accounts that are public AND indexable. A public-but-not-
  // indexable profile is a legitimate state and must not appear here.
  const users = all(
    `SELECT username, updated_at FROM users
      WHERE profile_visibility = 'public' AND search_indexable = 1
        AND email_verified_at IS NOT NULL AND deleted_at IS NULL
        AND deactivated_at IS NULL AND is_tombstone = 0 AND username IS NOT NULL`
  );

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    users.map((u) =>
      `  <url><loc>${base}/@${encodeURIComponent(u.username)}</loc>` +
      (u.updated_at ? `<lastmod>${String(u.updated_at).slice(0, 10)}</lastmod>` : '') +
      `</url>`
    ).join('\n') +
    `\n</urlset>\n`
  );
});

// §16 — "/.well-known/security.txt with a contact address and disclosure
// policy." A researcher who cannot find where to report will report
// somewhere worse.
router.get('/.well-known/security.txt', (req, res) => {
  const base = (process.env.MARGIN_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString();
  res.type('text/plain').send(
    [
      `Contact: ${process.env.MARGIN_SECURITY_CONTACT || 'mailto:security@example.invalid'}`,
      `Expires: ${expires}`,
      `Preferred-Languages: en`,
      `Canonical: ${base}/.well-known/security.txt`,
      `Policy: ${base}/security`,
      '',
      '# Reports are read by a person. There is no bounty and no NDA.',
      '# Please give us 90 days before publishing.'
    ].join('\n')
  );
});

export default router;
