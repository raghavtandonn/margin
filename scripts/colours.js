#!/usr/bin/env node
/**
 * RETIRING. Do not run this on a library that is being derived.
 *
 * This is the jacket sampler: it fills `editions.season_colour` by clustering
 * the cover artwork. The colour system replaced it — colour is derived from
 * what the sources say a book is doing, and a reader can overrule that — and
 * the values this writes now render only as PROVISIONAL bands: hatched,
 * dimmed, never named, and replaced the moment the book they belong to has
 * been derived.
 *
 * It is kept, and it still works, because 378 editions already carry a
 * sampled colour and those bands are holding the wall while the library is
 * derived. Running it again would add more of them, which is the wrong
 * direction.
 *
 * Use `npm run colours:derive` instead.
 */
import { all, run, nowSQL } from '../db/index.js';
import { readCached } from '../lib/covers.js';
import { colourOfCover, hasSips } from '../lib/colour.js';

// §8 — sample each jacket's dominant colour ONCE and cache it on the
// edition. The season strip reads the cached value; nothing decodes an
// image at render time.
//
//   npm run colours
//   npm run colours -- --all

const ALL = process.argv.includes('--all');

if (!hasSips()) {
  console.log('  sips UNAVAILABLE — the strip will use the no-cover band throughout');
  process.exit(0);
}

const rows = all(
  `SELECT id, cover_cache_key FROM editions
    WHERE cover_cache_key IS NOT NULL ${ALL ? '' : 'AND season_colour IS NULL'}`
);

console.log('"MARGIN" — SAMPLING JACKET COLOUR');
console.log(`  ${rows.length} EDITIONS\n`);

let done = 0;
let found = 0;

for (const e of rows) {
  const cached = readCached(e.cover_cache_key);
  const colour = cached ? colourOfCover(cached.buf) : null;

  run('UPDATE editions SET season_colour = ?, season_colour_at = ? WHERE id = ?',
      colour, nowSQL(), e.id);

  done++;
  if (colour) found++;
  if (done % 50 === 0 || done === rows.length) {
    process.stdout.write(`  [${String(done).padStart(4)}/${rows.length}] ${found} sampled\n`);
  }
}

console.log(`\n  SAMPLED ${found} of ${rows.length}`);
