import { privateText } from './crypto.js';
import { visibleReadingSQL, ANONYMOUS } from './visibility.js';
import { get, all } from '../db/index.js';
import * as HIST from './history.js';
import * as SEASONS from './seasons.js';
import { compositionOf, careOf } from './composition.js';
import { colourway, bruiseFor } from './colourway.js';
import { PALETTE } from './palette.js';
import { effective } from './book-colour.js';
import { colourNote, libraryBaseline } from './season-colour-note.js';
import { kindOf } from './colour-evidence.js';

const SOURCE_NAME = {
  interpretive: 'WIKIPEDIA, CRITICAL SECTIONS',
  doaj: 'OPEN-ACCESS CRITICISM',
  blurb: "THE PUBLISHER'S DESCRIPTION",
  plot: 'WIKIPEDIA, PLOT'
};

/** Every distinct source the components were actually drawn from. */
function sourceLabel(colour) {
  if (colour?.source !== 'derived') return null;
  const kinds = [...new Set((colour.components || []).map((c) => kindOf(c.section)))];
  return kinds.map((k) => SOURCE_NAME[k] || k.toUpperCase()).join(' · ');
}
import { creditsFor } from './boards.js';

// ── THE SEASONAL LOOKBOOK ────────────────────────────────
// Ref. AW25–0417–A
//
// §00 — "A lookbook is not a summary. It is a catalogue."
//
// Everything assembled here is a fact the reader's own logging already
// established, a heading a cataloguer published, or a line a person typed
// into a research board. Nothing in this file infers, and nothing in it
// congratulates.
//
// The register is fixed and non-negotiable: flat, declarative, cold, third
// person. §02 — "Never use the second person. Never congratulate." Those
// two rules are enforced by assertion at the bottom of this file, because a
// register is exactly the kind of thing that erodes one helpful sentence at
// a time.

// ── ARCHIVE NUMBERS ──────────────────────────────────────
/**
 * §05 — "Archive numbers need a scheme that survives a user reading two
 * hundred books a year."
 *
 *     AW25–0417–A
 *      │    │    └ revision: A, then B after a regeneration, and so on
 *      │    └───── the reader's cumulative book count at the season's close
 *      └────────── the season code
 *
 * The middle field counts BOOKS, not seasons, so it is monotonic and
 * meaningful at any volume: 0417 is the four-hundred-and-seventeenth book
 * this reader finished. Two hundred a year takes twenty-five years to reach
 * four digits, and it degrades gracefully past that rather than colliding.
 */
export function archiveNumber(userId, season, { revision = 0 } = {}) {
  const n = get(
    `SELECT COUNT(*) n FROM readings
      WHERE user_id = ? AND status = 'FINISHED' AND is_draft = 0
        AND finished_at IS NOT NULL AND date(finished_at) <= ?`,
    Number(userId), season.ends_on
  ).n;

  const seq = n < 10_000 ? String(n).padStart(4, '0') : String(n);
  const rev = String.fromCharCode(65 + Math.min(25, revision));
  return `${String(season.code).toUpperCase()}–${seq}–${rev}`;
}

// ── SHOW NOTES ───────────────────────────────────────────
const BANNED = [
  /\byou\b/i, /\byour\b/i, /\byours\b/i, /\byou're\b/i, /\byourself\b/i,
  /\bcongratulat/i, /\bwell done\b/i, /\bamazing\b/i, /\bincredible\b/i,
  /\bgreat job\b/i, /\bkeep it up\b/i, /\bcrushed\b/i, /\bsmashed\b/i,
  /\bjourney\b/i, /!\s*$/m, /\bwrapped\b/i, /\bepic\b/i, /\bgoals\b/i
];

/**
 * §02 — the register is a hard constraint, so it is checked, not trusted.
 *
 * The check is on the HOUSE'S voice. A title quoted verbatim is a proper
 * noun and is not the house speaking: "It opened with Stoner and closed
 * with Call Me By Your Name" is in register, and the naive check threw on
 * it — which took the whole catalogue down with a 500 for any season
 * containing that book. Titles are masked before the rules run.
 */
export function assertRegister(text, { quoting = [] } = {}) {
  let subject = text;
  for (const title of quoting) {
    if (title && title.length > 2) subject = subject.split(title).join(' ');
  }

  for (const rule of BANNED) {
    if (rule.test(subject)) {
      throw new Error(`show notes broke the register: ${rule}`);
    }
  }
  return text;
}

/**
 * §02 — "Fashion houses print roughly eighty words of terse prose before the
 * looks. Generate the season statement in that register — flat, declarative,
 * cold."
 *
 *   > Fourteen books. A winter spent mostly in translation. The collection
 *   > resists resolution.
 *
 * Composed from counts, never from interpretation. Each sentence is either
 * true of the data or absent.
 */
export function showNotes({ looks, season, deadstock }) {
  const s = [];
  const n = looks.length;
  if (!n) return null;

  s.push(`${words(n)} ${n === 1 ? 'book' : 'books'}.`);

  const half = String(season.code).toUpperCase().startsWith('AW') ? 'winter' : 'summer';

  // ── What it opened and closed with ──
  // Naming two books is worth more than any aggregate. It is the only line
  // that could not have been written about a different season, and it is
  // entirely derivable: the run is already in finish order.
  if (n >= 3) {
    const first = looks[0].work.title;
    const last = looks[n - 1].work.title;
    if (first !== last) s.push(`It opened with ${first} and closed with ${last}.`);
  }

  // ── Translation ──
  const translated = looks.filter((l) => l.translated).length;
  if (translated / n > 0.5) s.push(`A ${half} spent mostly in translation.`);
  else if (translated) s.push(`${words(translated)} in translation.`);

  // ── The difficult middle ──
  // §02 wants the season to have "a beginning, a difficult middle, a
  // close". The difficult middle is a fact, not a mood: it is whichever
  // book held on longest while the rest went past.
  const held = looks
    .map((l) => ({ title: l.work.title, days: heldDays(l.reading) }))
    .filter((x) => x.days > 0)
    .sort((a, b) => b.days - a.days);

  if (held.length >= 3 && held[0].days >= held[1].days * 3 && held[0].days >= 30) {
    s.push(`${held[0].title} took ${held[0].days} days; nothing else took more than ${held[1].days}.`);
  }

  // ── Books that were put down and picked back up ──
  // The gap is the most human thing the session log knows.
  const abandonedMidway = looks.filter((l) => wearingOf(l.reading).some((r) => r.kind === 'gap')).length;
  if (abandonedMidway) {
    s.push(abandonedMidway === 1
      ? 'One was set down partway and picked up again.'
      : `${words(abandonedMidway)} were set down partway and picked up again.`);
  }

  // ── Publication spread ──
  const years = looks.map((l) => l.work.first_published_year).filter(Boolean).sort((a, b) => a - b);
  if (years.length >= 3) {
    const spread = years[years.length - 1] - years[0];
    if (spread > 100) s.push(`The oldest is ${years[0]}; the newest ${years[years.length - 1]}.`);
    else if (spread <= 12) s.push(`Nothing published before ${years[0]}.`);
  }

  if (deadstock?.length) {
    s.push(`${words(deadstock.length)} ${deadstock.length === 1 ? 'was' : 'were'} not produced.`);
  }

  const rereads = looks.filter((l) => (l.reading?.pass_number || 1) > 1).length;
  if (rereads) s.push(`${words(rereads)} had been read before.`);

  // ── The close ──
  // Drawn from the shape of the ratings, and declining to draw a conclusion
  // where the data does not support one.
  const stars = looks.map((l) => l.reading?.stars).filter((x) => x != null);
  if (stars.length >= 4) {
    const mean = stars.reduce((a, b) => a + b, 0) / stars.length;
    const spread = Math.max(...stars) - Math.min(...stars);
    if (spread >= 3) s.push('The collection resists resolution.');
    else if (mean >= 4.3) s.push('The season holds together.');
    else if (mean <= 2.6) s.push('A difficult run.');
  }

  // §02 — "roughly eighty words". Longer than that stops being a show note
  // and becomes an essay nobody asked the house to write.
  const out = [];
  let count = 0;
  for (const line of s) {
    const w = line.split(/\s+/).length;
    if (count + w > 85) break;
    out.push(line);
    count += w;
  }

  return assertRegister(out.join(' '), { quoting: looks.map((l) => l.work.title) });
}

const NUMBERS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
  'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
const words = (n) => NUMBERS[n] || String(n);

// ── THE LOOKS ────────────────────────────────────────────
/**
 * §02 — "Runway order is chronological so the season has a shape — a
 * beginning, a difficult middle, a close."
 */
function looksFor(userId, season, { owner, viewer }) {
  const scope = owner ? null : visibleReadingSQL(viewer, { owner: 'u', entry: 'r' });
  const rows = all(
    `SELECT r.*, w.id AS work_id, w.title, w.subtitle, w.first_published_year,
            w.original_language,
            -- The colour system: the nearest anchor, the blend, the name,
            -- and the components — the composition label prints the weights
            -- and the heaviest component's citation, so the row has to carry
            -- them or the label renders a swatch and nothing under it.
            w.colour_id, w.colour_hex, w.colour_name, w.colour_components,
            e.id AS edition_id, e.page_count, e.publisher, e.format AS edition_format,
            e.language, e.cover_url, e.cover_cache_key, e.season_colour, e.published_year,
            (SELECT p.id FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author_id,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM readings r
       JOIN works w ON w.id = r.work_id
       JOIN users u ON u.id = r.user_id
       -- Most readings never named an edition; the catalogue's first one
       -- for the work is what the rest of the product shows, so the
       -- lookbook shows the same object rather than a different one.
       -- The jacket IS the look plate, so the edition chosen is the one that
       -- has artwork. Falling back to the lowest id gives a plate-shaped
       -- hole on most of the season for no reason.
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL),
                         (e2.page_count IS NULL), e2.id LIMIT 1))
      WHERE r.user_id = ? AND r.is_draft = 0 AND r.status = 'FINISHED'
        AND date(r.finished_at) BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM season_frames sf WHERE sf.reading_id = r.id AND sf.season_id = ? AND sf.hidden = 1)
        ${scope ? `AND ${scope.sql}` : ''}
      ORDER BY r.finished_at, r.id`,
    Number(userId), season.starts_on, season.ends_on, season.id, ...(scope?.params || [])
  );

  return rows.map((r, i) => {
    const work = {
      id: r.work_id, title: r.title, subtitle: r.subtitle,
      first_published_year: r.first_published_year, author: r.author, author_id: r.author_id
    };
    const edition = {
      id: r.edition_id, page_count: r.page_count, publisher: r.publisher,
      format: r.edition_format, language: r.language, cover_url: r.cover_url,
      cover_cache_key: r.cover_cache_key, season_colour: r.season_colour,
      published_year: r.published_year, title: r.title
    };

    return {
      n: i + 1,
      of: rows.length,
      work, edition, reading: owner ? r : {
        id: r.id, user_id: r.user_id, work_id: r.work_id, started_at: r.started_at,
        finished_at: r.finished_at, stars: r.stars, pass_number: r.pass_number
      },
      colour: effective(r),
      // Where the evidence came from, in the reader's words rather than the
      // pipeline's. Derived from the sections actually cited, so it never
      // claims a source a component did not use.
      colourSource: sourceLabel(effective(r)),
      // A book whose edition language differs from the work's original is a
      // translation. Where either is unrecorded, no claim is made.
      translated: !!(r.language && r.original_language &&
                     r.language.slice(0, 2).toLowerCase() !== r.original_language.slice(0, 2).toLowerCase()),
      composition: owner ? compositionOf(r.work_id, userId) : compositionOf(r.work_id, null),
      // ── The book as an object with a history ──
      //
      // Where it was written, under what conditions, and how it got into
      // print. Read from the cache only: this is a page render, and it
      // neither fetches Wikipedia nor calls a model on the way to a screen.
      // scripts/histories.mjs fills the cache; a book that has not been
      // through it simply has no plate here.
      history: HIST.cardFor(r.work_id),
      care: careOf(r, edition),
      // Every look, the same plates. There is no hero: a season is not one
      // book and eight also-rans, and the plate that made the difference —
      // the wearing, which is the only one with any character in it — is
      // derivable for all of them.
      wearing: owner ? wearingOf(r) : [],
      marginalia: owner ? marginaliaOf(r) : [],
      held: heldDays(r)
    };
  });
}

// ── THE SEASON, ON ONE LINE ──────────────────────────────
/**
 * Every book of the season on a shared axis, twice.
 *
 * The per-book version of this was three little bands inside each look,
 * comparing when a book was set against when its author lived — and for
 * almost every book two of the three bands were unknown, so it showed one
 * tick and explained nothing. It was a diagram of missing data.
 *
 * A season-wide line has the opposite property: it gets MORE interesting
 * the more books are on it. Two tracks, the same nine books on both:
 *
 *   READ     across the season's own calendar — the rhythm of the months,
 *            where the clusters were and where the silences were
 *   WRITTEN  across the publication span — five centuries in one line, and
 *            which of the books sit at either end
 *
 * Nothing is invented. A book missing a publication year is simply not on
 * the second track, and the track says how many it is drawn from.
 */
export function seasonTimeline(looks, season) {
  const parse = (d) => Date.parse(String(d).replace(' ', 'T'));

  // ── READ: the season's own calendar ──
  const from = parse(season.starts_on);
  const to = parse(season.ends_on);
  const span = Math.max(1, to - from);

  const read = looks
    .filter((l) => l.reading?.finished_at)
    .map((l) => ({
      n: l.n,
      title: l.work.title,
      workId: l.work.id,
      at: String(l.reading.finished_at).slice(0, 10),
      colour: l.colour?.hex || null,
      pct: Math.max(0, Math.min(100, ((parse(l.reading.finished_at) - from) / span) * 100))
    }))
    .sort((a, b) => a.pct - b.pct);

  // ── WRITTEN: the publication span ──
  const dated = looks.filter((l) => l.work.first_published_year);
  const years = dated.map((l) => l.work.first_published_year);
  const lo = years.length ? Math.min(...years) : null;
  const hi = years.length ? Math.max(...years) : null;

  // A single year is a point, not a span, and a line through it says nothing.
  const yearSpan = lo != null && hi > lo ? hi - lo : null;

  const written = yearSpan
    ? dated.map((l) => ({
        n: l.n,
        title: l.work.title,
        workId: l.work.id,
        year: l.work.first_published_year,
        colour: l.colour?.hex || null,
        pct: ((l.work.first_published_year - lo) / yearSpan) * 100
      })).sort((a, b) => a.pct - b.pct)
    : [];

  // Books the second track cannot place. Named rather than silently
  // dropped: "drawn from four of seven" tells you three are missing but not
  // which, and the reason is fixable — the year is a field on the book page.
  const unplaced = yearSpan
    ? looks.filter((l) => !l.work.first_published_year)
        .map((l) => ({ n: l.n, title: l.work.title, workId: l.work.id }))
    : [];

  return {
    read: {
      marks: lanes(read),
      from: String(season.starts_on).slice(0, 10),
      to: String(season.ends_on).slice(0, 10),
      // The month ticks, so the axis is readable as a calendar.
      months: monthsBetween(season.starts_on, season.ends_on, from, span)
    },
    written: written.length >= 3
      ? {
          marks: lanes(written),
          from: lo, to: hi,
          covers: dated.length, of: looks.length,
          unplaced
        }
      : null
  };
}

/**
 * Stack colliding labels instead of letting them print on top of each other.
 *
 * Two books finished in the same week are two marks a pixel apart, and
 * their numbers ran together into "0607" — which reads as one mark with a
 * broken label rather than as two books close in time. The marks keep their
 * true positions; only the labels move, upward, into whichever lane is
 * free.
 *
 * MIN_GAP is in percent of the track, so it holds at any width.
 */
const MIN_GAP = 4.5;
const LANES = 4;

function lanes(marks) {
  const placed = [];

  for (const m of marks) {
    // The lowest lane where nothing is already sitting too close.
    let lane = 0;
    while (lane < LANES
      && placed.some((p) => p.lane === lane && Math.abs(p.pct - m.pct) < MIN_GAP)) {
      lane++;
    }
    const out = { ...m, lane: Math.min(lane, LANES - 1) };
    placed.push(out);
  }
  return placed;
}

function monthsBetween(startsOn, endsOn, from, span) {
  const out = [];
  const d = new Date(String(startsOn).slice(0, 10) + 'T00:00:00');
  const end = new Date(String(endsOn).slice(0, 10) + 'T00:00:00');

  while (d <= end) {
    out.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase(),
      pct: Math.max(0, Math.min(100, ((d.getTime() - from) / span) * 100))
    });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

// ── BACK MATTER ──────────────────────────────────────────
/**
 * §02 — "Deadstock. DNFs. Goodreads treats abandonment as shameful; this
 * puts it on the wall."
 */
function deadstockFor(userId, season) {
  return all(
    `SELECT r.abandoned_page, r.abandoned_at, r.stars, w.title, e.page_count,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM readings r
       JOIN works w ON w.id = r.work_id
       -- The jacket IS the look plate, so the edition chosen is the one that
       -- has artwork. Falling back to the lowest id gives a plate-shaped
       -- hole on most of the season for no reason.
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL),
                         (e2.page_count IS NULL), e2.id LIMIT 1))
      WHERE r.user_id = ? AND r.is_draft = 0 AND r.status = 'ABANDONED'
        AND date(COALESCE(r.abandoned_at, r.finished_at)) BETWEEN ? AND ?
      ORDER BY r.abandoned_at`,
    Number(userId), season.starts_on, season.ends_on
  );
}

/**
 * §02 — "Credits. Authors as designers. Translators as pattern cutters.
 * Cover designer named. Publisher as the house."
 *
 * "Crediting translators and jacket designers is a genuinely good thing
 * competitors don't do, and it costs nothing." It costs nothing because the
 * publisher is already in the catalogue; the translator and the jacket
 * designer are not, and are shown only where somebody has entered them.
 */
function creditsOf(looks) {
  const designers = [];
  const cutters = [];

  for (const l of looks) {
    for (const c of l.edition?.id ? creditsFor(l.edition.id) : []) {
      const row = { name: c.name, title: l.work.title, source: c.source };
      if (c.role === 'translator') cutters.push(row);
      else if (c.role === 'cover_design') designers.push(row);
    }
  }

  return {
    designers: looks.map((l) => ({ name: l.work.author, title: l.work.title }))
      .filter((d) => d.name),
    cutters,
    jackets: designers
  };
}

/**
 * §02 — "The pulp. Lang shredded his own archive and made sculpture from the
 * remains. Take the season's highlights and interleave them into one
 * continuous shredded text object."
 *
 * The source is the reader's own notes, which are private. This is therefore
 * assembled ONLY for the owner and never reaches the public rendering — the
 * caller passes `owner`, and passing it wrongly is the one way this feature
 * could leak a note. The route resolves it from the session, never from the
 * request.
 */
function pulpOf(userId, season, { owner }) {
  if (!owner) return null;

  const notes = all(
    `SELECT r.private_note, r.review, w.title
       FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND r.is_draft = 0
        AND date(r.finished_at) BETWEEN ? AND ?
        AND (r.private_note IS NOT NULL OR r.review IS NOT NULL)
        -- An encrypted note cannot be read here without the key, so it is
        -- excluded rather than spliced in as ciphertext. COALESCE because
        -- rows written before the column existed hold NULL, and NULL = 0
        -- is itself NULL — which silently emptied the whole page.
        AND COALESCE(r.note_encrypted, 0) = 0`,
    Number(userId), season.starts_on, season.ends_on
  );

  const fragments = [];
  for (const n of notes) {
    // A lower bound only. There used to be an upper one of 220 characters,
    // which meant a long sentence was not shortened — it was DROPPED, and a
    // note written in long sentences contributed nothing at all to a page
    // built out of notes. The count is capped further down instead, which
    // limits the page without discarding anybody's writing.
    for (const sentence of String(n.private_note || n.review || '')
      .split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter((x) => x.length > 24)) {
      fragments.push({ text: sentence, from: n.title });
    }
  }
  if (fragments.length < 4) return null;

  // Interleaved deterministically — a stride coprime with the length walks
  // every fragment exactly once and never lands two from the same book in a
  // row where the season has more than two sources.
  const stride = coprimeStride(fragments.length);
  const out = [];
  for (let i = 0, k = 0; i < fragments.length; i++, k = (k + stride) % fragments.length) {
    out.push(fragments[k]);
  }
  return out.slice(0, 40);
}

function coprimeStride(n) {
  for (let s = Math.max(2, Math.floor(n / 3)); s < n; s++) if (gcd(s, n) === 1) return s;
  return 1;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * §02 — "Campaign. One sentence from the season. White on black. Full bleed.
 * No image. This is the share card."
 *
 * It is a sentence the reader wrote, or it is nothing. The one page in the
 * feature that would most benefit from a generated line is the one page
 * where a generated line would be least honest.
 */
function campaignOf(pulp, looks) {
  const candidates = (pulp || [])
    .filter((f) => f.text.length >= 40 && f.text.length <= 120 && !/["“”]/.test(f.text));
  if (candidates.length) {
    // The longest that still fits the plate, so it fills the space.
    return candidates.sort((a, b) => b.text.length - a.text.length)[0];
  }

  // Failing that, nothing — which is what the contract above already said.
  //
  // The fallback here read "Seven books, in the order they were finished."
  // on a page whose whole point is one sentence the reader wrote. It was a
  // count dressed as a campaign line: it said nothing about the season, it
  // could not be wrong, and it filled the one slot in this feature reserved
  // for something only a person can supply. The section is guarded on this
  // returning a value, so no sentence means no page.
  return null;
}

// ── ASSEMBLY ─────────────────────────────────────────────
export function build(userId, code, { owner = false, viewer = ANONYMOUS } = {}) {
  let season = SEASONS.seasonByCode(userId, code);
  if (!season) return null;

  // Cached notes and facts were generated from the owner's full library.
  // Public catalogues derive their copy only from the visible looks.
  if (!owner) season = { ...season, given_title: null, note: null, facts: null, colour_strip: null, note_edited_by_user: 0 };
  const looks = looksFor(userId, season, { owner, viewer });
  const deadstock = owner && get('SELECT deadstock_visible FROM users WHERE id = ?', Number(userId))
    ?.deadstock_visible ? deadstockFor(userId, season) : [];

  const pulp = pulpOf(userId, season, { owner });

  // §01 pins the bruise to the season; the second accent is the season's
  // own dominant colour. It used to be the jacket of whichever book was
  // held longest — atmosphere taken from an object the reader touched,
  // which was a good idea while jackets were the colour source and is a
  // publisher's art direction now that they are not. The book that
  // occupied the season longest still decides ties, so the accent is still
  // the colour the season SPENT most of itself in rather than the one it
  // happened to have most copies of.
  const held = new Map();
  for (const l of looks) {
    if (!l.colour?.id) continue;
    held.set(l.colour.id, (held.get(l.colour.id) || 0) + Math.max(1, heldDays(l.reading)));
  }
  const accentSource = [...held.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const accentColour = accentSource ? PALETTE.find((c) => c.id === accentSource[0]) : null;
  const meta = SEASONS.parseCode(season.code) || {};


  return {
    season,
    meta,
    archive: owner ? archiveNumber(userId, season) : String(season.code).toUpperCase(),
    // §01 pins the bruise to the season. The second accent is the HERO'S
    // OWN jacket, sampled — so a season staged around a book in oxblood
    // cloth is lit by that book rather than by a value from a table. It is
    // atmosphere the reader did not have to write, taken from an object
    // they actually held.
    bruise: bruiseFor(season.code),
    accent: accentColour?.hex || null,
    accentName: accentColour ? accentColour.name : null,
    looks,
    // §02's show note, composed from counts — unless the reader has written
    // their own on the season page, in which case that is the statement and
    // a tally of pages is not. A house prints what the designer said.
    showNotes: season.note_edited_by_user && season.note
      ? season.note
      : showNotes({ looks, season, deadstock }),
    noteIsTheirs: !!(season.note_edited_by_user && season.note),
    colourway: colourway(looks.map((l) => l.colour)),
    // How many books actually carry a colour — the denominator §05's
    // three-assignment floor is measured against, and NOT `looks.length`,
    // which counts books that hatched.
    colouredCount: looks.filter((l) => l.colour?.id).length,
    // §05 — a season where every coloured book came out the same is a real
    // result, and it is said plainly rather than rendered as a one-swatch
    // palette that looks like a bug.
    monochrome: (() => {
      const way = colourway(looks.map((l) => l.colour));
      const n = looks.filter((l) => l.colour?.id).length;
      return way.length === 1 && n >= 3 ? way[0] : null;
    })(),
    timeline: seasonTimeline(looks, season),
    // §02 — the line sheet is the looks again, in the same order, stripped to
    // numbers. It is deliberately the same data twice: a catalogue prints
    // both the plates and the wholesale sheet.
    lineSheet: looks.map((l) => ({
      n: l.n,
      title: l.work.title,
      author: l.work.author,
      yardage: l.edition?.page_count || null,
      acquired: l.reading?.started_at ? String(l.reading.started_at).slice(0, 10) : null,
      completed: l.reading?.finished_at ? String(l.reading.finished_at).slice(0, 10) : null,
      rating: l.reading?.stars ?? null
    })),
    deadstock,
    pulp,
    credits: creditsOf(looks),
    campaign: campaignOf(pulp, looks),
    // The closing note: one paragraph about the season as a whole, drawn
    // from the composition histories rather than from the plots. Read from
    // the cache, like the histories themselves, and absent until the
    // backfill has written one. Absent is a normal state, not a gap to fill
    // with something derivable.
    // ── THE SEASON, READ ACROSS ────────────────────────
    //
    // Built from the derived colours, not from the composition histories.
    //
    // The histories can only say how a book got made — deadlines, illness,
    // debt, geography — so a note drawn from them came out as a story about
    // how authors worked rather than about what was read, and it produced
    // notes that argued with themselves: A/W 23 opened on "writers who wrote
    // fast under pressure" and cited Conrad waiting eight years. Thesis
    // first, evidence bent to fit.
    //
    // The histories still run, on the individual books below, where a claim
    // about how one book was written is exactly the right claim. They are
    // just the wrong input for a season.
    // Against the shelf, not only against itself. Without the baseline every
    // season opens on whatever is largest, and across this library that is
    // grief or dread nearly every time — which is a fact about criticism and
    // not about any of these seasons.
    closingNote: colourNote(
      looks.map((l) => ({ ...l.work, colour: l.colour, hidden: false })),
      // Public text must not depend on the owner's private library, or on
      // any other reader's history. Owners can compare their own seasons.
      { baseline: owner ? libraryBaseline(userId) : null }
    ),
    // How many of the plates are written from a documented record, for the
    // colophon. A catalogue that shows its working says how much of it is
    // sourced and how much is the object described plainly.
    documented: looks.filter((l) => l.history?.kind === 'written').length
  };
}

const heldDays = (r) => {
  const a = r?.started_at, b = r?.finished_at || r?.abandoned_at;
  if (!a || !b) return 0;
  const ms = Date.parse(String(b).replace(' ', 'T')) - Date.parse(String(a).replace(' ', 'T'));
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86_400_000) : 0;
};

// ── THE WEARING ──────────────────────────────────────────
/**
 * The session log as a run of show.
 *
 * The point of this plate is the GAPS. A book set down for eleven days and
 * picked up again is the most interesting thing the log knows, and a chart
 * of cumulative pages hides it completely — the line just goes flat, which
 * reads as no data rather than as a fortnight of not wanting to go back.
 *
 * So the gaps are rows, with the same weight as the sessions around them.
 */
export const GAP_DAYS = 5;

export function wearingOf(reading, { total = null } = {}) {
  // An unsaved reading has no sessions to look up, and a caller holding one
  // should get an empty ledger rather than a bind error that takes the
  // whole catalogue down.
  if (!reading?.id) return [];

  const sessions = all(
    `SELECT position, occurred_at, note FROM sessions
      WHERE reading_id = ? ORDER BY occurred_at, id`,
    reading.id
  );

  const rows = [];
  const day = (d) => String(d || '').slice(0, 10);
  const at = (d) => Date.parse(String(d).replace(' ', 'T'));

  // A gap means SET DOWN, and that is only knowable from session data. An
  // imported reading with a start date and a finish date four months apart
  // and nothing in between is a long read, not a book abandoned midway —
  // claiming otherwise put "eight of nine were set down partway" on a
  // season where nobody had logged a single session.
  const logged = sessions.length > 0;

  if (reading.started_at) {
    rows.push({ kind: 'open', on: day(reading.started_at), text: 'Opened.' });
  }

  let previous = reading.started_at || sessions[0]?.occurred_at;
  for (const s of sessions) {
    const gap = previous ? Math.round((at(s.occurred_at) - at(previous)) / 86_400_000) : 0;
    if (gap >= GAP_DAYS) {
      rows.push({
        kind: 'gap', days: gap,
        on: `${gap} days`,
        text: 'Set down. Not touched.'
      });
    }

    rows.push({
      kind: 'session',
      on: day(s.occurred_at),
      text: s.note
        ? `Page ${s.position}. ${privateText(s.note)}`
        : `Page ${s.position}.`,
      note: !!s.note
    });
    previous = s.occurred_at;
  }

  const end = reading.finished_at || reading.abandoned_at;
  if (end) {
    const trailing = logged && previous ? Math.round((at(end) - at(previous)) / 86_400_000) : 0;
    if (trailing >= GAP_DAYS) {
      rows.push({ kind: 'gap', days: trailing, on: `${trailing} days`, text: 'Set down. Not touched.' });
    }
    rows.push({
      kind: 'close',
      on: day(end),
      text: reading.abandoned_at
        ? `Abandoned${reading.abandoned_page ? ` at page ${reading.abandoned_page}` : ''}. Not produced.`
        : `Closed${reading.stars != null ? `. Grade ${reading.stars}` : ''}.`
    });
  }

  // With no sessions the ledger is two dates, which the spec line already
  // gives. The span between them is still true and still the object's
  // history, so it is stated as a SPAN — how long it was out — and never as
  // a gap, which would be a claim about behaviour nobody recorded.
  if (!logged && rows.length === 2 && reading.started_at && end) {
    const span = Math.round((at(end) - at(reading.started_at)) / 86_400_000);
    if (span >= 1) {
      rows.splice(1, 0, {
        kind: 'span',
        on: `${span} ${span === 1 ? 'day' : 'days'}`,
        text: 'Out of the shelf. No sessions logged.'
      });
    }
  }

  // One row is not a run of show, it is a date.
  return rows.length >= 3 ? rows : [];
}

// ── MARGINALIA ───────────────────────────────────────────
/**
 * What the reader wrote, kept next to where they wrote it.
 *
 * This is the only plate in the feature whose content nobody can derive,
 * and it is the one that gives a look a voice. A note at page 122 is worth
 * more than any amount of composition analysis, because it is the only
 * thing on the page that could not have been written about a different book.
 *
 * It is empty until somebody writes something, and an empty plate is not
 * rendered. It is never filled in with a substitute.
 */
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
             'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "2024-01-20" as "20 JAN", which is what the rest of the plate is set in. */
function monthDayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]}` : null;
}

export function marginaliaOf(reading) {
  if (!reading) return [];

  const out = all(
    `SELECT position, note FROM sessions
      WHERE reading_id = ? AND note IS NOT NULL AND TRIM(note) != ''
      ORDER BY position, occurred_at`,
    reading.id
  ).map((s) => ({ at: `p.${s.position}`, text: privateText(s.note) }));

  // Notes carried in from a Goodreads data export. That file records what
  // was written and the day it was written, but never the page, so these
  // are annotations rather than sessions and they are stamped with the date
  // instead of a position. Inventing a page to make them sort with the rest
  // would put a false mark on the progress bar.
  for (const a of all(
    `SELECT page, body, written_on FROM reading_notes
      WHERE user_id = ? AND work_id = ? ORDER BY written_on, id`,
    reading.user_id, reading.work_id
  )) {
    out.push({ at: a.page ? `p.${a.page}` : monthDayOf(a.written_on), text: privateText(a.body) });
  }

  try {
    for (const m of JSON.parse(reading.marks || '[]') || []) {
      if (typeof m === 'string' && m.trim()) out.push({ at: null, text: m.trim() });
    }
  } catch { /* a malformed marks column is not worth a page */ }

  if (reading.review && reading.review.trim()) {
    out.push({ at: 'closing', text: reading.review.trim() });
  }
  return out;
}
