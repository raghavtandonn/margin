import { seal, privateText } from './crypto.js';
import { visibleReadingSQL } from './visibility.js';
import { randomUUID } from 'node:crypto';
import { all, get, run, nowSQL } from '../db/index.js';
import { noteOf } from './notes.js';

// ── §1 — SEASON DEFINITION ───────────────────────────────
//
// Two a year, on the fashion retail calendar rather than the meteorological
// one. It looks wrong for a second — January is not spring — and it is
// correct to the reference: a Spring/Summer collection reaches shop floors
// in January and holds them until June.
//
// The practical benefit is the one that matters here: no season straddles a
// year boundary, so no label is ever ambiguous.
//
//   Spring/Summer   S/S 26   1 January – 30 June
//   Autumn/Winter   A/W 26   1 July    – 31 December
//
// §1 — labels are globally constant. They are NOT inverted for the southern
// hemisphere: this is a fashion reference, not a weather report, and
// southern-hemisphere retailers use northern season naming too.

const pad = (n) => String(n).padStart(2, '0');

export function seasonOf(date) {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();           // 0-indexed

  // §2 — the boundary is inclusive-left: 30 June is S/S, 1 July is A/W.
  const isSS = month < 6;

  return build(year, isSS ? 'ss' : 'aw');
}

export function build(year, half) {
  const yy = pad(year % 100);
  return half === 'ss'
    ? {
        code: `ss${yy}`,
        short: `S/S ${yy}`,
        label: `Spring/Summer ${yy}`,
        starts_on: `${year}-01-01`,
        ends_on: `${year}-06-30`,
        year, half
      }
    : {
        code: `aw${yy}`,
        short: `A/W ${yy}`,
        label: `Autumn/Winter ${yy}`,
        starts_on: `${year}-07-01`,
        ends_on: `${year}-12-31`,
        year, half
      };
}

/** 'aw26' → the same shape. Returns null for anything else. */
export function parseCode(code) {
  const m = /^(ss|aw)(\d{2})$/i.exec(String(code || '').trim());
  if (!m) return null;
  const half = m[1].toLowerCase();
  // Two digits, resolved into the century the library actually lives in.
  const yy = Number(m[2]);
  const year = 2000 + yy;
  return build(year, half);
}

export const currentSeason = ({ now = new Date() } = {}) => seasonOf(now);

/** Every season from the first one that has anything in it, to today. */
export function rangeOfSeasons(from, to = new Date()) {
  const first = seasonOf(from);
  const last = seasonOf(to);
  const out = [];
  let { year, half } = first;

  for (let guard = 0; guard < 400; guard++) {
    out.push(build(year, half));
    if (year === last.year && half === last.half) break;
    if (half === 'ss') half = 'aw';
    else { half = 'ss'; year += 1; }
  }
  return out;
}

// ── §2 — ASSIGNMENT ──────────────────────────────────────
//
// One rule: a book belongs to the season in which it was FINISHED, however
// long it took to read. A book started in one season and finished three
// seasons later belongs entirely to the season it was finished in.

/**
 * The readings that land in a season.
 *
 * Abandonments come back too, flagged — §7.5 lists them plainly after the
 * last movement, and §4.4 counts them, but they are not rendered as frames.
 * A book still being read at the close is simply absent: it will land
 * wherever it finishes.
 */
export function readingsIn(userId, season) {
  return all(
    `SELECT r.*, w.title, w.subjects, w.original_language, w.first_published_year,
            -- THE EXTENT COMES FROM THE WORK, NOT FROM THE CHOSEN EDITION.
            --
            -- The join below picks the edition with the best ARTWORK, which
            -- is right for the jacket and wrong for everything else: an
            -- import never names an edition, so the fallback ran on cover
            -- quality alone and frequently landed on a record with no page
            -- count. A/W 25 reported "1 of 7 measured" while six of those
            -- seven had an extent on a sibling edition.
            --
            -- A cover and a page count are independent facts about a work
            -- and no single edition is guaranteed to carry both, so they are
            -- resolved separately. lib/stats.js already did this; this query
            -- did not.
            COALESCE(e.page_count, (
              SELECT e3.page_count FROM editions e3
               WHERE e3.work_id = w.id AND e3.page_count IS NOT NULL
               ORDER BY (e3.cover_cache_key IS NULL), e3.published_year DESC, e3.id
               LIMIT 1
            )) AS page_count,
            e.season_colour, e.cover_url, e.cover_cache_key, e.publisher,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'TRANSLATOR' ORDER BY wp.ord LIMIT 1) AS translator,
            (SELECT MIN(si.added_at) FROM shelf_items si
               JOIN shelves sh ON sh.id = si.shelf_id
              WHERE si.work_id = w.id AND sh.user_id = r.user_id AND sh.slug = 'waiting') AS waiting_since
       FROM readings r
       JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id ORDER BY e2.id LIMIT 1))
      WHERE r.user_id = ?
        AND r.is_draft = 0
        AND (
          (r.status = 'FINISHED'  AND date(r.finished_at)  BETWEEN ? AND ?) OR
          (r.status = 'ABANDONED' AND date(r.abandoned_at) BETWEEN ? AND ?)
        )
      ORDER BY COALESCE(r.finished_at, r.abandoned_at), r.id`,
    Number(userId), season.starts_on, season.ends_on, season.starts_on, season.ends_on
  ).map((r) => ({
    ...r,
    // §4.5 and §7 both read notes, and both go through lib/notes.js so the
    // decryption happens in one place.
    note: noteOf(r),
    subjects: safeJSON(r.subjects),
    finishedOn: String(r.finished_at || r.abandoned_at || '').slice(0, 10),
    abandoned: r.status === 'ABANDONED'
  }));
}

const safeJSON = (s) => { try { return JSON.parse(s || '[]') || []; } catch { return []; } };

/**
 * §2 — an imported reading with no finish date is excluded from every season
 * and lives in an undated bucket. It is not quietly dated to the import.
 */
export const undatedCount = (userId) =>
  get(
    `SELECT COUNT(*) n FROM readings
      WHERE user_id = ? AND status = 'FINISHED' AND (finished_at IS NULL OR finished_at = '')`,
    Number(userId)
  ).n;

// ── §3 — LIFECYCLE ───────────────────────────────────────
//
//   OPEN     exists from its first day; fills as the reader reads. Frames,
//            colour strip and a running colophon — but NO title, note or
//            movements. You cannot review a collection mid-show.
//   CLOSING  at 00:00 on 1 January and 1 July it locks.
//   CLOSED   title, note and movements appear. Permanently addressable.

export function ensureSeason(userId, season) {
  const existing = get(
    'SELECT * FROM seasons WHERE user_id = ? AND code = ?', Number(userId), season.code
  );
  if (existing) return existing;

  run(
    `INSERT INTO seasons (id, user_id, code, label, starts_on, ends_on, state)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    randomUUID(), Number(userId), season.code, season.label, season.starts_on, season.ends_on
  );
  return get('SELECT * FROM seasons WHERE user_id = ? AND code = ?', Number(userId), season.code);
}

/**
 * §14.1 — backfill from existing history.
 *
 * Creates a record for every season from the reader's first dated finish to
 * the present, including the ones they read nothing in. A season with no
 * books is not skipped: §12 says it "exists, shows the date range and
 * nothing else", and a gap in the index would be the product hiding an
 * absence it has promised to show.
 */
export function backfill(userId, { now = new Date() } = {}) {
  const first = get(
    `SELECT MIN(date(COALESCE(finished_at, abandoned_at))) AS d
       FROM readings
      WHERE user_id = ? AND COALESCE(finished_at, abandoned_at) IS NOT NULL`,
    Number(userId)
  )?.d;

  const seasons = rangeOfSeasons(first || now, now);
  const made = [];
  for (const s of seasons) {
    const before = get('SELECT id FROM seasons WHERE user_id = ? AND code = ?', Number(userId), s.code);
    ensureSeason(userId, s);
    if (!before) made.push(s.code);
  }
  return { seasons: seasons.length, created: made };
}

export const listSeasons = (userId) =>
  all(
    `SELECT * FROM seasons WHERE user_id = ? ORDER BY starts_on DESC`, Number(userId)
  );

export const seasonByCode = (userId, code) =>
  get('SELECT * FROM seasons WHERE user_id = ? AND code = ?', Number(userId), String(code || ''));

/** Has this season's end date passed? */
export const isPast = (season, { now = new Date() } = {}) =>
  new Date(`${season.ends_on}T23:59:59Z`).getTime() < now.getTime();

// ── FRAMES ───────────────────────────────────────────────
/**
 * §7.4 — a frame is a book in the collection. Abandonments are not frames;
 * they are listed as absences (§7.5).
 */
export function syncFrames(seasonRow, readings) {
  const framed = readings.filter((r) => !r.abandoned);

  // Anything no longer in range — a finish date corrected, a reading
  // deleted — stops being a frame rather than lingering.
  const keep = new Set(framed.map((r) => r.id));
  for (const f of all('SELECT reading_id FROM season_frames WHERE season_id = ?', seasonRow.id)) {
    if (!keep.has(f.reading_id)) {
      run('DELETE FROM season_frames WHERE season_id = ? AND reading_id = ?', seasonRow.id, f.reading_id);
    }
  }

  framed.forEach((r, i) => {
    run(
      `INSERT INTO season_frames (season_id, reading_id, work_id, ordinal, caption)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (season_id, reading_id) DO UPDATE SET
         ordinal = excluded.ordinal,
         work_id = excluded.work_id,
         -- A pinned caption is the reader's choice and survives a resync.
         caption = COALESCE(season_frames.caption, excluded.caption)`,
      seasonRow.id, r.id, r.work_id, i + 1, seal(defaultCaption(r.note))
    );
  });

  return framed.length;
}

/**
 * §7 — "Captions come from the reader's note on that book — first line,
 * capped at ~90 characters, verbatim, never rewritten or summarised."
 */
export function defaultCaption(note) {
  if (!note) return null;
  const line = String(note).split(/\n+/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  if (line.length <= 90) return line;
  // Cut at a word boundary rather than mid-word, and do not add a summary.
  const cut = line.slice(0, 90);
  const space = cut.lastIndexOf(' ');
  return (space > 50 ? cut.slice(0, space) : cut) + '…';
}

export function framesOf(seasonId, { viewer = null } = {}) {
  const scope = viewer ? visibleReadingSQL(viewer, { owner: 'u', entry: 'r' }) : null;
  return all(
    `SELECT sf.*, r.stars, r.pass_number, r.finished_at, r.status,
            w.title, w.original_language, w.first_published_year,
            -- THE EXTENT COMES FROM THE WORK, NOT FROM THE CHOSEN EDITION.
            --
            -- The join below picks the edition with the best ARTWORK, which
            -- is right for the jacket and wrong for everything else: an
            -- import never names an edition, so the fallback ran on cover
            -- quality alone and frequently landed on a record with no page
            -- count. A/W 25 reported "1 of 7 measured" while six of those
            -- seven had an extent on a sibling edition.
            --
            -- A cover and a page count are independent facts about a work
            -- and no single edition is guaranteed to carry both, so they are
            -- resolved separately. lib/stats.js already did this; this query
            -- did not.
            COALESCE(e.page_count, (
              SELECT e3.page_count FROM editions e3
               WHERE e3.work_id = w.id AND e3.page_count IS NOT NULL
               ORDER BY (e3.cover_cache_key IS NULL), e3.published_year DESC, e3.id
               LIMIT 1
            )) AS page_count,
            e.season_colour, e.cover_url, e.cover_cache_key,
            -- The colour system: the nearest anchor, the blended hex that
            -- is actually drawn, the generated name, and the components —
            -- the season note counts heaviest components, so a frame
            -- without them reports every book as uncoloured.
            w.colour_id, w.colour_hex, w.colour_name, w.colour_components,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM season_frames sf
       JOIN readings r ON r.id = sf.reading_id
       JOIN users u ON u.id = r.user_id
       JOIN works w ON w.id = sf.work_id
       -- Prefer the edition that actually has artwork. The lowest id is
       -- usually the one without, which left the poster showing three
       -- jackets out of nine and a field of flat colour where the rest
       -- should have been.
       LEFT JOIN editions e ON e.id = COALESCE(r.edition_id,
              (SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
                ORDER BY (e2.cover_cache_key IS NULL), (e2.season_colour IS NULL),
                         (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), e2.id LIMIT 1))
      WHERE sf.season_id = ? ${scope ? `AND r.is_draft = 0 AND ${scope.sql}` : ''}
      ORDER BY sf.ordinal`,
    seasonId, ...(scope?.params || [])
  ).map(f => scope ? { ...f, caption: null } : { ...f, caption: privateText(f.caption) });
}
