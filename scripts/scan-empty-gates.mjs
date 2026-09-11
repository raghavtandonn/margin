// Empty states that only privileged viewers can see.
//
// The shape, from the club page: a sentence explaining that there is
// nothing here, rendered inside a branch gated on the viewer being an
// admin/host/owner. Everyone else gets a blank region, and the one person
// who can see the explanation is the one person who would never file it.
//
// Walks tags in document order so a gate that OPENS AFTER the text on the
// same line does not count as enclosing it — that is the shape of the
// correct fix (text for everyone, action gated), and counting it produces
// a false positive on the very line that was just repaired.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRIV = /\b(isAdmin|isHost|isOwner|isMine|isSelf|canManage|canEdit|canModerate|isStaff)\b/;
const EMPTY = /\b(nothing|nobody|no one|none|empty|yet)\b/i;

const files = readdirSync('views', { recursive: true }).filter((f) => f.endsWith('.ejs'));
const hits = [];
const TAG = /<%(#|=|-|_)?([\s\S]*?)%>/g;

for (const f of files) {
  const src = readFileSync(join('views', f), 'utf8');
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  const stack = [];
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    // Literal text since the previous tag — what a reader actually sees.
    const text = src.slice(last, m.index);
    if (EMPTY.test(text) && /[A-Za-z]{3,}/.test(text)) {
      const gate = stack.find((s) => PRIV.test(s.cond));
      if (gate) hits.push({ f, line: lineAt(m.index), gate: gate.cond.trim(), at: gate.line,
                            text: text.replace(/\s+/g, ' ').trim().slice(0, 70) });
    }
    last = m.index + m[0].length;

    if (m[1] === '#') continue;                    // comment: not rendered
    const code = m[2];
    for (let k = 0; k < (code.match(/\}/g) || []).length; k++) stack.pop();
    const ifs = [...code.matchAll(/\bif\s*\((.+?)\)\s*\{/g)];
    for (const g of ifs) stack.push({ cond: g[1], line: lineAt(m.index) });
    // A bare `{` that is not an if (forEach callbacks etc.) still nests.
    const braces = (code.match(/\{/g) || []).length;
    for (let k = ifs.length; k < braces; k++) stack.push({ cond: '', line: lineAt(m.index) });
  }
}

for (const h of hits) {
  console.log(`${h.f}:${h.line}\n   gated by  (${h.gate})  opened line ${h.at}\n   text      "${h.text}"\n`);
}
console.log(hits.length ? `${hits.length} hit(s)` : 'no admin-gated empty states found');
console.log(`scanned ${files.length} templates`);
