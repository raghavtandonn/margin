import { ean13Modules, formatISBN, stampRotation } from './artifacts.js';
import { starGlyphs, starText, starLabel } from './stars.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── THE GLYPHS ───────────────────────────────────────────
//
// Six glyphs, one weight, drawn to the same hairline as the rules.
//
// This constant used to be called MARKS, which collided by name with the
// ten one-tap facets in lib/stars.js — a different thing entirely, now
// removed. Renamed so nobody deleting that one takes every icon in the
// product with it.
//
// The product had no icon set at all, so every quantity had to be spelled
// out — BOOKS 71, THIS YEAR 3, FOLLOWING 0 — and a page of figures came out
// as a page of tracked capitals with numbers after them. A mark carries the
// same meaning in a tenth of the space and, unlike the word, it is a
// picture, which is the whole argument of this pass.
//
// Inline, so there is no request and no icon font. `currentColor` and
// `1em`, so they inherit colour and size from the text beside them and need
// no sizing rule of their own.
//
// Deliberately six. An icon set applied to everything is how a restrained
// product turns into a dashboard, and these are only ever used where a
// COUNT already sits beside a LABEL.
const GLYPHS = {
  // A book, seen from the front board.
  book: '<rect x="3.5" y="2.5" width="13" height="15" rx="1"/><path d="M6.5 2.5v15"/>',
  // A season: the strip, as three plates.
  season: '<rect x="2.5" y="6.5" width="4" height="7"/><rect x="8" y="6.5" width="4" height="7"/><rect x="13.5" y="6.5" width="4" height="7"/>',
  // Following: one figure ahead of another.
  following: '<circle cx="7.5" cy="7" r="3"/><path d="M2.5 16.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5"/><path d="M13.5 16.5c0-2.2 1-3.6 2.5-4.2"/>',
  // Followers: the same pair, facing you.
  followers: '<circle cx="12.5" cy="7" r="3"/><path d="M7.5 16.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5"/><path d="M6.5 16.5c0-2.2-1-3.6-2.5-4.2"/>',
  // A reply: one mark on a sheet.
  reply: '<path d="M3.5 3.5h13v9h-8l-5 4z"/>',
  // A club: a room with people in it.
  club: '<circle cx="6.5" cy="8" r="2.4"/><circle cx="13.5" cy="8" r="2.4"/><path d="M2.5 16.5c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6"/><path d="M9.5 16.5c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6"/>'
};

/**
 * One mark, inline.
 *
 * aria-hidden by default: these always sit next to their own label, so a
 * screen reader announcing "book, BOOKS, 71" is noise rather than
 * information. Pass a `label` on the rare occasion the glyph stands alone.
 */
export function mark(name, { label = null } = {}) {
  const d = GLYPHS[name];
  if (!d) return '';
  const a = label
    ? `role="img" aria-label="${esc(label)}"`
    : 'aria-hidden="true" focusable="false"';
  return `<svg class="mark-glyph" viewBox="0 0 20 20" width="1em" height="1em" ${a}
    fill="none" stroke="currentColor" stroke-width="1.4"
    stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

// ── "THE BARCODE" (§08) ──────────────────────────────────
// Real EAN-13 modules as SVG. Scanning it with a phone camera resolves to
// the MARGIN page. Correct, useful, and free.
export function barcodeSVG(isbn13, { height = 54, unit = 2 } = {}) {
  const bits = ean13Modules(isbn13);
  if (!bits) return '';

  const quiet = 9;
  const width = (bits.length + quiet * 2) * unit;
  // Guard bars run longer than the data bars, as they do on a real symbol.
  const isGuard = (i) => i < 3 || (i >= 45 && i < 50) || i >= bits.length - 3;

  let bars = '';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    const h = isGuard(i) ? height + 6 : height;
    bars += `<rect x="${(i + quiet) * unit}" y="0" width="${unit}" height="${h}"/>`;
  }

  return `<svg viewBox="0 0 ${width} ${height + 6}" width="${width}" height="${height + 6}"
    role="img" aria-label="ISBN ${formatISBN(isbn13)}" fill="var(--press-black)">${bars}</svg>`;
}

// ── "THE CONTACT SHEET" frame (v0.2 A2) ──────────────────
// Explicit width/height from the trim aspect so the sheet never reflows
// during image load. Placeholder is flat stock gray — no shimmer, no pulse,
// no skeleton animation.
// §13.1 — a strict style-src forbids a style ATTRIBUTE, and --trim was one.
// There are exactly three trim ratios in the whole product (lib/artifacts.js
// TRIM), so they are three classes rather than a computed value.
const TRIM_CLASS = { 0.619: 'trim-mass', 0.647: 'trim-trade', 0.667: 'trim-hard' };

/**
 * @param {object} item
 * @param {object} [opts]
 * @param {boolean} [opts.reading]   draw the grease-pencil ring
 * @param {boolean} [opts.subject]   this cover IS the page's subject
 *
 * ON `alt`
 * --------
 * Empty alt is right in the common case and wrong in one case, and the two
 * were not being told apart.
 *
 * In a shelf, a grid or a rail, the galley plate underneath the cover already
 * carries the title and the author as real text, and the frame is wrapped in
 * a link naming the book. A screen reader that also announced the jacket
 * would hear the title twice. There the image is decoration and `alt=""` is
 * the correct, deliberate answer.
 *
 * On a work page the jacket is the subject of the page — it is what the
 * reader came to look at, it is credited by name underneath, and it is the
 * only place the design shows it at a size worth looking at. Pass
 * `subject: true` there and it gets described.
 */
export function frame(item, { subject = false } = {}) {
  const trim = item.trimAspect || 0.647;
  const trimClass = TRIM_CLASS[trim] || 'trim-trade';

  // The typographic fallback always renders underneath. The cover layers on
  // top and removes itself if it fails — so a missing cover degrades to a
  // designed blank galley rather than to a broken-image icon, with no
  // layout shift either way.
  const fallback =
    `<span class="frame-fallback">
       <span class="frame-fallback-title">${esc(item.title || '')}</span>
       <span class="frame-fallback-author">${esc(item.authorLine || item.author_name || '')}</span>
     </span>`;

  // §3.2 — explicit width/height so nothing reflows during load;
  // crossorigin so §5's spine sampling can read the pixels.
  const src = coverSrc(item);
  // The onerror attribute that used to live here was an inline event
  // handler, which script-src refuses just as firmly as an inline <script>.
  // public/js/app.js listens for the error event instead, once, in capture
  // phase — which also catches images that fail before the listener would
  // have been attached individually.
  const alt = subject
    ? `Jacket of ${item.title || 'this edition'}${item.authorLine || item.author_name
        ? ` by ${item.authorLine || item.author_name}` : ''}`
    : '';

  // These attributes exist to reserve the right SHAPE before the bytes
  // arrive, so nothing reflows during load; CSS decides how large the jacket
  // is actually drawn. The number was 200, which was neither the intrinsic
  // width of the files (measured across the cache: median 320, range
  // 120–500) nor any size at which one is displayed. 320 is the measured
  // median, so the declared shape is now a fact rather than a placeholder.
  const w = 320;
  const img = src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" crossorigin="anonymous"
            width="${w}" height="${Math.round(w / trim)}"
            data-cover>`
    : '';

  return `<span class="frame ${trimClass}">${fallback}${img}</span>`;
}

// §3.3 — covers are served from our own origin. A cached key is preferred so
// the browser never touches a third-party host, and so the Wall can sample
// pixels from a canvas without tainting it.
export function coverSrc(item) {
  if (!item) return '';
  if (typeof item === 'string') return withDefaultFalse(item);
  if (item.cover_cache_key) return `/cover/${item.cover_cache_key}.jpg`;
  return withDefaultFalse(item.cover_url);
}

// Every cover is served from this origin. Besides satisfying img-src 'self'
// (§13.1), it means no third party receives a request per book per page —
// which would be a running log of what someone is reading.
function withDefaultFalse(url) {
  if (!url) return '';
  const id = /covers\.openlibrary\.org\/b\/id\/(\d+)/.exec(url);
  if (id) return `/cover/ol/${id[1]}.jpg`;
  const isbn = /covers\.openlibrary\.org\/b\/isbn\/([0-9Xx-]+)/.exec(url);
  if (isbn) return `/cover/isbn/${isbn[1].replace(/-/g, '')}.jpg`;
  return url.startsWith('/') ? url : '';
}


// ── THE READER'S PLATE ───────────────────────────────────
//
// A profile with no avatar rendered a bare bordered rectangle, 112px square,
// immediately left of the word READER and the reader's name — with full
// colour jackets beside it. The human slot on the human page was the one
// empty box on the screen.
//
// This is the frame fallback's idiom applied to a person: initials in the
// display serif on a tinted block. The tint is seeded from the handle so it
// is stable per person across sessions and devices, and it is picked from a
// fixed set of classes rather than computed, because a strict style-src
// forbids a style ATTRIBUTE and there is no reason to write a nonced rule
// for six possible values.
export const PLATE_TINTS = 6;

export function plateTint(seed) {
  const rot = Number(stampRotation(String(seed || ''))); // −4.00 … +4.00
  return `plate-t${Math.abs(Math.round(rot * 100)) % PLATE_TINTS}`;
}

/**
 * Up to two initials, from a display name or a handle.
 *
 * Grapheme-aware, so a name that begins with an emoji or a combining mark
 * yields that whole character rather than half of it. A handle contributes
 * one letter, because "@raghavtandon" has no second word and "RA" reads as
 * an abbreviation of something rather than as initials.
 */
export function initials(displayName, username) {
  const source = String(displayName || '').trim();
  const seg = (s) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)]
    .map((g) => g.segment);

  if (source) {
    const words = source.split(/[\s._-]+/).filter(Boolean);
    const letters = words.slice(0, 2).map((w) => seg(w)[0] || '');
    if (letters.join('')) return letters.join('').toUpperCase();
  }
  const u = String(username || '').replace(/^@/, '').trim();
  return (seg(u)[0] || '·').toUpperCase();
}

/**
 * The avatar slot, whether or not there is a photograph in it.
 *
 * `size` is the rendered edge in CSS pixels and is also what the avatar
 * route is asked for, so the image is never scaled up from a smaller file.
 */
export function avatarPlate(person, { size = 112, className = '', alt = null } = {}) {
  const cls = `${className} avatar-plate`.trim();

  if (person?.avatar_key) {
    // A photograph of a person is not decoration: it is who the page is
    // about, so it carries real alternative text.
    const name = person.display_name || (person.username ? '@' + person.username : 'this reader');
    return `<img class="${esc(cls)}" src="/avatar/${esc(person.avatar_key)}/${size <= 128 ? 256 : 512}"
                 alt="${esc(alt ?? name)}" width="${size}" height="${size}"
                 loading="lazy" decoding="async">`;
  }

  const mark = initials(person?.display_name, person?.username);
  const tint = plateTint(person?.username || person?.public_id || person?.id || '');
  // aria-hidden: the name it abbreviates is the very next thing in the
  // document, so announcing "RT" first is noise, not information.
  return `<span class="${esc(cls)} avatar-plate--blank ${tint}" aria-hidden="true"
                ><span class="avatar-plate-mark">${esc(mark)}</span></span>`;
}

// ── "THE STAMP" (§08) ────────────────────────────────────
export function stamp(status, { date, page, seed, animate = false } = {}) {
  if (!status) return '';
  const rot = stampRotation(seed);
  const parts = [status];
  if (status === 'ABANDONED' && page != null) parts.push(`AT PAGE ${page}`);
  else if (date) parts.push(String(date).slice(0, 10));

  return `<span class="stamp stamp-${esc(status)}${animate ? ' stamp-press' : ''} ${rotClass(rot)}">${esc(parts.join(' · '))}</span>`;
}

// ── RATING (§2) ──────────────────────────────────────────
// Stars, never a colour. Unrated renders NOTHING — no placeholder, no dash,
// no gray blob. An absent rating reads as absent.
/**
 * A rotation, as a class rather than as a style attribute.
 *
 * The jitter exists so a stack of stamps reads as hand-applied rather than
 * printed. Twelve buckets of a quarter-degree preserve that completely, and
 * they can live in the stylesheet — where a style ATTRIBUTE cannot, because
 * a nonce attaches to a <style> element and never to an attribute. This
 * file's own comment says so forty lines down; three generated attributes
 * had slipped past it, and every one of them would have been dropped the
 * day MARGIN_CSP=enforce is switched on.
 */
export const ROT_STEPS = 12;
export const rotClass = (deg) => {
  const d = Math.max(0, Math.min(3, Number(deg) || 0));
  return `rot-${Math.round((d / 3) * ROT_STEPS)}`;
};


// ── B6 — formats that have no pages ──────────────────────
// The counter swaps its input mode on positionType. Everything else about
// it is identical.
const POSITION_LABELS = {
  page: 'PAGE',
  percent: 'PERCENT',
  minute: 'TIME',
  location: 'LOC'
};

export const positionLabel = (type) => POSITION_LABELS[type] || 'PAGE';

export function formatPosition(value, type) {
  if (value == null) return '';
  const n = Number(value);
  if (type === 'minute') {
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return `${h}H ${String(m).padStart(2, '0')}M`;
  }
  return String(Math.round(n));
}

// How a position reads in full, e.g. "P.247 OF 416" or "4H 07M OF 11H 32M".
export function positionDisplay(value, total, type) {
  if (value == null) return 'DATE UNRECORDED';
  const v = formatPosition(value, type);
  const t = total != null ? formatPosition(total, type) : null;
  const prefix = type === 'page' ? 'P.' : type === 'location' ? 'LOC ' : '';
  const suffix = type === 'percent' ? '%' : '';
  return t
    ? `${prefix}${v}${suffix} OF ${t}${suffix}`
    : `${prefix}${v}${suffix}`;
}

// "MARCH 12" — a date compact enough to sit on a status line.
/**
 * How long since something happened, as a phrase.
 *
 * "LAST LOGGED 1 DAYS AGO" is the kind of mistake that makes a careful
 * interface look careless, and it was in two templates because each of them
 * built the phrase itself.
 */
export function sinceLabel(days, { verb = 'LOGGED' } = {}) {
  if (days == null) return null;
  if (days === 0) return `${verb} TODAY`;
  if (days === 1) return `${verb} YESTERDAY`;
  return `LAST ${verb} ${days} DAYS AGO`;
}

export function monthDay(d) {
  if (!d) return '';
  const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleDateString('en-GB', { month: 'long', day: 'numeric', timeZone: 'UTC' }).toUpperCase();
}

/**
 * The title without its subtitle, for places that get one line.
 *
 * "The Hundred Years' War on Palestine: A History of Settler Colonialism
 * and Resistance, 1917-2017" is four lines in a 300px rail and one line as
 * far as anybody thinks of the book. The full title stays everywhere it has
 * room — the book page, the line sheet, search.
 */
export function shortTitle(title, { max = 42 } = {}) {
  const t = String(title ?? '').trim();
  if (t.length <= max) return t;

  const cut = t.split(/:\s|\s[—–]\s/)[0].trim();
  return cut.length >= 4 ? cut : t;
}

/**
 * A stored label, set as a heading rather than as a manifest line.
 *
 * Shelf names arrive from two places: the three system shelves are written
 * in caps (READING, FINISHED, WAITING) and anything a reader creates is
 * whatever they typed. Section headings are sentence case now, so a name
 * that is ALL CAPS gets lowered and a name the reader cased themselves is
 * left exactly as they cased it — "TBR" and "DNF" stay, because a word with
 * no lowercase letters in it and no vowels is an abbreviation, not shouting.
 */
export function sentence(label) {
  const s = String(label ?? '').trim();
  if (!s) return '';
  if (s !== s.toUpperCase()) return s;          // the reader cased it; leave it

  return s.replace(/\S+/g, (word) => {
    const letters = word.replace(/[^\p{L}]/gu, '');
    if (letters.length <= 1) return word;          // "I", "A"
    if (!/[AEIOU]/.test(letters)) return word;     // TBR, DNF, NYRB
    if (/[./]/.test(word)) return word;            // A/W, U.S., N.Y.
    return word.toLowerCase();
  }).replace(/^\p{L}/u, (c) => c.toUpperCase());
}

/** "Wednesday 26 August" — the masthead date. */
export const longDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

export const fmt = {
  longDate,
  isbn: formatISBN,
  date: (d) => (d ? String(d).slice(0, 10) : ''),
  position: formatPosition,
  // §10 — machine-plain. No exclamation marks anywhere in the product.
  // §1.5 — no value that computes to zero is displayed as a number.
  int: (n) => (n == null || n === 0 ? '' : Number(n).toLocaleString('en-GB')),
  stars: starText
};

// ── §13.1 — server-rendered dynamic CSS ──────────────────
// A nonce can be attached to a <style> ELEMENT but never to a style
// ATTRIBUTE, so a strict policy has no way to permit `style="width:42%"`.
// Genuinely computed values are pushed onto res.locals.styleRules during
// render and emitted, once, in a nonced block by partials/foot.ejs. That
// keeps them server-rendered — no flash of unstyled bars, no dependency on
// JavaScript having run.

// Everything reaching a stylesheet is bounded to a shape that cannot escape
// its declaration. A spine colour comes out of the database, and `red;}
// body{display:none` would otherwise be a stylesheet injection.
const cssLength = (v, unit = 'px') => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.max(0, Math.min(100000, n))}${unit}` : '0';
};

const cssColor = (v) => {
  const s = String(v ?? '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^rgba?\([\d\s.,%/]+\)$/i.test(s)) return s;
  if (/^var\(--[a-z0-9-]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return 'transparent';
};

export const css = {
  px: (v) => cssLength(v, 'px'),
  pct: (v) => cssLength(v, '%'),
  color: cssColor,
  // A selector is built here rather than accepted from a caller, so an id
  // derived from data cannot introduce one of its own.
  id: (prefix, key) => `${prefix}-${String(key).replace(/[^A-Za-z0-9_-]/g, '')}`
};

/** Push one rule. Returns the id so the element can carry it. */
export function rule(sheet, prefix, key, declarations) {
  const id = css.id(prefix, key);
  if (declarations) sheet.push(`#${id}{${declarations}}`);
  return id;
}

// ── THE COLOUR SYSTEM ────────────────────────────────────
//
// Four states, three of which are drawn and one of which is drawn as its own
// absence. The class carries the treatment and the nonce rule carries only
// the hex, so a page with nine bands generates at most nine declarations and
// no inline style attribute — which is the CSP rule, not a preference.

export const bandClass = (b) => {
  if (!b || !b.hex || b.source === 'none') return 'band band--none';
  if (b.source === 'provisional') return 'band band--provisional';
  return 'band';
};

/**
 * What a screen reader is told about a strip.
 *
 * §05: the emotion word ships alongside every swatch in every view, so
 * colour never carries meaning alone. On a strip the swatches have no room
 * for type, which makes this label the only place the words appear — it is
 * load-bearing rather than decorative, and an unassigned band says so
 * instead of being silently skipped.
 */
export function stripLabel(list = []) {
  if (!list.length) return 'No books';
  const named = list.map((b) => b?.emotion || 'unassigned');
  const n = list.length;
  return `${n} ${n === 1 ? 'book' : 'books'}, in the order they were finished: ` +
         named.join(', ');
}

/**
 * A section heading short enough to sit on one line.
 *
 * Wikipedia headings are two or three words. An open-access article title is
 * not — "Criticism: The ways of forming possible worlds of literary text
 * characters: a cognitive..." wrapped to two lines and pushed one panel's
 * source line below every other panel's on the page. The prefix is what
 * identifies the class; the rest of the title is on the DOI.
 */
export function shortSection(section, max = 34) {
  const s = String(section || '').trim();
  if (!s) return '';
  const body = s.startsWith('Criticism: ') ? `Criticism: ${s.slice(11)}` : s;
  const out = body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
  return out.toUpperCase();
}

/**
 * A cited span with its own quotation marks removed.
 *
 * The evidence is copied verbatim from a source, and a source often puts the
 * sentence in quotes already. Rendered inside a <q>, which supplies its own,
 * every citation came out doubled: ""Humbert is every man who is driven by
 * desire…"". Strip the outer pair and let the element do it.
 */
export function unquote(text) {
  let s = String(text || '').trim();
  // Repeat, because a quoted quotation nests: "\u201cx\u201d".
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^["\u201c\u201d'\u2018\u2019]+/, '').replace(/["\u201c\u201d'\u2018\u2019]+$/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}
