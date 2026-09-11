import { get, run, sqlTime, parseSQLTime } from '../../db/index.js';

// ── §5 — layered rate limiting ───────────────────────────
//
// The spec asks for Redis. This is one process with a local database, so the
// sliding windows live in memory — correct here, and wrong the moment there
// is a second process, which SECURITY.md records as a scaling gap.
//
// One counter deliberately does NOT live in memory: the per-account failure
// count. If a restart reset it, restarting would be a free reset of an
// attacker's budget, so that one is written to `auth_failures`.
//
// The rule underneath all of it: BACKOFF, NOT LOCKOUT. A permanent lock on
// failed attempts is a denial-of-service weapon aimed at any known username.

const windows = new Map();

function slide(key, limit, windowMs) {
  const now = Date.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return { ok: false, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) };
  }
  hits.push(now);
  windows.set(key, hits);
  return { ok: true, remaining: limit - hits.length };
}

// Unbounded maps are a memory leak with a long fuse. Sweep every 10 minutes.
const SWEEP = setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of windows) {
    const windowMs = LIMITS[k.slice(0, k.indexOf(':'))].windowMs;
    const live = hits.filter((t) => now - t < windowMs);
    if (live.length) windows.set(k, live);
    else windows.delete(k);
  }
}, 600_000);
SWEEP.unref?.();

export const LIMITS = {
  cspReport:    { limit: 30, windowMs: 60_000 },
  importUpload: { limit: 5, windowMs: 60 * 60_000 },
  ipAuth:       { limit: 20, windowMs: 10 * 60_000 },
  ipRegister:   { limit: 5,  windowMs: 60 * 60_000 },
  emailVerify:  { limit: 3,  windowMs: 60 * 60_000 },
  emailReset:   { limit: 3,  windowMs: 60 * 60_000 },
  exportRun:    { limit: 2,  windowMs: 24 * 60 * 60_000 },
  writeHourly:  { limit: 100, windowMs: 60 * 60_000 },      // §15
  writeDaily:   { limit: 500, windowMs: 24 * 60 * 60_000 }
};

export function check(bucket, key) {
  const cfg = LIMITS[bucket];
  if (!cfg) throw new Error(`unknown rate limit bucket: ${bucket}`);
  return slide(`${bucket}:${key}`, cfg.limit, cfg.windowMs);
}

// ── Per-account backoff ──────────────────────────────────
// Five failures, then 30s doubling to a 15-minute ceiling. The account is
// never locked; the wait simply grows past the point where guessing pays.
const FREE_ATTEMPTS = 5;
const BASE_MS = 30_000;
const CAP_MS = 15 * 60_000;

const parseTime = parseSQLTime;

export function accountBackoff(userId) {
  const row = get('SELECT * FROM auth_failures WHERE scope = ?', `account:${userId}`);
  if (!row?.retry_after) return { ok: true };
  const until = parseTime(row.retry_after);
  if (Date.now() >= until) return { ok: true };
  return { ok: false, retryAfter: Math.ceil((until - Date.now()) / 1000) };
}

export function recordFailure(userId) {
  const scope = `account:${userId}`;
  const row = get('SELECT * FROM auth_failures WHERE scope = ?', scope);
  const count = (row?.count || 0) + 1;

  let retryAfter = null;
  if (count > FREE_ATTEMPTS) {
    const wait = Math.min(BASE_MS * 2 ** (count - FREE_ATTEMPTS - 1), CAP_MS);
    retryAfter = sqlTime(Date.now() + wait);
  }

  run(
    `INSERT INTO auth_failures (scope, count, retry_after, last_at)
       VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (scope) DO UPDATE SET
       count = excluded.count, retry_after = excluded.retry_after, last_at = excluded.last_at`,
    scope, count, retryAfter
  );

  return { count, retryAfter };
}

export function clearFailures(userId) {
  run('DELETE FROM auth_failures WHERE scope = ?', `account:${userId}`);
}

// ── Circuit breaker ──────────────────────────────────────
// §5 asks for a breaker on abnormal volume across the whole auth surface.
// It does not reject — it raises the alarm, because a breaker that locks
// everyone out during an attack has done the attacker's work.
let recent = [];
let alerted = 0;
const ABNORMAL = 300;          // auth attempts per minute across all accounts

export function observeAuthAttempt({ onAlert } = {}) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60_000);
  recent.push(now);

  if (recent.length > ABNORMAL && now - alerted > 300_000) {
    alerted = now;
    const msg = `auth volume ${recent.length}/min exceeds ${ABNORMAL}`;
    (onAlert || ((m) => console.warn(`  ALERT — ${m}`)))(msg);
    return { abnormal: true, rate: recent.length };
  }
  return { abnormal: false, rate: recent.length };
}

// Tests need a clean slate between cases without waiting out a window.
export function __reset() {
  windows.clear();
  recent = [];
  alerted = 0;
}
