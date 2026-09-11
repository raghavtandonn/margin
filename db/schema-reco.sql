-- ── THE EMBEDDING STORE (recommendation spec §02) ────────
--
-- One vector per (work, kind, version). Computed once, read everywhere, and
-- FROZEN AT WRITE: a stored vector is never recomputed in place. A new model
-- is a new version row, so the vector used at evaluation is byte-identical to
-- the vector used at serving. The colour system was bitten by exactly this —
-- a frozen frequency table diverging from a recomputed one — and the rule is
-- here to stop the second instance of it.
--
-- Absence is a first-class state. A book with no usable text gets NO ROW,
-- never a zero vector: the origin is a real location in the space, and a
-- book placed there is being asserted to be maximally neutral rather than
-- unknown.
CREATE TABLE IF NOT EXISTS embeddings (
  id            INTEGER PRIMARY KEY,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,      -- 'text-blurb' | 'text-criticism' | 'text-plot'
                                    -- | 'clip-jacket' | 'colour-oklab' | 'colour-components'
  version       TEXT NOT NULL,      -- 'bge-small-en-v1.5@1'
  dim           INTEGER NOT NULL,
  vec           BLOB NOT NULL,      -- Float32Array, L2-normalised at write
  source_ref    TEXT,               -- which blurb/section/jacket produced it
  source_chars  INTEGER,            -- input length, for the length-bias audit (§09)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(work_id, kind, version)
);
CREATE INDEX IF NOT EXISTS idx_emb_kind_ver ON embeddings(kind, version);

-- ── THE PROBE (§04) ──────────────────────────────────────
-- Every probe result is kept, including the bad ones. A kind that scores at
-- random is a finding, and the number is what stops it being re-proposed.
CREATE TABLE IF NOT EXISTS probe_runs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  version      TEXT NOT NULL,
  n_pos        INTEGER NOT NULL,
  n_neg        INTEGER NOT NULL,
  accuracy     REAL NOT NULL,
  baseline     REAL NOT NULL,
  auc          REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── RUNS AND ITEMS (§10) ─────────────────────────────────
-- per_kind and neighbours are stored AT GENERATION so a recommendation stays
-- explainable after the embeddings are versioned forward — the same reason
-- colour cards store their components and their citations.
CREATE TABLE IF NOT EXISTS reco_runs (
  id           INTEGER PRIMARY KEY,
  surface      TEXT NOT NULL,          -- 'pile' | 'season'
  season_id    TEXT,                   -- seasons.id is a UUID; null for pile
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kinds        TEXT NOT NULL,          -- JSON: kinds and weights used
  probe_ver    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reco_items (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES reco_runs(id) ON DELETE CASCADE,
  work_id      INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  slot         TEXT,                   -- 'near' | 'absence' | 'thread' (season only)
  score        REAL NOT NULL,
  per_kind     TEXT NOT NULL,          -- JSON: cosine per kind
  neighbours   TEXT NOT NULL,          -- JSON: nearest finished books
  rationale    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reco_items_run ON reco_items(run_id, rank);
