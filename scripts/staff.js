import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { get, all, run } from '../db/index.js';
import * as P from '../lib/auth/passwords.js';
import * as TOTP from '../lib/auth/totp.js';
import { seal } from '../lib/crypto.js';
import * as audit from '../lib/audit.js';

// §14 — staff accounts are a separate table, created deliberately from the
// machine that runs the database. There is no self-signup and no web route
// that creates one, because "how do you become staff" is the question the
// Letterboxd incident was ultimately about.
//
//   npm run staff:add
//   npm run staff:add -- --list

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

if (args.includes('--list')) {
  console.log('"MARGIN" — STAFF\n');
  for (const s of all('SELECT id, email, role, created_at, disabled_at FROM staff ORDER BY email')) {
    console.log(`  ${s.email.padEnd(32)} ${s.role.padEnd(8)} ${s.disabled_at ? 'DISABLED' : 'active'}`);
  }
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });

const email = (argOf('email') || await rl.question('  email: ')).trim().toLowerCase();
if (get('SELECT id FROM staff WHERE email = ?', email)) {
  console.log('  That account already exists.');
  process.exit(1);
}

const role = (argOf('role') || await rl.question('  role (support | trust | admin): ')).trim() || 'support';
if (!['support', 'trust', 'admin'].includes(role)) {
  console.log('  Unknown role.');
  process.exit(1);
}

const password = argOf('password') || await rl.question('  password (visible as you type): ');
const check = await P.checkPassword(password, { email });
if (!check.ok) { console.log(`  ${check.error}`); process.exit(1); }

// §14 — 2FA is mandatory and there is no opt-out, so it is enrolled at
// creation rather than left as a prompt the account can ignore.
const id = randomUUID();
const enrollment = TOTP.beginEnrollment({ username: email, email }, { issuer: 'MARGIN STAFF' });

console.log('\n  Scan this before continuing — the account cannot sign in without it.\n');
console.log(`  SECRET  ${enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}`);
console.log(`  URI     ${enrollment.uri}\n`);

const code = (await rl.question('  the six digits it shows: ')).trim();
const step = TOTP.stepOfCode(enrollment.secret, code);
if (step == null) { console.log('  That code is wrong, or the clock has drifted. Nothing was created.'); process.exit(1); }

run(
  `INSERT INTO staff (id, email, password_hash, role, totp_secret, totp_last_step)
   VALUES (?, ?, ?, ?, ?, ?)`,
  id, email, await P.hashPassword(password), role, seal(enrollment.secret), step
);

audit.record({ actorType: 'system', action: 'admin.staff.created', metadata: { staff: id, role } });

console.log(`\n  CREATED  ${email} (${role})`);
console.log(`  The admin surface is reachable only from MARGIN_STAFF_ALLOWLIST`);
console.log(`  (currently ${process.env.MARGIN_STAFF_ALLOWLIST || '127.0.0.1, ::1'}).\n`);
rl.close();
