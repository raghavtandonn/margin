// ── RATING, FINAL (v0.5.1 §2) ────────────────────────────
// Stars. One to five, half-star steps. Never a colour, chip, strip, patch or
// colour chip of any kind. An absent rating reads as absent: no placeholder,
// no dash, no gray blob, nothing at all.

// A Goodreads "My Rating" of 0 means UNRATED. Mapping it to one star is the
// most common import bug there is.
export function starsFromImport(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0.5, Math.min(5, Math.round(n * 2) / 2));
}

export const clampStars = starsFromImport;

// Glyphs. Half-stars render as a real half glyph rather than a rounded whole.
export function starGlyphs(stars) {
  if (stars == null) return '';
  const s = Math.max(0, Math.min(5, Number(stars)));
  const full = Math.floor(s);
  const half = s - full >= 0.5;
  // U+2BE8 LEFT HALF BLACK STAR is in none of the four faces this product
  // loads, so every half rating rendered as a tofu box. A fraction sign
  // after the full stars is what a film log does, and it sets everywhere.
  // Filled stars and a half, with no hollow remainder. A row of empty
  // stars is a scorecard telling you what you did not give; the rating is
  // the marks that are there.
  return '★'.repeat(full) + (half ? '½' : '');
}

// The compact form, for rows where glyphs would crowd.
export function starText(stars) {
  if (stars == null) return '';
  const s = Number(stars);
  return `${Number.isInteger(s) ? s : s.toFixed(1)}★`;
}

export function starLabel(stars) {
  if (stars == null) return 'Not rated';
  return `${Number(stars)} of 5 stars`;
}

// ── MARKS: REMOVED ───────────────────────────────────────
//
// A fixed set of ten one-tap facets — "STAYED WITH ME", "CRIED", "WANTED TO
// ARGUE WITH IT" — that was capturable by nothing. The route accepted them,
// the library stored them, the API returned them, `h.marks()` could render
// them, and no template ever drew a control: zero rows in `readings.marks`
// across the whole library, from the day it shipped.
//
// It is gone rather than finished because the colour system now occupies
// this ground, and the two are different axes. The ten were VERDICTS on the
// reading — will I reread it, was the work worth it, was it the right time.
// The palette is the RESIDUE the book left. Shipping both would have put two
// emotional scales on one page and invited them to be read as one, which is
// the confusion the split exists to avoid. Nothing was lifted across for the
// same reason: "STAYED WITH ME" is not an emotion, it is a report on one.
//
// NOTE for whoever removes something else called MARKS: `lib/view-helpers.js`
// defines its own, unrelated. That one is the SVG glyph set behind
// `h.mark()`, it renders on the book page, the profile and every review, and
// deleting it removes every icon in the product.

