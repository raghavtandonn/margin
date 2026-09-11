import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePNG } from './png.js';
import { effective } from './book-colour.js';

// ── §8 — THE COLOUR SIGNATURE ────────────────────────────
//
// Automatic art direction at almost no cost.
//
// Because the strip derives from actual jackets in actual finish order,
// every season looks different from every other one and nobody art-directs
// anything. That is the whole trick: the reader's own sequence of books is
// the design.
//
// The value is cached on the edition. Recomputing it per render would be
// four hundred image decodes on a page load.

// ── LAB ──────────────────────────────────────────────────
// Clustering happens in LAB rather than RGB because LAB distance is roughly
// perceptual: two colours a reader would call "the same blue" sit close
// together, which is what makes k=5 land on jacket colours instead of on
// arbitrary slices of the RGB cube.

const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function rgbToLab([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);

  // sRGB → XYZ (D65)
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const chroma = ([, a, b]) => Math.sqrt(a * a + b * b);

const dist2 = (p, q) => {
  const dl = p[0] - q[0], da = p[1] - q[1], db = p[2] - q[2];
  return dl * dl + da * da + db * db;
};

// ── k-means ──────────────────────────────────────────────
// Deterministic on purpose: §15 asks for a poster that renders identically
// across machines, and a random seed would make the strip differ per run.
// Initial centroids are picked by even stride through the sorted sample.
export function kmeans(points, k = 5, iterations = 12) {
  if (!points.length) return [];
  if (points.length <= k) return points.map((p) => ({ centroid: p, size: 1 }));

  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const stride = Math.floor(sorted.length / k);
  let centroids = Array.from({ length: k }, (_, i) => sorted[i * stride].slice());

  let assignment = new Array(points.length).fill(0);

  for (let it = 0; it < iterations; it++) {
    let moved = false;

    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(points[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignment[i] !== best) { assignment[i] = best; moved = true; }
    }

    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assignment[i]];
      s[0] += points[i][0]; s[1] += points[i][1]; s[2] += points[i][2]; s[3]++;
    }
    centroids = centroids.map((c, i) =>
      sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c
    );

    if (!moved) break;
  }

  const sizes = centroids.map(() => 0);
  for (const a of assignment) sizes[a]++;

  return centroids.map((centroid, i) => ({ centroid, size: sizes[i] }))
                  .filter((c) => c.size > 0);
}

// ── LAB → hex, for rendering ─────────────────────────────
export function labToRgb([L, a, bb]) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);

  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;

  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  const gamma = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return [gamma(R), gamma(G), gamma(B)];
}

export const toHex = (rgb) =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/**
 * §8 — pick a book's colour from its jacket.
 *
 *   discard L > 92   paper white
 *   discard L < 8    print black
 *   discard chroma < 8   greys
 *   take the largest remaining cluster
 *   fallback: the darkest non-black cluster
 */
export function pickColour(pixels) {
  if (!pixels.length) return null;

  const lab = pixels.map(rgbToLab);
  const clusters = kmeans(lab, 5);
  if (!clusters.length) return null;

  const usable = clusters.filter((c) => {
    const L = c.centroid[0];
    return L <= 92 && L >= 8 && chroma(c.centroid) >= 8;
  });

  if (usable.length) {
    const largest = usable.reduce((a, b) => (b.size > a.size ? b : a));
    return toHex(labToRgb(largest.centroid));
  }

  // Nothing coloured survived — a black-and-white jacket. The darkest
  // non-black cluster is closer to the object than a grey average would be.
  const nonBlack = clusters.filter((c) => c.centroid[0] >= 8);
  if (!nonBlack.length) return null;
  const darkest = nonBlack.reduce((a, b) => (b.centroid[0] < a.centroid[0] ? b : a));
  return toHex(labToRgb(darkest.centroid));
}

// ── Reading a cover ──────────────────────────────────────
// The same approach the spine sampler takes: `sips` reduces the jacket to a
// small bitmap and lib/png.js reads the pixels back, so there is no JPEG
// decoder to maintain. Platform-specific, and SECURITY.md already records
// that this codebase leans on sips.

let sipsChecked = null;
export function hasSips() {
  if (sipsChecked !== null) return sipsChecked;
  try { execFileSync('sips', ['--version'], { stdio: 'ignore' }); sipsChecked = true; }
  catch { sipsChecked = false; }
  return sipsChecked;
}

/** §8 — downsample to 64×64, then cluster. */
export function colourOfCover(buffer) {
  if (!buffer?.length || !hasSips()) return null;

  const dir = mkdtempSync(join(tmpdir(), 'margin-colour-'));
  try {
    const src = join(dir, 'in.jpg');
    const out = join(dir, 'out.png');
    writeFileSync(src, buffer);

    execFileSync('sips', ['-z', '64', '64', '-s', 'format', 'png', src, '--out', out],
                 { stdio: 'ignore', timeout: 15_000 });

    return pickColour(decodePNG(readFileSync(out)));
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

/**
 * The strip itself: one band per book, in finish order.
 *
 * A book with no colour contributes a band with no hex rather than being
 * skipped — the strip is a record of the sequence, and dropping a band
 * would misreport how many books there were. It used to substitute
 * #2A2622, which the colour system forbids by name: §05 says an unassigned
 * book is drawn as an unfilled hatch and is never given a colour it did not
 * earn.
 *
 * Each band carries its source, because the poster and the page draw the
 * four states differently — a derived colour is flat, a provisional jacket
 * colour is hatched over its own hue while it retires, and nothing is an
 * outline.
 */
export const stripFrom = (frames) =>
  frames.map((f) => {
    const c = effective(f);
    return { hex: c.hex, id: c.id, emotion: c.emotion, name: c.name, source: c.source };
  });

/**
 * `seasons.colour_strip`, whichever shape it is in.
 *
 * Fifteen closed seasons hold a JSON array of bare hex strings, written
 * before the colour system existed. Rewriting them would mean re-deriving
 * every colour for every book in every closed season, which is a network
 * job, not a migration — so the reader accepts both shapes and an old strip
 * comes back as provisional bands, which is exactly what it is.
 */
export function bands(stored) {
  const list = Array.isArray(stored) ? stored : [];
  return list.map((b) => {
    if (b && typeof b === 'object') {
      return { hex: b.hex ?? null, id: b.id ?? null, emotion: b.emotion ?? null,
               name: b.name ?? null, source: b.source || (b.hex ? 'provisional' : 'none') };
    }
    if (typeof b === 'string' && /^#[0-9a-f]{6}$/i.test(b)) {
      return { hex: b, id: null, emotion: null, name: null, source: 'provisional' };
    }
    return { hex: null, id: null, emotion: null, name: null, source: 'none' };
  });
}
