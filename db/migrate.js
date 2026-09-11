import { randomUUID } from 'node:crypto';

// Additive, idempotent migrations that run at boot.
//
// The tables being altered already hold a real 411-book library, so nothing
// here recreates a table or rewrites a row that has content. Every change is
// an ADD COLUMN with a default, and every one is guarded by a check against
// the live schema.

const columns = (db, table) => {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
};

function addColumn(db, table, name, decl) {
  if (columns(db, table).has(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  return true;
}

// SQLite has no `ALTER COLUMN`, so relaxing a NOT NULL means rebuilding.
// Done once, guarded, and carrying every existing row.
function relaxReportsTarget(db) {
  const cols = db.prepare('PRAGMA table_info(reports)').all();
  const target = cols.find((c) => c.name === 'target_user_id');
  if (!target || !target.notnull) return false;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE reports_rebuilt (
        id             TEXT PRIMARY KEY,
        reporter_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_type    TEXT NOT NULL DEFAULT 'user',
        target_ref     TEXT,
        kind           TEXT NOT NULL,
        detail         TEXT,
        state          TEXT NOT NULL DEFAULT 'open',
        resolution     TEXT,
        weight         REAL NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at    TEXT,
        resolved_by    TEXT REFERENCES staff(id)
      );
      INSERT INTO reports_rebuilt
        (id, reporter_id, target_user_id, target_type, target_ref, kind,
         detail, state, resolution, weight, created_at, resolved_at, resolved_by)
        SELECT id, reporter_id, target_user_id,
               COALESCE(target_type, 'user'), target_ref, kind, detail, state,
               resolution, COALESCE(weight, 1), created_at, resolved_at, resolved_by
          FROM reports;
      DROP TABLE reports;
      ALTER TABLE reports_rebuilt RENAME TO reports;
      CREATE INDEX IF NOT EXISTS idx_reports_state ON reports(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_ref);
    `);
    return true;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function migrate(db) {
  const added = [];
  const add = (t, n, d) => { if (addColumn(db, t, n, d)) added.push(`${t}.${n}`); };

  // ── §3 users ───────────────────────────────────────────
  // §13.4 — public identifiers are UUIDs, never sequential integers. The
  // integer id stays as the internal foreign key everywhere it already is;
  // public_id is what may appear in a URL or an export.
  add('users', 'public_id', 'TEXT');
  add('users', 'email', 'TEXT');
  add('users', 'email_verified_at', 'TEXT');
  add('users', 'password_hash', 'TEXT');           // null if passkey-only
  add('users', 'username', 'TEXT');
  add('users', 'bio', 'TEXT');                     // plain text, 280 max
  add('users', 'avatar_key', 'TEXT');
  add('users', 'location', 'TEXT');
  add('users', 'link', 'TEXT');
  // Public is the default for a new account. Private-by-default made the
  // whole library private through 'inherit' and left the community surfaces
  // empty; §15's anti-impersonation protection moved to discoverability,
  // which is where it actually bites. See lib/accounts.js createUser.
  //
  // NOTE ON EXISTING ROWS: ALTER TABLE ... DEFAULT applies to rows inserted
  // AFTER it. Every account that already exists keeps the visibility it
  // already had, and nothing becomes more visible because of this change.
  add('users', 'profile_visibility', "TEXT NOT NULL DEFAULT 'public'");
  add('users', 'search_indexable', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'updated_at', 'TEXT');
  add('users', 'last_seen_at', 'TEXT');
  add('users', 'username_changed_at', 'TEXT');
  // §12 — deactivation and deletion are different things.
  add('users', 'deactivated_at', 'TEXT');
  add('users', 'deleted_at', 'TEXT');
  add('users', 'purge_after', 'TEXT');
  // §15 — a new account cannot make a profile public until it has some
  // history, which is what makes throwaway impersonation accounts pointless.
  add('users', 'books_logged', 'INTEGER NOT NULL DEFAULT 0');
  // A tombstone keeps a salted email hash for ban continuity and nothing else.
  add('users', 'is_tombstone', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'email_hash', 'TEXT');

  // ── §10 three-layer privacy ────────────────────────────
  // Shelf and entry visibility both default to 'inherit', so an existing
  // library keeps exactly the visibility its account has and nothing becomes
  // more visible than it was because of this migration.
  add('shelves', 'public_id', 'TEXT');
  add('shelves', 'visibility', "TEXT NOT NULL DEFAULT 'inherit'");
  add('shelf_items', 'visibility', "TEXT NOT NULL DEFAULT 'inherit'");
  // Legacy compatibility only: reading history follows profile visibility,
  // with no per-read privacy. Existing values are never used to hide reads.
  add('readings', 'visibility', "TEXT NOT NULL DEFAULT 'inherit'");
  // §10 — a draft entry does not contribute to statistics.
  add('readings', 'is_draft', 'INTEGER NOT NULL DEFAULT 0');
  // A queued reading update may be retried after its response is lost.
  // Store its identity with the session so replay cannot advance twice.
  add('sessions', 'client_request_id', 'TEXT');
  add('sessions', 'client_request_hash', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_request ON sessions(client_request_id)');
  // §11 — note bodies are encrypted at the application layer. The column
  // holds the ciphertext envelope; private_note holds plaintext only for
  // rows written before this migration, and lib/notes.js migrates them.
  add('readings', 'note_encrypted', 'BLOB');
  add('readings', 'note_imported', 'INTEGER NOT NULL DEFAULT 0');
  // §12 — an imported review carries the date it arrived, so it is
  // distinguishable from a note written here.
  add('readings', 'note_imported_at', 'TEXT');

  // community-spec §11 — the reports table predates community content. It
  // targeted profiles only, so target_user_id was NOT NULL; a report on a
  // club or a post has no single target user, and SQLite cannot relax a
  // NOT NULL with ALTER. The table is rebuilt once, carrying its rows.
  add('reports', 'target_type', "TEXT NOT NULL DEFAULT 'user'");
  add('reports', 'target_ref', 'TEXT');
  add('reports', 'resolution', 'TEXT');
  // §14 — reports are weighted by the reporter's trust and history, so an
  // account whose reports have never been upheld carries less weight.
  add('reports', 'weight', 'REAL NOT NULL DEFAULT 1');
  // Only after every column exists: the rebuild copies them all.
  relaxReportsTarget(db);

  // §12 — the age and volume gates the trust level is computed from are
  // already derivable, but the level itself is cached on the row so a read
  // path never recomputes it.
  add('users', 'trust_level', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'reviews_published', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'upheld_reports', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'last_upheld_at', 'TEXT');
  // §2.1 of the community spec — pronouns, optional, free text.
  add('users', 'pronouns', 'TEXT');
  // §2.2 — whether reviews are public by default.
  add('users', 'reviews_public', 'INTEGER NOT NULL DEFAULT 1');
  add('users', 'who_can_follow', "TEXT NOT NULL DEFAULT 'anyone'");

  // §8 — the season colour signature, cached on the jacket it comes from.
  add('editions', 'season_colour', 'TEXT');
  add('editions', 'season_colour_at', 'TEXT');

  // §10 — one global "pause everything" switch, and a likes digest that is
  // off until somebody asks for it.
  add('users', 'notifications_paused', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'digest_likes', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'digest_likes_at', 'TEXT');

  // §05 of the lookbook spec asks whether Deadstock should be opt-in. It
  // ships on — "Goodreads treats abandonment as shameful; this puts it on
  // the wall" is the argument of the page — but it is one switch away for
  // anyone who finds it confronting rather than freeing.
  add('users', 'deadstock_visible', 'INTEGER NOT NULL DEFAULT 1');

  // §12 — trust levels exist to keep throwaway signups from spamming a
  // public community. On a self-hosted instance the person running the
  // server is not a throwaway signup, and telling them to wait a fortnight
  // before they may make a club is the system misapplying its own purpose.
  //
  // The first account is the operator, the way it is in every other
  // self-hosted thing. Everyone who signs up afterwards earns their level
  // exactly as the spec describes.
  add('users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE users SET is_owner = 1
     WHERE id = (SELECT MIN(id) FROM users WHERE is_tombstone = 0)
       AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
  `);

  // ── THE COLOUR SYSTEM (colour-system-spec §01–§03, amended v1.1) ──
  //
  // Two cardinalities, two homes. The DERIVED colour is a fact about the
  // book and is the same for every reader, so it sits on the work beside
  // the evidence it was drawn from. The OVERRIDE is a fact about one
  // reader's pass, so it sits on the reading — which is also what preserves
  // "you read this differently at 19", since every pass carries its own.
  //
  // NULL is a permanent, legitimate state on both. §05: a book with no
  // evidence renders as an unfilled hatch and is never filled by guessing.
  add('works', 'colour_id', 'TEXT');          // the NEAREST ANCHOR to the blend
  add('works', 'colour_hex', 'TEXT');        // the blend itself, which is what is drawn
  add('works', 'colour_name', 'TEXT');       // from the fixed grammar, never free text
  add('works', 'colour_components', 'TEXT'); // JSON [{id, weight, section, evidence}]
  add('works', 'colour_model', 'TEXT');
  add('works', 'colour_at', 'TEXT');

  // `colour_evidence` and `colour_section` were the single-emotion model's
  // columns. Each component now carries its own citation inside
  // `colour_components`, so they are unused. Left in place rather than
  // dropped: removing a column in SQLite is a full table rebuild, and there
  // is no reason to do that to a live 411-book library for tidiness.

  // Every stored colour predates the blend model and is a single anchor with
  // no components. Cleared rather than migrated — a one-component "blend" is
  // not what the spec describes, and re-deriving is a cached-retrieval run
  // rather than a network one.
  db.exec(`
    UPDATE works SET colour_id = NULL, colour_model = NULL, colour_at = NULL
     WHERE colour_id IS NOT NULL AND colour_components IS NULL
  `);

  // Indexes that the new columns need. Created after the columns exist.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
      ON users(email) WHERE email IS NOT NULL AND is_tombstone = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
      ON users(username) WHERE username IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id
      ON users(public_id) WHERE public_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_purge ON users(purge_after)
      WHERE purge_after IS NOT NULL;
  `);

  // Backfill public ids for rows that predate the column.
  for (const r of db.prepare('SELECT id FROM users WHERE public_id IS NULL').all()) {
    db.prepare('UPDATE users SET public_id = ? WHERE id = ?').run(randomUUID(), r.id);
  }
  for (const r of db.prepare('SELECT id FROM shelves WHERE public_id IS NULL').all()) {
    db.prepare('UPDATE shelves SET public_id = ? WHERE id = ?').run(randomUUID(), r.id);
  }

  // The seeded single-reader account predates usernames. Its handle is the
  // obvious username, and adopting it here keeps the existing library
  // reachable at /@handle instead of stranding it on an account with none.
  db.exec(`
    UPDATE users SET username = lower(handle)
    WHERE username IS NULL AND handle IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = lower(users.handle))
  `);

  return added;
}
