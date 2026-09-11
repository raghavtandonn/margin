// A backtick inside a SQL template literal ends the literal, and the file
// then fails to parse with an error that points at the wrong line. It has
// happened twice, both times in a comment written inside the query.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.js')) continue;

    const src = readFileSync(p, 'utf8');
    // Every SQL-looking template literal, then any backtick inside it.
    for (const m of src.matchAll(/`\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE)\b[\s\S]*?`/gi)) {
      const inner = m[0].slice(1, -1);
      if (inner.includes('`')) {
        console.error(`${p}: backtick inside a SQL template literal`);
        bad++;
      }
    }
  }
};
walk('lib'); walk('routes'); walk('db');
console.log(bad ? `${bad} problem(s)` : 'sql literals ok');
process.exit(bad ? 1 : 0);
