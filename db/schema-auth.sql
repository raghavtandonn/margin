-- "MARGIN" — accounts, credentials, privacy, audit
--
-- The accounts spec is written against Postgres. This is SQLite, so a few
-- types are translated. The translations are listed here rather than left
-- to be rediscovered:
--
--   UUID PK      → TEXT PK holding a v4 UUID (crypto.randomUUID)
--   CITEXT       → TEXT stored pre-normalised to lowercase + UNIQUE index
--   BYTEA        → BLOB
--   TEXT[]       → TEXT holding a JSON array
--   JSONB        → TEXT holding JSON
--   TIMESTAMPTZ  → TEXT holding an ISO-8601 UTC instant
--
-- One translation is NOT equivalent and must be understood as a gap:
-- SQLite has no row-level security. §13.4 asks for RLS as a backstop
-- underneath application scoping. There is no backstop here — the
-- `visibleTo` scope in lib/visibility.js is load-bearing on its own, which
-- is why it has its own test file and why §19's IDOR test matters more here
-- than it would on Postgres.

PRAGMA foreign_keys = ON;

-- ── ACCOUNTS ─────────────────────────────────────────────
-- The existing `users` table is extended in place by db/migrate.js rather
-- than recreated, because it already carries a 411-book library.
--
-- Columns added there: public_id, email, email_verified_at, password_hash,
-- username, bio, avatar_key, profile_visibility, search_indexable,
-- updated_at, last_seen_at, deleted_at, purge_after, username_changed_at,
-- is_deactivated, books_logged.

-- Usernames stay reserved after a change so a freed URL cannot immediately
-- be taken for impersonation (§9, 90 days).
CREATE TABLE IF NOT EXISTS username_reservations (
  username     TEXT PRIMARY KEY,        -- normalised, lowercase
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reserved_at  TEXT NOT NULL DEFAULT (datetime('now')),
  release_at   TEXT NOT NULL
);

-- ── CREDENTIALS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credentials_totp (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted BLOB NOT NULL,       -- envelope-encrypted, never plaintext
  confirmed_at     TEXT NOT NULL,
  -- §6 — the counter that makes a phished code single-use. Any code at or
  -- below this step is rejected even inside its own validity window.
  last_used_step   INTEGER
);

CREATE TABLE IF NOT EXISTS credentials_webauthn (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,  -- base64url
  public_key     BLOB NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,                  -- JSON array
  nickname       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON credentials_webauthn(user_id);

-- In-flight WebAuthn challenges. Single-use, short-lived.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL,             -- 'register' | 'authenticate'
  expires_at TEXT NOT NULL
);

-- §6 — the thing Letterboxd doesn't do. Without these, "lost my phone"
-- becomes a support ticket, and support tickets are a social-engineering
-- channel.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,             -- Argon2id, same as passwords
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

-- ── SESSIONS ─────────────────────────────────────────────
-- §7 — opaque random tokens, not JWTs. A JWT cannot be revoked, and
-- revocation is the entire point of a session list.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,  -- SHA-256 of the opaque token
  user_agent     TEXT,
  ip_hash        TEXT,                  -- rotating-salt hash, never plaintext
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  -- 1 = password only, 2 = second factor satisfied
  aal            INTEGER NOT NULL DEFAULT 1,
  -- §6 step-up: the instant a factor was last freshly presented
  reauth_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Devices already seen, so a login from a new one can be noticed (§5).
CREATE TABLE IF NOT EXISTS known_devices (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,             -- hash of (user agent + ip prefix)
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, device_key)
);

-- ── EMAIL TOKENS ─────────────────────────────────────────
-- purpose: 'verify' | 'reset' | 'email_change' | 'revoke_email_change'
--        | 'login_link' | 'export'
CREATE TABLE IF NOT EXISTS email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  new_email   TEXT,                     -- for 'email_change'
  old_email   TEXT,                     -- for 'revoke_email_change'
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);

-- ── AUDIT ────────────────────────────────────────────────
-- §14 — this table exists because it is how Letterboxd was actually
-- breached, and because they could not afterwards say whose data was read.
--
-- The bar to clear: given a compromised staff account and a time window, one
-- query returns the exact list of affected members.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type     TEXT NOT NULL,         -- 'user' | 'staff' | 'system'
  actor_id       TEXT,
  action         TEXT NOT NULL,         -- 'admin.user.export', 'auth.login', …
  target_user_id INTEGER,
  fields         TEXT,                  -- JSON array of fields read/written
  reason         TEXT,                  -- required for staff reads
  ip_hash        TEXT,
  user_agent     TEXT,
  metadata       TEXT,                  -- JSON
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_type, actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

-- Append-only, enforced by the engine rather than by convention. §14 asks
-- for no UPDATE or DELETE grant on this table for the application role;
-- SQLite has no role grants, so the same guarantee is bought with triggers.
CREATE TRIGGER IF NOT EXISTS audit_log_append_only_update
  BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_append_only_delete
  BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ── STAFF ────────────────────────────────────────────────
-- §14 — staff are a separate table, not a boolean on a member row, so a
-- member account can never be escalated into a staff account by a
-- mass-assignment bug.
CREATE TABLE IF NOT EXISTS staff (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'support',  -- support | trust | admin
  totp_secret   BLOB,                  -- mandatory before the account works
  totp_last_step INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  id         TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  reauth_at  TEXT
);

-- §14 — the bulk export tool is the crown jewel, so it takes a second
-- staff member's approval before it will run.
CREATE TABLE IF NOT EXISTS staff_approvals (
  id             TEXT PRIMARY KEY,
  requested_by   TEXT NOT NULL REFERENCES staff(id),
  approved_by    TEXT REFERENCES staff(id),
  action         TEXT NOT NULL,
  target_user_id INTEGER,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at    TEXT,
  consumed_at    TEXT,
  expires_at     TEXT NOT NULL
);

-- ── RATE LIMITING ────────────────────────────────────────
-- §5 asks for Redis. This is a single process with a local database, so the
-- counters live in memory (lib/auth/ratelimit.js) and are mirrored here only
-- for the per-account backoff, which must survive a restart — otherwise a
-- restart is a free reset of an attacker's budget.
CREATE TABLE IF NOT EXISTS auth_failures (
  scope       TEXT PRIMARY KEY,         -- 'account:<id>'
  count       INTEGER NOT NULL DEFAULT 0,
  first_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_at     TEXT NOT NULL DEFAULT (datetime('now')),
  retry_after TEXT
);

-- ── EXPORTS ──────────────────────────────────────────────
-- §12 — delivered as a signed URL expiring in an hour, 2 per day.
CREATE TABLE IF NOT EXISTS exports (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exports_user ON exports(user_id, created_at);

-- ── IMPORT JOBS ──────────────────────────────────────────
-- §12 — a Goodreads CSV is processed in a job with progress and a preview
-- step, never inside the request.
CREATE TABLE IF NOT EXISTS import_jobs (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'parsed',  -- parsed | confirmed | running | done | failed
  total       INTEGER NOT NULL DEFAULT 0,
  done_count  INTEGER NOT NULL DEFAULT 0,
  preview     TEXT,                    -- JSON, first rows for the confirm step
  payload     TEXT,                    -- JSON, the parsed rows awaiting confirm
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- ── ABUSE REPORTS ────────────────────────────────────────
-- §15 — Goodreads' central failure is that reports go nowhere. A small
-- product with a small queue can genuinely do better.
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  reporter_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,        -- impersonation | display_name | bio | other
  detail         TEXT,
  state          TEXT NOT NULL DEFAULT 'open',   -- open | actioned | dismissed
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT,
  resolved_by    TEXT REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_state ON reports(state, created_at);
