// ── §11 / §16 — log hygiene ──────────────────────────────
//
// §16: "never log passwords, tokens, TOTP secrets, session tokens, note
// bodies, or full email addresses."
//
// §11 adds that notes must never appear in application logs, error reports,
// breadcrumbs, or analytics — "add an explicit scrubber and a test that
// asserts it". This is that scrubber, and test/scrub.test.js is that test.
//
// The design assumption is that someone will eventually log an object they
// did not fully inspect. So this does not depend on call sites being careful:
// `installConsoleScrubber()` wraps console itself, and everything that goes
// through it is filtered whether the author remembered or not.

const SECRET_KEYS = new Set([
  'password', 'pass', 'passwd', 'pwd', 'new_password', 'newpassword',
  'current_password', 'confirm', 'confirmation',
  'token', 'access_token', 'refresh_token', 'session', 'session_token',
  'cookie', 'authorization', 'auth', 'secret', 'secret_encrypted',
  'totp', 'totp_secret', 'otp', 'code', 'recovery_code', 'recovery',
  'private_note', 'note', 'note_encrypted', 'notes', 'review', 'body',
  'password_hash', 'token_hash', 'code_hash', 'public_key', 'credential_id',
  'apikey', 'api_key', 'csrf', '_csrf'
]);

export const REDACTED = '[redacted]';

// A full address identifies a person; the domain is what is useful in a log.
export const maskEmail = (value) =>
  String(value).replace(
    /\b([^\s@<>()[\]",;:]{1,64})@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
    (_, local, domain) => `${local.slice(0, 2)}${'·'.repeat(Math.max(1, local.length - 2))}@${domain}`
  );

// Things that look like credentials wherever they appear in free text.
const PATTERNS = [
  // Bearer tokens and long base64url blobs — session tokens are 43 chars.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${REDACTED}`],
  [/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED],
  // Argon2 encoded hashes.
  [/\$argon2[a-z]*\$[^\s"']+/g, REDACTED],
  // otpauth URIs carry the TOTP secret in a query parameter.
  [/otpauth:\/\/\S+/g, `otpauth://${REDACTED}`],
  // A credential in a URL — how reset links end up in access logs — and the
  // same shape in a bare log line, which is where it actually turned up.
  [/\b((?:token|code|secret|key|password|pwd)=)[^&\s'"]+/gi, `$1${REDACTED}`],
  // Set-Cookie / Cookie values.
  [/((?:^|;\s*)(?:margin_session|__Host-margin)=)[^;\s]+/g, `$1${REDACTED}`]
];

export function scrubString(input) {
  let s = String(input);
  for (const [re, replacement] of PATTERNS) s = s.replace(re, replacement);
  return maskEmail(s);
}

export function scrub(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[depth]';

  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;

  // Buffers are secret material as often as not, and never readable in a log.
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}]`;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => scrub(v, seen, depth + 1));

  if (value instanceof Error) {
    const out = new Error(scrubString(value.message));
    out.stack = value.stack ? scrubString(value.stack) : undefined;
    return out;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : scrub(v, seen, depth + 1);
  }
  return out;
}

/**
 * Wrap console so a careless `console.log(user)` cannot leak. Returns a
 * function that restores the originals, which the tests use.
 */
export function installConsoleScrubber(target = console) {
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = target[level];
    const write = original[level];
    target[level] = (...args) => write.apply(target, args.map((a) => scrub(a)));
  }
  return () => Object.assign(target, original);
}

/**
 * The shape an error reporter would receive. There is no Sentry DSN in this
 * deployment, so this is the seam one would attach to — scrubbed before it
 * leaves the process, per §13.5 and §19's "assert with an automated scan".
 */
export const forReporter = (err, context = {}) => ({
  message: scrubString(err?.message || String(err)),
  stack: err?.stack ? scrubString(err.stack) : null,
  context: scrub(context)
});
