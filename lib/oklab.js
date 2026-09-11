// ── OKLAB ────────────────────────────────────────────────
//
// Blending happens here and nowhere else.
//
// Mixing in hex — which is mixing in gamma-encoded sRGB — is the reason
// naive colour blends come out muddy: the channels are not linear in
// lightness, so a half-and-half of two saturated colours loses chroma and
// drifts toward grey. Mixing in Lab is better and still wrong in the blues,
// where its hue lines bend. Oklab was built for exactly this operation:
// uniform enough that a weighted average of three anchors lands where the
// eye says it should.
//
// Ottosson's matrices, unmodified. D65, sRGB primaries.

const cbrt = Math.cbrt;

const toLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const toSRGB = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = (rgb) =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16)
                        .padStart(2, '0')).join('').toUpperCase();

/** sRGB hex → Oklab [L, a, b]. */
export function oklab(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(toLinear);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
}

/** Oklab [L, a, b] → sRGB hex, clamped into gamut by the channel clamp. */
export function fromOklab([L, A, B]) {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.2914855480 * B;

  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;

  return toHex([
    toSRGB(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSRGB(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSRGB(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  ]);
}

/** Perceptual distance. Euclidean is the point of the space. */
export const distance = (p, q) =>
  Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);

export const distanceHex = (a, b) => {
  const [p, q] = [oklab(a), oklab(b)];
  return p && q ? distance(p, q) : null;
};

/**
 * The blend: a weighted average of anchors, in Oklab.
 *
 * `components` is [{ hex, weight }]. Weights are used as given — the caller
 * renormalises, because the caller is also the one enforcing the cap, and
 * doing both here would hide which of the two dropped a component.
 */
export function blend(components) {
  const usable = (components || []).filter((c) => c && c.weight > 0 && oklab(c.hex));
  if (!usable.length) return null;

  const total = usable.reduce((n, c) => n + c.weight, 0);
  if (!(total > 0)) return null;

  const acc = [0, 0, 0];
  for (const c of usable) {
    const lab = oklab(c.hex);
    const w = c.weight / total;
    acc[0] += lab[0] * w;
    acc[1] += lab[1] * w;
    acc[2] += lab[2] * w;
  }
  return { lab: acc, hex: fromOklab(acc) };
}

/** The centroid of a set of hexes, and how tightly they sit around it. */
export function spread(hexes) {
  const labs = (hexes || []).map(oklab).filter(Boolean);
  if (labs.length < 2) return null;

  const c = [0, 1, 2].map((i) => labs.reduce((n, l) => n + l[i], 0) / labs.length);
  const radii = labs.map((l) => distance(l, c));

  return {
    n: labs.length,
    centroid: c,
    centroidHex: fromOklab(c),
    mean: radii.reduce((a, b) => a + b, 0) / radii.length,
    max: Math.max(...radii),
    min: Math.min(...radii)
  };
}
