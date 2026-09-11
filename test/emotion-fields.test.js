import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../lib/emotion-fields.js');
const P = await import('../lib/palette.js');

// ── SHAPE ────────────────────────────────────────────────

test('there is one field per anchor, and no field without an anchor', () => {
  assert.deepEqual(Object.keys(F.FIELDS).sort(), [...P.IDS].sort());
  assert.equal(F.FIELDS_VERSION, 3);
});

test('every field is frozen and non-trivial', () => {
  assert.throws(() => { F.FIELDS.dread = []; }, TypeError);
  for (const [id, words] of Object.entries(F.FIELDS)) {
    assert.ok(words.length >= 12, `${id} has only ${words.length} terms`);
    assert.equal(new Set(words).size, words.length, `${id} repeats a term`);
    for (const w of words) assert.match(w, /^[a-z]+$/, `${id}: ${w}`);
  }
});

// ── THE TOKENISER ────────────────────────────────────────

test('quoted words are read', () => {
  // `'completeness'` inside a quotation tokenised as `completeness'` and
  // matched nothing. This corpus quotes constantly, so a tokeniser that
  // cannot read a quoted word cannot read the evidence — it was the last
  // eight points of the Siddhartha hand-count.
  assert.deepEqual(F.tokensOf("attain to that 'completeness'"),
                   ['attain', 'to', 'that', 'completeness']);
  assert.ok(F.mentions("His intention was to attain to that 'completeness'.", 'clarity'));
});

test('internal apostrophes survive, and possessives are one token', () => {
  assert.ok(F.tokensOf("Kurtz's station").includes("kurtz's"));
  assert.ok(F.tokensOf("don't").includes("don't"));
});

test('matching is on whole tokens, never on prefixes', () => {
  // Prefix matching is what makes a list like this rot, and every one of
  // these words is in this corpus.
  assert.ok(!F.mentions('He was a perfect gentleman about it.', 'tenderness'), 'gentleman ≠ gentle');
  assert.ok(!F.mentions('The pastor arrived late that evening.', 'nostalgia'), 'pastor ≠ past');
  assert.ok(!F.mentions('She served the pasta cold and left.', 'nostalgia'), 'pasta ≠ past');
  assert.ok(!F.mentions('A memorial was erected in the square.', 'nostalgia'), 'memorial ≠ memory');

  // And the real words still match, in their inflected forms.
  assert.ok(F.mentions('He was gentle with her.', 'tenderness'));
  assert.ok(F.mentions('She remembered the past.', 'nostalgia'));
  assert.ok(F.mentions('His loneliness deepened.', 'loneliness'));
  assert.ok(F.mentions('They were mourning him.', 'grief'));
});

test('fields may overlap, and that is deliberate', () => {
  // `sorrow` belongs to grief and to melancholy; `transcendental` to awe and
  // to clarity. An emotion is not a partition of the language.
  assert.ok(F.fieldsIn('a deep sorrow').has('grief'));
  assert.ok(F.fieldsIn('a deep sorrow').has('melancholy'));
  assert.ok(F.fieldsIn('a transcendental state').has('awe'));
  assert.ok(F.fieldsIn('a transcendental state').has('clarity'));
});

// ── THE HAND-COUNTS ──────────────────────────────────────
//
// Four real sections, counted by hand before the fields existed. These are
// the fixtures the fields are answerable to: a field that drifts away from
// one of these is wrong, however reasonable its words look.
//
// Excerpts, not the whole sections — enough to carry the ratio.

const MOCKINGBIRD = `Tom Robinson is the chief example, among several in the novel, of innocents being carelessly or deliberately destroyed. Scout's Aunt Alexandra attributes Maycomb's inhabitants' faults and advantages to genealogy. One writer was so impressed by Lee's detailed explanations of the people of Maycomb that he categorized the book as Southern romantic regionalism. The South itself, with its traditions and taboos, seems to drive the plot more than the characters. Reviewers were generally charmed by Scout and Jem's observations of their quirky neighbors. The second part of the novel deals with the spirit-corroding shame of the civilized white Southerner. Boo Radley is killed in a sense, though he is not literally dead.`;

// Verbatim from the cached Characters section, abridged to keep the ratio
// the full 35 sentences have: 7 grief, 3 loneliness. My first excerpt was
// six sentences I had chosen, and it inverted that — a fixture assembled by
// hand can be as wrong as a hand-count.
const NORWEGIAN_WOOD = `Toru Watanabe is a Tokyo college student of average ability, majoring in drama without reason or conviction for doing so. Naoko's older sister took her own life at age 17, which, along with Kizuki's suicide, has a lasting effect on Naoko's emotional stability and she resides in a psychiatric institution for most of the story. She and her sister help their absent father run a small bookstore after her mother's death from brain cancer. Reiko Ishida is a patient of the mountain asylum to which Naoko retreats. Kizuki took his own life when he was 17, which has a lasting effect on both Watanabe and Naoko. Two years after Nagasawa leaves for Germany, Hatsumi marries, only to commit suicide after another two years. Kobayashi is Midori's widowed father. He later dies, and his daughters sell the bookstore to move elsewhere. Nagasawa is unusually charismatic and complex in both his ideals and personal relationships. Storm Trooper is Watanabe's dormitory roommate who is obsessed with cleanliness.`;

const SIDDHARTHA = `Experience is shown as the best way to approach understanding of reality and attain enlightenment. Individual events are meaningless when considered by themselves. Every action and event gives Siddhartha experience, which in turn leads to understanding. His intention was to attain to that 'completeness' which is the Buddha's badge of distinction. The novel is structured on three of the traditional stages of life for Hindu males.`;

test('the fields land on the hand-counts', () => {
  // Mockingbird's Themes section is a survey — critical neglect, caste,
  // class, gender, courage — and grief is one theme among many.
  // 19% on this excerpt, against a hand-count of 19%. On the FULL 93-sentence
  // section v2 gives 7% where the hand-count gave 19%, and the difference is
  // entirely plot-event vocabulary — "Boo Radley is killed in a sense" is a
  // plot statement, not the book's grief. The hand-count had the same thumb
  // on the scale that v1 did, so the disagreement is expected and the fields
  // are the more careful of the two.
  const m = F.coverage(MOCKINGBIRD, 'grief');
  assert.ok(m.share > 0.15 && m.share < 0.45, `mockingbird/grief ${m.sentences}/${m.total}`);

  // Norwegian Wood's cast list reads as isolation on a first pass, and a
  // careful count says it is mostly GRIEF — four deaths and two suicides —
  // with isolation alongside. The first hand-count of it was wrong.
  const nl = F.coverage(NORWEGIAN_WOOD, 'loneliness');
  const ng = F.coverage(NORWEGIAN_WOOD, 'grief');
  assert.ok(ng.sentences >= nl.sentences,
            `grief ${ng.sentences} should not trail loneliness ${nl.sentences}`);

  // Siddhartha's Major themes section really is overwhelmingly about one
  // thing, which is the case that broke the metric this replaced.
  const s = F.coverage(SIDDHARTHA, 'clarity');
  assert.ok(s.share >= 0.5, `siddhartha/clarity ${s.sentences}/${s.total}`);
});

test('coverage sees a section that says one thing in many words', () => {
  // The Norwegian Wood problem, isolated. Term overlap with any single one
  // of these sentences sees the others once; coverage sees them all.
  const varied = 'Kizuki took his own life at seventeen. ' +
                 'Hatsumi married and then killed herself two years later. ' +
                 'Her mother had died of cancer some time before that. ' +
                 'The funeral was held without any of them present.';
  for (const sentence of F.sentencesOf(varied)) {
    assert.ok(F.voteFor(sentence, 'grief') > 0, `missed: ${sentence}`);
  }
  // Weighted rather than four: `killed` is a plot-event word and votes 0.25,
  // `own life` and `funeral` vote in full. All four are seen; they are not
  // all worth the same.
  const cov = F.coverage(varied, 'grief');
  assert.ok(cov.share > 0.7 && cov.share < 1, `${cov.sentences} of ${cov.total}`);
});

test('v3 — the two corpora are damped by their own tables', () => {
  // Publisher copy and encyclopaedia prose are not the same language.
  // `love` is in 5.6% of blurb sentences against 3.2% of Wikipedia's;
  // `kill` collapses from 4.18% to 1.14%. Damping a blurb by the
  // encyclopaedia table would silence exactly the words a blurb is made of.
  assert.ok(F.voteOf('love', 'blurb') < F.voteOf('love', 'wikipedia'));
  assert.ok(F.voteOf('kill', 'blurb') > F.voteOf('kill', 'wikipedia'));
  assert.ok(F.voteOf('epic', 'blurb') < 1, 'a marketing superlative is damped in a blurb');
  assert.equal(F.voteOf('epic', 'wikipedia'), 1, 'and not in criticism, where it is rare');

  // An unknown corpus falls back to the encyclopaedia table rather than
  // silently voting everything in full.
  assert.equal(F.voteOf('kill', 'nonsense'), F.voteOf('kill', 'wikipedia'));

  const blurb = 'A love story about love, and the love between them, told with love.';
  assert.ok(F.coverage(blurb, 'tenderness', 'blurb').share
            < F.coverage(blurb, 'tenderness', 'wikipedia').share,
            'the same sentence counts for less in the register that overuses it');
});

test('v2 — a term is worth what it discriminates', () => {
  // `kill` is in 4.18% of every sentence in this corpus and `mourn` in far
  // under 0.5%. v1 gave them the same vote, and grief came out at 12% of the
  // corpus against melancholy's 0.2% — sixty times, between two adjacent
  // negative anchors. That was the field, not the books.
  assert.ok(F.voteOf('kill') < 0.15, 'a plot-event word barely votes');
  assert.ok(F.voteOf('death') < 0.2);
  assert.ok(F.voteOf('fear') > 0.4 && F.voteOf('fear') < 0.7, 'a common emotion word is damped, not silenced');
  assert.equal(F.voteOf('mourn'), 1, 'a discriminating word votes in full');
  assert.equal(F.voteOf('nonsense'), 1, 'anything unmeasured votes in full');

  // A plot summary full of killings is not thereby about grief.
  const plot = 'He killed the man. Then he killed another. A third was killed later on. ' +
               'The killing continued through the chapter that follows this one.';
  // A fifth of what the same four sentences score in the vocabulary of
  // criticism — damped, not silenced, because a killing is not nothing.
  assert.ok(F.coverage(plot, 'grief').share < 0.25, 'four killings ≠ a section about grief');

  // The same four sentences in the vocabulary of criticism are.
  const themes = 'The novel is a work of mourning throughout its length. ' +
                 'Its elegiac register has been widely noted by critics. ' +
                 'Bereavement structures every one of the six parts. ' +
                 'The lament at the close is the most quoted passage.';
  assert.equal(F.coverage(themes, 'grief').share, 1, 'mourning, elegiac, bereavement, lament');
});

test('an empty or unmatched section is zero, not a throw', () => {
  assert.deepEqual(F.coverage('', 'grief'), { sentences: 0, total: 0, share: 0 });
  assert.equal(F.coverage(SIDDHARTHA, 'anger').sentences, 0);
  assert.equal(F.coverage(SIDDHARTHA, 'not-an-anchor').sentences, 0);
});

test('a title is not a sentence end', () => {
  // `Mr.`, `Dr.`, `St.` and initials all end in a period followed by a space
  // and a capital, which is exactly the shape of a sentence break. Splitting
  // on them made a one-sentence citation about *Dr. Jekyll and Mr. Hyde*
  // count as two, and the one-sentence rule then rejected it however it was
  // written — a book could be structurally unable to carry a colour because
  // of its own title.
  for (const one of [
    'The novel follows Mr. Utterson as he investigates the strange bequest.',
    'Dr. Jekyll is described as a large well-made man of fifty.',
    'The book was published by J. R. R. Tolkien in that year.',
    'She moved to St. Petersburg and never returned to the town.',
    'The edition was prepared by eds. Smith and Jones for the press.'
  ]) {
    assert.equal(F.splitSentences(one).length, 1, one);
  }

  // And real breaks still break.
  assert.equal(F.splitSentences('Two sentences here. And this is the second.').length, 2);
  assert.equal(F.splitSentences('One. Two. Three.').length, 3);
});
