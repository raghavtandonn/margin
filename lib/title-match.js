import { all, get } from '../db/index.js';

// ── MATCHING A BOOK BY TITLE ALONE ───────────────────────
//
// The Goodreads data export gives a title and nothing else: no author, no
// ISBN, no page count. Every row has to be matched on that one string, and
// getting it wrong has two failure modes with very different costs.
//
//   CREATING A DUPLICATE   the library doubles. Four hundred authorless
//                          copies that can never be merged back, because
//                          the thing that would distinguish them is the
//                          field the export does not have.
//
//   MERGING THE WRONG PAIR one book gets another book's rating.
//
// The first is the one that actually happens, at scale, silently. So the
// matching here is generous about strings and strict about identity: it
// works hard to recognise a book already in the library, and when two of
// them genuinely share a title it goes and looks for evidence rather than
// either guessing or giving up.

// ── Normalising ──────────────────────────────────────────
//
// Real catalogue titles differ from real export titles in ways that are
// invisible on screen. One of this library's books carries a NO-BREAK SPACE
// (U+00A0) inside its title where the export has an ordinary one; they
// render identically, compare unequal, and that single character was enough
// to make the importer create a second copy of the book.
//
// So: compatibility-decompose, fold every kind of space, unify the quotes
// and dashes that word processors substitute, and drop accents.
const SPACES = /[\s   -   　]+/g;
const QUOTES = /[‘’‚‛′‵]/g;
const DQUOTES = /[“”„‟″‶]/g;
const DASHES = /[‐-―−]/g;

export function normaliseTitle(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The aggressive form: only letters and digits survive.
 *
 * Letters in ANY script. `[^a-z0-9]` would erase a Japanese title
 * completely — and this library holds several — leaving every one of them
 * with the same empty key, which is both a failure to match and an
 * invitation to match the wrong thing.
 */
export const titleKey = (s) => normaliseTitle(s).replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The forms of a title worth trying, most specific first.
 *
 * Goodreads writes things into titles that the catalogue holds in other
 * columns — the imprint ("The Man in the High Castle (Vintage)"), the series
 * position ("Wolf Hall (Thomas Cromwell, #1)"), the edition ("Rodogune
 * (French Edition)"). Each is dropped in turn, and each form still has to
 * match a book the reader already owns, so a loosened title cannot reach
 * outside their own library.
 */
export function variants(title) {
  const out = [];
  const push = (t) => {
    const k = titleKey(t);
    if (k && !out.includes(k)) out.push(k);
  };

  push(title);

  // Trailing parentheticals, one at a time from the right, because a title
  // can carry two: "Tosca: Libretto (Libretti d'opera) (Italian Edition)".
  let t = String(title || '');
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (next === t || !next) break;
    t = next;
    push(t);
  }

  // A trailing bracketed form, which is how translated titles arrive:
  // "キッチン [Kitchin]".
  push(String(title || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim());

  return out;
}

// ── Candidates ───────────────────────────────────────────
/**
 * Every book the reader already has whose title could be this one.
 *
 * Scoped to their own library throughout. A title-only match against the
 * whole catalogue would let an uploaded file attach a rating to a stranger's
 * book, and the loosened variants above make that worse rather than better.
 */
export function candidatesFor(userId, title) {
  const rows = all(
    `SELECT DISTINCT w.id, w.title FROM works w
      WHERE w.id IN (SELECT work_id FROM readings WHERE user_id = ?)
         OR w.id IN (SELECT si.work_id FROM shelf_items si
                       JOIN shelves s ON s.id = si.shelf_id WHERE s.user_id = ?)`,
    Number(userId), Number(userId)
  );

  const index = new Map();
  for (const w of rows) {
    const k = titleKey(w.title);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(w.id);
  }

  // The most specific form that matches anything wins. A row whose full
  // title matches one book is not also offered the books that match its
  // title minus the imprint.
  for (const key of variants(title)) {
    if (index.has(key)) return index.get(key);
  }
  return [];
}

// ── Telling two books with one title apart ───────────────
//
// This library really contains two books called Leviathan (Hobbes and
// Auster) and two called The Secret History (Procopius and Donna Tartt).
// The export names neither author, so the title cannot settle it and no
// amount of looking the BOOKS up would help either: the question is not
// which Leviathan exists, it is which one this reader shelved.
//
// The evidence for that is in their own records. Both sides of this
// comparison came out of the same Goodreads account, so the day a book was
// shelved is close to a unique key, and it is carried on both.
//
//   2022-08-15  →  Leviathan, Paul Auster
//   2023-11-06  →  Leviathan, Thomas Hobbes
//
// Rating and status corroborate. Nothing is inferred from the title itself.

const dayOf = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? m[0] : null;
};

/** Whole days between two ISO dates, or null. */
function daysApart(a, b) {
  const x = dayOf(a), y = dayOf(b);
  if (!x || !y) return null;
  return Math.abs(Date.parse(x + 'T00:00:00Z') - Date.parse(y + 'T00:00:00Z')) / 86_400_000;
}

/**
 * Everything already recorded about one candidate, for comparison.
 */
function evidenceFor(userId, workId) {
  const shelved = all(
    `SELECT si.added_at FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
      WHERE s.user_id = ? AND si.work_id = ?`,
    Number(userId), Number(workId)
  ).map((r) => r.added_at).filter(Boolean);

  const readings = all(
    `SELECT status, stars, started_at, finished_at FROM readings
      WHERE user_id = ? AND work_id = ?`,
    Number(userId), Number(workId)
  );

  return { shelved, readings };
}

/**
 * Which of several same-titled books this row is about.
 *
 * Returns `{ workId, why }` when the evidence points at exactly one, and
 * `{ workId: null, why }` when it genuinely does not. Nothing is created
 * either way: an unresolved row goes to the screen for fixing by hand,
 * because a rating on the wrong book is worse than a row somebody has to
 * look at.
 */
export function disambiguate(userId, candidates, row) {
  const scores = candidates.map((workId) => {
    const ev = evidenceFor(userId, workId);
    let score = 0;
    const why = [];

    // ── The shelving date ──
    // Decisive when it lands. The export stamps UTC and the library stored
    // a local date, so the same act of shelving can be recorded a day
    // apart; one day of slack is the timezone, not a fudge factor.
    const dates = [...ev.shelved, ...ev.readings.map((r) => r.started_at)];
    const gaps = dates.map((d) => daysApart(d, row.dateAdded)).filter((n) => n !== null);
    const closest = gaps.length ? Math.min(...gaps) : null;
    if (closest === 0) { score += 100; why.push('shelved the same day'); }
    else if (closest === 1) { score += 80; why.push('shelved within a day'); }

    // ── The rating ──
    if (row.rating != null && ev.readings.some((r) => r.stars === row.rating)) {
      score += 30; why.push(`already rated ${row.rating}`);
    }

    // ── The status ──
    const finished = ev.readings.some((r) => r.status === 'FINISHED');
    if (row.sourceShelf === 'read' && finished) { score += 20; why.push('already finished'); }
    if (row.sourceShelf === 'to-read' && !ev.readings.length) {
      score += 10; why.push('never started, like this row');
    }

    return { workId, score, why };
  });

  scores.sort((a, b) => b.score - a.score);
  const [best, next] = scores;

  // A clear winner needs both a real signal and daylight behind it. Two
  // candidates that score the same are not resolved by picking the first.
  if (best.score >= 20 && best.score > (next?.score ?? 0)) {
    return { workId: best.workId, why: best.why.join(', ') };
  }

  return {
    workId: null,
    why: best?.score
      ? 'two of your books share this title and the file does not say which'
      : 'two of your books share this title'
  };
}

/**
 * The whole authorless path: find the book, or say why not.
 *
 * `{ workId }` to merge into, `{ workId: null, create: true }` when the
 * reader genuinely does not have this book, `{ workId: null, why }` when
 * they have more than one and the evidence does not choose.
 */
export function matchAuthorless(userId, row) {
  const candidates = candidatesFor(userId, row.title);
  if (!candidates.length) return { workId: null, create: true };
  if (candidates.length === 1) return { workId: candidates[0] };
  return disambiguate(userId, candidates, row);
}
