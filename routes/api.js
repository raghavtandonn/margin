import { Router } from '../lib/router.js';
import * as W from '../lib/works.js';
import * as L from '../lib/library.js';
import * as V from '../lib/visibility.js';
import { all, get } from '../db/index.js';
import { findByUsername } from '../lib/accounts.js';

// §12 — a public read API, documented, rate-limited, free for non-commercial
// use. Goodreads killed theirs in 2020 and the ecosystem died with it.

const router = Router();

// Rate limit: 60/min per address, and the remaining count is always in the
// headers. Never a silent throttle.
const WINDOW = 60_000;
const LIMIT = 60;
const hits = new Map();
setInterval(() => {
  for (const [ip, entry] of hits) if (Date.now() > entry.reset) hits.delete(ip);
}, WINDOW).unref();

router.use((req, res, next) => {
  const key = req.ip;
  if (!hits.has(key) && hits.size >= 10000) return res.status(429).json({ error: 'TRY AGAIN LATER' });
  const now = Date.now();
  const entry = hits.get(key) || { count: 0, reset: now + WINDOW };

  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + WINDOW;
  }
  entry.count++;
  hits.set(key, entry);

  res.set('X-RateLimit-Limit', String(LIMIT));
  res.set('X-RateLimit-Remaining', String(Math.max(0, LIMIT - entry.count)));
  res.set('X-RateLimit-Reset', new Date(entry.reset).toISOString());

  if (entry.count > LIMIT) {
    return res.status(429).json({
      error: 'RATE LIMIT EXCEEDED',
      reset: new Date(entry.reset).toISOString()
    });
  }
  next();
});

// CORS is open for the CATALOGUE — works, editions, people, series — because
// an ecosystem needs it to be, and none of it belongs to anybody.
//
// It is NOT open for reader data. §15: a public API "must enforce the same
// visibleTo scope as the web app", and a wildcard origin on somebody's shelf
// is the opposite of that. Reader endpoints below are same-origin only, and
// filtered through lib/visibility.js on top.
const CATALOGUE = /^\/(search|work|edition|person|series|)$|^\/(work|edition|person|series)\//;

router.use((req, res, next) => {
  if (CATALOGUE.test(req.path) && !/\/passes$/.test(req.path)) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Vary', 'Origin, Cookie');
  next();
});

router.get('/', (req, res) => {
  res.json({
    api: 'margin/v1',
    endpoints: [
      'GET /api/search?q=',
      'GET /api/work/:id',
      'GET /api/work/:id/editions',
      'GET /api/edition/:id',
      'GET /api/person/:id',
      'GET /api/series/:id',
      'GET /api/user/:handle/shelves',
      'GET /api/user/:handle/receipt?year=',
      'GET /api/work/:id/passes'
    ],
    terms: 'Free for non-commercial use. 60 req/min.'
  });
});

router.get('/search', (req, res) => {
  const started = performance.now();
  const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 25)));
  const results = W.search(String(req.query.q || '').slice(0, 400), { limit });
  res.json({
    query: req.query.q || '',
    elapsed_ms: Number((performance.now() - started).toFixed(2)),
    count: results.length,
    results: results.map((w) => ({
      id: w.id,
      title: w.title,
      authors: w.authors.map((a) => a.name),
      first_published_year: w.first_published_year,
      editions: w.editionCount,
      rank_reason: w.rankReason,
      cover: w.cover?.cover_url || null
    }))
  });
});

router.get('/work/:id', (req, res) => {
  const work = W.getWork(req.params.id);
  if (!work) return res.status(404).json({ error: 'NO SUCH WORK.' });
  res.json({
    ...work,
    editions: W.getEditions(work.id).length
  });
});

router.get('/work/:id/editions', (req, res) => {
  res.json(W.getEditions(req.params.id));
});

router.get('/edition/:id', (req, res) => {
  const e = W.getEdition(req.params.id);
  if (!e) return res.status(404).json({ error: 'NO SUCH EDITION.' });
  res.json(e);
});

router.get('/person/:id', (req, res) => {
  const p = W.getPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'NO SUCH PERSON.' });
  res.json(p);
});

router.get('/series/:id', (req, res) => {
  const s = W.getSeries(req.params.id);
  if (!s) return res.status(404).json({ error: 'NO SUCH SERIES.' });
  res.json(s);
});

// ── READER ENDPOINTS ─────────────────────────────────────
// Every one of these resolves the reader the same way and refuses the same
// way: 404, never 403, so the API cannot be used to discover which accounts
// exist or which are private.
function readerFor(req, res) {
  const u = findByUsername(req.params.handle);
  if (!V.profileVisibleTo(u, req.viewer)) {
    res.status(404).json({ error: 'NO SUCH READER.' });
    return null;
  }
  return u;
}

router.get('/user/:handle/shelves', (req, res) => {
  const u = readerFor(req, res);
  if (!u) return;

  // Filtered in SQL, exactly as the web app does it. Internal ids are not
  // part of the answer — a public shelf is a name, a slug, and a count.
  const v = V.visibleSQL(req.viewer, { owner: 'usr', shelf: 'sh' });
  const shelves = all(
    `SELECT sh.slug, sh.name, sh.public_id
       FROM shelves sh JOIN users usr ON usr.id = sh.user_id
      WHERE usr.id = ? AND ${v.sql}
      ORDER BY sh.is_system DESC, sh.name`,
    u.id, ...v.params
  );

  const vi = V.visibleSQL(req.viewer, { owner: 'usr', shelf: 'sh', entry: 'si' });
  res.json(shelves.map((sh) => ({
    ...sh,
    // §10.5 — the count of what THIS viewer may see. A true total would
    // reveal the private entries by subtraction.
    item_count: get(
      `SELECT COUNT(*) n FROM shelf_items si
         JOIN shelves sh ON sh.id = si.shelf_id
         JOIN users usr ON usr.id = sh.user_id
        WHERE sh.slug = ? AND usr.id = ? AND ${vi.sql}`,
      sh.slug, u.id, ...vi.params
    ).n
  })));
});

// Every pass on a work: a re-read has its own dates and its own rating.
//
// This used to read `getUser(1)` — a hard-coded id — and so served the first
// account's private reading history to anyone who asked. Reading passes are
// personal data with no owner in the URL, so the only correct owner is the
// session's.
router.get('/work/:id/passes', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'SIGN IN REQUIRED.' });
  res.json(
    L.getPassages(req.user.id, req.params.id).map((p) => ({
      pass: p.pass_number,
      status: p.status,
      stars: p.stars,
      started_at: p.started_at,
      finished_at: p.finished_at,
      abandoned_at: p.abandoned_at,
      sessions: p.sessions.length
    }))
  );
});

router.get('/user/:handle/receipt', (req, res) => {
  const u = readerFor(req, res);
  if (!u) return;

  res.json(L.getReceipt(u.id, {
    year: Number(req.query.year) || undefined,
    viewer: req.viewer
  }));
});

export default router;
