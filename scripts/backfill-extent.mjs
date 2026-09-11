// Fill an edition's page count where the catalogue has one and we don't.
//
// Two routes, in order of confidence: the edition record itself by ISBN,
// then the work's median across editions. The second is guarded on title
// agreement because a bare title search surfaces study guides above novels.
//
// A book no source can reach keeps its `?`, which is an editable field on
// the press — the reader is the only one who can measure the object in
// their hands, and a guessed extent would be worse than an empty one.
import { db } from '../db/index.js';
import * as OL from '../lib/openlibrary.js';

const only = process.argv.slice(2).map(Number).filter(Boolean);
const rows = db.prepare(`
  SELECT e.id, e.work_id, e.isbn13, w.title,
         (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
           WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' LIMIT 1) AS author
    FROM editions e JOIN works w ON w.id = e.work_id
   WHERE e.page_count IS NULL
     ${only.length ? `AND e.work_id IN (${only.join(',')})` : ''}
   ORDER BY e.work_id`).all();

console.log(`${rows.length} edition(s) with no page count\n`);
let filled = 0, unreachable = 0;

for (const r of rows) {
  const name = r.title.slice(0, 46);
  try {
    let pages = null, via = null;
    if (r.isbn13) {
      const d = await OL.byISBN(r.isbn13);
      if (d?.page_count) { pages = d.page_count; via = 'isbn'; }
      if (!pages && d?.workKey) {
        pages = await OL.pagesMedian(d.workKey, r.title);
        if (pages) via = 'work median';
      }
    }
    // A catalogue title carries its subtitle; Open Library's usually does
    // not, and the full string resolves to nothing. Both forms are tried —
    // pagesMedian re-checks title agreement either way, so a wrong
    // resolution is still refused rather than written.
    for (const form of [r.title, r.title.split(':')[0]]) {
      if (pages) break;
      const w = await OL.resolveWork(form, r.author);
      const wk = w?.workKey || w?.key;
      if (!wk) continue;
      pages = await OL.pagesMedian(wk, r.title);
      if (pages) via = `resolved work (${w.confidence || 'match'})`;
      await new Promise((z) => setTimeout(z, 900));
    }
    if (pages) {
      db.prepare('UPDATE editions SET page_count = ? WHERE id = ?').run(pages, r.id);
      db.prepare(`INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
                  VALUES ('edition', ?, 'page_count', NULL, ?, 'openlibrary')`).run(r.id, String(pages));
      console.log(`  ${String(pages).padStart(5)}pp  ${name}  (${via})`);
      filled++;
    } else {
      console.log(`      ?pp  ${name}  — no source has it`);
      unreachable++;
    }
  } catch (e) {
    // Throttling is not absence: a failed call is reported as a failure and
    // the row is left alone to be retried, never written as unreachable.
    console.log(`   RETRY  ${name}  — ${e.constructor.name}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 1100));
}
console.log(`\nfilled ${filled}, unreachable ${unreachable}, of ${rows.length}`);
