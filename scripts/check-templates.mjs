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

for (const p of problems) console.log('  BROKEN      ' + p);
if (!problems.length) {
  console.log(`templates ok — ${files.length} compile, every include resolves, every page is rendered`);
}
process.exit(problems.length ? 1 : 0);
