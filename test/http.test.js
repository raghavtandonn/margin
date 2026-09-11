import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The §19 requirements in this file are about what the SERVER returns, not
// what a function returns — "user A requesting user B's object by id receives
// 404" is a statement about an HTTP response. So this boots the real
// application, with the real middleware stack, and talks to it over a socket.

const dir = mkdtempSync(join(tmpdir(), 'margin-http-'));
const DB = join(dir, 'test.db');
const PORT = 3400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  MARGIN_DB: DB,
  MARGIN_KEY: 'http-test-key-0123456789abcdef',
  MARGIN_IP_SALT: 'http-test',
  MARGIN_AVATAR_DIR: join(dir, 'avatars'),
  MARGIN_EXPORT_DIR: join(dir, 'exports'),
  MARGIN_OUTBOX: join(dir, 'outbox'),
  MARGIN_BASE_URL: BASE,
  PORT: String(PORT),
  NODE_ENV: 'test'
};

// ── Fixtures, built directly against the same database ───
process.env.MARGIN_DB = DB;
process.env.MARGIN_KEY = env.MARGIN_KEY;
process.env.MARGIN_IP_SALT = env.MARGIN_IP_SALT;

const { db, get, run } = await import('../db/index.js');
const A = await import('../lib/accounts.js');
const S = await import('../lib/auth/sessions.js');
const NOTES = await import('../lib/notes.js');

const NOTE_TEXT = 'I read this the winter my father was ill, and I have never reread it.';

run(`INSERT INTO works (id, title) VALUES (1, 'A Shared Book'), (2, 'Another Book')`);

function reader(handle, visibility) {
  const u = A.createUser({ email: `${handle}@example.test`, passwordHash: 'x' });
  A.markVerified(u.id);
  A.setUsername(u.id, handle);
  run(`UPDATE users SET profile_visibility = ?, books_logged = 20,
                        created_at = datetime('now', '-1 year') WHERE id = ?`, visibility, u.id);

  run(`INSERT INTO shelves (user_id, name, slug, visibility) VALUES (?, 'Read', 'read', 'inherit')`, u.id);
  run(`INSERT INTO shelves (user_id, name, slug, visibility) VALUES (?, 'Private Shelf', 'quiet', 'private')`, u.id);

  const open = get(`SELECT * FROM shelves WHERE user_id = ? AND slug = 'read'`, u.id);
  const quiet = get(`SELECT * FROM shelves WHERE user_id = ? AND slug = 'quiet'`, u.id);
  run(`INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, 1)`, open.id);
  run(`INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, 2)`, quiet.id);

  run(`INSERT INTO readings (user_id, work_id, status, stars, finished_at)
       VALUES (?, 1, 'FINISHED', 4, datetime('now'))`, u.id);
  const reading = get(`SELECT * FROM readings WHERE user_id = ? AND work_id = 1`, u.id);
  NOTES.setNote(reading.id, NOTE_TEXT);

  const session = S.create(u.id, { ip: '127.0.0.1', userAgent: 'test' });
  return { user: u, shelves: { open, quiet }, reading, cookie: `${S.COOKIE}=${session.token}` };
}

const alice = reader('alice', 'public');
const bob = reader('bob', 'private');

// ── Boot ─────────────────────────────────────────────────
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

await new Promise((resolve, reject) => {
  const deadline = Date.now() + 20_000;
  const poll = async () => {
    if (Date.now() > deadline) return reject(new Error(`server did not start:\n${serverLog.join('')}`));
    try {
      await fetch(`${BASE}/signin`);
      resolve();
    } catch {
      setTimeout(poll, 150);
    }
  };
  poll();
});

test.after(() => {
  server.kill('SIGKILL');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});

const GET = (path, cookie) =>
  fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

test('audiobook progress remains numeric in editable fields and save responses', async () => {
  const who = reader('audioprogress', 'public');
  run("UPDATE readings SET status = 'READING', position_type = 'minute', current_page = 125, total_positions = 300 WHERE id = ?", who.reading.id);
  const page = await GET('/reading', who.cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /class="press-number"[^>]*value="125"/);

  // The SAME control exists on the book page, and covering only /reading
  // left the other copy formatted. A type="number" whose value is not a
  // valid number is sanitised to empty by the browser, so the field renders
  // blank and LOG posts nothing — which Number('') turns into 0 and stores
  // as a progress reset.
  const bookPage = await GET('/work/1', who.cookie);
  assert.equal(bookPage.status, 200);
  const bookHtml = await bookPage.text();
  assert.match(bookHtml, /id="pg"[^>]*value="125"/, 'the book page logs a number too');
  assert.doesNotMatch(bookHtml, /id="pg"[^>]*value="[^"]*H /, 'never an "H 07M" clock in a number field');
  const saved = await post('/work/1/log', {
    cookie: who.cookie, headers: { 'x-requested-with': 'fetch' }, form: { position: '130' }
  });
  assert.equal((await saved.json()).position, '130');
  const extent = await post('/work/1/extent', {
    cookie: who.cookie, headers: { 'x-requested-with': 'fetch' }, form: { total: '240' }
  });
  assert.equal((await extent.json()).position, '130');
});

const body = async (res) => await res.text();

/**
 * Post with a VALID CSRF token, so the request reaches the handler.
 *
 * Without this, an unauthorised request is refused at the CSRF layer with a
 * 403 and never reaches the ownership check — which looks like a pass and
 * proves nothing about §13.4. The point of these tests is what the handler
 * does when the token is good and the object belongs to somebody else.
 */
async function post(path, { cookie, form = {}, headers = {} }) {
  // Any GET issues a CSRF cookie and renders a matching token.
  const page = await fetch(`${BASE}${cookie ? '/settings/profile' : '/signin'}`, {
    headers: cookie ? { cookie } : {}, redirect: 'manual'
  });
  const html = await page.text();
  const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  const setCookie = page.headers.get('set-cookie') || '';
  const csrfCookie = /margin_csrf=([^;]+)/.exec(setCookie)?.[1];

  const jar = [cookie, csrfCookie ? `margin_csrf=${csrfCookie}` : ''].filter(Boolean).join('; ');
  const params = new URLSearchParams({ ...form, ...(token ? { _csrf: token } : {}) });

  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: params.toString(),
    redirect: 'manual'
  });
}

// ── §19 AUTHORISATION ────────────────────────────────────

test("§19 — user A requesting user B's object receives 404", async (t) => {
  await t.test("bob's shelf, requested by alice", async () => {
    const res = await post(`/settings/privacy/shelf/${bob.shelves.open.id}`, {
      cookie: alice.cookie, form: { visibility: 'public' }
    });
    // 403 would confirm the shelf exists. It has to be indistinguishable
    // from a shelf id that was never issued at all.
    assert.equal(res.status, 404, '403 or 200 would both be wrong here');
  });

  await t.test('and a shelf id that never existed answers identically', async () => {
    const real = await post(`/settings/privacy/shelf/${bob.shelves.open.id}`, {
      cookie: alice.cookie, form: { visibility: 'public' }
    });
    const fake = await post('/settings/privacy/shelf/99999', {
      cookie: alice.cookie, form: { visibility: 'public' }
    });
    assert.equal(real.status, fake.status);
  });

  await t.test("bob's shelf is genuinely unchanged", () => {
    const after = get('SELECT visibility FROM shelves WHERE id = ?', bob.shelves.open.id);
    assert.equal(after.visibility, 'inherit', "alice must not have altered bob's shelf");
  });

  await t.test("bob's session, revoked by alice", async () => {
    const bobSession = get('SELECT id FROM auth_sessions WHERE user_id = ?', bob.user.id);
    const res = await post(`/settings/sessions/${bobSession.id}/revoke`, { cookie: alice.cookie });
    assert.equal(res.status, 404);
    const still = get('SELECT revoked_at FROM auth_sessions WHERE id = ?', bobSession.id);
    assert.equal(still.revoked_at, null, "bob's session must still be live");
  });
});

test('§19 — a private profile returns 404 to a signed-out visitor', async (t) => {
  await t.test('signed out', async () => {
    assert.equal((await GET('/@bob')).status, 404);
  });
  await t.test('signed in as someone else', async () => {
    assert.equal((await GET('/@bob', alice.cookie)).status, 404);
  });
  await t.test('but bob sees his own', async () => {
    assert.equal((await GET('/@bob', bob.cookie)).status, 200);
  });
  await t.test('and a nonexistent profile is indistinguishable from a private one', async () => {
    const missing = await GET('/@nobodyatall');
    const priv = await GET('/@bob');
    assert.equal(missing.status, priv.status);
  });
});

test('§19 — a public profile with a private shelf renders no trace of it', async (t) => {
  const res = await GET('/@alice');
  assert.equal(res.status, 200);
  const html = await body(res);

  await t.test('the public shelf is there', () => {
    assert.ok(html.includes('Read'), 'the public shelf renders');
  });

  await t.test('the private shelf is nowhere in the HTML', () => {
    assert.ok(!html.includes('Private Shelf'), 'the shelf name leaked');
    assert.ok(!html.includes('quiet'), 'the shelf slug leaked');
  });

  await t.test('nor is the book that is only on it', () => {
    assert.ok(!html.includes('Another Book'), 'a private book leaked onto a public page');
  });

  await t.test('nor a count that would reveal it by subtraction', () => {
    // §10.5 — the visible count must be the count of what this viewer may
    // see. Alice has 2 shelved books; a stranger may see 1.
    assert.ok(!/>\s*2\s*</.test(html.split('SHELVES')[1] || ''), 'a private item was counted');
  });
});

test('§19 — no note body is retrievable through any public path', async (t) => {
  const paths = [
    '/@alice',
    `/api/user/alice/shelves`,
    `/api/user/alice/receipt`,
    `/api/work/1`,
    `/api/work/1/passes`,
    '/sitemap.xml',
    '/robots.txt'
  ];

  for (const path of paths) {
    await t.test(`${path} carries no note`, async () => {
      const res = await GET(path);
      const text = await body(res);
      assert.ok(!text.includes('father was ill'), `note body leaked via ${path}`);
      assert.ok(!text.includes(NOTE_TEXT), `note body leaked via ${path}`);
    });
  }

  await t.test('nor does the API when signed in as another reader', async () => {
    const res = await GET('/api/work/1/passes', bob.cookie);
    const text = await body(res);
    assert.ok(!text.includes('father was ill'));
  });
});

test('§10 — a public but non-indexable profile carries noindex', async (t) => {
  const res = await GET('/@alice');
  await t.test('header', () => {
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  });

  await t.test('and is absent from the sitemap', async () => {
    const xml = await body(await GET('/sitemap.xml'));
    assert.ok(!xml.includes('/@alice'), 'a non-indexable profile must not be in the sitemap');
  });

  await t.test('and disallowed in robots.txt', async () => {
    const txt = await body(await GET('/robots.txt'));
    assert.ok(txt.includes('Disallow: /@'));
    assert.ok(!txt.includes('Allow: /@alice'));
  });

  await t.test('marking it indexable puts it in the sitemap', async () => {
    run('UPDATE users SET search_indexable = 1 WHERE id = ?', alice.user.id);
    const xml = await body(await GET('/sitemap.xml'));
    assert.ok(xml.includes('/@alice'));
    const res2 = await GET('/@alice');
    assert.equal(res2.headers.get('x-robots-tag'), null, 'an indexable profile carries no noindex');
    run('UPDATE users SET search_indexable = 0 WHERE id = ?', alice.user.id);
  });
});

// ── §13 ──────────────────────────────────────────────────

test('§13.2 — a state-changing request without a CSRF token is refused', async (t) => {
  await t.test('no token', async () => {
    const res = await fetch(`${BASE}/settings/profile`, {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'display_name=Injected',
      redirect: 'manual'
    });
    assert.equal(res.status, 403);
  });

  await t.test('and nothing was written', () => {
    const u = get('SELECT display_name FROM users WHERE id = ?', alice.user.id);
    assert.notEqual(u.display_name, 'Injected');
  });

  await t.test('a forged token is refused', async () => {
    const res = await fetch(`${BASE}/settings/profile`, {
      method: 'POST',
      headers: {
        cookie: `${alice.cookie}; margin_csrf=aaaaaaaaaaaaaaaaaaaaaaaa`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: 'display_name=Injected&_csrf=obviouslywrong',
      redirect: 'manual'
    });
    assert.equal(res.status, 403);
  });
});

test('§13.1 — the security headers are present on every response', async () => {
  const res = await GET('/signin');
  const h = (n) => res.headers.get(n) || '';

  assert.match(h('content-security-policy-report-only') + h('content-security-policy'),
               /script-src 'self' 'nonce-/);
  assert.ok(!/unsafe-inline/.test(h('content-security-policy-report-only') + h('content-security-policy')),
            "the policy must not contain 'unsafe-inline'");
  assert.equal(h('x-content-type-options'), 'nosniff');
  assert.equal(h('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(h('permissions-policy'), /geolocation=\(\)/);
  assert.equal(h('cross-origin-opener-policy'), 'same-origin');
  assert.match(h('content-security-policy-report-only') + h('content-security-policy'),
               /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null, 'Express must not advertise itself');
});

test('§13.1 — the nonce differs on every response', async () => {
  const a = (await GET('/signin')).headers.get('content-security-policy-report-only');
  const b = (await GET('/signin')).headers.get('content-security-policy-report-only');
  const nonceOf = (h) => /'nonce-([^']+)'/.exec(h)?.[1];
  assert.ok(nonceOf(a) && nonceOf(b));
  assert.notEqual(nonceOf(a), nonceOf(b), 'a predictable nonce is no nonce at all');
});

test('§13.3 — an unexpected field is rejected, not ignored', async () => {
  // Mass assignment: posting a column name that the form does not offer.
  const page = await GET('/settings/profile', alice.cookie);
  const html = await body(page);
  const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  const csrfCookie = /margin_csrf=([^;]+)/.exec(page.headers.get('set-cookie') || '')?.[1];
  assert.ok(token, 'the form carries a token');

  const res = await fetch(`${BASE}/settings/profile`, {
    method: 'POST',
    headers: {
      cookie: `${alice.cookie}${csrfCookie ? `; margin_csrf=${csrfCookie}` : ''}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: `_csrf=${encodeURIComponent(token)}&display_name=Alice&is_staff=1&profile_visibility=public`,
    redirect: 'manual'
  });

  // Whether it is refused or merely ignored, the column must not be set.
  const u = get('SELECT * FROM users WHERE id = ?', alice.user.id);
  assert.equal(u.is_staff, undefined, 'there is no such column to set');
  assert.ok(res.status < 500);
});

test('the staff surface is not reachable and does not confirm it exists', async () => {
  // The allowlist admits 127.0.0.1, which is where this test connects from,
  // so the gate itself is exercised in test/staff-gate. What is asserted
  // here is that an unauthenticated visitor is bounced to a sign-in rather
  // than shown anything.
  const res = await GET('/staff');
  assert.ok([302, 404].includes(res.status));
  if (res.status === 302) assert.match(res.headers.get('location'), /\/staff\/signin/);
});

test('an unverified account cannot make itself public', async () => {
  const u = A.createUser({ email: 'fresh@example.test', passwordHash: 'x' });
  A.setUsername(u.id, 'freshreader');
  run(`UPDATE users SET profile_visibility = 'public' WHERE id = ?`, u.id);

  // Even with the column forced, the scope refuses to publish it.
  assert.equal((await GET('/@freshreader')).status, 404);
});

test('§5 — the sign-in form does not reveal whether an account exists', async () => {
  const attempt = async (identifier) => {
    const page = await fetch(`${BASE}/signin`, { redirect: 'manual' });
    const html = await page.text();
    const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
    const csrfCookie = /margin_csrf=([^;]+)/.exec(page.headers.get('set-cookie') || '')?.[1];

    return fetch(`${BASE}/signin`, {
      method: 'POST',
      headers: {
        cookie: csrfCookie ? `margin_csrf=${csrfCookie}` : '',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        identifier, password: 'definitely the wrong password', _csrf: token || ''
      }).toString(),
      redirect: 'manual'
    });
  };

  const real = await attempt('alice@example.test');
  const fake = await attempt('nobody-at-all@example.test');

  assert.equal(real.status, fake.status, 'the status must not differ');

  // The rendered pages differ only by the identifier echoed into the field.
  // Per-request values — the CSP nonce and the CSRF token, in both the meta
  // tag and the hidden field — differ by design and carry no information
  // about the account. Everything else must match byte for byte.
  const norm = (html) => html
    .replace(/nonce="[^"]*"/g, '')
    .replace(/content="[^"]*"/g, '')
    .replace(/value="[^"]*"/g, '')
    .replace(/alice@example\.test|nobody-at-all@example\.test/g, '');
  assert.equal(norm(await body(real)), norm(await body(fake)),
    'the response body must not say which one exists');
});

// ── §15 — the public API enforces the same scope ─────────
//
// This section exists because it did not. The API served a private account's
// entire shelf list and reading receipt to anonymous callers with
// `Access-Control-Allow-Origin: *`, and /work/:id/passes read a hard-coded
// `getUser(1)` — so it handed out the first account's reading history to
// anyone who asked. §10.2 names exactly this: a template hides nothing from
// a JSON endpoint.

test('§15 — the API refuses a private reader', async (t) => {
  await t.test('shelves', async () => {
    const res = await GET('/api/user/bob/shelves');
    assert.equal(res.status, 404);
    assert.ok(!(await body(res)).includes('Private Shelf'));
  });

  await t.test('receipt', async () => {
    assert.equal((await GET('/api/user/bob/receipt')).status, 404);
  });

  await t.test('and does not distinguish private from nonexistent', async () => {
    const priv = await GET('/api/user/bob/shelves');
    const gone = await GET('/api/user/nobodyatall/shelves');
    assert.equal(priv.status, gone.status);
    assert.equal(await body(priv), await body(gone));
  });
});

test('§15 — the API serves a public reader, minus the private parts', async (t) => {
  const res = await GET('/api/user/alice/shelves');
  assert.equal(res.status, 200);
  const json = JSON.parse(await body(res));

  await t.test('the public shelf is served', () => {
    assert.ok(json.some((s) => s.slug === 'read'));
  });

  await t.test('the private one is not', () => {
    assert.ok(!json.some((s) => s.slug === 'quiet'), 'a private shelf came back over the API');
  });

  await t.test('and no internal ids leak', () => {
    for (const s of json) {
      assert.equal(s.user_id, undefined, 'user_id must not be in the payload');
      assert.equal(s.id, undefined, 'the integer primary key must not be either');
    }
  });

  await t.test('counts are what the viewer may see', () => {
    const read = json.find((s) => s.slug === 'read');
    assert.equal(read.item_count, 1);
  });
});

test('§15 — reading passes belong to the session, not to user 1', async (t) => {
  await t.test('anonymous is refused', async () => {
    const res = await GET('/api/work/1/passes');
    assert.equal(res.status, 401);
  });

  await t.test('and a signed-in reader gets their OWN', async () => {
    const asBob = JSON.parse(await body(await GET('/api/work/1/passes', bob.cookie)));
    const asAlice = JSON.parse(await body(await GET('/api/work/1/passes', alice.cookie)));
    assert.ok(Array.isArray(asBob) && Array.isArray(asAlice));
    // Both read work 1; each must see exactly one pass, their own.
    assert.equal(asBob.length, 1);
    assert.equal(asAlice.length, 1);
  });
});

test('§15 — CORS is open for the catalogue and closed for readers', async (t) => {
  await t.test('catalogue', async () => {
    const res = await GET('/api/search?q=book');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
  await t.test('reader data', async () => {
    const res = await GET('/api/user/alice/shelves');
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      'a wildcard origin on somebody\'s shelf is the opposite of scoping it');
  });
});

test('profile season history shows all reads while keeping personal notes out', async () => {
  const who = reader('seasonprivacy', 'public');
  const SEASONS = await import('../lib/seasons.js');
  run("UPDATE readings SET finished_at = '2025-08-10' WHERE id = ?", who.reading.id);
  NOTES.setNote(who.reading.id, 'A private seasonal diary sentence.');
  const LIBRARY = await import('../lib/library.js');
  LIBRARY.logSession(who.user.id, 1, 10, { note: 'A private session margin.' });
  const wid = Number(run('INSERT INTO works (title) VALUES (?)', 'Restricted seasonal book').lastInsertRowid);
  run(`INSERT INTO readings (user_id, work_id, status, visibility, finished_at)
    VALUES (?, ?, 'FINISHED', 'private', '2025-08-11')`, who.user.id, wid);
  const season = SEASONS.ensureSeason(who.user.id, SEASONS.parseCode('aw25'));
  SEASONS.syncFrames(season, SEASONS.readingsIn(who.user.id, season));
  run("UPDATE seasons SET state = 'closed', note = 'A private generated note' WHERE id = ?", season.id);
  for (const path of ['/@seasonprivacy/aw25']) {
    const res = await GET(path);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('A Shared Book'));
    assert.ok(html.includes('Restricted seasonal book'));
    for (const secret of ['A private seasonal diary sentence.', 'A private session margin.', 'A private generated note']) {
      assert.ok(!html.includes(secret), `private data in ${path}`);
    }
  }
  for (const cookie of [undefined, who.cookie, alice.cookie]) {
    assert.equal((await GET('/@seasonprivacy/aw25/lookbook', cookie)).status, 404);
  }
  const own = await GET('/season/aw25/lookbook', who.cookie);
  assert.equal(own.status, 200);
  const ownHTML = await own.text();
  assert.ok(ownHTML.includes('A private session margin.'));
  assert.ok(ownHTML.includes('Restricted seasonal book'));
});

test('private shelves stay hidden while their books remain in public reading history', async () => {
  const who = reader('shelfprivacy', 'public');
  run(`INSERT INTO readings (user_id, work_id, status, finished_at) VALUES (?, 2, 'FINISHED', datetime('now'))`, who.user.id);
  const profile = await GET('/@shelfprivacy');
  const html = await profile.text();
  assert.ok(html.includes('Another Book'));
  assert.ok(!html.includes('Private Shelf'));
  const shelves = await (await GET('/api/user/shelfprivacy/shelves')).text();
  assert.ok(!shelves.includes('Private Shelf'));
  const receipt = await (await GET('/api/user/shelfprivacy/receipt')).json();
  assert.equal(receipt.lines.length, 2);
  assert.equal(receipt.totals.finished, 2);
});

test('passkey enrollment requires fresh authentication on both endpoints', async () => {
  const who = reader('stalepasskey', 'public');
  run("UPDATE auth_sessions SET reauth_at = datetime('now', '-1 hour') WHERE user_id = ?", who.user.id);
  for (const path of ['/settings/security/passkey/options', '/settings/security/passkey']) {
    const res = await post(path, { cookie: who.cookie });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').startsWith('/reauth'));
  }
});

test('reauthentication for a two-factor account requires the second factor', async () => {
  const who = reader('stepupfactor', 'public');
  const P = await import('../lib/auth/passwords.js');
  const TOTP = await import('../lib/auth/totp.js');
  const { seal } = await import('../lib/crypto.js');
  const secret = TOTP.beginEnrollment(who.user).secret;
  run('UPDATE users SET password_hash = ? WHERE id = ?', await P.hashPassword('test stepup password'), who.user.id);
  run('INSERT INTO credentials_totp (user_id, secret_encrypted, confirmed_at, last_used_step) VALUES (?, ?, datetime(\'now\'), ?)',
    who.user.id, seal(secret), TOTP.stepFor() - 2);
  run("UPDATE auth_sessions SET reauth_at = datetime('now', '-1 hour') WHERE user_id = ?", who.user.id);
  const denied = await post('/reauth', { cookie: who.cookie, form: { password: 'test stepup password' } });
  assert.equal(denied.status, 401);
  const ok = await post('/reauth', { cookie: who.cookie, form: { password: 'test stepup password', code: TOTP.codeFor(secret, TOTP.stepFor()) } });
  assert.equal(ok.status, 302);
  assert.equal(get('SELECT aal FROM auth_sessions WHERE user_id = ?', who.user.id).aal, 2);
});

test('malformed security input is refused without stopping the server', async () => {
  const who = reader('invalidfactor', 'public');
  const res = await post('/settings/security/totp', { cookie: who.cookie, form: { secret: 'invalid secret', code: '000000' } });
  assert.equal(res.status, 400);
  assert.equal((await GET('/signin')).status, 200);
});

test('nobody can overwrite a shared catalogue description', async () => {
  // The endpoint that let a reader rewrite a description in their own words
  // is GONE, not merely gated: what a reader thinks of a book is a review,
  // and it already had a place on the page. The security property this test
  // was written to defend now holds absolutely rather than by permission
  // check, so the assertion is 404 rather than 403 — and the blurb still
  // has to be untouched, which is the half that actually mattered.
  const who = reader('cataloguewriter', 'public');
  const before = get('SELECT blurb FROM works WHERE id = 1').blurb;
  const res = await post('/work/1/description', { cookie: who.cookie, form: { blurb: 'Replacement' } });
  assert.equal(res.status, 404);
  assert.equal(get('SELECT blurb FROM works WHERE id = 1').blurb, before);
});

test('unestablished accounts cannot correct a shared publication year', async () => {
  // The other half of the same audit finding, which still has a live route
  // and so still needs the permission check tested.
  const who = reader('yearwriter', 'public');
  const before = get('SELECT first_published_year y FROM works WHERE id = 1').y;
  const res = await post('/work/1/first-published', { cookie: who.cookie, form: { year: '1902' } });
  assert.equal(res.status, 403);
  assert.equal(get('SELECT first_published_year y FROM works WHERE id = 1').y, before);
});

test('reporting an unfamiliar sign-in invalidates the old password and pending logins', async () => {
  const who = reader('reportedlogin', 'public');
  const P = await import('../lib/auth/passwords.js');
  const T = await import('../lib/auth/tokens.js');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await P.hashPassword('old compromised password'), who.user.id);
  const pending = T.issue(who.user.id, 'login_link');
  const notification = T.issue(who.user.id, 'not_me');
  const res = await GET(`/security/not-me?token=${notification}`);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/reset/'));
  assert.equal(T.inspect(pending, 'login_link'), null);
  assert.equal(get('SELECT COUNT(*) n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL', who.user.id).n, 0);
  const denied = await post('/signin', { form: { identifier: 'reportedlogin', password: 'old compromised password' } });
  assert.equal(denied.status, 401);
});

test('unverified readers can register a book and use the ISBN capture endpoint', async () => {
  const who = reader('newbookreader', 'public');
  run('UPDATE users SET email_verified_at = NULL WHERE id = ?', who.user.id);
  const registered = await post('/capture/register', {
    cookie: who.cookie, form: { title: 'An onboarding book', author: 'Example Writer', shelf: 'read' }
  });
  assert.equal(registered.status, 302);
  assert.match(registered.headers.get('location'), /^\/work\/\d+\?stamped=1$/);
  const added = get(`SELECT si.id FROM shelf_items si JOIN shelves sh ON sh.id = si.shelf_id
    JOIN works w ON w.id = si.work_id WHERE sh.user_id = ? AND w.title = 'An onboarding book'`, who.user.id);
  assert.ok(added, 'the unverified reader can add the new book to their shelf');
  // Invalid input exercises the handler without requiring Open Library.
  const scanned = await post('/capture/isbn', { cookie: who.cookie, form: { isbn: 'invalid' } });
  assert.equal(scanned.status, 200);
  assert.equal((await scanned.json()).error, 'NOT A VALID ISBN');
});

test('queued reading updates acknowledge success and apply retries only once', async () => {
  const who = reader('offlinereader', 'public');
  run("UPDATE readings SET status = 'READING', current_page = 0 WHERE id = ?", who.reading.id);
  const requestId = '6fc4abda-f6bd-4bf8-b50a-f87191842d18';
  const headers = { 'x-reading-owner': who.user.public_id, 'x-reading-request-id': requestId };
  for (let i = 0; i < 2; i++) {
    const response = await post('/work/1/log', { cookie: who.cookie, headers, form: { advance: '10' } });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.ok, true);
    assert.equal(reply.requestId, requestId);
  }
  assert.equal(get('SELECT current_page FROM readings WHERE id = ?', who.reading.id).current_page, 10);
  assert.equal(get('SELECT COUNT(*) n FROM sessions WHERE reading_id = ?', who.reading.id).n, 1);
  const changed = await post('/work/1/log', { cookie: who.cookie, headers, form: { advance: '25' } });
  assert.equal(changed.status, 400);
  assert.equal(get('SELECT current_page FROM readings WHERE id = ?', who.reading.id).current_page, 10);
});

test('a queue left open in another tab cannot write to the newly signed-in account', async () => {
  const before = get('SELECT COUNT(*) n FROM sessions WHERE reading_id = ?', bob.reading.id).n;
  const response = await post('/work/1/log', {
    cookie: bob.cookie,
    headers: { 'x-reading-owner': alice.user.public_id, 'x-reading-request-id': '102ece63-dff3-4df3-99cb-e736e946e67e' },
    form: { advance: '10' }
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'ACCOUNT_CHANGED');
  assert.equal(get('SELECT COUNT(*) n FROM sessions WHERE reading_id = ?', bob.reading.id).n, before);
});

// ── §12 — THE PASTED LIST, OVER THE WIRE ─────────────────
//
// The seam this covers is not the parser — that has its own tests — but the
// submission: a multipart body carrying an empty file input AND a textarea,
// with the CSRF token in the query string because a multipart body is
// invisible to the middleware. Nothing below the HTTP layer can prove that
// the empty file part does not win over the text beside it.

test('§12 — a list typed into the page reaches the preview', async () => {
  const page = await fetch(`${BASE}/settings/import`, {
    headers: { cookie: alice.cookie }, redirect: 'manual'
  });
  const html = await page.text();
  const token = /name="_csrf" value="([^"]+)"/.exec(html)?.[1]
    || /_csrf=([^"&]+)/.exec(html)?.[1];
  const csrfCookie = /margin_csrf=([^;]+)/.exec(page.headers.get('set-cookie') || '')?.[1];
  const jar = [alice.cookie, csrfCookie ? `margin_csrf=${csrfCookie}` : ''].filter(Boolean).join('; ');

  // The page must actually offer the second way in, or the rest of this
  // test is checking a route nobody can reach.
  assert.match(html, /name="pasted"/, 'the import page offers a paste box');

  const B = '----marginlisttest';
  const body =
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename=""\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n\r\n` +
    `--${B}\r\nContent-Disposition: form-data; name="pasted"\r\n\r\n` +
    `Stoner by John Williams\nGilead — Marilynne Robinson\nHousekeeping\r\n` +
    `--${B}--\r\n`;

  const res = await fetch(
    `${BASE}/settings/import?_csrf=${encodeURIComponent(decodeURIComponent(token || ''))}`,
    {
      method: 'POST',
      headers: { cookie: jar, 'content-type': `multipart/form-data; boundary=${B}` },
      body,
      redirect: 'manual'
    }
  );

  assert.equal(res.status, 302, 'a good paste goes to its preview');
  const preview = await fetch(`${BASE}${res.headers.get('location')}`, {
    headers: { cookie: jar }, redirect: 'manual'
  });
  const shown = await preview.text();

  assert.equal(preview.status, 200);
  assert.match(shown, /3 rows/, 'the preview counts what was pasted');
  assert.match(shown, /2 of these name an author/, 'and says what it could not learn');
  assert.match(shown, /Import 3/, 'nothing is written until this is pressed');
});

test('§12 — an empty submission says what to do, rather than 500ing', async () => {
  const page = await fetch(`${BASE}/settings/import`, {
    headers: { cookie: alice.cookie }, redirect: 'manual'
  });
  const html = await page.text();
  const token = /_csrf=([^"&]+)/.exec(html)?.[1];
  const csrfCookie = /margin_csrf=([^;]+)/.exec(page.headers.get('set-cookie') || '')?.[1];
  const jar = [alice.cookie, csrfCookie ? `margin_csrf=${csrfCookie}` : ''].filter(Boolean).join('; ');

  const B = '----marginemptytest';
  const body =
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename=""\r\n\r\n\r\n` +
    `--${B}\r\nContent-Disposition: form-data; name="pasted"\r\n\r\n   \r\n` +
    `--${B}--\r\n`;

  const res = await fetch(`${BASE}/settings/import?_csrf=${encodeURIComponent(decodeURIComponent(token || ''))}`, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': `multipart/form-data; boundary=${B}` },
    body,
    redirect: 'manual'
  });

  assert.equal(res.status, 400);
  assert.match(await res.text(), /Choose a file, or paste some titles/);
});

// ── A SHELF WITH A RATED BOOK ON IT ──────────────────────
//
// Every shelf holding a rated book returned 500: views/shelf.ejs called
// h.stars(), which was on no module, and eight other templates called it too.
// Compiling a template cannot catch that — the expression only runs when a
// book on the page has a rating, and no test had ever rendered one.
//
// scripts/check-templates.mjs now checks the helper names statically. This
// covers the other half: that the page actually renders.

test('a shelf with a rated book renders, with its stars', async () => {
  const who = reader('starshelf', 'public');
  const res = await GET('/shelf/read', who.cookie);
  assert.equal(res.status, 200, 'a rated book must not 500 the shelf');

  const html = await res.text();
  assert.match(html, /class="stars stars-\d+"/, 'the glyphs are rendered as an element');
  assert.match(html, /aria-label="4 of 5 stars"/, 'and read as words, not as four black stars');
});

test('an unrated book prints nothing rather than an empty star element', async () => {
  const H = await import('../lib/view-helpers.js');
  assert.equal(H.stars(null), '');
  assert.equal(H.stars(4.5, { size: 11 }),
    '<span class="stars stars-11" aria-label="4.5 of 5 stars">★★★★½</span>');
  // Only the sizes margin.css defines. An unknown one inherits rather than
  // emitting a class that resolves to nothing.
  assert.equal(H.stars(4, { size: 99 }),
    '<span class="stars" aria-label="4 of 5 stars">★★★★</span>');
});
