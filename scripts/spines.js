import { all, get, run } from '../db/index.js';
import { readCached } from '../lib/covers.js';
import { decodePNG } from '../lib/png.js';

// §5.2 / §5.7 — sample each cover's dominant left-edge colour ONCE, at
// import, and store it on the edition. Never per render: with 400+ spines
// that would be 400 canvas reads on every page load.
//
// Real spines continue the cover artwork, so the leftmost column of the
// jacket is the closest thing to the spine's true colour that we have.
//
// Decoding JPEG in pure JS is more than this needs, so the sampler shells out
// to `sips` (built into macOS) to reduce each cover to a tiny bitmap and reads
// the pixels back. Where sips is unavailable the spine falls back to the
// plain-cloth rendering, which is a designed state rather than an error.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const ALL = args.includes('--all');

function hasSips() {
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Reduce the cover to a narrow strip of its left edge, then to a handful of
// pixels, and take the median — median rather than mean so one bright
// element on the jacket does not drag the whole spine toward it.
function sampleLeftEdge(buf, dir) {
  const src = join(dir, 'in.jpg');
  const out = join(dir, 'out.png');
  writeFileSync(src, buf);

  // Crop to the left ~10% of the image, then resample down to 1×8.
  const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], {
    encoding: 'utf8'
  });
  const w = Number(/pixelWidth:\s*(\d+)/.exec(info)?.[1] || 0);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(info)?.[1] || 0);
  if (!w || !h) return null;

  const stripW = Math.max(1, Math.round(w * 0.1));
  execFileSync('sips', ['-c', String(h), String(stripW), '--cropOffset', '0', '0', src, '--out', out], { stdio: 'ignore' });
  execFileSync('sips', ['-z', '8', '1', '-s', 'format', 'png', out, '--out', out], { stdio: 'ignore' });

  const png = readFileSync(out);
  const pixels = decodePNG(png);
  if (!pixels.length) return null;

  const median = (idx) => {
    const vals = pixels.map((p) => p[idx]).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  const [r, g, b] = [median(0), median(1), median(2)];
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function main() {
  if (!hasSips()) {
    console.log('  sips UNAVAILABLE — SPINES WILL USE THE PLAIN-CLOTH FALLBACK');
    return;
  }

  const rows = all(
    `SELECT id, cover_cache_key FROM editions
     WHERE cover_cache_key IS NOT NULL ${ALL ? '' : 'AND spine_color IS NULL'}`
  );

  console.log('"MARGIN" — SAMPLING SPINE COLOURS');
  console.log(`  ${rows.length} COVERS\n`);

  const dir = mkdtempSync(join(tmpdir(), 'margin-spine-'));
  let done = 0;
  let failed = 0;

  for (const [i, ed] of rows.entries()) {
    const cached = readCached(ed.cover_cache_key);
    if (!cached) { failed++; continue; }
    try {
      const hex = sampleLeftEdge(cached.buf, dir);
      if (hex) {
        run('UPDATE editions SET spine_color = ? WHERE id = ?', hex, ed.id);
        done++;
      } else failed++;
    } catch {
      failed++;
    }
    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      process.stdout.write(`  [${String(i + 1).padStart(4)}/${rows.length}] ${done} sampled\n`);
    }
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n  SAMPLED  ${done}`);
  if (failed) console.log(`  FALLBACK ${failed}  (plain cloth binding)`);
}

main();
