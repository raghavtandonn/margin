// ── PHASE 1: compute one kind of embedding ───────────────
//
//   npm run embed -- --kind text-blurb
//   npm run embed -- --kind text-blurb --limit 20     (a probe run)
//   npm run embed -- --kind text-blurb --verify       (stability check only)
//
// The model runs in-process. There is no network call after the first model
// download and no API key, which is the opposite of the colour pipeline and
// deliberately so.
//
// Inputs are TRUNCATED to a fixed character budget before embedding. §09
// names length bias as a real failure mode — books with long articles
// producing richer vectors and ranking higher for no reason connected to the
// reader — and truncating at write is cheaper than correlating rank against
// source_chars afterwards and discovering it then.
import { db, all, get } from '../db/index.js';
import * as EV from '../lib/colour-evidence.js';
import * as EMB from '../lib/embeddings.js';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const KIND = argOf('kind', 'text-blurb');
const LIMIT = Number(argOf('limit', 0)) || 0;
const MODEL = 'Xenova/bge-small-en-v1.5';
const VERSION = 'bge-small-en-v1.5@1';
const MAX_CHARS = 2000;
const COLOUR_VERSION = 'colour-system@1.2';

// What each text kind reads. Only text-blurb is wired in Phase 1; the others
// are listed so the shape of adding one is obvious and so nobody has to guess
// where a new kind hooks in.
const SOURCES = {
  'text-blurb': () => all(
    `SELECT w.id AS work_id, w.title, w.blurb AS text, 'works.blurb' AS ref
       FROM works w
      WHERE w.blurb IS NOT NULL AND length(trim(w.blurb)) >= 80
      ORDER BY w.id`
  ),

  // Both text kinds read the sections the COLOUR work already retrieved and
  // cached — 206 Wikipedia articles and 162 DOAJ abstracts on disk. No new
  // network calls, no rate limits, nothing to throttle.
  //
  // Plot and interpretive stay SEPARATE kinds. The colour work established
  // that plot prose and interpretive prose are different registers with
  // different vocabularies; pooling them here would repeat a mistake that
  // has already been made and corrected once.
  'text-plot': () => sectioned((heading) => EV.kindOf(heading) === 'plot'),
  'text-criticism': () => sectioned((heading) => EV.kindOf(heading) === 'interpretive'),
};

/**
 * Wikipedia sections of one class, joined per work.
 *
 * The cache stores a whole article as "== Heading ==" blocks, which is the
 * same shape `colour-evidence` parses — so the classifier that decided what
 * a colour could cite is the classifier that decides what gets embedded, and
 * the two cannot drift apart.
 */
function sectioned(wanted) {
  const out = [];
  for (const row of all(
    `SELECT h.work_id, w.title, h.text, h.ref
       FROM history_sources h JOIN works w ON w.id = h.work_id
      WHERE h.kind = 'wikipedia-colour' ORDER BY h.work_id`
  )) {
    const parts = String(row.text).split(/^== ([^=]+) ==$/m);
    let text = '';
    for (let i = 1; i < parts.length; i += 2) {
      if (wanted(parts[i].trim())) text += parts[i + 1] + '\n';
    }
    // DOAJ abstracts are criticism by definition: they describe a paper's
    // argument about the book.
    if (wanted('Analysis')) {
      const doaj = get(
        `SELECT text FROM history_sources WHERE work_id = ? AND kind = 'doaj-colour'`, row.work_id
      );
      if (doaj?.text) text += doaj.text;
    }
    if (text.trim().length >= 200) {
      out.push({ work_id: row.work_id, title: row.title, text: text.trim(), ref: row.ref || 'wikipedia' });
    }
  }
  return out;
}

if (!SOURCES[KIND] && !KIND.startsWith('colour-')) {
  console.error(`\n  no source wired for kind "${KIND}" — Phase 1 covers: ${Object.keys(SOURCES).join(', ')}\n`);
  process.exit(1);
}

console.log(`\n  KIND      ${KIND}`);
console.log(`  MODEL     ${MODEL}`);
console.log(`  VERSION   ${KIND.startsWith('colour-') ? COLOUR_VERSION : VERSION}`);

// ── the colour kinds, which cost nothing ─────────────────
//
// Already computed by the colour system. `colour-components` is a 20-dim
// vector where each dimension is one anchor's weight — mostly zeros, and the
// only embedding in this project that is human-readable end to end. If it
// carries signal it is the best-explaining embedding available, so it is
// probed despite looking unpromising beside a 384-dim dense vector.
//
// These are NOT L2-normalised by hand here: put() normalises everything at
// write, so a component vector's direction is what is compared, not its
// magnitude. Two books that are 90% grief differ only in what the other 10%
// is, which is the correct thing to measure.
if (KIND === 'colour-components' || KIND === 'colour-oklab') {
  const PAL = await import('../lib/palette.js');
  const OK = await import('../lib/oklab.js');
  const ids = PAL.PALETTE.map((p) => p.id);

  let wrote = 0, skipped = 0;
  for (const row of all(
    `SELECT id AS work_id, title, colour_hex, colour_components
       FROM works WHERE colour_id IS NOT NULL AND colour_components IS NOT NULL`
  )) {
    let comps = [];
    try { comps = JSON.parse(row.colour_components) || []; } catch { continue; }
    if (!comps.length) continue;

    let vec, ref;
    if (KIND === 'colour-components') {
      vec = ids.map((id) => {
        const c = comps.find((x) => x.id === id);
        return c ? Number(c.weight) || 0 : 0;
      });
      ref = 'works.colour_components';
    } else {
      vec = Array.from(OK.oklab(row.colour_hex));   // [L, a, b]
      ref = 'works.colour_hex';
    }
    if (!vec.some((v) => v !== 0)) { skipped++; continue; }   // absence, not origin
    try {
      EMB.put(row.work_id, KIND, COLOUR_VERSION, vec, { sourceRef: ref, sourceChars: null });
      wrote++;
    } catch { skipped++; }
  }
  const cov = EMB.coverage(KIND, COLOUR_VERSION);
  console.log(`  wrote ${wrote}, skipped ${skipped}`);
  console.log(`  coverage  ${cov.have} of ${cov.works} works (${Math.round(cov.have / cov.works * 100)}%)\n`);
  db.exec('PRAGMA optimize');
  process.exit(0);
}

const { pipeline } = await import('@huggingface/transformers');
const t0 = Date.now();
const extract = await pipeline('feature-extraction', MODEL);
console.log(`  loaded    ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const embed = async (text) => {
  const out = await extract(text.slice(0, MAX_CHARS), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
};

// ── the stability check the spec demands before trusting any of it ──
if (has('verify')) {
  const sample = SOURCES[KIND]().slice(0, 3);
  let worst = 1;
  for (const row of sample) {
    const a = await embed(row.text);
    const b = await embed(row.text);
    const cos = EMB.cosine(Float32Array.from(a), Float32Array.from(b));
    worst = Math.min(worst, cos);
    console.log(`  ${cos.toFixed(9)}  ${row.title.slice(0, 46)}`);
  }
  console.log(`\n  worst self-cosine across two runs: ${worst.toFixed(9)}`);
  console.log(`  ${worst > 0.9999 ? 'STABLE — safe to store' : 'UNSTABLE — do not store'}\n`);
  process.exit(worst > 0.9999 ? 0 : 1);
}

const rows = SOURCES[KIND]();
const todo = LIMIT ? rows.slice(0, LIMIT) : rows;
const already = new Set(
  all('SELECT work_id FROM embeddings WHERE kind = ? AND version = ?', KIND, VERSION)
    .map((r) => r.work_id)
);

console.log(`  ${rows.length} work(s) have usable input; ${already.size} already stored\n`);

let wrote = 0, skipped = 0, failed = 0;
const started = Date.now();

for (const [i, row] of todo.entries()) {
  if (already.has(row.work_id)) { skipped++; continue; }
  try {
    const vec = await embed(row.text);
    EMB.put(row.work_id, KIND, VERSION, vec, {
      sourceRef: row.ref,
      sourceChars: Math.min(row.text.length, MAX_CHARS)
    });
    wrote++;
  } catch (e) {
    // A failure is reported, never written as an absence — the two are
    // different states and conflating them is the error this project has
    // made three times in another layer.
    failed++;
    console.log(`  FAILED  ${row.title.slice(0, 40)} — ${e.message}`);
  }
  if ((i + 1) % 25 === 0) {
    const rate = (i + 1) / ((Date.now() - started) / 1000);
    process.stdout.write(`  ${i + 1}/${todo.length}  (${rate.toFixed(1)}/s)\r`);
  }
}

const cov = EMB.coverage(KIND, VERSION);
console.log(`\n\n  wrote ${wrote}, skipped ${skipped} already present, ${failed} failed`);
console.log(`  coverage  ${cov.have} of ${cov.works} works (${Math.round(cov.have / cov.works * 100)}%)`);
console.log(`  missing   ${cov.missing} — absent, not zero-scored\n`);

db.exec('PRAGMA optimize');
