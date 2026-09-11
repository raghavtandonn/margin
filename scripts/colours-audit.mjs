#!/usr/bin/env node
/**
 * The fifty-card review.
 *
 *   node scripts/colours-audit.mjs
 *
 * Questions no unit test can answer, because every one of them is about a
 * distribution rather than about any single card.
 *
 * ── 1. DO THE COLOURS COLLAPSE? ──────────────────────────
 *
 * The failure that survives every validator rule. Each card can cite real
 * sentences from real sections, name legitimate anchors, dodge every setting
 * rule — and the blends can still all land in the same small patch of the
 * space, because literary criticism is written in the vocabulary of loss.
 * The pipeline passes and the season is one colour.
 *
 * Measured in OKLAB DISTANCE, not palette reach. Under the blend model a
 * colour is no longer one of twenty, so counting how many of the twenty were
 * used stopped meaning anything: two books can both be "nearest Grief" and
 * be visibly different colours, and three books can name six different
 * anchors between them and still come out the same brown. Distance is what
 * the eye sees; reach is bookkeeping.
 *
 * The palette's own anchors sit a mean 0.198 from their centroid, with the
 * closest pair 0.037 apart. Those two numbers are what the thresholds below
 * are calibrated against.
 *
 * ── 2. IS SETTING LEAKING IN ANYWAY? ─────────────────────
 *
 * The per-card check is a regex over one sentence, and it is the cheap first
 * pass rather than the guarantee. This is the measurement: across every
 * assigned book, do the ones whose evidence talks about deserts land on the
 * amber end more often than chance?
 *
 * Deliberately run against the retrieved prose and the cited evidence, NOT
 * against Open Library subject headings. Matching /snow|ice|winter/ against
 * those returns The Giving Tree and To Kill a Mockingbird; /war/ returns
 * Call Me By Your Name. They are cataloguing terms and they are noise.
 */
import { all } from '../db/index.js';
import { PALETTE, colourOf, baseName } from '../lib/palette.js';
import * as OK from '../lib/oklab.js';
import { SETTING_TERMS } from '../lib/colour-derive.js';
import { isInterpretive, cachedFor, evidenceFor, kindOf } from '../lib/colour-evidence.js';
import { coverage, FIELDS_VERSION } from '../lib/emotion-fields.js';

const rows = all(
  `SELECT id, title, colour_id, colour_hex, colour_name, colour_components
     FROM works WHERE colour_hex IS NOT NULL ORDER BY colour_at`).map((r) => {
  let components = [];
  try { components = JSON.parse(r.colour_components || '[]'); } catch { /* none */ }
  return { ...r, components, evidence: components.map((c) => c.evidence).join(' ') };
});

if (!rows.length) {
  console.log('no colours derived yet — run scripts/colours-derive.mjs first');
  process.exit(0);
}

const n = rows.length;
console.log(`\n${n} assigned book${n === 1 ? '' : 's'}\n`);

// ── WHICH ANCHORS ARE BEING REACHED ──────────────────────
//
// Kept as context rather than as the verdict. Under blending an anchor is
// an ingredient, so this counts ingredients — how often each of the twenty
// is named in any component, at any weight.
const pulls = new Map();
for (const r of rows) {
  for (const c of r.components) pulls.set(c.id, (pulls.get(c.id) || 0) + c.weight);
}
const totalWeight = [...pulls.values()].reduce((a, b) => a + b, 0) || 1;

console.log('ANCHORS, BY SHARE OF THE LIBRARY'.padEnd(38));
for (const c of PALETTE) {
  const w = pulls.get(c.id) || 0;
  const pct = (w / totalWeight) * 100;
  console.log(`  ${c.emotion.padEnd(16)} ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(pct / 2))}`);
}
console.log(`  ${'—'.repeat(16)}`);
console.log(`  anchors reached  ${pulls.size} of ${PALETTE.length}   (context only — see SPREAD)`);

// ── REACH ────────────────────────────────────────────────
//
// A standing number rather than something to rediscover.
//
// An anchor that is never the heaviest component of any book is an anchor
// the library has no book *about* — it may colour things without ever being
// what a book is. An anchor never present at all is a word in the palette
// that this corpus cannot reach, and if that list stops shrinking it is a
// fact about the palette rather than about the reading.
const leads = new Map();
const appears = new Map();
for (const r of rows) {
  if (!r.components.length) continue;
  leads.set(r.components[0].id, (leads.get(r.components[0].id) || 0) + 1);
  for (const c of r.components) appears.set(c.id, (appears.get(c.id) || 0) + 1);
}
const neverLeads = PALETTE.filter((c) => !leads.get(c.id));
const neverAt = PALETTE.filter((c) => !appears.get(c.id));
const positives = PALETTE.filter((c) => c.valence === '+');

console.log('\nREACH');
console.log(`  anchors that lead at least one book   ${PALETTE.length - neverLeads.length} of ${PALETTE.length}`);
console.log(`  anchors present anywhere              ${PALETTE.length - neverAt.length} of ${PALETTE.length}`);
console.log(`  positive anchors that never lead      ${positives.filter((c) => !leads.get(c.id)).length} of ${positives.length}`);
if (neverLeads.length) {
  console.log(`  never the heaviest    ${neverLeads.map((c) => c.emotion).join(', ')}`);
}
if (neverAt.length) {
  console.log(`  never reached at all  ${neverAt.map((c) => c.emotion).join(', ')}`);
}

// ── NAMES ────────────────────────────────────────────────
//
// The base of a name is the heaviest component's anchor, so this is a
// distribution of what the library is mostly made of. It used to be the
// anchor a blend landed NEAREST, which collapsed toward the middle of the
// palette: the name disagreed with the dominant component on 79% of cards.
const bases = new Map();
for (const r of rows) {
  const b = baseName(r.colour_name);
  if (b) bases.set(b, (bases.get(b) || 0) + 1);
}
if (bases.size) {
  const ranked = [...bases].sort((a, b) => b[1] - a[1]);
  const topShare = ranked[0][1] / rows.length;
  console.log('\nNAMES');
  console.log(`  distinct base names   ${bases.size}`);
  console.log(`  most common           ${ranked[0][0]} — ${Math.round(topShare * 100)}%`);
  for (const [b, k] of ranked.slice(0, 6)) console.log(`    ${String(k).padStart(4)}  ${b}`);
  if (topShare > 0.25) {
    console.log('\n  ⚠  One base name holds more than a quarter of the library. The');
    console.log('     grammar needs another pass: a name that common has stopped');
    console.log('     distinguishing the books it is on.');
  }
}

// ── SPREAD, IN OKLAB ─────────────────────────────────────
//
// The verdict. Palette reach stopped being meaningful when colours started
// being blends: two books both nearest Grief can be visibly different, and
// six anchors between three books can still average to one brown.
const sp = OK.spread(rows.map((r) => r.colour_hex));
const anchorSpread = OK.spread(PALETTE.map((c) => c.hex));

console.log('\nSPREAD (Oklab distance)');
if (!sp) {
  console.log('  not enough colours to measure');
} else {
  const ratio = sp.mean / anchorSpread.mean;
  console.log(`  mean radius from centroid   ${sp.mean.toFixed(3)}`);
  console.log(`  tightest / widest           ${sp.min.toFixed(3)} / ${sp.max.toFixed(3)}`);
  console.log(`  the palette itself, for scale  ${anchorSpread.mean.toFixed(3)}`);
  console.log(`  so the library occupies     ${Math.round(ratio * 100)}% of the palette's range`);
  console.log(`  centroid                    ${sp.centroidHex}`);

  // 0.07 is a third of the palette's own 0.198 — a library sitting inside
  // that is using a third of the range the anchors were chosen to cover.
  if (sp.mean < 0.07) {
    console.log('\n  ⚠  These colours are clustered. Every rule in the validator can pass');
    console.log('     and the shelf still be one colour — the rules check whether a card');
    console.log('     is honest, not whether the set of them is various.');
  }
}

// ── PER SEASON ───────────────────────────────────────────
//
// The unit that ships. A library can look various and still have every
// individual season come out monochrome, which is the thing a reader sees.
const seasons = all(
  `SELECT s.code, w.colour_hex
     FROM seasons s
     JOIN season_frames sf ON sf.season_id = s.id
     JOIN works w ON w.id = sf.work_id
    WHERE w.colour_hex IS NOT NULL AND sf.hidden = 0
    ORDER BY s.code`);

const bySeason = new Map();
for (const r of seasons) {
  if (!bySeason.has(r.code)) bySeason.set(r.code, []);
  bySeason.get(r.code).push(r.colour_hex);
}

const measurable = [...bySeason].filter(([, hexes]) => hexes.length >= 3);
if (measurable.length) {
  console.log('\nBY SEASON');
  for (const [code, hexes] of measurable) {
    const s2 = OK.spread(hexes);
    const flag = s2.mean < 0.07 ? '  ⚠ clustered' : '';
    console.log(`  ${code.padEnd(6)} ${String(hexes.length).padStart(2)} books   radius ${s2.mean.toFixed(3)}   ${s2.centroidHex}${flag}`);
  }
}

// ── SETTING LEAKAGE ──────────────────────────────────────
const warm = new Set(['nostalgia', 'delight', 'exhilaration', 'desire', 'anger']);
const cold = new Set(['clarity', 'desolation', 'calm', 'loneliness']);

let withSetting = 0;
const leaks = [];
for (const r of rows) {
  const words = String(r.colour_evidence || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const hits = [...new Set(words.filter((w) => SETTING_TERMS.test(w)))];
  if (!hits.length) continue;
  withSetting++;

  // The specific cliché pairings §00 named, as a shortlist to read by hand.
  const hot = hits.some((h) => /desert|sand|dune|sahara|arid/.test(h)) && warm.has(r.colour_id);
  const ice = hits.some((h) => /snow|ice|arctic|frozen|tundra|winter/.test(h)) && cold.has(r.colour_id);
  const war = hits.some((h) => /war|battle|trench/.test(h)) && ['dread', 'grief'].includes(r.colour_id);
  if (hot || ice || war) leaks.push({ ...r, hits });
}

console.log('\nSETTING');
console.log(`  evidence mentioning a place or a season   ${withSetting} of ${n}`);
console.log(`  landing on the matching cliché           ${leaks.length}`);

if (leaks.length) {
  console.log('\n  read these by hand — the colour may be right for the wrong reason:');
  for (const l of leaks) {
    console.log(`\n    ${l.title}  →  ${colourOf(l.colour_id).emotion}   [${l.hits.join(', ')}]`);
    console.log(`      ${l.colour_evidence}`);
  }
}

// ── SECTIONS ─────────────────────────────────────────────
const bySection = new Map();
for (const r of rows) {
  for (const c of r.components) {
    const k = (c.section || '—').toLowerCase();
    bySection.set(k, (bySection.get(k) || 0) + 1);
  }
}
console.log('\nCITED FROM  (per component, not per book)');
for (const [k, v] of [...bySection].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

// ── PROVENANCE BY POSITION ───────────────────────────────
//
// The guard on the interpretive rule now applying to the heaviest component
// only. The heaviest is required to be interpretive when the article has an
// interpretive section, so it should read near 0% plot; the tail is allowed
// to cite plot and the question is how much it does.
//
// If the tail turns out to be overwhelmingly plot-sourced, that is worth
// knowing BEFORE it arrives as a season of mud: two thirds of every blend's
// weight would be anchored in what the book is doing and one third in where
// it happens, which is the setting problem coming back through the side
// door at a third of the volume.
const positions = [];
for (const r of rows) {
  const sorted = [...r.components].sort((a, b) => b.weight - a.weight);
  sorted.forEach((c, i) => {
    positions[i] = positions[i] || { n: 0, plot: 0, weight: 0 };
    positions[i].n++;
    positions[i].weight += c.weight;
    if (!isInterpretive(c.section || '')) positions[i].plot++;
  });
}

// ── WEIGHT AGAINST EVIDENCE VOLUME ───────────────────────
//
// The weights are checked at derivation, but only against the sections that
// were in front of the model at the time. This re-measures them against what
// is cached now, so a prompt change or a re-retrieval that quietly loosened
// the relationship shows up here rather than in a season.
const claimed = [];
for (const r of rows) {
  const cached = evidenceFor(r.id);
  if (!cached?.sections?.length) continue;
  const sup = r.components.map((c) => {
    const sec = cached.sections.find(
      (x) => x.heading.toLowerCase() === String(c.section || '').toLowerCase());
    return coverage(sec?.text || '', c.id, kindOf(c.section) === 'blurb' ? 'blurb' : 'wikipedia');
  });
  const total = sup.reduce((n, x) => n + x.share, 0);
  if (!total) continue;
  // How far the heaviest component's claimed share is from its share of the
  // discussion. Positive means it claims more than the source gives it.
  claimed.push(r.components[0].weight - sup[0].share / total);
}

if (claimed.length >= 5) {
  const mean = claimed.reduce((a, b) => a + b, 0) / claimed.length;
  const over = claimed.filter((d) => d > 0.2).length;
  console.log(`\nWEIGHT AGAINST TOPICAL COVERAGE  (fields v${FIELDS_VERSION})`);
  console.log(`  cards measurable                 ${claimed.length}`);
  console.log(`  heaviest claims this much more   ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}`);
  console.log(`  overclaiming by 20 points or more ${over}`);
  if (mean > 0.2) {
    console.log('\n  ⚠  Dominant components are systematically claiming more than the');
    console.log('     sections give them. The weights are drifting back to free-hand.');
  }
}

console.log('\nPROVENANCE BY POSITION');
console.log('                 n   from plot   mean weight');
positions.forEach((p, i) => {
  const label = i === 0 ? 'heaviest' : i === 1 ? 'second' : `#${i + 1}`;
  console.log(`  ${label.padEnd(13)} ${String(p.n).padStart(3)}   ` +
              `${String(Math.round((p.plot / p.n) * 100)).padStart(3)}%        ` +
              `${(p.weight / p.n).toFixed(2)}`);
});

const tail = positions.slice(1).reduce((a, p) => ({ n: a.n + p.n, plot: a.plot + p.plot }),
                                       { n: 0, plot: 0 });
if (tail.n >= 10 && tail.plot / tail.n > 0.6) {
  console.log('\n  ⚠  The tail is mostly plot-sourced. The heaviest component is anchored');
  console.log('     interpretively, but a third of every blend is coming from what');
  console.log('     happens rather than what the book is doing. Read some by hand.');
}

// ── BY SOURCE ────────────────────────────────────────────
//
// Wikipedia analysis sections exist for canonical literature and almost
// nothing else, so a pipeline resting on them alone has a structural gap
// that skews against contemporary, translated, genre and nonfiction work.
// The blurb closes most of it — but publisher copy is marketing, and the
// question is whether it produces different colours or just louder ones.
//
// Three things worth knowing: does it invert the negative skew, does it
// spread as widely, and does setting leak in more.
const VALENCE_OF = new Map(PALETTE.map((c) => [c.id, c.valence]));

const classOf = (r) => {
  const heaviest = r.components[0];
  return heaviest?.kind || kindOf(heaviest?.section || '');
};

const groups = { interpretive: [], doaj: [], blurb: [], plot: [] };
for (const r of rows) (groups[classOf(r)] || groups.plot).push(r);

// Valence by source class. Academic criticism is where the loss-and-
// alienation vocabulary is densest, so open-access abstracts are the source
// most likely to deepen the negative skew recorded in §12 — and the only way
// to see that happen is to keep the classes apart.
console.log('\nBY SOURCE OF THE HEAVIEST COMPONENT');
console.log('                  n   radius   positive   anchors   setting');
for (const [label, list] of Object.entries(groups)) {
  if (!list.length) { console.log(`  ${label.padEnd(15)} 0`); continue; }
  const sp2 = OK.spread(list.map((r) => r.colour_hex));
  const pos = list.filter((r) => VALENCE_OF.get(r.components[0].id) === '+').length;
  const anchors = new Set(list.flatMap((r) => r.components.map((c) => c.id))).size;
  const leaks = list.filter((r) => SETTING_TERMS.test(r.evidence || '')).length;
  console.log(`  ${label.padEnd(15)} ${String(list.length).padStart(3)}   ` +
              `${(sp2 ? sp2.mean.toFixed(3) : '  —  ')}    ` +
              `${String(Math.round((pos / list.length) * 100)).padStart(3)}%      ` +
              `${String(anchors).padStart(2)}/20     ${leaks}`);
}

// Valence spread across every class that has enough cards to mean anything.
const valenceShare = (list) => {
  const by = { '−': 0, '~': 0, '+': 0 };
  for (const r of list) by[VALENCE_OF.get(r.components[0].id)]++;
  return by;
};
const byValence = Object.entries(groups).filter(([, l]) => l.length >= 5);
if (byValence.length >= 2) {
  console.log('\nVALENCE BY SOURCE CLASS');
  console.log('                  n   negative  neutral  positive');
  for (const [label, list] of byValence) {
    const v = valenceShare(list);
    const pct = (k) => String(Math.round((v[k] / list.length) * 100)).padStart(3) + '%';
    console.log(`  ${label.padEnd(15)} ${String(list.length).padStart(3)}    ` +
                `${pct('−')}     ${pct('~')}     ${pct('+')}`);
  }
  const neg = (l) => l.filter((r) => VALENCE_OF.get(r.components[0].id) === '−').length / l.length;
  if (groups.doaj.length >= 8 && groups.interpretive.length + groups.blurb.length >= 8) {
    const other = [...groups.interpretive, ...groups.blurb];
    if (neg(groups.doaj) > neg(other) + 0.15) {
      console.log('\n  ⚠  Criticism-derived colours are markedly more negative than the rest.');
      console.log('     Academic writing is where the loss-and-alienation vocabulary is');
      console.log('     densest, and this is that showing up in the library rather than');
      console.log('     in an argument. §12 is the decision it bears on.');
    }
  }
}

if (groups.blurb.length >= 8 && groups.interpretive.length >= 8) {
  const b = groups.blurb.filter((r) => VALENCE_OF.get(r.components[0].id) === '+').length / groups.blurb.length;
  const w = groups.interpretive.filter((r) => VALENCE_OF.get(r.components[0].id) === '+').length / groups.interpretive.length;
  if (b > w + 0.2) {
    console.log('\n  Blurb-derived colours skew markedly more positive than criticism-derived');
    console.log('  ones. That is the corpus difference showing as data, and it is the');
    console.log('  thing to read by hand before trusting either half on its own.');
  }
  const bs = OK.spread(groups.blurb.map((r) => r.colour_hex));
  const ws = OK.spread(groups.interpretive.map((r) => r.colour_hex));
  if (bs && ws && bs.mean < ws.mean * 0.7) {
    console.log('\n  ⚠  Blurb-derived blends are markedly tighter than criticism-derived ones.');
    console.log('     Marketing copy is a narrow register; this is what mush looks like');
    console.log('     before it reaches a season.');
  }
}

// ── THE CROSS-TAB ────────────────────────────────────────
//
// The interpretive gate was reversed on the argument that it hatched books
// for a Wikipedia editorial reason rather than anything about the books, and
// at fifty attempts the data agreed: plot-backed cards spread as widely as
// themes-backed ones. This keeps that measurement running now that the unit
// has changed — a book counts as plot-backed when the MAJORITY of its
// blend's weight was cited from plot sections.
//
// Measured in Oklab, like everything else: if plot-backed books cluster
// while themes-backed ones spread, the gate was measuring something real.
const weightFromPlot = (r) => r.components
  .filter((c) => !isInterpretive(c.section || ''))
  .reduce((n, c) => n + c.weight, 0);

const plot = rows.filter((r) => weightFromPlot(r) > 0.5);
const themed = rows.filter((r) => weightFromPlot(r) <= 0.5);

console.log('\nWHERE THE WEIGHT CAME FROM');
console.log('                  n   radius   anchors');
for (const [label, list] of [['plot-backed', plot], ['themes-backed', themed]]) {
  if (!list.length) { console.log(`  ${label.padEnd(15)} 0`); continue; }
  const sp2 = OK.spread(list.map((r) => r.colour_hex));
  const anchors = new Set(list.flatMap((r) => r.components.map((c) => c.id))).size;
  console.log(`  ${label.padEnd(15)} ${String(list.length).padStart(3)}   ` +
              `${sp2 ? sp2.mean.toFixed(3) : '  —  '}    ${anchors}/20`);
}

if (plot.length >= 8 && themed.length >= 8) {
  const a = OK.spread(plot.map((r) => r.colour_hex));
  const b = OK.spread(themed.map((r) => r.colour_hex));
  if (a && b && a.mean < b.mean * 0.75) {
    console.log('\n  ⚠  Plot-backed blends are measurably tighter than themes-backed ones.');
    console.log('     That is what the interpretive gate was guessing at. Check WHICH');
    console.log('     books fall on each side before restoring anything.');
  } else {
    console.log('\n  Plot-backed evidence is holding up. The fixtures are doing the work.');
  }
}
console.log();
