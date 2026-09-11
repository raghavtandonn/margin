import { argon2id, argon2Verify } from 'hash-wasm';
import { createHash, randomBytes } from 'node:crypto';

// ── §4 — password policy, per NIST SP 800-63B ────────────
//
// The whole point of citing NIST here is that the folklore is wrong. No
// composition rules, no forced rotation, no silly maximum. What actually
// moves the needle is length, a breach check, and a slow hash — so those are
// the three things this file does.

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 256;   // "64 or more"; the hash cost is flat anyway

// OWASP's Argon2id parameters. Stored inside the encoded hash string, so
// raising them later does not invalidate existing passwords — see needsRehash.
const PARAMS = { memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32 };

// hash-wasm is a WebAssembly build, so this stays a pure-JS install with no
// native toolchain — the same property that lets node:sqlite carry the rest
// of the app with no build step.
const normalise = (password) => String(password).normalize('NFKC');

export async function hashPassword(password) {
  return argon2id({
    password: normalise(password),
    salt: randomBytes(16),
    outputType: 'encoded',
    ...PARAMS
  });
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    return await argon2Verify({ password: normalise(password), hash });
  } catch {
    return false;
  }
}

// §5 — "always execute a dummy Argon2 verification against a fixed hash when
// the user is not found". Without this, a missing account answers in
// microseconds and a real one takes ~50ms, and the timing alone enumerates
// the whole user table.
let DUMMY = null;
export async function dummyVerify(password = 'x') {
  DUMMY ||= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, DUMMY);
  return false;
}

// Parameters live in the encoded string, so an upgrade is detectable and can
// be applied transparently on the next successful login.
export function needsRehash(hash) {
  if (!hash) return true;
  const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!m) return true;
  return Number(m[1]) < PARAMS.memorySize || Number(m[2]) < PARAMS.iterations;
}

// ── Breach check ─────────────────────────────────────────
// k-anonymity: the first five hex characters of the SHA-1 go to the API and
// nothing else does. The password itself never leaves the process, and the
// range endpoint cannot tell which of its ~800 suffixes was being asked about.
const breachCache = new Map();

export async function isBreached(password, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const sha1 = createHash('sha1').update(normalise(password)).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  if (breachCache.has(prefix)) return breachCache.get(prefix).has(suffix);

  const ctl = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: ctl,
      headers: { 'Add-Padding': 'true', 'User-Agent': 'MARGIN/0.6' }
    });
    if (!res.ok) return localBreached(password);

    const set = new Set();
    for (const line of (await res.text()).split('\n')) {
      const [hash, count] = line.trim().split(':');
      // Padded responses come back with a count of 0 and are noise, not hits.
      if (hash && Number(count) > 0) set.add(hash.toUpperCase());
    }
    breachCache.set(prefix, set);
    return set.has(suffix);
  } catch {
    // Offline, rate-limited, or slow. A registration must not fail because a
    // third party is down, but it must not silently skip the check either —
    // so it falls through to a list that ships with the app.
    return localBreached(password);
  }
}

// The floor when the range API is unreachable. Small on purpose: it exists so
// that "offline" still rejects `password1`, not to replace the real check.
const LOCAL_WORST = new Set([
  'password', 'password1', '123456', '12345678', '123456789', '1234567890',
  'qwerty', 'qwerty123', 'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou',
  'admin', 'welcome', 'login', 'passw0rd', 'password123', 'sunshine',
  'princess', 'football', 'baseball', 'trustno1', 'superman', '000000',
  '111111', '696969', 'shadow', 'master', 'michael', 'jennifer', 'freedom',
  'whatever', 'starwars', 'computer', 'access', 'flower', 'hello',
  'charlie', 'donald', 'batman', 'zaq1zaq1', 'qazwsx', '1q2w3e4r',
  'goodreads', 'bookworm', 'margin', 'reading'
]);

const localBreached = (password) => LOCAL_WORST.has(normalise(password).toLowerCase());

// ── The gate ─────────────────────────────────────────────
export async function checkPassword(password, { email, username } = {}) {
  const p = normalise(password ?? '');

  if (p.length < MIN_LENGTH) {
    return { ok: false, error: `Passwords are at least ${MIN_LENGTH} characters.` };
  }
  if (p.length > MAX_LENGTH) {
    return { ok: false, error: `Passwords are at most ${MAX_LENGTH} characters.` };
  }

  // Not a composition rule — a context check. "alice@example.com" is a bad
  // password for alice however many symbols it contains.
  const lower = p.toLowerCase();
  for (const context of [email, username].filter(Boolean)) {
    const c = String(context).toLowerCase().split('@')[0];
    if (c.length >= 4 && lower.includes(c)) {
      return { ok: false, error: 'That password contains your own details. Choose another.' };
    }
  }

  if (await isBreached(p)) {
    return { ok: false, error: 'That password appears in a known breach. Choose another.' };
  }

  return { ok: true };
}
