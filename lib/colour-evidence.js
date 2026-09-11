import { get, run, nowSQL } from '../db/index.js';
import { findArticle, articleSections, RetrievalUnavailable } from './history.js';
import { cachedFor as doajCached, HEADING_PREFIX as DOAJ_PREFIX } from './doaj.js';

// ── THE EVIDENCE LAYER ───────────────────────────────────
//
// The colour is derived from the book. The amendment (§7.3) makes the terms
// of that exact, and this file is where they are enforced before a model is
// ever called:
//
//   The retrieval is not there to jog the model's memory.
//   It is the only permitted source.
//
// So this fetches what a book's article says ABOUT THE BOOK — what happens
// in it, who is in it, what it is doing and how it reads — and hands the
// derivation nothing else. A work with no article, or a thin one, gets no
// colour at all. §05 calls that a legitimate state, and it is roughly a
// third of a general library.
//
// The retrieval itself is `lib/history.js`'s, unchanged: same article
// matcher, same section cutter, same backoff, same `history_sources` cache.
// Only the section list is different — and it is precisely the inverse of
// the composition card's, because the card wants how a book got made and
// this wants what the book is.

/**
 * The sections that carry what a book IS.
 *
 * `history.js` puts every one of these in its UNWANTED list, for the same
 * reason in reverse: a composition history has no business quoting the plot.
 */
const WANTED = [
  'plot', 'plot summary', 'synopsis', 'summary', 'story',
  'themes', 'theme', 'themes and style', 'style and themes', 'motifs',
  'style', 'analysis', 'interpretation', 'criticism and analysis',
  'characters', 'main characters', 'setting', 'structure'
];

/**
 * Everything the article carries that is about something other than the
 * book itself. `reception` is the sharpest of these: it is what critics
 * thought, and a colour derived from reviews is a colour derived from other
 * people's verdicts rather than from the book.
 */
const UNWANTED = [
  'reception', 'critical reception', 'legacy', 'influence', 'adaptations',
  'adaptation', 'in popular culture', 'publication', 'publication history',
  'background', 'composition', 'writing', 'development', 'awards',
  'sequel', 'sequels', 'see also', 'references', 'further reading',
  'external links', 'notes', 'bibliography', 'editions', 'translations'
];

/**
 * The sections that carry INTERPRETATION rather than events.
 *
 * This USED to be a gate: at least one had to resolve or the book hatched.
 * It was measured and reversed, and the reason is worth keeping because the
 * argument for the gate still sounds right.
 *
 * The gate took the run from 67% of the library to 39%. But the number was
 * not the problem — WHICH books it rejected was. Heart of Darkness, White
 * Nights, Do Androids Dream of Electric Sheep? and Lie With Me all hatched,
 * and those are not ambiguous books. They hatched because of how their
 * Wikipedia articles happen to be organised, which is a fact about
 * Wikipedia's editors and not about the books.
 *
 * And the bias is structural rather than random. Articles that stop at a
 * plot summary cluster on shorter, more recent and translated fiction;
 * canonical literature has had decades to accumulate a Themes section. So
 * the gate systematically hatched contemporary and translated work while
 * passing the canon — which would have made every season of an ordinary
 * reader's reading come out hollow in exactly the places they cared most.
 *
 * It is still the list that decides whether a card may cite Plot when
 * something better was on offer, and it is the variable the audit
 * cross-tabulates: if plot-backed cards cluster on a handful of colours
 * while themes-backed ones spread, that is measurable now rather than
 * assumed.
 */
const INTERPRETIVE = [
  'themes', 'theme', 'themes and style', 'style and themes', 'motifs',
  'style', 'analysis', 'interpretation', 'criticism and analysis',
  'characters', 'main characters', 'structure'
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();

export const isInterpretive = (heading) => {
  const n = norm(heading);
  return INTERPRETIVE.some((w) => n === w || n.includes(w));
};

/**
 * How much retrieved prose is enough.
 *
 * 450 is `lib/history.js`'s number, arrived at by reading real articles
 * rather than by picking a round one, and there is no reason for this file
 * to disagree with it about what a stub looks like.
 *
 * 450 characters of Themes is better evidence than 450 of plot summary, and
 * for a while that difference was enforced as a gate. It is now enforced by
 * the validator and the fixtures instead: a plot-only book is eligible, and
 * a plot-only card has to work harder to survive the setting rules.
 */
export const ENOUGH = 450;

export const KIND = 'wikipedia-colour';

// ── SOURCE RANK ──────────────────────────────────────────
//
// Three classes of evidence, best first. The heaviest component must come
// from the best class a book HAS — not from the best class in the abstract,
// or a book with only a blurb could never carry a colour.
//
//   interpretive  Wikipedia Themes, Style, Analysis, Characters
//   blurb         the publisher's own description
//   plot          Wikipedia Plot, Synopsis, Summary
//
// The blurb sits between them for a reason. It is marketing — written to
// sell, hyperbolic and positive-skewed — so it is worse evidence than a
// critic saying what a book is doing. But it is ABOUT the book as a whole,
// where a plot summary is a list of what happens, and what happens is mostly
// where and when. A publisher overstating the tenderness of a novel is
// closer to the truth than a synopsis reciting its geography.
//   doaj          open-access criticism, author-corroborated
//
// DOAJ sits directly under Wikipedia's interpretive sections and above the
// blurb because it IS criticism — a scholar saying what a book is doing —
// and the only thing separating it from a Themes section is that a Themes
// section was written about the book and an abstract was written about a
// paper about the book. That gap is real, which is why it ranks second and
// not first, and it is what the prompt's §7.3 rule has to police.
export const RANKS = ['interpretive', 'doaj', 'blurb', 'plot'];

export const BLURB_HEADING = 'Publisher description';

export const kindOf = (heading) => {
  const h = String(heading || '');
  if (h.startsWith(DOAJ_PREFIX)) return 'doaj';
  if (h.toLowerCase() === BLURB_HEADING.toLowerCase()) return 'blurb';
  return isInterpretive(h) ? 'interpretive' : 'plot';
};

/** The best class of evidence this book actually has. */
export const bestRank = (sections) => {
  for (const rank of RANKS) {
    if ((sections || []).some((s) => kindOf(s.heading) === rank)) return rank;
  }
  return null;
};

/**
 * Is what we retrieved good enough to derive from?
 *
 * Returns the reason when it is not, because "no colour" is a state the
 * book page explains rather than an error it swallows.
 */
export function eligibility(sections, { article = undefined } = {}) {
  const list = sections || [];
  if (!list.length) {
    // Two different failures that used to report as one. "No article" is a
    // catalogue problem — a misspelled title, a book too obscure to have one
    // — and is sometimes fixable. "An article with nothing usable in it" is
    // a book nobody has written about analytically, and is not. Telling them
    // apart is the difference between a list worth working through and a
    // number to shrug at.
    // Both messages predate the blurb being a source, and "no article found"
    // now reads as though Wikipedia were the only place we looked.
    if (article === null) return { ok: false, reason: 'no article and no description' };
    return { ok: false, reason: 'nothing about the book in either source' };
  }

  const interpretive = list.filter((s) => isInterpretive(s.heading));
  const total = list.reduce((n, s) => n + s.text.length, 0);

  // Length over any resolved section. Plot-only is eligible — see the note
  // on INTERPRETIVE for why the gate came off — but it is reported, because
  // plot-only evidence is precisely where setting-as-emotion breeds and the
  // audit needs to know which cards came from where.
  if (total < ENOUGH) {
    return { ok: false, reason: `thin (${total} characters, want ${ENOUGH})`, total };
  }
  return {
    ok: true,
    total,
    interpretive: interpretive.map((s) => s.heading),
    plotOnly: !interpretive.length
  };
}

/**
 * Retrieve the evidence for one work.
 *
 * Deliberately separate from deriving a colour out of it: retrieval is
 * network-bound, rate-limited and cacheable, and derivation is neither. A
 * `RetrievalUnavailable` here propagates rather than being swallowed — a
 * throttled fetch read as "this book has no article" would hatch a third of
 * a library for entirely the wrong reason, which is the single most
 * expensive mistake available in this file.
 */
export async function retrieve(workId, { force = false } = {}) {
  const work = get(
    `SELECT w.id, w.title,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM works w WHERE w.id = ?`,
    Number(workId)
  );
  if (!work) return null;

  if (!force) {
    const cached = cachedFor(workId);
    if (cached) return cached;
  }

  const article = await findArticle(work.title, work.author);
  if (!article) return { sections: [], article: null, cached: false };

  // No lead. Wikipedia's opening paragraph is a one-paragraph précis that
  // names the genre, the setting and the year — it is the single densest
  // patch of setting language in the article, and handing it to a model
  // asked for an emotion is handing it the cliché ready-made. The
  // composition card wants the lead for exactly the facts this one must not
  // have.
  const sections = await articleSections(article.articleTitle, {
    wanted: WANTED, unwanted: UNWANTED, lead: false, max: 6
  });

  const out = {
    article: article.articleTitle,
    sections: sections || [],
    cached: false
  };
  cache(workId, out);
  return out;
}

/**
 * The publisher's description, as a section.
 *
 * Wikipedia analysis sections exist for canonical literature and almost
 * nothing else, so a pipeline resting on them alone has a structural gap
 * that skews against contemporary, translated, genre and nonfiction work —
 * 27 of 411 books, and not a random 27. The blurb is populated for 271 of
 * 411 and is the only per-work prose the catalogue holds for most of them.
 *
 * It is held to the same discipline as everything else: a verbatim span, a
 * named source, the same grounding and the same setting rules. What differs
 * is what it is damped by — see the blurb table in lib/emotion-fields.js.
 */
export function blurbSection(workId) {
  const row = get('SELECT blurb, blurb_source FROM works WHERE id = ?', Number(workId));
  const text = String(row?.blurb || '').trim();
  if (text.length < 200) return null;
  return { heading: BLURB_HEADING, text, kind: 'blurb', origin: row.blurb_source || 'publisher' };
}

/** Everything a book can be derived from, best class first. */
export function evidenceFor(workId, { retrieved = null } = {}) {
  const wiki = retrieved || cachedFor(workId) || { sections: [], article: null };
  const sections = [...(wiki.sections || [])];

  for (const a of doajCached(workId) || []) sections.push(a);

  const blurb = blurbSection(workId);
  if (blurb) sections.push(blurb);

  const rank = (s) => RANKS.indexOf(kindOf(s.heading));
  sections.sort((a, b) => rank(a) - rank(b));

  return { article: wiki.article, sections, best: bestRank(sections) };
}

const REF = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;

/**
 * One row per work, under our own kind, so the composition card's cached
 * sources are untouched — `history_sources` is keyed on (work_id, kind) and
 * both features can hold the same article for different reasons.
 */
function cache(workId, { article, sections }) {
  if (!sections?.length) return;
  const body = sections.map((s) => `== ${s.heading} ==\n${s.text}`).join('\n\n');
  run(
    `INSERT INTO history_sources (work_id, kind, ref, title, text, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (work_id, kind) DO UPDATE SET
       ref = excluded.ref, title = excluded.title,
       text = excluded.text, fetched_at = excluded.fetched_at`,
    Number(workId), KIND, REF(article), article, body, nowSQL()
  );
}

/** Read the cache back into the same shape `retrieve` returns. */
export function cachedFor(workId) {
  const row = get('SELECT * FROM history_sources WHERE work_id = ? AND kind = ?',
                  Number(workId), KIND);
  if (!row) return null;
  return { article: row.title, sections: parseSections(row.text), cached: true };
}

export function parseSections(text) {
  const out = [];
  for (const block of String(text || '').split(/\n(?===\s)/)) {
    const m = /^==\s*(.+?)\s*==\n([\s\S]*)$/.exec(block.trim());
    if (m && m[2].trim()) out.push({ heading: m[1], text: m[2].trim() });
  }
  return out;
}

export { RetrievalUnavailable };
