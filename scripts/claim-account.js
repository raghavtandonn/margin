import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { get, all, run } from '../db/index.js';
import * as A from '../lib/accounts.js';
import * as P from '../lib/auth/passwords.js';
import { migrateAll } from '../lib/notes.js';
import * as audit from '../lib/audit.js';

// Attach credentials to the library that already exists.
//
// Before the accounts work there was one reader, identified by a handle and
// no password at all. That reader owns 411 books. This gives that same row an
// email, a password, and a verified state, rather than creating a second
// account and leaving the library stranded on the first.
//
//   npm run claim
//   npm run claim -- --handle you --email me@example.com

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);

  console.log('"MARGIN" — CLAIMING AN EXISTING LIBRARY\n');

  const candidates = all(
    `SELECT u.id, u.handle, u.username, u.email,
            (SELECT COUNT(*) FROM readings r WHERE r.user_id = u.id) AS books
       FROM users u WHERE u.is_tombstone = 0 ORDER BY books DESC`
  );

  if (!candidates.length) {
    console.log('  No accounts. Run: npm run seed');
    return rl.close();
  }

  for (const c of candidates) {
    console.log(`  ${String(c.id).padStart(3)}  ${(c.handle || '—').padEnd(16)} ` +
                `${String(c.books).padStart(4)} readings  ${c.email ? 'HAS CREDENTIALS' : 'no credentials'}`);
  }
  console.log('');

  const handle = argOf('handle') || (await ask('  handle to claim: ')).trim();
  const user = get('SELECT * FROM users WHERE handle = ? OR username = ?', handle, handle);
  if (!user) { console.log('  No such account.'); return rl.close(); }

  const emailRaw = argOf('email') || (await ask('  email: ')).trim();
  const e = A.validateEmail(emailRaw);
  if (!e.ok) { console.log(`  ${e.error}`); return rl.close(); }

  const taken = A.findByEmail(e.email);
  if (taken && taken.id !== user.id) { console.log('  That address is already in use.'); return rl.close(); }

  // Read without echoing. There is no portable way to switch off terminal
  // echo through readline, so the prompt says so rather than implying
  // privacy it cannot provide.
  const password = argOf('password') || (await ask('  password (visible as you type): '));

  const check = await P.checkPassword(password, { email: e.email, username: user.username });
  if (!check.ok) { console.log(`  ${check.error}`); return rl.close(); }

  const hash = await P.hashPassword(password);

  run(
    `UPDATE users SET email = ?, password_hash = ?,
                      email_verified_at = COALESCE(email_verified_at, datetime('now')),
                      updated_at = datetime('now')
      WHERE id = ?`,
    e.email, hash, user.id
  );

  // The handle becomes the username if that has not happened already.
  if (!user.username) {
    const r = A.setUsername(user.id, user.handle);
    if (!r.ok) console.log(`  (username not set: ${r.error} — choose one at /username)`);
  }

  A.recountBooks(user.id);

  // §11 — any note written before the encryption migration is still sitting
  // in plaintext. Claiming the account is the natural moment to move them.
  const moved = migrateAll();

  audit.record({
    actorType: 'system', action: 'account.claimed', targetUserId: user.id,
    fields: ['email', 'password_hash', 'email_verified_at']
  });

  const after = get('SELECT * FROM users WHERE id = ?', user.id);
  console.log('');
  console.log(`  CLAIMED   @${after.username}`);
  console.log(`  EMAIL     ${e.email} (already confirmed — you set it here)`);
  console.log(`  BOOKS     ${after.books_logged}`);
  if (moved) console.log(`  NOTES     ${moved} encrypted at rest`);
  console.log(`  PRIVACY   ${after.profile_visibility} — nothing is public until you say so`);
  console.log('');
  console.log('  Sign in at http://localhost:3000/signin');

  rl.close();
}

main();
