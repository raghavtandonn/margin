import { randomUUID } from 'node:crypto';
import { get, run, nowSQL } from '../db/index.js';
import { hashPassword } from '../lib/auth/passwords.js';
import { hashEmailForBan } from '../lib/crypto.js';
import * as audit from '../lib/audit.js';

// ── A LOCAL ACCOUNT, POLICY BYPASSED ─────────────────────
//
// This creates an account that the application's own sign-up path would
// refuse, and it is deliberately a separate script so that the refusal
// stays intact everywhere else.
//
// Two rules are bypassed, both on purpose and both stated on the way out:
//
//   §4  the password policy — minimum length and the breach-corpus check.
//       "admin" is five characters and appears in every credential-stuffing
//       list in existence.
//
//   §9  the reserved-username list. "admin" is on it because a profile at
//       /@admin sitting next to an administrative route is a phishing
//       primitive, and because it is the first name anyone impersonating
//       staff would reach for.
//
// This is fine on a laptop, for one reader, on localhost. It is not fine on
// anything reachable from the internet, which is why the script says so
// every time it runs rather than trusting anyone to remember.
//
//   npm run dev:account
//   npm run dev:account -- --username someone --password "..." --email a@b.test

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const username = argOf('username', 'admin').toLowerCase();
const password = argOf('password', 'admin');
const email = argOf('email', `${username}@localhost.invalid`).toLowerCase();

const existing = get(
  'SELECT id FROM users WHERE username = ? OR email = ?', username, email
);

const hash = await hashPassword(password);

if (existing) {
  // Re-running should reset the password rather than fail, because the
  // reason to run this twice is having forgotten it.
  run(
    `UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?),
                      deleted_at = NULL, purge_after = NULL, deactivated_at = NULL,
                      updated_at = ?
      WHERE id = ?`,
    hash, nowSQL(), nowSQL(), existing.id
  );
  console.log(`\n  RESET     @${username} — password set to what you passed in`);
} else {
  const publicId = randomUUID();
  run(
    `INSERT INTO users (handle, public_id, email, password_hash, email_hash, username,
                        email_verified_at, profile_visibility, search_indexable, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 0, ?)`,
    `u${publicId.slice(0, 12)}`, publicId, email, hash, hashEmailForBan(email),
    // Written straight in, so validateUsername() keeps refusing this name on
    // every path a real person can reach.
    username,
    // Verified on creation: there is no mail delivery to verify through.
    nowSQL(), nowSQL()
  );

  const user = get('SELECT id FROM users WHERE public_id = ?', publicId);

  // Every account needs somewhere to put a book — all four of the shelves
  // the product moves books between on its own. ABANDONED was missing here,
  // which produced an account that threw the first time anything was
  // abandoned on it, because addToShelf refuses a shelf that is not there.
  for (const [name, slug] of [['READING', 'reading'], ['FINISHED', 'finished'],
                              ['ABANDONED', 'abandoned'], ['WAITING', 'waiting']]) {
    run(
      `INSERT OR IGNORE INTO shelves (user_id, name, slug, is_system, public_id)
       VALUES (?, ?, ?, 1, ?)`,
      user.id, name, slug, randomUUID()
    );
  }

  audit.record({
    actorType: 'system', action: 'account.dev_created', targetUserId: user.id,
    fields: ['username', 'password_hash', 'email_verified_at'],
    metadata: { policy: 'bypassed', script: 'dev-account' }
  });

  console.log(`\n  CREATED   @${username}`);
}

console.log(`  EMAIL     ${email} (marked confirmed — nothing was sent)`);
console.log(`  PASSWORD  ${password}`);
console.log(`  PRIVACY   private`);
console.log('');
console.log('  This account bypasses the password policy and the reserved-username');
console.log('  list. Both still apply to every account created through the app.');
console.log('  Do not expose this instance to a network while it exists.');
console.log('');
console.log('  Sign in: http://localhost:3000/signin');
console.log('');
