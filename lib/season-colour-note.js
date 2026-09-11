import { all } from '../db/index.js';
import { PALETTE, colourOf } from './palette.js';
import * as OK from './oklab.js';

// ── THE SEASON, READ ACROSS ──────────────────────────────
//
// What a season's colours say about it, arithmetically.
//
// This replaces a note built from the composition histories, which could
// only ever be about publishing conditions — deadlines, illness, debt,
// geography — so every season came out as a story about how authors worked
// rather than about what was read. It also produced notes that contradicted
// themselves: A/W 23 opened on "writers who wrote fast under pressure" and
// then cited Conrad waiting eight years, which is the counterexample. That
// is what happens when a thesis is written first and evidence is bent to
// fit it.
//
// Every observation below traces to arithmetic over the season's own
// weights. What changed after the first version is WHICH arithmetic.
//
// v1 counted heaviest components only, and produced statistics rather than
// observations: "two of the seven carry dread as their heaviest component"
// is barely a pattern at that ratio, and it put the machinery on the page.
// A reader should not have to know what a component is.
//
// So this reads the whole profile. Seven books at two or three weighted
// feelings each is around twenty data points, and the SHAPE of that
// distribution supports things a single count cannot: what runs through a
// season without ever dominating it, what always arrives in company, what is
// missing from a set of feelings that otherwise sit together.
//
// There is no model in this path at all. A generator is what invents a
// thesis, and removing it removes the failure rather than validating
// against it.

/**
 * What every season, together, is made of.
 *
 * Without this a note can only report a season against itself, and every
 * season then opens on whichever feeling happens to be largest — which
 * across this library is grief or dread almost every time, because that is
 * what criticism writes about (§12). Five seasons in a row led on the same
 * two feelings and read as the same season five times.
 *
 * Measured against the baseline they are not alike at all: S/S 25 carries
 * six times the library's melancholy, S/S 23 four times its desolation,
 * A/W 22 three and a half times its grief. A season is interesting for what
 * it has MORE of than the others, and that is a different sentence every
 * time.
 */
export function libraryBaseline(userId) {
  if (!userId) return null;
  const rows = all(`
    SELECT DISTINCT w.id, w.colour_components
      FROM season_frames sf
      JOIN seasons s ON s.id = sf.season_id
      JOIN works w ON w.id = sf.work_id
     WHERE s.user_id = ? AND sf.hidden = 0 AND w.colour_components IS NOT NULL`, userId);

  const mass = new Map();
  let total = 0;
  for (const r of rows) {
    let comps = [];
    try { comps = JSON.parse(r.colour_components) || []; } catch { continue; }
    for (const c of comps) {
      mass.set(c.id, (mass.get(c.id) || 0) + c.weight);
      total += c.weight;
    }
  }
  if (!total) return null;

  const out = new Map();
  for (const [id, m] of mass) out.set(id, m / total);
  return out;
}

const n = (k) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
                  'eight', 'nine', 'ten', 'eleven', 'twelve'][k] ?? String(k);

/** Sentence-case, so a note can open on an emotion without shouting. */
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

/**
 * The facts, before any of them is phrased.
 *
 * `frames` is the season's books; each carries `colour` from
 * lib/book-colour.js. Hatched books are counted and then excluded — a note
 * that spoke for books it has no colour for would be speaking for silence.
 */
export function observationsOf(frames = [], { baseline = null } = {}) {
  const all = frames.filter((f) => f && !f.hidden);
  const coloured = all.filter((f) => f.colour?.source === 'derived' && f.colour.components?.length);

  const facts = {
    total: all.length,
    spokenFor: coloured.length,
    hatched: all.length - coloured.length,
    enough: coloured.length >= 3
  };
  if (!facts.enough) return facts;

  // ── THE DISTRIBUTION ───────────────────────────────────
  // Weight summed across every book, not just where a feeling led. A feeling
  // carried at a third in five books is a bigger presence in a season than
  // one carried outright in two, and only the totals can see that.
  const mass = new Map();
  const inBooks = new Map();
  const leads = new Map();

  for (const f of coloured) {
    f.colour.components.forEach((c, i) => {
      mass.set(c.id, (mass.get(c.id) || 0) + c.weight);
      if (!inBooks.has(c.id)) inBooks.set(c.id, []);
      inBooks.get(c.id).push(f.title);
      if (i === 0) leads.set(c.id, (leads.get(c.id) || 0) + 1);
    });
  }

  const totalMass = [...mass.values()].reduce((a, b) => a + b, 0) || 1;
  facts.profile = [...mass.entries()]
    .map(([id, m]) => ({
      id,
      emotion: colourOf(id).emotion,
      valence: colourOf(id).valence,
      share: m / totalMass,
      books: inBooks.get(id).length,
      titles: inBooks.get(id),
      leads: leads.get(id) || 0
    }))
    .sort((a, b) => b.share - a.share);

  facts.present = new Set(facts.profile.map((p) => p.id));
  facts.distinct = facts.profile.length;

  // ── DISTINCTIVENESS ────────────────────────────────────
  // How much more of a feeling this season holds than the library does.
  // A season is interesting for what sets it apart, and grief being large
  // everywhere makes grief being large here unremarkable.
  if (baseline) {
    for (const p of facts.profile) {
      const base = baseline.get(p.id) || 0;
      p.lift = base > 0 ? p.share / base : (p.share > 0 ? Infinity : 0);
    }
    // Enough presence to be a real feature, then the biggest departure.
    facts.distinctive = [...facts.profile]
      .filter((p) => p.books >= 2 && p.share >= 0.10 && p.lift >= 1.8)
      .sort((a, b) => b.lift - a.lift)[0] || null;
  }

  // ── SHAPE 1: something runs through it ─────────────────
  const half = Math.ceil(coloured.length / 2);
  facts.running = facts.profile.find((p) => p.books >= half && p.share >= 0.18) || null;

  // ── SHAPE 2: two that keep arriving together ───────────
  facts.pairing = null;
  for (const a of facts.profile) {
    for (const b of facts.profile) {
      if (a.id >= b.id) continue;
      const together = coloured.filter((f) => {
        const ids = f.colour.components.map((c) => c.id);
        return ids.includes(a.id) && ids.includes(b.id);
      });
      if (together.length < 2) continue;
      // Only a pairing if they mostly travel together rather than merely
      // both being common.
      const loyalty = together.length / Math.min(a.books, b.books);
      if (loyalty >= 0.75 && (!facts.pairing || together.length > facts.pairing.count)) {
        facts.pairing = { a, b, count: together.length, titles: together.map((f) => f.title) };
      }
    }
  }

  // ── SHAPE 3: nothing holds it together ─────────────────
  // Scattered is simply: nothing recurs. A season where no feeling reaches
  // half the books has no thread through it, whatever its top share happens
  // to be — S/S 26's leader was 22% of one book, which is not a season
  // "about" anything.
  facts.scattered = !facts.running && !facts.profile.some((p) => p.books >= half);

  // ── SHAPE 4: a hole in an otherwise coherent set ───────
  // A feeling absent from every book, sitting perceptually inside the
  // company the season keeps. Only worth saying when the season HAS company
  // — three or more feelings of one valence.
  facts.absent = null;

  // Neighbourhood by VALENCE AND AROUSAL, not by colour distance.
  //
  // Nearest-in-Oklab was wrong and wrong systematically: the centroid of any
  // blend sits near mid-grey, so the nearest absent anchor was almost always
  // a grey neutral, and every season came out reporting "there is no boredom
  // anywhere in it". Boredom is rare in every season, so its absence is a
  // fact about the palette rather than about the reading.
  //
  // A conspicuous absence is a feeling that belongs to the company the
  // season is actually keeping: same valence, same arousal, and at least two
  // of its neighbours present.
  const neighbourhood = new Map();
  for (const p of facts.profile) {
    const c = colourOf(p.id);
    const key = `${c.valence}${c.arousal}`;
    neighbourhood.set(key, (neighbourhood.get(key) || 0) + 1);
  }
  const missing = PALETTE
    .filter((c) => !facts.present.has(c.id))
    .map((c) => ({ ...c, near: neighbourhood.get(`${c.valence}${c.arousal}`) || 0 }))
    .filter((c) => c.near >= 2)
    .sort((a, b) => b.near - a.near);

  if (missing.length) {
    const company = facts.profile.filter((p) => {
      const c = colourOf(p.id);
      return c.valence === missing[0].valence && c.arousal === missing[0].arousal;
    });
    facts.absent = { ...missing[0], company };
  }

  // ── SHAPE 5: a book that shares nothing ────────────────
  facts.outlier = null;
  if (coloured.length >= 4) {
    for (const f of coloured) {
      const mine = new Set(f.colour.components.map((c) => c.id));
      const others = new Set(coloured.filter((g) => g !== f)
        .flatMap((g) => g.colour.components.map((c) => c.id)));
      if (![...mine].some((id) => others.has(id))) {
        facts.outlier = { title: f.title, ids: [...mine] };
        break;
      }
    }
  }

  // Concentration, for the closing sentence.
  facts.topTwoShare = facts.profile.slice(0, 2).reduce((a, p) => a + p.share, 0);
  facts.spread = OK.spread(coloured.map((f) => f.colour.hex));
  facts.paletteSpread = OK.spread(PALETTE.map((c) => c.hex));

  // Kept for the provenance detail, which still lists what led each book.
  facts.heaviest = coloured.map((f) => ({
    title: f.title, id: f.colour.components[0].id,
    weight: f.colour.components[0].weight, section: f.colour.components[0].section
  }));

  return facts;
}

const listTitles = (list, max = 3) => {
  const names = list.map((h) => h.title);
  if (names.length <= max) {
    return names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
      : names[0];
  }
  return `${names.slice(0, max).join(', ')} and ${n(names.length - max)} more`;
};

/**
 * The note.
 *
 * Three to five sentences about what the season was like to read, every one
 * of them traceable to the totals above. One sentence is a caption.
 *
 * BANNED, and there are tests for each: "not X, but Y" and its variants;
 * em-dash asides; the machinery ("component", "weight", "heaviest",
 * "derived"); rhetorical questions; and opening on a number. The first and
 * the last are the same failure in different clothes — a sentence that leads
 * with its arithmetic is a sentence about the arithmetic.
 */
const lower = (s) => String(s || '').toLowerCase();
const books = (k) => `${n(k)} book${k === 1 ? '' : 's'}`;

/** "four of the seven books" / "all five books" — never "three of the three". */
const outOf = (k, total) => (k >= total ? `all ${books(total)}` : `${n(k)} of the ${n(total)} books`);

export function noteFrom(facts) {
  if (!facts?.enough) return null;

  const { profile, spokenFor, running, pairing, scattered, absent, outlier, distinctive } = facts;
  const top = profile[0];

  // The shape sentences and the point are built separately, because the
  // point is the sentence worth keeping. Assembled the other way round it
  // was the first thing the length cap threw away, and three of five seasons
  // ended on a statistic.
  const body = [];

  // ── OPENING ────────────────────────────────────────────
  if (scattered) {
    body.push(
      `Nothing holds this season together. ` +
      `${cap(n(facts.distinct))} different feelings across ${books(spokenFor)}, ` +
      `and ${lower(top.emotion)} is the closest thing to a common thread at ` +
      `${Math.round(top.share * 100)} percent of it.`
    );
  } else if (distinctive && running && distinctive.id === running.id) {
    // Distinctive AND everywhere. One opener carrying both facts, phrased by
    // how far outside the shelf's norm it sits — otherwise every saturated
    // season opens on the same sentence with a different noun in it, which
    // is the recycling this whole rewrite is against.
    const lead = distinctive.lift >= 5
      ? `${cap(running.emotion)} is thicker here than anywhere else on the shelf.`
      : distinctive.lift >= 3
        ? `No other season carries this much ${lower(running.emotion)}.`
        : `${cap(running.emotion)} is the weather of this season.`;
    body.push(
      `${lead} It reaches ${outOf(running.books, spokenFor)} and takes over only ${n(running.leads)}.`
    );
  } else if (distinctive && distinctive.lift >= 2.5) {
    const lead = distinctive.lift >= 4
      ? `${cap(distinctive.emotion)} is concentrated here in a way it is nowhere else.`
      : `${cap(distinctive.emotion)} is thicker here than anywhere else on the shelf.`;
    body.push(
      `${lead} It carries ${Math.round(distinctive.share * 100)} percent of this season across ` +
      `${books(distinctive.books)}.`
    );
  } else if (running && running.leads >= Math.ceil(spokenFor / 2)) {
    body.push(
      `${cap(running.emotion)} takes this season over. ` +
      (running.leads >= running.books
        ? `It leads ${outOf(running.leads, spokenFor)} and appears in no others.`
        : `It leads ${n(running.leads)} of the ${n(spokenFor)} and appears quietly in ${n(running.books - running.leads)} more.`)
    );
  } else if (running) {
    body.push(
      `${cap(running.emotion)} is the weather of this season. ` +
      (running.leads === 0
        ? `It reaches ${outOf(running.books, spokenFor)} and is the strongest feeling in none of them.`
        : `It reaches ${outOf(running.books, spokenFor)} and takes over only ${n(running.leads)}.`)
    );
  } else {
    body.push(
      `${cap(top.emotion)} accounts for more of this season than anything else, ` +
      `about ${Math.round(top.share * 100)} percent of it across ${books(top.books)}.`
    );
  }

  // ── WHAT KEEPS IT COMPANY ──────────────────────────────
  const opened = new Set([running?.id, distinctive?.id, scattered ? top.id : null].filter(Boolean));
  if (pairing) {
    // One sentence, not two. Two spent half the budget on the same
    // observation and crowded out whatever actually distinguished the
    // season, so A/W 22 and A/W 23 came out with an identical skeleton.
    body.push(
      `${cap(pairing.a.emotion)} and ${lower(pairing.b.emotion)} arrive together in ${books(pairing.count)}.`
    );
  } else {
    // Named, never "it": when the opener led on a different feeling, "sits
    // behind it" had no antecedent and S/S 23 read as nonsense.
    const second = profile.find((p) => !opened.has(p.id) && p.books >= 2);
    if (second) {
      body.push(
        `${cap(second.emotion)} follows it through ${books(second.books)}.`
      );
    }
  }

  // ── THE HOLE ───────────────────────────────────────────
  if (absent) {
    body.push(
      `There is no ${lower(absent.emotion)} anywhere in it, ` +
      `though ${absent.company.slice(0, 2).map((p) => lower(p.emotion)).join(' and ')} both recur.`
    );
  }

  // ── THE POINT ──────────────────────────────────────────
  //
  // What the shape amounts to, keyed to the shape actually measured. Not a
  // thesis the books have to fit: a different shape produces a different
  // sentence, and a season with no shape gets the one that says so.
  //
  // This is the line the note went a version without, and it is the
  // difference between a reading and a readout.
  // Chosen by what is most particular to THIS season, so two seasons of the
  // same broad shape do not close on the same sentence. A/W 22 and A/W 23
  // are both saturated and both paired; only one of them has a book that
  // belongs to nothing.
  let point;
  if (scattered) {
    point = `Six months of books that refuse to agree with one another.`;
  } else if (outlier) {
    point = `${outlier.title} belongs to no part of this season.`;
  } else if (pairing) {
    point = `${cap(pairing.a.emotion)} and ${lower(pairing.b.emotion)} are the whole argument of it.`;
  } else if (absent && running) {
    point = `A season that went everywhere near ${lower(absent.emotion)} and never arrived.`;
  } else if (running && running.leads === 0) {
    point = `${cap(running.emotion)} was the room this season was read in, never the thing on the page.`;
  } else if (running) {
    point = `A season lived alongside ${lower(running.emotion)} more than inside it.`;
  } else if (distinctive) {
    point = `No other season on this shelf reads the way this one does.`;
  } else if (facts.topTwoShare > 0.55) {
    point = `Two feelings account for more than half of everything read.`;
  }

  // Four sentences of shape at most, so the point always lands.
  const shape = (body.join(' ').match(/[^.!?]+[.!?]+/g) || []).map((x) => x.trim());
  const kept = shape.slice(0, point ? 4 : 5);
  if (point) kept.push(point);
  return kept.join(' ');
}

/**
 * Where the note came from, in the same register as the colour cards' own
 * provenance line.
 */
export function provenanceOf(facts) {
  if (!facts?.enough) return null;
  const parts = [
    `READ FROM ${n(facts.spokenFor).toUpperCase()} OF ${n(facts.total).toUpperCase()} BOOKS`
  ];
  if (facts.hatched) parts.push(`${n(facts.hatched).toUpperCase()} UNWRITTEN`);
  // The third segment used to read HEAVIEST COMPONENTS ONLY, which stopped
  // being true when the note started reading the whole profile. A citation
  // that describes the wrong method is worse than no citation.
  return parts.join(' · ');
}

/**
 * What to say when there is not enough to say anything.
 *
 * Same house rules as the note itself: numbers spelled, never opening on
 * one, and the sentence states the arithmetic rather than apologising for
 * it. The template had this inline and it came out "2 of these 7 books carry
 * a colour" — numerals, opening on a number, and ungrammatical at one.
 */
export function shortfallOf(facts) {
  if (!facts || facts.enough) return null;
  const { spokenFor, total } = facts;
  if (!total) return null;
  if (!spokenFor) {
    return `None of these ${books(total)} carries a colour yet. ` +
           `A season is not read across until three of them do.`;
  }
  return `Only ${n(spokenFor)} of these ${books(total)} ` +
         `${spokenFor === 1 ? 'carries' : 'carry'} a colour. ` +
         `A season is not read across until three of them do.`;
}

/** Everything a template needs, in one call. */
export function colourNote(frames, { baseline = null } = {}) {
  const facts = observationsOf(frames, { baseline });
  return {
    facts,
    note: noteFrom(facts),
    shortfall: shortfallOf(facts),
    provenance: provenanceOf(facts),
    // The books and components the sentences are counting, so a reader can
    // check the arithmetic rather than take it.
    drawnFrom: facts.enough
      ? facts.heaviest.map((h) => ({
          title: h.title,
          emotion: colourOf(h.id).emotion,
          pct: Math.round(h.weight * 100),
          section: h.section
        }))
      : []
  };
}
