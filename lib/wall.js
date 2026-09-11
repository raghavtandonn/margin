import { all } from '../db/index.js';
import { daysSince } from './artifacts.js';

// ── "THE WALL" (v0.5.1 §5) ───────────────────────────────
// Your library rendered as physical shelves at true scale. Spine widths and
// heights derived from real edition data, so a 900-page hardcover is visibly
// bigger than a 180-page paperback.
//
// Everything here works from data already in the Goodreads import.

// §5.1 — paper bulk is measured in PPI, pages per inch.
const PPI = {
  MASS_MARKET: 500,
  HARDCOVER: 360,
  PAPERBACK: 434, // 50lb offset, the common trade stock
  DEFAULT: 434
};

const HEIGHT_INCHES = {
  MASS_MARKET: 6.87,
  PAPERBACK: 8.5,
  HARDCOVER: 9.0,
  DEFAULT: 8.5
};

export const SCALE = 34; // px per inch
const MIN_WIDTH = 14;
const MAX_WIDTH = 120;
const NO_EXTENT_INCHES = 0.9;

const normFormat = (f) => {
  const k = String(f || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (k === 'MASS_MARKET' || k === 'HARDCOVER' || k === 'PAPERBACK') return k;
  return 'DEFAULT';
};

export function spineGeometry({ page_count, format }) {
  const f = normFormat(format);
  const heightIn = HEIGHT_INCHES[f] ?? HEIGHT_INCHES.DEFAULT;

  let thicknessIn;
  let noExtent = false;
  if (page_count) {
    thicknessIn = page_count / (PPI[f] ?? PPI.DEFAULT);
    if (f === 'HARDCOVER') thicknessIn += 0.15; // boards and endpapers
  } else {
    // Do not guess a page count. Render at a default and mark the spine.
    thicknessIn = NO_EXTENT_INCHES;
    noExtent = true;
  }

  const raw = Math.round(thicknessIn * SCALE);
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw));

  return {
    width,
    height: Math.round(heightIn * SCALE),
    noExtent,
    // §5.1 — note the clamp rather than silently distorting.
    clamped: raw !== width ? (raw < MIN_WIDTH ? 'MIN' : 'MAX') : null,
    thicknessIn: Number(thicknessIn.toFixed(2)),
    heightIn
  };
}

// §5.3 — the wall reflects how books actually sit on a shelf. WAITING is
// deliberately absent: the wall is books you own and have engaged with.
const WALL_STATES = new Set(['FINISHED', 'READING', 'STALLED', 'ABANDONED']);

// Matches the reading screen's threshold: a pass with no session in 21 days
// is stalled. Neutral, automatic, and never a notification.
const STALL_DAYS = 21;

// A wall of 336 unread books is a portrait of a wishlist, not of reading.
// Scope decides what is on the shelf at all.
export const WALL_SCOPES = ['FINISHED', 'READING'];
export const WALL_GROUPS = ['NONE', 'SHELF', 'YEAR', 'AUTHOR'];

const SCOPE_STATES = {
  FINISHED: ['FINISHED'],
  READING: ['READING', 'STALLED'],
  ALL: ['FINISHED', 'READING', 'STALLED', 'ABANDONED']
};

export function wallBooks(userId, { sort = 'ADDED', scope = 'FINISHED' } = {}) {
  const rows = all(
    `SELECT
       w.id AS work_id, w.title,
       (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author,
       r.id AS reading_id, r.status, r.stars, r.finished_at, r.created_at, r.current_page,
       e.id AS edition_id, e.page_count, e.format, e.cover_url,
       e.cover_cache_key, e.spine_color, e.isbn13
     FROM readings r
     JOIN works w ON w.id = r.work_id
     LEFT JOIN editions e ON e.id = COALESCE(r.edition_id, (
       SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
       ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), (e2.page_count IS NULL), e2.published_year DESC LIMIT 1
     ))
     WHERE r.user_id = ? AND r.status IN ('FINISHED','READING','STALLED','ABANDONED')
     ORDER BY r.created_at`,
    Number(userId)
  );

  // STALLED is derived, not stored — a pass goes quiet, it is not marked
  // quiet. The wall has to derive it the same way the reading screen does,
  // or a stalled book sits flat on the shelf pretending to be on press.
  const lastLogged = new Map(
    all(
      `SELECT r.id, MAX(s.occurred_at) AS last
       FROM readings r LEFT JOIN sessions s ON s.reading_id = r.id
       WHERE r.user_id = ? GROUP BY r.id`,
      Number(userId)
    ).map((r) => [r.id, r.last])
  );

  const books = rows.map((b) => {
    let state = WALL_STATES.has(b.status) ? b.status : 'FINISHED';
    if (state === 'READING') {
      const last = lastLogged.get(b.reading_id);
      const days = last != null ? daysSince(last) : null;
      if (days != null && days >= STALL_DAYS) state = 'STALLED';
    }
    return { ...b, geometry: spineGeometry(b), state };
  });

  const allowed = new Set(SCOPE_STATES[scope] || SCOPE_STATES.FINISHED);
  return sortWall(books.filter((b) => allowed.has(b.state)), sort);
}

// Sort and group are different things. Sorting reorders one shelf; grouping
// breaks the wall into separate shelves, the way a real bookcase is arranged.
export function groupWall(books, group) {
  if (!group || group === 'NONE') return [{ label: null, books }];

  const key = (b) => {
    if (group === 'YEAR') {
      const d = b.finished_at || b.created_at;
      return d ? String(d).slice(0, 4) : 'UNDATED';
    }
    if (group === 'AUTHOR') return b.author || 'UNATTRIBUTED';
    return b.shelf || b.state;
  };

  const map = new Map();
  for (const b of books) {
    const k = key(b);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }

  const entries = [...map.entries()];
  // Years read forward; everything else by size, so the shelf you have most
  // of leads.
  if (group === 'YEAR') entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  else entries.sort((a, b) => b[1].length - a[1].length);

  return entries.map(([label, list]) => ({ label, books: list }));
}

export const WALL_SORTS = ['ADDED', 'AUTHOR', 'TITLE', 'RATING'];

function sortWall(books, sort) {
  const by = {
    ADDED: (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
    AUTHOR: (a, b) => String(a.author || '').localeCompare(String(b.author || '')),
    TITLE: (a, b) => String(a.title).localeCompare(String(b.title)),
    RATING: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
    HEIGHT: (a, b) => b.geometry.height - a.geometry.height,
    THICKNESS: (a, b) => b.geometry.width - a.geometry.width,
    // Sorted by the sampled spine hue: a rainbow shelf.
    COLOUR: (a, b) => hueOf(a.spine_color) - hueOf(b.spine_color)
  };
  return [...books].sort(by[sort] || by.ADDED);
}

function hueOf(hex) {
  if (!hex) return 999; // unsampled spines gather at the end
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.04) return 998; // neutrals, just before the unsampled
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// §5.2 — text colour is computed against the sampled spine, never hardcoded.
export function readableOn(hex) {
  if (!hex) return '#0B0B0B';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Relative luminance, sRGB.
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.42 ? '#0B0B0B' : '#FDFDFC';
}
