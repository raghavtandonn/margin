// Parser for a Goodreads "My Books" table view pasted as plain text.
//
// The CSV export is better data, but it arrives by email on Goodreads'
// schedule. This reads what is already on screen. It is honest about what it
// cannot know: the table view carries no ISBNs, so editions have to be
// resolved against Open Library afterwards.
//
// Two copy shapes exist in the wild and both are handled:
//
//   A. Cover-alt duplicated title, stars on ONE line, rows end
//      "view » / Remove from my books"
//   B. Single title line, stars on FIVE lines, rows end "view »"
//
// Copying the page often yields every row twice (the table is rendered twice
// in the DOM), so records are deduplicated on title+author.

// Either delimiter ends a row. Splitting on both handles shape A, which has
// them one after the other, by producing an empty chunk that falls through
// the length check.
const RECORD_SPLIT = /Remove from my books|view\s*»/;

const HEADER_HINT = 'date added';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

// "Aug 20, 2026" -> "2026-08-20"
function parseDate(s) {
  const m = String(s || '').match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  return month ? `${m[3]}-${month}-${m[2].padStart(2, '0')}` : null;
}

// Goodreads marks the reader's own rating by bracketing it among the star
// links. No brackets means unrated, which is not the same as zero.
function parseRating(lines) {
  for (const l of lines) {
    const m = String(l).match(/\[\s*(\d)\s+of\s+5\s+stars\s*\]/);
    if (m) return Number(m[1]);
  }
  return null;
}

const isStarLine = (l) => /\d\s+of\s+5\s+stars/.test(l || '');
const isAvgRating = (l) => /^\d\.\d{1,2}$/.test(String(l || '').trim());

// "Schroeder, Paul W."    -> "Paul W. Schroeder"
// "La Fayette, Madame de" -> "Madame de La Fayette"
// "Seneca"                -> "Seneca"          (single-name authors stay put)
// "El-Mohtar, Amal *"     -> "Amal El-Mohtar"  (the * is a Goodreads badge)
export function normalizeAuthor(raw) {
  const clean = String(raw || '').replace(/\s*\*\s*$/, '').trim();
  if (!clean) return '';
  const comma = clean.indexOf(',');
  if (comma === -1) return clean;
  const last = clean.slice(0, comma).trim();
  const first = clean.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

// Only a "(Name, #N)" shape is a series. "(Classics Illustrated)" is an
// edition note and stays in the title. §04: titles keep the publisher's own
// capitalization, and a series marker is not part of the title.
const SERIES_RE = /\s*\(([^)]+?),?\s*#([\d.]+)\)\s*/;

function parseSeries(...candidates) {
  for (const c of candidates) {
    const m = String(c || '').match(SERIES_RE);
    if (m) return { name: m[1].trim(), position: Number(m[2]) };
  }
  return null;
}

const stripSeries = (title) => String(title || '').replace(SERIES_RE, ' ').trim();

const NOISE = new Set(['[edit]', 'Write a review', 'edit', 'view »', 'view', '»']);

export function parsePaste(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');

  // Drop the navigation and shelf sidebar that precedes the table.
  const headerAt = normalized.indexOf(HEADER_HINT);
  const body = headerAt === -1
    ? normalized
    : normalized.slice(normalized.indexOf('\n', headerAt) + 1);

  const books = [];
  const skipped = [];
  const seen = new Set();
  let duplicates = 0;

  for (const chunk of body.split(RECORD_SPLIT)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 6) continue;

    // Anchor on the run of star lines. Everything before it is
    // title/author/average; everything after is shelves, review, and dates.
    const starStart = lines.findIndex(isStarLine);
    if (starStart < 0) continue;

    let starEnd = starStart;
    while (starEnd + 1 < lines.length && isStarLine(lines[starEnd + 1])) starEnd++;

    // The line before the stars is Goodreads' community average — their
    // number, not the reader's, and deliberately dropped. It also confirms
    // the row is aligned before title and author are read off by position.
    if (starStart < 3 || !isAvgRating(lines[starStart - 1])) {
      skipped.push(lines[0] || '(unreadable row)');
      continue;
    }

    const author = normalizeAuthor(lines[starStart - 2]);
    const rawTitle = lines[starStart - 3];
    const title = stripSeries(rawTitle);

    if (!title || !author) {
      skipped.push(rawTitle || '(unnamed)');
      continue;
    }

    const key = `${title.toLowerCase()}|${author.toLowerCase()}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);

    const rating = parseRating(lines.slice(starStart, starEnd + 1));

    const shelves = String(lines[starEnd + 1] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !NOISE.has(s));

    // Work backwards from the end for the two date-shaped lines. Anything
    // between the shelves and those dates is the review, however long.
    const tail = lines.slice(starEnd + 2);
    const dateIdxs = [];
    for (let i = tail.length - 1; i >= 0 && dateIdxs.length < 2; i--) {
      if (parseDate(tail[i]) || /^not set\b/i.test(tail[i])) dateIdxs.unshift(i);
    }

    let dateRead = null;
    let dateAdded = null;
    let reviewEnd = tail.length;

    if (dateIdxs.length === 2) {
      dateRead = parseDate(tail[dateIdxs[0]]);
      dateAdded = parseDate(tail[dateIdxs[1]]);
      reviewEnd = dateIdxs[0];
    } else if (dateIdxs.length === 1) {
      dateAdded = parseDate(tail[dateIdxs[0]]);
      reviewEnd = dateIdxs[0];
    }

    const review = tail
      .slice(0, reviewEnd)
      .filter((l) => !NOISE.has(l))
      .join('\n\n')
      .replace(/\s*\[edit\]\s*$/, '')
      // The table view truncates long reviews; the marker is not part of
      // what the reader wrote.
      .replace(/\s*\.\.\.more\s*$/, '…')
      .trim();

    books.push({
      title,
      author,
      series: parseSeries(rawTitle),
      rating,
      shelves,
      review: review || null,
      dateRead,
      dateAdded
    });
  }

  return { books, skipped, duplicates };
}
