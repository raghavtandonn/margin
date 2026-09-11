import { runDue } from '../lib/jobs.js';

// §12 — "Deletion must actually delete on a defined schedule, not soft-flag
// forever." The server runs this hourly on its own; this is the same work,
// runnable from cron on a deployment that would rather drive it externally.
//
//   npm run purge

const done = runDue();
console.log('"MARGIN" — SWEEP');
for (const [what, n] of Object.entries(done)) {
  console.log(`  ${what.padEnd(14)} ${n}`);
}
