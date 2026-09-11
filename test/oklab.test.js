import test from 'node:test';
import assert from 'node:assert/strict';

const OK = await import('../lib/oklab.js');
const P = await import('../lib/palette.js');

// ── THE SPACE ────────────────────────────────────────────

test('every anchor round-trips exactly', () => {
  // Not "close enough": a stored blend is recomputed from its components on
  // demand, and a conversion that drifts by a channel each way would make
  // the same components produce a different hex on a different day.
  for (const c of P.PALETTE) {
    assert.equal(OK.fromOklab(OK.oklab(c.hex)), c.hex.toUpperCase(), c.id);
  }
});

test('black, white and mid grey land where they should', () => {
  assert.equal(OK.oklab('#000000')[0].toFixed(4), '0.0000');
  assert.equal(OK.oklab('#FFFFFF')[0].toFixed(3), '1.000');
  const [, a, b] = OK.oklab('#808080');
  assert.ok(Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6, 'grey has no chroma');
});

test('nonsense is null, not a throw', () => {
  for (const bad of [null, undefined, '', 'red', '#12345', 'zzzzzz']) {
    assert.equal(OK.oklab(bad), null);
    assert.equal(OK.parseHex(bad), null);
  }
});

// ── THE BLEND ────────────────────────────────────────────

test('blending happens in Oklab, and it is not the hex average', () => {
  // This is the whole reason the module exists. Averaging gamma-encoded
  // channels loses chroma and drifts toward grey; the two results differ,
  // and the Oklab one is the one the eye agrees with.
  const a = P.colourOf('delight').hex;   // #E8C34A
  const b = P.colourOf('calm').hex;      // #6E93A8

  const mixed = OK.blend([{ hex: a, weight: 1 }, { hex: b, weight: 1 }]).hex;
  const naive = OK.toHex([0, 1, 2].map((i) => (OK.parseHex(a)[i] + OK.parseHex(b)[i]) / 2));
  assert.notEqual(mixed, naive);

  // And the blend sits between its ingredients rather than outside them.
  const [da, db] = [OK.distanceHex(mixed, a), OK.distanceHex(mixed, b)];
  assert.ok(Math.abs(da - db) < 0.02, 'an even blend is even');
  assert.ok(da < OK.distanceHex(a, b), 'and lies between them');
});

test('weights move the result toward the heavier anchor', () => {
  const g = P.colourOf('grief').hex;
  const d = P.colourOf('delight').hex;
  const heavy = OK.blend([{ hex: g, weight: 9 }, { hex: d, weight: 1 }]).hex;
  assert.ok(OK.distanceHex(heavy, g) < OK.distanceHex(heavy, d));
});

test('weights need not be normalised — the ratio is what counts', () => {
  const parts = (w) => [{ hex: P.colourOf('grief').hex, weight: 2 * w },
                        { hex: P.colourOf('calm').hex, weight: 1 * w }];
  assert.equal(OK.blend(parts(1)).hex, OK.blend(parts(37)).hex);
});

test('one component blends to itself', () => {
  assert.equal(OK.blend([{ hex: '#23262B', weight: 1 }]).hex, '#23262B');
});

test('nothing usable blends to nothing', () => {
  assert.equal(OK.blend([]), null);
  assert.equal(OK.blend([{ hex: 'nonsense', weight: 1 }]), null);
  assert.equal(OK.blend([{ hex: '#23262B', weight: 0 }]), null);
  assert.equal(OK.blend(null), null);
});

// ── SPREAD, THE AUDIT'S INSTRUMENT ───────────────────────

test('spread measures how tightly a set sits around its own centroid', () => {
  const anchors = OK.spread(P.PALETTE.map((c) => c.hex));
  assert.equal(anchors.n, 20);
  // The number the audit's threshold is calibrated against. If the palette
  // is ever re-tuned this moves, and the threshold has to move with it.
  assert.equal(anchors.mean.toFixed(3), '0.198');

  // Three near-identical colours are a cluster, and must measure as one.
  const tight = OK.spread(['#3B3A38', '#3C3B39', '#3A3937']);
  assert.ok(tight.mean < 0.01, `${tight.mean}`);
  assert.ok(tight.mean < anchors.mean / 10);
});

test('spread needs two colours to mean anything', () => {
  assert.equal(OK.spread(['#000000']), null);
  assert.equal(OK.spread([]), null);
});

test('distance is symmetric and zero on itself', () => {
  assert.equal(OK.distanceHex('#23262B', '#23262B'), 0);
  assert.equal(OK.distanceHex('#23262B', '#E8C34A'), OK.distanceHex('#E8C34A', '#23262B'));
  assert.equal(OK.distanceHex('#23262B', 'nope'), null);
});

// ── THE NAME GRAMMAR ─────────────────────────────────────

test('a blend is named from its heaviest component and its second', () => {
  assert.equal(P.blendName('grief', 'nostalgia'), 'Slate, Kept');
  assert.equal(P.blendName('grief', 'tenderness'), 'Slate, Dusted');
  assert.equal(P.blendName('loneliness', 'delight'), 'Harbour Grey, Bright');
});

test('the name never comes from the anchor nearest the blend', () => {
  // Nearest-anchor naming collapsed geometrically: a blend lands inside the
  // hull of its components and drifts to the middle of the palette, where
  // Smoke Violet sits. Measured across 123 cards, the name disagreed with
  // the dominant component 79% of the time, and one card sat 0.0790 from
  // Smoke Violet against 0.0821 from Harbour Grey — a four percent margin
  // deciding a name — while loneliness was 67% of the blend.
  const heavy = P.colourOf('melancholy');
  const light = P.colourOf('tenderness');
  const mixed = OK.blend([{ hex: heavy.hex, weight: 0.73 }, { hex: light.hex, weight: 0.27 }]).hex;

  const near = P.nearestAnchor(mixed, OK);
  const named = P.blendName('melancholy', 'tenderness');

  // The name follows the weights a reader can see, whatever the mix is
  // nearest to.
  assert.equal(named, 'Indigo, Dusted');
  assert.equal(P.baseName(named), P.baseName(heavy.name));
  if (near.id !== 'melancholy') {
    assert.notEqual(P.baseName(named), P.baseName(near.name),
                    'the name tracked the result rather than the components');
  }
});

test('a single-anchor colour keeps the anchor’s own name', () => {
  assert.equal(P.blendName('grief', 'grief'), 'Slate, Deep');
  assert.equal(P.blendName('grief', null), 'Slate, Deep');
});

test('every pairing produces a name, and none of them is free text', () => {
  for (const a of P.IDS) {
    for (const b of P.IDS) {
      const name = P.blendName(a, b);
      assert.ok(name && name.length < 40, `${a}+${b} → ${name}`);
    }
  }
  assert.equal(P.blendName('ochre', 'grief'), null);
});

test('the nearest anchor is found perceptually, not by hex', () => {
  for (const c of P.PALETTE) {
    assert.equal(P.nearestAnchor(c.hex, OK).id, c.id, `${c.id} is nearest itself`);
  }
  // A blend of grief and delight is nearest neither of them.
  const mid = OK.blend([{ hex: P.colourOf('grief').hex, weight: 1 },
                        { hex: P.colourOf('delight').hex, weight: 1 }]).hex;
  const near = P.nearestAnchor(mid, OK);
  assert.ok(near.d > 0, `${mid} → ${near.emotion}`);
});
