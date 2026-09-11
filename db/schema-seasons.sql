-- "MARGIN" — seasons and the lookbook
--
-- §13, translated to SQLite the same way schema-auth.sql was:
--   UUID PK → TEXT holding a v4 UUID
--   JSONB   → TEXT holding JSON
--   TEXT[]  → TEXT holding a JSON array
--   DATE    → TEXT holding YYYY-MM-DD
--   BOOLEAN → INTEGER 0/1

CREATE TABLE IF NOT EXISTS seasons (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,          -- 'aw26'
  label          TEXT NOT NULL,          -- 'Autumn/Winter 26'
  starts_on      TEXT NOT NULL,          -- 'YYYY-MM-DD'
  ends_on        TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  closed_at      TEXT,
  given_title    TEXT,
  note           TEXT,
  note_edited_by_user INTEGER NOT NULL DEFAULT 0,
  -- §13 — "Retain facts permanently." It is what makes regeneration cheap,
  -- makes the validation step auditable, and lets a future version
  -- re-render old seasons with better writing.
  facts          TEXT,
  colour_strip   TEXT,                   -- JSON array of hex strings
  generated_at   TEXT,
  regenerated_today_at TEXT,
  -- Which path produced the note, so the lookbook can say so rather than
  -- implying a model wrote something a template did.
  note_source    TEXT,                   -- 'template' | 'model'
  UNIQUE (user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_seasons_user ON seasons(user_id, starts_on);

CREATE TABLE IF NOT EXISTS season_movements (
  id              TEXT PRIMARY KEY,
  season_id       TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,      -- 1, 2, 3 → i. ii. iii.
  name            TEXT,
  starts_on       TEXT,
  ends_on         TEXT,
  -- §6 — "The empty movement is not a bug and must not be optimised away."
  is_empty        INTEGER NOT NULL DEFAULT 0,
  boundary_reason TEXT                   -- 'gap' | 'changepoint:translated'
);
CREATE INDEX IF NOT EXISTS idx_movements_season ON season_movements(season_id, ordinal);

CREATE TABLE IF NOT EXISTS season_frames (
  season_id       TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  reading_id      INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  work_id         INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  movement_id     TEXT REFERENCES season_movements(id) ON DELETE SET NULL,
  ordinal         INTEGER NOT NULL,
  -- §7 — the caption is a line of the reader's own note, pinned verbatim.
  caption         TEXT,
  -- §11 — hidden from frames, still counted in facts unless also private.
  hidden          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, reading_id)
);
CREATE INDEX IF NOT EXISTS idx_frames_movement ON season_frames(movement_id, ordinal);

-- §8 — the colour signature is cached on the book record, never recomputed
-- per render. Kept on the edition, beside spine_color, because it is a
-- property of the jacket rather than of the reading.
