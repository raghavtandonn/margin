import test from 'node:test';
import assert from 'node:assert/strict';

const BC = await import('../lib/book-colour.js');
const P = await import('../lib/palette.js');
const OK = await import('../lib/oklab.js');

const blended = {
  colour_id: 'grief',
  colour_hex: '#3B3A38',
  colour_name: 'Slate, Kept',
  colour_components: JSON.stringify([
    { id: 'grief', weight: 0.6, section: 'Themes', evidence: 'A long defeat he does not resist.' },
    { id: 'nostalgia', weight: 0.4, section: 'Themes', evidence: 'The unopened book in his hands.' }
  ])
};

// ── THE THREE STATES ─────────────────────────────────────

test('a derived colour is the blend, not any anchor', () => {
  const out = BC.effective(blended);
  assert.equal(out.source, 'derived');
  assert.equal(out.hex, '#3B3A38');
  assert.notEqual(out.hex, P.colourOf('grief').hex, 'the blend is its own colour');
  assert.equal(out.name, 'Slate, Kept');
  assert.equal(out.emotion, 'Grief', 'the nearest anchor, for grouping');
});

test('the components come back with their anchors and their citations', () => {
  const out = BC.effective(blended);
  assert.equal(out.components.length, 2);
  assert.equal(out.components[0].emotion, 'Grief');
  assert.equal(out.components[0].anchorHex, P.colourOf('grief').hex);
  assert.equal(out.components[1].emotion, 'Nostalgia');
  assert.match(out.components[1].evidence, /unopened book/);
  assert.equal(out.components.reduce((n, c) => n + c.weight, 0).toFixed(2), '1.00');
});

test('components already parsed are accepted as well as JSON', () => {
  const out = BC.effective({ ...blended, colour_components: JSON.parse(blended.colour_components) });
  assert.equal(out.components.length, 2);
});

test('§05 — nothing is substituted for a book with no colour', () => {
  const out = BC.effective({});
  assert.equal(out.source, 'none');
  assert.equal(out.hex, null);
  assert.equal(out.name, null);
  assert.deepEqual(out.components, []);
});

test('a jacket colour is never named, because it is not a claim', () => {
  const out = BC.effective({ season_colour: '#aabbcc' });
  assert.equal(out.source, 'provisional');
  assert.equal(out.hex, '#aabbcc');
  assert.equal(out.name, null);
  assert.equal(out.emotion, null);
});

test('a hex with no valid anchor is not a colour', () => {
  // Both halves are required: the blend to draw, the anchor to name it by.
  assert.equal(BC.effective({ colour_hex: '#3B3A38' }).source, 'none');
  assert.equal(BC.effective({ colour_hex: '#3B3A38', colour_id: 'ochre' }).source, 'none');
  assert.equal(BC.effective({ colour_id: 'grief' }).source, 'none');
});

test('malformed component JSON degrades to no components, not a throw', () => {
  const out = BC.effective({ ...blended, colour_components: '{not json' });
  assert.equal(out.source, 'derived');
  assert.deepEqual(out.components, []);
});

test('there is no reader override left to consult', () => {
  // It was built and it is gone: the colour is what it is. A stale
  // `reading_colour_id` on a joined row must not resurrect it.
  const out = BC.effective({ ...blended, reading_colour_id: 'calm' });
  assert.equal(out.hex, '#3B3A38');
  assert.equal(out.emotion, 'Grief');
  assert.equal(BC.setOverride, undefined);
  assert.equal(BC.passForColour, undefined);
  assert.deepEqual(BC.SOURCES, ['derived', 'provisional', 'none']);
});
