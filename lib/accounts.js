import { randomUUID } from 'node:crypto';
import { get, all, run, sqlTime, nowSQL } from '../db/index.js';
import { hashEmailForBan } from './crypto.js';

// ── §9 — usernames ───────────────────────────────────────

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_]{1,18})[a-z0-9]$/;

// Anything that is, or could become, a route. A username that shadows a path
// is not merely confusing — `/@settings` next to `/settings` is a phishing
// primitive.
export const RESERVED = new Set([
  'admin', 'administrator', 'api', 'settings', 'signin', 'signout', 'login',
  'logout', 'signup', 'register', 'about', 'help', 'support', 'staff',
  'desk', 'shelf', 'shelves', 'wall', 'gap', 'book', 'books', 'work',
  'works', 'edition', 'editions', 'person', 'people', 'search', 'terms',
  'privacy', 'security', 'legal', 'contact', 'reading', 'export', 'import',
  'verify', 'reset', 'cover', 'covers', 'capture', 'scan', 'add', 'root',
  'me', 'you', 'user', 'users', 'account', 'accounts', 'margin', 'null',
  'undefined', 'system', 'moderator', 'mod', 'official', 'well-known',
  '.well-known', 'robots.txt', 'sitemap.xml', 'favicon.ico', 'static',
  'assets', 'public', 'css', 'js', 'img', 'images'
]);

// §9 — "normalise confusables when checking uniqueness, to block homograph
// impersonation". Without this, `аlice` with a Cyrillic а is a different
// string from `alice` and renders identically in every font on earth.
const CONFUSABLES = new Map(Object.entries({
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i',
  ј: 'j', һ: 'h', ԁ: 'd', ɡ: 'g', ν: 'v', κ: 'k', ρ: 'p', τ: 't', ο: 'o',
  α: 'a', ϲ: 'c', ｅ: 'e', ｏ: 'o', '０': '0', '１': '1', 'ⅰ': 'i', 'ⅼ': 'l',
  'ᴏ': 'o', 'ʟ': 'l', 'ɪ': 'i', 'ʀ': 'r', 'ɴ': 'n', 'ᴀ': 'a'
}));

/** The form uniqueness is checked against — never the form displayed. */
export function skeleton(username) {
  return String(username)
    .normalize('NFKC')
    .toLowerCase()
    .split('')
    .map((c) => CONFUSABLES.get(c) ?? c)
    .join('')
    // A digit 0 and a letter o are the same to a reader glancing at a URL.
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/_/g, '');
}

export function validateUsername(username) {
  const u = String(username ?? '').trim().toLowerCase();

  if (u.length < 3 || u.length > 20) return { ok: false, error: 'Three to twenty characters.' };
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: 'Letters, numbers and underscores. Not starting or ending with one.' };
  }
  if (RESERVED.has(u)) return { ok: false, error: 'That username is taken.' };

  const skel = skeleton(u);

  // A confusable of a reserved name is a reserved name.
  for (const r of RESERVED) {
    if (skeleton(r) === skel) return { ok: false, error: 'That username is taken.' };
  }

  return { ok: true, username: u, skeleton: skel };
}

/**
 * Is this username free? Checks live accounts, the reservation table (§9 —
 * held 90 days after a change so a freed URL cannot be grabbed for
 * impersonation), and the confusable skeletons of both.
 */
export function usernameAvailable(username, { forUserId = null } = {}) {
  const v = validateUsername(username);
  if (!v.ok) return v;

  // "Not mine" has to mean NOT MINE, and null is nobody's. Comparing with
  // Number() made Number(null) === Number(null) true, so a reservation left
  // behind by a purge looked like the caller's own and stopped blocking —
  // a deleted account's username became immediately re-registrable, which is
  // the impersonation window §9 holds it for 90 days to close.
  const mine = (ownerId) =>
    ownerId != null && forUserId != null && Number(ownerId) === Number(forUserId);

  const taken = all(
    'SELECT id, username FROM users WHERE username IS NOT NULL AND is_tombstone = 0'
  ).find((r) => skeleton(r.username) === v.skeleton && !mine(r.id));
  if (taken) return { ok: false, error: 'That username is taken.' };

  const held = all(
    `SELECT username, user_id FROM username_reservations WHERE release_at > ?`, nowSQL()
  ).find((r) => skeleton(r.username) === v.skeleton && !mine(r.user_id));
  if (held) return { ok: false, error: 'That username is taken.' };

  return v;
}

const DAY = 86_400_000;

export function setUsername(userId, username) {
  const user = get('SELECT * FROM users WHERE id = ?', Number(userId));
  if (!user) return { ok: false, error: 'No such account.' };

  // §9 — at most once every 30 days.
  if (user.username_changed_at) {
    const since = Date.now() - Date.parse(user.username_changed_at);
    if (since < 30 * DAY) {
      const days = Math.ceil((30 * DAY - since) / DAY);
      return { ok: false, error: `You can change your username again in ${days} days.` };
    }
  }

  const v = usernameAvailable(username, { forUserId: userId });
  if (!v.ok) return v;

  // The old name is held rather than released, for 90 days.
  if (user.username && user.username !== v.username) {
    run(
      `INSERT OR REPLACE INTO username_reservations (username, user_id, release_at)
       VALUES (?, ?, ?)`,
      user.username, Number(userId), sqlTime(Date.now() + 90 * DAY)
    );
  }

  run(
    `UPDATE users SET username = ?, username_changed_at = ?, updated_at = datetime('now')
      WHERE id = ?`,
    v.username, user.username ? nowSQL() : null, Number(userId)
  );

  return { ok: true, username: v.username };
}

// ── §4 — email ───────────────────────────────────────────
// Normalised by trimming and lowercasing, and by nothing else. Stripping
// Gmail dots or plus-addressing is a common "cleanup" that silently merges
// two people's accounts and breaks a legitimate and widely used feature.
export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

// Deliberately not an RFC 5322 grammar. That grammar admits addresses no
// mail system will accept, and the real check is the verification mail.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function validateEmail(email) {
  const e = normaliseEmail(email);
  if (!e || e.length > 254) return { ok: false, error: "That address doesn't look right." };
  if (!EMAIL_RE.test(e)) return { ok: false, error: "That address doesn't look right." };
  const [local] = e.split('@');
  if (local.length > 64) return { ok: false, error: "That address doesn't look right." };
  return { ok: true, email: e };
}

export const findByEmail = (email) =>
  get(
    'SELECT * FROM users WHERE email = ? AND is_tombstone = 0 AND deleted_at IS NULL',
    normaliseEmail(email)
  );

export const findByUsername = (username) => {
  const skel = skeleton(username);
  return all(
    'SELECT * FROM users WHERE username IS NOT NULL AND is_tombstone = 0'
  ).find((u) => skeleton(u.username) === skel) || null;
};

/** §5 — login accepts either. */
export const findByIdentifier = (identifier) => {
  const id = String(identifier ?? '').trim();
  return id.includes('@') ? findByEmail(id) : findByUsername(id);
};

export const findByPublicId = (publicId) =>
  get('SELECT * FROM users WHERE public_id = ? AND is_tombstone = 0', String(publicId));

// ── Creation ─────────────────────────────────────────────
export function createUser({ email, passwordHash }) {
  const publicId = randomUUID();
  // A handle is required by the pre-accounts schema and is not user-facing
  // any more; the username, chosen after verification, is what people see.
  const handle = `u${publicId.slice(0, 12)}`;

  // A NEW ACCOUNT IS PUBLIC.
  //
  // It was private, and private-by-default quietly cost this product the
  // thing it is for. Every shelf, entry and review defaults to 'inherit',
  // so a private account made the ENTIRE library private, and a reader had
  // to find a settings page and opt in before another person could see a
  // single thing they had read. Nobody does that on the way in, so the
  // house was empty by construction: /readers had nobody in it, the feed
  // said NOTHING THIS WEEK for everybody, and clubs had no one to join.
  //
  // §15's protection is NOT lost — it moves to where it does its actual
  // work. What makes a throwaway impersonation account worthless is being
  // undiscoverable, not being unviewable, so the age-and-history gate now
  // governs LISTING (see visibility.isEstablished) rather than viewing. An
  // impersonator still gets no distribution: no /readers, no search, no
  // index. What changes is that a real reader is visible to a friend they
  // send the link to on their first day.
  //
  // search_indexable stays 0. "Public but not indexable" is a distinct and
  // deliberate state — being findable by other readers here is what serves
  // community; being crawled by Google is a different decision, about the
  // open internet, and it stays the reader's to make.
  run(
    `INSERT INTO users (handle, public_id, email, password_hash, email_hash,
                        profile_visibility, search_indexable, updated_at)
     VALUES (?, ?, ?, ?, ?, 'public', 0, datetime('now'))`,
    handle, publicId, normaliseEmail(email), passwordHash, hashEmailForBan(email)
  );

  return get('SELECT * FROM users WHERE public_id = ?', publicId);
}

export function markVerified(userId) {
  run(
    `UPDATE users SET email_verified_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND email_verified_at IS NULL`,
    Number(userId)
  );
}

export function touchSeen(userId) {
  run(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`, Number(userId));
}

/** §15 — the counter that gates making a profile public. */
export function recountBooks(userId) {
  const n = get(
    'SELECT COUNT(DISTINCT work_id) n FROM readings WHERE user_id = ?',
    Number(userId)
  ).n;
  run('UPDATE users SET books_logged = ? WHERE id = ?', n, Number(userId));
  return n;
}

// ── §9 — profile fields ──────────────────────────────────
// "Nothing else. Resist the pull toward Goodreads-style profile sprawl."
export const BIO_MAX = 280;

export function updateProfile(userId, { displayName, bio, location, link }) {
  const clean = (s, max) =>
    s == null ? null : String(s).replace(/[ -]/g, ' ').trim().slice(0, max) || null;

  let url = null;
  if (link) {
    try {
      const u = new URL(String(link).trim());
      // Only http(s). A `javascript:` or `data:` href in a profile is stored
      // XSS waiting for one template to render it unescaped.
      if (u.protocol === 'http:' || u.protocol === 'https:') url = u.toString().slice(0, 300);
    } catch { url = null; }
  }

  run(
    `UPDATE users SET display_name = ?, bio = ?, location = ?, link = ?,
                      updated_at = datetime('now')
      WHERE id = ?`,
    clean(displayName, 60), clean(bio, BIO_MAX), clean(location, 60), url, Number(userId)
  );

  return get('SELECT * FROM users WHERE id = ?', Number(userId));
}

// ── THE STATEMENT ────────────────────────────────────────
//
// Up to four books, chosen by hand, presented at plate size.
//
// THE STATEMENT is gone, and with it profile_pins, MAX_PINS, pin(),
// unpin() and pinsFor(). It was a second, parallel list of favourite books
// that a reader had to curate to satisfy a distinction the product invented
// — "a shelf is a filing decision, a pin is a statement" — and the table
// held zero rows, which is the answer to that argument. The profile shows
// the Favourites shelf they already keep. See routes/profile.js.

/** Opt in, never on by surprise. */
export const setTastePublic = (userId, on) =>
  run('UPDATE users SET taste_public = ? WHERE id = ?', on ? 1 : 0, Number(userId));
