import { all, get, run, reindexWork } from '../db/index.js';
import * as OL from '../lib/openlibrary.js';
import * as W from '../lib/works.js';

// Backfill covers, page counts, publishers, and sibling editions from Open
// Library for everything already in the graph — the books a Goodreads CSV
// brought in with nothing but a title and an ISBN.
//
//   npm run enrich              # everything missing metadata
//   npm run enrich -- --limit 20
//   npm run enrich -- --editions   # also pull sibling editions

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const WITH_EDITIONS = args.includes('--editions');
const RESOLVE = args.includes('--resolve');

// Works imported from a pasted table view have no editions at all, because
// the table view carries no ISBNs. Resolving them against Open Library is
// what gives them a cover, a page count, and a colophon. Resumable: a work
// that already has an edition is skipped, so this can be re-run any time.
async function resolveMissing() {
  const orphans = all(
    `SELECT w.id, w.title FROM works w
     LEFT JOIN editions e ON e.work_id = w.id
     WHERE e.id IS NULL ORDER BY w.id`
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`"MARGIN" — RESOLVING EDITIONS FROM OPEN LIBRARY`);
  console.log(`  ${orphans.length} WORKS WITH NO EDITION\n`);

  let resolved = 0;
  let unresolved = 0;

  for (const [i, w] of orphans.entries()) {
    const author = get(
      `SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
       WHERE wp.work_id = ? AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1`,
      w.id
    );

    // A low-confidence match is refused: a wrong cover and ISBN on the shelf
    // is worse than a book with no edition data.
    const match = await OL.resolveWork(w.title, author?.name || '');
    const n = `[${String(i + 1).padStart(4)}/${orphans.length}]`;

    if (!match) {
      unresolved++;
      console.log(`  ${n} ${w.title.slice(0, 46).padEnd(47)} NO CONFIDENT MATCH`);
      continue;
    }

    run(
      'UPDATE works SET ol_key = ?, first_published_year = COALESCE(first_published_year, ?) WHERE id = ?',
      match.workKey, match.year || null, w.id
    );

    let added = 0;
    for (const e of await OL.editionsOfWork(match.workKey, { limit: 5 })) {
      if (!e.isbn13 || get('SELECT id FROM editions WHERE isbn13 = ?', e.isbn13)) continue;
      W.addEdition(w.id, e);
      added++;
    }
    if (!added) {
      W.addEdition(w.id, {
        isbn13: match.isbn13 || null,
        cover_url: match.cover_url || null,
        published_year: match.year || null,
        format: 'PAPERBACK'
      });
      added = 1;
    }

    reindexWork(w.id);
    resolved++;
    console.log(`  ${n} ${w.title.slice(0, 46).padEnd(47)} +${added} ED · ${match.confidence}`);
  }

  console.log(`\n  RESOLVED   ${resolved}`);
  console.log(`  UNRESOLVED ${unresolved} (kept, with rating and review intact)`);
}

async function main() {
  if (RESOLVE) {
    await resolveMissing();
    if (!WITH_EDITIONS) return;
  }

  // Editions missing a cover or a page count are the ones worth a request.
  const stale = all(
    `SELECT id, isbn13 FROM editions
     WHERE isbn13 IS NOT NULL AND (cover_url IS NULL OR page_count IS NULL OR publisher IS NULL)
     ORDER BY id`
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`"MARGIN" — ENRICHING FROM OPEN LIBRARY`);
  console.log(`  ${stale.length} EDITIONS TO LOOK UP`);
  if (!stale.length) console.log('  NOTHING MISSING.');

  let filled = 0;
  let missing = 0;

  for (const [i, ed] of stale.entries()) {
    const r = await OL.enrichEdition(ed.id);
    const tag = r.ok ? (r.filled.length ? r.filled.join(',') : 'ALREADY COMPLETE') : r.reason;
    if (r.ok && r.filled.length) filled++;
    if (!r.ok) missing++;
    process.stdout.write(`  [${String(i + 1).padStart(4)}/${stale.length}] ${ed.isbn13}  ${tag}\n`);
  }

  if (WITH_EDITIONS) {
    // Works with a single edition have nothing to select between in the
    // filmstrip, which is where the work/edition distinction becomes visible.
    const thin = all(
      `SELECT w.id, w.title FROM works w
       JOIN editions e ON e.work_id = w.id
       GROUP BY w.id HAVING COUNT(e.id) = 1
       ORDER BY w.id`
    ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

    console.log(`\n  ${thin.length} WORKS WITH A SINGLE EDITION`);
    for (const [i, w] of thin.entries()) {
      const r = await OL.addSiblingEditions(w.id);
      const tag = r.ok ? `+${r.added} EDITIONS` : r.reason;
      process.stdout.write(`  [${String(i + 1).padStart(4)}/${thin.length}] ${w.title.slice(0, 40).padEnd(40)} ${tag}\n`);
    }
  }

  console.log(`\n  FILLED   ${filled}`);
  console.log(`  MISSING  ${missing}  (not on Open Library — the record stays as it was)`);
}

main();
