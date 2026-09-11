import { all, get } from '../db/index.js';

// Who exists, and what state they are in.
//
// There is no mail delivery in this deployment (SECURITY.md, "Requires
// infrastructure this deployment does not have"), so a verification link
// never reaches an inbox — it is written to data/outbox/ and printed to the
// console. This is the script for finding out where an account got stuck.
//
//   npm run accounts

console.log('"MARGIN" — ACCOUNTS\n');

const users = all(
  `SELECT id, email, username, email_verified_at, created_at, profile_visibility,
          deleted_at, deactivated_at,
          (SELECT COUNT(*) FROM readings r WHERE r.user_id = users.id) AS books
     FROM users WHERE is_tombstone = 0 ORDER BY id`
);

if (!users.length) console.log('  none');

for (const u of users) {
  const state = u.deleted_at ? 'DELETED'
    : u.deactivated_at ? 'DEACTIVATED'
    : u.email_verified_at ? 'verified'
    : 'UNVERIFIED';
  console.log(
    `  ${String(u.id).padStart(3)}  ${String(u.email || '—').padEnd(32)}` +
    `${String(u.username ? '@' + u.username : '—').padEnd(16)}` +
    `${state.padEnd(13)}${String(u.books).padStart(4)} readings`
  );
}

const pending = all(
  `SELECT t.purpose, t.expires_at, u.email
     FROM email_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.consumed_at IS NULL AND t.expires_at > datetime('now')
    ORDER BY t.expires_at DESC`
);

if (pending.length) {
  console.log('\n  UNUSED LINKS (the mail that was never delivered):');
  for (const t of pending) {
    console.log(`    ${t.purpose.padEnd(20)} ${t.email}   expires ${t.expires_at}`);
  }
  console.log('\n  The links themselves are in data/outbox/, newest last.');
}

const staff = all('SELECT email, role, disabled_at FROM staff ORDER BY email');
if (staff.length) {
  console.log('\n  STAFF:');
  for (const s of staff) {
    console.log(`    ${s.email.padEnd(32)} ${s.role.padEnd(9)}${s.disabled_at ? 'DISABLED' : 'active'}`);
  }
}
