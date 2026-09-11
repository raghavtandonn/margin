#!/usr/bin/env node
// Every form action and link in the views, checked against the routes that
// actually exist.
//
// This has been a real bug twice. /work/:id/shelve was a route with nothing
// posting to it, so no book could be put on a shelf; then rename and delete
// shipped as routes with no controls, which is the same fault in the other
// direction. Both were invisible until somebody tried to use the product.
//
// Run: node scripts/check-routes.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── Where each router is mounted ─────────────────────────
//
// routes/staff.js declares '/signin' and is mounted at '/staff', so the URL
// a form has to name is '/staff/signin'. Without this the checker reports
// every staff route as broken, which is the fastest way to make a checker
// nobody reads.
const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
const mounts = new Map();
for (const m of server.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
  mounts.set(m[2], m[1] === '/' ? '' : m[1]);
}
// The import name a router file was bound to.
const importedAs = new Map();
for (const m of server.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+'\.\/routes\/([\w-]+)\.js'/g)) {
  importedAs.set(m[2], m[1]);
}
// A file can export more than one router. routes/seasons.js exports the
// default AND `publicRouter`, mounted separately at '/', and the public
// season page lives on the second one — so a checker that only knew about
// default exports could not see `/@:username/:code` at all and reported
// every link to it as broken.
for (const m of server.matchAll(
  /import\s+[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}\s*from\s+'\.\/routes\/([\w-]+)\.js'/g
)) {
  for (const part of m[1].split(',')) {
    const as = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(part.trim());
    const name = as ? as[2] : part.trim();
    if (name) importedAs.set(`${m[2]}#${name}`, name);
  }
}

// ── The routes that exist ────────────────────────────────
const routes = [];
for (const file of walk(join(ROOT, 'routes'))) {
  if (!file.endsWith('.js')) continue;
  const src = readFileSync(file, 'utf8');
  const base = file.split('/').pop().replace(/\.js$/, '');
  const prefix = mounts.get(importedAs.get(base)) ?? '';

  // Any identifier ending in `router`, not only one called exactly that:
  // `publicRouter.get(...)` is a route and was invisible to the old pattern.
  for (const m of src.matchAll(
    /\b([A-Za-z_$][\w$]*)\.(get|post|put|delete|all)\(\s*'([^']+)'/g
  )) {
    const varName = m[1];
    if (!/router$/i.test(varName)) continue;      // not a router at all
    // Mount point: the default export takes the file's own mount; a named
    // export takes whatever server.js mounted THAT identifier at.
    const mount = varName === 'router'
      ? prefix
      : (mounts.get(importedAs.get(`${base}#${varName}`) ?? varName)
         ?? mounts.get(varName) ?? prefix);
    routes.push({
      method: m[2].toUpperCase(),
      path: (mount + m[3]).replace(/\/$/, '') || '/',
      file: relative(ROOT, file)
    });
  }
}

/** A route path with :params becomes a regex that a real URL can be tested against. */
const matcher = (path) =>
  new RegExp('^' + path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z_]+\??/g, '[^/]+')
    .replace(/\*/g, '.*') + '$');

const compiled = routes.map((r) => ({ ...r, re: matcher(r.path) }));

const known = (method, url) => {
  const path = url.split('?')[0];
  return compiled.some((r) => r.method === method && r.re.test(path));
};

// ── What the views ask for ───────────────────────────────
//
// EJS interpolation is replaced with a placeholder segment: an action of
// `/clubs/<%= club.slug %>/members/<%= m.id %>/remove` is a request for
// `/clubs/X/members/X/remove`, which is exactly the shape a route pattern
// has to cover.
const placeholder = (s) => s.replace(/<%[-=]?[\s\S]*?%>/g, 'X');

// Paths served by something other than a router: static middleware, and the
// two files mounted at the root of the site.
const SKIP_LINK = [
  /^\/css\//, /^\/js\//, /^\/img\//, /^\/fonts?\//, /^\/assets\//,
  /^\/favicon/, /^\/robots\.txt$/, /^\/sitemap/,
  /^\/cover\//, /^\/avatar\//
];

const problems = [];

for (const file of walk(join(ROOT, 'views'))) {
  if (!file.endsWith('.ejs')) continue;
  const src = readFileSync(file, 'utf8');
  const where = relative(ROOT, file);

  for (const m of src.matchAll(/<form\b[^>]*?action="([^"]+)"[^>]*>/gi)) {
    const tag = m[0];
    const action = placeholder(m[1]);
    if (!action.startsWith('/')) continue;                 // external or relative
    const method = /method\s*=\s*"post"/i.test(tag) ? 'POST' : 'GET';
    if (!known(method, action)) {
      problems.push(`${where}: form ${method} ${action} has no route`);
    }
  }

  // ── LINKS, WHICH THIS DID NOT USED TO CHECK ────────────
  //
  // This checker validated form actions and nothing else, and that gap cost
  // two incidents in one afternoon: a regex edit deleted `GET /reviews`, and
  // a later one took `GET /season/:code/poster.png` and the public season
  // page with it. Both were linked from views, both 404'd for every reader,
  // and this script reported everything fine each time. They were found by
  // requesting the pages by hand, which is not a safety net.
  //
  // An <a href> to a route this app does not serve is exactly the same fault
  // as a form posting nowhere. It is checked the same way.
  for (const m of src.matchAll(/<a\b[^>]*?href="([^"]+)"/gi)) {
    const raw = m[1].trim();
    if (!raw.startsWith('/')) continue;              // external, anchor, mailto
    const href = placeholder(raw).split('#')[0].split('?')[0];
    if (!href || href === '/') continue;
    if (SKIP_LINK.some((re) => re.test(href))) continue;
    if (!known('GET', href)) {
      problems.push(`${where}: link GET ${href} has no route`);
    }
  }
}

// ── The other direction ──────────────────────────────────
//
// A POST route that nothing in the product posts to is dead weight at best
// and, when it is the only way to do something, a feature nobody can reach.
const viewSrc = walk(join(ROOT, 'views'))
  .filter((f) => f.endsWith('.ejs'))
  .map((f) => placeholder(readFileSync(f, 'utf8')))
  .join('\n');
const clientSrc = walk(join(ROOT, 'public'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
// A form action can arrive as a variable rather than as literal markup —
// views/auth/message.ejs renders `action="<%= action.href %>"`, and the path
// itself is written in the route that renders it. So route source counts as
// a request too, with the route DECLARATIONS stripped out first: a route
// must not be able to vouch for its own reachability.
const routeSrc = walk(join(ROOT, 'routes'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(f, 'utf8')
    .replace(/router\.(get|post|put|delete|all)\(\s*'[^']+'/g, ''))
  .join('\n');

const asked = viewSrc + '\n' + clientSrc + '\n' + routeSrc;

// Routes that are legitimately not posted to from a page.
const EXEMPT = [
  /^\/csp-report/, /^\/api\//, /^\/webhooks?\//, /^\/signout/
];

const unreachable = [];
for (const r of routes) {
  if (r.method !== 'POST') continue;
  if (EXEMPT.some((re) => re.test(r.path))) continue;

  // The literal text before the first :param is what a view would have to
  // contain for this route to be reachable at all. Splitting on '/:' misses
  // '/@:username', whose parameter follows a character that is not a slash.
  const prefix = r.path.split(':')[0];
  if (!asked.includes(prefix)) {
    unreachable.push(`${r.file}: POST ${r.path} — nothing in the product posts to it`);
  }
}

for (const p of problems) console.log('  BROKEN      ' + p);
for (const u of unreachable) console.log('  UNREACHABLE ' + u);

if (!problems.length) {
  console.log(
    `routes ok — ${routes.length} routes; every form action and every link resolves` +
    (unreachable.length ? `  (${unreachable.length} unreachable POST${unreachable.length === 1 ? '' : 's'} above, advisory)` : '')
  );
}
process.exit(problems.length ? 1 : 0);
