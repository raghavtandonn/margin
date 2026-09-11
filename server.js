import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

import pages from './routes/pages.js';
import api from './routes/api.js';
import auth from './routes/auth.js';
import settings from './routes/settings.js';
import profile from './routes/profile.js';
import staff from './routes/staff.js';
import seasons, { publicRouter as seasonsPublic } from './routes/seasons.js';

import * as helpers from './lib/view-helpers.js';
import { starGlyphs, starText } from './lib/stars.js';
import { trimAspect } from './lib/artifacts.js';
import { readableOn, SCALE as WALL_SCALE } from './lib/wall.js';
import { summarise as importSummary } from './lib/import.js';
import { spoilerState } from './lib/reviews.js';
import community from './routes/community.js';
import clubs from './routes/clubs.js';
import lookbook from './routes/lookbook.js';
import { cookies, headers, csrf } from './lib/security.js';
import { attach } from './lib/auth/middleware.js';
import * as SAFE from './lib/safety.js';
import * as READERS from './lib/readers.js';
import { installConsoleScrubber, forReporter } from './lib/scrub.js';
import { db, run } from './db/index.js';
import { startJobs } from './lib/jobs.js';
import { check as rateLimit } from './lib/auth/ratelimit.js';

const root = dirname(fileURLToPath(import.meta.url));
const app = express();

// §11 / §16 — installed before anything else can log. A careless
// `console.log(user)` anywhere downstream is filtered on the way out.
installConsoleScrubber();

app.set('view engine', 'ejs');
app.set('views', join(root, 'views'));
// Express trusts no proxy by default, which would make every req.ip the
// proxy's. Only enable it where a proxy is actually in front, or the header
// becomes a way to forge an address past the rate limiter.
if (process.env.MARGIN_TRUST_PROXY) app.set('trust proxy', process.env.MARGIN_TRUST_PROXY);
app.locals.db = { run };

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

// Assets are fingerprinted by mtime, so they can be cached hard — but CSS
// and JS must never be served stale after an edit. A one-hour cache once
// meant every fix was invisible for an hour.
app.use(express.static(join(root, 'public'), { maxAge: 0, etag: true }));

// ── §13 — the security stack, before any route ───────────
app.use(cookies);
app.use(headers);       // §13.1 — CSP nonce, HSTS, frame-ancestors, the rest
app.use(csrf);          // §13.2 — signed double-submit on every write
app.use(attach);        // the session, resolved exactly once

// Per-request template state.
app.use((req, res, next) => {
  res.locals.nonce = res.locals.nonce || '';
  // Collected by h.rule() during render, emitted once in a nonced <style>.
  res.locals.styleRules = [];

  // Whether there is anything unread. A BOOLEAN, never a count:
  // §11's NEVER SENT list refuses the whole engagement toolkit, and a number
  // on a bell is the thin end of it. Presence is enough to make somebody
  // look; a tally is what makes them anxious about the size of it.
  res.locals.hasUnread = false;
  if (req.user) {
    try { res.locals.hasUnread = SAFE.unreadCount(req.user.id) > 0; }
    catch { /* the nav must render whether or not this can be answered */ }
  }
  next();
});

const assetStamp = (rel) => {
  try { return String(Math.floor(statSync(join(root, 'public', rel)).mtimeMs)); }
  catch { return '0'; }
};
app.locals.v = {
  css: assetStamp('css/margin.css'),
  fonts: assetStamp('css/fonts.css'),
  js: assetStamp('js/app.js')
};

app.locals.h = {
  ...helpers, starGlyphs, starText, trimAspect,
  readableOn, wallScale: WALL_SCALE, importSummary, spoilerState,
  // "Ida and 2 others" — the pigeonhole folds repeats into one row.
  actorLine: SAFE.actorLine,
  // "a few" under three, the number above it. A count that small is a name.
  countWord: READERS.countWord
};

// ── §13.1 — CSP violation collection ─────────────────────
// The policy ships in Report-Only and is promoted to enforcing once this is
// quiet. Reports are the evidence for that decision, not decoration.
const cspSeen = new Map();
app.post('/csp-report', express.json({ type: ['application/csp-report', 'application/json'], limit: '16kb' }), (req, res) => {
  if (!rateLimit('cspReport', req.ip).ok) return res.status(429).end();
  const r = req.body?.['csp-report'] || req.body || {};
  // Store directive counts, never user-controlled URLs that can contain
  // reset tokens, private queries, or arbitrary log text.
  const key = String(r['effective-directive'] || r['violated-directive'] || 'unknown').replace(/[^a-z-]/g, '').slice(0, 48);
  if (!cspSeen.has(key) && cspSeen.size >= 64) return res.status(204).end();
  const n = (cspSeen.get(key) || 0) + 1;
  cspSeen.set(key, n);
  // Log the first of each kind. A misconfigured policy otherwise floods.
  if (n === 1) console.warn(`  CSP — ${key}`);
  res.status(204).end();
});
app.get('/csp-report/summary', (req, res) => {
  if (!req.user?.is_owner) return res.status(404).end();
  res.json(Object.fromEntries(cspSeen));
});

app.use('/api', api);
app.use('/', auth);
app.use('/', settings);
app.use('/staff', staff);
// profile.js owns /@username, robots.txt, sitemap.xml and security.txt, none
// of which can collide with a route (every profile path starts with "@").
// It must come BEFORE pages.js, which requires a session for everything that
// reaches it — mounted after, the whole public surface redirected to /signin.
// Season pages before the profile router, so /@user/aw26 is matched by
// the season route rather than swallowed by /@:username.
app.use('/', seasonsPublic);
app.use('/', profile);
app.use('/', community);
app.use('/', clubs);
app.use('/', lookbook);
app.use('/', seasons);
app.use('/', pages);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not found' });
});

app.use((err, req, res, next) => {
  // §19 — nothing reaching a log or a reporter carries a token, a password,
  // or a note body.
  if (err?.status === 404) return res.status(404).render('404', { title: 'Not found' });
  console.error(forReporter(err, { path: req.path, method: req.method }));
  res.status(500).render('error', {
    title: 'Record unavailable',
    heading: 'That did not come back.',
    detail: 'The request failed on this end. Nothing was changed.'
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`MARGIN`);
  console.log(`http://localhost:${port}`);
  const mode = process.env.MARGIN_CSP === 'enforce' ? 'enforcing' : 'report-only';
  console.log(`  csp ${mode}`);
  startJobs();
});
