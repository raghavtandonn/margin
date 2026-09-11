#!/usr/bin/env node
/**
 * Derive book colours.
 *
 *   node scripts/colours-derive.mjs                 # finished books, no colour yet
 *   node scripts/colours-derive.mjs --all           # the whole library
 *   node scripts/colours-derive.mjs --limit 20
 *   node scripts/colours-derive.mjs --dry           # retrieve and report, call nothing
 *   node scripts/colours-derive.mjs --seasoned    # only books in a season
 *   node scripts/colours-derive.mjs --work 41 --force
 *
 * Resumable, one work at a time, and it never overwrites a colour that is
 * already there without --force. Retrieval is cached in `history_sources`,
 * so a second run costs nothing on books it has already fetched.
 *
 * A throttled Wikipedia is NOT a book with no article. `RetrievalUnavailable`
 * stops the run rather than being counted as a hatch — reading absence into a
 * 429 would silently mark a third of the library unassignable for entirely
 * the wrong reason, and it would look exactly like success.
 */
import { all, get } from '../db/index.js';
import { derive, classify } from '../lib/colour-derive.js';
import { retrieve, cachedFor, eligibility, RetrievalUnavailable } from '../lib/colour-evidence.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const ALL = flag('all');
const DRY = flag('dry');
const FORCE = flag('force');
const LIMIT = Number(value('limit', ALL ? 1000 : 200));
const ONE = value('work', null);

// Only the books that are actually in a season.
//
// Library-wide coverage is the wrong target: 411 works exist, 45 are in a
// season, and a season is the only place a colour is ever seen. Everything
// else is a book on a shelf that nobody has read yet.
const SEASONED = flag('seasoned');

const works = ONE
  ? all('SELECT id, title FROM works WHERE id = ?', Number(ONE))
  : all(
      `SELECT DISTINCT w.id, w.title
         FROM works w
         ${SEASONED ? 'JOIN season_frames sf ON sf.work_id = w.id AND sf.hidden = 0'
                    : (ALL ? '' : "JOIN readings r ON r.work_id = w.id AND r.status = 'FINISHED'")}
        WHERE ${FORCE ? '1 = 1' : 'w.colour_id IS NULL'}
        ORDER BY w.id
        LIMIT ?`,
      LIMIT);

if (!works.length) {
  console.log('nothing to do — every book in scope already has a colour');
  process.exit(0);
}

console.log(`${works.length} work${works.length === 1 ? '' : 's'}${DRY ? ' (dry run)' : ''}\n`);

const tally = { derived: 0, held: 0, hatch: 0, cleared: 0, skipped: 0, eligible: 0 };
const reasons = new Map();
// What the retry loop is worth: cards that failed once and came good.
const recovered = { onRetry: 0, firstTry: 0 };
// What is left over, by kind, so the residual can be read at a glance.
const residual = new Map();

for (const w of works) {
  const label = w.title.length > 44 ? w.title.slice(0, 43) + '…' : w.title;
  try {
    if (DRY) {
      // Retrieval only. Answers the one question worth knowing before
      // spending anything: how much of this library is even eligible?
      const found = cachedFor(w.id) || await retrieve(w.id);
      const fit = eligibility(found?.sections || [], { article: found?.article ?? null });
      if (fit.ok) {
        tally.eligible++;
        console.log(`  ✓ ${label.padEnd(45)} ${fit.total} chars · ${fit.interpretive.join(', ')}`);
      } else {
        tally.hatch++;
        reasons.set(fit.reason.split(' (')[0], (reasons.get(fit.reason.split(' (')[0]) || 0) + 1);
        console.log(`  · ${label.padEnd(45)} ${fit.reason}`);
      }
      continue;
    }

    const out = await derive(w.id, { force: FORCE });
    tally[out.kind] = (tally[out.kind] || 0) + 1;

    if (out.kind === 'derived') {
      if (out.attempts > 1) recovered.onRetry++; else recovered.firstTry++;
      const mix = out.colour.components
        .map((c) => `${c.emotion} ${Math.round(c.weight * 100)}%`).join(' · ');
      console.log(`  ✓ ${label.padEnd(45)} ${out.colour.hex} ${out.colour.name}` +
                  (out.attempts > 1 ? `  [recovered on attempt ${out.attempts}]` : ''));
      console.log(`      ${mix}`);
      for (const c of out.colour.components) {
        console.log(`      ${c.emotion.padEnd(14)} [${c.section}] ${c.evidence}`);
      }
    } else if (out.kind === 'held') {
      console.log(`  = ${label.padEnd(45)} already ${out.colour.name}`);
    } else if (out.kind === 'cleared') {
      console.log(`  ✗ ${label.padEnd(45)} CLEARED — the stored card fails current rules`);
      console.log(`      it was: ${out.was.join('; ')}`);
      console.log(`      redo:   ${(out.problems || []).join('; ')}`);
      reasons.set('cleared', (reasons.get('cleared') || 0) + 1);
    } else {
      const why = out.reason + (out.problems ? `: ${out.problems.join('; ')}` : '');
      reasons.set(out.reason, (reasons.get(out.reason) || 0) + 1);
      for (const k of new Set((out.problems || []).map(classify))) {
        residual.set(k, (residual.get(k) || 0) + 1);
      }
      console.log(`  · ${label.padEnd(45)} ${why}`);
    }
  } catch (err) {
    if (err instanceof RetrievalUnavailable) {
      console.error(`\nSTOPPED at "${w.title}": ${err.message}.`);
      console.error('This is throttling, not absence. Nothing was marked unassignable.');
      console.error('Wait and run again — retrieval is cached, so it resumes where it stopped.');
      process.exit(2);
    }
    throw err;
  }
}

console.log('\n' + '─'.repeat(60));
for (const [k, n] of Object.entries(tally)) if (n) console.log(`  ${k.padEnd(10)} ${n}`);
if (reasons.size) {
  console.log('\n  why not:');
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${r}`);
  }
}

if (recovered.onRetry || recovered.firstTry) {
  const total = recovered.onRetry + recovered.firstTry;
  console.log('\n  the retry loop:');
  console.log(`    ${String(recovered.firstTry).padStart(4)}  passed first time`);
  console.log(`    ${String(recovered.onRetry).padStart(4)}  recovered on a retry` +
              (total ? `  (${Math.round(recovered.onRetry / total * 100)}% of what landed)` : ''));
}

if (residual.size) {
  console.log('\n  what is still failing, by kind:');
  for (const [k, n] of [...residual].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
}

const done = get('SELECT COUNT(*) n FROM works WHERE colour_id IS NOT NULL').n;
const total = get('SELECT COUNT(*) n FROM works').n;
console.log(`\n  ${done} of ${total} works carry a colour`);
