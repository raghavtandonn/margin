-- ── THE SEASONAL LOOKBOOK ────────────────────────────────
-- Ref. AW25–0417–A
--
-- §04 settles the two open constraints before any of this exists:
--
--   Images.   Text-only research boards. "It sidesteps licensing completely,
--             it's the Lang campaign move, and it will probably look better
--             than the image version." No remote asset ever enters the page,
--             which also keeps the CSP at 'self' with nothing to relax.
--
--   Accuracy. Option three: readers build their own boards. A model
--             generating them "will produce exactly the error corrected
--             above — confident, wrong, and set in beautiful type, which
--             makes people believe it MORE." So no model writes into any
--             table in this file. Every row here was typed by a person, and
--             every row carries where it came from.

-- One board per work, owned by the reader who built it. §04's third
-- mitigation: "User boards can accrete into the canonical board over time" —
-- `canonical` marks a board a curator has verified, which is the only way a
-- board is ever shown to someone who did not write it.
CREATE TABLE IF NOT EXISTS source_boards (
  id           TEXT PRIMARY KEY,
  work_id      INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  canonical    INTEGER NOT NULL DEFAULT 0,
  -- §02 band 1: "WHEN THE BOOK IS SET". Nothing in the catalogue knows this
  -- and it must not be guessed, so it is a field a reader fills in. Unset,
  -- the band falls back to publication and says so.
  set_year_from INTEGER,
  set_year_to   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,
  UNIQUE (work_id, user_id)
);

-- §02c — six found objects per book, numbered, captions at 6pt.
-- "Do not explain the connections. Pin them up and let the reader assemble
-- it." So there is no field for an explanation: a label and a source, and
-- nothing that invites an essay.
CREATE TABLE IF NOT EXISTS board_entries (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES source_boards(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  label    TEXT NOT NULL,
  -- §04 mitigation two: "Cite visibly. Every board entry carries its source
  -- at 6pt. Attribution as design element." Not nullable — an entry without
  -- a source is the failure mode this feature was warned about.
  source   TEXT NOT NULL,
  year     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_board_entries ON board_entries(board_id, ordinal);

-- §02d — lineage. "Every book has parents." source text → intermediary →
-- book, each link cited like everything else.
CREATE TABLE IF NOT EXISTS lineage (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES source_boards(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  ancestor TEXT NOT NULL,
  relation TEXT,          -- 'source' | 'intermediary'
  year     INTEGER,
  source   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage ON lineage(board_id, ordinal);

-- §02e band 2 — the author's life. There are no birth years anywhere in the
-- catalogue data, so these are curated too rather than inferred.
CREATE TABLE IF NOT EXISTS person_life (
  person_id  INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  born_year  INTEGER,
  died_year  INTEGER,
  source     TEXT NOT NULL,
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- §02 back matter — credits. "Authors as designers. Translators as pattern
-- cutters. Cover designer named."
--
-- The catalogue already has `edition_credits`, person-linked, filled from
-- Open Library. That table stays exactly as it is and remains the primary
-- source; this one holds what a READER adds by hand, which is most of it,
-- because Open Library rarely records a jacket designer. Two tables rather
-- than one because the provenance genuinely differs, and a credit that says
-- where it came from is the whole point of the page.
CREATE TABLE IF NOT EXISTS credit_additions (
  id         TEXT PRIMARY KEY,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,       -- translator | cover_design | typeset | editor
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_additions ON credit_additions(edition_id);

-- ── COMPOSITION HISTORY ──────────────────────────────────
-- A book as an object with a history: where the author was, what was
-- happening around them, and how the thing got into print.
--
-- Retrieval is cached because it is slow and remote, and because the whole
-- guarantee of the feature is that the generated sentences can be traced
-- back to the text they were written from. Keeping the sources means the
-- claim is auditable later, not just at the moment it was made.
CREATE TABLE IF NOT EXISTS history_sources (
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- wikipedia | catalogue
  ref         TEXT NOT NULL,          -- the URL, or 'this library'
  title       TEXT,
  text        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (work_id, kind)
);

CREATE TABLE IF NOT EXISTS history_cards (
  work_id     INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  -- documented: written from a retrieved composition history.
  -- thin:       nothing documented; the material card is shown instead.
  confidence  TEXT NOT NULL,
  body        TEXT,                   -- null on a thin card, by design
  model       TEXT,
  generated_at TEXT,
  -- Set when a reader edits the card by hand. A hand-written card is never
  -- overwritten by a regeneration.
  edited_by_user INTEGER NOT NULL DEFAULT 0
);

-- The closing note on a season. One per season, and only ever written from
-- the histories above rather than from the books' plots.
CREATE TABLE IF NOT EXISTS season_notes (
  season_id    TEXT PRIMARY KEY REFERENCES seasons(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  model        TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── IMPORTED MARGINALIA ─────────────────────────────────
--
-- A note somebody wrote while reading, carried in from somewhere else.
--
-- It cannot be a session. A session has a position, and the Goodreads data
-- export records what was written and the day it was written but never the
-- page — so logging one would mean inventing a page number and then drawing
-- it on a progress bar as though it were measured.
--
-- It cannot be the old `annotations` table either: that one is a v04 relic
-- that migrate-v05 folds into readings.private_note and then drops, so a
-- note written there would survive exactly until the next migration.
--
-- So it is its own table, with a nullable page and a real date. `source`
-- says where it came from, which is what makes a second upload of the same
-- file a no-op rather than a duplicate.
CREATE TABLE IF NOT EXISTS reading_notes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  page       INTEGER,
  body       TEXT NOT NULL,
  written_on TEXT,
  source     TEXT NOT NULL DEFAULT 'goodreads',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The uniqueness that makes re-uploading the same export harmless.
CREATE UNIQUE INDEX IF NOT EXISTS reading_notes_once
  ON reading_notes (user_id, work_id, body);

-- ── PUBLISHED ARTIFACTS ─────────────────────────────────
--
-- The lookbook and the poster are the best things this product makes and
-- both were sealed inside an account that defaults to private. The season
-- artifacts are the identity object and the invitation, and neither could
-- leave the building.
--
-- The reconciliation is NOT "make your profile public". It is publishing ONE
-- artifact, once, at any profile visibility including private. The decision
-- is scoped to a single object, reversible, and legible — which is what lets
-- private-by-default survive a product that also wants to be shared.
--
-- Only the token HASH is stored. A published link cannot be recovered from
-- the database, so a leak of this table exposes nothing that is not already
-- public by the reader's own choice.
-- RETIRED. A season could be published as one link anybody could open, at
-- any profile visibility. The safety of it was real — the assembler ran with
-- owner:false, so the pulp and the marginalia never reached the page — but
-- the object is personal: a record of what one person read, with their own
-- writing in the margins, does not need a public URL.
--
-- The table is left in place rather than dropped. A DROP in a schema file
-- that runs on every boot destroys rows, and nothing costs anything by its
-- staying. Nothing reads or writes it; there is no route that resolves a
-- token, so any link that was minted is already dead.
CREATE TABLE IF NOT EXISTS published_looks (
  id           TEXT PRIMARY KEY,
  season_id    TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  -- The visible half of the token, so the reader can recognise their own
  -- link in a list without the server being able to reconstruct it.
  token_hint   TEXT NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS published_looks_season ON published_looks (season_id);
