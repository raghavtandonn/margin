#!/usr/bin/env node
// Exports nothing imports, and CSS classes no template uses.
//
// Removing a feature leaves a tail: a lib function with no caller, a rule
// styling markup that is gone. Neither breaks a page, so neither shows up in
// any other check — and both make the next person reading the file believe
// something is in use when it is not.
//
//   node scripts/check-dead.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const walk = (dir, ext, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};

const jsFiles = [
  ...walk(join(ROOT, 'lib'), '.js'),
  ...walk(join(ROOT, 'routes'), '.js'),
  ...walk(join(ROOT, 'db'), '.js'),
  join(ROOT, 'server.js')
];
const allJs = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const testSrc = walk(join(ROOT, 'test'), '.js').map((f) => readFileSync(f, 'utf8')).join('\n');
const scriptSrc = walk(join(ROOT, 'scripts'), '.js')
  .concat(walk(join(ROOT, 'scripts'), '.mjs'))
  .map((f) => readFileSync(f, 'utf8')).join('\n');
const viewSrc = walk(join(ROOT, 'views'), '.ejs').map((f) => readFileSync(f, 'utf8')).join('\n');

// ── Dead exports ─────────────────────────────────────────
const deadExports = [];
for (const file of walk(join(ROOT, 'lib'), '.js')) {
  const where = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  const own = src;
  for (const m of src.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    // Used inside its own file, by another module, by a view helper call,
    // by a test, or by a script.
    const elsewhere = jsFiles
      .filter((f) => f !== file)
      .some((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(f, 'utf8')));
    const selfUses = (own.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1;
    const inViews = new RegExp(`\\bh\\.${name}\\b|\\b${name}\\(`).test(viewSrc);
    const inTests = new RegExp(`\\b${name}\\b`).test(testSrc);
    const inScripts = new RegExp(`\\b${name}\\b`).test(scriptSrc);
    if (!elsewhere && !selfUses && !inViews && !inTests && !inScripts) {
      deadExports.push(`${where}: export ${name} — nothing imports or calls it`);
    }
  }
}

// ── Dead CSS classes ─────────────────────────────────────
const deadCss = [];
for (const file of walk(join(ROOT, 'public/css'), '.css')) {
  const where = relative(ROOT, file);
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const seen = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) seen.add(m[1]);
  const clientJs = walk(join(ROOT, 'public'), '.js').map((f) => readFileSync(f, 'utf8')).join('\n');
  const haystack = viewSrc + '\n' + allJs + '\n' + clientJs;

  for (const cls of [...seen].sort()) {
    if (new RegExp(`\\b${cls}\\b`).test(haystack)) continue;

    // A class can be BUILT rather than written: `lb-led--${r.kind}`,
    // `plate-t${n}`, `rot-${i}`, `trim-${x}`. Looking only for the whole
    // name reports every one of those as dead, which makes the check
    // untrustworthy and therefore useless.
    //
    // So: every prefix of the class, from three characters up, is tested
    // against the source followed by an interpolation opener. If any of them
    // appears, something constructs this name.
    let built = false;
    for (let n = 3; n < cls.length && !built; n++) {
      const stem = cls.slice(0, n);
      for (const opener of ['${', '<%', "' +", '" +', '` +']) {
        if (haystack.includes(stem + opener)) { built = true; break; }
      }
    }
    if (built) continue;

    deadCss.push(`${where}: .${cls} — no template or script uses it`);
  }
}

for (const d of deadExports) console.log('  DEAD EXPORT ' + d);
for (const d of deadCss) console.log('  DEAD CSS    ' + d);
if (!deadExports.length && !deadCss.length) console.log('no dead exports, no dead CSS');
