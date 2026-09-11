import { rmSync } from 'node:fs';
import { get, all, run, tx, sqlTime } from '../db/index.js';
import { hashEmailForBan } from './crypto.js';
import * as notes from './notes.js';
import * as audit from './audit.js';
import { removeAvatar, avatarFile } from './avatars.js';
import { invalidate as invalidateVectors } from './vectors.js';

// ── §12 — deletion actually deletes ──────────────────────
//
// "Letterboxd's incident exposed *deleted content*, which means it was still
// there." That is the whole reason this file exists and the whole reason it
// issues DELETEs rather than setting a flag.
//
// The order is deliberate. §11: "On account deletion, notes and their
// embeddings are purged in the first pass, not at the end of the retention
// window." The most sensitive data goes first, so a crash halfway through
// has already destroyed the thing that mattered most.

const DAY = 86_400_000;
export const GRACE_DAYS = 30;

/** Reversible. Profile hidden, sessions revoked, nothing destroyed (§12). */
export function deactivate(userId) {
  run(
    `UPDATE users SET deactivated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    Number(userId)
  );
  run(`UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
      Number(userId));
  audit.record({ actorType: 'user', actorId: userId, action: 'account.deactivated', targetUserId: userId });
}

export function reactivate(userId) {
  run(
    `UPDATE users SET deactivated_at = NULL, deleted_at = NULL, purge_after = NULL,
                      updated_at = datetime('now')
      WHERE id = ?`,
    Number(userId)
  );
  audit.record({ actorType: 'user', actorId: userId, action: 'account.reactivated', targetUserId: userId });
}

/**
 * §12 — schedules the delete. A 30-day grace period during which signing in
 * restores the account, and a stated date rather than "soon".
 */
export function scheduleDeletion(userId) {
  const when = new Date(Date.now() + GRACE_DAYS * DAY);
  run(
    `UPDATE users SET deleted_at = datetime('now'), purge_after = ?,
                      deactivated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    sqlTime(when), Number(userId)
  );
  run(`UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ?`, Number(userId));
  audit.record({ actorType: 'user', actorId: userId, action: 'account.deletion.scheduled',
                 targetUserId: userId, metadata: { purge_after: when.toISOString() } });
  return when;
}

/**
 * The irreversible one.
 *
 * §12: "a job hard-deletes rows — books, notes, vectors, sessions, tokens,
 * avatar objects — and replaces the users row with a tombstone holding only
 * the id, deletion timestamp, and a salted hash of the email."
 */
export function purgeUser(userId, { tombstone = true } = {}) {
  const id = Number(userId);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) return { purged: false };

  // PASS ONE — the notes, before anything else can fail.
  const noteCount = notes.purgeFor(id);

  const avatarKey = user.avatar_key;
  const exportFiles = all('SELECT path FROM exports WHERE user_id = ?', id);

  tx(() => {
    // Tombstoning users does not fire ON DELETE CASCADE. Purge dependent
    // content explicitly, including features added after account deletion.
    if (get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'desk_vectors'")) {
      run("DELETE FROM desk_vectors WHERE kind = 'note' AND ref_id IN (SELECT id FROM readings WHERE user_id = ?)", id);
    }
    for (const table of ['reading_notes', 'source_boards', 'reco_runs', 'seasons', 'reviews',
      'review_replies', 'review_likes', 'club_posts', 'post_reactions',
      'pick_participation', 'club_members', 'notifications', 'notification_prefs',
      'profile_pins', 'user_trust']) {
      run(`DELETE FROM ${table} WHERE user_id = ?`, id);
    }
    run('DELETE FROM user_follows WHERE follower_id = ? OR followee_id = ?', id, id);
    run('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?', id, id);
    run('DELETE FROM mutes WHERE muter_id = ? OR muted_id = ?', id, id);
    run('DELETE FROM notifications WHERE actor_id = ?', id);
    run('DELETE FROM club_invites WHERE created_by = ?', id);
    run("UPDATE clubs SET host_id = NULL, archived_at = COALESCE(archived_at, datetime('now')) WHERE host_id = ?", id);
    run('UPDATE club_picks SET set_by = NULL, announcement_body = NULL WHERE set_by = ?', id);
    run('UPDATE person_life SET added_by = NULL WHERE added_by = ?', id);
    run('UPDATE credit_additions SET added_by = NULL WHERE added_by = ?', id);
    // Readings and their sessions. Sessions cascade from readings, but the
    // cascade is only as reliable as PRAGMA foreign_keys, so this is explicit.
    const readingIds = all('SELECT id FROM readings WHERE user_id = ?', id).map((r) => r.id);
    for (const rid of readingIds) run('DELETE FROM sessions WHERE reading_id = ?', rid);
    run('DELETE FROM readings WHERE user_id = ?', id);

    const shelfIds = all('SELECT id FROM shelves WHERE user_id = ?', id).map((r) => r.id);
    for (const sid of shelfIds) run('DELETE FROM shelf_items WHERE shelf_id = ?', sid);
    run('DELETE FROM shelves WHERE user_id = ?', id);

    // Credentials and everything that could re-authenticate as this person.
    run('DELETE FROM auth_sessions WHERE user_id = ?', id);
    run('DELETE FROM credentials_totp WHERE user_id = ?', id);
    run('DELETE FROM credentials_webauthn WHERE user_id = ?', id);
    run('DELETE FROM webauthn_challenges WHERE user_id = ?', id);
    run('DELETE FROM recovery_codes WHERE user_id = ?', id);
    run('DELETE FROM email_tokens WHERE user_id = ?', id);
    run('DELETE FROM known_devices WHERE user_id = ?', id);
    run('DELETE FROM auth_failures WHERE scope = ?', `account:${id}`);
    run('DELETE FROM exports WHERE user_id = ?', id);
    run('DELETE FROM import_jobs WHERE user_id = ?', id);

    // Anything else keyed to the account.
    try { run('DELETE FROM follows WHERE user_id = ?', id); } catch { /* table may not exist */ }

    if (tombstone) {
      // §12 — "no name, no email in plaintext, no bio". What survives is an
      // id, a timestamp, and a salted email hash, so that a banned person
      // cannot simply re-register the same address.
      run(
        `UPDATE users SET
           email = NULL, password_hash = NULL, display_name = NULL, bio = NULL,
           avatar_key = NULL, location = NULL, link = NULL, username = NULL, pronouns = NULL,
           handle = ?, settings = '{}', library_card = NULL,
           email_hash = ?, is_tombstone = 1,
           deleted_at = COALESCE(deleted_at, datetime('now')),
           purge_after = NULL, email_verified_at = NULL,
           profile_visibility = 'private', search_indexable = 0
         WHERE id = ?`,
        `deleted-${id}`, user.email ? hashEmailForBan(user.email) : null, id
      );
      // §9 — the username goes back to the pool after 90 days, not at once.
      if (user.username) {
        run(
          `INSERT OR REPLACE INTO username_reservations (username, user_id, release_at)
           VALUES (?, NULL, ?)`,
          user.username, sqlTime(Date.now() + 90 * DAY)
        );
      }
    } else {
      run('DELETE FROM users WHERE id = ?', id);
    }
  });

  // The avatar lives on disk, outside the transaction.
  if (avatarKey) removeAvatar(avatarKey);
  for (const file of exportFiles) rmSync(file.path, { force: true });
  invalidateVectors();

  // §11 — no embedding of a deleted note may survive in the desk's index.
  // The index is built from the database, and the rows are gone, so a
  // rebuild is what makes that true rather than a separate deletion.
  reindexAfterPurge();

  audit.record({
    actorType: 'system', action: 'account.purged', targetUserId: id,
    metadata: { notes: noteCount, tombstone }
  });

  return { purged: true, notes: noteCount };
}

// Rebuilding is deferred so a batch purge does it once rather than per user.
let reindexTimer = null;
function reindexAfterPurge() {
  clearTimeout(reindexTimer);
  reindexTimer = setTimeout(async () => {
    try {
      const V = await import('./vectors.js');
      await V.reindex?.();
    } catch (err) {
      console.error('  index rebuild after purge failed —', err.message);
    }
  }, 500);
  reindexTimer.unref?.();
}

// Kept here so purge and the avatar pipeline cannot disagree about where a
// file lives — the commonest way a "deleted" file quietly survives.
export function avatarPath(key, size) {
  return avatarFile(key, size);
}
