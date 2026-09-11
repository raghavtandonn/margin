import { get, all } from '../db/index.js';

// ── §02b — THE COMPOSITION LABEL ─────────────────────────
//
// "The strongest page in the feature. A care label with fabric percentages
// drawn from themes."
//
//     68% GRIEF
//     21% ARCHITECTURE
//     11% REVENGE
//
//     READ IN ONE SITTING. DO NOT LEND. NO HEAT.
//
// §05 asks where the percentages come from: "user tags, editorial data, or
// model inference? Same accuracy problem, smaller blast radius."
//
// They come from EDITORIAL DATA and the reader's own shelves, and from
// nothing else. No model touches this file. The blast radius is smaller than
// the research board's but the failure is identical in kind — a confident
// wrong number set in beautiful type — and the mitigation is the same one:
// the label carries its source, so the page shows its working.
//
// The care instructions underneath are the honest half: every one of them is
// a fact the reader's own logging already proved.

/** Administrative and library-science noise that is not a theme. */
const JUNK = [
  /^open[_ ]syllabus/i, /^pro /i, /^chr \d/i, /^long now/i, /^accessible book/i,
  /^protected daisy/i, /^in library/i, /^overdrive/i, /^lending library/i,
  /^internet archive/i, /^large type/i, /^\d{4}$/, /^nyt:/i, /^new york times/i,
  /^fiction$/i, /^literature$/i, /^general$/i, /^fiction, general$/i,
  /collection/i, /^readers/i, /^textbooks/i, /^juvenile/i, /^bestseller/i,
  /tie-in/i, /^novelization$/i, /^films?$/i, /^movies$/i, /^motion pictures$/i,
  /\(fictitious character\)/i, /^translations into/i, /^history and criticism$/i
];

// Subjects arrive as library headings. These read as garment fibres.
const REWRITE = new Map(Object.entries({
  'science fiction': 'SPECULATION',
  'psychological fiction': 'INTERIORITY',
  'domestic fiction': 'DOMESTICITY',
  'historical fiction': 'THE PAST',
  'love stories': 'DESIRE',
  'detective and mystery stories': 'PROCEDURE',
  'war stories': 'WAR',
  'ghost stories': 'HAUNTING',
  'dystopias': 'FORECAST',
  'bildungsromans': 'FORMATION',
  'coming of age': 'FORMATION',
  'man-woman relationships': 'COUPLES',
  'interpersonal relations': 'PROXIMITY',
  'city and town life': 'THE CITY',
  'country life': 'LANDSCAPE',
  'social conditions': 'CLASS',
  'race relations': 'RACE',
  'grief': 'GRIEF',
  'death': 'MORTALITY',
  'memory': 'MEMORY',
  'identity': 'IDENTITY',
  'family': 'FAMILY',
  'friendship': 'FRIENDSHIP',
  'revenge': 'REVENGE',
  'architecture': 'ARCHITECTURE',
  'religion': 'DOCTRINE',
  'philosophy': 'PHILOSOPHY',
  'politics and government': 'POWER',
  'women': 'WOMEN',
  'artificial intelligence': 'MACHINES',
  'robots': 'MACHINES',
  'androids': 'MACHINES',
  'time travel': 'TIME',
  'space flight': 'DISTANCE',
  'immigrants': 'ARRIVAL',
  'exiles': 'EXILE',
  'travel': 'TRANSIT',
  'voyages and travels': 'TRANSIT',
  'nature': 'WEATHER',
  'nineteen twenties': 'THE TWENTIES',
  'suspense': 'DREAD',
  'horror': 'DREAD'
}));

// Library headings arrive inverted and subdivided — "Authors, American,
// Biography" or "Paris (France) -- Social life". The head of the string is
// the subject; everything after the first comma or double dash is a
// cataloguer's filing path and reads as noise on a garment label.
const head = (s) => s.split(' -- ')[0].split(/,\s/)[0].trim();

// Open Library carries the same book's headings in several languages. They
// are not wrong, but a care label set half in Spanish is just a mistake.
const NOT_ENGLISH = new RegExp(
  '\\b(' + [
    // Function words that mark a heading as being in another language.
    'et', 'de', 'des', 'du', 'la', 'le', 'les', 'y', 'und', 'der', 'die', 'das',
    'del', 'della', 'dans', 'sur', 'och', 'av', 'en el', 'ett',
    // And the subject vocabulary the same catalogues repeat.
    'literatura', 'literatur', 'littérature', 'roman', 'romans', 'novela',
    'novelas', 'ficción', 'histoire', 'geschichte', 'politique', 'gouvernement',
    'storia', 'powie', 'ksi', 'stany', 'zjednoczone', 'istoty', 'japonesa',
    'inglesa', 'americana', 'francesa', 'kirjallisuus', 'tieteiskirjallisuus'
  ].join('|') + ')\\b', 'i'
);

const clean = (raw) => {
  const s = head(String(raw ?? '').trim());
  if (!s || s.length < 3 || s.length > 26) return null;
  if (JUNK.some((r) => r.test(s))) return null;
  if (NOT_ENGLISH.test(s)) return null;

  const key = s.toLowerCase().replace(/\s+/g, ' ');
  if (REWRITE.has(key)) return REWRITE.get(key);
  // Anything with a character the label cannot set is dropped rather than
  // mangled — a fibre name is display type, not data.
  return /^[A-Za-z][A-Za-z0-9 '’&-]*$/.test(s) ? s.toUpperCase() : null;
};

/**
 * §02b — three fibres, summing to 100.
 *
 * Weight is by position: Open Library orders subject headings roughly by
 * how many editions carry them, so the head of the list is the strongest
 * claim about the book. A shelf the reader made themselves outranks all of
 * it — their own filing is better evidence about their own reading than a
 * cataloguer's is.
 */
export function compositionOf(workId, userId, { max = 3 } = {}) {
  const work = get('SELECT subjects FROM works WHERE id = ?', Number(workId));

  let subjects = [];
  try { subjects = JSON.parse(work?.subjects || '[]'); } catch { subjects = []; }

  const weights = new Map();
  const bump = (name, w) => {
    if (!name) return;
    weights.set(name, (weights.get(name) || 0) + w);
  };

  // Weight decays sharply with position. A linear ramp produces 36/33/31 —
  // three fibres of identical size, which is not a composition, it is a
  // list. The curve is what makes the label say something: the spec's own
  // example is 68/21/11.
  //
  // A theme that appears more than once accumulates, so a book catalogued
  // as grief four different ways ends up overwhelmingly grief.
  subjects.slice(0, 30).forEach((s, i) => bump(clean(s), 1 / Math.pow(i + 1, 1.15)));

  // The reader's own non-system shelves, counted heavily. This is the "user
  // tags" half of §05's question, and it wins where it exists.
  if (userId) {
    for (const sh of all(
      `SELECT sh.name FROM shelf_items si
         JOIN shelves sh ON sh.id = si.shelf_id
        WHERE si.work_id = ? AND sh.user_id = ? AND sh.is_system = 0`,
      Number(workId), Number(userId)
    )) bump(clean(sh.name), 1.4);
  }

  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length < 2) return null;   // Two fibres is not a composition.

  const top = ranked.slice(0, max);
  const total = top.reduce((n, [, w]) => n + w, 0);

  // Percentages are rounded down, then the remainder goes to the largest
  // fibre, so the label always reads exactly 100 and never 99 or 101.
  const parts = top.map(([name, w]) => ({ name, pct: Math.floor((w / total) * 100) }));
  parts[0].pct += 100 - parts.reduce((n, p) => n + p.pct, 0);

  return {
    parts,
    // §04 mitigation two, applied here as well: the label says where it came
    // from at 6pt, so nobody mistakes a cataloguer's headings for a reading.
    source: userId && parts.length ? 'SUBJECT HEADINGS, OPEN LIBRARY · READER SHELVES'
                                   : 'SUBJECT HEADINGS, OPEN LIBRARY'
  };
}

/**
 * The care instructions.
 *
 * Every line is derived from the reading itself and is therefore true. There
 * is no line here that is a joke about the book — the register is flat, and
 * the humour, where there is any, is in the accuracy.
 */
export function careOf(reading, edition) {
  const lines = [];
  const days = spanDays(reading);
  const pages = edition?.page_count || null;

  if (days != null && days <= 1) lines.push('READ IN ONE SITTING');
  else if (days != null && days <= 4) lines.push(`READ IN ${days} DAYS`);
  else if (days != null && days >= 120) lines.push('KEPT ON THE PILE FOR MONTHS');

  if (pages && days && days > 0) {
    const rate = Math.round(pages / days);
    if (rate >= 120) lines.push('HANDLE AT SPEED');
    else if (rate <= 8) lines.push('LOW HEAT');
  }

  if (reading?.status === 'ABANDONED') lines.push('NOT PRODUCED');
  if (reading?.pass_number > 1) lines.push(`WORN ${reading.pass_number} TIMES`);
  if (reading?.stars === 5) lines.push('DO NOT LEND');
  if (reading?.format === 'AUDIO') lines.push('LISTENED, NOT READ');
  if (edition?.format === 'HARDCOVER') lines.push('DO NOT PACK FLAT');

  return lines.slice(0, 4);
}

function spanDays(r) {
  const a = r?.started_at, b = r?.finished_at || r?.abandoned_at;
  if (!a || !b) return null;
  const ms = Date.parse(String(b).replace(' ', 'T')) - Date.parse(String(a).replace(' ', 'T'));
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}
