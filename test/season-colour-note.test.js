import test from 'node:test';
import assert from 'node:assert/strict';

const N = await import('../lib/season-colour-note.js');
const { shortSection, unquote } = await import('../lib/view-helpers.js');

// A season is a list of frames, each carrying the colour lib/book-colour.js
// resolved for it. Only the shape matters here.
const book = (title, ...ids) => ({
  title,
  colour: {
    source: 'derived',
    hex: '#333333',
    components: ids.map((id, i) => ({ id, weight: i === 0 ? 0.6 : 0.4 / (ids.length - 1),
                                      section: 'Themes', evidence: 'x' }))
  }
});

/** Explicit weights, for the cases where the shape is the point. */
const weighted = (title, pairs) => ({
  title,
  colour: {
    source: 'derived', hex: '#333333',
    components: pairs.map(([id, weight]) => ({ id, weight, section: 'Themes', evidence: 'x' }))
  }
});
const hatched = (title) => ({ title, colour: { source: 'none', components: [] } });

// ── HOUSE RULES ──────────────────────────────────────────
//
// The note is about what a season was like to read. A reader should not have
// to know how it was made, and the note should not sound like it was made.

const SEASON = [
  weighted('A', [['grief', 0.45], ['tenderness', 0.35], ['nostalgia', 0.20]]),
  weighted('B', [['melancholy', 0.50], ['grief', 0.30], ['tenderness', 0.20]]),
  weighted('C', [['grief', 0.55], ['loneliness', 0.45]]),
  weighted('D', [['tenderness', 0.60], ['grief', 0.40]]),
  weighted('E', [['loneliness', 0.50], ['grief', 0.30], ['melancholy', 0.20]]),
  weighted('F', [['wonder', 0.70], ['awe', 0.30]]),
  weighted('G', [['grief', 0.40], ['melancholy', 0.35], ['tenderness', 0.25]])
];

test('the machinery never appears on the page', () => {
  const note = N.colourNote(SEASON).note;
  for (const word of [/\bcomponent/i, /\bweight/i, /\bheaviest/i, /\bderived/i,
                      /\bpalette\b/i, /\banchor/i, /\bblend/i]) {
    assert.ok(!word.test(note), `machinery on the page: ${note}`);
  }
});

test('no "not X, but Y", no em-dash asides, no rhetorical questions', () => {
  const note = N.colourNote(SEASON).note;
  assert.ok(!/\bnot .{1,40}?,? but\b/i.test(note), `"not X but Y": ${note}`);
  assert.ok(!/\brather than\b/i.test(note), `a variant of the same: ${note}`);
  assert.ok(!/—|–/.test(note), `em-dash aside: ${note}`);
  assert.ok(!/\?/.test(note), `rhetorical question: ${note}`);
});

test('it never opens on a number', () => {
  // A sentence that leads with its arithmetic is a sentence about the
  // arithmetic. Every shape the note can take is checked, not just this one.
  const seasons = [
    SEASON,
    [book('A', 'grief'), book('B', 'grief'), book('C', 'grief')],
    [book('A', 'grief', 'calm'), book('B', 'wonder', 'awe'), book('C', 'delight', 'desire')],
    [book('A', 'grief', 'tenderness'), book('B', 'wonder', 'tenderness'),
     book('C', 'delight', 'tenderness'), book('D', 'calm', 'awe')]
  ];
  for (const s of seasons) {
    const note = N.colourNote(s).note;
    assert.ok(!/^\W*\d/.test(note), `opens on a numeral: ${note}`);
    assert.ok(!/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(note),
              `opens on a number: ${note}`);
  }
});

test('three to five sentences, never one', () => {
  for (const s of [SEASON,
                   [book('A', 'grief'), book('B', 'grief'), book('C', 'grief')],
                   [book('A', 'grief', 'calm'), book('B', 'wonder', 'awe'), book('C', 'delight', 'desire')]]) {
    const note = N.colourNote(s).note;
    const count = (note.match(/[.!?]/g) || []).length;
    assert.ok(count >= 3 && count <= 5, `${count} sentences: ${note}`);
  }
});

test('sentences are separated by one space', () => {
  // The sentence cap re-joins split fragments, and the first version left a
  // double space at every seam.
  assert.ok(!/ {2}/.test(N.colourNote(SEASON).note));
});

test('two seasons of the same broad shape do not read the same', () => {
  // The recycling complaint. Both of these are saturated and paired; what
  // distinguishes them is that one has a book belonging to nothing, and the
  // note has to end somewhere different because of it.
  const a = N.colourNote([
    book('A', 'grief', 'recognition'), book('B', 'grief', 'recognition'),
    book('C', 'grief', 'recognition'), book('D', 'clarity', 'grief'),
    book('Outsider', 'exhilaration', 'delight')
  ]).note;
  const b = N.colourNote([
    book('A', 'dread', 'loneliness'), book('B', 'dread', 'loneliness'),
    book('C', 'dread', 'loneliness'), book('D', 'melancholy', 'dread')
  ]).note;

  const lastOf = (note) => (note.match(/[^.!?]+[.!?]/g) || []).at(-1).trim();
  assert.notEqual(lastOf(a), lastOf(b), 'both seasons closed on the same sentence');
  assert.match(lastOf(a), /Outsider belongs to no part of this season/);
});

test('the point is never crowded out by the arithmetic', () => {
  // Assembled the other way round it was the first thing the length cap threw
  // away, and three of five seasons ended on a statistic.
  for (const season of [SEASON,
      [book('A', 'grief', 'calm'), book('B', 'wonder', 'awe'), book('C', 'delight', 'desire')],
      [book('A', 'dread', 'loneliness'), book('B', 'dread', 'loneliness'),
       book('C', 'dread', 'loneliness'), book('D', 'melancholy', 'dread')]]) {
    const note = N.colourNote(season).note;
    const last = (note.match(/[^.!?]+[.!?]/g) || []).at(-1).trim();
    assert.ok(!/\d/.test(last), `closed on a statistic: ${last}`);
  }
});

test('a season is described against the shelf, not only against itself', () => {
  // Without a baseline every season opens on whatever is largest, and across
  // this library that is grief or dread nearly every time — a fact about
  // criticism, not about any season.
  const baseline = new Map([['grief', 0.40], ['melancholy', 0.02], ['calm', 0.10]]);
  const season = [
    book('A', 'grief', 'melancholy'), book('B', 'grief', 'melancholy'),
    book('C', 'melancholy', 'grief'), book('D', 'grief', 'calm')
  ];
  const withBase = N.colourNote(season, { baseline }).note;
  const without = N.colourNote(season).note;
  assert.notEqual(withBase, without, 'the baseline changed nothing');
  assert.match(withBase, /melancholy/i, 'the rare thing is what makes it distinctive');
});

// ── THE SHAPES ───────────────────────────────────────────

test('a feeling present nearly everywhere and dominant almost nowhere', () => {
  // The observation a count of leading feelings cannot make, and the reason
  // the note reads the whole profile: grief is in six of the seven books
  // above and leads only two.
  const note = N.colourNote(SEASON).note;
  // Six is the number a reader is given, not three: the observation is that
  // grief is nearly everywhere and rarely in charge.
  assert.match(note, /reaches six of the seven books/);
  assert.ok(!/^Grief leads three/.test(note));
});

test('two feelings that keep arriving together', () => {
  const note = N.colourNote(SEASON).note;
  assert.match(note, /(Grief and tenderness|Tenderness and grief) arrive together in \w+ books\./);
});

test('a season with nothing running through it says so', () => {
  const note = N.colourNote([
    book('A', 'grief', 'calm'), book('B', 'wonder', 'awe'), book('C', 'delight', 'desire')
  ]).note;
  assert.match(note, /^Nothing holds this season together\./);
});

test('a conspicuous absence is a neighbour, not a rarity', () => {
  // Nearest-in-colour was wrong systematically: a blend centroid sits near
  // mid-grey, so the nearest absent anchor was always a grey neutral and
  // every season reported "there is no boredom anywhere in it". Boredom is
  // rare everywhere, so its absence is a fact about the palette.
  const note = N.colourNote([
    weighted('A', [['clarity', 0.6], ['recognition', 0.4]]),
    weighted('B', [['recognition', 0.6], ['contentment', 0.4]]),
    weighted('C', [['contentment', 0.6], ['clarity', 0.4]]),
    weighted('D', [['clarity', 0.5], ['contentment', 0.5]])
  ]).note;
  if (/There is no /.test(note)) {
    const named = /There is no (\w+)/.exec(note)[1];
    // Whatever it names must share the company's valence and arousal.
    assert.ok(['calm', 'tenderness', 'nostalgia'].includes(named), `named ${named}: ${note}`);
  }
});

test('a book sharing nothing with the season closes the note', () => {
  // It is the strongest thing a season can say about itself, so it lands
  // last rather than in the middle — and it is said once, not twice.
  const note = N.colourNote([
    book('A', 'grief', 'calm'), book('B', 'grief', 'calm'),
    book('C', 'grief', 'calm'), book('Outlier', 'delight', 'exhilaration')
  ]).note;
  assert.match(note, /Outlier belongs to no part of this season\.$/);
  assert.equal((note.match(/Outlier/g) || []).length, 1, 'said once');
});

// ── THE OBSERVATIONS ARE ARITHMETIC ──────────────────────

test('the note reads the whole profile, not just what led', () => {
  const out = N.colourNote(SEASON);
  // Seven books, nineteen data points. Grief appears in six of them and
  // leads three — and the note leads on the six, which is the observation a
  // count of leading feelings alone would have missed.
  const grief = out.facts.profile.find((p) => p.id === 'grief');
  assert.equal(grief.books, 6);
  assert.equal(grief.leads, 3);
  assert.equal(Math.round(grief.share * 100), 34);
  assert.equal(out.drawnFrom.length, 7);
});

test('hatched books are excluded, and the citation says how many it speaks for', () => {
  const out = N.colourNote([
    book('A', 'grief', 'calm'), book('B', 'grief', 'calm'),
    book('C', 'grief', 'calm'), hatched('D'), hatched('E')
  ]);
  assert.match(out.provenance, /READ FROM THREE OF FIVE BOOKS/);
  assert.match(out.provenance, /TWO UNWRITTEN/);
  // The citation may stay technical. The note may not.
  assert.ok(!/UNWRITTEN|READ FROM/.test(out.note));
  assert.equal(out.facts.spokenFor, 3);
  assert.ok(!out.drawnFrom.some((d) => d.title === 'D'));
});

test('a whole season on one feeling is stated as such', () => {
  const note = N.colourNote([
    book('A', 'grief', 'calm'), book('B', 'grief', 'awe'), book('C', 'grief', 'desire')
  ]).note;
  assert.match(note, /all three books|takes this season over/i);
});

test('a feeling that never leads but recurs beneath is visible in the profile', () => {
  const out = N.colourNote([
    book('A', 'grief', 'tenderness'), book('B', 'wonder', 'tenderness'),
    book('C', 'delight', 'tenderness'), book('D', 'calm', 'awe')
  ]);
  const t = out.facts.profile.find((p) => p.id === 'tenderness');
  assert.equal(t.books, 3);
  assert.equal(t.leads, 0);
  assert.match(out.note, /tenderness/i);
});

test('fewer than three coloured books is no note at all', () => {
  const out = N.colourNote([book('A', 'grief', 'calm'), book('B', 'grief', 'calm'), hatched('C')]);
  assert.equal(out.note, null);
  assert.equal(out.provenance, null);
  assert.deepEqual(out.drawnFrom, []);
  assert.equal(out.facts.enough, false);
});

test('an empty season does not throw', () => {
  assert.equal(N.colourNote([]).note, null);
  assert.equal(N.colourNote().note, null);
});

// ── WHAT IT MUST NOT DO ──────────────────────────────────

test('the note never interprets, and never states a thesis', () => {
  const out = N.colourNote([
    book('A', 'grief', 'calm'), book('B', 'grief', 'awe'),
    book('C', 'grief', 'desire'), book('D', 'melancholy', 'calm'),
    book('E', 'loneliness', 'calm')
  ]);
  // The failure this file replaced: a claim about the reading rather than a
  // count of it, which the books then have to agree with.
  for (const thesis of [
    /this season was about/i, /a season of/i, /reveals/i, /suggests/i,
    /speaks to/i, /explores/i, /tells the story of/i, /what emerges/i
  ]) {
    assert.ok(!thesis.test(out.note), `interpreted: ${out.note}`);
  }
  // And there is no model in this path to invent one.
  assert.ok(!Object.keys(N).some((k) => /generate|model|prompt/i.test(k)));
});

test('the valence clause counts one side only', () => {
  // It read "five on the positive side, no on the other" — ungrammatical,
  // and false besides: a book can sit on neither side.
  const out = N.colourNote([
    book('A', 'delight', 'calm'), book('B', 'wonder', 'calm'),
    book('C', 'calm', 'clarity'), book('D', 'desire', 'delight'),
    book('E', 'awe', 'wonder')   // awe is neutral, on neither side
  ]);
  assert.ok(!/\bno on the other\b/.test(out.note), out.note);
  if (/side of the palette/.test(out.note)) {
    assert.match(out.note, /sit on the positive side of the palette\./);
  }
});

// ── THE DERIVATION PANEL'S ONE HELPER ────────────────────

test('a section heading is trimmed to one line', () => {
  // Wikipedia headings are two or three words and pass through whole.
  assert.equal(shortSection('Themes'), 'THEMES');
  assert.equal(shortSection('Style and interpretation'), 'STYLE AND INTERPRETATION');
  assert.equal(shortSection('Publisher description'), 'PUBLISHER DESCRIPTION');

  // An open-access article title is not. One of them wrapped to two lines
  // and pushed that panel's source line below every other panel's.
  const long = shortSection('Criticism: THE WAYS OF FORMING POSSIBLE WORLDS OF LITERARY TEXT CHARACTERS: A COGNITIVE VIEW');
  assert.ok(long.length <= 34, `${long.length}: ${long}`);
  assert.match(long, /^CRITICISM: /, 'the class survives the trim');
  assert.match(long, /…$/);

  assert.equal(shortSection(null), '');
  assert.equal(shortSection(''), '');
});

test('a cited span does not come out double-quoted', () => {
  // The evidence is copied verbatim and a source often quotes the sentence
  // already. Rendered inside a <q>, which supplies its own marks, every
  // citation on the page read ""Humbert is every man…"".
  assert.equal(unquote('"Humbert is every man who is driven by desire."'),
               'Humbert is every man who is driven by desire.');
  assert.equal(unquote('“Curly quoted.”'), 'Curly quoted.');
  assert.equal(unquote('"“nested”"'), 'nested');

  // An unquoted span is untouched, and an internal quotation survives.
  assert.equal(unquote('Plain sentence.'), 'Plain sentence.');
  assert.equal(unquote('He said "no" and left.'), 'He said "no" and left.');
  assert.equal(unquote(null), '');
});

test('a season with too few colours says so in the same voice', () => {
  // Written inline in the template it came out "2 of these 7 books carry a
  // colour": numerals, opening on a number, and ungrammatical at one.
  const two = N.colourNote([book('A', 'grief', 'calm'), book('B', 'grief', 'calm'),
                            hatched('C'), hatched('D'), hatched('E'),
                            hatched('F'), hatched('G')]);
  assert.equal(two.note, null);
  assert.equal(two.shortfall,
    'Only two of these seven books carry a colour. A season is not read across until three of them do.');

  const one = N.colourNote([book('A', 'grief', 'calm'), hatched('B'), hatched('C'), hatched('D')]);
  assert.match(one.shortfall, /^Only one of these four books carries a colour\./);

  const none = N.colourNote([hatched('A'), hatched('B'), hatched('C')]);
  assert.match(none.shortfall, /^None of these three books carries a colour yet\./);

  // And a season that has a note has no shortfall.
  assert.equal(N.colourNote(SEASON).shortfall, null);

  for (const s of [two.shortfall, one.shortfall, none.shortfall]) {
    assert.ok(!/^\W*\d/.test(s), `opens on a numeral: ${s}`);
    assert.ok(!/\d/.test(s), `numerals in the copy: ${s}`);
  }
});
