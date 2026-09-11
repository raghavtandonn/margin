#!/usr/bin/env node
/**
 * Recompute every card's name and grouping anchor from its own components.
 *
 *   node scripts/colours-rename.mjs [--dry]
 *
 * Pure arithmetic over what is already stored — no retrieval, no model, no
 * network. The blends themselves are untouched: only the NAME and the anchor
 * a card is grouped under change, because both used to be taken from
 * whichever anchor the blend landed nearest rather than from what the blend
 * is mostly made of.
 */
import { all, run, get } from '../db/index.js';
import { colourOf, blendName, baseName } from '../lib/palette.js';

const DRY = process.argv.includes('--dry');
const rows = all(`SELECT id, title, colour_id, colour_name, colour_components
                    FROM works WHERE colour_hex IS NOT NULL`);

let changed = 0;
const before = new Map();
const after = new Map();

for (const r of rows) {
  let comps = [];
  try { comps = JSON.parse(r.colour_components) || []; } catch { continue; }
  if (!comps.length) continue;

  const dominant = comps[0].id;
  const second = comps[1]?.id ?? null;
  const name = blendName(dominant, second);
  if (!name) continue;

  before.set(baseName(r.colour_name), (before.get(baseName(r.colour_name)) || 0) + 1);
  after.set(baseName(name), (after.get(baseName(name)) || 0) + 1);

  if (name !== r.colour_name || dominant !== r.colour_id) {
    changed++;
    if (!DRY) run('UPDATE works SET colour_id = ?, colour_name = ? WHERE id = ?',
                  dominant, name, r.id);
  }
}

const report = (label, m, total) => {
  const s = [...m].sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${label}`);
  console.log(`    distinct base names   ${m.size}`);
  console.log(`    most common           ${s[0][0]} — ${s[0][1]} of ${total} (${Math.round(s[0][1] / total * 100)}%)`);
  for (const [b, n] of s.slice(0, 8)) console.log(`      ${String(n).padStart(3)}  ${b}`);
};

console.log(`${rows.length} cards${DRY ? ' (dry run)' : ''} · ${changed} renamed`);
report('BEFORE — base from the anchor nearest the blend', before, rows.length);
report('AFTER  — base from the heaviest component', after, rows.length);
