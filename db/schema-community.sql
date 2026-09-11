-- "MARGIN" — community
--
-- community-spec §16 and community-security-spec §2, translated to SQLite the
-- same way the earlier schemas were: UUID → TEXT, JSONB → TEXT, BOOLEAN →
-- INTEGER, TIMESTAMPTZ → TEXT holding SQLite's 'YYYY-MM-DD HH:MM:SS'.
--
-- One translation is again NOT equivalent and is recorded rather than
-- glossed: community-security §2.2 asks for Postgres row-level security as a
-- backstop on every user-owned and club-owned table. SQLite has none. The
-- `visibleTo` scope in lib/visibility.js is the only thing standing there,
-- which is why §2.3's required tests are not optional here.

PRAGMA foreign_keys = ON;

-- ── FOLLOWING (§3) ───────────────────────────────────────
-- Asymmetric. There is no friendship, no mutual tier, and no close-friends
-- list: one relationship type, because anything more becomes a hierarchy
-- people manage instead of a tool they use.
--
-- NOT `follows`: that table already exists and means something else — it is
-- how a reader follows an AUTHOR or a jacket designer (§08 of the original
-- spec makes a designer a first-class followable entity). Following a person
-- who has an account is a different relation with different rules, so it
-- gets its own table rather than an overloaded `entity` column.
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'requested'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id != followee_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows(followee_id, state);

-- ── BLOCKS AND MUTES (§11) ───────────────────────────────
-- A block is mutual invisibility, enforced in the data layer. A mute is
-- one-directional and severs nothing — the lower-stakes one people actually
-- use.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS mutes (
  muter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (muter_id, muted_id),
  CHECK (muter_id != muted_id)
);

-- ── TRUST (§12) ──────────────────────────────────────────
-- Progressive privilege rather than a binary ban. Levels rise automatically
-- and silently, and are NEVER displayed on a profile: a visible level is a
-- status game, and a status game is what farmed Goodreads' reviewer ranks.
CREATE TABLE IF NOT EXISTS user_trust (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason      TEXT
);

-- ── REVIEWS (§4) ─────────────────────────────────────────
-- A review is public writing. A note is private writing. They are different
-- objects and one never silently becomes the other — see lib/reviews.js.
CREATE TABLE IF NOT EXISTS reviews (
  id                      TEXT PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id                 INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  pass                    INTEGER NOT NULL DEFAULT 1,
  body                    TEXT NOT NULL,
  -- The sanitised render, stored. §4.1 of the security spec: render the
  -- stored form, never re-render untrusted input at display time.
  body_html               TEXT,
  rating                  REAL,
  contains_spoilers       INTEGER NOT NULL DEFAULT 0,
  spoiler_through_page    INTEGER,
  spoiler_through_chapter TEXT,
  visibility              TEXT NOT NULL DEFAULT 'inherit',
  published_at            TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at               TEXT,
  -- §4.2 — deleting removes the body and keeps a tombstone, so like counts
  -- and replies do not orphan. The tombstone holds no text.
  deleted_at              TEXT,
  like_count              INTEGER NOT NULL DEFAULT 0,
  flag_count              INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, work_id, pass)
);
CREATE INDEX IF NOT EXISTS idx_reviews_work ON reviews(work_id, published_at);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, published_at);

-- §4.2 — full revision history retained internally for moderation.
CREATE TABLE IF NOT EXISTS review_revisions (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  edited_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- §7 — likes are private counts, publicly aggregated. You see how many;
-- you see WHO only for people you follow.
CREATE TABLE IF NOT EXISTS review_likes (
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, user_id)
);

-- ── RATINGS AND AGGREGATES (§5) ──────────────────────────
-- A public aggregate is the thing bombing attacks, so it is built to be hard
-- to move: trimmed mean over eligible ratings only, suppressed under 20, and
-- never used to rank anything anywhere in the product.
CREATE TABLE IF NOT EXISTS book_rating_stats (
  work_id        INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  distribution   TEXT NOT NULL DEFAULT '[0,0,0,0,0]',
  median         REAL,
  trimmed_mean   REAL,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  -- §13.1 — a suspected bombing freezes the aggregate at its pre-spike
  -- value rather than deleting anything. A human decides; the automation
  -- only buys time.
  frozen         INTEGER NOT NULL DEFAULT 0,
  frozen_value   REAL,
  frozen_at      TEXT,
  computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── CLUBS (§9) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clubs (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  -- The confusable skeleton, so a Cyrillic homograph of an existing club
  -- collides at creation rather than shipping as an impersonation.
  slug_skeleton TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  banner_key    TEXT,
  avatar_key    TEXT,
  visibility    TEXT NOT NULL DEFAULT 'public',   -- public | unlisted | private
  join_policy   TEXT NOT NULL DEFAULT 'open',     -- open | request | invite_only
  member_cap    INTEGER NOT NULL DEFAULT 500,
  host_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_skeleton ON clubs(slug_skeleton);

CREATE TABLE IF NOT EXISTS club_members (
  club_id   TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',   -- host | admin | member
  state     TEXT NOT NULL DEFAULT 'active',   -- active | requested | invited | removed
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_club_members_user ON club_members(user_id, state);

CREATE TABLE IF NOT EXISTS club_picks (
  id                TEXT PRIMARY KEY,
  club_id           TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  work_id           INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  cadence           TEXT NOT NULL DEFAULT 'month',
  starts_on         TEXT,
  ends_on           TEXT,
  set_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  announcement_body TEXT,
  position          INTEGER NOT NULL DEFAULT 0,   -- 0 = active, 1..3 = queued
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_picks_club ON club_picks(club_id, position);

-- §9.4 — a checkpoint's position becomes the spoiler boundary of its thread,
-- so nobody in a club has to remember to tag a spoiler.
CREATE TABLE IF NOT EXISTS club_checkpoints (
  id              TEXT PRIMARY KEY,
  pick_id         TEXT NOT NULL REFERENCES club_picks(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  label           TEXT NOT NULL,
  through_page    INTEGER,
  through_chapter TEXT,
  opens_on        TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_pick ON club_checkpoints(pick_id, ordinal);

CREATE TABLE IF NOT EXISTS club_posts (
  id            TEXT PRIMARY KEY,
  club_id       TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  thread_id     TEXT,
  checkpoint_id TEXT REFERENCES club_checkpoints(id) ON DELETE SET NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  body_html     TEXT,
  parent_id     TEXT REFERENCES club_posts(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'post',   -- post | announcement
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at     TEXT,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_club ON club_posts(club_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_checkpoint ON club_posts(checkpoint_id, created_at);

CREATE TABLE IF NOT EXISTS pick_participation (
  pick_id TEXT NOT NULL REFERENCES club_picks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state   TEXT NOT NULL DEFAULT 'in',   -- in | sitting_out
  PRIMARY KEY (pick_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id  TEXT NOT NULL REFERENCES club_posts(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, reaction)
);

-- §12 — invite links. 32 bytes CSPRNG, stored hashed, revocable.
CREATE TABLE IF NOT EXISTS club_invites (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── NOTIFICATIONS (§10) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT,
  url        TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT,
  -- Suppressed at DELIVERY when a block was created after generation
  -- (security spec §13).
  suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- ── REPORTS (§11, §14) ───────────────────────────────────
-- The existing `reports` table from schema-auth.sql handled profiles only.
-- Community reports target any content type, so the columns it lacks are
-- added by db/migrate.js rather than a second table being created.

-- §13.1 — the evidence behind a freeze, kept so a human can see what the
-- automation saw.
CREATE TABLE IF NOT EXISTS bombing_flags (
  id          TEXT PRIMARY KEY,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  velocity    REAL,
  new_share   REAL,
  extreme_share REAL,
  accounts    TEXT,                  -- JSON array of contributing user ids
  state       TEXT NOT NULL DEFAULT 'open',  -- open | upheld | dismissed
  resolved_by TEXT REFERENCES staff(id),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bombing_work ON bombing_flags(work_id, state);

-- ── §10 — NOTIFICATION PREFERENCES ───────────────────────
-- "Keep them boring. Every product ruins itself here."
--
-- One row per user per kind, written only when a default is overridden, so
-- the absence of a row means the default. Security notices are deliberately
-- not representable here: there is no key that can switch them off.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);

-- ── REPLIES TO A REVIEW ─────────────────────────────────
--
-- The composer was the best-designed thing in the product and what it
-- produced had nowhere to go: a review appeared at the foot of one work page
-- and nowhere else, and nobody could answer it. Notification settings
-- promised "someone replies to your review" for a reply that could not be
-- written.
--
-- ONE LEVEL DEEP, deliberately. `parent_id` exists so a reply can be
-- attributed to the review it answers and for no other reason — two levels
-- is an argument, and this product has no moderation appetite for one.
--
-- Same contract as club_posts: the sanitised render is STORED and the stored
-- form is what gets rendered (§4.1 of the security spec), and a deletion
-- keeps the row as a tombstone so counts and threads do not orphan (§9.2).
CREATE TABLE IF NOT EXISTS review_replies (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at  TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS review_replies_review
  ON review_replies (review_id, created_at);

-- ── THE STATEMENT ───────────────────────────────────────
--
-- Up to four books, chosen by hand, presented at plate size.
--
-- A Favourites shelf already existed and appeared as one row in a list of
-- shelves next to "TESTING" — which is a filing decision, not a statement.
-- In a product whose whole thesis is taste, the profile had no way to say
-- "this is what I am", and a shelf named FAVOURITES is not that sentence.
-- RETIRED. THE STATEMENT was a hand-pinned list of four works, shown at the
-- top of a profile on the theory that a Favourites shelf is a filing
-- decision rather than a claim about who somebody is. Readers disagreed by
-- not using it: the table held zero rows. The profile now shows the
-- Favourites shelf they already keep.
--
-- The table is left in place rather than dropped. It is empty here, but a
-- DROP in a schema file that runs on every boot would destroy any pins an
-- installation elsewhere still holds, and nothing costs anything by it
-- staying. Nothing reads or writes it.
CREATE TABLE IF NOT EXISTS profile_pins (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id  INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, work_id)
);

-- The taste analysis, made shareable.
--
-- "WHAT YOU LIKE" — 1990s +0.6, over 600pp +0.2 — is the most characterful
-- thing the product computes, and it lived on a private home page where only
-- its subject could see it. A portrait, filed where the sitter is the only
-- viewer.
--
-- Opt in, defaulting OFF. It is derived from every rating the reader has
-- given, and turning that outward is a decision they make rather than one
-- that happens to them.
-- (Added by migration in db/index.js for existing installs.)
