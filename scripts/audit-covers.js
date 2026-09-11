import { all, get, run } from '../db/index.js';
import { coverIdForWork, cacheKey } from '../lib/covers.js';

// Re-verify every cover that was attached by TITLE SEARCH rather than by a
// confirmed ISBN or Open Library edition id.
//
// A search-sourced cover is only as good as the rule that accepted it, and an
// early rule accepted a perfect title match without author agreement. That is
// how Isaac Asimov's "Gold" ended up on Rumi's "Gold": four letters matches
// four letters, and title similarity is no evidence at all on a short title.
//
// Anything the current, stricter rule would no longer accept is cleared back
// to the galley plate. A blank cover is honest; a confidently wrong one is not.
//
//   npm run audit:covers          report only
//   npm run audit:covers -- --fix clear the ones that no longer qualify

const FIX = process.argv.includes('--fix');

async function main() {
  const rows = all(
    `SELECT e.id AS edition_id, e.cover_url, e.cover_source, w.id AS work_id, w.title,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
             WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
     FROM editions e JOIN works w ON w.id = e.work_id
     -- An edition having an ISBN does NOT prove its cover came from that
     -- ISBN: Rumi's "Gold" carries a correct ISBN and Isaac Asimov's jacket,
     -- because the ISBN had no cover and the title search supplied one.
     -- Only a cover fetched by ISBN is identity-proven; everything else is
     -- re-checked.
     WHERE e.cover_url IS NOT NULL AND e.cover_source != 'openlibrary-isbn'
     ORDER BY w.title`
  );

  console.log('"MARGIN" — AUDITING SEARCH-SOURCED COVERS');
  console.log(`  ${rows.length} TO RE-VERIFY UNDER THE CURRENT RULE\n`);

  let kept = 0;
  let alternates = 0;
  const suspect = [];

  for (const [i, r] of rows.entries()) {
    const id = await coverIdForWork(r.title, r.author);
    // The stored URL carries the cover id it was built from.
    const storedId = (String(r.cover_url).match(/\/b\/id\/(\d+)-/) || [])[1] || null;

    if (id && String(id) === storedId) {
      kept++;
    } else if (id) {
      // A different id is usually another edition's jacket of the same book,
      // which is not an error. Noted, never auto-replaced.
      alternates++;
    } else {
      suspect.push({ ...r, reason: 'NO LONGER CONFIDENT', replaceWith: null });
    }

    if ((i + 1) % 25 === 0) {
      process.stdout.write(`  [${String(i + 1).padStart(4)}/${rows.length}] ${suspect.length} suspect\n`);
    }
  }

  console.log(`\n  CONFIRMED   ${kept}  (same cover)`);
  console.log(`  ALTERNATE   ${alternates}  (a different edition's jacket — left alone)`);
  console.log(`  UNSUPPORTED ${suspect.length}  (the current rule would refuse these)\n`);

  for (const s of suspect) {
    console.log(`    ${String(s.title).slice(0, 44).padEnd(45)} ${String(s.author || '').slice(0, 20).padEnd(21)} ${s.reason}`);
  }

  if (!FIX) {
    console.log('\n  REPORT ONLY. RE-RUN WITH --fix TO CLEAR THESE.');
    return;
  }

  let cleared = 0;
  let replaced = 0;
  for (const s of suspect) {
    if (s.replaceWith) {
      const url = `https://covers.openlibrary.org/b/id/${s.replaceWith}-L.jpg?default=false`;
      run(
        `UPDATE editions SET cover_url = ?, cover_cache_key = ?, spine_color = NULL WHERE id = ?`,
        url, cacheKey(url), s.edition_id
      );
      replaced++;
    } else {
      run(
        `UPDATE editions SET cover_url = NULL, cover_cache_key = NULL, spine_color = NULL,
           cover_source = 'none' WHERE id = ?`,
        s.edition_id
      );
      cleared++;
    }
  }

  console.log(`\n  REPLACED ${replaced}`);
  console.log(`  CLEARED  ${cleared}  (back to the galley plate)`);
  console.log('\n  NEXT: npm run covers   then   npm run spines');
}

main();
