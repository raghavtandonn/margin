import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test file gets its own database file. db/index.js resolves MARGIN_DB
// at import time, so this has to run before the first import of anything
// that touches the database — which is why test files call `useTempDB()` at
// the top level rather than inside a hook.
export function useTempDB() {
  const dir = mkdtempSync(join(tmpdir(), 'margin-test-'));
  process.env.MARGIN_DB = join(dir, 'test.db');
  process.env.MARGIN_KEY = 'test-key-not-a-real-secret-0123456789abcdef';
  process.env.MARGIN_IP_SALT = 'test-salt';
  process.env.NODE_ENV = 'test';
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return process.env.MARGIN_DB;
}

// A verified account with a username, which is the state most tests need and
// none of them should have to spell out.
export function makeUser(db, { handle, visibility = 'private', verified = true, ...rest } = {}) {
  db.prepare(
    `INSERT INTO users (handle, username, public_id, email, email_verified_at,
                        profile_visibility, books_logged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 20, datetime('now', '-1 year'))`
  ).run(
    handle, handle, randomUUID(), `${handle}@example.test`,
    verified ? new Date().toISOString() : null, visibility
  );
  return db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
}
