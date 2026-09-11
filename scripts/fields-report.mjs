#!/usr/bin/env node
/**
 * What the corpus says, so the fields can be built from it.
 *
 *   node scripts/fields-report.mjs                # coverage per anchor
 *   node scripts/fields-report.mjs --terms grief  # which terms are earning it
 *   node scripts/fields-report.mjs --vocab lonel  # corpus terms matching a stem
 *
 * The fields in lib/emotion-fields.js were written against this. They are
 * NOT model-generated synonyms for twenty emotion words — that is unsourced
 * inference, and it is the thing this pipeline is arranged to avoid.
 */
import { all } from '../db/index.js';
import { PALETTE } from '../lib/palette.js';
import { cachedFor, blurbSection } from '../lib/colour-evidence.js';
import { cachedFor as doajCached } from '../lib/doaj.js';
import { FIELDS, FIELDS_VERSION, coverage, sentencesOf, tokensOf, mentions } from '../lib/emotion-fields.js';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };

const CORPUS = process.argv.includes('--blurb') ? 'blurb'
             : process.argv.includes('--doaj') ? 'doaj'
             : 'wikipedia';

const sections = [];
for (const w of all('SELECT id, title FROM works')) {
  if (CORPUS === 'blurb') {
    const b = blurbSection(w.id);
    if (b) sections.push({ ...b, title: w.title });
  } else if (CORPUS === 'doaj') {
    for (const a of doajCached(w.id) || []) sections.push({ ...a, title: w.title });
  } else {
    const c = cachedFor(w.id);
    if (c) for (const s of c.sections) sections.push({ ...s, title: w.title });
  }
}
if (!sections.length) { console.log('no retrieved sections cached yet'); process.exit(0); }

const vocab = arg('vocab');
if (vocab) {
  const freq = new Map();
  for (const s of sections) for (const t of tokensOf(s.text)) freq.set(t, (freq.get(t) || 0) + 1);
  const hits = [...freq].filter(([w]) => w.includes(vocab)).sort((a, b) => b[1] - a[1]);
  console.log(`terms containing "${vocab}" in the corpus:\n`);
  for (const [w, n] of hits.slice(0, 60)) console.log(`  ${String(n).padStart(5)}  ${w}`);
  process.exit(0);
}

const only = arg('terms');
if (only) {
  const freq = new Map();
  for (const s of sections) {
    for (const t of tokensOf(s.text)) {
      if (mentions(t, only)) freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  console.log(`terms earning "${only}" across the corpus (field v${FIELDS_VERSION}):\n`);
  for (const [w, n] of [...freq].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${w}`);
  const dead = FIELDS[only].filter((w) => !freq.has(w));
  if (dead.length) console.log(`\n  never seen in this corpus: ${dead.join(', ')}`);
  process.exit(0);
}

const total = sections.reduce((n, s) => n + sentencesOf(s.text).length, 0);
console.log(`${sections.length} ${CORPUS} sections, ${total} sentences, fields v${FIELDS_VERSION}\n`);
console.log('  anchor           weighted    share of corpus');
for (const c of PALETTE) {
  const hits = sections.reduce((n, s) => n + coverage(s.text, c.id, CORPUS).sentences, 0);
  const pct = (hits / total) * 100;
  console.log(`  ${c.emotion.padEnd(16)} ${hits.toFixed(1).padStart(7)}      ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(pct))}`);
}
