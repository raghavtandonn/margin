import test from 'node:test';
import assert from 'node:assert/strict';

// No database. The palette is a constant and everything here is arithmetic
// over it.
const P = await import('../lib/palette.js');

test('the set is closed at twenty, with unique ids', () => {
  assert.equal(P.PALETTE.length, 20);
  assert.equal(new Set(P.IDS).size, 20);
  assert.equal(new Set(P.PALETTE.map((c) => c.hex)).size, 20, 'no two colours share a hex');
  assert.equal(new Set(P.PALETTE.map((c) => c.name)).size, 20, 'nor a name');
});

test('the palette is frozen — nothing adds a twenty-first at runtime', () => {
  assert.throws(() => P.PALETTE.push({ id: 'x' }), TypeError);
});

test('every entry is complete and well formed', () => {
  for (const c of P.PALETTE) {
    assert.match(c.id, /^[a-z]+$/, `${c.id} is a plain id`);
    assert.match(c.hex, /^#[0-9A-F]{6}$/i, `${c.id} has a hex`);
    assert.ok(c.emotion && c.name, `${c.id} has both an emotion and a name`);
    assert.ok(P.VALENCE.includes(c.valence), `${c.id} valence`);
    assert.ok(P.AROUSAL.includes(c.arousal), `${c.id} arousal`);
  }
});

test('all twenty emotion labels are nouns, not phrases', () => {
  // v1.1 §7.6. "Being seen" was the only phrase among nineteen nouns, and a
  // picker of nineteen nouns and one participle reads as a mistake.
  for (const c of P.PALETTE) {
    assert.ok(!/\s/.test(c.emotion), `${c.id} is labelled "${c.emotion}", which is not one word`);
  }
  assert.equal(P.colourOf('recognition').emotion, 'Recognition');
});

test('an unknown id is a null, not a throw', () => {
  for (const bad of [null, undefined, '', 'ochre', 'DREAD', 42, {}]) {
    assert.equal(P.colourOf(bad), null, `${JSON.stringify(bad)}`);
    assert.equal(P.isColourId(bad), false);
  }
  assert.equal(P.colourOf('dread').hex, '#2A1416');
  assert.equal(P.isColourId('dread'), true);
});

test('the picker reads as a gradient, negative to positive', () => {
  const out = P.ordered();
  assert.equal(out.length, 20);
  assert.equal(out[0].valence, '−', 'it opens on the negative end');
  assert.equal(out.at(-1).valence, '+', 'and closes on the positive one');

  // Valence never goes backwards.
  const seen = out.map((c) => P.VALENCE.indexOf(c.valence));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
});

// ── CONTRAST ─────────────────────────────────────────────
//
// The numbers §05 asked for. These are assertions rather than a table in a
// document because a hex edited in six months has to fail loudly here rather
// than quietly on a page nobody measured.

const R = (hex, ground) => Number(P.contrast(hex, P.GROUNDS[ground]).toFixed(2));

test('contrast maths agrees with the known anchors', () => {
  assert.equal(Number(P.contrast('#FFFFFF', '#000000').toFixed(0)), 21);
  assert.equal(Number(P.contrast('#FFFFFF', '#FFFFFF').toFixed(0)), 1);
  assert.equal(P.contrast('nonsense', '#000000'), null);
});

test('§05 — the six swatches the spec expected to fail, do', () => {
  // Named in §05: Salt, Glass and Bone, Warm against a light surface.
  for (const id of ['desolation', 'clarity', 'recognition']) {
    assert.ok(R(P.colourOf(id).hex, 'light') < 3,
      `${id} was expected to fail on light and did not`);
  }
  // And Pitch, Oxidised, Deep Field and Slate, Deep against a dark one.
  for (const id of ['dread', 'awe', 'grief']) {
    assert.ok(R(P.colourOf(id).hex, 'dark') < 3,
      `${id} was expected to fail on dark and did not`);
  }
});

test('the failures are complementary — nothing fails on both grounds', () => {
  // This is what makes a single hairline rule sufficient rather than a
  // per-colour exception list: every swatch is legible on one of the two
  // grounds, so the hairline is carrying the boundary and never the meaning.
  for (const c of P.PALETTE) {
    const both = R(c.hex, 'light') < 3 && R(c.hex, 'dark') < 3;
    assert.ok(!both, `${c.id} is under 3:1 on BOTH grounds`);
  }
});

test('the measured floor is where §7.7 says it is', () => {
  // Pitch, Oxidised on the dark ground is the worst case in the set, and it
  // is not "low contrast" — it is a band that disappears. If this ever rises
  // above ~1.1 someone has moved a hex or a ground token.
  assert.ok(R('#2A1416', 'dark') < 1.1, 'dread on dark');
  assert.ok(R('#2A1416', 'plinth') < 1.2, 'dread on the poster plinth');

  const light = P.PALETTE.filter((c) => R(c.hex, 'light') < 3).length;
  const dark = P.PALETTE.filter((c) => R(c.hex, 'dark') < 3).length;
  assert.equal(light, 8, 'eight swatches need the hairline on the light ground');
  assert.equal(dark, 7, 'seven need it on the dark one');
});

test('inkOn picks the legible ink for every swatch', () => {
  for (const c of P.PALETTE) {
    const ink = P.inkOn(c.hex);
    assert.ok(P.contrast(c.hex, ink) >= 4.5,
      `${c.id} carries ${ink} at only ${P.contrast(c.hex, ink).toFixed(2)}:1`);
  }
});
