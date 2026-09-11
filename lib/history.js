import { get, all, run, nowSQL } from '../db/index.js';

// ── COMPOSITION HISTORY: RETRIEVAL ───────────────────────
//
// A book as an object with a history: where the author physically was, what
// was happening around them, what they were reacting against, and how the
// thing got into print.
//
// The accuracy risk is the whole problem. A model asked for this from
// memory will produce plausible cities, confident dates and invented print
// runs, and it will do it in the same flat register as the true ones, so
// nothing on the page will look wrong. This file exists so that no sentence
// is ever written from memory: it goes and fetches the documented record
// first, and what it fetches is what gets passed to the model.
//
// Where the record does not exist — which is most contemporary and genre
// fiction — nothing is generated at all. The fallback is a shorter card
// built from material facts the catalogue can prove. A thin true card is
// better than a rich invented one.

const UA = 'MARGIN/0.5 (a personal reading log; contact: local install)';
const TIMEOUT_MS = 9000;

// Wikipedia's guidance for unauthenticated clients is serial requests at
// about one a second. 320ms was three times too fast and earned a 429 part
// way through the first real run.
const PAUSE_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thrown when the source could not be reached, as opposed to having nothing
 * to say.
 *
 * The distinction is the whole point. A 429 read as "no article found" marks
 * a book with a well documented history as `thin`, writes that verdict to
 * the cache, and produces a lookbook where the flag is confidently wrong —
 * which is the same class of silent error the retrieval exists to prevent,
 * arriving through the back door.
 */
export class RetrievalUnavailable extends Error {
  constructor(status) {
    super(`the source is not answering (${status})`);
    this.name = 'RetrievalUnavailable';
    this.status = status;
  }
}

async function json(url, { attempt = 0 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: controller.signal
    });
  } catch {
    // A network error is also "could not reach", not "nothing there".
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return json(url, { attempt: attempt + 1 }); }
    throw new RetrievalUnavailable('network');
  } finally {
    clearTimeout(timer);
  }

  // Rate limited or broken upstream: back off and try again, honouring
  // Retry-After when it is offered.
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1));
      return json(url, { attempt: attempt + 1 });
    }
    throw new RetrievalUnavailable(res.status);
  }

  // A genuine 404 means the page is not there, which IS an answer.
  if (!res.ok) return null;

  try {
    return await res.json();
  } catch {
    throw new RetrievalUnavailable('unreadable');
  }
}

// ── The sections worth having ────────────────────────────
//
// A Wikipedia article on a novel usually carries its composition history
// under one of a small set of headings. Plot and Reception are explicitly
// NOT among them: the brief bans plot summary and evaluation, and the
// cheapest way to keep both out of the copy is to keep them out of the
// evidence.
const WANTED = [
  'background', 'composition', 'writing', 'writing and publication',
  'development', 'publication', 'publication history', 'production',
  'history', 'origins', 'genesis', 'conception', 'inspiration',
  'creation', 'censorship', 'translation', 'reception and censorship'
];

const UNWANTED = [
  'plot', 'synopsis', 'summary', 'characters', 'reception', 'legacy',
  'adaptations', 'adaptation', 'in popular culture', 'see also',
  'references', 'further reading', 'external links', 'notes', 'awards',
  'sequel', 'themes', 'analysis', 'style', 'critical'
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();

/**
 * Find the article for a specific book, not for its author and not for the
 * film of it.
 *
 * The search is deliberately narrow. A loose match is how a card about the
 * wrong book gets written in beautiful type, which is the exact failure this
 * whole file is built to avoid.
 */
export async function findArticle(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''} novel`.trim());
  const data = await json(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}` +
    `&srlimit=5&format=json&origin=*`
  );
  await sleep(PAUSE_MS);
  if (!data?.query?.search?.length) return null;

  const wantTitle = norm(title);
  for (const hit of data.query.search) {
    const t = norm(hit.title);
    // The article title has to actually contain the book's title, allowing
    // for the "(novel)" disambiguator. Anything looser matches essays about
    // the author, or the film, or a different book in the series.
    if (t === wantTitle || t.startsWith(wantTitle + ' ') || t === `${wantTitle} novel`) {
      return { pageId: hit.pageid, articleTitle: hit.title };
    }
  }
  return null;
}

/** The article's sections, filtered to the ones that carry a history. */
export const articleHistory = (articleTitle) =>
  articleSections(articleTitle, { wanted: WANTED, unwanted: UNWANTED, lead: true });

/**
 * One article, cut into the sections a caller asked for.
 *
 * Generic because there are now two callers wanting opposite halves of the
 * same article: the composition card wants Background and Publication and
 * bans Plot and Themes, and `lib/colour-evidence.js` wants exactly what the
 * card bans. Splitting this out is the alternative to a second copy of the
 * heading matcher, the extract fetch and the backoff — and the backoff in
 * particular is not a thing to have two of.
 */
export async function articleSections(articleTitle, { wanted: WANT, unwanted: SKIP,
                                                      lead = true, max = 5 } = {}) {
  const t = encodeURIComponent(articleTitle);

  const parsed = await json(
    `https://en.wikipedia.org/w/api.php?action=parse&page=${t}&prop=sections&format=json&origin=*`
  );
  await sleep(PAUSE_MS);
  if (!parsed?.parse?.sections) return null;

  const wanted = parsed.parse.sections.filter((s) => {
    const n = norm(s.line);
    if (SKIP.some((u) => n === u || n.startsWith(u + ' '))) return false;
    return WANT.some((w) => n === w || n.includes(w));
  });
  if (!wanted.length) return null;

  // One call carries the whole article as plaintext; the sections are cut
  // out of it locally rather than fetched one at a time.
  const page = await json(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1` +
    `&titles=${t}&format=json&origin=*`
  );
  await sleep(PAUSE_MS);

  const pages = page?.query?.pages;
  const extract = pages ? Object.values(pages)[0]?.extract : null;
  if (!extract) return null;

  const out = [];

  // The lead, always.
  //
  // Wikipedia's opening paragraphs carry the house, the city and the year of
  // first publication almost without exception, and none of that is under a
  // heading — so retrieving only the matched sections left the evidence
  // missing the very facts the card most wants. Worse, it made the grounding
  // check punish the truth: a card correctly saying Olympia Press published
  // Lolita in Paris was rejected because "Paris" appeared in the article's
  // first sentence rather than in the section called Publication.
  if (lead) {
    const opening = leadOf(extract);
    if (opening && opening.length > 80) out.push({ heading: 'Lead', text: opening });
  }

  for (const section of wanted.slice(0, max)) {
    const body = sectionOf(extract, section.line);
    if (body && body.length > 120) out.push({ heading: section.line, text: body });
  }
  return out.length ? out : null;
}

/** Everything before the first heading. */
function leadOf(extract) {
  const lines = String(extract).split('\n');
  const end = lines.findIndex((l) => /^=+\s*.+?\s*=+$/.test(l.trim()));
  return lines.slice(0, end === -1 ? lines.length : end).join('\n').trim();
}

/**
 * Cut one section out of a plaintext extract by its heading.
 *
 * Subsections come with it, EXCEPT the unwanted ones. Do Androids Dream of
 * Electric Sheep? files "Adaptations" as a child of "Influence and
 * inspiration", so taking the parent whole dragged Blade Runner, Ridley
 * Scott and a BBC radio play into evidence that was supposed to be about
 * how the book got written — and the model, correctly, could not find a
 * composition history in it.
 */
function sectionOf(extract, heading) {
  const lines = String(extract).split('\n');
  const want = norm(heading);

  let start = -1;
  let depth = 0;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = /^(=+)\s*(.+?)\s*=+$/.exec(lines[i].trim());
    if (!m) continue;
    if (start === -1 && norm(m[2]) === want) { start = i + 1; depth = m[1].length; continue; }
    // The next heading at the same level or higher ends the section.
    if (start !== -1 && m[1].length <= depth) { end = i; break; }
  }
  if (start === -1) return null;

  // Drop any unwanted subsection nested inside what was taken.
  const kept = [];
  let skipping = false;
  for (let i = start; i < end; i++) {
    const m = /^(=+)\s*(.+?)\s*=+$/.exec(lines[i].trim());
    if (m) {
      const n = norm(m[2]);
      skipping = UNWANTED.some((u) => n === u || n.startsWith(u + ' ') || n.endsWith(' ' + u));
      if (skipping) continue;
    }
    if (!skipping) kept.push(lines[i]);
  }
  return kept.join('\n').trim();
}

/**
 * Everything documented about how one book came to exist.
 *
 * Returns the retrieved TEXT, not a summary of it. What comes back here is
 * what gets handed to the model; nothing is paraphrased on the way.
 */
export async function retrieve(workId, { force = false } = {}) {
  // Already fetched. Wikipedia is asked once per book, not once per run:
  // re-fetching four hundred articles to rebuild a page is how a personal
  // project earns a 429, and the composition history of a book published in
  // 1955 does not change between Tuesdays.
  if (!force) {
    const cached = all(
      'SELECT kind, ref, title, text, fetched_at FROM history_sources WHERE work_id = ?',
      Number(workId)
    );

    // Only a cache with an ARTICLE in it is a finished answer. A cache
    // holding the catalogue row alone means either "there is no article" or
    // "the lookup failed", and those must not be the same thing — the run
    // that was rate limited part way through wrote exactly this shape, and
    // treating it as settled would freeze a wrong verdict in place forever.
    // So it is re-looked, at most weekly.
    const hasArticle = cached.some((s) => s.kind === 'wikipedia');
    const lookedRecently = cached.some(
      (s) => s.fetched_at && Date.now() - Date.parse(s.fetched_at.replace(' ', 'T') + 'Z') < 7 * 86_400_000
    );

    if (cached.length && (hasArticle || lookedRecently)) {
      const work = get(
        `SELECT w.*,
                (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
                  WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
           FROM works w WHERE w.id = ?`,
        Number(workId)
      );
      if (work) return { work, sources: cached, cached: true };
    }
  }

  const work = get(
    `SELECT w.*,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM works w WHERE w.id = ?`,
    Number(workId)
  );
  if (!work) return null;

  const sources = [];

  const article = await findArticle(work.title, work.author);
  if (article) {
    const sections = await articleHistory(article.articleTitle);
    if (sections?.length) {
      sources.push({
        kind: 'wikipedia',
        ref: `https://en.wikipedia.org/wiki/${encodeURIComponent(article.articleTitle.replace(/ /g, '_'))}`,
        title: article.articleTitle,
        text: sections.map((s) => `## ${s.heading}\n${s.text}`).join('\n\n').slice(0, 9000)
      });
    }
  }

  // The catalogue's own record: imprint, printings, the physical object.
  // This is always available and always true, and it is what the fallback
  // card is built out of.
  const editions = all(
    `SELECT publisher, published_year, page_count, format, language, isbn13
       FROM editions WHERE work_id = ? ORDER BY (published_year IS NULL), published_year`,
    work.id
  );
  sources.push({
    kind: 'catalogue',
    ref: 'this library',
    title: work.title,
    text: JSON.stringify({
      title: work.title,
      author: work.author,
      first_published_year: work.first_published_year,
      original_language: work.original_language,
      subjects: safeSubjects(work.subjects).slice(0, 12),
      editions: editions.slice(0, 8)
    })
  });

  return { work, sources };
}

const safeSubjects = (raw) => {
  try { return JSON.parse(raw || '[]') || []; } catch { return []; }
};

// ── CONFIDENCE ───────────────────────────────────────────
/**
 * How much documented history was actually found.
 *
 *   documented  a Wikipedia article for THIS book with a section about how
 *               it was written or published. Enough to write from.
 *   thin        the book was identified but nothing about its composition
 *               exists. No blurb is generated; the material card is shown.
 *   none        the book could not be identified at all.
 *
 * The flag is set by what retrieval returned, never by how confident the
 * finished sentences happen to sound.
 */
// How much retrieved prose counts as enough to write 70 to 90 words from.
//
// Set by reading the real thing rather than by picking a round number. At
// 700 this excluded Stoner, whose 612 characters carry the university, the
// retirement year, the disclaimer in the preface and the poet who partly
// inspired it — plenty. Below about 450 an article section is a stub.
export const ENOUGH_TO_WRITE_FROM = 450;

export function confidenceOf(sources) {
  const wiki = (sources || []).find((s) => s.kind === 'wikipedia');
  if (!wiki) return 'thin';
  return wiki.text.length >= ENOUGH_TO_WRITE_FROM ? 'documented' : 'thin';
}

// ── THE MATERIAL CARD ────────────────────────────────────
/**
 * The fallback, and for most contemporary and genre fiction the only
 * honest output.
 *
 * Built entirely from what the catalogue can prove: the imprint, the
 * printings it holds, the language it was translated out of, the credited
 * translator and jacket designer. No composition history is implied and
 * none is invented. It is shorter than a written card on purpose — a thin
 * true card is better than a rich invented one, and it should look thin so
 * nobody mistakes it for the other thing.
 */
export function materialCard(workId) {
  const work = get(
    `SELECT w.*,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM works w WHERE w.id = ?`,
    Number(workId)
  );
  if (!work) return null;

  // Every edition, not only the ones naming a publisher. Filtering on
  // `publisher IS NOT NULL` meant a book whose only edition carried a page
  // count and a language but no imprint produced no card at all — and an
  // imported library is full of those. The page count is a verifiable
  // material fact about the object whether or not the house is recorded.
  const editions = all(
    `SELECT publisher, published_year, page_count, format, language
       FROM editions WHERE work_id = ?
      ORDER BY (published_year IS NULL), published_year`,
    work.id
  );

  const facts = [];

  const first = editions.find((e) => e.publisher) || editions[0];
  if (first?.publisher) {
    facts.push(first.published_year
      ? `${first.publisher}, ${first.published_year}.`
      : `${first.publisher}.`);
  }
  if (work.first_published_year && work.first_published_year !== first?.published_year) {
    facts.push(`First published ${work.first_published_year}.`);
  }

  const houses = [...new Set(editions.map((e) => e.publisher).filter(Boolean))];
  if (houses.length > 1) {
    facts.push(`${houses.length} imprints on record: ${houses.slice(0, 4).join(', ')}.`);
  }

  const langs = [...new Set(editions.map((e) => e.language).filter(Boolean))];
  if (langs.length > 1) facts.push(`Editions in ${langs.length} languages.`);

  const pages = editions.map((e) => e.page_count).filter(Boolean);
  if (pages.length > 1 && Math.max(...pages) - Math.min(...pages) > 40) {
    facts.push(`Printings run ${Math.min(...pages)} to ${Math.max(...pages)} pages.`);
  } else if (pages.length) {
    facts.push(`${pages[0]} pages.`);
  }

  const credits = all(
    `SELECT p.name, ec.role FROM edition_credits ec
       JOIN people p ON p.id = ec.person_id
       JOIN editions e ON e.id = ec.edition_id
      WHERE e.work_id = ?`,
    work.id
  );
  for (const c of credits) {
    if (/TRANSLAT/i.test(c.role)) facts.push(`Translated by ${c.name}.`);
    if (/COVER|JACKET|DESIGN/i.test(c.role)) facts.push(`Jacket by ${c.name}.`);
  }

  // A book the catalogue holds nothing material about at all. Naming the
  // author is not a fact about the OBJECT, so the card is not padded with
  // one: the plate simply does not appear, which is the honest result and
  // the one the lookbook is built to handle.
  return facts.length ? { facts, kind: 'material' } : null;
}

// ── THE VALIDATOR ────────────────────────────────────────
//
// Nothing generated reaches the page without passing this. It is the only
// thing standing between the brief and a card that reads beautifully and is
// wrong, so it fails closed: anything it cannot check, it rejects, and the
// material card is shown instead.
//
// Two jobs, and the second is the important one.
//
//   REGISTER  the copy has to sound like exhibition catalogue text and not
//             like a blurb. Flat declarative past tense, no plot, no
//             evaluation, no addressing the reader, none of the four banned
//             words. Cheap to check and cheap to fix.
//
//   GROUNDING every date and every figure in the copy has to appear in the
//             retrieved text. This is the anti-invention check, and it works
//             because fabrication concentrates in exactly those tokens: a
//             model writing from memory produces a confident wrong year and
//             an invented print run far more readily than it invents a
//             sentence shape. If a number in the output is not in the
//             evidence, the card did not come from the evidence.

// Matched as STEMS, not as whole words. Banning "explores" and leaving
// "exploration" is banning a conjugation rather than a habit, and
// "her exploration of what is real or not real" is the same sentence the
// rule exists to keep off the page.
const BANNED = [
  // Named in the brief.
  'timeless', 'masterpiece', 'explor', 'delv',
  // The same register, one synonym away.
  'masterwork', 'seminal', 'iconic', 'unforgettable', 'haunting',
  'lyrical', 'searing', 'luminous', 'tour de force', 'must-read',
  'beloved', 'celebrated', 'acclaimed', 'brilliant', 'stunning',
  'profound', 'poignant', 'compelling', 'gripping', 'unflinching',
  'weaves', 'delving', 'meditation on', 'love letter to'
];

// Plot summary, which the brief bans outright. These are the joints a
// synopsis is built on; catalogue copy about composition never needs them.
const PLOT = [
  /\bthe (?:novel|book|story) (?:follows|tells|centers|centres|opens|begins|charts)\b/i,
  /\bwhen (?:a|an|the) [a-z]+ (?:arrives|dies|disappears|returns|discovers)\b/i,
  /\bprotagonist\b/i, /\bnarrator (?:is|becomes|must)\b/i,
  /\bset in a world\b/i, /\bmust (?:choose|decide|confront|face)\b/i
];

// Addressing the reader. Banned here; the closing season note is the one
// place second person is allowed, and it has its own validator.
// "us" is the trap. Case-insensitively it matches "US" — the country — so a
// card correctly reporting that a translation "topped US bestseller lists"
// was rejected for addressing the reader, three attempts running, and a book
// with 8,800 characters of good sources came out thin. The pronoun is
// lowercase; the country is not.
const SECOND_PERSON_ANY = /\b(?:you|your|yours|yourself|we|our)\b/i;
const US_PRONOUN = /\bus\b/;                      // case-SENSITIVE, deliberately
const SECOND_PERSON = {
  test: (t) => SECOND_PERSON_ANY.test(t) || US_PRONOUN.test(t)
};

// Present tense on the book itself, which is the blurb tense. Composition
// history happened; it is written in the past.
const PRESENT = [
  /\bthe (?:novel|book) (?:is|has|opens|takes|remains)\b/i,
  /\bit (?:is|remains) (?:a|an|the)\b/i
];

const COMMON_CAPS = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'in', 'on', 'at', 'by', 'for',
  'from', 'to', 'of', 'with', 'after', 'before', 'during', 'while',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'i', 'he', 'she', 'they', 'it', 'his', 'her', 'their', 'its',
  'when', 'where', 'what', 'that', 'this', 'these', 'those',
  'first', 'second', 'third', 'world', 'war', 'one', 'two'
]);

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

/**
 * Is a generated composition card allowed on the page?
 *
 * `sources` is the retrieved text the card was supposed to be written from.
 * Passing it is not optional: without it there is no grounding check, and a
 * card that has only been checked for register is exactly the failure mode
 * this whole file exists to prevent. Called without sources, this refuses.
 *
 * Returns `{ ok, problems }`. `problems` is kept because a rejected card is
 * regenerated once with the problems fed back, and because a run of
 * rejections is worth being able to read.
 */
export function validate(text, { sources, title, author } = {}) {
  const problems = [];
  const body = String(text || '').trim();

  if (!body) return { ok: false, problems: ['empty'] };
  if (!Array.isArray(sources) || !sources.length) {
    return { ok: false, problems: ['no sources to check against'] };
  }

  // ── Length ──
  // The brief says around 70 to 90 words. The band is a shade wider so a
  // good card is not thrown away over one article, but a card at 40 words
  // is not the thing that was asked for and a card at 130 has started
  // summarising.
  // The brief says AROUND 70 to 90. The band is wider than that on purpose,
  // and the reason is asymmetric: a card that runs long has started
  // summarising, but a card that runs short is usually short because the
  // sources were thin — and throwing away sixty-five true words to protect a
  // word count is the validator working against its own purpose. Lie With Me
  // has one paragraph of documented history and it is worth having.
  const n = words(body).length;
  if (n < 62) problems.push(`too short (${n} words, want 70 to 90)`);
  if (n > 100) problems.push(`too long (${n} words, want 70 to 90)`);

  // ── Register ──
  const low = body.toLowerCase();
  for (const b of BANNED) {
    if (low.includes(b)) problems.push(`banned word: ${b}`);
  }
  if (SECOND_PERSON.test(body)) problems.push('addresses the reader');
  for (const re of PLOT) {
    if (re.test(body)) problems.push('reads as plot summary');
  }
  for (const re of PRESENT) {
    if (re.test(body)) problems.push('present tense on the book');
  }

  // A question or an exclamation is a voice the brief does not have.
  if (/[?!]/.test(body)) problems.push('not declarative');

  // ── Grounding ──
  const evidence = sources.map((s) => s.text || '').join('\n').toLowerCase();

  // Every year in the copy must appear in the evidence. This is the check
  // that catches an invented date, which is the most common and least
  // visible way this feature fails.
  for (const year of new Set(body.match(/\b1[0-9]{3}\b|\b20[0-9]{2}\b/g) || [])) {
    if (!evidence.includes(year)) problems.push(`year not in sources: ${year}`);
  }

  // And every other figure — print runs, page counts, rejection counts,
  // sums of money. Digits are where fabrication concentrates.
  for (const fig of new Set(body.match(/\b\d[\d,]{1,}\b/g) || [])) {
    const bare = fig.replace(/,/g, '');
    if (/^(1[0-9]{3}|20[0-9]{2})$/.test(bare)) continue;             // already checked
    if (evidence.includes(fig.toLowerCase()) || evidence.includes(bare)) continue;
    problems.push(`figure not in sources: ${fig}`);
  }

  // Proper nouns: cities, publishers, editors, magazines. A capitalised word
  // that does not open a sentence and is not part of the book's own title or
  // its author's name has to be in the evidence too.
  const own = new Set(
    `${title || ''} ${author || ''}`.toLowerCase().split(/[^a-z']+/i).filter(Boolean)
  );
  const sentenceStarts = new Set();
  for (const m of body.matchAll(/(?:^|[.:;]\s+)([A-Z][a-z]+)/g)) {
    sentenceStarts.add(m[1]);
  }
  for (const m of new Set(body.match(/\b[A-Z][a-z]{2,}\b/g) || [])) {
    const l = m.toLowerCase();
    if (COMMON_CAPS.has(l) || own.has(l)) continue;
    if (sentenceStarts.has(m) && !evidence.includes(l)) {
      // Opening a sentence is a weak signal on its own, so a first word is
      // only forgiven, never flagged.
      continue;
    }
    if (!evidence.includes(l)) problems.push(`name not in sources: ${m}`);
  }

  return { ok: problems.length === 0, problems };
}

// ── THE PROMPT ───────────────────────────────────────────
//
// Everything the model is allowed to know arrives in the message. It is
// never asked what it remembers about a book; it is handed the retrieved
// text and told to write only from that.
//
// The instruction that matters most is the last one. A model given a
// research brief and thin evidence will fill the gap rather than return
// short, because returning short reads like failure — and the sentences it
// invents to reach ninety words are exactly the ones nobody can check.
// Saying INSUFFICIENT is the correct answer to a thin file, and it has to be
// named as such.

const SYSTEM = [
  'You write exhibition catalogue copy for a museum of books.',
  '',
  'You are given retrieved source text about how one book came to be written',
  'and published. Write 70 to 90 words about the CONDITIONS OF ITS COMPOSITION,',
  'using only what the sources say.',
  '',
  'THE SUBJECT IS HOW THE BOOK WAS WRITTEN. Publication is the epilogue.',
  '',
  'Lead with whichever of these the sources support. Most books will only',
  'give you two or three, and two of these is a better card than five facts',
  'about printing:',
  '  - where the author physically was, and what they were living on',
  '  - how long it took, what interrupted it, what they wrote it on',
  '  - what was happening in their life or their country at the time',
  '  - what they were reading, reacting against, or arguing with',
  '  - what the book was before it was this book: an earlier draft, a short',
  '    story, a commission, a different title, a false start',
  '  - who else was in the room: a spouse who typed it, a friend who read it',
  '    first, a rival, a patron, a translator who reshaped it',
  '',
  'THEN, and only as the last sentence or two, how it reached print: the',
  'house, the year, a serialisation, a rejection, a censor.',
  '',
  'That is the ORDER OF PREFERENCE, not a requirement. Read it as: if the',
  'sources tell you how the book was written, lead with that.',
  '',
  'IF THEY ONLY TELL YOU HOW IT WAS PUBLISHED, WRITE THAT CARD ANYWAY.',
  'Publication history on its own is a real card and it is the card most',
  'books will get: a serialisation in 1995, a translator who dropped three',
  'chapters, a first edition of 5,090 copies, the house and the year. Never',
  'reply INSUFFICIENT because the sources are about publication rather than',
  'composition. That is not insufficient; that is the material.',
  '',
  'What you must NOT do is pad. If print runs and page counts are all there',
  'is, write the two or three concrete facts plainly and stop, even if that',
  'lands at 70 words. Do not reach for more arithmetic to fill the space,',
  'and do not make how much an editor removed the SUBJECT of the card when',
  'the sources give you anything else to lead with.',
  '',
  'Concrete nouns, dates, cities, print runs, names of houses and editors.',
  '',
  'NEVER: plot summary. Any judgement of whether the book is good. Addressing',
  'the reader as "you". Any form of the words timeless, masterpiece, explore or',
  'delve, including exploration and delving. Their synonyms. Questions.',
  'Exclamations.',
  '',
  'ALWAYS: flat declarative past tense. Catalogue copy, not marketing copy.',
  '',
  'Every date, figure, city and name you write MUST appear in the sources. Do',
  'not supply a fact from your own knowledge, even one you are certain of.',
  '',
  'Reply with exactly INSUFFICIENT ONLY when the sources say nothing about how',
  'the book was written AND nothing about how it was published — when all',
  'they contain is',
  'plot, themes, reception, adaptations, or the author\'s biography with no',
  'bearing on this book. That is a correct and expected answer for a great',
  'many books, and a thin true card gets written from other material instead.',
  '',
  'But do not refuse because the picture is partial. Partial is normal. If the',
  'sources give you the house, the year and a serialisation, write those.'
].join('\n');

/** What gets sent, as data rather than as prose. */
export function promptFor(work, sources) {
  const wiki = (sources || []).find((s) => s.kind === 'wikipedia');
  return {
    system: SYSTEM,
    user: JSON.stringify({
      title: work.title,
      author: work.author || null,
      first_published_year: work.first_published_year || null,
      sources: (sources || []).map((s) => ({ kind: s.kind, ref: s.ref, text: s.text }))
    }),
    // No retrieved composition history means there is nothing to write from
    // and the call is not worth making.
    worthCalling: !!wiki && wiki.text.length >= ENOUGH_TO_WRITE_FROM
  };
}

// ── THE MODEL CALL ───────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 20_000;

/**
 * Model output as plain text.
 *
 * Asked for prose, a model will still reach for markdown to italicise a
 * title — and every one of these strings is printed through an escaping
 * template, so `*The Wind-Up Bird Chronicle*` reaches the page with its
 * asterisks intact. Stripping them here rather than in the view means the
 * validator sees what the reader will see, and the word counts are counts
 * of words rather than of punctuation.
 */
function plain(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    // An em dash set tight is a typographic choice this product does not
    // make anywhere else.
    .replace(/\s*—\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * One attempt. Returns the raw text, or null.
 *
 * `fetchImpl` is injectable so the whole path — request shape, refusal
 * handling, validation, rejection, retry — can be tested without a key and
 * without a network. Without that seam the only way to know this works is to
 * run it against the real API and read the output, which is not a test.
 */
export async function callModel({ system, user },
                                { apiKey, fetchImpl = fetch, temperature = 0.2,
                                  maxTokens = 400 } = {}) {
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        // 400 is right for a composition card, which is one paragraph. It is
        // NOT right for a colour blend, which is four blocks each carrying a
        // 45-word citation — that lands around 330 tokens before the model
        // has written anything long, and truncation there produces a final
        // block with a COLOUR line and no WEIGHT, SECTION or EVIDENCE. Which
        // is exactly what Wolf Hall came back with.
        max_tokens: maxTokens,
        // Low. This is a paraphrase of a source document, not a composition.
        temperature,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return plain(data?.content?.[0]?.text) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write one card: retrieve, generate, validate, retry once, or fall back.
 *
 * The order is the point. Retrieval happens whether or not there is a key,
 * because the confidence flag and the material card are both derived from
 * what was found rather than from what was written. A card is only ever
 * `documented` when a model wrote it from retrieved text AND the validator
 * passed it.
 */
export async function generate(workId, { apiKey = process.env.ANTHROPIC_API_KEY,
                                         fetchImpl = fetch, retrieveImpl = retrieve } = {}) {
  // A RetrievalUnavailable is deliberately NOT caught here. "We could not
  // reach Wikipedia" must not be written to the cache as "this book has no
  // documented history": the first is temporary and the second is a claim.
  // The caller stops the run instead.
  const found = await retrieveImpl(workId);
  if (!found) return null;

  const { work, sources } = found;
  cacheSources(workId, sources);

  const confidence = confidenceOf(sources);
  const prompt = promptFor(work, sources);

  // No key, or nothing documented to write from. Either way the honest
  // output is the material card, and the flag says so.
  //
  // EXCEPT when a written card already exists. Running this script without a
  // key used to overwrite documented cards with thin ones — "we did not ask
  // the model" was being recorded as "this book has no documented history",
  // which is the same category error the RetrievalUnavailable guard above
  // exists to prevent, and it destroyed two real cards before it was caught.
  // Absence of a key is a fact about the run, never about the book.
  if (!apiKey || !prompt.worthCalling) {
    const held = cardFor(workId);
    if (held?.kind === 'written') return held;
    return saveCard(workId, { confidence: 'thin', body: null, model: null });
  }

  const problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // The second attempt is told what was wrong with the first. Asking the
    // same question twice and hoping is not a retry.
    const user = attempt === 0 ? prompt.user : retryMessage(prompt.user, problems);

    // A retry at the same temperature reproduces the same sentence, which is
    // not a second attempt. Loosened just enough to find different words for
    // the same facts.
    const raw = await callModel({ system: prompt.system, user },
                                { apiKey, fetchImpl, temperature: attempt === 0 ? 0.2 : 0.6 });
    if (!raw) continue;

    // The model saying the file is thin is a result, not a failure.
    if (/^INSUFFICIENT\b/i.test(raw)) break;

    const check = validate(raw, { sources, title: work.title, author: work.author });
    if (check.ok) {
      return saveCard(workId, { confidence: 'documented', body: raw, model: MODEL });
    }
    problems.length = 0;
    problems.push(...check.problems);
  }

  // Generated and rejected, or refused. Either way nothing unverified is
  // written to the page.
  return saveCard(workId, {
    confidence: 'thin', body: null, model: null,
    rejected: problems.length ? problems : null
  });
}

/**
 * The second attempt, told what to do rather than what went wrong.
 *
 * "Your previous answer was rejected: too long (105 words)" was not enough
 * — rich sources make the model overshoot, and being told it overshot
 * produced another overshoot. Length now gets an instruction with a method
 * attached: drop whole facts, because compressing sentences is how a card
 * turns into a list.
 *
 * A grounding failure gets the opposite treatment. There is no rewriting
 * around an unsupported name; the only fix is to remove the claim.
 */
function retryMessage(user, problems) {
  const long = problems.find((p) => p.startsWith('too long'));
  const short = problems.find((p) => p.startsWith('too short'));
  const ungrounded = problems.filter((p) => / not in sources: /.test(p));

  const orders = [];
  if (long) {
    orders.push(
      'It ran long. Write it again at 80 words. Drop whole facts from the end ' +
      'rather than compressing the sentences you keep: a card of clipped ' +
      'clauses is worse than a card with one fewer date in it.'
    );
  }
  if (short) {
    orders.push('It ran short. Write it again at 80 words, using more of what the sources give you.');
  }
  if (ungrounded.length) {
    orders.push(
      'These do not appear in the sources: ' +
      ungrounded.map((p) => p.split(': ').pop()).join(', ') + '. ' +
      'Delete every claim that rests on them. Do not substitute a different ' +
      'date or place, and do not supply one from memory: remove the sentence.'
    );
  }
  // A banned word has to be named, not hinted at. "Also fix: banned word:
  // explor" tells the model a stem it never wrote, and it answered by
  // producing the identical sentence twice.
  const banned = problems.filter((p) => p.startsWith('banned word: '));
  if (banned.length) {
    orders.push(
      'You used ' + banned.map((p) => `"${p.split(': ').pop()}"`).join(' and ') +
      ' (in some form). Rewrite those clauses to state what happened instead ' +
      'of characterising it. "Her exploration of propaganda" is a description ' +
      'of the book; "she read Hume on submission" is a fact about how it was ' +
      'written. Prefer the fact, or drop the clause.'
    );
  }

  const other = problems.filter(
    (p) => p !== long && p !== short && !ungrounded.includes(p) && !banned.includes(p)
  );
  if (other.length) orders.push('Also fix: ' + other.join('; ') + '.');

  return `${user}\n\nYour previous answer was rejected.\n${orders.join('\n')}`;
}

function cacheSources(workId, sources) {
  for (const s of sources || []) {
    run(
      `INSERT INTO history_sources (work_id, kind, ref, title, text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (work_id, kind) DO UPDATE SET
         ref = excluded.ref, title = excluded.title,
         text = excluded.text, fetched_at = excluded.fetched_at`,
      Number(workId), s.kind, s.ref, s.title || null, s.text, nowSQL()
    );
  }
}

function saveCard(workId, { confidence, body, model, rejected = null }) {
  // A card somebody edited by hand is never overwritten by a regeneration.
  const existing = get('SELECT edited_by_user FROM history_cards WHERE work_id = ?', Number(workId));
  if (existing?.edited_by_user) return cardFor(workId);

  run(
    `INSERT INTO history_cards (work_id, confidence, body, model, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (work_id) DO UPDATE SET
       confidence = excluded.confidence, body = excluded.body,
       model = excluded.model, generated_at = excluded.generated_at`,
    Number(workId), confidence, body, model, nowSQL()
  );
  // cardFor returns null for a book with no written card AND no material
  // facts to fall back on — a work with no editions at all. That is a real
  // state, not an error, so the rejection reasons are returned on their own
  // rather than attached to nothing.
  const card = cardFor(workId);
  if (!card) return rejected ? { kind: 'none', confidence: 'thin', rejected } : null;
  if (rejected) card.rejected = rejected;
  return card;
}

// ── READING A CARD ───────────────────────────────────────
/**
 * What the lookbook shows for one book.
 *
 * Always returns something or nothing honestly: a written card when one was
 * generated and passed, otherwise the material card built from the
 * catalogue's own facts, otherwise null. It never returns prose that has not
 * been through the validator.
 */
export function cardFor(workId) {
  const row = get('SELECT * FROM history_cards WHERE work_id = ?', Number(workId));

  if (row?.body && row.confidence === 'documented') {
    const source = get(
      `SELECT ref, title FROM history_sources WHERE work_id = ? AND kind = 'wikipedia'`,
      Number(workId)
    );
    return {
      kind: 'written',
      confidence: 'documented',
      body: row.body,
      edited: !!row.edited_by_user,
      source: source ? { ref: source.ref, title: source.title } : null
    };
  }

  const material = materialCard(workId);
  if (material) return { kind: 'material', confidence: 'thin', facts: material.facts };
  return null;
}

/** A reader's own correction, which no regeneration may undo. */
export function editCard(workId, body) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'Say something.' };
  run(
    `INSERT INTO history_cards (work_id, confidence, body, model, generated_at, edited_by_user)
     VALUES (?, 'documented', ?, NULL, ?, 1)
     ON CONFLICT (work_id) DO UPDATE SET
       confidence = 'documented', body = excluded.body,
       model = NULL, generated_at = excluded.generated_at, edited_by_user = 1`,
    Number(workId), text.slice(0, 1200), nowSQL()
  );
  return { ok: true };
}

// ── THE CLOSING NOTE ─────────────────────────────────────
//
// After the entries, one paragraph about the season as a whole.
//
// Not statistics. The through-line is in the HISTORIES rather than in the
// plots: books written under censorship, books written in exile, a run of
// first novels, writers who were the same age when they wrote them, two
// books from the same decade on opposite sides of an argument.
//
// This is the one place in the feature written in the second person, and the
// one place allowed a voice. The line it must not cross is flattery: a
// season that was timid or restless or nostalgic gets told so. It never
// mocks a particular book and never counts anything.

const NOTE_SYSTEM = [
  'You write the closing note for a seasonal reading catalogue.',
  '',
  'You are given the COMPOSITION HISTORIES of the books someone read in one',
  'season: where each was written, under what conditions, and how it reached',
  'print. Write 90 to 110 words to that reader, addressed as "you".',
  '',
  'Find the through-line in the HISTORIES, not the plots. Books written in',
  'exile. A run of first novels. Writers the same age when they wrote them.',
  'Books written fast, or written over a decade. Two books from the same',
  'decade on opposite sides of an argument. A book that began as something',
  'else. Writers who were doing another job the whole time.',
  '',
  'ONE THROUGH-LINE IS BANNED UNLESS NOTHING ELSE CONNECTS THE BOOKS:',
  '"editors changed these books before you saw them."',
  '',
  'It is the easiest line to reach for, because publication sections are the',
  'longest part of most sources, and it has been the answer far too often. It',
  'is also close to empty: every published book passed through an editor, so',
  'saying so about a particular season tells the reader nothing about THIS',
  'season. Cuts, page counts and print runs may appear as supporting detail.',
  'They may not be the point.',
  '',
  'The connection must be about the WRITERS or the WRITING — where they were,',
  'what they were living on, what they were arguing with, how long it took,',
  'what the book was before it was this book — and not about the machinery',
  'that printed them.',
  '',
  'You MUST do all three of these:',
  '',
  '  1. Print at least TWO of the book TITLES exactly as given to you. Naming',
  '     the author is not naming the book. "Stevenson wrote it in Braemar"',
  '     does not count; "Treasure Island" does.',
  '  2. Make one claim about the connection between them that the reader',
  '     would not have spotted.',
  '  3. Land one line about what the season says about them.',
  '',
  'Length is 90 to 110 words. Count them. A note at 127 words will be thrown',
  'away whatever else is right about it.',
  '',
  'WRITE IT SO A FRIEND WOULD UNDERSTAND IT ON ONE READING. This matters more',
  'than sounding clever, and it is where these notes usually go wrong.',
  '',
  '  - Say the concrete thing before the abstract one. "She wrote it at night',
  '    after shifts at the airline" lands; "apprenticing themselves to',
  '    absence" does not.',
  '  - Never stack abstract nouns. "Restless with mediation, with what gets',
  '    removed, what gets borrowed" is three abstractions in a row and means',
  '    nothing on first reading. One idea, in plain words.',
  '  - Do not describe books as doing things they cannot do. Books do not',
  '    "complete themselves in the reader\'s hands" or "know they are',
  '    reconstructions". People did things to these books. Say who, and what.',
  '  - Prefer short sentences and ordinary words. The facts are strange',
  '    enough; the sentences do not have to be.',
  '',
  'The point you make should be one a reader could repeat to someone else',
  'afterwards. If you cannot imagine them repeating it, it is too vague.',
  '',
  'DO NOT END ON A HEDGE. The last line must be a claim, not a gesture at',
  'something unknowable. These are all forbidden endings:',
  '',
  '  "That changes what they could say."',
  '  "What disappears when someone else decides what the reader should see."',
  '  "What was left out, we will never know."',
  '  "What might this book have been?"',
  '',
  'They sound like conclusions and commit to nothing. Say something that',
  'could be wrong. A sentence nobody could disagree with is not worth the',
  'reader\'s time.',
  '',
  'NEVER: congratulate. Flatter. Count the books or mention how many there',
  'were. Mock any particular book. Summarise a plot. Use the words timeless,',
  'masterpiece, or any form of explore or delve.',
  '',
  'If the season was timid, restless, nostalgic or narrow, say so plainly.',
  'Flamboyance is welcome; praise of the reader is not.',
  '',
  'Every fact you use must come from the histories given. If they are too thin',
  'to find a through-line in, reply with exactly: INSUFFICIENT'
].join('\n');

/**
 * Does the note actually name this book?
 *
 * Not by whole-string equality. Nobody writing a sentence prints "Colorless
 * Tsukuru Tazaki and His Years of Pilgrimage" in full, and requiring it meant
 * a note that named the book perfectly well was rejected for naming nothing —
 * which sent A/W 25 round the retry loop twice and came back with no note at
 * all.
 *
 * A book counts as named when the note carries its title up to any subtitle,
 * or the first few significant words of it. Naming the AUTHOR still does not
 * count: the requirement is that a reader can see which books are being
 * talked about.
 */
function mentions(body, title) {
  const hay = normaliseForMention(body);
  const full = normaliseForMention(title);
  if (!full) return false;
  if (hay.includes(full)) return true;

  // Up to a subtitle: "Wolf Hall: A Novel" → "wolf hall".
  const head = normaliseForMention(String(title).split(/[:(\u2014]/)[0]);
  if (head && head.length >= 8 && hay.includes(head)) return true;

  // Otherwise the longest opening run of the title that appears. Titles get
  // shortened in a sentence — "Colorless Tsukuru Tazaki" for a book whose
  // full title runs to eight words — and the shortened form is still
  // unambiguously the book. The floor keeps "The Sun" or "Never Let" from
  // counting: at least two words and twelve characters, which is long
  // enough to be this book and not another.
  const parts = full.split(' ');
  for (let n = parts.length; n >= 2; n--) {
    const prefix = parts.slice(0, n).join(' ');
    if (prefix.length < 12) break;
    if (hay.includes(prefix)) return true;
  }
  return false;
}

const normaliseForMention = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// A note gets three attempts where a card gets two.
//
// Not because the rules are too strict — each rejection was catching
// something real — but because it fails a DIFFERENT one each time: too long,
// then naming one book, then stacking abstractions. Two tries kept losing
// seasons that would have landed on the third, and a note is one call per
// season rather than one per book, so the extra attempt is cheap.
const NOTE_ATTEMPTS = 3;

const CONGRATULATION = [
  /\bwell read\b/i, /\bimpressive\b/i, /\bcongratulat/i, /\bgood (?:taste|year|season)\b/i,
  /\byou should be proud\b/i, /\bwhat a (?:year|season|list)\b/i, /\bbravo\b/i,
  /\bkudos\b/i, /\bnicely done\b/i, /\bvoracious\b/i, /\bprolific\b/i
];

/**
 * Is a closing note allowed on the page?
 *
 * A different set of rules from the per-book validator, and deliberately so:
 * second person is required here rather than banned, and the grounding check
 * is that it names real books from this season rather than that every digit
 * appears in the sources.
 */
export function validateNote(text, { titles = [], sources = [] } = {}) {
  const problems = [];
  const body = String(text || '').trim();
  if (!body) return { ok: false, problems: ['empty'] };

  const n = words(body).length;
  if (n < 85) problems.push(`too short (${n} words, want 90 to 110)`);
  if (n > 118) problems.push(`too long (${n} words, want 90 to 110)`);

  if (!SECOND_PERSON.test(body)) problems.push('does not address the reader');

  const low = body.toLowerCase();
  for (const b of ['timeless', 'masterpiece', 'explor', 'delv']) {
    if (low.includes(b)) problems.push(`banned word: ${b}`);
  }
  for (const re of CONGRATULATION) {
    if (re.test(body)) problems.push('congratulates the reader');
  }

  // ── The editorial-intervention through-line ──
  //
  // Two of the first five notes written landed on the same idea — "editors
  // had their hands on these books before you saw them" — and a third was
  // adjacent to it. It is the easiest line available, because publication
  // sections are the longest part of most sources, and it is close to
  // empty: every published book passed through an editor, so saying it
  // about a particular season says nothing about that season.
  //
  // Catching it by the word "cut" does not work: the worst example of it
  // never used that word. It said "missing sixty-one pages", "three whole
  // chapters gone", "rearranged", "passed through someone else's judgment".
  // So the test is for the SHAPE of the claim — somebody with authority over
  // the text, plus repeated language about the text being altered — rather
  // than for any one verb.
  //
  // A single alteration alongside an agent is fine, and is often the best
  // detail in the note. Two or more is a note about scissors.
  const AGENT = /\b(?:editor|editors|publisher|publishers|translator|translators)\b/i;
  const ALTERED = new RegExp(
    '\\b(?:cut|cuts|cutting|excis\\w*|trimm?\\w*|removed|removal|deleted|omitt\\w*|' +
    'pared|abridg\\w*|condensed|slashed|missing|gone|rearrang\\w*|reorder\\w*|' +
    'withheld|held back|scissors|shortened)\\b', 'gi'
  );
  const altered = (body.match(ALTERED) || []).length;
  if (AGENT.test(body) && altered >= 2) {
    problems.push(
      'the through-line is editors altering books, which is banned unless nothing else connects them'
    );
  }

  // ── The hedged ending ──
  //
  // A closing gesture at something unknowable reads as a conclusion and
  // commits to nothing: "That changes what they could say." "What
  // disappears when someone else decides what the reader should see."
  const tail = body.split(/(?<=[.!?])\s+/).slice(-1)[0] || '';
  const HEDGE = [
    /\bwhat (?:was|were|is|are|gets?|got|had been) (?:lost|left out|taken|removed|cut|missing)\b/i,
    /\bwe (?:will )?never know\b/i,
    /\bwhat (?:disappear|vanish|remain)\w*\b/i,
    /\bchanges what they could say\b/i,
    /\bwhat (?:might|could) (?:it|they|these|this) have been\b/i,
    /\bwhat (?:you|they) (?:never|will never) (?:saw|see|read)\b/i
  ];
  if (HEDGE.some((re) => re.test(tail))) problems.push('ends on a hedge rather than a claim');
  if (/\?\s*$/.test(body)) problems.push('ends on a rhetorical question');

  // "Don't mention how many books they read." A bare number of books is the
  // statistic the note exists instead of.
  if (/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+books\b/i.test(body)) {
    problems.push('counts the books');
  }

  // ── Readability ──
  //
  // The note is the one paragraph on the page with a voice, and the voice
  // kept drifting into a register that sounds like criticism and says
  // nothing: "each author apprenticing themselves to absence", "restless
  // with mediation, with what gets removed, what gets borrowed, what arrives
  // incomplete". Both passed every other rule here. Neither survives being
  // read aloud to somebody.
  //
  // These two checks catch the actual mechanics of that drift rather than
  // trying to measure profundity: sentences too long to hold, and lists of
  // abstractions stacked in place of a point.
  const sentences = body.split(/(?<=[.;])\s+/).filter(Boolean);
  const longest = sentences.reduce((a, b) => (words(b).length > words(a).length ? b : a), '');
  if (words(longest).length > 34) {
    problems.push(`one sentence runs ${words(longest).length} words; keep them under 34`);
  }

  // "what gets removed, what gets borrowed, what arrives incomplete" — three
  // abstractions in a row, which reads as a cadence and lands as nothing.
  if (/\b(what|how)\b[^,.;]{3,40},\s*\b(what|how)\b[^,.;]{3,40},\s*\b(what|how)\b/i.test(body)) {
    problems.push('stacks three abstract clauses in a row instead of making one point');
  }

  // It has to name at least two of the actual books. This is the grounding
  // check: a note that names none of them was written about a season in
  // general rather than about this one.
  const named = titles.filter((t) => mentions(body, t));
  if (named.length < 2) {
    problems.push(`names ${named.length} of the books, needs at least 2`);
  }

  // Dates and figures still have to be real, for the same reason as in a
  // card. Checking only years, as this did at first, let "61 pages" and
  // "450,000 copies" through unexamined — they happened to be true, but the
  // note is the most quotable thing on the page and it should not be the
  // one paragraph whose numbers nobody checked.
  const evidence = sources.map((s) => s.text || '').join('\n').toLowerCase();
  if (evidence) {
    for (const fig of new Set(body.match(/\b\d[\d,]{1,}\b/g) || [])) {
      const bare = fig.replace(/,/g, '');
      if (evidence.includes(fig.toLowerCase()) || evidence.includes(bare)) continue;
      problems.push(/^(1[0-9]{3}|20[0-9]{2})$/.test(bare)
        ? `year not in the histories: ${fig}`
        : `figure not in the histories: ${fig}`);
    }
  }

  return { ok: problems.length === 0, problems, named };
}

/**
 * The second attempt at a note, told what to do rather than what went wrong.
 *
 * The generic version — "rejected: names 0 of the books" — produced another
 * note naming nobody, because the model was already naming the writers and
 * had no way to know that titles were the thing being counted.
 */
function noteRetry(user, problems, titles) {
  const orders = [];

  if (problems.some((p) => p.startsWith('names '))) {
    orders.push(
      'You did not print any of the book titles. Print at least two of these, ' +
      'exactly as written, inside the note: ' + titles.map((t) => `"${t}"`).join(', ') + '. ' +
      'Naming the author instead does not satisfy this.'
    );
  }
  const long = problems.find((p) => p.startsWith('too long'));
  if (long) orders.push(`It ran long (${long}). Cut it to 100 words by dropping a whole sentence.`);
  if (problems.some((p) => p.startsWith('too short'))) {
    orders.push('It ran short. Take it to 100 words with one more concrete fact from the histories.');
  }
  if (problems.some((p) => /counts the books/.test(p))) {
    orders.push('Do not say how many books there were. Remove the number.');
  }
  if (problems.some((p) => /abstract clauses/.test(p))) {
    orders.push(
      'You stacked three abstract clauses in a row. Replace them with one ' +
      'concrete statement about something a person did to one of these books.'
    );
  }
  if (problems.some((p) => /runs \d+ words/.test(p))) {
    orders.push('One sentence was too long to follow. Break it into two.');
  }
  if (problems.some((p) => /congratulates/.test(p))) {
    orders.push('You praised the reader. Delete that; describe the season instead.');
  }
  if (problems.some((p) => /through-line is editors/.test(p))) {
    orders.push(
      'You made the connection "editors changed these books". That is banned: ' +
      'every published book went through an editor, so it says nothing about ' +
      'THIS season. Find a different through-line, in the writers rather than ' +
      'in the publishing — where they were, what they were living on, how long ' +
      'it took, what interrupted them, what the book was before it was this ' +
      'book, what they were arguing with. A cut or a page count may stay as ONE ' +
      'supporting detail; it may not be the point.'
    );
  }
  if (problems.some((p) => /hedge|rhetorical question/.test(p))) {
    orders.push(
      'Your last sentence gestures at something unknowable instead of claiming ' +
      'anything. End on a statement that could be argued with.'
    );
  }

  const rest = problems.filter((p) =>
    !/^names |^too long|^too short|counts the books|abstract clauses|runs \d+ words|congratulates/.test(p));
  if (rest.length) orders.push('Also fix: ' + rest.join('; ') + '.');

  return `${user}\n\nYour previous answer was rejected.\n${orders.join('\n')}\n` +
         'Keep it plain. One point a reader could repeat to somebody else.';
}

/**
 * Write the closing note for a season.
 *
 * `looks` is what the lookbook already assembled — the books, in order. Only
 * the ones with a documented history contribute, because the note is about
 * the histories and a season of thin cards has no through-line to find that
 * is not invented.
 */
export async function seasonNote(seasonId, looks, { apiKey = process.env.ANTHROPIC_API_KEY,
                                                    fetchImpl = fetch } = {}) {
  const cached = get('SELECT * FROM season_notes WHERE season_id = ?', String(seasonId));
  if (cached) return { body: cached.body, model: cached.model };

  const entries = [];
  for (const look of looks || []) {
    const card = cardFor(look.work_id ?? look.id);
    if (card?.kind === 'written') {
      entries.push({ title: look.title, author: look.author || null, history: card.body });
    }
  }

  // Two histories is the minimum a through-line can be drawn between, and
  // the note is required to name two books.
  if (!apiKey) return { skipped: 'no api key' };
  if (entries.length < 2) return { skipped: `only ${entries.length} documented histories` };

  const sources = entries.map((e) => ({ text: e.history }));
  const titles = entries.map((e) => e.title);
  const user = JSON.stringify({ books: entries });

  const problems = [];
  for (let attempt = 0; attempt < NOTE_ATTEMPTS; attempt++) {
    const message = attempt === 0 ? user : noteRetry(user, problems, titles);

    const raw = await callModel({ system: NOTE_SYSTEM, user: message },
                                { apiKey, fetchImpl, temperature: 0.7 });
    if (!raw || /^INSUFFICIENT\b/i.test(raw)) break;

    const check = validateNote(raw, { titles, sources });
    if (check.ok) {
      run(
        `INSERT INTO season_notes (season_id, body, model, generated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (season_id) DO UPDATE SET
           body = excluded.body, model = excluded.model, generated_at = excluded.generated_at`,
        String(seasonId), raw, MODEL, nowSQL()
      );
      return { body: raw, model: MODEL };
    }
    problems.length = 0;
    problems.push(...check.problems);
  }

  // Nothing rather than something unverified, here as everywhere else. The
  // reasons come back with it: a season whose note was written and refused
  // is a different situation from one that had nothing to write about, and
  // reporting both as "too few histories" sent me looking in the wrong
  // place for half an hour.
  return { rejected: problems.length ? problems : ['the model declined to write one'] };
}

/** What the lookbook reads. Never generates; the backfill does that. */
export const noteFor = (seasonId) => {
  const row = get('SELECT body FROM season_notes WHERE season_id = ?', String(seasonId));
  return row?.body || null;
};
