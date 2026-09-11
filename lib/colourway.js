import { colourOf, IDS } from './palette.js';

// ── §02 — COLORWAY ───────────────────────────────────────
//
// "Dominant colors extracted from the actual jackets, laid out as a season
// palette with fashion-copywriter names."
//
// Both halves of that are gone. The colours are no longer extracted from
// jackets — the colour system derives them from what the sources say a book
// is doing, and a reader can overrule it — and the names are no longer
// generated, because a closed palette of twenty has real names that were
// written once by a person.
//
// What survives is the idea: the season's palette, in the season's own
// proportions, which nobody art-directed. It is still the most
// screenshot-able thing here.

/**
 * The season palette: the distinct colours the season held, with counts.
 *
 * This used to cluster in LAB and invent a name per hex, because the input
 * was four hundred arbitrary jacket colours and "six shades of the same
 * cream" needed collapsing into one swatch. Neither job exists now. The
 * input is a closed set of twenty, so "the same colour" is id equality
 * rather than a distance under a threshold — and a colour's name is its
 * palette entry, written once, rather than a string assembled from a hue
 * angle. `nameOf`, the hue families and the copywriter's qualifiers are all
 * gone with the problem they solved.
 *
 * Order is by count, then by the palette's own order, so a season reads as
 * what it mostly was followed by what else was in it.
 */
export function colourway(bands, { max = 8 } = {}) {
  const seen = new Map();

  for (const b of bands || []) {
    // Only named colours compose a colourway. A retiring jacket colour has
    // no name and an unassigned book has no colour, and neither belongs in
    // a palette that claims to describe what the season felt like.
    const id = typeof b === 'string' ? b : b?.id;
    const entry = colourOf(id);
    if (!entry) continue;

    const at = seen.get(entry.id);
    if (at) at.count++;
    else seen.set(entry.id, { id: entry.id, hex: entry.hex, name: entry.name,
                              emotion: entry.emotion, count: 1 });
  }

  const order = new Map(IDS.map((id, i) => [id, i]));
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || order.get(a.id) - order.get(b.id))
    .slice(0, max);
}

/**
 * §01 — the bruise. "Three permanent, one seasonal. The bruise color
 * rotates each season and is the only thing that changes."
 *
 * A/W 25 is oxblood, named in the spec. The rest rotate through a fixed
 * cycle keyed by the season's own code, so a season's accent never changes
 * once it has been seen — and two people looking at A/W 25 see the same one.
 */
const BRUISES = [
  '#4A1418',  // oxblood
  '#1C2A3A',  // ink blue
  '#3A2A14',  // tobacco
  '#2A3A2A',  // moss
  '#3A1428',  // aubergine
  '#143A38'   // spruce
];

export function bruiseFor(code) {
  const m = /^(SS|AW)(\d{2})$/.exec(String(code || '').toUpperCase());
  if (!m) return BRUISES[0];
  if (m[0] === 'AW25') return '#4A1418';   // named in the spec; pinned.

  const year = Number(m[2]);
  const half = m[1] === 'AW' ? 1 : 0;
  return BRUISES[(year * 2 + half) % BRUISES.length];
}
