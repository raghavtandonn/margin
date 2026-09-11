// ── THE EMOTION FIELDS ───────────────────────────────────
//
// Twenty vocabularies, one per anchor. Version 1.
//
// These exist because the thing they replace was measuring the wrong
// quantity. Support used to be counted as sentences of a section sharing
// distinctive terms with the ONE cited sentence — which measures how often
// that sentence's phrasing is repeated, not how much of the section is about
// the thing. Read against hand-counts on four real sections, it undercounted
// topical coverage by three to ten times.
//
// Norwegian Wood is the proof that it could not be tuned. Its Characters
// section is pervaded by isolation — Kizuki "took his own life", Hatsumi
// "commit suicide", Reiko's "lifelong mental problems", Naoko in a
// psychiatric institution — and almost none of those sentences share
// vocabulary with each other. A cast list states the same condition once per
// character, in different words. Term overlap sees it once.
//
// So: the same trade already taken on the palette and on the name grammar.
// A small hand-built set that can be inspected, versioned and argued with
// beats a derivation nobody can audit.
//
// ── HOW THESE WERE BUILT ─────────────────────────────────
//
// From the corpus, by reading it. `scripts/fields-report.mjs` prints every
// term in the cached sections; these were chosen from what those sections
// actually say, and every entry below occurs in them. They were NOT produced
// by asking a model for synonyms of twenty emotion words — that is unsourced
// inference, which is the thing §06 bans and the thing this whole pipeline
// is arranged to avoid.
//
// ── HOW TO CHANGE THEM ───────────────────────────────────
//
// Bump FIELDS_VERSION and re-run the fixtures in test/emotion-fields.test.js,
// which hold hand-counted coverage for four real sections. A field that
// drifts away from a hand-count is wrong, however reasonable its words look.

export const FIELDS_VERSION = 3;

// ── DISCRIMINATION ───────────────────────────────────────
//
// v1 gave every term the same vote, and `kill` appears in 4.18% of every
// sentence in this corpus while `melancholy` appears in 0.15%. Grief came
// out at 12% of the corpus against melancholy's 0.2% — a sixty-fold gap
// between two adjacent negative anchors, which is the field and not the
// books. `kill`, `death`, `killed` and `die` are what a plot summary says
// about events; they are not what criticism says about grief.
//
// So a term's vote is scaled by how discriminating it is. Below 0.5% of
// sentences a term votes in full; above that it is damped in proportion, so
// `kill` at 4.18% votes 0.12 and `fear` at 0.91% votes 0.55.
//
// The table is MEASURED and FROZEN rather than computed at runtime: a
// coverage score that shifted as the retrieval cache grew would not be
// reproducible, and a stored card could not be re-checked against the
// numbers that produced it. Re-measure with `npm run colours:fields` and
// bump FIELDS_VERSION when it moves.
//
// Shares below are the fraction of the 4,616 cached corpus sentences
// containing the term, in any of the suffix forms.

const FULL_VOTE_BELOW = 0.005;

export const CORPORA = ['wikipedia', 'blurb'];

/**
 * Two tables, because the two corpora are not the same language.
 *
 * The Wikipedia table was measured over 4,616 sentences of encyclopaedia
 * prose about novels. Publisher copy is marketing: it is hyperbolic,
 * positive-skewed, and lexically nothing like criticism. Measured over 1,317
 * blurb sentences, `love` appears in 5.6% of them against 3.2% of Wikipedia's,
 * while `kill` collapses from 4.18% to 1.14% — a plot-event word in one
 * corpus is a rare word in the other, and damping a blurb by Wikipedia's
 * numbers would silence exactly the words that carry a blurb.
 *
 * Both are measured and frozen. Re-measure with `npm run colours:fields`.
 */
const SHARE_WIKIPEDIA = Object.freeze({
  kill: 0.0418, death: 0.0334, love: 0.0316, killed: 0.0197, die: 0.0180,
  revenge: 0.0147, realize: 0.0102, desire: 0.0097, alone: 0.0093,
  fear: 0.0091, dead: 0.0080, destroy: 0.0071, seen: 0.0071, dream: 0.0067,
  understand: 0.0063, died: 0.0061, accept: 0.0061, past: 0.0058,
  stark: 0.0056, suicide: 0.0052, abandon: 0.0052, childhood: 0.0052
});

// 1,317 sentences across 271 publisher blurbs.
const SHARE_BLURB = Object.freeze({
  love: 0.0562, death: 0.0220, beautiful: 0.0159, dream: 0.0137,
  kill: 0.0114, past: 0.0114, strange: 0.0114, die: 0.0099, truth: 0.0099,
  peace: 0.0099, epic: 0.0091, mysterious: 0.0091, destroy: 0.0084,
  evil: 0.0068, dangerous: 0.0068, childhood: 0.0068, accept: 0.0068,
  desire: 0.0068, fear: 0.0061, dead: 0.0061, youth: 0.0061,
  magical: 0.0061, passion: 0.0061, beauty: 0.0061, wit: 0.0061,
  horror: 0.0053, danger: 0.0053, profound: 0.0053, understand: 0.0053,
  seen: 0.0053, mystery: 0.0053, extraordinary: 0.0053, hunger: 0.0053
});

const TABLES = { wikipedia: SHARE_WIKIPEDIA, blurb: SHARE_BLURB };

/** A rare term votes 1; a common one votes in inverse proportion. */
export const voteOf = (term, corpus = 'wikipedia') => {
  const share = (TABLES[corpus] || SHARE_WIKIPEDIA)[term];
  if (!share) return 1;
  return Math.max(0.1, Math.min(1, FULL_VOTE_BELOW / share));
};

/**
 * Matching is on whole tokens with a small suffix set, never on prefixes.
 *
 * Prefix matching was tried first and is what makes lists like this rot:
 * `gentle` catches *gentleman*, `past` catches *pasta* and *pastor*,
 * `memor` catches *memorial*. Every one of those is in this corpus.
 */
const SUFFIXES = ['', 's', 'es', 'd', 'ed', 'ing', 'ly', 'ment', 'ness', 'ful'];

/**
 * Phrases, because some of this vocabulary is euphemism.
 *
 * "Kizuki took his own life when he was 17" carries no single word from any
 * field — the whole point of the phrase is that it avoids one. Encyclopaedia
 * prose about novels is full of them, and a field built only from single
 * words reads that sentence as being about nothing.
 *
 * Matched against the token stream, so punctuation and case do not matter
 * and `own life` cannot match inside another word.
 */
const PHRASES = Object.freeze({
  grief: ['own life', 'passed away', 'takes her life', 'takes his life'],
  loneliness: ['on his own', 'on her own', 'shut out', 'cut off'],
  desire: ['drawn to', 'in love with'],
  recognition: ['seen for', 'understood by']
});

export const FIELDS = Object.freeze({
  dread: ['dread', 'dreadful', 'terror', 'horror', 'fear', 'afraid', 'menace',
          'menacing', 'ominous', 'sinister', 'foreboding', 'threat', 'threaten',
          'doom', 'nightmare', 'evil', 'peril', 'danger', 'dangerous'],

  anger: ['anger', 'angry', 'rage', 'fury', 'furious', 'wrath', 'vengeance',
          'revenge', 'vengeful', 'resentment', 'resent', 'indignation', 'outrage',
          'bitter', 'hatred', 'hate', 'spite', 'retribution', 'avenge'],

  anxiety: ['anxiety', 'anxious', 'nervous', 'panic', 'unease', 'uneasy',
            'restless', 'tension', 'tense', 'paranoia', 'paranoid', 'worry',
            'worried', 'apprehension', 'apprehensive', 'unstable', 'instability',
            'disturb', 'disturbing', 'dread'],

  grief: ['grief', 'grieve', 'grieving', 'mourn', 'mourning', 'lament',
          'bereave', 'bereaved', 'sorrow', 'sorrowful', 'loss', 'losses', 'death', 'dead',
          'dying', 'die', 'died', 'funeral', 'deathbed', 'elegiac', 'suicide',
          'widow', 'orphan', 'destroy', 'destruction', 'kill', 'killed'],

  // v2 — the thin fields were under-built, not the corpus. Every term added
  // below was found in the cached sections with `--vocab`; none was guessed.
  melancholy: ['melancholy', 'melancholic', 'sadness', 'sad', 'sorrow', 'wistful',
               'despondent', 'gloom', 'gloomy', 'dejected', 'forlorn', 'brooding',
               'malaise', 'sombre', 'somber', 'mournful',
               'despair', 'despairing', 'disillusion', 'disillusioned',
               'disillusionment', 'unhappy', 'unhappiness', 'disappointment',
               'disappointed', 'regret', 'resignation', 'poignant', 'longing'],

  loneliness: ['lonely', 'loneliness', 'alone', 'isolation', 'isolate', 'isolated',
               'solitude', 'solitary', 'alienation', 'alienate', 'estrange',
               'estranged', 'abandon', 'abandoned', 'abandonment', 'detach',
               'detached', 'detachment', 'withdraw', 'withdrawn', 'disconnect',
               'unloved', 'friendless', 'outcast', 'asylum', 'psychiatric',
               'institution'],

  boredom: ['boredom', 'bored', 'boring', 'tedious', 'tedium', 'monotony',
            'monotonous', 'dull', 'listless', 'ennui', 'apathy', 'apathetic',
            'banal', 'uneventful', 'stagnant', 'aimless',
            'mundane', 'futile', 'futility', 'meaningless', 'repetitive', 'drift'],

  desolation: ['desolate', 'desolation', 'barren', 'bleak', 'empty', 'emptiness',
               'wasteland', 'ruin', 'ruined', 'devastation', 'devastated', 'void',
               'bereft', 'stark', 'austere'],

  disorientation: ['disorient', 'disorientation', 'confusion', 'confused',
                   'bewilder', 'bewildered', 'bewilderment', 'uncanny', 'surreal',
                   'dreamlike', 'dream', 'hallucination', 'hallucinate',
                   'ambiguity', 'ambiguous', 'unreliable', 'fragmented',
                   'labyrinth', 'uncertain', 'uncertainty', 'delusion'],

  awe: ['awe', 'sublime', 'vast', 'vastness', 'immense', 'magnitude', 'cosmic',
        'infinite', 'eternity', 'eternal', 'overwhelming', 'majesty', 'grandeur',
        'transcendent', 'transcendence', 'transcendental', 'transcend',
        'overwhelm', 'universe', 'epic', 'profound'],

  clarity: ['clarity', 'clear', 'understanding', 'understand', 'understood',
            'enlightenment', 'enlighten', 'enlightened', 'wisdom', 'wise',
            'insight', 'knowledge', 'realization', 'realisation', 'realize',
            'realise', 'awakening', 'awaken', 'truth', 'lucid', 'comprehension',
            'cognition', 'nirvana', 'salvation', 'perceive', 'perception',
            // Both of these are clarity IN THIS CORPUS, and both were misses
            // against the Siddhartha hand-count: "that transcendental state
            // of unity to which Siddhartha aspires" and "attain to that
            // 'completeness' which is the Buddha's badge of distinction".
            // They also sit in `awe` and `contentment`; fields overlap on
            // purpose, the way `sorrow` sits in both grief and melancholy.
            'transcendental', 'transcendence', 'transcend', 'completeness'],

  recognition: ['recognition', 'recognize', 'recognise', 'recognized',
                'recognised', 'acknowledge', 'acknowledgment', 'validation',
                'identify', 'identification', 'empathy', 'empathize', 'kinship',
                'belonging', 'mirror', 'reflected', 'seen', 'understood'],

  calm: ['calm', 'peace', 'peaceful', 'serene', 'serenity', 'tranquil',
         'tranquility', 'quiet', 'stillness', 'repose', 'soothing', 'restful',
         'harmony', 'harmonious', 'gentle', 'solace', 'equanimity', 'composure'],

  tenderness: ['tender', 'tenderness', 'gentle', 'gentleness', 'affection',
               'affectionate', 'intimacy', 'intimate', 'kindness', 'kind',
               'compassion', 'compassionate', 'caring', 'care', 'warmth',
               'comfort', 'devotion', 'love', 'loving', 'beloved', 'embrace'],

  nostalgia: ['nostalgia', 'nostalgic', 'memory', 'memories', 'remember',
              'remembrance', 'recollection', 'reminisce', 'past', 'childhood',
              'youth', 'youthful', 'longing', 'yearning', 'elegiac', 'wistful',
              'bygone', 'recall'],

  contentment: ['contentment', 'content', 'satisfied', 'satisfaction',
                'fulfilment', 'fulfillment', 'fulfil', 'fulfill', 'ease',
                'comfortable', 'settled', 'acceptance', 'accept', 'gratitude',
                'grateful', 'completeness', 'complete'],

  wonder: ['wonder', 'wondrous', 'marvel', 'marvellous', 'marvelous', 'magic',
           'magical', 'enchant', 'enchanted', 'mystical', 'mystery',
           'mysterious', 'epiphany', 'revelation', 'miracle', 'strange',
           'extraordinary', 'mystique'],

  desire: ['desire', 'longing', 'yearning', 'yearn', 'lust', 'passion',
           'passionate', 'attraction', 'attract', 'attracted', 'drawn',
           'obsession', 'obsessed', 'obsess', 'erotic', 'sensual', 'craving',
           'crave', 'hunger', 'seduction', 'seduce', 'seduced', 'beauty',
           'beautiful', 'aesthetic', 'allure', 'picturesque', 'hedonistic'],

  delight: ['delight', 'joy', 'joyful', 'humour', 'humor', 'humorous', 'comic',
            'comedy', 'comedic', 'funny', 'wit', 'witty', 'laughter', 'laugh',
            'playful', 'amusing', 'amuse', 'exuberant', 'pleasure', 'charm',
            'charming'],

  exhilaration: ['exhilaration', 'exhilarating', 'thrill', 'thrilling',
                 'excitement', 'excited', 'exciting', 'urgent', 'urgency',
                 'propulsive', 'breathless', 'momentum', 'energy', 'energetic',
                 'vivid', 'intense', 'intensity', 'frenzy', 'frenzied']
});

// Built once: every (term + suffix) form, mapped back to its anchor.
// form → [{ id, base }], so a matched word can be traced to the term whose
// share was measured. `killed` and `kill` share one measurement.
const INDEX = new Map();
for (const [id, words] of Object.entries(FIELDS)) {
  for (const w of words) {
    for (const suffix of SUFFIXES) {
      const form = w + suffix;
      if (!INDEX.has(form)) INDEX.set(form, []);
      INDEX.get(form).push({ id, base: w });
    }
  }
}

/**
 * Words, with quotation marks stripped off the ends.
 *
 * Without the strip, `'completeness'` inside a quoted phrase tokenises as
 * `completeness'` and matches nothing. This corpus is encyclopaedia prose
 * that quotes constantly — "beauty is terror", "sickness with life", "he
 * fails at both" — so a tokeniser that cannot read a quoted word is a
 * tokeniser that cannot read the evidence.
 *
 * Internal apostrophes are kept: `Kurtz's` and `don't` are single tokens.
 */
export const tokensOf = (text) =>
  (String(text || '').toLowerCase().match(/[a-z][a-z'’-]*|['’][a-z][a-z'’-]*/g) || [])
    .map((t) => t.replace(/^['’]+|['’]+$/g, ''))
    .filter(Boolean);

/** Every anchor whose vocabulary appears in this text. */
export function fieldsIn(text) {
  const found = new Set();
  for (const t of tokensOf(text)) {
    for (const { id } of INDEX.get(t) || []) found.add(id);
  }
  return found;
}

/**
 * The strongest vote this text casts for one anchor.
 *
 * Max rather than sum: a sentence saying "death" three times is still one
 * sentence about a death, and summing would let repetition manufacture
 * coverage.
 */
export function voteFor(text, id, corpus = 'wikipedia') {
  let best = 0;
  for (const t of tokensOf(text)) {
    for (const e of INDEX.get(t) || []) {
      if (e.id === id) best = Math.max(best, voteOf(e.base, corpus));
    }
  }
  if (!best && phraseHit(tokensOf(text), id)) best = 1;
  return best;
}

const phraseHit = (tokens, id) => (PHRASES[id] || []).some((p) => {
  const want = p.split(' ');
  for (let i = 0; i + want.length <= tokens.length; i++) {
    if (want.every((w, k) => tokens[i + k] === w)) return true;
  }
  return false;
});

export const mentions = (text, id, corpus = 'wikipedia') => voteFor(text, id, corpus) > 0;

const SENTENCE = /(?<=[.!?]["']?)\s+(?=["'“]?[A-Z0-9])/;

/**
 * Full stops that are not sentence ends.
 *
 * A period followed by a space and a capital is USUALLY a sentence break and
 * is sometimes a title: `Mr. Utterson`, `Dr. Jekyll`, `St. Petersburg`,
 * `J. R. R. Tolkien`. Splitting on those made a single-sentence citation
 * about *Dr. Jekyll and Mr. Hyde* count as two, and the one-sentence rule
 * then rejected it however it was written — a book could be structurally
 * unable to carry a colour because of its own title.
 */
const ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|rev|hon|jr|sr|vs|etc|ie|eg|cf|ca|no|vol|ch|pp|ed|eds|trans|fig|approx)\.$/i;

/** `J.`, `R.` — an initial, which is never the end of a sentence. */
const INITIAL = /(?:^|\s)[A-Z]\.$/;

export function splitSentences(text) {
  const parts = String(text || '').split(SENTENCE);
  const out = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (ABBREVIATION.test(prev) || INITIAL.test(prev))) {
      out[out.length - 1] = `${prev} ${part}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

export const sentencesOf = (text) =>
  splitSentences(text).map((x) => x.trim()).filter((x) => x.length > 20);

/**
 * How much of a section is about one emotion.
 *
 * The replacement for term overlap with a single cited sentence. A sentence
 * counts when it uses that emotion's vocabulary at all — which is what makes
 * a cast list register as being about isolation seven times rather than once.
 */
export function coverage(sectionText, id, corpus = 'wikipedia') {
  const all = sentencesOf(sectionText);
  if (!all.length) return { sentences: 0, total: 0, share: 0 };
  // A weighted count of sentences: each contributes its strongest vote, so
  // forty sentences saying "killed" contribute less than four saying
  // "mourning". Still a sentence count, still legible as "N of M".
  const hits = all.reduce((n, s) => n + voteFor(s, id, corpus), 0);
  return { sentences: Math.round(hits * 100) / 100, total: all.length, share: hits / all.length };
}
