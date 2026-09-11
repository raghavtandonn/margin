-- "MARGIN" — schema
-- P0: the work/edition graph. Everything else hangs off this.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── PEOPLE ───────────────────────────────────────────────
-- Authors, jacket designers, translators, editors, illustrators, typographers
-- all live in one table. §08 "THE COLOPHON": a jacket designer is a first-class
-- linkable entity with a followable catalog, exactly like an author.
CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  sort_name     TEXT,
  ol_key        TEXT UNIQUE,
  bio           TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);

-- ── WORKS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS works (
  id                    INTEGER PRIMARY KEY,
  title                 TEXT NOT NULL,
  subtitle              TEXT,
  first_published_year  INTEGER,
  description           TEXT,
  first_lines           TEXT,
  first_lines_source    TEXT,
  -- The desk's semantic corpus: subject headings and blurb from Open
  -- Library. Without these, "books about grief" has nothing to match on.
  subjects              TEXT,          -- JSON array
  blurb                 TEXT,
  original_language     TEXT,
  subjects_fetched_at   TEXT,
  ol_key                TEXT UNIQUE,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_works_title ON works(title);

-- role: AUTHOR | TRANSLATOR | EDITOR | INTRODUCTION | ILLUSTRATOR
CREATE TABLE IF NOT EXISTS work_people (
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'AUTHOR',
  ord         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (work_id, person_id, role)
);

-- ── SERIES ───────────────────────────────────────────────
-- §00 failure 3: "series ordering is unreliable". position is REAL so that
-- novellas can sit at 2.5 without renumbering the whole series.
CREATE TABLE IF NOT EXISTS series (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS series_works (
  series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  position   REAL NOT NULL,
  PRIMARY KEY (series_id, work_id)
);

-- ── EDITIONS ─────────────────────────────────────────────
-- §09.1: choosing an edition changes page count, cover, and colophon.
CREATE TABLE IF NOT EXISTS editions (
  id              INTEGER PRIMARY KEY,
  work_id         INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  isbn13          TEXT,
  isbn10          TEXT,
  publisher       TEXT,
  published_year  INTEGER,
  page_count      INTEGER,
  format          TEXT,          -- PAPERBACK | HARDCOVER | EBOOK | AUDIO
  binding_note    TEXT,
  language        TEXT DEFAULT 'en',
  cover_url       TEXT,
  ol_key          TEXT UNIQUE,
  -- v0.5.1 §0 — a cover URL is only ever stored once verified to return real
  -- image bytes. cover_source records which link in the chain answered.
  cover_source    TEXT,
  cover_cache_key TEXT,
  cover_checked_at TEXT,
  -- §5.2 — dominant colour of the cover's left edge, sampled once at import.
  spine_color     TEXT,
  -- Bulk (paper thickness) in mm-per-page, used to compute real spine width
  -- for the "SPINES" shelf view (§09.2). Default is uncoated 80gsm.
  paper_bulk      REAL DEFAULT 0.10,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_editions_work ON editions(work_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_isbn13 ON editions(isbn13) WHERE isbn13 IS NOT NULL;

-- §08 "THE COLOPHON" — the block that closes every book page.
CREATE TABLE IF NOT EXISTS colophons (
  edition_id      INTEGER PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  set_in          TEXT,   -- "Dante MT 10.25 / 12.75"
  paper           TEXT,   -- "Munken Print Cream 80gsm"
  printer         TEXT,   -- "Clays Ltd, Bungay, Suffolk"
  number_line     TEXT,   -- "10 9 8 7 6 5 4 3 2 1"
  print_run       INTEGER,
  first_printing  TEXT
);

-- Credits on an edition: JACKET_DESIGN, COVER_ILLUSTRATION, TYPOGRAPHY,
-- TRANSLATION, INTRODUCTION, EDITOR. This is what makes designers followable.
CREATE TABLE IF NOT EXISTS edition_credits (
  edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  PRIMARY KEY (edition_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_edition_credits_person ON edition_credits(person_id);

-- §12: "community correction and a visible edit history on every record"
CREATE TABLE IF NOT EXISTS edit_history (
  id          INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL,     -- 'work' | 'edition' | 'person'
  entity_id   INTEGER NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source      TEXT,              -- 'openlibrary' | 'goodreads-import' | 'manual'
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edit_history_entity ON edit_history(entity, entity_id);

-- ── USERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  library_card  TEXT,   -- for the "WHERE TO GET IT" local-library-first lookup
  settings      TEXT NOT NULL DEFAULT '{}',  -- JSON: pattern_mode, show_overall, spoiler_horizon
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SHELVES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shelves (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS shelf_items (
  id          INTEGER PRIMARY KEY,
  shelf_id    INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  edition_id  INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shelf_id, work_id)
);
CREATE INDEX IF NOT EXISTS idx_shelf_items_work ON shelf_items(work_id);

-- ── READING PASSES (§09.3, v0.3 B1) ──────────────────────
-- Goodreads conflates three distinct things into one row, and nearly every
-- complaint about it traces back to that conflation:
--
--   SHELF MEMBERSHIP  where a book sits      — shelf_items
--   READING PASS      one time through it    — readings (this table)
--   PRINT             what you thought of it — prints
--
-- pass_number is why this table exists. Each re-read is its own record with
-- its own dates, sessions, pace, and optionally its own print. Your opinion
-- at nineteen and at thirty-four are two data points, not one overwritten
-- field. Goodreads stores a Read Count integer and destroys the dates.
--
-- status: READING | FINISHED | ABANDONED | WAITING | STALLED
CREATE TABLE IF NOT EXISTS readings (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id         INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  edition_id      INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'READING',
  pass_number     INTEGER NOT NULL DEFAULT 1,
  -- B6: formats that have no pages.
  format          TEXT NOT NULL DEFAULT 'print',   -- print | ebook | audio
  position_type   TEXT NOT NULL DEFAULT 'page',    -- page | percent | minute | location
  current_page    REAL NOT NULL DEFAULT 0,         -- current position, any type
  total_positions REAL,                            -- page count, runtime in min, …
  started_at      TEXT,
  finished_at     TEXT,
  abandoned_at    TEXT,
  abandoned_page  REAL,
  due_date        TEXT,
  due_extensions  INTEGER NOT NULL DEFAULT 0,
  due_notified    INTEGER NOT NULL DEFAULT 0,
  -- v0.5.1 §2 — the rating lives on the pass, so a re-read gets its own and
  -- the earlier one survives. Stars only; never a colour.
  stars           REAL CHECK (stars IS NULL OR (stars > 0 AND stars <= 5)),
  marks           TEXT,          -- JSON array from the fixed MARKS set
  review          TEXT,
  -- §1.2 — anchored public annotation is cut. A private notes field, yours only.
  private_note    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_readings_user_status ON readings(user_id, status);
-- Deliberately NOT unique on (user_id, work_id): a work may hold many passes.
CREATE INDEX IF NOT EXISTS idx_readings_user_work ON readings(user_id, work_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_pass ON readings(user_id, work_id, pass_number);

-- ── SESSIONS (v0.3 B1, B3) ───────────────────────────────
-- position is CUMULATIVE, never a delta. People know what page they stopped
-- on; they do not know how many pages they read. Never ask for a delta.
--
-- occurred_at defaults to now but is always editable: remembering later is
-- the most common real-world logging pattern, so backdating is a primary
-- path rather than a repair path (B7).
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  reading_id       INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  position         REAL NOT NULL,
  position_type    TEXT,          -- may differ from the reading's own type
  logged_at        TEXT NOT NULL DEFAULT (datetime('now')),
  occurred_at      TEXT NOT NULL DEFAULT (datetime('now')),
  duration_minutes INTEGER,       -- opt-in only; off by default (B3)
  note             TEXT,
  source           TEXT NOT NULL DEFAULT 'manual'  -- manual | scan | import | backfill
);
CREATE INDEX IF NOT EXISTS idx_sessions_reading ON sessions(reading_id, occurred_at);

-- ── SEARCH (§12) ─────────────────────────────────────────
-- Trigram tokenizer gives substring and typo tolerance. Target p95 < 120ms.
CREATE VIRTUAL TABLE IF NOT EXISTS works_fts USING fts5(
  title,
  authors,
  series,
  isbns,
  work_id UNINDEXED,
  tokenize = 'trigram'
);
