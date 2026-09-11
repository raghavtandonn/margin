import { unzip } from './zip.js';

// ── THE GOODREADS DATA EXPORT ────────────────────────────
//
// There are two different things called "your Goodreads export" and they
// share no format at all.
//
//   THE CSV        goodreads_library_export.csv. One row per book, with the
//                  author, the ISBN, the page count, the publisher, the date
//                  read. This is what the importer was built for.
//
//   THE DATA FILE  what "Request my data" actually sends: a folder of 44
//                  zipped JSON files, most of which are HTTP request logs.
//                  The library is in review.zip, it has no author column,
//                  no ISBN, and no date read.
//
// Somebody who asked for their data and got the second one currently has 44
// files, no idea which matters, and an importer that accepts none of them.
// This module reads that folder.
//
// The honest part: the data file is a WORSE export than the CSV. It cannot
// carry an author, so matching is by title alone and is correspondingly
// weaker. Where somebody has both, they should use the CSV, and the import
// page says so rather than letting them find out afterwards.

/**
 * The four files in the folder that carry anything. Everything else is
 * request logs, ad preferences, and recommendation telemetry.
 *
 * `kind` is what the file contributes, not what it is called: `library` is
 * the books themselves and goes through the ordinary preview and confirm
 * path; the other three are supplements that attach to books already there.
 */
const FILES = [
  { name: 'review',     kind: 'library',    label: 'your books, their shelves and your ratings' },
  { name: 'notes',      kind: 'notes',      label: 'notes you left while reading' },
  { name: 'activity',   kind: 'activity',   label: 'when you started and finished things' },
  { name: 'user_quote', kind: 'quotes',     label: 'quotes you saved' }
];

/**
 * Named for the import page, which lists them so nobody has to guess.
 *
 * `kind` travels with them so the page can say which ONE to start with.
 * Four names in a list is still four things to choose between, and only one
 * of them is the library — the other three cannot create a book and do
 * nothing at all until it has been imported.
 */
export const EXPORT_FILES = FILES.map((f) => ({
  file: `${f.name}.zip`, label: f.label, kind: f.kind
}));

// Goodreads writes this string rather than leaving a field out.
const NP = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s && s !== '(not provided)' ? s : null;
};

// "2023-07-19 22:19:07 UTC" is not something Date.parse should be trusted
// with, and only the day is ever used.
const day = (v) => {
  const s = NP(v);
  const m = s && /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
};

/**
 * A Goodreads product string carries series information the catalogue holds
 * separately: "Wolf Hall (Thomas Cromwell, #1)". The parenthetical is
 * dropped only when it contains a series number, so "The Human Use of Human
 * Beings (Da Capo)" keeps its subtitle.
 */
export const cleanTitle = (s) =>
  String(s || '').replace(/\s*\([^)]*#\s*\d+[^)]*\)\s*$/, '').trim();

/**
 * Every one of these files is an array whose FIRST element is a prose
 * explanation of the file rather than a record. Reading it as data produces
 * one phantom book called undefined, which is exactly the sort of thing that
 * gets committed to a library and noticed six screens later.
 */
function records(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((r) => r && typeof r === 'object' && !r.explanation);
}

/**
 * Work out which export file this is, from its contents rather than its
 * name, because a file that has been renamed or re-downloaded as
 * `review (1).json` is still that file.
 */
export function identify(parsed) {
  const rows = records(parsed);
  if (!rows.length) return null;

  const first = rows[0];
  if (first.read_status !== undefined && first.book !== undefined) return 'library';
  if (Array.isArray(first.notes)) return 'notes';
  if (Array.isArray(first.activities) || Array.isArray(first.feeds)) return 'activity';
  if (first.quote !== undefined) return 'quotes';
  return null;
}

/**
 * review.json as CSV, so that it goes through `analyse` and the preview and
 * confirm screens exactly like every other import.
 *
 * Only the columns the file genuinely has. An author column is deliberately
 * NOT emitted: the data file has no author, and an empty one would let a
 * title match the wrong book with nothing to check it against.
 */
export function libraryCSV(parsed) {
  const rows = records(parsed);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const out = ['Title,Exclusive Shelf,My Rating,My Review,Date Added,Book Id'];

  for (const r of rows) {
    const title = cleanTitle(r.book);
    if (!title) continue;
    out.push([
      esc(title),
      esc(r.read_status || ''),
      esc(r.rating || ''),
      esc(NP(r.review) || ''),
      esc(day(r.created_at) || ''),
      // The CSV detector wants a Book Id column present. There are no book
      // ids in the data export, so the column exists and is empty, which is
      // true rather than invented.
      esc('')
    ].join(','));
  }

  return out.join('\n');
}

/** Reading notes, which the CSV has never carried at all. */
export function notesOf(parsed) {
  const rows = records(parsed);
  const list = rows.flatMap((r) => (Array.isArray(r.notes) ? r.notes : []));
  return list
    .filter((n) => n.is_deleted !== 'Yes' && NP(n.note_text))
    .map((n) => ({
      title: cleanTitle(n.product),
      text: NP(n.note_text),
      at: day(n.created_at)
    }))
    .filter((n) => n.title && n.text);
}

/**
 * Start and finish dates, from the newsfeed rather than from the library.
 *
 * This is the only place in the whole export where a reading DATE lives.
 * review.json carries when a book was shelved, which is not when it was
 * read, and the difference is often years.
 */
const STATUS_FIELD = {
  BookStatusReading: 'started_at',
  BookStatusRead: 'finished_at',
  BookStatusDidNotFinish: 'abandoned_at'
};

export function datesOf(parsed) {
  const rows = records(parsed);
  const acts = rows.flatMap((r) => (Array.isArray(r.activities) ? r.activities : []));

  return acts
    .filter((a) => STATUS_FIELD[a.activity_type])
    .map((a) => ({
      title: cleanTitle(a.product),
      field: STATUS_FIELD[a.activity_type],
      at: day(a.created_at)
    }))
    .filter((d) => d.title && d.at);
}

export function quotesOf(parsed) {
  const rows = records(parsed);
  return rows
    .filter((r) => NP(r.quote))
    .map((r) => ({ text: NP(r.quote), at: day(r.created_at) }));
}

/**
 * Read one uploaded file, zipped or not, and say what it is.
 *
 * Returns `{ kind, parsed, filename }`, or throws with a message written for
 * somebody looking at a folder of 44 files rather than for a log.
 */
export function readExport(buffer, filename = '') {
  let text;

  // A ZIP starts "PK\x03\x04". Trusting the extension would fail on the
  // common case of a browser that unzipped the file on download.
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const entries = unzip(buffer).filter((e) => e.name.toLowerCase().endsWith('.json'));
    if (!entries.length) throw new Error('That archive has no JSON in it.');
    // Every one of these archives holds exactly one file.
    text = entries[0].data.toString('utf8');
    filename = entries[0].name;
  } else {
    text = buffer.toString('utf8');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not the JSON a Goodreads data export contains.');
  }

  const kind = identify(parsed);
  if (!kind) {
    throw new Error(
      'That is a Goodreads data file, but not one that holds any reading. ' +
      'The four worth importing are review, notes, activity, and user_quote.'
    );
  }

  return { kind, parsed, filename };
}
