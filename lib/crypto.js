import {
  randomBytes, createHash, createCipheriv, createDecipheriv,
  hkdfSync, timingSafeEqual, createHmac
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── §11 / §16 — application-layer encryption ─────────────
//
// The spec asks for envelope encryption with a KMS-held key. There is no KMS
// here, and pretending otherwise would be the worst option. What is
// implemented is the SHAPE of envelope encryption with a locally-held root
// key, which buys the property the spec actually names:
//
//   "Compromise of a database backup should not yield readable notes."
//
// That holds as long as the key is not in the database and not in the
// backup — so the key lives in a file outside the data directory, with 0600
// permissions, and is gitignored. What it does NOT buy, and what a real KMS
// would, is protection against an attacker who reaches the filesystem, plus
// key rotation, per-use audit, and hardware custody. Section "Deployment
// gaps" in SECURITY.md says so plainly rather than leaving it implied.

const here = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.MARGIN_KEY_FILE || join(here, '..', 'secrets', 'master.key');

function loadKey() {
  // An explicit key in the environment wins, which is how a real deployment
  // injects one from a secret manager without a file ever existing.
  if (process.env.MARGIN_KEY) {
    return createHash('sha256').update(process.env.MARGIN_KEY).digest();
  }
  if (!existsSync(KEY_PATH)) {
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, randomBytes(32));
    chmodSync(KEY_PATH, 0o600);
    console.log(`  generated a new master key at ${KEY_PATH} — back it up, or notes become unreadable`);
  }
  const raw = readFileSync(KEY_PATH);
  return raw.length === 32 ? raw : createHash('sha256').update(raw).digest();
}

let ROOT = null;
const root = () => (ROOT ||= loadKey());

const VERSION = 1;

/**
 * Encrypt to a self-describing envelope.
 *
 * Every record gets its OWN key, derived from the root by HKDF over a random
 * per-record salt. That is the property envelope encryption is for: reading
 * one record's key does not read any other record.
 *
 *   [1 byte version][16 salt][12 iv][16 tag][ciphertext]
 */
export function seal(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync('sha256', root(), salt, 'margin:record', 32));

  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), salt, iv, c.getAuthTag(), ct]);
}

export function open(envelope) {
  if (!envelope) return null;
  const b = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (b.length < 45 || b[0] !== VERSION) return null;

  const salt = b.subarray(1, 17);
  const iv = b.subarray(17, 29);
  const tag = b.subarray(29, 45);
  const ct = b.subarray(45);
  const key = Buffer.from(hkdfSync('sha256', root(), salt, 'margin:record', 32));

  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    // A failed tag check means tampering or the wrong key. Either way there
    // is no plaintext to return, and guessing would be worse than nothing.
    return null;
  }
}

// ── Tokens ───────────────────────────────────────────────
// Text columns can hold encrypted SQLite BLOBs. The string fallback supports
// legacy rows until startup migration and old-format import fixtures.
export const privateText = value => value == null ? null : typeof value === 'string' ? value : open(value);
export const privateTextKey = (userId, workId, text) =>
  createHmac('sha256', root()).update(JSON.stringify([Number(userId), Number(workId), text])).digest('hex');
export const csrfSigningKey = () => createHmac('sha256', root()).update('margin:csrf').digest();

// §4, §7, §8 — 32 bytes of CSPRNG, base64url, stored only as a hash.
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token) =>
  createHash('sha256').update(String(token)).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── §16 — IP hashing ─────────────────────────────────────
// Rate limiting needs to recognise an address; nothing needs to retain a
// plaintext history of where someone reads from. The salt rotates daily, so
// yesterday's hashes cannot be correlated with today's.
const ipSalt = () => {
  const day = Math.floor(Date.now() / 86_400_000);
  return `${process.env.MARGIN_IP_SALT || 'margin'}:${day}`;
};

export const hashIP = (ip) =>
  ip ? createHash('sha256').update(`${ipSalt()}:${ip}`).digest('hex').slice(0, 32) : null;

// A stable hash for ban continuity on a tombstoned account (§12). Salted
// with the root key so the table alone cannot be dictionary-attacked back
// into a list of everyone who ever signed up.
export const hashEmailForBan = (email) =>
  createHash('sha256')
    .update(root())
    .update(String(email).trim().toLowerCase())
    .digest('hex');

// §5 — a device is "recognised" by its user agent and the network it came
// from, at /24 granularity so an ordinary reconnection is not a new device.
export function deviceKey(ip, userAgent) {
  const net = String(ip || '').split('.').slice(0, 3).join('.');
  return createHash('sha256').update(`${ipSalt()}:${net}:${userAgent || ''}`).digest('hex').slice(0, 32);
}
