import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { csrfSigningKey } from './crypto.js';

// ── §13.1 / §13.2 — headers and CSRF ─────────────────────
//
// Hand-rolled rather than pulled from helmet, for the same reason the rest of
// this app has two dependencies: every header here is one the spec names, and
// the list is short enough to read in full.

// ── Cookies ──────────────────────────────────────────────
// Ten lines instead of a dependency. Express 4 has no cookie parser built in.
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed */ }
  }
  return out;
}

export function cookies(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

// ── §13.1 — headers ──────────────────────────────────────
export function headers(req, res, next) {
  // A nonce per response. Anything inline must carry it, which is the whole
  // point: an injected <script> cannot guess a fresh 128-bit value.
  res.locals.nonce = randomBytes(16).toString('base64');

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${res.locals.nonce}'`,
    `style-src 'self' 'nonce-${res.locals.nonce}'`,
    // data: is here for the inline SVG favicon. Covers are proxied through
    // /cover/:key.jpg precisely so that no third-party image host has to be
    // allowed — which also stops a cover request telling anyone what someone
    // is reading.
    "img-src 'self' data: blob:",
    // Fonts are self-hosted. Google Fonts would mean 'style-src
    // https://fonts.googleapis.com' plus a font host, and would hand a third
    // party the IP address of every reader on every page load.
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests'
  ].join('; ');

  // §13.1 — Report-Only first, then enforce. The spec sequences it that way
  // (collect violations for a week) and §18 makes enforcing the last step of
  // the build, so the default here is the honest one. MARGIN_CSP=enforce
  // flips it, and the test suite runs with it flipped.
  const enforce = process.env.MARGIN_CSP === 'enforce';
  res.set(
    enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    `${csp}; report-uri /csp-report`
  );

  // HSTS is only meaningful over TLS, and setting it on a plain-HTTP dev
  // server would be cargo cult. Two years, subdomains, preload — as §13.1.
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Frame-Options', 'DENY');
  // Express advertises itself by default. Nothing needs to know.
  res.removeHeader('X-Powered-By');

  next();
}

// ── §10 — search indexing ────────────────────────────────
// `search_indexable` defaults to false, and "public but not indexable" is a
// legitimate state that Goodreads conflates with private. Anything not
// explicitly marked indexable gets the header.
export function noindex(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
}

// ── §13.2 — CSRF ─────────────────────────────────────────
//
// Double-submit, signed. The cookie holds a random value; the form holds an
// HMAC of it under a server secret. An attacker on another origin can neither
// read the cookie nor forge the signature.
//
// SameSite=Lax on the session cookie is a second layer, not a replacement:
// it does not cover top-level POST navigation in every browser, and it does
// nothing at all if a same-site subdomain is compromised.

const CSRF_COOKIE = 'margin_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const secret = () =>
  process.env.MARGIN_CSRF_SECRET || process.env.MARGIN_KEY || csrfSigningKey();

const sign = (value) => createHmac('sha256', secret()).update(value).digest('base64url');

export function csrf(req, res, next) {
  let seed = req.cookies?.[CSRF_COOKIE];

  if (!seed || !/^[A-Za-z0-9_-]{22,}$/.test(seed)) {
    seed = randomBytes(18).toString('base64url');
    res.cookie(CSRF_COOKIE, seed, {
      httpOnly: false,          // the page has to read it for fetch() calls
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 3600_000
    });
    req.cookies = { ...req.cookies, [CSRF_COOKIE]: seed };
  }

  // Available to every template as `csrfToken`, and to scripts via a meta tag.
  res.locals.csrfToken = sign(seed);

  if (SAFE.has(req.method)) return next();

  // Browsers cannot attach a CSRF token to a CSP report. The handler caps
  // its stored diagnostics and rate limits reports.
  if (req.path === '/csp-report') return next();

  // A multipart body is not parsed by express.urlencoded, so `req.body` is
  // empty for a file upload and a token in the form fields is invisible
  // here. Rather than letting those routes verify for themselves — an
  // opt-out that is one forgotten line away from being no check at all —
  // multipart forms put the token in the query string, where this sees it.
  const supplied =
    req.body?._csrf ||
    req.get('x-csrf-token') ||
    req.query?._csrf;

  const expected = sign(seed);
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403);
    return res.format({
      html: () => res.render('error', {
        title: 'Expired',
        heading: 'That form expired.',
        detail: 'Go back, reload the page, and try once more.'
      }),
      json: () => res.json({ error: 'CSRF token missing or invalid' }),
      default: () => res.send('CSRF token missing or invalid')
    });
  }

  next();
}

// ── §13.3 — input validation at the boundary ─────────────
//
// The spec names Zod. A schema validator is a dependency; what it is FOR is
// the two properties below, and those are small enough to implement:
//
//   - unknown fields are rejected, not ignored, so mass-assignment cannot
//     reach a column like `is_staff` by being posted at it
//   - every field is checked against a declared shape before use
export function fields(spec) {
  return (req, res, next) => {
    const body = req.body || {};
    const out = {};

    for (const key of Object.keys(body)) {
      // The CSRF token is framework plumbing, not a field of the form.
      if (key === '_csrf') continue;
      if (!(key in spec)) {
        return res.status(400).json({ error: `unexpected field: ${key}` });
      }
    }

    for (const [key, rule] of Object.entries(spec)) {
      const raw = body[key];

      if (raw == null || raw === '') {
        if (rule.required) return res.status(400).json({ error: `${key} is required` });
        out[key] = rule.default ?? null;
        continue;
      }

      let value = String(raw);
      if (rule.trim !== false) value = value.trim();
      if (rule.max && value.length > rule.max) {
        return res.status(400).json({ error: `${key} is too long` });
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        return res.status(400).json({ error: `${key} is not valid` });
      }
      if (rule.enum && !rule.enum.includes(value)) {
        return res.status(400).json({ error: `${key} is not valid` });
      }
      if (rule.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) return res.status(400).json({ error: `${key} is not a number` });
        value = n;
      }
      if (rule.type === 'boolean') value = value === 'on' || value === 'true' || value === '1';

      out[key] = value;
    }

    req.valid = out;
    next();
  };
}

// §13.3 — "validate sort columns against an allowlist". String interpolation
// into ORDER BY is the one place a parameterised query cannot help.
export const allowlist = (value, allowed, fallback) =>
  allowed.includes(String(value)) ? String(value) : fallback;
