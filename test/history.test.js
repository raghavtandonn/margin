import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, run } = await import('../db/index.js');
const H = await import('../lib/history.js');
const W = await import('../lib/works.js');

// ── A book with a documented history, and the retrieved text it came from ──
//
// Real Wikipedia prose, trimmed. Every date and name the validator checks
// for is in here, which is the point: the test asserts that copy is allowed
// through BECAUSE it is grounded, not because it reads well.
const LOLITA_SOURCE = `## Composition
Nabokov began writing Lolita in 1948 while teaching at Cornell University in
Ithaca, New York. He wrote much of it during summer butterfly-collecting trips
across the western United States, composing on index cards in the passenger
seat of the family car. Twice he tried to burn the unfinished manuscript and
was stopped by his wife Vera. The novel was rejected by Viking, Simon and
Schuster, New Directions, Farrar Straus and Doubleday between 1953 and 1954.
It was published in Paris in 1955 by Olympia Press, a house better known for
pornography, in a print run of 5000 copies. The British Home Office ordered
customs to seize copies in 1956. G. P. Putnam's Sons published the American
edition in 1958.`;

const stubSources = (text) => [
  { kind: 'wikipedia', ref: 'https://en.wikipedia.org/wiki/Lolita', title: 'Lolita', text },
  { kind: 'catalogue', ref: 'this library', title: 'Lolita', text: '{}' }
];

// ── THE VALIDATOR ────────────────────────────────────────

test('grounded catalogue copy is allowed through', () => {
  const good =
    'Nabokov began the book in 1948 while teaching at Cornell University in ' +
    'Ithaca. He composed much of it on index cards during butterfly-collecting ' +
    'trips across the western United States, writing in the passenger seat of ' +
    'the family car. Twice he attempted to burn the manuscript and was stopped ' +
    'by Vera. Viking, Simon and Schuster, New Directions, Farrar Straus and ' +
    'Doubleday all rejected it. Olympia Press published it in Paris in 1955 in ' +
    'a print run of 5000 copies. The British Home Office ordered seizures the ' +
    'following year.';

  const check = H.validate(good, { sources: stubSources(LOLITA_SOURCE), title: 'Lolita', author: 'Vladimir Nabokov' });
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
});

test('an invented date is caught even when everything else is true', () => {
  // 1947 is not in the sources. One digit, and the whole card is wrong in a
  // way no reader could detect.
  const wrong =
    'Nabokov began the book in 1947 while teaching at Cornell University in ' +
    'Ithaca. He composed much of it on index cards during butterfly-collecting ' +
    'trips across the western United States, writing in the passenger seat of ' +
    'the family car. Twice he attempted to burn the manuscript and was stopped ' +
    'by Vera. Viking, Simon and Schuster, New Directions, Farrar Straus and ' +
    'Doubleday all rejected it. Olympia Press published it in Paris in 1955 in ' +
    'a print run of 5000 copies. The British Home Office ordered seizures the ' +
    'following year.';

  const check = H.validate(wrong, { sources: stubSources(LOLITA_SOURCE), title: 'Lolita' });
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('1947')), check.problems.join('; '));
});

test('an invented print run is caught', () => {
  const wrong =
    'Nabokov began the book in 1948 while teaching at Cornell University in ' +
    'Ithaca. He composed much of it on index cards during butterfly-collecting ' +
    'trips across the western United States, writing in the passenger seat of ' +
    'the family car. Twice he attempted to burn the manuscript and was stopped ' +
    'by Vera. Viking, Simon and Schuster, New Directions, Farrar Straus and ' +
    'Doubleday all rejected it. Olympia Press published it in Paris in 1955 in ' +
    'a print run of 8000 copies. The British Home Office ordered seizures the ' +
    'following year.';

  const check = H.validate(wrong, { sources: stubSources(LOLITA_SOURCE), title: 'Lolita' });
  assert.ok(check.problems.some((p) => p.includes('8000')));
});

test('a city nobody mentioned is caught', () => {
  const wrong =
    'Nabokov began the book in 1948 while teaching at Cornell University in ' +
    'Ithaca. He wrote the closing chapters in Montreux during a long winter, ' +
    'composing on index cards in the passenger seat of the family car. Twice ' +
    'he attempted to burn the manuscript and was stopped by Vera. Viking, ' +
    'Simon and Schuster, New Directions, Farrar Straus and Doubleday all ' +
    'rejected it. Olympia Press published it in Paris in 1955 in a print run ' +
    'of 5000 copies.';

  const check = H.validate(wrong, { sources: stubSources(LOLITA_SOURCE), title: 'Lolita' });
  assert.ok(check.problems.some((p) => /Montreux/.test(p)), check.problems.join('; '));
});

test('the banned register is refused', () => {
  const base = (mid) =>
    `Nabokov began the book in 1948 while teaching at Cornell University in ` +
    `Ithaca. ${mid} He composed on index cards during butterfly-collecting trips ` +
    `across the western United States. Twice he attempted to burn the manuscript ` +
    `and was stopped by Vera. Viking, Simon and Schuster, New Directions, Farrar ` +
    `Straus and Doubleday all rejected it. Olympia Press published it in Paris in ` +
    `1955 in a print run of 5000 copies.`;

  const bad = (mid, needle) => {
    const c = H.validate(base(mid), { sources: stubSources(LOLITA_SOURCE), title: 'Lolita' });
    assert.ok(c.problems.some((p) => p.includes(needle)),
              `${needle} not caught in: ${c.problems.join('; ')}`);
  };

  bad('The timeless novel remains widely read.', 'timeless');
  bad('It is a masterpiece of the period.', 'masterpiece');
  bad('The book explores the American road.', 'explor');
  // The stem, not the conjugation: "her exploration of" is the same
  // sentence the rule exists to keep off the page, and it slipped through
  // a whole-word check on a real card.
  bad('Her exploration of the subject continued.', 'explor');
  bad('You will recognise the shape of it.', 'addresses the reader');
});

test('the validator refuses to run without the sources it checks against', () => {
  // A card checked only for register is exactly the failure this exists to
  // prevent, so having no evidence is a refusal rather than a pass.
  const check = H.validate('Anything at all.', {});
  assert.equal(check.ok, false);
  assert.match(check.problems[0], /no sources/);
});

// ── THE MODEL PATH, WITHOUT A MODEL ──────────────────────
//
// `fetchImpl` and `retrieveImpl` are injected so the whole round trip is
// exercised with no key and no network: what gets sent, what comes back,
// what the validator does with it, and what is written to the page.

const workWith = (title, author) => {
  const id = W.createWork({ title, authors: [author] });
  return id;
};

const modelSaying = (...replies) => {
  const queue = [...replies];
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const text = queue.shift();
    return { ok: true, json: async () => ({ content: [{ text }] }) };
  };
  impl.calls = calls;
  return impl;
};

test('the retrieved text is what gets sent, and the model is told not to use memory', async () => {
  const id = workWith('Lolita', 'Vladimir Nabokov');
  const fetchImpl = modelSaying('INSUFFICIENT');

  await H.generate(id, {
    apiKey: 'test-key',
    fetchImpl,
    retrieveImpl: async () => ({
      work: { id, title: 'Lolita', author: 'Vladimir Nabokov', first_published_year: 1955 },
      sources: stubSources(LOLITA_SOURCE)
    })
  });

  const sent = fetchImpl.calls[0];
  assert.match(sent.system, /Do\s*\n?not supply a fact from your own knowledge/);
  assert.ok(sent.messages[0].content.includes('Olympia Press'),
            'the retrieved text travels in the message');
  assert.ok(sent.temperature <= 0.3, 'this is a paraphrase, not a composition');
});

test('a good card is saved as documented, with its source', async () => {
  const id = workWith('Lolita II', 'Vladimir Nabokov');
  const good =
    'Nabokov began the book in 1948 while teaching at Cornell University in ' +
    'Ithaca. He composed much of it on index cards during butterfly-collecting ' +
    'trips across the western United States, writing in the passenger seat of ' +
    'the family car. Twice he attempted to burn the manuscript and was stopped ' +
    'by Vera. Viking, Simon and Schuster, New Directions, Farrar Straus and ' +
    'Doubleday all rejected it. Olympia Press published it in Paris in 1955 in ' +
    'a print run of 5000 copies. The British Home Office ordered seizures the ' +
    'following year.';

  await H.generate(id, {
    apiKey: 'test-key',
    fetchImpl: modelSaying(good),
    retrieveImpl: async () => ({
      work: { id, title: 'Lolita II', author: 'Vladimir Nabokov' },
      sources: stubSources(LOLITA_SOURCE)
    })
  });

  const card = H.cardFor(id);
  assert.equal(card.kind, 'written');
  assert.equal(card.confidence, 'documented');
  assert.match(card.source.ref, /wikipedia\.org/);
});

test('a card with an invented date is rejected, retried, and then refused', async () => {
  const id = workWith('Lolita III', 'Vladimir Nabokov');
  const invented =
    'Nabokov began the book in 1947 while teaching at Cornell University in ' +
    'Ithaca. He composed much of it on index cards during butterfly-collecting ' +
    'trips across the western United States, writing in the passenger seat of ' +
    'the family car. Twice he attempted to burn the manuscript and was stopped ' +
    'by Vera. Viking, Simon and Schuster, New Directions, Farrar Straus and ' +
    'Doubleday all rejected it. Olympia Press published it in Paris in 1955 in ' +
    'a print run of 5000 copies. The British Home Office ordered seizures the ' +
    'following year.';

  // Wrong twice: the model does not get a third chance to be plausible.
  const fetchImpl = modelSaying(invented, invented);
  const card = await H.generate(id, {
    apiKey: 'test-key',
    fetchImpl,
    retrieveImpl: async () => ({
      work: { id, title: 'Lolita III', author: 'Vladimir Nabokov' },
      sources: stubSources(LOLITA_SOURCE)
    })
  });

  assert.equal(fetchImpl.calls.length, 2, 'it retries once');
  assert.match(fetchImpl.calls[1].messages[0].content, /previous answer was rejected/,
               'and says what was wrong rather than asking again and hoping');
  assert.notEqual(card.kind, 'written', 'nothing unverified reaches the page');
});

// ── THE FAILURE MODE, ON PURPOSE ─────────────────────────
//
// "Test this path on recent genre fiction specifically, not on classics,
// because the classics will look great and hide the failure mode."
//
// Retrieval against the live Wikipedia found composition history for two of
// six recent titles from this library and nothing for the other four. These
// are those four.

test('recent fiction with no documented history gets a thin card, never a written one', async () => {
  for (const title of ['The Death I Gave Him', 'Brutes', 'Martyr!', 'Shy']) {
    const id = W.createWork({ title, authors: ['A Living Writer'] });
    W.addEdition(id, { publisher: 'Faber and Faber', published_year: 2023, page_count: 288 });

    // Retrieval found the catalogue and nothing else, which is what really
    // happens for these titles.
    const fetchImpl = modelSaying('SHOULD NEVER BE CALLED');
    const card = await H.generate(id, {
      apiKey: 'test-key',
      fetchImpl,
      retrieveImpl: async () => ({
        work: { id, title, author: 'A Living Writer' },
        sources: [{ kind: 'catalogue', ref: 'this library', title, text: '{}' }]
      })
    });

    assert.equal(fetchImpl.calls.length, 0,
                 `${title}: the model is not called when there is nothing to write from`);
    assert.equal(card.kind, 'material', `${title}: falls back to material facts`);
    assert.equal(card.confidence, 'thin');
    assert.ok(card.facts.some((f) => f.includes('Faber')), `${title}: built from what is provable`);
  }
});

test('a thin file is not padded out to ninety words', async () => {
  const id = workWith('A Sparse Article', 'Somebody');
  // An article exists but says nothing about composition: 200 characters,
  // under the threshold that makes a call worth making.
  const thin = [{ kind: 'wikipedia', ref: 'x', title: 'y', text: 'A novel published in 2023.' },
                { kind: 'catalogue', ref: 'this library', title: 'z', text: '{}' }];

  const fetchImpl = modelSaying('SHOULD NEVER BE CALLED');
  await H.generate(id, {
    apiKey: 'test-key', fetchImpl,
    retrieveImpl: async () => ({ work: { id, title: 'A Sparse Article', author: 'Somebody' }, sources: thin })
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('a hand-written card is never overwritten by a regeneration', async () => {
  const id = workWith('Edited By Hand', 'Somebody');
  H.editCard(id, 'The reader knows something the sources do not.');

  await H.generate(id, {
    apiKey: 'test-key',
    fetchImpl: modelSaying('Something else entirely, written by a machine, at length.'),
    retrieveImpl: async () => ({
      work: { id, title: 'Edited By Hand', author: 'Somebody' }, sources: stubSources(LOLITA_SOURCE)
    })
  });

  assert.match(H.cardFor(id).body, /The reader knows something/);
});

// ── THE CLOSING NOTE ─────────────────────────────────────

const NOTE = (() => [
  'Four of these were written by people in the wrong country. Nabokov in a',
  'Berlin boarding house furnished by strangers, Kundera already halfway out of',
  'Prague and writing like a man packing. Half a century between them and',
  'neither one at home. The two contemporary novels you set against them look',
  'indecently comfortable by comparison, and one of them cracks under the',
  'weight of the company it keeps. A season assembled almost entirely from',
  'writers with no ground beneath them, read from a very settled chair. Your',
  'taste in displacement is expensive and you should probably examine it.'
].join(' '))();

test('the closing note must name real books and address the reader', () => {
  const titles = ['Lolita', 'The Unbearable Lightness of Being'];
  const sources = [{ text: 'Nabokov Berlin Kundera Prague' }];

  const named = NOTE.replace('Nabokov in a', 'Lolita, written in a')
                    .replace('Kundera already', 'The Unbearable Lightness of Being already');
  const check = H.validateNote(named, { titles, sources });
  assert.deepEqual(check.problems, []);

  // The same paragraph naming none of them is about a season in general.
  const anonymous = H.validateNote(NOTE.replace(/Nabokov|Kundera/g, 'the author'), { titles, sources });
  assert.ok(anonymous.problems.some((p) => /needs at least 2/.test(p)));
});

test('the closing note may not congratulate or count', () => {
  const titles = ['Lolita', 'Shy'];
  const sources = [{ text: '' }];
  const base = 'You read Lolita and Shy this season. ' + NOTE;

  const flattering = H.validateNote(base + ' What an impressive season.', { titles, sources });
  assert.ok(flattering.problems.some((p) => /congratulates/.test(p)));

  const counting = H.validateNote('You finished nine books. ' + base, { titles, sources });
  assert.ok(counting.problems.some((p) => /counts the books/.test(p)));
});

test('a season with fewer than two documented histories gets no note at all', async () => {
  const id = W.createWork({ title: 'Only One History', authors: ['Somebody'] });
  const note = await H.seasonNote('s-empty', [{ work_id: id, title: 'Only One History' }],
                                  { apiKey: 'test-key', fetchImpl: modelSaying(NOTE) });
  assert.equal(note.body, undefined, 'a through-line between one book and nothing is invented');
  // And it says which of the two failures this was. A note that was written
  // and refused is a different situation from a season with nothing to write
  // about, and reporting both the same way sends you looking in the wrong
  // place.
  assert.match(note.skipped, /documented histories/);
});

// ── A RUN WITHOUT A KEY MUST NOT DESTROY A WRITTEN CARD ──
//
// This happened. `generate()` with no apiKey wrote a thin card
// unconditionally, so running scripts/histories.mjs without ANTHROPIC_API_KEY
// overwrote documented histories with nulls and lost two of them. "We did not
// ask the model" was being recorded as "this book has no documented history",
// which is the same category error the RetrievalUnavailable guard exists to
// prevent: absence of a key is a fact about the run, never about the book.
test('a keyless run keeps a card that is already written', async () => {
  const work = get('SELECT id FROM works LIMIT 1');

  run(
    `INSERT OR REPLACE INTO history_cards (work_id, confidence, body, model, edited_by_user)
     VALUES (?, 'documented', ?, 'test-model', 0)`,
    work.id, 'Written in a rented room over one winter, on a borrowed machine.'
  );

  const before = H.cardFor(work.id);
  assert.equal(before.kind, 'written');

  // Enough cached source that the card would otherwise be regenerated.
  const out = await H.generate(work.id, {
    apiKey: null,
    retrieveImpl: async () => ({
      work: { id: work.id, title: 'A Book', author: 'Somebody' },
      sources: [{ kind: 'wikipedia', ref: 'A_Book', text: 'x'.repeat(900) }]
    })
  });

  assert.equal(out.kind, 'written', 'generate returns the held card');
  assert.equal(
    H.cardFor(work.id).body, before.body,
    'and the stored card is untouched'
  );
});
