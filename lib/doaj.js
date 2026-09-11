import { get, run, nowSQL } from '../db/index.js';

// ── OPEN-ACCESS CRITICISM ────────────────────────────────
//
// The fourth source, and the one that reaches where the others cannot.
//
// Wikipedia analysis sections exist for canonical literature and almost
// nothing else; publisher blurbs exist for whatever is still in print. What
// was left over was 170 works with nothing at all — disproportionately
// contemporary, translated, postcolonial and non-English-origin, which is
// exactly the class the criticism gap skews against.
//
// Measured on 40 of those before any of this was written: 25 returned
// results, and **14 were genuinely about the book**. The hits included
// Casati's Clytemnestra (2023), Adichie's Half of a Yellow Sun, Okri's The
// Famished Road, Grimmelshausen's Simplicissimus and Corneille's Cinna —
// contemporary and non-English-origin work our English-article retrieval had
// failed on. Mean best abstract 1,475 characters; 13 of 14 cleared the
// 450-character evidence floor.
//
// English only. Every one of the 25 hits had an English-language result, so
// there is no coverage cost, and a second language would mean a fourth
// damping table.

const UA = 'MARGIN/1.0 (+https://margin.local) colour-derivation';
const TIMEOUT_MS = 20_000;
const PAUSE_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KIND = 'doaj-colour';
export const HEADING_PREFIX = 'Criticism: ';

export class DoajUnavailable extends Error {
  constructor(status) {
    super(`DOAJ is not answering (${status})`);
    this.name = 'DoajUnavailable';
    this.status = status;
  }
}

/**
 * A throttled search is not an empty one.
 *
 * The same distinction `lib/history.js` makes, for the same reason: reading
 * absence into a 429 would silently mark books unassignable, and the run
 * would look like a success. This project has hit that three times.
 */
async function search(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' },
                             signal: controller.signal });
  } catch {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return search(url, attempt + 1); }
    throw new DoajUnavailable('network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2500 * (attempt + 1));
      return search(url, attempt + 1);
    }
    throw new DoajUnavailable(res.status);
  }
  if (!res.ok) return null;          // a 404 IS an answer

  const body = await res.text();
  try { return JSON.parse(body); } catch { throw new DoajUnavailable('unparseable'); }
}

// ── THE AUTHOR GUARD ─────────────────────────────────────
//
// 11 of the 25 works that returned results returned collisions, and they
// were systematic: common-word titles (`Shy` → shy albatross, a social
// anxiety questionnaire; `Eileen` → Eileen Chang, Eileen Lundy), and titles
// shared with a more famous work (`Antigona`, a 1960 Slovene play, returned
// 199 articles about Sophocles; `Carmina` returned Carmina Burana).
//
// Every genuine hit named the author. No collision did. So the guard is
// author corroboration and nothing more elaborate until that fails.

const DIACRITICS = /[\u0300-\u036f]/g;

export const fold = (s) => String(s || '')
  .normalize('NFD').replace(DIACRITICS, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The parts of an author's name worth matching on.
 *
 * Every token of four characters or more, not just the surname. Two things
 * this has to survive, both flagged before it was written:
 *
 *   - **Transliteration.** `Dostoevsky` and `Dostoyevsky` are the same man,
 *     and criticism uses both. Handled below by folding, not by weakening
 *     the rule to a substring.
 *   - **Translated work**, where criticism may foreground the translator.
 *     The author is still named somewhere in a paper about their book; the
 *     translator appearing more often does not remove them.
 */
export const nameTokens = (author) =>
  fold(author).split(' ').filter((t) => t.length >= 4);

/**
 * Transliteration-tolerant containment.
 *
 * `dostoevsky` vs `dostoyevsky`, `tolstoy` vs `tolstoi`. Collapsing the
 * vowels — `y` included, which is the whole of the Russian case — catches
 * the romanisation differences that actually appear.
 *
 * KNOWN LIMIT: it does not catch initial-consonant variance, so `Chekhov`
 * and `Čechov` remain distinct. That form is rare in English-language
 * journals, which is all this source reads, and widening the rule to reach
 * it would cost more in false matches than it recovers. If it shows up in
 * real data, it is still a name-matching problem — do not weaken the guard.
 */
export const collapse = (t) => fold(t)
  // `y` counts as a vowel here, and it is the whole of the Russian case:
  // `dostoevsky` and `dostoyevsky` differ only in a medial `y`, as do
  // `tolstoy` and `tolstoi`. Without it the collapse does nothing for the
  // names it exists for.
  .replace(/[aeiouy]+/g, 'a')
  .replace(/kh|ch|cz|cs/g, 'h')
  .replace(/ks|cs/g, 'x')
  .replace(/ff|ph/g, 'f')
  .replace(/(.)\1+/g, '$1');

export function namesAuthor(haystack, author) {
  const tokens = nameTokens(author);
  if (!tokens.length) return false;

  const hay = fold(haystack);
  if (tokens.some((t) => hay.includes(t))) return true;

  // Only then the tolerant pass, and only on tokens that are still
  // distinctive AFTER collapsing — not before.
  //
  // Measuring the token's original length was wrong and produced a false
  // match immediately: `louis` is five characters but collapses to `las`,
  // which is inside `molecules`, so a paper on adhesion molecules matched
  // Robert Louis Stevenson. The collapsed form is what does the matching, so
  // the collapsed form is what has to be long enough to mean something.
  const loose = ' ' + collapse(hay) + ' ';
  return tokens.some((t) => {
    const c = collapse(t);
    return c.length >= 5 && loose.includes(c);
  });
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const isEnglish = (a) => (a?.bibjson?.journal?.language || []).includes('EN');

/**
 * Everything DOAJ holds that is demonstrably about this book.
 *
 * Returns [] for a book it has nothing on, which is an answer. Throws
 * `DoajUnavailable` when the service will not say, which is not.
 */
export async function criticismFor({ title, author }, { max = 4, minAbstract = 300 } = {}) {
  if (!title || !author) return [];

  const q = encodeURIComponent(`bibjson.title:("${String(title).replace(/["\\]/g, '')}")`);
  const data = await search(`https://doaj.org/api/search/articles/${q}?pageSize=12`);
  await sleep(PAUSE_MS);

  const out = [];
  for (const a of data?.results || []) {
    if (!isEnglish(a)) continue;

    const b = a.bibjson || {};
    const abstract = clean(b.abstract);
    if (abstract.length < minAbstract) continue;

    // The guard. Author named in the abstract, the title, or the keywords.
    const where = [abstract, clean(b.title), (b.keywords || []).join(' ')].join(' ');
    if (!namesAuthor(where, author)) continue;

    out.push({
      heading: HEADING_PREFIX + clean(b.title).slice(0, 70),
      text: abstract,
      kind: 'doaj',
      journal: clean(b.journal?.title),
      year: b.year || null,
      doi: (b.identifier || []).find((i) => i.type === 'doi')?.id || null
    });
    if (out.length >= max) break;
  }
  return out;
}

// ── CACHE ────────────────────────────────────────────────
// One row per work under our own kind, so Wikipedia's cached sections and
// the blurb are untouched — `history_sources` is keyed on (work_id, kind).

export function cache(workId, sections) {
  if (!sections?.length) return;
  const body = sections.map((s) => `== ${s.heading} ==\n${s.text}`).join('\n\n');
  run(
    `INSERT INTO history_sources (work_id, kind, ref, title, text, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (work_id, kind) DO UPDATE SET
       ref = excluded.ref, title = excluded.title,
       text = excluded.text, fetched_at = excluded.fetched_at`,
    Number(workId), KIND, 'https://doaj.org/', `${sections.length} open-access articles`,
    body, nowSQL()
  );
}

export function cachedFor(workId) {
  const row = get('SELECT text FROM history_sources WHERE work_id = ? AND kind = ?',
                  Number(workId), KIND);
  if (!row) return null;
  const out = [];
  for (const block of String(row.text || '').split(/\n(?===\s)/)) {
    const m = /^==\s*(.+?)\s*==\n([\s\S]*)$/.exec(block.trim());
    if (m && m[2].trim()) out.push({ heading: m[1], text: m[2].trim(), kind: 'doaj' });
  }
  return out;
}
