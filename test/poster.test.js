import test from 'node:test';
import assert from 'node:assert/strict';

// No database: the poster is a pure function of the season it is handed.
const P = await import('../lib/poster.js');

// ── THE NOTE, AS THE POSTER READS IT ─────────────────────
//
// The sheet sets a run of sentences quiet and the last one in full, so the
// split has to be right about where a sentence ends. Two of the things a
// season note says routinely look like sentence ends and are not.

test('sentences split on the mark, not on every full stop', () => {
  assert.deepEqual(
    P.noteLines('8 finished, against a usual 2. 198 days a book on average.'),
    ['8 finished, against a usual 2.', '198 days a book on average.']
  );
});

test('a decimal is not a sentence end', () => {
  // "A mean of 4.33 stars" is one clause. There is no space after the
  // point, which is the whole of the guard.
  const lines = P.noteLines('3 finished, against a usual 3. A mean of 4.33 stars.');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('4.33 stars'));
});

test('a season code survives the split', () => {
  const lines = P.noteLines('Held over from S/S 26. Nothing was finished in July.');
  assert.deepEqual(lines, ['Held over from S/S 26.', 'Nothing was finished in July.']);
});

test('three sentences at most, and not past the budget', () => {
  const four = 'One. Two. Three. Four.';
  assert.deepEqual(P.noteLines(four), ['One.', 'Two.', 'Three.']);

  // A single sentence over the budget is still shown: the alternative is a
  // poster with a title and nothing under it.
  const long = 'x'.repeat(400) + '.';
  assert.deepEqual(P.noteLines(long), [long]);

  // The second one is not, because it would push the foot off the sheet.
  assert.deepEqual(P.noteLines(`${long} And a short one.`), [long]);
});

test('a season with no note gets no sentences rather than an empty one', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.deepEqual(P.noteLines(empty), []);
  }
});

// ── THE TITLE ────────────────────────────────────────────

test('an untitled season is titled by its count, spelled out', () => {
  assert.equal(P.countTitle(1), 'One book');
  assert.equal(P.countTitle(7), 'Seven books');
  assert.equal(P.countTitle(0), 'No books');
  assert.equal(P.countTitle(41), '41 books');
});

// ── THE SHEET ────────────────────────────────────────────

test('the sheet carries the label, the title and the claim', () => {
  const html = P.posterHTML({
    title: 'After September', code: 'A/W 25', label: 'Autumn/Winter 25',
    count: 7, note: 'Seven finished. Ratings fell after 27 September. It was a long autumn.',
    strip: ['#b6cafb', '#2A2622'], shape: 'story'
  });

  assert.ok(html.includes('AUTUMN / WINTER 25'), 'the label, spaced round the slash');
  assert.ok(html.includes('After September'));
  // One colour, one weight, all the way through. It used to set the last
  // sentence in full bone and leave the rest grey, which put a tonal break
  // mid-paragraph and made whichever figure ended a sentence look like a
  // highlight. A stat block is one statement.
  assert.ok(html.includes('Seven finished. Ratings fell after 27 September. It was a long autumn.'),
            'the note runs as one paragraph');
  assert.ok(!/<b>/.test(html), 'nothing in the note is emphasised');
  assert.ok(html.includes('background:#b6cafb'));
  assert.ok(html.includes('MARGIN.CO'));
});

test('§04 — the plinth carries the swatch names, and only the real ones', () => {
  const html = P.posterHTML({
    title: 'After September', code: 'A/W 25', label: 'Autumn/Winter 25', count: 4,
    strip: [
      { hex: '#23262B', emotion: 'Grief', name: 'Slate, Deep', source: 'derived' },
      { hex: '#23262B', emotion: 'Grief', name: 'Slate, Deep', source: 'derived' },
      { hex: '#aabbcc', emotion: null, name: null, source: 'provisional' },
      { hex: null, emotion: null, name: null, source: 'none' }
    ],
    shape: 'story'
  });

  // §05 — the emotion word ships beside every swatch in every view. On the
  // poster that is the plinth, and it is the only thing that makes the
  // strip legible as meaning.
  // The BLEND's name, not the nearest anchor's emotion: naming by anchor
  // collapsed a four-band poster to one word, because three different
  // blends can round to the same anchor.
  assert.ok(/class="words">[^<]*Slate, Deep/.test(html), 'the blend name reaches the plinth');
  assert.equal((html.match(/Slate, Deep/g) || []).length, 1, 'named once, not once per band');
  assert.ok(!/class="words">[^<]*#aabbcc/.test(html), 'a jacket colour is never named');

  // An unassigned book keeps its band and gets no colour.
  assert.ok(html.includes('<i class="empty">'), 'the unfilled band is drawn as a hatch');
  assert.ok(html.includes('class="prov"'), 'and a retiring jacket band is marked');
});

test('the poster never carries the citation — one image, one idea', () => {
  // Provenance is the book page's job. A sentence per band is a different
  // object, and the whole argument for killing the cover collage was that
  // the sheet says one thing.
  const html = P.posterHTML({
    title: 'After September', code: 'A/W 25', label: 'Autumn/Winter 25', count: 1,
    strip: [{
      hex: '#23262B', emotion: 'Grief', name: 'Slate, Deep', source: 'derived',
      evidence: "Stoner's marriage is presented as a long defeat he does not resist.",
      section: 'Themes'
    }]
  });
  assert.ok(!html.includes('long defeat'), 'no evidence on the sheet');
  assert.ok(!html.includes('Themes'), 'and no section name either');
});

test('a stored strip of bare hexes still renders', () => {
  const html = P.posterHTML({
    title: 'After October', code: 'A/W 23', label: 'Autumn/Winter 23', count: 2,
    strip: ['#c8beaa', '#817f6f']
  });
  assert.ok(html.includes('background:#c8beaa'));
  assert.ok(!html.includes('class="words"'), 'an unnamed strip gets no plinth key');
});

test('a title is never set twice — an untitled season falls back to its count', () => {
  const html = P.posterHTML({
    title: '', code: 'S/S 26', label: 'Spring/Summer 26', count: 3, strip: []
  });
  assert.ok(html.includes('SPRING / SUMMER 26'));
  assert.ok(html.includes('Three books'));
  assert.ok(!/class="title">\s*Spring\/Summer/.test(html));
});

test('the escape holds against a title that is trying to be markup', () => {
  const html = P.posterHTML({
    title: '"><script>alert(1)</script>', code: 'A/W 25', label: 'Autumn/Winter 25',
    count: 1, note: '<img src=x onerror=alert(1)>. And a second.',
    strip: [{ hex: '#fff"><b>', emotion: '<b>Grief</b>', source: 'derived' }]
  });
  // The escaped text still CONTAINS the words — `&lt;img src=x onerror=…&gt;`
  // is the note, printed. What must not survive is live markup, and an
  // attribute the strip colour has broken out of.
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(html.includes('background:#fff&quot;&gt;&lt;b&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('every trim renders, and none of them lose the foot', () => {
  for (const shape of Object.keys(P.SHAPES)) {
    const html = P.posterHTML({
      title: 'A title long enough to want the smaller size', code: 'A/W 25',
      label: 'Autumn/Winter 25', count: 9,
      note: 'One sentence. Then a second one. Then a third that lands.',
      strip: ['#111', '#222'], shape
    });
    const { w, h } = P.SHAPES[shape];
    assert.ok(html.includes(`width: ${w}px; height: ${h}px`), `${shape} is the right trim`);
    assert.ok(html.includes('class="foot"'), `${shape} keeps its foot`);
  }
});
