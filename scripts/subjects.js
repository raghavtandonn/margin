import { all, get, run } from '../db/index.js';
import { cleanBlurb } from '../lib/blurb.js';

// Backfill subject headings and blurbs from Open Library.
//
// The desk's tier 2 is a semantic search over what a book is ABOUT. With no
// subjects and no blurb there is nothing to match on, and "books about grief"
// returns an empty shelf however good the maths is.
//
//   npm run subjects
//   npm run subjects -- --all

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const limitAt = args.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;

const UA = 'MARGIN/0.5 (personal reading log)';

let last = 0;
async function polite(gap = 220) {
  const wait = Math.max(0, last + gap - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function ol(path) {
  await polite();
  try {
    const res = await fetch(`https://openlibrary.org${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Open Library subjects are freeform and long-tailed: one book carries
// "Fiction", "American fiction", "New York (N.Y.) -- Fiction" and "Large type
// books" at once. Physical-format and audience subjects say nothing about
// what a book is about, so they are dropped rather than indexed as content.
const JUNK = /^(large type|large print|audiobook|talking book|juvenile|reading level|accessible book|protected daisy|in library|overdrive|internet archive|open library|nyt:|new york times bestseller|lending library|popular print disabled)/i;

const cleanSubjects = (list) =>
  [...new Set(
    (list || [])
      .map((s) => String(s).trim())
      .filter((s) => s.length > 2 && s.length < 60 && !JUNK.test(s))
      // "New York (N.Y.) -- Fiction" carries two facets; keep both halves.
      .flatMap((s) => s.split(/\s+--\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && !JUNK.test(s))
  )].slice(0, 40);

// Marketing matter is stripped here, at ingest, so a stored blurb is
// already clean and nothing has to filter it at render time.
const blurbOf = (d) => {
  const raw = typeof d?.description === 'string' ? d.description : d?.description?.value;
  return cleanBlurb(raw)?.slice(0, 1600) || null;
};

async function main() {
  const works = all(
    `SELECT id, title, ol_key,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
             WHERE wp.work_id = works.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
     FROM works
     ${ALL ? '' : 'WHERE subjects_fetched_at IS NULL'}
     ORDER BY id`
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log('"MARGIN" — BACKFILLING SUBJECTS AND BLURBS');
  console.log(`  ${works.length} WORKS\n`);

  let withSubjects = 0;
  let withBlurb = 0;

  for (const [i, w] of works.entries()) {
    let key = w.ol_key;

    // A work imported from a pasted table view has no OL key; find one.
    if (!key) {
      const q = encodeURIComponent(`${w.title} ${w.author || ''}`.trim());
      const found = await ol(`/search.json?q=${q}&fields=key,author_name&limit=1`);
      key = found?.docs?.[0]?.key || null;
      // Two works can legitimately resolve to the same Open Library key.
      // The column is unique, so the key is only claimed if it is free.
      if (key && !get('SELECT 1 AS x FROM works WHERE ol_key = ?', key)) {
        run('UPDATE works SET ol_key = ? WHERE id = ?', key, w.id);
      } else if (key) {
        key = null;
      }
    }

    let subjects = [];
    let blurb = null;

    if (key) {
      const d = await ol(`${key}.json`);
      if (d) {
        subjects = cleanSubjects([
          ...(d.subjects || []),
          ...(d.subject_places || []),
          ...(d.subject_times || [])
        ]);
        blurb = blurbOf(d);
      }
    }

    // The search index also carries subjects, and often has them when the
    // work record does not.
    if (!subjects.length) {
      const q = encodeURIComponent(`${w.title} ${w.author || ''}`.trim());
      const s = await ol(`/search.json?q=${q}&fields=subject,first_sentence&limit=1`);
      subjects = cleanSubjects(s?.docs?.[0]?.subject || []);
    }

    run(
      `UPDATE works SET subjects = ?, blurb = COALESCE(?, blurb),
         subjects_fetched_at = datetime('now') WHERE id = ?`,
      subjects.length ? JSON.stringify(subjects) : null,
      blurb,
      w.id
    );

    if (subjects.length) withSubjects++;
    if (blurb) withBlurb++;

    if ((i + 1) % 25 === 0 || i === works.length - 1) {
      process.stdout.write(
        `  [${String(i + 1).padStart(4)}/${works.length}] ${withSubjects} with subjects · ${withBlurb} with blurb\n`
      );
    }
  }

  console.log(`\n  SUBJECTS ${withSubjects}`);
  console.log(`  BLURBS   ${withBlurb}`);
  console.log('\n  NEXT: npm run index   (build the desk\'s vectors)');
}

main();
