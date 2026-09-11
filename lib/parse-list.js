// ── A LIST SOMEBODY TYPED ────────────────────────────────
//
// §12 offers "a plain list" as an import format, and until now the product
// could not read one. Every other source arrives as a table with a header
// row, so the CSV parser takes line one as column names — which means the
// first book in a typed list became a column called "The Secret History"
// and every book after it arrived with no title at all.
//
// A list is not a table missing its header. It is a different shape and it
// gets a different parser: one book per line, and the separator between
// title and author worked out from the whole file rather than guessed at
// line by line.

// The vocabulary of a header row. One match anywhere in line one and the
// file is a table — either a source we know, or one we ask about. Zero
// matches and there is nothing to ask: it is a list.
const HEADER_WORDS = new Set([
  'title', 'book', 'name', 'book id', 'author', 'authors', 'primary author',
  'author l-f', 'additional authors', 'secondary author', 'by',
  'isbn', 'isbn13', 'isbn/uid', 'isbns', 'asin',
  'rating', 'stars', 'my rating', 'star rating', 'average rating',
  'date', 'date read', 'date added', 'last date read', 'entry date', 'added', 'read',
  'shelf', 'shelves', 'bookshelves', 'exclusive shelf', 'collections', 'tags',
  'status', 'read status', 'pages', 'page count', 'number of pages',
  'publisher', 'publication', 'year', 'original publication year', 'year published',
  'review', 'my review', 'notes', 'private notes', 'comment', 'private comment'
]);

/**
 * Is this text a list rather than a table?
 *
 * Two rules, in order, because the second one alone would misread a
 * Goodreads export in a language whose column names we do not have:
 *
 *   1. Any recognised column name in line one — a table.
 *   2. Three or more columns held consistently — a table, whatever its
 *      headers are called. A typed list runs to a title and maybe an
 *      author; it does not run to three fields on every line.
 */
export function looksLikeList(rows) {
  if (!rows.length) return false;
  const header = rows[0].map((c) => String(c ?? '').trim().toLowerCase());
  if (header.some((c) => HEADER_WORDS.has(c))) return false;

  const wide = rows.filter((r) => r.length >= 3).length;
  if (wide >= Math.max(2, rows.length * 0.8)) return false;

  return true;
}

// Ordinals, bullets and the tab a spreadsheet leaves behind.
const MARKER = /^\s*(?:[-*•·—–]|\(?\d{1,3}[.)])\s+/;
const TRAILING_YEAR = /\s*[([](?:19|20)\d{2}[)\]]\s*$/;
const QUOTED = /^\s*["“'‘](.+)["”'’]\s*$/;

// A separator is only a separator with space around it: "Anti-Oedipus" and
// "Sci-Fi" must survive, and they do because neither hyphen is spaced.
const SPACED_DASH = /\s+[—–]\s+|\s+-\s+/;
const BY = /\s+by\s+/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Split one line into title and author.
 *
 * `useComma` is decided once for the whole file rather than per line,
 * because a comma is the one separator that is genuinely ambiguous:
 * "Cloud Atlas, David Mitchell" is a title and an author and "Goodbye,
 * Columbus" is a title. Nothing in either line settles it. What settles it
 * is the company it keeps — a file where nearly every line has exactly one
 * comma is a two-column list, and a file where only a few do is not.
 */
function splitLine(line, useComma) {
  const tab = line.indexOf('\t');
  if (tab >= 0) return [line.slice(0, tab), line.slice(tab + 1)];

  const pipe = line.indexOf('|');
  if (pipe >= 0) return [line.slice(0, pipe), line.slice(pipe + 1)];

  // "by" beats a dash: "The Long Goodbye — a novel by Raymond Chandler"
  // splits on the author, not on the subtitle. Last occurrence, so "Death
  // by Water by Kenzaburo Oe" keeps its title.
  const by = [...line.matchAll(new RegExp(BY, 'gi'))].pop();
  if (by && by.index > 0) return [line.slice(0, by.index), line.slice(by.index + by[0].length)];

  const dash = SPACED_DASH.exec(line);
  if (dash && dash.index > 0) return [line.slice(0, dash.index), line.slice(dash.index + dash[0].length)];

  if (useComma) {
    const c = line.indexOf(',');
    if (c > 0) return [line.slice(0, c), line.slice(c + 1)];
  }

  return [line, null];
}

// Does the file as a whole read as "title, author"? Exactly one comma on
// most of the lines that have any, and enough of them to be a convention.
function commaIsSeparator(lines) {
  const withComma = lines.filter((l) => l.includes(','));
  if (withComma.length < Math.max(2, lines.length * 0.6)) return false;
  return withComma.every((l) => (l.match(/,/g) || []).length === 1);
}

/**
 * Parse a typed list into the row shape the preview screen already knows.
 *
 * Nothing here invents a shelf, a date or a rating: a list carries a title
 * and sometimes an author, and the fields it does not carry stay null
 * rather than being filled with a plausible value. The shelf mapping screen
 * is where these rows get a status, and with no shelf to propose from they
 * arrive as WAITING — which is what a list of books usually is.
 */
export function parseList(text) {
  const raw = String(text).replace(/^﻿/, '').split(/\r?\n/);

  const lines = [];
  for (const l of raw) {
    let s = l.replace(MARKER, '').trim();
    if (!s) continue;
    const q = QUOTED.exec(s);
    if (q) s = q[1].trim();
    lines.push(s);
  }
  if (!lines.length) return { rows: [], rowCount: 0 };

  const useComma = commaIsSeparator(lines);

  const rows = [];
  for (const line of lines) {
    const withoutYear = line.replace(TRAILING_YEAR, '');
    const year = TRAILING_YEAR.exec(line);
    let [title, author] = splitLine(withoutYear, useComma);

    title = clean(title);
    author = clean(author);
    if (!title) continue;

    // "Tartt, Donna" is how half the world writes a name down.
    if (author && (author.match(/,/g) || []).length === 1) {
      const [last, first] = author.split(',').map(clean);
      if (last && first && !/\s/.test(last)) author = `${first} ${last}`;
    }

    rows.push({
      title,
      author: author || null,
      isbn13: null, isbn10: null, pages: null, publisher: null,
      year: year ? Number(year[0].replace(/\D/g, '')) : null,
      rating: null, review: null, note: null,
      dateRead: null, dateAdded: null,
      sourceShelf: '',
      extraShelves: []
    });
  }

  return { rows, rowCount: lines.length };
}
