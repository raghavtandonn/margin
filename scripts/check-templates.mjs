#!/usr/bin/env node
// Every template compiles, and every partial it includes exists.
//
// A regex edit that removes a route can also leave a template referring to a
// local nobody passes any more, or an include pointing at a file that was
// deleted. Neither shows up until somebody opens the page, and EJS reports
// it as a 500 at request time rather than at boot.
//
//   node scripts/check-templates.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import ejs from 'ejs';

const ROOT = new URL('..', import.meta.url).pathname;
const VIEWS = join(ROOT, 'views');

function walk(dir, ext = '.ejs', out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const problems = [];
const files = walk(VIEWS);

for (const file of files) {
  const where = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');

  // 1. It compiles.
  try {
    ejs.compile(src, { filename: file });
  } catch (e) {
    problems.push(`${where}: does not compile — ${String(e.message).split('\n')[0]}`);
    continue;
  }

  // 2. Every include resolves to a file that exists.
  for (const m of src.matchAll(/include\(\s*'([^']+)'/g)) {
    const target = m[1].endsWith('.ejs') ? m[1] : m[1] + '.ejs';
    const abs = join(dirname(file), target);
    if (!existsSync(abs)) {
      problems.push(`${where}: includes '${m[1]}' which does not exist`);
    }
  }
}

// ── 3. Every page template is rendered by something ──────
//
// A template nothing renders is a page nobody can reach. It has happened
// twice: /wall rendered, worked, and was linked from nowhere; views/
// published.ejs outlived the feature that rendered it. Partials are
// excluded — they are included, not rendered — as are the error pages,
// which are rendered by handlers rather than by a named route.
const routeSrc = walk(join(ROOT, 'routes'), '.js')
  .concat([join(ROOT, 'server.js')].filter(existsSync))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// A page can be rendered by its full path ('settings/privacy') or, through a
// helper that supplies the directory, by its basename alone — routes/auth.js
// calls `screen(res, 'signin')` for views/auth/signin.ejs. Both count.
const namesFor = (where) => {
  const full = where.replace(/^views\//, '').replace(/\.ejs$/, '');
  return [full, full.split('/').pop()];
};

const NOT_A_PAGE = /^views\/(partials\/|.*_[a-z])/;
const RENDERED_BY_HANDLER = new Set(['views/404.ejs', 'views/error.ejs']);

const orphans = [];
for (const file of files) {
  const where = relative(ROOT, file);
  if (NOT_A_PAGE.test(where) || RENDERED_BY_HANDLER.has(where)) continue;
  const names = namesFor(where);
  const rendered = names.some((n) => routeSrc.includes(`'${n}'`) || routeSrc.includes(`"${n}"`));
  const name = names[0];
  const included = files.some((f) => f !== file &&
    /include\(\s*'([^']+)'/.test(readFileSync(f, 'utf8')) &&
    [...readFileSync(f, 'utf8').matchAll(/include\(\s*'([^']+)'/g)]
      .some((m) => m[1].replace(/\.ejs$/, '').split('/').pop() === name.split('/').pop()));
  if (!rendered && !included) orphans.push(`${where}: no route renders it`);
}
problems.push(...orphans);

// ── EVERY HELPER A TEMPLATE CALLS MUST EXIST ─────────────
//
// Compiling a template proves its SYNTAX. It cannot prove that `h.stars(...)`
// resolves to anything, because that is only known when the expression runs —
// and it only runs when a book on the page has a rating. So nine call sites
// across eight templates called a helper that did not exist, every shelf with
// a rated book on it returned 500, and the whole gate stayed green.
//
// This is the cheap half of that lesson: the names are right there in the
// source on both sides.
// `h` is not one module: server.js spreads lib/view-helpers.js and then adds
// a handful of bindings from elsewhere. Checking only the module would call
// every one of those a fault, so the composition is read where it is written.
const helperNames = new Set(Object.keys(await import(join(ROOT, 'lib/view-helpers.js'))));
const composed = /app\.locals\.h\s*=\s*\{([\s\S]*?)\n\};/.exec(readFileSync(join(ROOT, 'server.js'), 'utf8'));
if (!composed) {
  problems.push('server.js: could not find the app.locals.h composition to check helpers against');
} else {
  for (const part of composed[1].replace(/\/\/[^\n]*/g, '').split(',')) {
    const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(part) || /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
    if (key) helperNames.add(key[1]);
  }
}
const missing = new Map();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // `h.name(` — a call, not a property read like `h.css.pct`, which resolves
  // through an object and would need a deeper walk than this is worth.
  for (const m of src.matchAll(/\bh\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (helperNames.has(name)) continue;
    const where = `${relative(ROOT, file)}: h.${name}() is not on app.locals.h`;
    if (!missing.has(where)) missing.set(where, true);
  }
}
problems.push(...missing.keys());

for (const p of problems) console.log('  BROKEN      ' + p);
if (!problems.length) {
  console.log(`templates ok — ${files.length} compile, every include resolves, every page is rendered, every h.helper() exists`);
}
process.exit(problems.length ? 1 : 0);
