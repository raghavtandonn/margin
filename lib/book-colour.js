import { colourOf, isColourId } from './palette.js';

// ── THE EFFECTIVE COLOUR ─────────────────────────────────
//
// One function decides what colour a book shows, everywhere. Three states:
//
//   1. derived      — the blend, its components, and each one's citation
//   2. provisional  — a retiring jacket colour; hatched, dimmed, never named
//   3. nothing      — the unfilled state, which is legitimate
//
// §05: a book with no colour is NOT given one. No substitute, no guess, no
// jacket colour standing in. It renders as an outline with a hairline hatch
// and it must look chosen, because it is.
//
// THERE IS NO READER OVERRIDE. It was built, and it is gone: the colour is
// what it is. What went with it was `readings.colour_id`, the picker on the
// book page, POST /work/:id/colour, the edit_history logging, and the
// override-direction report in the audit. The columns stay in the schema
// because dropping one in SQLite is a table rebuild, and nothing reads them.

export const SOURCES = ['derived', 'provisional', 'none'];

const NOTHING = Object.freeze({
  id: null, hex: null, name: null, emotion: null,
  components: [], source: 'none'
});

/**
 * @param {object} row  a joined row carrying some of:
 *   colour_id, colour_hex, colour_name, colour_components, season_colour
 */
export function effective(row = {}) {
  if (row.colour_hex && isColourId(row.colour_id)) {
    let components = [];
    if (Array.isArray(row.colour_components)) components = row.colour_components;
    else {
      try { components = JSON.parse(row.colour_components || '[]'); } catch { /* none */ }
    }
    return {
      // The nearest anchor, for grouping and for the name. The colour that
      // is DRAWN is the blend, and it is usually not any anchor's hex.
      id: row.colour_id,
      hex: row.colour_hex,
      name: row.colour_name || colourOf(row.colour_id)?.name || null,
      emotion: colourOf(row.colour_id)?.emotion || null,
      components: components.map((c) => ({
        ...c,
        emotion: colourOf(c.id)?.emotion || null,
        // The anchor's own name, so a derivation can show Carmine, Soft
        // going in beside Carmine, Oxidised coming out.
        name: colourOf(c.id)?.name || null,
        anchorHex: colourOf(c.id)?.hex || null
      })),
      source: 'derived'
    };
  }

  // Extraction stays visible while it retires, but it is never named and
  // never mistaken for a derived colour.
  const jacket = row.season_colour ?? null;
  if (jacket && /^#[0-9a-f]{6}$/i.test(jacket)) {
    return { ...NOTHING, hex: jacket, source: 'provisional' };
  }

  return NOTHING;
}
