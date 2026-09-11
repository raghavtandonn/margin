// ── §12 — CSV, in both directions ────────────────────────
//
// Goodreads' own export is the input format, and §12 is blunt about what it
// is like: "inconsistent quoting, embedded newlines in review text, and
// `=""ISBN""` formula-escaped identifiers."
//
// And the output side carries an attack that is easy to forget because it
// does not fire in the browser at all. A cell beginning `=`, `+`, `-`, `@`,
// tab, or carriage return is a FORMULA to Excel, Numbers, and Sheets. Export
// someone's review that begins `=cmd|'/c calc'!A1` and the damage happens on
// their machine, in a different application, later.

// ── Parsing ──────────────────────────────────────────────
/**
 * A character-by-character parser, because a regex cannot track whether a
 * newline is a row break or part of a quoted review — and Goodreads reviews
 * routinely contain newlines.
 */
export function parseCSV(text, { maxRows = 50_000 } = {}) {
  const src = String(text).replace(/^﻿/, '');   // strip a BOM
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { quoted = true; i++; continue; }

    if (c === ',') { row.push(field); field = ''; i++; continue; }

    if (c === '\r' || c === '\n') {
      // Consume CRLF as one break.
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      // A blank line is not a row.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++;
      if (rows.length > maxRows) throw new Error(`More than ${maxRows} rows.`);
      continue;
    }

    field += c; i++;
  }

  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);

  return rows;
}

/**
 * Goodreads writes identifiers as `=""9780141184982""` so that Excel keeps
 * the leading zeros. What arrives after quote-unescaping is `=""value""`.
 */
export const unformula = (cell) => {
  const s = String(cell ?? '').trim();
  // ONLY the ="..." shape. An earlier version stripped any leading "=",
  // which quietly ate the first character of a review beginning with one —
  // and a review beginning with "=" is exactly the formula-injection case
  // this file exists to preserve intact so it can be escaped on the way out.
  const m = /^="(.*)"$/.exec(s);
  return m ? m[1].trim() : s;
};

export function parseWithHeader(text, opts) {
  const rows = parseCSV(text, opts);
  if (!rows.length) return { header: [], records: [] };

  const header = rows[0].map((h) => unformula(h).trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = unformula(r[i] ?? ''); });
    return o;
  });

  // `rows` comes back too: deciding whether a file is a table or a typed
  // list is a question about its raw shape, and re-parsing 50 MB to ask it
  // twice would be the only expensive thing on this path.
  return { header, records, rows };
}

// ── Writing ──────────────────────────────────────────────
// The characters a spreadsheet treats as the start of a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * §12 — "prefix any value starting with =, +, -, @, tab, or CR with a single
 * quote when re-exporting, to prevent CSV formula injection into whatever
 * spreadsheet the user opens next."
 *
 * The apostrophe is the standard escape: spreadsheets read it as "the rest is
 * literal text" and do not display it.
 */
export function safeCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return s;
}

export function quote(value) {
  const s = safeCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.map(quote).join(',')];
  for (const row of rows) lines.push(cols.map((c) => quote(row[c])).join(','));
  // CRLF, which is what the spec's format expects and what Excel prefers.
  return `${lines.join('\r\n')}\r\n`;
}
