import { run, get, db } from '../db/index.js';

// Seed corpus for the Gap.
//
// The spec asks for 5,000–10,000 editorially curated books. There is no such
// list to hand, and an unfiltered catalogue would make the distance term
// surface noise rather than the interesting far edge.
//
// The curation signal used instead is EDITION COUNT: a book reprinted forty
// times has been vouched for repeatedly by people who had to pay to print it.
// Combined with a deliberately broad spread of subjects, that produces a
// corpus whose far edge is unfamiliar rather than junk.
//
//   npm run gap:corpus
//   npm run gap:corpus -- --min-editions 25

const args = process.argv.slice(2);
const minAt = args.indexOf('--min-editions');
const MIN_EDITIONS = minAt >= 0 ? Number(args[minAt + 1]) : 18;

// Deliberately wide. The Gap is only interesting if the corpus reaches
// places the reader's library does not.
const SUBJECTS = [
  'literature', 'poetry', 'drama', 'essays', 'philosophy', 'ethics',
  'history', 'biography', 'memoir', 'anthropology', 'archaeology',
  'science', 'physics', 'mathematics', 'biology', 'natural_history',
  'psychology', 'sociology', 'economics', 'political_science',
  'art', 'architecture', 'photography', 'music', 'film',
  'religion', 'mysticism', 'mythology', 'folklore',
  'travel', 'nature', 'gardening', 'food', 'craft',
  'science_fiction', 'fantasy', 'horror', 'mystery', 'historical_fiction',
  'short_stories', 'letters', 'diaries', 'translation',
  'african_literature', 'japanese_literature', 'russian_literature',
  'latin_american_literature', 'arabic_literature', 'indian_literature',
  'chinese_literature', 'nordic_literature', 'caribbean_literature',
  'medicine', 'technology', 'linguistics', 'education', 'law',
  'war', 'exploration', 'geology', 'astronomy', 'ecology'
];

const UA = 'MARGIN/0.5 (personal reading log)';
let last = 0;
const polite = async (gap = 260) => {
  const w = Math.max(0, last + gap - Date.now());
  if (w) await new Promise((r) => setTimeout(r, w));
  last = Date.now();
};

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

function ensure() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_corpus (
      id        INTEGER PRIMARY KEY,
      title     TEXT NOT NULL,
      author    TEXT NOT NULL,
      year      INTEGER,
      subjects  TEXT NOT NULL,
      ol_key    TEXT,
      cover_id  INTEGER
    )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gap_corpus_key ON gap_corpus(ol_key) WHERE ol_key IS NOT NULL');
}

async function main() {
  ensure();
  console.log('"MARGIN" — BUILDING THE GAP CORPUS');
  console.log(`  ${SUBJECTS.length} SUBJECTS · MIN ${MIN_EDITIONS} EDITIONS\n`);

  let added = 0;
  let seen = 0;

  for (const [i, subject] of SUBJECTS.entries()) {
    const data = await ol(
      `/search.json?subject=${encodeURIComponent(subject)}` +
      `&fields=key,title,author_name,first_publish_year,subject,cover_i,edition_count` +
      `&sort=editions&limit=60`
    );

    for (const d of data?.docs || []) {
      seen++;
      if ((d.edition_count || 0) < MIN_EDITIONS) continue;
      if (!d.title || !d.author_name?.length || !d.key) continue;

      // Subjects are what the distance term actually reads, so a candidate
      // with none is useless whatever its pedigree.
      const subjects = (d.subject || []).slice(0, 30).join(' ');
      if (!subjects) continue;

      run(
        `INSERT OR IGNORE INTO gap_corpus (title, author, year, subjects, ol_key, cover_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        d.title, d.author_name[0], d.first_publish_year || null,
        `${subject} ${subjects}`, d.key, d.cover_i || null
      );
      added++;
    }

    process.stdout.write(
      `  [${String(i + 1).padStart(2)}/${SUBJECTS.length}] ${subject.padEnd(28)} ${get('SELECT COUNT(*) n FROM gap_corpus').n} in corpus\n`
    );
  }

  const total = get('SELECT COUNT(*) n FROM gap_corpus').n;
  const authors = get('SELECT COUNT(DISTINCT author) n FROM gap_corpus').n;
  console.log(`\n  CORPUS   ${total} BOOKS · ${authors} AUTHORS`);
  console.log(`  SCANNED  ${seen} CANDIDATES`);
}

main();
