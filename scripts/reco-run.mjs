// Generate and store a pile run.  npm run reco:run
import { db } from '../db/index.js';
import * as PILE from '../lib/reco-pile.js';
const out = PILE.generate(Number(process.argv[2] || 1));
console.log(out ? `\n  run ${out.runId}: ${out.count} recommendations stored\n`
                : '\n  no run: profile or pile is empty\n');
db.exec('PRAGMA optimize');
