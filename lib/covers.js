import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, run } from '../db/index.js';
import { normalizeISBN } from './artifacts.js';

// ── THE COVER PIPELINE (v0.5.1 §0, §3.3) ─────────────────
//
// The visual identity of the product is carried entirely by cover art, so
// this is load-bearing infrastructure rather than a nicety.
//
// The rule that fixes the original bug: NEVER store a cover URL that has not
// been confirmed to return a real image. The previous implementation
// generated `covers.openlibrary.org/b/isbn/{isbn}.jpg` optimistically for any
// edition with an ISBN and stored it as if verified — measured at a 5% hit
// rate against 100% for URLs Open Library actually confirmed.
//
// Chain: Open Library cover id → Open Library by ISBN → Google Books →
// the typographic galley plate (§3.4) as the terminal state.

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.MARGIN_COVER_DIR || join(here, '..', 'data', 'covers');
mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'MARGIN/0.5 (personal reading log)';

// Open Library's blank placeholder is ~43 bytes. Anything under this is not
// a cover, whatever status code came with it.
const MIN_BYTES = 1000;

let lastCall = 0;
async function polite(gap = 120) {
  const wait = Math.max(0, lastCall + gap - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

// A URL is only usable if it actually returns image bytes. This is the whole
// fix: verification happens once, at import, not hopefully at render.
async function verify(url, { timeout = 12000 } = {}) {
  if (!url) return null;
  await polite();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < MIN_BYTES) return null; // the 1×1 placeholder
    return { url, buf, type, ...dimensions(buf) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pixel dimensions, read straight out of the file header.
 *
 * `verify` used to judge an image by its byte length alone, so a 95x148
 * thumbnail weighed enough to pass and was accepted as the final answer —
 * and because the first candidate that verified won, the search stopped
 * there and never saw the 333x500 the same book had under a different
 * cover id. Fifty-two jackets in this library came in that way.
 *
 * No decoder and no dependency: both formats state their size in the first
 * few hundred bytes.
 */
export function dimensions(buf) {
  if (!buf || buf.length < 24) return { w: 0, h: 0 };

  // PNG: IHDR is always the first chunk.
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // JPEG: walk the markers to the start-of-frame, which carries the size.
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15, minus the ones that are not frame headers.
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return { w: 0, h: 0 };
}

/**
 * Below this a jacket is a thumbnail, not artwork.
 *
 * The lookbook prints a cover 225 CSS px wide, which wants 450 on a retina
 * screen, and the season poster prints them larger still. Open Library caps
 * its own large size at 500px on the long edge, so 280 is not an aspiration
 * — it is the line under which a jacket visibly degrades.
 */
export const MIN_COVER_WIDTH = 280;

// ?default=false makes Open Library 404 on a miss instead of returning a
// 1×1 blank at HTTP 200.
const olById = (id, size = 'L') =>
  id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg?default=false` : null;

const olByISBN = (isbn, size = 'L') =>
  isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg?default=false` : null;

// Search-index helpers. Local to this module so the cover pipeline does not
// depend on the shape of the work-resolution code.
async function ol(path, { timeout = 15000 } = {}) {
  await polite(220);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`https://openlibrary.org${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The likeliest of several matching works, by the same signals the main
 * path uses: how close the title is, and whether the author agrees.
 *
 * Used only for the editions fallback, where the candidates have no cover
 * to score and the choice is which work to open.
 */
function pickWork(docs, { title, bare, alt, primary, author }) {
  const wanted = String(author || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  let best = null;

  for (const d of docs) {
    if (!d.title || PARASITE.test(d.title)) continue;
    const cand = normalizeTitle(d.title);
    const sim = Math.max(
      dice(cand, normalizeTitle(title)),
      dice(cand, normalizeTitle(bare)),
      alt ? dice(cand, normalizeTitle(alt)) : 0,
      primary !== bare ? dice(cand, normalizeTitle(primary)) : 0
    );
    const authors = (d.author_name || []).join(' ').toLowerCase();
    const authorMatch = wanted.length > 0 && wanted.some((w) => authors.includes(w));

    // The same floor the scored path applies. A loose title match with the
    // wrong author is how a cover for a different book gets attached.
    if (sim < 0.5 && !authorMatch) continue;

    const score = sim + (authorMatch ? 0.5 : 0) + Math.min(0.2, (d.edition_count || 0) / 500);
    if (!best || score > best.score) best = { ...d, score };
  }
  return best;
}

// Books *about* books. Never the work the reader meant.
const PARASITE = /^(summary|trivia|study guide|a study guide|analysis|analyse|a guide|guide to|notes on|sparknotes|cliffsnotes|workbook|conversation starters|key takeaways|abstract|bloom's|readers guide|reading group)\b|\bsummary of\b|\bstudy guide\b/i;

const normalizeTitle = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

// ── Second source (§3.3) ─────────────────────────────────
// Open Library's search index, which carries a `cover_i` for the best-known
// edition of a work. This is a different lookup path from /b/isbn/ and a far
// better one: an edition's own ISBN frequently has no cover while the work
// plainly does, and the search index knows about that other edition.
//
// Google Books was the intended second source but returns HTTP 429 on the
// unkeyed quota at this volume, so it sits last and rarely answers.
export async function coverIdForWork(title, author, { strictEnglish = false, requireAuthor = false } = {}) {
  if (!title) return null;

  // Several query shapes, because each fails differently:
  //  - title+author is precise but dies on translated authors, where Open
  //    Library lists 村上春樹 or Фёдор Достоевский, and on classics where it
  //    lists the TRANSLATOR (Anna Karenina comes back as "Louise Maude").
  //  - the full title dies on anything with a subtitle.
  //  - a bare title surfaces study guides above the novel.
  // Strip a subtitle, and a trailing volume marker: Goodreads titles carry
  // "Book 1" / "Vol. 2" / "#3" where Open Library does not.
  const bare = title
    .replace(/\s*[:–—-]\s.*$/, '')
    .replace(/[,(]?\s*(book|vol\.?|volume|part)\s*[\dIVX]+\)?\s*$/i, '')
    .replace(/\s*#\s*[\d.]+\s*$/, '')
    .trim();
  // Some books carry two names — "The Story of the Stone, or The Dream of
  // the Red Chamber" is catalogued under the second.
  const alt = (bare.match(/,?\s+or,?\s+(.+)$/i) || [])[1]?.trim() || null;
  // And the primary name is what precedes the "or".
  const primary = alt ? bare.replace(/,?\s+or,?\s+.+$/i, '').trim() : bare;

  const queries = [
    `/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author || '')}`,
    `/search.json?title=${encodeURIComponent(title)}`,
    bare && bare !== title ? `/search.json?title=${encodeURIComponent(bare)}` : null,
    primary && primary !== bare ? `/search.json?title=${encodeURIComponent(primary)}` : null,
    alt ? `/search.json?title=${encodeURIComponent(alt)}` : null,
    `/search.json?q=${encodeURIComponent(`${bare} ${author || ''}`.trim())}`
  ].filter(Boolean);

  // Records returned by the FIRST query — the one that constrains on author
  // — are author-confirmed by construction. Open Library did the matching,
  // and it can match 三島由紀夫 to "Yukio Mishima" and Фёдор Достоевский to
  // "Fyodor Dostoevsky" where a Latin string comparison cannot.
  //
  // Without this, requiring the author blocked every translated writer in
  // the library: Mishima's book fell back to its French jacket because the
  // only thing that could vouch for the author was a name in a script the
  // comparison could not read.
  const authorConfirmed = new Set();

  const seen = new Map();
  // Works that matched but carry no cover of their own. Open Library files a
  // great many covers on the EDITION and leaves the work record bare —
  // Being and Nothingness, Chess Story and Antigona all match by title and
  // author and all come back with no cover_i at all — so these are kept for
  // a second pass rather than discarded.
  const coverless = new Map();
  for (const [qi, base] of queries.entries()) {
    const data = await ol(`${base}&fields=key,title,author_name,cover_i,edition_count&limit=10`);
    for (const d of data?.docs || []) {
      // queries[0] is title AND author. A hit there is vouched for.
      if (qi === 0 && author && d.key) authorConfirmed.add(d.key);
      if (!d.cover_i) {
        if (d.key && !coverless.has(d.key)) coverless.set(d.key, d);
        continue;
      }
      if (seen.has(d.cover_i)) continue;
      seen.set(d.cover_i, d);
    }
    if (seen.size >= 12) break;
  }

  // ── Descend into the editions ──────────────────────────
  //
  // The work matched but has no cover of its own. Its editions almost
  // certainly do, and one of them is the jacket somebody actually held.
  // Without this the search reported "no cover exists" for thirty-three
  // books in this library, several of them Penguin classics.
  //
  // Only the best-matching coverless work is opened, and only one call is
  // spent on it: this runs over a whole library and Open Library is a
  // volunteer-funded service.
  if (!seen.size && coverless.size) {
    const best = pickWork([...coverless.values()], { title, bare, alt, primary, author });
    if (best?.key) {
      const eds = await ol(`${best.key}/editions.json?limit=40`);
      const ids = [...new Set((eds?.entries || []).flatMap((e) => e.covers || []).filter((n) => n > 0))];
      // Newest editions first: a cover id issued later is both a more
      // current jacket and, usually, a better scan.
      for (const id of ids.reverse().slice(0, 6)) {
        const hit = await verify(olById(id));
        if (hit && hit.w >= MIN_COVER_WIDTH) return id;
      }
      if (ids.length) return ids[0];
    }
  }

  if (!seen.size) return null;

  const wanted = String(author || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = [];
  for (const d of seen.values()) {
    if (PARASITE.test(d.title)) continue;

    // Title similarity against both the full title and the part before any
    // subtitle, so a subtitle neither helps nor hurts.
    const candNorm = normalizeTitle(d.title);
    const sim = Math.max(
      dice(candNorm, normalizeTitle(title)),
      dice(candNorm, normalizeTitle(bare)),
      alt ? dice(candNorm, normalizeTitle(alt)) : 0,
      primary !== bare ? dice(candNorm, normalizeTitle(primary)) : 0
    );

    const authors = (d.author_name || []).join(' ').toLowerCase();
    const authorMatch = authorConfirmed.has(d.key) ||
      (wanted.length > 0 && wanted.some((w) => authors.includes(w)));

    // Open Library often files a translated novel under its ORIGINAL title:
    // Kafka on the Shore is 海辺のカフカ by 村上春樹, with 61 editions. That
    // normalizes to an empty string, so title similarity is meaningless and
    // neither the title nor the author can corroborate. Weight of editions
    // does it instead — a 61-edition record returned by a search naming both
    // the title and the author is the canonical work.
    // The same rule applies to the original-title path: a work filed under
    // its native script is only identifiable if our own title is
    // distinctive enough to have produced the query.
    const nbq = normalizeTitle(bare);
    const distinctiveQuery = nbq.length >= 14 || (nbq.split(' ').length >= 2 && nbq.length >= 10);
    const nonLatinTitle = candNorm.length < 2;
    if (nonLatinTitle) {
      if (!requireAuthor && distinctiveQuery && (d.edition_count || 0) >= 2) {
        scored.push({ cover: d.cover_i, key: d.key, score: 1.2 + Math.min(1, (d.edition_count || 0) / 40) });
      }
      continue;
    }

    if (sim < 0.62) continue;

    // A near-exact title can stand in for author agreement — but only when
    // the title is distinctive enough to identify a book on its own.
    //
    // "Gold" is four letters. It matches Rumi's Gold and Asimov's Gold
    // equally perfectly, and title similarity is therefore no evidence at
    // all. Anything short or common REQUIRES the author to agree.
    // Two words and ten characters is enough to name a book ("anna karenina").
    // One short word is not ("gold").
    const nb = normalizeTitle(bare);
    const distinctive = nb.length >= 14 || (nb.split(' ').length >= 2 && nb.length >= 10);

    // A distinctive-looking title can normally stand in for author
    // agreement. It must not when we are overwriting a cover that already
    // exists: "White Nights" is twelve characters and two words, which
    // passes the distinctiveness test, and it is also an Ann Cleeves
    // thriller — so Dostoevsky's book got her jacket. Same for Philippe
    // Besson's Lie With Me and Sabine Durrant's.
    //
    // A foreign jacket on the right book is a blemish. The wrong book is an
    // error, and the recheck path is not allowed to make one.
    const confident = requireAuthor
      ? authorMatch
      : authorMatch || (distinctive && sim >= 0.86 && (d.edition_count || 0) >= 2);
    if (!confident) continue;

    scored.push({
      cover: d.cover_i,
      key: d.key,
      // Author agreement outranks popularity; popularity breaks ties.
      score: (authorMatch ? 2 : 0) + sim + Math.min(1, (d.edition_count || 0) / 40)
    });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  // ── Prefer a jacket in the language the book was read in ──
  //
  // This is the fix that mattered. Open Library files ONE default cover per
  // work and picks it arbitrarily, so an English reader's shelf came back
  // with Do Androids Dream in Cyrillic, The Great Gatsby as Der Grosse
  // Gatsby, The Bell Jar as La Campana de Cristal and The Road as La
  // Carretera. Every one of those was the right book and the wrong object:
  // not a jacket anybody in this library ever held.
  //
  // The work's own editions know their language. Asking for an English one
  // costs a single extra request against the work already chosen, and it
  // only ever overrides the default when it finds one.
  // strict: an English jacket or nothing.
  //
  // Falling back to scored[0].cover here was the hole. That value is Open
  // Library's arbitrary per-work default, and it is exactly the thing that
  // put Cyrillic on Do Androids Dream in the first place — so "prefer
  // English, else take the default" quietly reintroduced the bug it was
  // written to fix. When the caller asked for English, a foreign cover is
  // not a partial success; it is the failure.
  if (strictEnglish) return englishCover(scored[0].key, bare);

  const english = await englishCover(scored[0].key, bare);
  return english || scored[0].cover;
}

/**
 * The cover of the most recent English edition of a work, if it has one.
 *
 * Recent because a jacket reissued in 2020 is both the edition somebody is
 * likely to be holding and, usually, the better scan — the 1969 printings
 * in Open Library are photographs of paperbacks that have been in a box.
 */
async function englishCover(workKey, wantedTitle = null) {
  if (!workKey) return null;
  const eds = await ol(`${workKey}/editions.json?limit=50`);
  const entries = eds?.entries || [];

  // The edition's own TITLE has to be the English one too.
  //
  // Language alone is not enough. Open Library marks the Anaconda "Der
  // Grosse Gatsby" as English, correctly — it is a ZWEISPRACHIGE AUSGABE, a
  // bilingual edition, and half of it really is in English. The metadata is
  // not wrong; it just does not answer the question being asked, which is
  // whether the JACKET says The Great Gatsby or Der Grosse Gatsby.
  //
  // The title does answer it.
  const want = wantedTitle ? normalizeTitle(wantedTitle) : null;
  const titleAgrees = (e) => {
    if (!want) return true;
    const t = normalizeTitle(e.title || '');
    if (!t) return false;
    // A LONGER title that merely contains ours is how the bilingual edition
    // got through: Open Library files it as "The Great Gatsby / Der große
    // Gatsby", which contains "the great gatsby" exactly. Containment is
    // therefore only allowed in the other direction — a stored title
    // shorter than ours is an edition dropping a subtitle, which is fine.
    return dice(t, want) >= 0.72 || want.includes(t);
  };

  // Editions published in an English-speaking country, first.
  //
  // Not a filter — plenty of good records leave the field blank — but a
  // strong tiebreak, and the one that separates a London Penguin from a
  // Cologne dual-language reprint when both are marked English.
  const ANGLOPHONE = new Set([
    'enk', 'nyu', 'cau', 'mau', 'ilu', 'nju', 'pau', 'txu', 'wau', 'mnu',
    'onc', 'bcc', 'quc', 'at', 'nsw', 'vra', 'nz', 'sti', 'ie', 'xxk', 'gbr'
  ]);

  const candidates = entries
    .filter((e) => (e.covers || []).some((c) => c > 0))
    .filter((e) => (e.languages || []).some((l) => /\/eng$/.test(l?.key || '')))
    .filter(titleAgrees)
    .map((e) => ({
      id: (e.covers || []).find((c) => c > 0),
      // Only the year matters, and the field is free text: "2017-05-09",
      // "1969", "May 2011".
      year: Number((String(e.publish_date || '').match(/\b(1[89]\d{2}|20\d{2})\b/) || [])[1]) || 0,
      anglophone: ANGLOPHONE.has(String(e.publish_country || '').trim()) ? 1 : 0
    }))
    // Country first, then recency: a 2011 London printing beats a 2020
    // bilingual one, and among equals the newer jacket wins.
    .sort((a, b) => b.anglophone - a.anglophone || b.year - a.year);

  let best = null;
  for (const c of candidates.slice(0, 5)) {
    const hit = await verify(olById(c.id));
    if (!hit) continue;
    if (hit.w >= MIN_COVER_WIDTH) return c.id;
    if (!best || hit.w > best.w) best = { id: c.id, w: hit.w };
  }
  return best?.id || null;
}

// Third source. Kept for completeness; usually quota-blocked without a key.
async function googleBooks(isbn) {
  if (!isbn) return null;
  await polite(300);
  try {
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`,
      { headers: { 'User-Agent': UA } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const links = data.items?.[0]?.volumeInfo?.imageLinks;
    if (!links) return null;

    // Returned URLs are http and zoom-limited; rewrite for a usable size.
    const raw = links.extraLarge || links.large || links.medium || links.thumbnail;
    if (!raw) return null;
    return raw
      .replace(/^http:/, 'https:')
      .replace(/&zoom=\d+/, '&zoom=3')
      .replace(/&edge=curl/, '');
  } catch {
    return null;
  }
}

const cachePath = (key) => join(CACHE_DIR, `${key}.jpg`);
export const cacheKey = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 20);

// Resolve one edition's cover, verify it, cache the bytes locally, and record
// the result. Returns { url, source, cached } or null.
export async function resolveCover(edition, { olCoverId = null, title = null, author = null,
                                              olCoverIdIsVerified = false, preferEnglish = false } = {}) {
  const isbn = normalizeISBN(edition.isbn13 || edition.isbn10);

  // ── preferEnglish ──────────────────────────────────────
  //
  // Identity-first is the right default: this edition's own ISBN names THIS
  // object, and its cover is the jacket on the copy in the catalogue.
  //
  // It is the wrong default when the catalogue is wrong. An import that
  // matched a Spanish printing of The Road stores that printing's ISBN, so
  // the identity path returns La Carretera, at a perfectly good 300px, and
  // returns it before the search that would have found the English jacket
  // ever runs. Three passes over this library left Der Grosse Gatsby, El
  // pacient anglès and La Campana de Cristal exactly where they were.
  //
  // With this on, the work-level search goes first and the edition's own
  // ISBN becomes the fallback rather than the answer.
  if (preferEnglish && title) {
    // requireAuthor: this path REPLACES a jacket that is already there.
    const searchId = await coverIdForWork(title, author, { strictEnglish: true, requireAuthor: true });
    if (searchId) {
      const hit = await verify(olById(searchId));
      if (hit && hit.w >= MIN_COVER_WIDTH) return store(edition.id, hit, 'openlibrary-search');
    }
  }

  const candidates = [
    olCoverId ? { url: olById(olCoverId), source: 'openlibrary-id' } : null,
    isbn ? { url: olByISBN(isbn), source: 'openlibrary-isbn' } : null
  ].filter(Boolean);

  // ── Take the best, not the first ───────────────────────
  //
  // This loop used to return on the first candidate that loaded, which is
  // why the library holds jackets at 95x148: an ISBN-derived cover is
  // identity-proven but frequently a thumbnail, and once it verified the
  // search stopped and never looked at the work-level cover that would have
  // come back at 333x500.
  //
  // So identity still wins — an ISBN cover IS this edition — but only when
  // it is actually big enough to print. Below that the search runs too, and
  // the larger image takes it.
  let best = null;
  const consider = (hit, source) => {
    if (!hit) return;
    if (!best || hit.w > best.hit.w) best = { hit, source };
  };

  for (const c of candidates) {
    const hit = await verify(c.url);
    // An ISBN-derived cover is identity-proven; a caller-supplied cover id is
    // only as good as whatever resolved it, so it is labelled as such.
    const source = c.source === 'openlibrary-id' && !olCoverIdIsVerified ? 'openlibrary-search' : c.source;
    if (hit && hit.w >= MIN_COVER_WIDTH) return store(edition.id, hit, source);
    consider(hit, source);
  }

  // Second source: the work almost certainly has a jacket even when this
  // particular edition's ISBN does not — and often a better one.
  //
  // `requireAuthor` rides along with preferEnglish. This call was the last
  // leak: the strict search above correctly declined to give Dostoevsky's
  // White Nights an English cover it does not have, and then this line ran
  // the LOOSE search and handed it Ann Cleeves' thriller of the same name.
  // Anything replacing an existing jacket has to clear the same bar.
  if (title) {
    const searchId = await coverIdForWork(title, author, { requireAuthor: preferEnglish });
    if (searchId) {
      const hit = await verify(olById(searchId));
      if (hit && hit.w >= MIN_COVER_WIDTH) return store(edition.id, hit, 'openlibrary-search');
      consider(hit, 'openlibrary-search');
    }
  }

  // Nothing reached the bar. A small jacket still beats the galley plate, so
  // the largest of what was found is kept rather than discarded.
  if (best) return store(edition.id, best.hit, best.source);

  const g = await googleBooks(isbn);
  if (g) {
    const hit = await verify(g);
    if (hit) return store(edition.id, hit, 'googlebooks');
  }

  // Terminal state is the galley plate. Recording null is a real answer, not
  // a failure — it stops the next run from re-asking.
  //
  // But ONLY for an edition that has no jacket already. Blanking cover_url
  // while leaving cover_cache_key in place makes a row that still has a
  // usable image and looks coverless to every query that sorts on the url —
  // which is exactly what happened: twenty books whose shelf item has no
  // pinned edition fell through to a DIFFERENT edition with no cover at all,
  // and appeared to lose jackets that were never actually deleted.
  //
  // A failed re-lookup is not evidence that the cover we already hold is bad.
  run(
    `UPDATE editions SET cover_url = CASE WHEN cover_cache_key IS NULL THEN NULL ELSE cover_url END,
                         cover_source = CASE WHEN cover_cache_key IS NULL THEN 'none' ELSE cover_source END,
                         cover_checked_at = datetime('now')
     WHERE id = ?`,
    edition.id
  );
  return null;
}

function store(editionId, hit, source) {
  // Cached to our own storage so the app never hotlinks a third-party host,
  // and — critically for "THE WALL" — so cover pixels are same-origin and a
  // canvas can read them without CORS tainting.
  const key = cacheKey(hit.url);
  try {
    writeFileSync(cachePath(key), hit.buf);
  } catch { /* the remote URL still works if the disk cache fails */ }

  run(
    `UPDATE editions SET cover_url = ?, cover_source = ?, cover_cache_key = ?,
       cover_checked_at = datetime('now')
     WHERE id = ?`,
    hit.url, source, key, editionId
  );
  return { url: hit.url, source, cached: key };
}

// Served same-origin by the /cover route.
export function readCached(key) {
  if (!key || !/^[0-9a-f]{20}$/.test(key)) return null;
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  try {
    return { buf: readFileSync(p), size: statSync(p).size };
  } catch {
    return null;
  }
}

export async function cacheFromURL(url) {
  const key = cacheKey(url);
  if (existsSync(cachePath(key))) return key;
  const hit = await verify(url);
  if (!hit) return null;
  try {
    writeFileSync(cachePath(key), hit.buf);
  } catch {
    return null;
  }
  return key;
}
