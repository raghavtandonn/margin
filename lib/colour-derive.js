import { get, run, nowSQL } from '../db/index.js';
import { PALETTE, IDS, colourOf, isColourId, blendName } from './palette.js';
import * as OKLAB from './oklab.js';
import { blend } from './oklab.js';
import { callModel } from './history.js';
import { retrieve, cachedFor, eligibility, isInterpretive,
         evidenceFor, kindOf, bestRank, RANKS } from './colour-evidence.js';
import { coverage, FIELDS_VERSION, splitSentences } from './emotion-fields.js';

// ── DERIVING THE COLOUR ──────────────────────────────────
//
// Amendment §7.2 draws the line this file sits on:
//
//   The model is not being asked what it knows.
//   It is being asked what a specific passage says.
//
// Everything here exists to hold that line. The prompt is given retrieved
// sections and told they are the only source; the validator checks that
// what came back is IN them; and the answer to "there isn't enough here" is
// a hatch, not a guess.
//
// The shape is `lib/history.js`'s, because that file already solved this
// problem once for composition cards: a system prompt with worked examples,
// a validator that rejects with specific reasons, one retry carrying those
// reasons, and a refusal that is a first-class answer rather than an error.

// 45, not 34. The first twenty cards rejected three sentences at 35, 38 and
// 44 words — a cap that throws away a good citation for one word over is not
// measuring anything, and a verbatim span from an encyclopaedia runs longer
// than a sentence somebody composed.
// One initial attempt and two retries. Past that a card is not failing on
// format any more.
export const MAX_ATTEMPTS = 3;

/**
 * What kind of failure a problem is.
 *
 *   format    — the answer's shape: sentence count, length, a heading copied
 *               wrong, a colour id that is not one of the twenty. Costs
 *               nothing to fix and is most of what fails.
 *   weight    — a claim the source will not support. Retryable, but it is
 *               the weight check working rather than a formatting quibble,
 *               and a card that cannot find a defensible weight should fail.
 *   grounding — words that are not in the section. Retryable: the fix is to
 *               quote rather than paraphrase.
 *   setting   — reasoning from where and when. Retryable, once told.
 */
export function classify(problem) {
  const p = String(problem);
  if (/is \d+ sentences|too long|too short|not declarative|was not one of the sections supplied|not a palette id|no (COLOUR|WEIGHT|SECTION|EVIDENCE)|named twice|components survived/.test(p)) return 'format';
  if (/weighted heaviest|discussed far more/.test(p)) return 'weight';
  if (/describes the article rather than the book/.test(p)) return 'source';
  if (/not in the source/.test(p)) return 'grounding';
  if (/reasons from setting|only where and when/.test(p)) return 'setting';
  if (/heaviest component|is a plot section|states a theme/.test(p)) return 'source';
  return 'other';
}

const MAX_EVIDENCE_WORDS = 45;
const MIN_EVIDENCE_WORDS = 8;

// ── THE PROMPT ───────────────────────────────────────────

const SYSTEM = [
  'You assign one colour to a book, from a fixed palette of twenty, and you',
  'cite the sentence of retrieved source material that justifies it.',
  '',
  'You will be given sections of an encyclopaedia article about the book.',
  'THOSE SECTIONS ARE YOUR ONLY SOURCE. You may know this book. It does not',
  'matter: anything you write that is not supported by the sections in front',
  'of you is wrong, however true it is. If the sections do not carry enough',
  'to answer from, say so.',
  '',
  'THE QUESTION is what the book leaves a reader with — its emotional',
  'residue. Not what it is about, not whether it is good, not what happens',
  'in it.',
  '',
  'SETTING IS NOT THE ANSWER, EVER. This is the failure this task exists to',
  'avoid, and it is the one you will be most tempted by:',
  '  a book set in a desert is not therefore Nostalgia or Exhilaration;',
  '  a book set in snow is not therefore Clarity or Desolation;',
  '  a book about a war is not therefore Dread or Grief;',
  '  a book set in Russia is not therefore Melancholy.',
  'A book set in a desert can be tender. A war novel can be funny. If your',
  'reason is where or when the book takes place, you have not answered the',
  'question — start again from what the sources say the book is DOING.',
  '',
  'WHICH SECTION. The sections you are given are ranked, best first:',
  '  1. Themes, Style, Analysis, Interpretation, Characters, Structure',
  '     — a critic saying what the book is doing.',
  '  2. "Criticism: ..." — the abstract of an open-access scholarly article.',
  '  3. Publisher description — about the book as a whole, but written to',
  '     sell it, so read it for what it describes and not for its adjectives.',
  '  4. Plot, Synopsis, Summary — a list of what happens, which is mostly',
  '     where and when.',
  '',
  'A "Criticism:" section is an ABSTRACT — it describes what a PAPER argues,',
  'not what the book is. "This article examines the treatment of grief in..."',
  'is a claim about scholarship. Take from it only what it says about THE',
  'BOOK, and never quote the paper describing itself.',
  '  good: "Stoner\'s marriage is figured as a long defeat he does not resist"',
  '  bad:  "This article examines the figure of defeat in Stoner"',
  '  bad:  "The author argues that Williams uses irony throughout"',
  'The first is about the novel. The second is about a paper. The third is',
  'about a critic.',
  'Your HEAVIEST component must come from the best class you were given.',
  'Lighter components may come from any of them: they shift the hue and',
  'cannot carry the book.',
  '',
  'EVIDENCE MUST BE COPIED, NOT WRITTEN. Find the sentence in the section',
  'that carries your answer and reproduce it word for word. Do not paraphrase,',
  'do not summarise, do not smooth it out. It is checked against the section',
  'word by word, and a paraphrase fails that check even when it is accurate.',
  'ONE sentence only. You may trim a long one to the clause that matters, but',
  'never join two — a citation that starts mid-quote and runs for a paragraph',
  'is true and useless. 8 to 45 words.',
  '',
  'What to look for: a scene, a structural fact, a recurring object, a named',
  'character\'s situation, a stated technique.',
  '',
  'Two worked examples. They differ in METHOD, not in mood — the first reads a',
  'life, the second reads a form. Either method can reach any colour in the',
  'palette, and neither of these two colours is more likely than the other:',
  '',
  '  from a Themes section, a character\'s situation:',
  '    "Stoner\'s marriage is described as a long defeat he does not resist,',
  '     and the novel closes on him alone with his own book."',
  '     → grief',
  '',
  '  from a Style section, a repeated formal device:',
  '    "Each chapter opens with an inventory of the shop, and the lists grow',
  '     longer as the narrator recovers."',
  '     → contentment',
  '',
  'And two failures:',
  '  bad:  "The novel explores themes of isolation and disappointment."',
  '  bad:  "Set in rural Missouri, the book has a bleak atmosphere."',
  'The first is a summary of nothing. The second is setting.',
  '',
  'A BOOK IS NOT ONE EMOTION. Name THREE OR FOUR, each with a weight, and',
  'each with its own citation.',
  '',
  'THE WEIGHT IS HOW MUCH OF THE SECTION IS ABOUT THAT EMOTION. Not how',
  'strongly you feel it. Before you weight a component, look at how much of',
  'the cited section actually discusses it: an emotion carried by two',
  'sentences out of forty is not the book\'s dominant colour, however well',
  'those two sentences read. This is checked against the sections you were',
  'given.',
  '',
  'USE THE WHOLE RANGE. Weights of 5, 4 and 3 say the book is three roughly',
  'equal things, which is almost never true — and three equal parts average',
  'out to the same muddy middle for every book, so a shelf of them all comes',
  'out one colour. If most of the writing is about one thing, say so: 8, 2, 1.',
  '',
  'Every component needs its own SECTION and its own copied EVIDENCE, under',
  'all the rules above. A component you cannot cite is a component you do not',
  'name.',
  '',
  'ANSWER as three or four blocks, in this exact form and nothing else:',
  '',
  'COLOUR: <one id from the palette>',
  'WEIGHT: <a number from 1 to 10>',
  'SECTION: <the heading text only, without the == markers>',
  'EVIDENCE: <copied from that section>',
  '',
  'COLOUR: <a different id>',
  'WEIGHT: ...',
  'SECTION: ...',
  'EVIDENCE: ...',
  '',
  'Reply with exactly INSUFFICIENT, and nothing else, when the sections do',
  'not let you cite at least two components — when they are a bare plot',
  'outline, or too short, or about the book\'s publication rather than the',
  'book. INSUFFICIENT is a correct and expected answer. It is much better',
  'than plausible colours with vague reasons.'
].join('\n');

/**
 * The palette, in a different order every call.
 *
 * The first twenty cards came back nine for nine negative, and two of the
 * three candidate causes were in this function: one worked example, which was
 * a defeat, and a palette listed dread-first. A list read top to bottom
 * anchors on what is at the top.
 *
 * Shuffled rather than reversed. Positive-first would swap the bias for its
 * mirror image and prove nothing; a different random order per call means
 * that if the skew survives, ordering is ruled out rather than re-pointed.
 * The cost is that a prompt is no longer byte-identical between runs, which
 * matters to nothing here — the model is reading a set, not a sequence.
 */
export function promptFor(work, sections, { rng = Math.random } = {}) {
  const shuffled = [...PALETTE];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const palette = shuffled
    .map((c) => `  ${c.id.padEnd(15)} ${c.emotion} — ${c.name}`)
    .join('\n');

  const body = sections
    .map((s) => `== ${s.heading} ==\n${s.text}`)
    .join('\n\n');

  return [
    `BOOK: ${work.title}${work.author ? ` — ${work.author}` : ''}`,
    '',
    'PALETTE (choose exactly one id):',
    palette,
    '',
    'SECTIONS (your only source):',
    body
  ].join('\n');
}

// ── PARSING ──────────────────────────────────────────────

export function parseReply(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^INSUFFICIENT\b/i.test(text)) return { insufficient: true };

  // Split on each COLOUR line rather than on blank lines: a model that runs
  // its blocks together, or separates them with a rule, still parses.
  const chunks = text.split(/(?=^COLOUR:)/im).map((c) => c.trim()).filter(Boolean);

  const components = [];
  for (const chunk of chunks) {
    const field = (name) => {
      const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(chunk);
      return m ? m[1].trim() : null;
    };
    const colourLine = field('COLOUR');
    if (!colourLine) continue;

    components.push({
      // The FIRST token, not the whole line flattened: a model answering
      // `COLOUR: melancholy Melancholy — Indigo, Washed` is copying the
      // palette row it was shown, and that is a real choice.
      id: (colourLine.trim().split(/[\s—–:,-]+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '') || null,
      weight: Number(String(field('WEIGHT') || '').replace(/[^0-9.]/g, '')) || 0,
      // Headings come back with their == markers because the prompt shows
      // them that way. Obedience, not error.
      section: (field('SECTION') || '').replace(/^[=\s]+|[=\s]+$/g, '') || null,
      evidence: field('EVIDENCE')
    });
  }
  return components.length ? { components } : null;
}

/**
 * Cap, then renormalise.
 *
 * The cap is hard at three. Four anchors averaged in Oklab already sit close
 * to the palette centroid — which is #8D7770, a mid brown — and every book
 * with four components would come out a shade of it. The blend is supposed
 * to distinguish books from each other, and past three it stops.
 *
 * Weights are renormalised AFTER the cap, over what survives, so dropping a
 * fourth component redistributes its weight rather than leaving a blend that
 * only sums to 0.85.
 */
export const MAX_COMPONENTS = 3;

export function capAndNormalise(components) {
  const kept = [...(components || [])]
    .filter((c) => c && c.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_COMPONENTS);

  const total = kept.reduce((n, c) => n + c.weight, 0);
  if (!(total > 0)) return [];
  return kept.map((c) => ({ ...c, weight: c.weight / total }));
}

// ── THE VALIDATOR ────────────────────────────────────────
//
// Rule 3 of §7.3 is the one with teeth: nothing outside the retrieved text,
// however true it happens to be. It will reject good-sounding cards. It does
// not get relaxed to raise the assignment rate — it is the entire difference
// between this and the thing §06 banned.

/**
 * Where and when.
 *
 * NOT used to judge a single card — see the note in `validate` for why a
 * noun census cannot do that. It is exported for the corpus check: across
 * fifty assigned books, if the desert-tagged ones cluster on the amber end
 * above chance, the prompt is drifting no matter how any individual card
 * reads. That is a question about a distribution, which is a question this
 * list can answer.
 */
export const SETTING_TERMS = new RegExp(
  '\\b(' + [
    'desert', 'sahara', 'dune', 'dunes', 'arid', 'sand', 'sands',
    'snow', 'snowy', 'ice', 'icy', 'arctic', 'tundra', 'frozen', 'winter',
    'jungle', 'forest', 'swamp', 'moor', 'moors', 'prairie', 'steppe',
    'sea', 'ocean', 'island', 'coast', 'river', 'mountain', 'mountains',
    'war', 'wartime', 'battlefield', 'trenches', 'front',
    'city', 'village', 'countryside', 'rural', 'urban', 'provincial',
    'summer', 'autumn', 'spring', 'nineteenth', 'twentieth', 'century',
    'russia', 'russian', 'soviet', 'siberia', 'paris', 'london', 'japan',
    'japanese', 'america', 'american', 'england', 'english', 'africa'
  ].join('|') + ')\\b', 'i');

/**
 * Setting as the grammatical SUBJECT of an emotional predicate.
 *
 * "The river is oppressive." "The dust-covered city feels bleak." No frame
 * catches those — nothing in them announces that it is reasoning from
 * setting, it simply is — and they became reachable when plot-only articles
 * were admitted, because a plot summary is where a model goes looking for
 * atmosphere when nobody has written it a Themes section.
 *
 * Narrow on purpose: it needs a place or a season AS the subject and a mood
 * word AS the predicate. "The harbour recurs in each of Tsukuru's dreams"
 * has no emotional predicate and survives, which is the case §7.3 protects.
 */
const MOOD = 'oppressive|bleak|hostile|menacing|desolate|harsh|cold|dark|gloomy|' +
             'forbidding|claustrophobic|suffocating|brooding|grim|barren|lonely|' +
             'melancholy|sinister|threatening|unforgiving|inhospitable';

const SETTING_PREDICATE = new RegExp(
  '\\b(?:the|its|a|this)?\\s*\\w*\\s*(?:' +
  'river|desert|sand|dunes?|snow|ice|jungle|forest|swamp|moors?|steppe|sea|ocean|' +
  'island|coast|mountains?|city|village|countryside|landscape|climate|weather|' +
  'winter|summer|wilderness|terrain|surroundings|environment|atmosphere|setting' +
  ')\\b[^.]{0,28}\\b(?:is|are|was|were|becomes?|became|feels?|felt|seems?|remains?|grows?)\\b' +
  '[^.]{0,28}\\b(?:' + MOOD + ')\\b', 'i');

/** The shapes a setting-as-reason answer takes. */
const SETTING_FRAME = [
  /\bset (?:in|on|against|during)\b/i,
  /\btakes? place\b/i,
  /\bbackdrop\b/i,
  /\b(?:the|its|a) (?:setting|landscape|climate|weather|scenery)\b/i,
  /\batmosphere of\b/i,
  /\bevok(?:es|ing) the\b/i
];

/**
 * Evidence about the paper rather than about the book.
 *
 * An abstract describes what a scholar argues, so it is dense with sentences
 * that are perfectly quotable and about entirely the wrong object: "this
 * article examines...", "the author argues...", "this paper contributes to
 * the scholarship on...". Every one of those is a claim about scholarship,
 * and a colour drawn from one is a colour of the criticism rather than of
 * the novel.
 */
const ABOUT_THE_PAPER = [
  /\b(?:this|the present) (?:article|paper|essay|study|chapter|contribution)\b/i,
  /\b(?:the|its) author(?:s)? (?:argue|argues|claim|claims|contend|contends|suggest|suggests|show|shows|demonstrate|demonstrates)\b/i,
  /\b(?:we|I) (?:argue|examine|explore|analyse|analyze|investigate|contend|propose)\b/i,
  /\b(?:examines|explores|analyses|analyzes|investigates|interrogates|considers) the (?:treatment|representation|figure|role|question|theme)\b/i,
  /\b(?:draws|drawing) (?:on|upon) (?:the )?(?:work|theor|framework)/i,
  /\bcontributes to (?:the )?(?:scholarship|literature|debate|field)\b/i,
  /\bthis (?:reading|analysis|interpretation) (?:of|shows|argues)\b/i
];

/** Sentences that say nothing. The second "bad" example in the prompt. */
const VAGUE = [
  /\bexplores? (?:the )?themes? of\b/i,
  /\bdeals? with (?:the )?(?:themes? of|issues? of)\b/i,
  /\bis (?:a )?(?:meditation|exploration|reflection) on\b/i,
  /\ba (?:sense|feeling|mood|tone) of\b/i,
  /\b(?:conveys|captures|evokes) (?:a|the) (?:sense|feeling|mood)\b/i
];

/**
 * Words a grounding check must not demand.
 *
 * Function words carry no factual claim, so requiring them to appear in the
 * source protects nothing and rejects good cards for nothing: a true,
 * grounded sentence was thrown out because "across" was not in the section
 * it correctly quoted. Distinctive nouns, verbs and names are what
 * fabrication is made of, and they are what this check is for.
 *
 * Also here: the vocabulary of writing ABOUT books — "novel", "narrator",
 * "depicts" — which the model supplies as scaffolding and which is almost
 * never in the source verbatim.
 */
const STOP = new Set(`a an the and or but of in on at to for with from by as is are was were
be been being it its his her their they he she him them this that these those which who whom
whose what when where while not no nor so than then there here into over under after before
between during about against through above below up down out off again further once all any
both each few more most other some such only own same too very can will just should now has
have had do does did him himself herself itself themselves novel book story chapter character
characters narrator author writes written describes described described depicts depicted
described one two three first second last new old man woman men women life
across along amid among around behind beneath beside besides beyond despite
inside near onto outside since throughout toward towards underneath until
upon within without whether either neither also however therefore thus
rather quite still yet ever never always often sometimes usually almost
each every another others itself many much several various given whole
entire main major minor real true whose while though although because`.split(/\s+/));

/**
 * Two different counts, deliberately.
 *
 * `terms` is the grounding vocabulary — content tokens long enough to be
 * distinctive. `wordCount` is what the prompt means when it says 8 to 34
 * words, which is words. Measuring the length band in content tokens let a
 * forty-word sentence of short words through, because half of it did not
 * count.
 */
const terms = (s) => String(s || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

/**
 * Every distinctive term in the evidence has to be in the section it claims
 * to come from. This is rule 3, and it is what stops the model reaching for
 * a scene it remembers rather than one it was shown.
 */
const flatten = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function ungrounded(evidence, sectionText) {
  const hay = String(sectionText || '').toLowerCase();

  // Copied verbatim is grounded, by definition. Checked first because it is
  // exactly what the prompt asks for, and because the term-by-term check
  // below cannot distinguish an accurate paraphrase from an invention — it
  // rejected "helpful", "central" and "loss" on cards that were otherwise
  // true. Quoting makes the rule satisfiable rather than weaker.
  if (flatten(hay).includes(flatten(evidence))) return [];

  const missing = [];
  for (const w of new Set(terms(evidence))) {
    if (STOP.has(w)) continue;
    if (w.length < 4) continue;
    if (hay.includes(w)) continue;
    // A plural or possessive of something present is present.
    const stem = w.replace(/(?:'s|s|ed|ing|ly)$/, '');
    if (stem.length >= 4 && hay.includes(stem)) continue;
    missing.push(w);
  }
  return missing;
}

/**
 * One component, against the same rules a single colour used to face — with
 * one exception, which is the whole of `dominant`.
 *
 * The interpretive-section rule applies to the HEAVIEST component only.
 *
 * The rule exists to stop setting-as-emotion, and setting leakage happens
 * when the dominant read of a book comes from its landscape. With the
 * heaviest component now averaging 0.56, a book whose primary colour is
 * anchored in Themes or Style is anchored interpretively; the tail at 0.2
 * shifts the hue and cannot turn a book into its scenery.
 *
 * Majority-of-weight was the other candidate and is mushier despite sounding
 * stricter: a 0.4 + 0.15 pair satisfies it while the dominant component came
 * from plot, which is precisely the case the rule is for.
 *
 * The empirical half was already settled at one colour — plot-backed cards
 * spread as widely as themes-backed ones and their most common colour was
 * LESS dominant — and there is no reason that holds worse at three.
 */
export function validateComponent(c, { sections, dominant = true } = {}, label = 'component') {
  const problems = [];
  const say = (p) => problems.push(`${label}: ${p}`);

  if (!c.id) say('no COLOUR');
  else if (!isColourId(c.id)) say(`not a palette id: ${c.id}`);
  if (!(c.weight > 0)) say('no WEIGHT');

  const supplied = (sections || []).find(
    (x) => c.section && x.heading.toLowerCase() === String(c.section).toLowerCase());
  if (!c.section) say('no SECTION');
  else if (!supplied) say(`SECTION "${c.section}" was not one of the sections supplied`);
  else if (dominant) {
    // The heaviest component must come from the best class of evidence this
    // book HAS — interpretive if it has one, else the blurb, else plot. Not
    // the best class in the abstract: a book with only a publisher's
    // description would never carry a colour, and those are most of them.
    const best = bestRank(sections);
    const mine = kindOf(supplied.heading);
    if (best && mine !== best) {
      // Name the class it IS, not one of two guesses. A DOAJ abstract was
      // being reported as "a plot section", which is both wrong and the
      // hardest kind of message to debug from a log.
      const NAME = {
        interpretive: 'a themes, style, characters or analysis section',
        doaj: 'an open-access criticism abstract',
        blurb: 'the publisher description',
        plot: 'a plot section'
      };
      say(`SECTION "${c.section}" is ${NAME[mine]}, and this is the heaviest ` +
          `component — this book has ${NAME[best]} to cite instead`);
    }
  }

  if (!c.evidence) { say('no EVIDENCE'); return problems; }

  const n = wordCount(c.evidence);
  if (n < MIN_EVIDENCE_WORDS) say(`evidence too short (${n} words)`);
  if (n > MAX_EVIDENCE_WORDS) say(`evidence too long (${n} words, want under ${MAX_EVIDENCE_WORDS})`);
  if (/[?!]/.test(c.evidence)) say('evidence is not declarative');

  // The shared splitter, which knows that `Mr.` and `J. R. R.` are not
  // sentence ends. Counting them as such made a one-sentence citation about
  // Dr. Jekyll and Mr. Hyde unpassable however it was written.
  const sentences = splitSentences(c.evidence.trim()).length;
  if (sentences > 1) say(`evidence is ${sentences} sentences; take the one clause that carries it`);

  for (const re of VAGUE) {
    if (re.test(c.evidence)) { say('evidence states a theme rather than naming anything'); break; }
  }
  for (const re of ABOUT_THE_PAPER) {
    if (re.test(c.evidence)) {
      say('evidence describes the article rather than the book');
      break;
    }
  }
  for (const re of [...SETTING_FRAME, SETTING_PREDICATE]) {
    if (re.test(c.evidence)) { say('evidence reasons from setting'); break; }
  }

  const hay = supplied ? supplied.text : (sections || []).map((x) => x.text).join('\n');
  const missing = ungrounded(c.evidence, hay);
  if (missing.length) say(`not in the source: ${missing.slice(0, 6).join(', ')}`);

  return problems;
}

/**
 * The whole answer.
 *
 * Every component is held to the rules a single colour used to face — the
 * grounding is per component, so a blend cannot smuggle an ungrounded
 * emotion in behind two good ones. What changes is the arithmetic around
 * them: at least two must survive, no colour may appear twice, and the ones
 * that do survive are capped and renormalised before anything is blended.
 */
export function validate(reply, { sections, work } = {}) {
  if (!reply) return { ok: false, problems: ['empty reply'] };
  if (reply.insufficient) return { ok: false, insufficient: true, problems: [] };

  const raw = reply.components || [];
  if (!raw.length) return { ok: false, problems: ['no components'] };

  // ── PARTIAL ACCEPTANCE ─────────────────────────────────
  //
  // Each component is validated on its own, and a failing one is DROPPED
  // rather than taking the card down with it.
  //
  // This is arithmetic, not a relaxation. Under blending, three components
  // each face the sentence, length, grounding and setting rules, so the
  // chance of a clean card is roughly p³ — at p = 0.8 that is 51%, and the
  // yield fell when the interpretive rule was narrowed even though the
  // interpretive rejections themselves dropped from 13 to 5. Every surviving
  // component is still fully grounded and fully checked. What changes is
  // that one bad sentence costs one component instead of a book.
  //
  // Two things it does not relax: at least two components must survive, and
  // the heaviest SURVIVOR still has to satisfy the interpretive rule, so the
  // book's primary colour cannot become plot-anchored by attrition.
  const perComponent = raw.map((c, i) => ({
    c,
    label: c.id || `#${i + 1}`,
    problems: validateComponent(c, { sections, dominant: false }, c.id || `#${i + 1}`)
  }));

  const survivors = perComponent.filter((x) => !x.problems.length).map((x) => x.c);
  const dropped = perComponent.filter((x) => x.problems.length);

  // One emotion, twice, is one emotion with its weight split — and it would
  // quietly double that anchor's pull on the blend.
  const ids = survivors.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const problems = [...new Set(dupes)].map((d) => `${d} is named twice`);

  if (survivors.length < 2) {
    // Report what actually went wrong, not just the count.
    return {
      ok: false,
      problems: [
        `only ${survivors.length} of ${raw.length} components survived`,
        ...dropped.flatMap((x) => x.problems)
      ]
    };
  }

  const components = capAndNormalise(survivors);
  if (components.length < 2) return { ok: false, problems: ['fewer than two usable components'] };

  // The heaviest survivor carries the book's primary colour, so it faces the
  // interpretive rule. Checked here rather than in the loop above because
  // which component is heaviest can change when one is dropped.
  problems.push(...validateComponent(components[0], { sections, dominant: true },
                                     components[0].id));

  // ── THE WEIGHTS, AGAINST THE SOURCE ────────────────────
  //
  // Support is now TOPICAL COVERAGE: how many sentences of the cited section
  // use that emotion's own vocabulary, from the fixed fields in
  // lib/emotion-fields.js. The thing it replaced measured how often the one
  // cited sentence's phrasing was repeated, which is a different quantity and
  // undercounted coverage three to ten times.
  //
  // Validated against hand-counts on four real sections before it was
  // allowed to reject anything — see test/emotion-fields.test.js. Both
  // thresholds below are back to where they were before the loosening,
  // because the ruler they run on is now the one they were written for.
  const supportOf = (c) => {
    const sec = (sections || []).find(
      (x) => x.heading.toLowerCase() === String(c.section || '').toLowerCase());
    // Damped by the corpus it came from: publisher copy and encyclopaedia
    // prose are not the same language, and `love` is common in one where
    // `kill` is common in the other.
    return coverage(sec?.text || '', c.id, kindOf(sec?.heading) === 'blurb' ? 'blurb' : 'wikipedia');
  };
  const support = components.map(supportOf);
  const total = support.reduce((n, x) => n + x.share, 0);

  if (total > 0) {
    const top = support[0];

    // 1. The floor. "An emotion carried by two sentences in forty is not a
    //    book's dominant colour, however well those two sentences read."
    //    The short-section exemption stands: one sentence in four IS a
    //    quarter of what was written.
    if (top.sentences < 2 && top.share < 0.25) {
      problems.push(
        `${components[0].id} is weighted heaviest at ${(components[0].weight * 100).toFixed(0)}% ` +
        `but only ${top.sentences} of ${top.total} sentences in ${components[0].section} are about it`);
    }

    // 2. A clear inversion. Still compared within one section only: coverage
    //    is a fairer ruler than term overlap was, but a Characters section
    //    and a Themes section are still different kinds of writing, and the
    //    comparison is sounder where the kind is held constant.
    components.forEach((c, i) => {
      if (i === 0) return;
      const sameSection = String(c.section || '').toLowerCase() ===
                          String(components[0].section || '').toLowerCase();
      const enough = sameSection && support[i].sentences >= 3 && top.sentences >= 3;
      if (enough && support[i].share >= top.share * 2 && c.weight < components[0].weight) {
        problems.push(
          `${c.id} is discussed far more than ${components[0].id} in ${c.section} ` +
          `(${support[i].sentences} sentences against ${top.sentences}) but is weighted lower`);
      }
    });
  }

  if (problems.length) return { ok: false, problems };

  return {
    ok: true, problems: [], components,
    dropped: dropped.map((x) => x.label),
    support: support.map((x, i) => ({ id: components[i].id, ...x })),
    fieldsVersion: FIELDS_VERSION
  };
}

/**
 * What to send back on the one retry.
 *
 * Specific, because "try again" produces the same answer. A grounding
 * failure gets the strongest wording: it is the rule that protects the
 * whole feature, and a model that has just invented a detail needs telling
 * that inventing is the problem, not phrasing.
 */
export function retryMessage(problems) {
  const kinds = new Set(problems.map(classify));
  const lines = ['That answer was rejected. Fix these and answer again in the same form:'];
  for (const p of problems) lines.push(`  - ${p}`);

  // Format faults get told exactly what shape to return, because that is
  // what they got wrong — not the reading, the answer.
  if (kinds.has('format')) {
    lines.push('');
    lines.push('These are faults in the SHAPE of the answer, not in your reading of the');
    lines.push('book. Keep the same colours and the same weights if you still believe');
    lines.push('them, and fix the form: ONE sentence per EVIDENCE line, 8 to 45 words,');
    lines.push('SECTION copied exactly from a heading you were given, one block per');
    lines.push('colour, three or four blocks in total, no colour named twice.');
  }
  // `includes`, not `startsWith`. Problems are prefixed with the component
  // they belong to now ("calm: not in the source: ..."), and a prefix match
  // meant the strongest piece of retry guidance in the file silently stopped
  // firing the moment blending was introduced.
  if (problems.some((p) => p.includes('not in the source'))) {
    lines.push('');
    lines.push('Those words are not in the sections you were given. Do not write from');
    lines.push('what you know about this book. Quote something that is actually there,');
    lines.push('or reply INSUFFICIENT.');
  }
  if (problems.some((p) => p.includes('is a plot section'))) {
    lines.push('');
    lines.push('Your heaviest component must come from the Themes, Style, Analysis,');
    lines.push('Interpretation or Characters section. Take that one from there, or');
    lines.push('make a component that IS from there the heaviest.');
  }
  if (problems.some((p) => /weighted heaviest|discussed far more/.test(p))) {
    lines.push('');
    lines.push('The weight is how much of the cited section is about that emotion, not');
    lines.push('how strongly it reads. Either weight it to match what the section');
    lines.push('actually spends its sentences on, or make the emotion the section does');
    lines.push('discuss your heaviest component.');
  }
  if (problems.some((p) => p.includes('setting'))) {
    lines.push('');
    lines.push('Where and when the book takes place is not an answer to this question.');
  }
  return lines.join('\n');
}

// ── WRITING IT DOWN ──────────────────────────────────────

export function colourFor(workId) {
  const row = get(
    `SELECT colour_id, colour_hex, colour_name, colour_components, colour_at
       FROM works WHERE id = ?`, Number(workId));
  if (!row?.colour_hex) return null;

  let components = [];
  try { components = JSON.parse(row.colour_components || '[]'); } catch { /* keep none */ }

  const anchor = colourOf(row.colour_id);
  return {
    id: row.colour_id,                 // the nearest anchor, for grouping
    hex: row.colour_hex,               // the blend, which is what is drawn
    name: row.colour_name,
    emotion: anchor?.emotion || null,
    components: components.map((c) => ({ ...c, ...(colourOf(c.id) || {}) , weight: c.weight,
                                         evidence: c.evidence, section: c.section })),
    at: row.colour_at
  };
}

/**
 * Blend the components, name the result, and write it down.
 *
 * Everything needed to reproduce the colour is stored: the component ids,
 * their renormalised weights, and each one's citation. The hex is derived
 * from those and could be recomputed at any time — it is stored because a
 * page that renders four hundred books should not run four hundred cube
 * roots to do it.
 */
function save(workId, { components, model }) {
  const mixed = blend(components.map((c) => ({ hex: colourOf(c.id).hex, weight: c.weight })));
  if (!mixed) return null;

  // ── NAMED FROM THE COMPONENTS, NOT FROM THE RESULT ─────
  //
  // Naming by nearest-anchor-to-the-blend collapsed, and geometrically
  // rather than by any bug: a blend always lands inside the hull of its
  // components, so results drift toward the middle of the palette, and
  // `disorientation / Smoke Violet` at #5E5470 sits near that middle. The
  // corpus makes it worse — grief, melancholy, loneliness, dread and anxiety
  // all occupy the same desaturated blue-grey-violet region, so averaging
  // any two of them lands beside Smoke Violet.
  //
  // The margins deciding those names were noise. One card sat 0.0790 from
  // Smoke Violet and 0.0821 from Harbour Grey — a four percent gap — while
  // loneliness was 67% of the blend. Measured across the library, the name
  // disagreed with the heaviest component on 79% of cards.
  //
  // So the base is the heaviest component's anchor and the modifier is the
  // second's. The name now tracks the weights printed directly above it in
  // the derivation panel, where a reader can check it.
  const dominant = components[0].id;
  const second = components[1]?.id ?? null;

  run(
    `UPDATE works SET colour_id = ?, colour_hex = ?, colour_name = ?,
                      colour_components = ?, colour_model = ?, colour_at = ?
      WHERE id = ?`,
    // colour_id follows the name: the anchor a card is grouped under is the
    // one it is mostly made of, not the one its mix happens to sit nearest.
    dominant, mixed.hex, blendName(dominant, second),
    JSON.stringify(components.map((c) => ({
      id: c.id, weight: Number(c.weight.toFixed(4)),
      section: c.section, evidence: c.evidence,
      // Which class of evidence this component rests on, so blurb-derived
      // and Wikipedia-derived colours can be told apart afterwards.
      kind: kindOf(c.section)
    }))),
    model || null, nowSQL(), Number(workId)
  );
  return colourFor(workId);
}

/**
 * Derive one book's colour: retrieve, check eligibility, generate, validate,
 * retry once, or hatch.
 *
 * Never overwrites an existing colour without `force`. This codebase has
 * already destroyed two written cards by running a generator without a key
 * and letting it write a thin result unconditionally; the same shape of bug
 * here would silently replace a reader's considered override with a machine
 * guess.
 */
export async function derive(workId, {
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
  force = false,
  model = 'claude-haiku-4-5-20251001'
} = {}) {
  const work = get(
    `SELECT w.id, w.title, w.colour_id,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM works w WHERE w.id = ?`,
    Number(workId));
  if (!work) return { kind: 'none', reason: 'no such work' };

  if (work.colour_id && !force) {
    return { kind: 'held', colour: colourFor(workId) };
  }

  // Wikipedia first — cached, or fetched once — then everything the
  // catalogue itself holds, ranked best class first.
  if (!cachedFor(workId)) await retrieve(workId);
  const found = evidenceFor(workId);
  const sections = found.sections;

  const fit = eligibility(sections, { article: found.article });
  if (!fit.ok) return { kind: 'hatch', reason: fit.reason };

  // No key is not a hatch: it is "not attempted". Writing a hatch here would
  // mean a keyless run marked two thirds of the library unassignable.
  if (!apiKey) return { kind: 'skipped', reason: 'no api key', eligible: true };

  // ── RETRY ON FORMAT, NOT ON RULES ──────────────────────
  //
  // Measured across 87 attempts: 25 cards were rejected while holding
  // perfectly usable evidence, and almost all of it was answer format —
  // citations that ran to two sentences, a heading copied wrong, a span over
  // the word cap. Those are compliance failures, not evidence failures, and
  // the cheapest coverage in the whole system is asking again with the
  // specific fault named.
  //
  // NOT a relaxation. Every rule stays exactly where it is; what changes is
  // that the model gets told precisely what it broke and gets two more goes.
  // A card that cannot satisfy the rules in three attempts fails, and a
  // weight the source will not support fails no matter how often it is
  // asked — that check is doing its job and is not a formatting quibble.
  const user = promptFor(work, sections);

  let reply = null;
  let checked = null;
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const ask = attempts === 1
      ? user
      : `${user}\n\n${retryMessage(checked.problems)}`;
    // Four blocks of up to 45 words each, plus a retry that may make them
    // longer. The composition card's 400 was truncating answers mid-block.
    reply = parseReply(await callModel({ system: SYSTEM, user: ask },
                                       { apiKey, fetchImpl, maxTokens: 1200 }));
    checked = validate(reply, { sections, work });
    if (checked.ok || checked.insufficient) break;
  }

  if (checked.insufficient || !checked.ok) {
    const reason = checked.insufficient
      ? 'the model found no citable evidence'
      : 'rejected';

    // A failed regeneration must never destroy a good card — that is the
    // bug this codebase has already been bitten by. But a FORCED redo that
    // fails, over a stored card the current rules would themselves reject,
    // is a different case: keeping it means the tool that wrote it cannot
    // remove it, and the database holds something the pipeline would never
    // produce today. So the stored card is re-validated against its own
    // cited section, and only cleared if it fails.
    if (force && work.colour_id) {
      const stored = colourFor(workId);
      const stale = stored
        ? validate({ components: stored.components.map((c) => ({
            id: c.id, weight: c.weight, section: c.section, evidence: c.evidence })) },
          { sections, work })
        : { ok: false, problems: ['nothing stored'] };
      if (!stale.ok) {
        run(`UPDATE works SET colour_id = NULL, colour_hex = NULL, colour_name = NULL,
                              colour_components = NULL, colour_model = NULL, colour_at = NULL
              WHERE id = ?`, Number(workId));
        return { kind: 'cleared', reason, problems: checked.problems, was: stale.problems, attempts };
      }
    }
    return { kind: 'hatch', reason, problems: checked.problems, attempts };
  }

  return {
    kind: 'derived',
    colour: save(workId, { components: checked.components, model }),
    attempts
  };
}

export { SYSTEM };
