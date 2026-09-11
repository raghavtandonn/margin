import { get, run, reindexWork } from '../db/index.js';
import * as W from './works.js';
import { titleKey } from './title-match.js';
import { normalizeISBN } from './artifacts.js';

// §12 — "a real work/edition graph, populated from Open Library".
// Open Library is the right source because it already IS a work/edition
// graph: the distinction MARGIN puts on the outside is the distinction their
// data model is built on. No API key, no auth, free.

const UA = 'MARGIN/0.1 (personal reading log; https://github.com/local/margin)';
const BASE = 'https://openlibrary.org';

// Open Library asks for considerate use. One request at a time, with a gap.
let lastCall = 0;
const POLITE_GAP_MS = 250;

async function ol(path, { timeout = 15000 } = {}) {
  const wait = Math.max(0, lastCall + POLITE_GAP_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // §10 — a failed lookup is reported plainly by the caller, never as a
    // crash and never as a silent success.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ?default=false is essential (A2). Without it a miss returns a 1×1 blank
// image with HTTP 200 instead of a 404, and the product renders invisible
// broken covers forever.
export const coverURL = (isbn, size = 'L') =>
  isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg?default=false` : null;

const coverURLFromId = (id, size = 'L') =>
  id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg?default=false` : null;

const yearOf = (publishDate) => {
  const m = String(publishDate || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : null;
};

const formatOf = (physical) => {
  const f = String(physical || '').toLowerCase();
  if (f.includes('hard')) return 'HARDCOVER';
  if (f.includes('mass')) return 'MASS_MARKET';
  if (f.includes('ebook') || f.includes('electronic')) return 'EBOOK';
  if (f.includes('audio')) return 'AUDIO';
  return 'PAPERBACK';
};

// ── Lookups ──────────────────────────────────────────────

/**
 * The extent, when the catalogue records it as a pagination statement.
 *
 * Open Library stores an edition's length in `number_of_pages` OR in the
 * free-text `pagination` field, and for a good many records only the second
 * is filled — `Gold` and `Doctor Zhivago` both read "no page count" through
 * `number_of_pages` while carrying "96" and "384" here. That is a gap in the
 * reading, not an absence in the source.
 *
 * The field is a bibliographer's string: "96", "xii, 275 p.", "384 pages",
 * "1 volume (various pagings)". The largest plausible integer in it is the
 * extent — roman-numeral front matter is not it, and a record with no number
 * in range yields nothing rather than a guess.
 */
export function pagesFromPagination(pagination) {
  const nums = String(pagination || '').match(/\d+/g);
  if (!nums) return null;
  const best = Math.max(...nums.map(Number).filter((n) => n >= 20 && n <= 20000));
  return Number.isFinite(best) ? best : null;
}

export async function byISBN(isbn) {
  const clean = normalizeISBN(isbn);
  if (!clean) return null;
  const ed = await ol(`/isbn/${clean}.json`);
  if (!ed) return null;

  return {
    title: ed.title,
    isbn13: (ed.isbn_13 || [])[0] || clean,
    isbn10: (ed.isbn_10 || [])[0] || null,
    publisher: (ed.publishers || [])[0] || null,
    published_year: yearOf(ed.publish_date),
    page_count: ed.number_of_pages || pagesFromPagination(ed.pagination),
    format: formatOf(ed.physical_format),
    cover_url: coverURLFromId((ed.covers || [])[0]) || coverURL(clean),
    ol_key: ed.key || null,
    workKey: (ed.works || [])[0]?.key || null
  };
}

// ── Resolving a title+author to the right work ───────────
// Harder than it looks. Open Library indexes translated authors under their
// native script (Murakami as 村上春樹, Dostoevsky in Cyrillic), so an author
// string match cannot be required. Meanwhile a bare title search surfaces
// "Summary of X", "Trivia: X", and critical studies above the novel itself.
//
// Attaching one of those would put a wrong cover and a wrong ISBN on the
// shelf, which is worse than leaving the book unresolved — so a low-confidence
// match is refused rather than guessed.

const LATIN = /^[\p{Script=Latin}\p{P}\p{N}\s]+$/u;

// Books *about* books. Never the work the reader meant.
const PARASITE = /^(summary|trivia|study guide|analysis|analyse|a guide|guide to|notes on|sparknotes|cliffsnotes|workbook|conversation starters|key takeaways|abstract)\b|\bsummary of\b/i;

const normalizeTitle = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

function dice(a, b) {
  const grams = (s) => {
    const p = ` ${s} `;
    const set = new Set();
    for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

export function scoreCandidate(candidate, title, author) {
  const candTitle = normalizeTitle(candidate.title);
  const wantTitle = normalizeTitle(title);
  if (!candTitle || !wantTitle) return { accept: false, reason: 'NO TITLE' };

  if (PARASITE.test(candidate.title)) return { accept: false, reason: 'BOOK ABOUT THE BOOK' };

  const titleSim = dice(candTitle, wantTitle);

  // "Haruki Murakami's The Wind-Up Bird Chronicle" contains the title but is
  // not it. A candidate carrying a lot of extra words is a different book.
  const extraWords = candTitle.split(' ').length - wantTitle.split(' ').length;
  if (extraWords >= 3 && !candTitle.startsWith(wantTitle)) {
    return { accept: false, reason: 'TITLE IS A SUPERSET' };
  }

  const candAuthors = (candidate.authors || []).join(' ');
  const authorIsLatin = !candAuthors || LATIN.test(candAuthors);
  const wanted = String(author || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const authorMatch =
    wanted.length > 0 && wanted.some((w) => candAuthors.toLowerCase().includes(w));

  const editions = candidate.editionCount || 0;

  // Strong: the title matches and the author corroborates it.
  if (titleSim >= 0.72 && authorMatch) {
    return { accept: true, confidence: 'AUTHOR MATCH', titleSim };
  }
  // The author is in another script, so it cannot corroborate. A near-exact
  // title with many editions is the canonical work rather than a study of it.
  if (titleSim >= 0.86 && !authorIsLatin && editions >= 5) {
    return { accept: true, confidence: 'TITLE + SCRIPT', titleSim };
  }
  // A near-exact title carrying a large edition count is the real work.
  if (titleSim >= 0.92 && editions >= 12) {
    return { accept: true, confidence: 'TITLE + EDITIONS', titleSim };
  }

  return { accept: false, reason: `WEAK (t=${titleSim.toFixed(2)}, ed=${editions})` };
}

// Runs several query shapes because no single one finds everything: fielded
// title+author is precise but misses translated authors; a plain q finds them
// but ranks studies above novels.
export async function resolveWork(title, author) {
  const seen = new Map();
  const queries = [
    `/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`,
    `/search.json?title=${encodeURIComponent(title)}`,
    `/search.json?q=${encodeURIComponent(`${title} ${author}`)}`
  ];

  for (const base of queries) {
    const data = await ol(
      `${base}&fields=key,title,author_name,first_publish_year,isbn,cover_i,edition_count&limit=8`
    );
    for (const d of data?.docs || []) {
      if (!d.key || seen.has(d.key)) continue;
      seen.set(d.key, {
        workKey: d.key,
        title: d.title,
        authors: d.author_name || [],
        year: d.first_publish_year || null,
        isbn13: (d.isbn || []).map(normalizeISBN).find(Boolean) || null,
        editionCount: d.edition_count || 0,
        cover_url: coverURLFromId(d.cover_i)
      });
    }
    // A confident hit from the most precise query needs no fallback.
    const early = [...seen.values()]
      .map((c) => ({ c, s: scoreCandidate(c, title, author) }))
      .filter((x) => x.s.accept && x.s.confidence === 'AUTHOR MATCH');
    if (early.length) {
      early.sort((a, b) => b.s.titleSim - a.s.titleSim || b.c.editionCount - a.c.editionCount);
      return { ...early[0].c, confidence: early[0].s.confidence };
    }
  }

  const scored = [...seen.values()]
    .map((c) => ({ c, s: scoreCandidate(c, title, author) }))
    .filter((x) => x.s.accept);

  if (!scored.length) return null;
  scored.sort((a, b) => b.s.titleSim - a.s.titleSim || b.c.editionCount - a.c.editionCount);
  return { ...scored[0].c, confidence: scored[0].s.confidence };
}

export async function search(query, { limit = 10 } = {}) {
  const fields = 'key,title,author_name,first_publish_year,isbn,cover_i,edition_count';
  const data = await ol(
    `/search.json?q=${encodeURIComponent(query)}&fields=${fields}&limit=${limit}`
  );
  if (!data?.docs) return [];

  return data.docs.map((d) => ({
    workKey: d.key,
    title: d.title,
    authors: d.author_name || [],
    year: d.first_publish_year || null,
    isbn13: (d.isbn || []).map(normalizeISBN).find(Boolean) || null,
    editionCount: d.edition_count || 0,
    cover_url: coverURLFromId(d.cover_i)
  }));
}

// The filmstrip needs more than one edition to be worth having (§09.1).
/**
 * The median page count Open Library computes across every edition of a work.
 *
 * `editionsOfWork` walks the first N editions and takes a length from
 * whichever states one. That fails on exactly the books most likely to be
 * old: Treasure Island has 1,991 editions and none of the first twenty
 * records an extent, so a twenty-edition walk came back empty on a book
 * whose median is 248 pages and is one request away.
 *
 * THE TITLE IS CHECKED BEFORE THE NUMBER IS TRUSTED, and that guard is not
 * theoretical. This library's key for The Wind-Up Bird Chronicle points at
 * "Haruki Murakami's The Wind-up Bird Chronicle" — a 99-page study guide
 * with two editions. Taking its median would have recorded an 600-page novel
 * as 99 pages, silently, with a citation.
 *
 * Returns null rather than a guess whenever the title does not agree.
 */
export async function pagesMedian(workKey, expectedTitle) {
  const key = String(workKey || '').replace(/^\/works\//, '');
  if (!key) return null;

  const data = await ol(
    `/search.json?q=key:/works/${key}&fields=title,number_of_pages_median&limit=1`,
    { base: 'https://openlibrary.org' }
  );
  const doc = (data?.docs || [])[0];
  const pages = doc?.number_of_pages_median;
  if (!pages || pages < 20 || pages > 20000) return null;

  // Agreement, not equality: subtitles, articles and casing differ freely
  // between a catalogue and an export. One title containing the other is
  // enough; "X's The Y" containing "The Y" is exactly the case this rejects,
  // so the check runs the other way too and both must hold.
  //
  // The 0.6 floor is what rejects a study guide whose title merely contains
  // the novel's. It also rejected every book whose catalogue title carries a
  // subtitle the catalogue elsewhere does not: ours reads "The Hundred
  // Years' War on Palestine: A History of Settler Colonialism and
  // Resistance, 1917–2017", theirs reads "The Hundred Years' War on
  // Palestine", and the second is 44% of the first. So the comparison runs
  // against the title with its subtitle cut as well as the whole thing, and
  // agreement with either is enough.
  //
  // This does not weaken the guard: it still requires OUR title to contain
  // THEIRS, so "Summary of Rashid Khalidi's ..." — which is longer than
  // either form of ours — fails both ways round exactly as before.
  const theirs = titleKey(doc.title || '');
  if (!theirs) return null;
  const forms = [expectedTitle || '', String(expectedTitle || '').split(':')[0]]
    .map(titleKey).filter(Boolean);
  const agrees = forms.some(
    (ours) => theirs === ours || (ours.includes(theirs) && theirs.length >= ours.length * 0.6)
  );
  return agrees ? pages : null;
}

export async function editionsOfWork(workKey, { limit = 12 } = {}) {
  const key = String(workKey).replace(/^\/works\//, '');
  const data = await ol(`/works/${key}/editions.json?limit=${limit}`);
  if (!data?.entries) return [];

  return data.entries
    .map((e) => {
      const isbn13 = (e.isbn_13 || [])[0] || normalizeISBN((e.isbn_10 || [])[0]);
      return {
        title: e.title,
        isbn13,
        isbn10: (e.isbn_10 || [])[0] || null,
        publisher: (e.publishers || [])[0] || null,
        published_year: yearOf(e.publish_date),
        page_count: e.number_of_pages || null,
        format: formatOf(e.physical_format),
        cover_url: coverURLFromId((e.covers || [])[0]) || coverURL(isbn13),
        ol_key: e.key || null
      };
    })
    // An edition with neither an ISBN nor a page count adds nothing to the
    // graph and clutters the filmstrip.
    .filter((e) => e.isbn13 || e.page_count);
}

async function workDetail(workKey) {
  const key = String(workKey).replace(/^\/works\//, '');
  const data = await ol(`/works/${key}.json`);
  if (!data) return null;

  const description =
    typeof data.description === 'string' ? data.description : data.description?.value || null;

  return {
    title: data.title,
    description,
    ol_key: data.key,
    subjects: data.subjects || []
  };
}

// ── Import a whole work into the graph ───────────────────

export async function importWork(workKey, { editionLimit = 8 } = {}) {
  const detail = await workDetail(workKey);
  if (!detail) return { ok: false, reason: 'WORK NOT FOUND ON OPEN LIBRARY.' };

  const existing = get('SELECT id FROM works WHERE ol_key = ?', detail.ol_key);
  if (existing) return { ok: true, workId: existing.id, created: false, editionsAdded: 0 };

  // Authors come from the search doc where available; the work record stores
  // them as keys, which would cost one request each.
  const meta = await ol(`/works/${String(workKey).replace(/^\/works\//, '')}.json`);
  const authorKeys = (meta?.authors || [])
    .map((a) => a.author?.key)
    .filter(Boolean)
    .slice(0, 3);

  const authors = [];
  for (const k of authorKeys) {
    const a = await ol(`${k}.json`);
    if (a?.name) authors.push(a.name);
  }

  const workId = W.createWork({
    title: detail.title,
    authors,
    description: detail.description,
    olKey: detail.ol_key
  });

  const editions = await editionsOfWork(workKey, { limit: editionLimit });
  let added = 0;
  for (const e of editions) {
    if (e.isbn13 && get('SELECT id FROM editions WHERE isbn13 = ?', e.isbn13)) continue;
    W.addEdition(workId, e);
    added++;
  }

  // A work with no usable edition still needs one, or the book page has no
  // page count, cover, or colophon to show.
  if (!added) {
    W.addEdition(workId, { format: 'PAPERBACK' });
    added = 1;
  }

  reindexWork(workId);
  return { ok: true, workId, created: true, editionsAdded: added, title: detail.title };
}

// ── Enrichment of what is already in the graph ───────────
// Fills in covers, page counts, publishers, and extra editions for books that
// arrived from a Goodreads CSV with nothing but a title and an ISBN.

export async function enrichEdition(editionId) {
  const ed = get('SELECT * FROM editions WHERE id = ?', Number(editionId));
  if (!ed?.isbn13) return { ok: false, reason: 'NO ISBN' };

  const data = await byISBN(ed.isbn13);
  if (!data) return { ok: false, reason: 'NOT ON OPEN LIBRARY' };

  const patch = {
    cover_url: ed.cover_url || data.cover_url,
    page_count: ed.page_count || data.page_count,
    publisher: ed.publisher || data.publisher,
    published_year: ed.published_year || data.published_year,
    format: ed.format || data.format,
    ol_key: ed.ol_key || data.ol_key
  };

  run(
    `UPDATE editions SET cover_url = ?, page_count = ?, publisher = ?,
       published_year = ?, format = ?, ol_key = ? WHERE id = ?`,
    patch.cover_url, patch.page_count, patch.publisher,
    patch.published_year, patch.format, patch.ol_key, ed.id
  );

  // §12 — a visible edit history on every record.
  for (const [field, value] of Object.entries(patch)) {
    if (ed[field] || !value) continue;
    run(
      `INSERT INTO edit_history (entity, entity_id, field, old_value, new_value, source)
       VALUES ('edition', ?, ?, ?, ?, 'openlibrary')`,
      ed.id, field, ed[field] ?? null, String(value)
    );
  }

  return { ok: true, workKey: data.workKey, filled: Object.keys(patch).filter((k) => !ed[k] && patch[k]) };
}

// Pull sibling editions for a work that only has the one the CSV knew about,
// so the "EDITION" filmstrip has something to select between.
export async function addSiblingEditions(workId, { limit = 8 } = {}) {
  const work = get('SELECT * FROM works WHERE id = ?', Number(workId));
  if (!work) return { ok: false, reason: 'NO SUCH WORK' };

  let workKey = work.ol_key;
  if (!workKey) {
    const anyISBN = get(
      'SELECT isbn13 FROM editions WHERE work_id = ? AND isbn13 IS NOT NULL LIMIT 1',
      work.id
    );
    if (!anyISBN) return { ok: false, reason: 'NO ISBN TO RESOLVE FROM' };
    const data = await byISBN(anyISBN.isbn13);
    workKey = data?.workKey;
    if (workKey) run('UPDATE works SET ol_key = ? WHERE id = ?', workKey, work.id);
  }
  if (!workKey) return { ok: false, reason: 'NOT ON OPEN LIBRARY' };

  const editions = await editionsOfWork(workKey, { limit });
  let added = 0;
  for (const e of editions) {
    if (!e.isbn13) continue;
    if (get('SELECT id FROM editions WHERE isbn13 = ?', e.isbn13)) continue;
    W.addEdition(work.id, e);
    added++;
  }

  reindexWork(work.id);
  return { ok: true, added };
}
