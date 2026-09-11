import { all, get } from '../db/index.js';
import * as S from '../lib/seasons.js';
import * as RUN from '../lib/season-run.js';
import * as M from '../lib/movements.js';

// Close what is due, refresh the open season, and print what came out.
//
// §3 — the closing job is scheduled and idempotent, and the server runs it
// hourly. This is the same work from the terminal, for a deployment that
// would rather drive it from cron.
//
//   npm run seasons
//   npm run seasons -- --code aw23

const args = process.argv.slice(2);
const at = args.indexOf('--code');
const only = at >= 0 ? args[at + 1] : null;

const user = get('SELECT id, settings FROM users WHERE is_tombstone = 0 ORDER BY id LIMIT 1');
if (!user) { console.log('  no reader'); process.exit(0); }

let localOnly = true;
try { localOnly = JSON.parse(user.settings || '{}').local_only !== false; } catch { /* default */ }

console.log('"MARGIN" — SEASONS');
console.log(`  local-only: ${localOnly ? 'on — nothing leaves this machine' : 'off'}\n`);

if (only) {
  await RUN.refresh(user.id, only, { localOnly, force: true });
} else {
  const closed = await RUN.closeDue(user.id, { localOnly });
  for (const s of closed) {
    const n = S.framesOf(s.id).length;
    console.log(`  ${s.code.toUpperCase()} closed. ${n} ${n === 1 ? 'book' : 'books'}.`);
  }
}

for (const row of S.listSeasons(user.id)) {
  const frames = S.framesOf(row.id);
  if (!frames.length && row.state !== 'open') continue;
  const meta = S.parseCode(row.code);
  const movements = M.movementsOf(row.id);
  const empty = movements.filter((m) => m.is_empty).length;

  console.log(
    `  ${meta.short.padEnd(8)} ${String(frames.length).padStart(3)} ${frames.length === 1 ? 'book ' : 'books'}  ` +
    `${row.state.padEnd(7)} ${(row.given_title || '').slice(0, 30).padEnd(32)}` +
    (movements.length ? `${movements.length} movements${empty ? `, ${empty} empty` : ''}` : '')
  );
}
