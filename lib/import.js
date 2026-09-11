import { parseWithHeader, unformula } from './csv.js';
import { looksLikeList, parseList } from './parse-list.js';
import { normalizeISBN } from './artifacts.js';
import { starsFromImport } from './stars.js';

// ── §12 — IMPORT ─────────────────────────────────────────
//
// The format is detected from the column headers rather than asked for.
// Somebody who has just exported their library does not think of themselves
// as holding "a Goodreads CSV" — they are holding their books, and being
// made to classify the file before the product will look at it is a chore
// invented by the product.
//
// The names of the services appear exactly once in the interface, in a line
// of body copy under the drop zone where they are genuinely useful. Never in
// a heading, a button, or a nav item.

// ── Detection ────────────────────────────────────────────
//
// Each signature is a column the others do not have. Book Id and Exclusive
// Shelf are Goodreads'; Read Status is StoryGraph's; Entry Date is
// LibraryThing's. Matching on a distinctive column rather than on a set of
// common ones means a file with extra columns bolted on still resolves.

const SOURCES = [
  {
    id: 'goodreads',
    label: 'Goodreads',
    // Both, because "Exclusive Shelf" alone appears in third-party
    // re-exports that do not carry the rest of the shape.
    detect: (h) => h.has('exclusive shelf') && h.has('book id'),
    status: 'Exclusive Shelf',
    map: {
      title: ['Title'],
      author: ['Author', 'Author l-f', 'Additional Authors'],
      isbn13: ['ISBN13'],
      isbn10: ['ISBN'],
      pages: ['Number of Pages'],
      publisher: ['Publisher'],
      year: ['Original Publication Year', 'Year Published'],
      rating: ['My Rating'],
      review: ['My Review'],
      note: ['Private Notes'],
      dateRead: ['Date Read'],
      dateAdded: ['Date Added'],
      shelves: ['Bookshelves']
    }
  },
  {
    id: 'storygraph',
    label: 'The StoryGraph',
    detect: (h) => h.has('read status'),
    status: 'Read Status',
    map: {
      title: ['Title'],
      author: ['Authors', 'Author'],
      isbn13: ['ISBN/UID', 'ISBN'],
      pages: ['Number of Pages'],
      publisher: ['Publisher'],
      year: ['Publication Year', 'Original Publication Year'],
      rating: ['Star Rating'],
      review: ['Review'],
      note: ['Content Warnings'],
      dateRead: ['Last Date Read', 'Date Read'],
      dateAdded: ['Date Added'],
      shelves: ['Tags']
    }
  },
  {
    id: 'librarything',
    label: 'LibraryThing',
    detect: (h) => h.has('entry date'),
    status: 'Collections',
    map: {
      title: ['Title'],
      author: ['Primary Author', 'Author', 'Secondary Author'],
      isbn13: ['ISBN', 'ISBNs'],
      pages: ['Page Count', 'Number of Pages'],
      publisher: ['Publication'],
      year: ['Date', 'Publication date'],
      rating: ['Rating'],
      review: ['Review', 'Comment'],
      note: ['Private Comment'],
      dateRead: ['Date Read'],
      dateAdded: ['Entry Date'],
      shelves: ['Tags']
    }
  },
  {
    id: 'plain',
    label: 'a plain list',
    // The fallback that is still a detection rather than a shrug: a file
    // with something title-shaped in it can be read as a list of books.
    detect: (h) => h.has('title') || h.has('book') || h.has('name'),
    status: null,
    map: {
      title: ['Title', 'Book', 'Name'],
      author: ['Author', 'Authors', 'By'],
      isbn13: ['ISBN13', 'ISBN'],
      pages: ['Pages', 'Number of Pages'],
      year: ['Year'],
      rating: ['Rating', 'Stars'],
      review: ['Review', 'Notes'],
      dateRead: ['Date Read', 'Read'],
      dateAdded: ['Date Added', 'Added'],
      shelves: ['Shelves', 'Tags']
    }
  }
];

export function detectSource(header) {
  const lower = new Set(header.map((h) => String(h).trim().toLowerCase()));
  return SOURCES.find((s) => s.detect(lower)) || null;
}

export const sourceById = (id) => SOURCES.find((s) => s.id === id) || null;

// Every source the picker offers when detection fails — which is the only
// time a person is asked to name their file.
export const SOURCE_CHOICES = [
  ...SOURCES.map((s) => ({ id: s.id, label: s.label })),
  // Not one of SOURCES: it is detected from the file's shape rather than
  // from its columns, and it has no column map to be picked through.
  { id: 'list', label: 'just a list of titles, one per line' }
];

// ── Reading a row ────────────────────────────────────────
const pick = (row, names) => {
  for (const n of names || []) {
    const v = row[n];
    if (v != null && String(v).trim() !== '') return unformula(v);
  }
  return null;
};

const cleanISBN = (v) => (v ? normalizeISBN(String(unformula(v)).replace(/[^0-9Xx]/g, '')) : null);

// A date column may hold anything from "2019/03/14" to "March 2019".
const cleanDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

export function normaliseRow(row, source) {
  const m = source.map;
  const title = pick(row, m.title);

  return {
    title: title ? String(title).trim() : null,
    author: pick(row, m.author),
    isbn13: cleanISBN(pick(row, ['ISBN13'])) || cleanISBN(pick(row, m.isbn13)),
    isbn10: cleanISBN(pick(row, m.isbn10)),
    pages: Number(pick(row, m.pages)) || null,
    publisher: pick(row, m.publisher),
    year: Number(String(pick(row, m.year) || '').slice(0, 4)) || null,
    rating: starsFromImport(pick(row, m.rating)),
    review: pick(row, m.review),
    note: pick(row, m.note),
    dateRead: cleanDate(pick(row, m.dateRead)),
    dateAdded: cleanDate(pick(row, m.dateAdded)),
    // The raw value from whichever column carries reading state. It is kept
    // verbatim because the mapping screen shows it back to the person in
    // their own vocabulary.
    sourceShelf: source.status ? (pick(row, [source.status]) || '') : '',
    extraShelves: String(pick(row, m.shelves) || '')
      .split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  };
}

// ── Shelf mapping ────────────────────────────────────────
//
// "their vocabulary is theirs and yours is yours" — so nothing is silently
// translated. The mapping is proposed, shown, and editable before a single
// row is written.

export const STATUSES = ['FINISHED', 'READING', 'WAITING', 'ABANDONED', 'SKIP'];

// Deliberately loose: it is a proposal on a screen somebody is about to
// correct, not a decision.
export function guessStatus(value) {
  const v = String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!v) return 'WAITING';
  if (/(^|\b)(read|finished|完読)($|\b)/.test(v) && !/to read|want|unread/.test(v)) return 'FINISHED';
  if (/currently|reading now|in progress|^reading$/.test(v)) return 'READING';
  if (/did not finish|dnf|abandon|gave up|stopped/.test(v)) return 'ABANDONED';
  if (/to read|want to read|wishlist|to-be-read|tbr|unread/.test(v)) return 'WAITING';
  // LibraryThing's "Your library" means owned, which says nothing about
  // whether it has been read.
  if (/your library|owned|library/.test(v)) return 'WAITING';
  return 'WAITING';
}

/**
 * A list, in the shape the preview screen already understands.
 *
 * It goes through the same mapping row, the same confirm step and the same
 * commit as a Goodreads CSV. A second write path for the smallest import
 * would be the one nobody maintains.
 */
function fromList(text) {
  const { rows, rowCount } = parseList(text);
  if (!rows.length) return { ok: false, error: 'There were no book titles in that.' };

  const withAuthor = rows.filter((r) => r.author).length;

  return {
    ok: true,
    source: { id: 'list', label: 'a list' },
    rowCount,
    rows,
    unmatched: [],
    // One row, because a list makes no distinctions. It still goes through
    // the mapping screen: with no shelf of their own to translate, choosing
    // what these books ARE is the only thing left to confirm, and it is the
    // one thing the file cannot say.
    mapping: [{ value: '', count: rows.length, status: 'WAITING' }],
    counts: { rows: rows.length, waiting: rows.length, unmatched: 0 },
    list: { withAuthor, withoutAuthor: rows.length - withAuthor }
  };
}

/**
 * Parse a file into everything the preview screen needs, WITHOUT writing
 * anything. §12: "Show a preview and a confirm step before writing. Never
 * silently merge into an existing library."
 */
export function analyse(text, { sourceId = null, maxRows = 50_000 } = {}) {
  const { header, records, rows: cells } = parseWithHeader(text, { maxRows });

  // ── A typed list ───────────────────────────────────────
  //
  // Checked before the header is trusted, because a list HAS no header and
  // reading one as a table costs the reader their first book: it becomes a
  // column name, and every line after it arrives with no title. §12 has
  // promised "a plain list" from the beginning; this is where it is kept.
  if (sourceId === 'list' || (!sourceId && looksLikeList(cells))) {
    return fromList(text);
  }

  if (!header.length || !records.length) {
    return { ok: false, error: 'That file has no rows in it.' };
  }

  const source = sourceById(sourceId === 'list' ? null : sourceId) || detectSource(header);
  if (!source) {
    // The only branch that asks. Everything else is inferred.
    return { ok: false, needsSource: true, header, rowCount: records.length };
  }

  const rows = records.map((r) => normaliseRow(r, source));

  // A row with no title is not a book. It is kept rather than dropped so it
  // can be shown afterwards and fixed by hand.
  const unmatched = [];
  const usable = [];
  rows.forEach((r, i) => {
    if (!r.title) unmatched.push({ line: i + 2, raw: records[i] });
    else usable.push(r);
  });

  // The distinct vocabulary of the file, each with a proposed target.
  const shelves = new Map();
  for (const r of usable) {
    const key = r.sourceShelf || '';
    if (!shelves.has(key)) shelves.set(key, { value: key, count: 0, status: guessStatus(key) });
    shelves.get(key).count++;
  }

  const mapping = [...shelves.values()].sort((a, b) => b.count - a.count);
  const byStatus = (s) =>
    mapping.filter((m) => m.status === s).reduce((n, m) => n + m.count, 0);

  return {
    ok: true,
    source: { id: source.id, label: source.label },
    rowCount: records.length,
    rows: usable,
    unmatched,
    mapping,
    counts: {
      rows: records.length,
      finished: byStatus('FINISHED'),
      waiting: byStatus('WAITING'),
      reading: byStatus('READING'),
      abandoned: byStatus('ABANDONED'),
      unmatched: unmatched.length
    }
  };
}

/**
 * The one line the preview leads with.
 *
 *   412 rows · 71 finished · 336 waiting · 4 reading · 1 unmatched
 *
 * Zeroes are omitted rather than printed, because a count of nothing is not
 * information (§1.5 — no value that computes to zero is displayed).
 */
export function summarise(counts) {
  const parts = [`${counts.rows} rows`];
  for (const [key, label] of [
    ['finished', 'finished'], ['waiting', 'waiting'],
    ['reading', 'reading'], ['abandoned', 'abandoned'], ['unmatched', 'unmatched']
  ]) {
    if (counts[key]) parts.push(`${counts[key]} ${label}`);
  }
  return parts.join(' · ');
}
