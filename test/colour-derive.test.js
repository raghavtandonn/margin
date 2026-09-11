import test from 'node:test';
import assert from 'node:assert/strict';

const D = await import('../lib/colour-derive.js');
const E = await import('../lib/colour-evidence.js');
const FIELDS = await import('../lib/emotion-fields.js');

// A pinned section, so every test below runs offline against fixed text.
// This is the shape §2b of the plan asks for: the fixture is the source, and
// the assertions are about the REASONING, not about which colour came back.
const STONER_THEMES = {
  heading: 'Themes',
  text: `The novel has been described as a study of endurance. Stoner's marriage
to Edith is presented as a long defeat which he does not resist, and his
affair with Katherine Driscoll is ended by institutional pressure rather
than by either of them. Critics have noted the recurring image of the
unopened book in his hands at the end, and the way his teaching becomes the
only sphere in which he acts.`
};
const STONER_PLOT = {
  heading: 'Plot',
  text: `William Stoner enrols at the University of Missouri in 1910 to study
agriculture, and switches to English literature. He marries Edith, has a
daughter named Grace, and remains at the university until his death.`
};
const SECTIONS = [STONER_PLOT, STONER_THEMES];

// One well-formed component, so a test can vary exactly one thing.
const part = (o) => ({ id: 'grief', weight: 5, section: 'Themes',
  evidence: "Stoner's marriage to Edith is presented as a long defeat which he does not resist.",
  ...o });

const second = (o) => ({ id: 'nostalgia', weight: 3, section: 'Themes',
  evidence: 'Critics have noted the recurring image of the unopened book in his hands at the end.',
  ...o });

/** The validator takes a whole reply; most tests care about one component. */
const check = (parts, sections = SECTIONS) =>
  D.validate({ components: parts }, { sections });

const onlyThis = (c, sections = SECTIONS) => D.validateComponent(c, { sections }, c.id || '?');

// ── ELIGIBILITY: the gate before the model ───────────────

test('plot alone IS eligible — the gate came off, and the reason matters', () => {
  // It took the run from 67% to 39%, and the number was not the problem:
  // Heart of Darkness, White Nights, Do Androids Dream and Lie With Me all
  // hatched because of how their articles happen to be organised. The bias
  // is structural — plot-only articles cluster on shorter, more recent and
  // translated fiction — so the gate hatched contemporary work and passed
  // the canon.
  const fit = E.eligibility([{ heading: 'Plot', text: 'x'.repeat(4000) }]);
  assert.equal(fit.ok, true);
  assert.equal(fit.plotOnly, true, 'still reported, because the audit needs it');
});

test('an interpretive section is recorded when there is one', () => {
  const fit = E.eligibility(SECTIONS);
  assert.equal(fit.ok, true);
  assert.equal(fit.plotOnly, false);
  assert.deepEqual(fit.interpretive, ['Themes']);
});

test('thin still hatches, whatever the section is', () => {
  assert.match(E.eligibility([{ heading: 'Themes', text: 'It is sad.' }]).reason, /thin/);
  assert.match(E.eligibility([{ heading: 'Plot', text: 'It is sad.' }]).reason, /thin/);
});

test('nothing retrieved hatches, and distinguishes the two ways it can', () => {
  // A misspelled catalogue title and a book nobody has analysed both hatch,
  // and only one of them is worth going and fixing.
  // Both messages predate the blurb being a source, so neither says
  // "article" any more — Wikipedia is not the only place we look.
  assert.match(E.eligibility([], { article: null }).reason, /no article and no description/);
  assert.match(E.eligibility([], { article: 'Stoner (novel)' }).reason,
               /nothing about the book in either source/);
  assert.equal(E.eligibility([]).ok, false);
});

test('the interpretive set is the sections that say what a book is doing', () => {
  for (const h of ['Themes', 'Style', 'Analysis', 'Characters', 'Themes and style']) {
    assert.ok(E.isInterpretive(h), `${h} should count`);
  }
  for (const h of ['Plot', 'Plot summary', 'Synopsis', 'Publication']) {
    assert.ok(!E.isInterpretive(h), `${h} should not`);
  }
});

// ── THE VALIDATOR ────────────────────────────────────────

test('a grounded, concrete, interpretive blend passes', () => {
  const out = check([part(), second()]);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.equal(out.components.length, 2);
  // Renormalised: 5 and 3 become 0.625 and 0.375.
  assert.equal(out.components[0].weight.toFixed(3), '0.625');
  assert.equal(out.components.reduce((n, c) => n + c.weight, 0).toFixed(6), '1.000000');
});

test('one emotion is not an answer', () => {
  const out = check([part()]);
  assert.ok(out.problems.some((p) => /only 1 of 1 components survived/.test(p)),
            out.problems.join(' / '));
});

test('the same emotion twice is one emotion with its weight split', () => {
  // And it would quietly double that anchor's pull on the blend.
  const out = check([part(), part({ weight: 2 })]);
  assert.ok(out.problems.some((p) => /grief is named twice/.test(p)));
});

test('the cap is hard at three, and weights renormalise over what survives', () => {
  const raw = [
    { id: 'grief', weight: 4 }, { id: 'nostalgia', weight: 3 },
    { id: 'calm', weight: 2 }, { id: 'awe', weight: 1 }
  ];
  const out = D.capAndNormalise(raw);
  assert.equal(out.length, 3, 'four anchors averaged sit near the palette centroid, which is a mid brown');
  assert.deepEqual(out.map((c) => c.id), ['grief', 'nostalgia', 'calm']);
  assert.equal(out.reduce((n, c) => n + c.weight, 0).toFixed(6), '1.000000',
               'the dropped weight is redistributed, not left as a hole');
  assert.equal(out[0].weight.toFixed(4), (4 / 9).toFixed(4));
});

test('a zero or negative weight drops the component rather than the answer', () => {
  const out = D.capAndNormalise([{ id: 'grief', weight: 5 }, { id: 'calm', weight: 0 }]);
  assert.deepEqual(out.map((c) => c.id), ['grief']);
});

test('every component is grounded on its own, and a bad one is dropped', () => {
  // A blend must not smuggle an ungrounded emotion in behind two good ones.
  // Under partial acceptance the ungrounded one is DROPPED rather than
  // taking the book down with it — every survivor is still fully checked.
  const out = check([part(), second(), {
    id: 'calm', weight: 2, section: 'Themes',
    evidence: 'Stoner serves as a mentor while the First World War empties the Missouri campus.'
  }]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.components.map((c) => c.id), ['grief', 'nostalgia']);
  assert.deepEqual(out.dropped, ['calm']);
  assert.equal(out.components.reduce((n, c) => n + c.weight, 0).toFixed(6), '1.000000',
               'the dropped weight is redistributed');
});

test('a card dies when fewer than two components survive', () => {
  // Partial acceptance has a floor. One surviving component is not a blend,
  // it is the single-emotion model this amendment replaced.
  const bad = (id) => ({ id, weight: 3, section: 'Themes',
    evidence: 'Stoner serves as a mentor while the First World War empties the Missouri campus.' });
  const out = check([part(), bad('calm'), bad('awe')]);
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => /only 1 of 3 components survived/.test(p)), out.problems.join(' / '));
  // And it says what actually went wrong, not just the count.
  assert.ok(out.problems.some((p) => /not in the source/.test(p)));
});

test('the heaviest SURVIVOR faces the interpretive rule, not the heaviest sent', () => {
  // Attrition must not be able to make a book's primary colour plot-anchored:
  // if the heaviest component is dropped, whatever inherits its place is
  // checked in its stead.
  const out = check([
    { id: 'awe', weight: 9, section: 'Themes',    // heaviest, and ungrounded → dropped
      evidence: 'Stoner serves as a mentor while the First World War empties the Missouri campus.' },
    { id: 'nostalgia', weight: 5, section: 'Plot', // inherits the top slot
      evidence: 'He marries Edith, has a daughter named Grace, and remains at the university until his death.' },
    second({ id: 'calm', weight: 1 })
  ]);
  assert.ok(out.problems.some((p) => /heaviest component/.test(p)),
            `attrition promoted a plot component unchecked: ${JSON.stringify(out.problems)}`);
});

test('a colour outside the twenty is rejected', () => {
  assert.ok(onlyThis(part({ id: 'ochre' })).some((p) => /not a palette id/.test(p)));
});

test('a component with no weight is rejected', () => {
  assert.ok(onlyThis(part({ weight: 0 })).some((p) => /no WEIGHT/.test(p)));
});

test('rule 3 — anything not in the cited section is rejected, however true', () => {
  const out = onlyThis(part({
    evidence: 'Stoner serves as a mentor while the First World War empties the Missouri campus.'
  }));
  assert.ok(out.some((p) => /not in the source/.test(p)), out.join(' / '));
});

test('a section that was never supplied is rejected', () => {
  assert.ok(onlyThis(part({ section: 'Reception' }))
    .some((p) => /was not one of the sections supplied/.test(p)));
});

// ── THE INTERPRETIVE RULE, APPLIED TO THE HEAVIEST ONLY ──
//
// Guard against this quietly becoming "leave it": the heaviest component
// carries the book's primary colour, and if THAT comes from plot the book
// can be turned into its scenery. The tail cannot.

test('the HEAVIEST component may not cite Plot when the article has better', () => {
  const out = check([
    part({ section: 'Plot', weight: 8,
           evidence: 'William Stoner enrols at the University of Missouri and switches to English literature.' }),
    second({ weight: 2 })
  ]);
  assert.ok(out.problems.some((p) => /heaviest component/.test(p)), out.problems.join(' / '));
});

test('a LIGHTER component may cite Plot — it shifts the hue, it cannot carry the book', () => {
  const out = check([
    part({ weight: 8 }),                       // Themes, and heaviest
    { id: 'nostalgia', weight: 2, section: 'Plot',
      evidence: 'He marries Edith, has a daughter named Grace, and remains at the university until his death.' }
  ]);
  assert.deepEqual(out.problems, []);
  assert.equal(out.components[0].id, 'grief');
});

test('the rule follows the weight, not the order it was written in', () => {
  // A plot component listed first but weighted lightest is fine; the same
  // component weighted heaviest is not.
  const light = check([
    { id: 'nostalgia', weight: 1, section: 'Plot',
      evidence: 'He marries Edith, has a daughter named Grace, and remains at the university until his death.' },
    part({ weight: 9 })
  ]);
  assert.deepEqual(light.problems, []);

  const heavy = check([
    { id: 'nostalgia', weight: 9, section: 'Plot',
      evidence: 'He marries Edith, has a daughter named Grace, and remains at the university until his death.' },
    part({ weight: 1 })
  ]);
  assert.ok(heavy.problems.some((p) => /heaviest component/.test(p)));
});

test('citing Plot is allowed anywhere when plot is all there is', () => {
  const plotOnly = [{
    heading: 'Plot',
    text: `Rick Deckard is assigned to retire six escaped androids. He owns an
electric sheep and covets a real animal. The novel ends with him finding a
toad in the desert, which his wife discovers is electric.`
  }];
  const out = check([
    { id: 'loneliness', weight: 7, section: 'Plot',
      evidence: 'Deckard owns an electric sheep and covets a real animal, and the toad he finds is electric too.' },
    { id: 'disorientation', weight: 3, section: 'Plot',
      evidence: 'Rick Deckard is assigned to retire six escaped androids in the novel.' }
  ], plotOnly);
  assert.deepEqual(out.problems, []);
});

test('setting as the reason is rejected even when grounded', () => {
  const sections = [{
    heading: 'Themes',
    text: 'The novel is set in the deep desert, and critics have noted the harshness of the landscape throughout the work.'
  }];
  const out = onlyThis({
    id: 'nostalgia', weight: 4, section: 'Themes',
    evidence: 'The novel is set in the deep desert, and the landscape is harsh throughout.'
  }, sections);
  assert.ok(out.some((p) => /reasons from setting/.test(p)), out.join(' / '));
});

test('the frames catch every phrasing that claims setting as the reason', () => {
  const sections = [{
    heading: 'Themes',
    text: `The work is set against the long winter and takes place over six parts.
Critics note the landscape, the atmosphere of the frozen passes, and the
backdrop of the war throughout.`
  }];
  for (const evidence of [
    'The work is set against the long winter and runs over six parts of the book.',
    'The story takes place over six parts, and the frozen passes recur throughout.',
    'Critics note the landscape recurs across all six parts of the long winter work.',
    'The atmosphere of the frozen passes is noted by critics throughout the work.',
    'The backdrop of the war is noted by critics across all six parts of the work.'
  ]) {
    const out = onlyThis({ id: 'desolation', weight: 4, section: 'Themes', evidence }, sections);
    assert.ok(out.some((p) => /reasons from setting/.test(p)), `not caught: ${evidence}`);
  }
});

test('a recurring object that happens to be a place is NOT setting', () => {
  const sections = [{
    heading: 'Themes',
    text: 'The harbour recurs in each of the dreams Tsukuru reports, and is the only image the novel repeats.'
  }];
  const out = onlyThis({
    id: 'melancholy', weight: 4, section: 'Themes',
    evidence: 'The harbour recurs in each of the dreams Tsukuru reports across the novel.'
  }, sections);
  assert.deepEqual(out, []);
});

test('a theme statement that names nothing is rejected', () => {
  const sections = [{
    heading: 'Themes',
    text: 'The novel explores themes of isolation and disappointment across its length, critics have written.'
  }];
  const out = onlyThis({
    id: 'loneliness', weight: 4, section: 'Themes',
    evidence: 'The novel explores themes of isolation and disappointment across its length.'
  }, sections);
  assert.ok(out.some((p) => /states a theme rather than naming anything/.test(p)));
});

test('one sentence — a true citation can still be useless', () => {
  const sections = [{
    heading: 'Themes',
    text: 'Stoner fails at both. Love is also a widely recognized theme in Stoner. The novel representation of love moves beyond romance.'
  }];
  const out = onlyThis({
    id: 'grief', weight: 4, section: 'Themes',
    evidence: '"he fails at both." Love is also a widely recognized theme in Stoner. The novel representation of love moves beyond romance.'
  }, sections);
  assert.ok(out.some((p) => /3 sentences/.test(p)), out.join(' / '));
});

test('embedded quotations are not sentence ends', () => {
  const sections = [{
    heading: 'Form and themes',
    text: 'Euripides characterization of Medea exhibits the inner emotions of passion, love, and vengeance and she becomes the personification of vengeance, with her humanity mortified.'
  }];
  const out = onlyThis({
    id: 'anger', weight: 4, section: 'Form and themes',
    evidence: 'Euripides characterization of Medea exhibits the inner emotions of passion, love, and vengeance and she becomes the personification of vengeance.'
  }, sections);
  assert.deepEqual(out, []);
});

test('a verbatim quotation is grounded by definition', () => {
  const out = onlyThis(part({
    evidence: "Stoner's marriage\nto Edith is presented as a long defeat which he does not resist"
  }));
  assert.deepEqual(out, [], 'whitespace and line breaks do not break a quotation');
});

test('INSUFFICIENT is an answer, not a failure', () => {
  const out = D.validate({ insufficient: true }, { sections: SECTIONS });
  assert.equal(out.ok, false);
  assert.equal(out.insufficient, true);
  assert.deepEqual(out.problems, []);
});

test('an empty or shapeless reply is named rather than crashed on', () => {
  assert.equal(D.validate(null, {}).ok, false);
  assert.ok(D.validate({ components: [] }, { sections: SECTIONS }).problems.includes('no components'));
  assert.ok(onlyThis(part({ evidence: null })).includes('grief: no EVIDENCE'));
});

test('the evidence has to be a sentence, not a fragment or an essay', () => {
  assert.ok(onlyThis(part({ evidence: 'A long defeat.' })).some((p) => /too short/.test(p)));

  const fortyFour = ("Stoner's marriage to Edith is presented as a long defeat which he does not " +
                     'resist and his affair with Katherine Driscoll is ended by institutional ' +
                     'pressure rather than by either of them.');
  assert.ok(!onlyThis(part({ evidence: fortyFour })).some((p) => /too long/.test(p)));

  const essay = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  assert.ok(onlyThis(part({ evidence: essay })).some((p) => /too long/.test(p)));
});

// ── THE WEIGHTS, AGAINST THE SOURCE ──────────────────────
//
// The weight used to be the one number nothing checked: a card could quote a
// real line and put any figure beside it. Everything downstream rests on
// these — the blend, the name's second slot, the composition percentages on
// the lookbook — so they are the last place a card should be allowed to
// guess. Measured against 34 real cards, 13 of them had a dominant weight
// the source did not support.

// Built for the FIELDS, not for term overlap: the sentences have to carry
// each emotion's own vocabulary, because that is what coverage counts now.
const LONG = {
  heading: 'Themes',
  text: Array.from({ length: 20 }, (_, i) =>
    `Critics have written about the loneliness and isolation of the narrator in chapter ${i + 1}.`)
    .concat(['A single sentence notes the nostalgia of one remembered childhood afternoon.'])
    .join(' ')
};

test('a moderate claim on well-covered support passes', () => {
  const moderate = check([
    { id: 'loneliness', weight: 5, section: 'Themes',
      evidence: 'Critics have written about the loneliness and isolation of the narrator in chapter 4.' },
    { id: 'nostalgia', weight: 4, section: 'Themes',
      evidence: 'A single sentence notes the nostalgia of one remembered childhood afternoon.' }
  ], [LONG]);
  assert.deepEqual(moderate.problems, []);
});

test('a large claim on one covered sentence is still caught', () => {
  const out = check([
    { id: 'nostalgia', weight: 8, section: 'Themes',
      evidence: 'A single sentence notes the nostalgia of one remembered childhood afternoon.' },
    { id: 'loneliness', weight: 2, section: 'Themes',
      evidence: 'Critics have written about the loneliness and isolation of the narrator in chapter 3.' }
  ], [LONG]);
  assert.ok(out.problems.some((p) => /weighted heaviest at 80% but only 1 of/.test(p)),
            out.problems.join(' / '));
});

test('a short section is exempt by share — one sentence in four is a quarter of it', () => {
  // The floor is absolute OR proportional, because a four-sentence Style
  // section has no room to say anything twice.
  const short = { heading: 'Style', text:
    'The prose is built from very long sentences throughout the book. ' +
    'The chapters alternate between two narrators in strict order. ' +
    'A refrain closes each of the six parts of the novel. ' +
    'The translator kept the original punctuation entirely.' };
  const out = check([
    { id: 'wonder', weight: 7, section: 'Style',
      evidence: 'A refrain closes each of the six parts of the novel.' },
    { id: 'calm', weight: 3, section: 'Style',
      evidence: 'The chapters alternate between two narrators in strict order.' }
  ], [short]);
  assert.ok(!out.problems.some((p) => /weighted heaviest/.test(p)), out.problems.join(' / '));
});

// Twelve sentences on one thing, four on another: both sides clear the
// three-sentence floor, so they can actually be compared.
const LOPSIDED = {
  heading: 'Themes',
  text: Array.from({ length: 12 }, (_, i) =>
    `Critics have written about the loneliness and isolation of the narrator in chapter ${i + 1}.`)
    .concat(Array.from({ length: 4 }, (_, i) =>
      `A remembered childhood scene returns with some nostalgia in part ${i + 1} of it.`))
    .join(' ')
};

test('inversion is compared within one section only', () => {
  // The undercount factor varies by section — a Characters section
  // undercounts far worse than a Themes section, because it says the same
  // thing once per character in different words. Comparing supports across
  // two sections compares two different rulers.
  const twoSections = [LOPSIDED, {
    heading: 'Characters',
    text: 'Kizuki took his own life at seventeen, which marked both of them. ' +
          'Hatsumi married and then took her own life two years afterwards. ' +
          'Reiko had endured lifelong mental problems that wrecked her career. ' +
          'Naoko resides in a psychiatric institution for most of the story.'
  }];
  const across = check([
    { id: 'nostalgia', weight: 8, section: 'Characters',
      evidence: 'Naoko resides in a psychiatric institution for most of the story.' },
    { id: 'loneliness', weight: 2, section: 'Themes',
      evidence: 'Critics have written about the loneliness of the narrator in the work.' }
  ], twoSections);
  assert.ok(!across.problems.some((p) => /discussed far more/.test(p)),
            `two sections, two rulers: ${across.problems.join(' / ')}`);
});

test('a clear inversion within one section is still caught', () => {
  const out = check([
    { id: 'nostalgia', weight: 8, section: 'Themes',
      evidence: 'A remembered childhood scene returns with some nostalgia in part 2 of it.' },
    { id: 'loneliness', weight: 2, section: 'Themes',
      evidence: 'Critics have written about the loneliness and isolation of the narrator in chapter 3.' }
  ], [LOPSIDED]);
  assert.ok(out.problems.some((p) => /discussed far more/.test(p)), out.problems.join(' / '));
  assert.ok(!out.problems.some((p) => /weighted heaviest at/.test(p)),
            'the floor is clear — this is the comparison, not the floor');

  // Both sides need at least three supporting sentences. One against one is
  // noise, and a rule that ranked it would be the noun census again.
  const thin = {
    heading: 'Themes',
    text: 'The loneliness of the narrator is noted once by critics of the work. ' +
          'The recurring image of the unopened book returns at the very end of it. ' +
          'The translator kept the original punctuation throughout the whole book. ' +
          'The chapters alternate between two narrators in a strict repeating order.'
  };
  const noise = check([
    { id: 'nostalgia', weight: 8, section: 'Themes',
      evidence: 'The recurring image of the unopened book returns at the very end of it.' },
    { id: 'loneliness', weight: 2, section: 'Themes',
      evidence: 'The loneliness of the narrator is noted once by critics of the work.' }
  ], [thin]);
  assert.ok(!noise.problems.some((p) => /discussed far more/.test(p)),
            `one against one is not a ranking: ${noise.problems.join(' / ')}`);
});

test('comparable support with different weights is not an inversion', () => {
  const even = check([
    { id: 'loneliness', weight: 7, section: 'Themes',
      evidence: 'Critics have written about the loneliness and isolation of the narrator in chapter 2.' },
    { id: 'nostalgia', weight: 3, section: 'Themes',
      evidence: 'A remembered childhood scene returns with some nostalgia in part 1 of it.' }
  ], [LOPSIDED]);
  assert.deepEqual(even.problems, []);
});

test('a well-supported blend reports its support alongside its components', () => {
  const out = check([
    { id: 'loneliness', weight: 7, section: 'Themes',
      evidence: 'Critics have written about the loneliness and isolation of the narrator in chapter 6.' },
    { id: 'nostalgia', weight: 3, section: 'Themes',
      evidence: 'A single sentence notes the nostalgia of one remembered childhood afternoon.' }
  ], [LONG]);
  assert.equal(out.ok, true);
  assert.equal(out.support.length, 2);
  assert.equal(out.support[0].id, 'loneliness');
  assert.ok(out.support[0].sentences > 0);
  assert.equal(out.fieldsVersion, 3, 'the card records which fields measured it');
});

test('a weight failure is told what a weight means', () => {
  const msg = D.retryMessage(['grief: grief is weighted heaviest at 80% but only 1 of 40 sentences discuss it']);
  assert.match(msg, /how much of the cited section is about that emotion/);
  assert.match(msg, /not\s*\n?how strongly it reads|how strongly it reads/);
});

test('the heaviest component must come from the best class the book HAS', () => {
  // Not the best class in the abstract. A book with only a publisher's
  // description would otherwise never carry a colour, and those are most of
  // the library — 271 of 411 have a blurb, 52 have a usable Wikipedia
  // section.
  const blurbOnly = [{
    heading: 'Publisher description',
    text: 'A novel of mourning, written after the death of the narrator\'s father. ' +
          'Its grief is carried in the smallest domestic detail. ' +
          'It is also a study of tenderness and quiet devotion between them. ' +
          'The affection in it survives everything the bereavement takes away.'
  }];
  const ok = check([
    { id: 'grief', weight: 7, section: 'Publisher description',
      evidence: 'A novel of mourning, written after the death of the narrator\'s father.' },
    { id: 'tenderness', weight: 3, section: 'Publisher description',
      evidence: 'It is also a study of tenderness and quiet devotion between them.' }
  ], blurbOnly);
  assert.deepEqual(ok.problems, [], 'the blurb is the best class this book has');

  // But where the article HAS an interpretive section, the blurb is not
  // good enough for the heaviest component.
  const both = [...SECTIONS, blurbOnly[0]];
  const demoted = check([
    { id: 'grief', weight: 7, section: 'Publisher description',
      evidence: 'A novel of mourning, written after the death of the narrator\'s father.' },
    { id: 'nostalgia', weight: 3, section: 'Themes',
      evidence: 'Critics have noted the recurring image of the unopened book in his hands at the end.' }
  ], both);
  assert.ok(demoted.problems.some((p) => /heaviest component/.test(p)), demoted.problems.join(' / '));
});

test('a blurb is damped by the blurb table, not by the encyclopaedia one', () => {
  // `love` is in 5.6% of blurb sentences and 3.2% of Wikipedia's; `kill` is
  // in 1.1% of blurbs and 4.2% of Wikipedia. Damping publisher copy by the
  // encyclopaedia table would silence exactly the words a blurb is made of.
  const F = FIELDS;
  assert.ok(F.voteOf('love', 'blurb') < F.voteOf('love'), 'love is cheaper in a blurb');
  assert.ok(F.voteOf('kill', 'blurb') > F.voteOf('kill'), 'a killing is rarer in one');
});

// ── THE PLOT-ONLY FIXTURES ───────────────────────────────
//
// The hard cases. A plot summary is where a model goes looking for
// atmosphere when nobody has written it a Themes section, so these assert
// the REASONING: the same anchor passes or fails depending only on what it
// was drawn from.

const HEART_OF_DARKNESS = [{
  heading: 'Plot',
  text: `Marlow travels up the river in a battered steamer toward the Inner
Station, which is oppressive and thick with fog. At the Inner Station he
finds the fence posts topped with severed heads, and Kurtz dying in the
cabin. Kurtz has written a report on civilising the region and scrawled
"Exterminate all the brutes" across its last page. Marlow later lies to
Kurtz's Intended about his last words.`
}];

test('Heart of Darkness — the Inner Station passes, the river does not', () => {
  const yes = onlyThis({
    id: 'dread', weight: 5, section: 'Plot',
    evidence: 'The fence posts at the Inner Station are topped with severed heads, and Kurtz scrawled "Exterminate all the brutes" across his report.'
  }, HEART_OF_DARKNESS);
  assert.deepEqual(yes, [], 'what happens at the Inner Station is evidence');

  const no = onlyThis({
    id: 'dread', weight: 5, section: 'Plot',
    evidence: 'The river toward the Inner Station is oppressive and thick with fog.'
  }, HEART_OF_DARKNESS);
  assert.ok(no.some((p) => /reasons from setting/.test(p)),
            `the same anchor, for the wrong reason: ${no.join(' / ')}`);
});

const ANDROIDS = [{
  heading: 'Plot',
  text: `The dust-covered city is bleak and mostly abandoned after the war.
Rick Deckard owns an electric sheep and covets a real animal. He uses the
Voigt-Kampff test, which measures empathy, to distinguish androids from
people, and grips the handles of a Mercer empathy box to share the suffering
of a stranger. He retires six androids in a day and finds a toad in the
desert that turns out to be electric.`
}];

test('Do Androids Dream — the empathy box passes, the dust does not', () => {
  const yes = onlyThis({
    id: 'loneliness', weight: 5, section: 'Plot',
    evidence: 'Deckard grips the handles of a Mercer empathy box to share the suffering of a stranger.'
  }, ANDROIDS);
  assert.deepEqual(yes, [], 'a recurring object is evidence');

  const no = onlyThis({
    id: 'desolation', weight: 5, section: 'Plot',
    evidence: 'The dust-covered city is bleak and mostly abandoned after the war.'
  }, ANDROIDS);
  assert.ok(no.some((p) => /reasons from setting/.test(p)), no.join(' / '));
});

test('the desert in Dune is not the reason, whatever the anchor', () => {
  const dune = [{
    heading: 'Plot',
    text: `Paul Atreides drinks the Water of Life and gains prescient visions
of a jihad carried out in his name across the desert planet, which is arid
and hostile. He foresees billions dead and cannot find a path that avoids it.`
  }];
  const yes = onlyThis({
    id: 'dread', weight: 5, section: 'Plot',
    evidence: 'Paul gains prescient visions of a jihad in his name and cannot find a path that avoids it.'
  }, dune);
  assert.deepEqual(yes, [], 'the visions are the evidence');

  const no = onlyThis({
    id: 'dread', weight: 5, section: 'Plot',
    evidence: 'The desert planet is arid and hostile across the whole of the book.'
  }, dune);
  assert.ok(no.some((p) => /reasons from setting/.test(p)), no.join(' / '));
});

// ── PARSING ──────────────────────────────────────────────

test('blocks parse, with or without blank lines between them', () => {
  const out = D.parseReply(`COLOUR: grief
WEIGHT: 6
SECTION: Themes
EVIDENCE: A long defeat he does not resist.

COLOUR: nostalgia
WEIGHT: 3
SECTION: Themes
EVIDENCE: The recurring image of the unopened book.`);

  assert.equal(out.components.length, 2);
  assert.deepEqual(out.components.map((c) => c.id), ['grief', 'nostalgia']);
  assert.equal(out.components[0].weight, 6);
  assert.equal(out.components[1].section, 'Themes');

  // Run together, no blank line — split is on the COLOUR line, not on gaps.
  const tight = D.parseReply(
    'COLOUR: grief\nWEIGHT: 6\nSECTION: Themes\nEVIDENCE: a\nCOLOUR: calm\nWEIGHT: 1\nSECTION: Themes\nEVIDENCE: b');
  assert.equal(tight.components.length, 2);
});

test('INSUFFICIENT parses, and noise does not pretend to', () => {
  assert.equal(D.parseReply('INSUFFICIENT').insufficient, true);
  assert.equal(D.parseReply('  insufficient  ').insufficient, true);
  assert.equal(D.parseReply(''), null);
  assert.equal(D.parseReply('Sure! Here are the colours.'), null);
});

test('the parser survives a model that copies the row it was shown', () => {
  // Both were real answers. Both were thrown away by the parser rather than
  // by any rule: a valid choice flattened to an unknown id, and a heading
  // rejected for carrying the markers the prompt had shown it in.
  const a = D.parseReply('COLOUR: melancholy Melancholy — Indigo, Washed\nWEIGHT: 4\nSECTION: Themes\nEVIDENCE: x');
  assert.equal(a.components[0].id, 'melancholy');

  const b = D.parseReply('COLOUR: dread\nWEIGHT: 4\nSECTION: == Analysis ==\nEVIDENCE: x');
  assert.equal(b.components[0].section, 'Analysis');
});

// ── THE RETRY ────────────────────────────────────────────

test('a grounding failure is told that inventing is the problem', () => {
  const msg = D.retryMessage(['calm: not in the source: mentor, war']);
  assert.match(msg, /not in the sections you were given/);
  assert.match(msg, /Do not write from/);
});

test('a setting failure is told that setting is not an answer', () => {
  assert.match(D.retryMessage(['dread: evidence reasons from setting']),
               /Where and when the book takes place is not an answer/);
});

test('a plot-section failure is told where to go instead', () => {
  const msg = D.retryMessage(['grief: SECTION "Plot" is a plot section, and this is the heaviest component']);
  assert.match(msg, /heaviest component must come from/);
  // And the other way out: promote a component that already is interpretive.
  assert.match(msg, /make a component that IS from there the heaviest/);
});

// ── THE PROMPT ───────────────────────────────────────────

test('the prompt carries the palette and the sections, and says they are all there is', () => {
  const p = D.promptFor({ title: 'Stoner', author: 'John Williams' }, SECTIONS);
  assert.match(p, /Stoner — John Williams/);
  assert.match(p, /grief\s+Grief — Slate, Deep/);
  assert.match(p, /== Themes ==/);
  assert.equal(p.split('\n').filter((l) => /^ {2}\w+ +\w+ — /.test(l)).length, 20);
  assert.match(D.SYSTEM, /THOSE SECTIONS ARE YOUR ONLY SOURCE/);
  assert.match(D.SYSTEM, /SETTING IS NOT THE ANSWER, EVER/);
});

test('the prompt asks for a blend, with a citation per component', () => {
  assert.match(D.SYSTEM, /A BOOK IS NOT ONE EMOTION/);
  assert.match(D.SYSTEM, /THREE OR FOUR, each with a weight/);
  assert.match(D.SYSTEM, /A component you cannot cite is a component you do not/);
  assert.match(D.SYSTEM, /WEIGHT:/);
});

test('the palette order is randomised per call, not reversed', () => {
  const firstOf = (p) => p.split('\n').find((l) => /^ {2}\w+ +\w+ — /.test(l)).trim().split(/\s+/)[0];
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(firstOf(D.promptFor({ title: 'X' }, SECTIONS)));
  assert.ok(seen.size > 8, `only ${seen.size} distinct openings in 60 calls`);

  const fixed = D.promptFor({ title: 'X' }, SECTIONS, { rng: () => 0 });
  assert.equal(fixed, D.promptFor({ title: 'X' }, SECTIONS, { rng: () => 0 }));
});

test('two worked examples, of different method and opposite valence', () => {
  assert.match(D.SYSTEM, /→ grief/);
  assert.match(D.SYSTEM, /→ contentment/);
  assert.match(D.SYSTEM, /differ in METHOD, not in mood/);
});

// ── RETRY ON FORMAT ──────────────────────────────────────
//
// Measured across 87 attempts: 25 cards were rejected while holding usable
// evidence, almost all of it answer format. Retrying with the specific fault
// named is the cheapest coverage in the system, and it relaxes nothing.

test('failures are classified so the retry can say what kind they are', () => {
  assert.equal(D.classify('grief: evidence is 3 sentences; take the one clause'), 'format');
  assert.equal(D.classify('grief: evidence too long (57 words, want under 45)'), 'format');
  assert.equal(D.classify('grief: SECTION "Morning" was not one of the sections supplied'), 'format');
  assert.equal(D.classify('not a palette id: ochre'), 'format');
  assert.equal(D.classify('only 1 of 3 components survived'), 'format');

  // These are the rules working, not the answer being malformed.
  assert.equal(D.classify('grief is weighted heaviest at 80% but only 1 of 40 sentences are about it'), 'weight');
  assert.equal(D.classify('calm: not in the source: mentor, war'), 'grounding');
  assert.equal(D.classify('dread: evidence reasons from setting'), 'setting');
  assert.equal(D.classify('grief: SECTION "Plot" is a plot section, and this is the heaviest component'), 'source');
});

test('a format retry is told to keep its reading and fix the shape', () => {
  const msg = D.retryMessage(['grief: evidence is 3 sentences; take the one clause that carries it']);
  assert.match(msg, /faults in the SHAPE of the answer, not in your reading/);
  assert.match(msg, /Keep the same colours and the same weights/);
  assert.match(msg, /ONE sentence per EVIDENCE line, 8 to 45 words/);
});

test('a weight failure is not told it is a formatting problem', () => {
  const msg = D.retryMessage(['grief is weighted heaviest at 80% but only 1 of 40 sentences are about it']);
  assert.ok(!/faults in the SHAPE/.test(msg), 'the weight check is doing its job, not quibbling');
  assert.match(msg, /how much of the cited section is about that emotion/);
});

test('three attempts, and the rules are identical on every one', () => {
  assert.equal(D.MAX_ATTEMPTS, 3, 'one attempt and two retries');

  // The point of the whole change: a card that fails on format at attempt
  // one faces exactly the same rules at attempt three.
  const sections = [{ heading: 'Themes', text:
    'Critics have written about the loneliness and isolation of the narrator throughout. ' +
    'The loneliness of the closing chapter is noted by every one of them. ' +
    'His isolation is the subject of the longest essay in the collection.' }];
  const bad = { id: 'loneliness', weight: 8, section: 'Themes',
    evidence: 'Critics have written about the loneliness and isolation of the narrator throughout. The loneliness of the closing chapter is noted by every one of them.' };
  const good = { ...bad,
    evidence: 'Critics have written about the loneliness and isolation of the narrator throughout.' };
  const second = { id: 'melancholy', weight: 2, section: 'Themes',
    evidence: 'His isolation is the subject of the longest essay in the collection.' };

  assert.ok(D.validate({ components: [bad, second] }, { sections })
             .problems.some((p) => D.classify(p) === 'format'), 'two sentences is a format fault');
  assert.equal(D.validate({ components: [good, second] }, { sections }).ok, true,
               'and the same reading passes once the shape is fixed');
});

// ── ABSTRACTS ARE ABOUT PAPERS ───────────────────────────
//
// The distinctive hazard of open-access criticism as a source. An abstract
// describes what a scholar ARGUES, so it is full of sentences that are
// perfectly quotable, verbatim, grounded — and about entirely the wrong
// object. A colour drawn from "this article examines the treatment of grief"
// is a colour of the scholarship, not of the novel.

const ABSTRACT = [{
  heading: 'Criticism: Defeat and endurance in Stoner',
  text: `This article examines the treatment of grief in John Williams's Stoner.
Stoner's marriage is figured as a long defeat which he does not resist, and
the novel closes on him alone with his own book. The author argues that
Williams uses irony throughout. This paper contributes to the scholarship on
mid-century American campus fiction.`
}];

test('evidence may quote what the abstract says about the BOOK', () => {
  const out = D.validateComponent({
    id: 'grief', weight: 7, section: ABSTRACT[0].heading,
    evidence: "Stoner's marriage is figured as a long defeat which he does not resist."
  }, { sections: ABSTRACT, dominant: false }, 'grief');
  assert.deepEqual(out, []);
});

test('evidence may NOT quote the abstract describing its own paper', () => {
  for (const evidence of [
    'This article examines the treatment of grief in John Williams\'s Stoner.',
    'The author argues that Williams uses irony throughout the whole novel.',
    'This paper contributes to the scholarship on mid-century American campus fiction.'
  ]) {
    const out = D.validateComponent({
      id: 'grief', weight: 7, section: ABSTRACT[0].heading, evidence
    }, { sections: ABSTRACT, dominant: false }, 'grief');
    assert.ok(out.some((p) => /describes the article rather than the book/.test(p)),
              `not caught: ${evidence}`);
  }
});

test('the prompt says which object to read the abstract for', () => {
  assert.match(D.SYSTEM, /is an ABSTRACT/);
  assert.match(D.SYSTEM, /Take from it only what it says about THE/);
  assert.match(D.SYSTEM, /never quote the paper describing itself/);
});

test('criticism ranks under Wikipedia interpretive and over the blurb', () => {
  assert.deepEqual(E.RANKS, ['interpretive', 'doaj', 'blurb', 'plot']);
  assert.equal(E.kindOf('Criticism: Rewriting the Myth'), 'doaj');

  // Where a book has criticism and a blurb, the heaviest must take the
  // criticism — it is a scholar saying what the book is doing.
  const both = [...ABSTRACT, {
    heading: 'Publisher description',
    text: 'A tender novel of mourning and quiet devotion, and of the grief that outlasts it. Its affection survives everything the bereavement takes away.'
  }];
  const out = D.validate({ components: [
    { id: 'grief', weight: 7, section: 'Publisher description',
      evidence: 'A tender novel of mourning and quiet devotion, and of the grief that outlasts it.' },
    { id: 'tenderness', weight: 3, section: ABSTRACT[0].heading,
      evidence: "Stoner's marriage is figured as a long defeat which he does not resist." }
  ] }, { sections: both });
  assert.ok(out.problems.some((p) => /heaviest component/.test(p)), out.problems.join(' / '));
});
