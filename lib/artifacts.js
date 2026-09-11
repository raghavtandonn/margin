// Helpers for the components that quote physical bookmaking artifacts (§08).
// The system quotes these artifacts; it does not simulate them (§13).

// ── "THE STAMP" ──────────────────────────────────────────
// Rotation seeded deterministically from the ISBN so a book's stamp sits at
// the same angle across sessions and devices (§08). A random angle per render
// would read as jitter rather than as a stamped object.
export function stampRotation(seedText) {
  const seed = String(seedText || '');
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 801) / 100 - 4).toFixed(2); // −4.00° … +4.00°
}

export const STAMP_STATES = {
  READING: { label: 'READING', dated: false, struck: false, tone: 'orange' },
  FINISHED: { label: 'FINISHED', dated: true, struck: false, tone: 'black' },
  ABANDONED: { label: 'ABANDONED', dated: true, struck: true, tone: 'black' },
  WAITING: { label: 'WAITING', dated: true, struck: false, tone: 'gray' }
};

// ── ISBN / "THE BARCODE" ─────────────────────────────────
export function isbnCheckDigit13(first12) {
  const sum = [...first12].reduce(
    (s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3),
    0
  );
  return String((10 - (sum % 10)) % 10);
}

export function normalizeISBN(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 13) return digits;
  if (digits.length === 10) {
    const core = '978' + digits.slice(0, 9);
    return core + isbnCheckDigit13(core);
  }
  return null;
}

export function isValidISBN13(isbn) {
  const n = normalizeISBN(isbn);
  return !!n && n.length === 13 && isbnCheckDigit13(n.slice(0, 12)) === n[12];
}

export function formatISBN(isbn13) {
  const n = normalizeISBN(isbn13);
  if (!n) return null;
  return `${n.slice(0, 3)}-${n[3]}-${n.slice(4, 8)}-${n.slice(8, 12)}-${n[12]}`;
}

// EAN-13 module pattern. Rendered as real bars rather than a barcode font so
// it survives at any size and actually scans (§08 "THE BARCODE").
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

// Returns the 95-module bit string: quiet zones are added by the renderer.
export function ean13Modules(isbn13) {
  const n = normalizeISBN(isbn13);
  if (!n || n.length !== 13) return null;
  const digits = [...n].map(Number);
  const parity = PARITY[digits[0]];

  let bits = '101'; // start guard
  for (let i = 1; i <= 6; i++) {
    bits += (parity[i - 1] === 'L' ? L : G)[digits[i]];
  }
  bits += '01010'; // centre guard
  for (let i = 7; i <= 12; i++) bits += R[digits[i]];
  bits += '101'; // end guard
  return bits;
}

// ── Spine dimensions (§09.2 "SPINES" view) ───────────────
// Real spine width from page count and paper bulk — thick books look thick.
export function spineWidth(pageCount, paperBulk = 0.1) {
  const leaves = (pageCount || 200) / 2;
  const mm = leaves * paperBulk + 2; // + board and hinge
  return Math.max(6, Math.min(64, Math.round(mm * 1.6))); // mm → px
}

export function spineHeight(format) {
  const heights = { HARDCOVER: 240, PAPERBACK: 198, MASS_MARKET: 174, EBOOK: 198, AUDIO: 198 };
  return heights[format] || 198;
}

// ── Time ─────────────────────────────────────────────────
// SQLite stores datetime('now') as UTC with no zone marker. Parsing that
// naively treats it as local time, which puts every fresh timestamp in the
// future and produces "-1 DAYS AGO" — and silently delays stall detection
// by up to a day. Every SQLite timestamp goes through here.
export function parseSQLiteTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysSince(value) {
  const d = parseSQLiteTime(value);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

// ── Trim aspect (v0.2 A2) ────────────────────────────────
// Covers are never cropped. The frame takes the edition's true trim and the
// cover letterboxes within it, so a mass market paperback is genuinely
// narrower than a hardcover on the contact sheet. The ragged right edge of
// the grid is real information about what kind of reader you are.
const TRIM = {
  MASS_MARKET: 0.619,   // 4.25 × 6.87 in
  PAPERBACK: 0.647,     // 5.5 × 8.5 in — trade
  HARDCOVER: 0.667,     // 6 × 9 in
  EBOOK: 0.647,
  AUDIO: 0.647
};

export function trimAspect(format) {
  const key = String(format || '').toUpperCase().replace(/[\s-]+/g, '_');
  return TRIM[key] ?? TRIM.PAPERBACK;
}

// ── The pace strip (§09.3) ───────────────────────────────
// Pages per day across the days you held the book. Gaps are preserved
// because the stall is information, not an accusation. No streaks.
export function paceStrip(events, { startedAt, endAt, maxDays = 120 } = {}) {
  if (!events.length) return [];

  const day = (t) => String(t).slice(0, 10);
  const sorted = [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  let start = new Date(day(startedAt || sorted[0].at));
  const end = new Date(day(endAt || sorted[sorted.length - 1].at));

  // A book held for two years is a true fact, but 700 bars in a 44px strip is
  // not a reading of it. The window is capped and the caller labels the cap,
  // so the truncation is visible rather than silent.
  const span = Math.round((end - start) / 86400000);
  if (span > maxDays) {
    start = new Date(end);
    start.setDate(start.getDate() - maxDays);
  }

  const byDay = new Map();
  for (const e of sorted) {
    const d = day(e.at);
    byDay.set(d, Math.max(byDay.get(d) ?? 0, e.page));
  }

  const out = [];
  let lastPage = 0;
  for (let t = new Date(start); t <= end; t.setDate(t.getDate() + 1)) {
    const d = t.toISOString().slice(0, 10);
    const reached = byDay.get(d);
    const pages = reached === undefined ? 0 : Math.max(0, reached - lastPage);
    if (reached !== undefined) lastPage = reached;
    out.push({ date: d, pages, stalled: pages === 0 });
  }
  return out;
}

// ── Breakpoint names (§06) ───────────────────────────────
// The names appear in the CSS, in dev tools, and in the page footer. This is
// P2 — show the mechanics — applied to the responsive system itself.
export const BREAKPOINTS = [
  { name: 'PROOF', min: 1440, note: 'FULL GRID · MARGIN AT 3 COLS' },
  { name: 'TRIM', min: 1024, note: 'MARGIN AT 2 COLS' },
  { name: 'GALLEY', min: 768, note: 'MARGIN AS DRAWER' },
  { name: 'POCKET', min: 0, note: 'ANCHOR DOTS + SHEET' }
];
