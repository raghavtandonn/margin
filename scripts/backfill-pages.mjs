// ── PAGE COUNTS ──────────────────────────────────────────
//
// A book with no page count has no ceiling on the page number, no
// percentage, and no mark on the rule — the reading page shows "775 / ?"
// and the desk cannot answer a question about length. 158 of 411 works had
// none on any edition.
//
// Open Library knows most of them. This walks the works that have none and
// asks, by ISBN first and by edition key second, filling ONLY the empty
// field and never overwriting anything already recorded.
//
//   node scripts/backfill-pages.mjs [--limit N] [--dry]
//
// Resumable: it only looks at works that still have nothing, so running it
// twice does the remainder rather than the lot again.

import { all, get, run } from '../db/index.js';
import { byISBN, editionsOfWork, resolveWork, pagesMedian } from '../lib/openlibrary.js';

const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const DRY = args.includes('--dry');

// Open Library asks for one request at a time and a real user agent. Being
// a good guest costs nothing here: this runs once.
const PAUSE_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = all(
  `SELECT w.id, w.title, w.ol_key
     FROM works w
    WHERE NOT EXISTS (
      SELECT 1 FROM editions e WHERE e.work_id = w.id AND e.page_count IS NOT NULL)
    ORDER BY
      -- Books being read now matter most: they are the ones showing "?".
      (SELECT COUNT(*) FROM readings r WHERE r.work_id = w.id AND r.status = 'READING') DESC,
      (SELECT COUNT(*) FROM readings r WHERE r.work_id = w.id) DESC,
      w.title`
);

console.log(`${targets.length} works with no page count on any edition.`);
if (DRY) {
  for (const t of targets.slice(0, 20)) console.log('  ', t.title);
  process.exit(0);
}

let filled = 0, asked = 0, missing = 0;

for (const work of targets.slice(0, LIMIT)) {
  const editions = all(
    `SELECT id, isbn13, isbn10, ol_key FROM editions
      WHERE work_id = ? AND page_count IS NULL
      ORDER BY (isbn13 IS NULL), id`,
    work.id
  );

  let got = null;
  for (const ed of editions) {
    const isbn = ed.isbn13 || ed.isbn10;
    if (!isbn) continue;

    asked++;
    let data = null;
    try { data = await byISBN(isbn); } catch { data = null; }
    await sleep(PAUSE_MS);

    if (data?.page_count) {
      // Only the empty field. Nothing already recorded is touched.
      run('UPDATE editions SET page_count = ? WHERE id = ? AND page_count IS NULL',
          data.page_count, ed.id);
      run(`INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
           VALUES ('edition', ?, 'page_count', NULL, ?, 'openlibrary')`,
          ed.id, String(data.page_count));
      got = data.page_count;
      break;
    }
  }

  // Most of the library was imported from a CSV with no ISBNs at all, so
  // the ISBN route reaches almost none of it. The work's own Open Library
  // key does: ask what editions exist and take a length from whichever one
  // states it. A different printing of the same book is a fair estimate of
  // its length, and it is what the reading page already falls back to.
  if (!got && work.ol_key) {
    asked++;
    let siblings = [];
    try { siblings = await editionsOfWork(work.ol_key, { limit: 20 }); } catch { siblings = []; }
    await sleep(PAUSE_MS);

    const counts = siblings.map((e) => e.page_count).filter((n) => n > 20 && n < 20000);
    if (counts.length) {
      // The median of what the printings say, so one mis-keyed 3,000-page
      // record does not become the length of the book.
      counts.sort((a, b) => a - b);
      const median = counts[Math.floor(counts.length / 2)];

      const target = editions[0] || get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', work.id);
      if (target) {
        run('UPDATE editions SET page_count = ? WHERE id = ? AND page_count IS NULL',
            median, target.id);
        run(`INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
             VALUES ('edition', ?, 'page_count', NULL, ?, 'openlibrary:siblings')`,
            target.id, String(median));
        got = median;
      }
    }
  }

  // Open Library's own median, across EVERY edition of the work.
  //
  // The sibling walk above reads the first twenty editions. That is enough
  // for a modern book and useless for an old one: Treasure Island has 1,991
  // editions, none of the first twenty states an extent, and its median is
  // 248 pages — one request away, and missed entirely. This tier is one call
  // and it sees all of them.
  //
  // `pagesMedian` refuses unless the returned title agrees with ours. That
  // guard earns itself immediately: this library's key for The Wind-Up Bird
  // Chronicle points at a 99-page study guide OF the novel, and taking its
  // median would have recorded a 600-page book as 99 pages with a citation
  // attached.
  if (!got && work.ol_key) {
    asked++;
    let median = null;
    try { median = await pagesMedian(work.ol_key, work.title); } catch { median = null; }
    await sleep(PAUSE_MS);

    if (median) {
      const target = editions[0] || get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', work.id);
      if (target) {
        run('UPDATE editions SET page_count = ? WHERE id = ? AND page_count IS NULL',
            median, target.id);
        run(`INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
             VALUES ('edition', ?, 'page_count', NULL, ?, 'openlibrary:median')`,
            target.id, String(median));
        got = median;
      }
    }
  }

  // Last tier. Some works are linked to an Open Library record that states
  // no lengths at all — this library's Doctor Zhivago points at a Russian
  // edition whose four printings all leave the field blank.
  //
  // resolveWork does the careful title-and-author match the importer uses,
  // and it is used here READ-ONLY: the work's own identity is never
  // relinked, because attaching the wrong record is how Lolita ended up
  // dated 1777. Only a length is taken, and only on an AUTHOR MATCH.
  if (!got) {
    const author = get(
      `SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = ? AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1`,
      work.id
    )?.name;

    if (author) {
      asked++;
      let match = null;
      try { match = await resolveWork(work.title, author); } catch { match = null; }
      await sleep(PAUSE_MS);

      if (match?.workKey && match.confidence === 'AUTHOR MATCH' && match.workKey !== work.ol_key) {
        let siblings = [];
        try { siblings = await editionsOfWork(match.workKey, { limit: 20 }); } catch { siblings = []; }
        await sleep(PAUSE_MS);

        const counts = siblings.map((e) => e.page_count).filter((n) => n > 20 && n < 20000);
        if (counts.length) {
          counts.sort((a, b) => a - b);
          const median = counts[Math.floor(counts.length / 2)];
          const target = editions[0] || get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', work.id);
          if (target) {
            run('UPDATE editions SET page_count = ? WHERE id = ? AND page_count IS NULL',
                median, target.id);
            run(`INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
                 VALUES ('edition', ?, 'page_count', NULL, ?, 'openlibrary:matched')`,
                target.id, String(median));
            got = median;
          }
        }
      }
    }
  }

  if (got) {
    filled++;
    console.log(`  ${String(got).padStart(5)}pp  ${work.title.slice(0, 62)}`);
  } else {
    missing++;
  }
}

console.log(`\nfilled ${filled}, still unknown ${missing}, ${asked} lookups.`);
console.log('Anything still unknown can be typed on the reading page: the number beside the page.');
