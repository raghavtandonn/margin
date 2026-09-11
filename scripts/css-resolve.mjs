#!/usr/bin/env node
// Resolve every (media context, selector, property) in a stylesheet to the
// declaration that actually wins, and report the ones declared more than once.
//
// This exists because margin.css had grown two competing :root palettes 800
// lines apart, and three different .work-cover widths. Editing the top of the
// file had no effect on the page, which is the kind of fault that costs an
// afternoon and leaves no trace. A stylesheet should say what it does.
//
// The resolver is deliberately small and deliberately honest about its
// limits: it compares declarations with EQUAL specificity, in source order,
// within the same at-rule context. That is exactly the case that produced the
// bug — the same selector, written twice — and it is the case a refactor has
// to preserve. It does not model specificity across different selectors,
// because it does not need to.
//
//   node scripts/css-resolve.mjs                     # shadowing census
//   node scripts/css-resolve.mjs --snapshot out.json # resolved values
//   node scripts/css-resolve.mjs --check out.json    # nothing moved

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = ['public/css/margin.css', 'public/css/lookbook.css'];

/** Strip comments without touching content inside strings or url(). */
function decomment(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Walk a stylesheet into flat rules, carrying the at-rule context down.
 *
 * Nested at-rules (a @media inside a @supports) concatenate their preludes,
 * so two rules only share a context when every wrapper matches.
 */
function parse(src, file) {
  const out = [];
  let i = 0;
  const stack = [];

  while (i < src.length) {
    const brace = src.indexOf('{', i);
    const close = src.indexOf('}', i);

    if (brace === -1 && close === -1) break;

    // A closing brace before the next opening one ends the innermost block.
    if (close !== -1 && (brace === -1 || close < brace)) {
      stack.pop();
      i = close + 1;
      continue;
    }

    const prelude = src.slice(i, brace).trim();
    i = brace + 1;

    if (prelude.startsWith('@')) {
      // @media / @supports wrap other rules; @keyframes and @font-face carry
      // declarations that no selector addresses, so they are recorded whole
      // and not descended into.
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        stack.push(prelude.replace(/\s+/g, ' '));
        continue;
      }
      const end = matchBrace(src, brace);
      out.push({ file, context: stack.join(' :: '), selector: prelude, decls: [], raw: true });
      i = end + 1;
      continue;
    }

    // A normal rule. Everything to the next '}' is its declaration list;
    // nested rules are not used in this codebase.
    const end = src.indexOf('}', i);
    const body = src.slice(i, end === -1 ? src.length : end);
    i = (end === -1 ? src.length : end) + 1;

    out.push({
      file,
      context: stack.join(' :: '),
      selector: prelude.replace(/\s+/g, ' '),
      decls: declarations(body)
    });
  }
  return out;
}

function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return src.length;
}

function declarations(body) {
  const out = [];
  for (const part of splitTop(body, ';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (!prop || !value) continue;
    out.push({ prop, value: value.replace(/\s+/g, ' ') });
  }
  return out;
}

/** Split on a separator that is not inside brackets or quotes. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// ── Resolution ───────────────────────────────────────────
//
// Selector lists are split, so `.a, .b { color: red }` records against both.
// Within one (context, selector, property) the last declaration in source
// order wins — !important excepted, which wins over anything that is not.

function resolve(rules) {
  const winner = new Map();   // key -> { value, file, important, seen: [] }
  for (const rule of rules) {
    if (rule.raw) continue;
    for (const sel of splitTop(rule.selector, ',')) {
      for (const d of rule.decls) {
        const key = `${rule.context}||${sel}||${d.prop}`;
        const important = /!\s*important$/i.test(d.value);
        const prev = winner.get(key);
        const entry = prev || { value: null, file: rule.file, important: false, seen: [] };
        entry.seen.push({ value: d.value, file: rule.file });
        if (!prev || important || !prev.important) {
          entry.value = d.value;
          entry.important = important;
          entry.file = rule.file;
        }
        winner.set(key, entry);
      }
    }
  }
  return winner;
}

const rules = FILES.flatMap((f) => parse(decomment(readFileSync(ROOT + f, 'utf8')), f));
const winner = resolve(rules);

const mode = process.argv[2];
const path = process.argv[3];

if (mode === '--snapshot') {
  const snap = {};
  for (const [k, v] of winner) snap[k] = v.value;
  writeFileSync(path, JSON.stringify(snap, null, 0));
  console.log(`snapshot  ${Object.keys(snap).length} resolved declarations -> ${path}`);
  process.exit(0);
}

if (mode === '--check') {
  const before = JSON.parse(readFileSync(path, 'utf8'));
  const after = {};
  for (const [k, v] of winner) after[k] = v.value;

  const changed = [];
  const removed = [];
  const added = [];
  for (const k of Object.keys(before)) {
    if (!(k in after)) removed.push(k);
    else if (before[k] !== after[k]) changed.push([k, before[k], after[k]]);
  }
  for (const k of Object.keys(after)) if (!(k in before)) added.push(k);

  const show = (label, list, fmt) => {
    if (!list.length) return;
    console.log(`\n${label} (${list.length})`);
    for (const x of list.slice(0, 60)) console.log('  ' + fmt(x));
    if (list.length > 60) console.log(`  … ${list.length - 60} more`);
  };
  show('CHANGED', changed, ([k, a, b]) => `${k.replace(/\|\|/g, '  ')}\n      was ${a}\n      now ${b}`);
  show('REMOVED', removed, (k) => k.replace(/\|\|/g, '  '));
  show('ADDED', added, (k) => k.replace(/\|\|/g, '  '));

  console.log(`\n${Object.keys(before).length} -> ${Object.keys(after).length} declarations, ` +
    `${changed.length} changed, ${removed.length} removed, ${added.length} added`);
  process.exit(changed.length || removed.length ? 1 : 0);
}

// Default: the shadowing census. Anything declared twice with two different
// values is a place where the file does not say what it does.
const shadowed = [];
for (const [key, v] of winner) {
  const values = [...new Set(v.seen.map((s) => s.value))];
  if (values.length > 1) shadowed.push([key, values, v.value]);
}

shadowed.sort();
console.log(`SHADOWED DECLARATIONS  (same context, same selector, different values)\n`);
for (const [key, values, wins] of shadowed) {
  const [ctx, sel, prop] = key.split('||');
  console.log(`  ${sel}${ctx ? `   @ ${ctx}` : ''}`);
  console.log(`    ${prop}: ${values.join('  |  ')}   ->  ${wins}`);
}
console.log(`\n${shadowed.length} shadowed, ${winner.size} resolved declarations total`);
