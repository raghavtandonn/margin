import { all, get, run } from '../db/index.js';
import * as C from '../lib/covers.js';
import * as W from '../lib/works.js';

// Resolve, verify, and cache covers.
//
//   npm run covers              # works with no verified cover yet
//   npm run covers -- --purge   # first, clear every unverified stored URL
//   npm run covers -- --all     # re-check every work, including known misses
//
// WORK-CENTRIC by design. The app displays one edition per work, so what
// matters is whether each WORK resolves a cover — not whether all 1,045
// editions do. Resolving per work also spends requests where they change
// what the reader sees.
//
// The original bug was storing unverified guesses: a URL was generated for
// any edition with an ISBN and saved as though it were a real cover. Measured
// at a 5% hit rate against 100% for URLs Open Library actually confirmed.

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const PURGE = args.includes('--purge');
const limitAt = args.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;

const olCache = new Map();
async function olCoverIdFor(olKey) {
  if (!olKey) return null;
  if (olCache.has(olKey)) return olCache.get(olKey);
  try {
    const res = await fetch(`https://openlibrary.org${olKey}.json`, {
      headers: { 'User-Agent': 'MARGIN/0.5 (personal reading log)' }
    });
    const id = res.ok ? ((await res.json()).covers || []).find((c) => c > 0) || null : null;
    olCache.set(olKey, id);
    return id;
  } catch {
    olCache.set(olKey, null);
    return null;
  }
}

async function main() {
  if (PURGE) {
    const n = run(
      `UPDATE editions SET cover_url = NULL, cover_cache_key = NULL, cover_checked_at = NULL
       WHERE cover_source IS NULL`
    ).changes;
    console.log(`  PURGED ${n} UNVERIFIED COVER URLS\n`);
  }

  const works = all(
    `SELECT w.id, w.title,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
             WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
     FROM works w
     ${ALL ? '' : `WHERE NOT EXISTS (
       SELECT 1 FROM editions e WHERE e.work_id = w.id AND e.cover_url IS NOT NULL
     )`}
     ORDER BY w.id`
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log('"MARGIN" — RESOLVING COVERS');
  console.log(`  ${works.length} WORKS TO RESOLVE`);
  console.log('  CHAIN: OL COVER ID -> OL BY ISBN -> OL SEARCH -> GOOGLE BOOKS -> GALLEY PLATE\n');

  const tally = {};
  let resolved = 0;

  for (const [i, w] of works.entries()) {
    // Try the editions most likely to carry a jacket first.
    const editions = all(
      `SELECT id, isbn13, isbn10, ol_key FROM editions WHERE work_id = ?
       ORDER BY (ol_key IS NULL), (isbn13 IS NULL), published_year DESC
       LIMIT 4`,
      w.id
    );

    let hit = null;
    for (const ed of editions) {
      const olCoverId = await olCoverIdFor(ed.ol_key);
      hit = await C.resolveCover(ed, { olCoverId, title: null, author: null, olCoverIdIsVerified: true });
      if (hit) break;
    }

    // Nothing on any edition — ask the search index about the work itself.
    //
    // A work with NO edition row still deserves a jacket: an import that
    // could not be resolved has a title and an author, and the search index
    // very often knows the book. Without a row to hang the cover on it would
    // be skipped entirely, which is what left Anna Karenina and A Wild Sheep
    // Chase showing galley plates.
    if (!hit) {
      const searchId = await C.coverIdForWork(w.title, w.author);
      if (searchId) {
        let target = editions[0];
        if (!target) {
          const id = W.addEdition(w.id, { format: 'PAPERBACK' });
          target = get('SELECT id, isbn13, isbn10, ol_key FROM editions WHERE id = ?', id);
        }
        hit = await C.resolveCover(target, {
          olCoverId: searchId,
          title: w.title,
          author: w.author
        });
        if (hit) hit.source = 'openlibrary-search';
      }
    }

    const source = hit ? hit.source : 'none';
    tally[source] = (tally[source] || 0) + 1;
    if (hit) resolved++;

    if ((i + 1) % 20 === 0 || i === works.length - 1) {
      process.stdout.write(
        `  [${String(i + 1).padStart(4)}/${works.length}] ${resolved} resolved (${Math.round((resolved / (i + 1)) * 100)}%)\n`
      );
    }
  }

  console.log('\n  BY SOURCE');
  for (const [k, v] of Object.entries(tally)) console.log(`    ${k.padEnd(20)} ${v}`);

  const total = get('SELECT COUNT(*) n FROM works').n;
  const covered = get(
    `SELECT COUNT(*) n FROM works w
     WHERE EXISTS (SELECT 1 FROM editions e WHERE e.work_id = w.id AND e.cover_url IS NOT NULL)`
  ).n;
  console.log(`\n  LIBRARY HIT RATE  ${covered}/${total}  (${Math.round((covered / total) * 100)}%)`);
}

main();
