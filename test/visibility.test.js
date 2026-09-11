import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB, makeUser } from './helpers.js';

useTempDB();

const { db } = await import('../db/index.js');
const V = await import('../lib/visibility.js');

// Two readers and an onlooker. `alice` is the subject of every check;
// `bob` is a signed-in stranger; anonymous is the open internet.
const alice = makeUser(db, { handle: 'alice', visibility: 'public' });
const bob = makeUser(db, { handle: 'bob' });

const AS_ALICE = { id: alice.id, isMember: true };
const AS_BOB = { id: bob.id, isMember: true };
const ANON = V.ANONYMOUS;

// A shelf per visibility, and a private book on the public shelf.
const shelf = (name, visibility) => {
  db.prepare(
    `INSERT INTO shelves (user_id, name, slug, visibility) VALUES (?, ?, ?, ?)`
  ).run(alice.id, name, name, visibility);
  return db.prepare('SELECT * FROM shelves WHERE user_id = ? AND slug = ?').get(alice.id, name);
};

db.prepare(`INSERT INTO works (id, title) VALUES (1, 'A Public Book'), (2, 'A Private Book')`).run();

const open = shelf('open', 'public');
const quiet = shelf('quiet', 'private');
const inherited = shelf('inherited', 'inherit');

db.prepare(`INSERT INTO shelf_items (shelf_id, work_id, visibility) VALUES (?, 1, 'inherit')`).run(open.id);
db.prepare(`INSERT INTO shelf_items (shelf_id, work_id, visibility) VALUES (?, 2, 'private')`).run(open.id);
db.prepare(`INSERT INTO shelf_items (shelf_id, work_id, visibility) VALUES (?, 1, 'public')`).run(quiet.id);
db.prepare(`INSERT INTO shelf_items (shelf_id, work_id, visibility) VALUES (?, 1, 'inherit')`).run(inherited.id);

// The query every read path is supposed to look like.
function itemsVisibleTo(viewer) {
  const v = V.visibleSQL(viewer, { owner: 'u', shelf: 'sh', entry: 'si' });
  return db.prepare(
    `SELECT sh.slug, si.work_id
       FROM shelf_items si
       JOIN shelves sh ON sh.id = si.shelf_id
       JOIN users u ON u.id = sh.user_id
      WHERE u.id = ${alice.id} AND ${v.sql}
      ORDER BY sh.slug, si.work_id`
  ).all(...v.params).map((r) => `${r.slug}/${r.work_id}`);
}

test('most restrictive layer wins', async (t) => {
  await t.test('a private entry on a public shelf is not public', () => {
    assert.deepEqual(itemsVisibleTo(ANON), ['inherited/1', 'open/1']);
  });

  await t.test('a public entry on a private shelf is not public', () => {
    // quiet/1 is marked 'public' at entry level but its shelf is private.
    assert.ok(!itemsVisibleTo(ANON).includes('quiet/1'));
    assert.ok(!itemsVisibleTo(AS_BOB).includes('quiet/1'));
  });

  await t.test('the owner sees everything regardless of layer', () => {
    assert.deepEqual(itemsVisibleTo(AS_ALICE), ['inherited/1', 'open/1', 'open/2', 'quiet/1']);
  });
});

test('the account layer floors the ones below it', async (t) => {
  db.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = ?`).run(alice.id);
  await t.test('a private account publishes nothing, whatever its shelves say', () => {
    assert.deepEqual(itemsVisibleTo(ANON), []);
    assert.deepEqual(itemsVisibleTo(AS_BOB), []);
  });
  await t.test('and the owner still sees all of it', () => {
    assert.equal(itemsVisibleTo(AS_ALICE).length, 4);
  });

  db.prepare(`UPDATE users SET profile_visibility = 'members' WHERE id = ?`).run(alice.id);
  await t.test("'members' is visible to a signed-in stranger but not to the open internet", () => {
    assert.deepEqual(itemsVisibleTo(ANON), []);
    assert.deepEqual(itemsVisibleTo(AS_BOB), ['inherited/1', 'open/1']);
  });

  db.prepare(`UPDATE users SET profile_visibility = 'public' WHERE id = ?`).run(alice.id);
});

test('an account that cannot publish, does not', async (t) => {
  await t.test('unverified', () => {
    db.prepare(`UPDATE users SET email_verified_at = NULL WHERE id = ?`).run(alice.id);
    assert.deepEqual(itemsVisibleTo(ANON), []);
    db.prepare(`UPDATE users SET email_verified_at = datetime('now') WHERE id = ?`).run(alice.id);
  });

  await t.test('deactivated', () => {
    db.prepare(`UPDATE users SET deactivated_at = datetime('now') WHERE id = ?`).run(alice.id);
    assert.deepEqual(itemsVisibleTo(ANON), []);
    db.prepare(`UPDATE users SET deactivated_at = NULL WHERE id = ?`).run(alice.id);
  });

  await t.test('deleted', () => {
    db.prepare(`UPDATE users SET deleted_at = datetime('now') WHERE id = ?`).run(alice.id);
    assert.deepEqual(itemsVisibleTo(ANON), []);
    db.prepare(`UPDATE users SET deleted_at = NULL WHERE id = ?`).run(alice.id);
  });
});

test('§19 — a private profile 404s rather than 403s', () => {
  const priv = { ...alice, profile_visibility: 'private' };
  assert.equal(V.profileVisibleTo(priv, ANON), false);
  assert.equal(V.profileVisibleTo(priv, AS_BOB), false);
  assert.equal(V.profileVisibleTo(priv, AS_ALICE), true, 'the owner still sees their own');
});

test('§19 — user A gets 404 for user B\'s object', () => {
  const row = { id: 99, user_id: alice.id };
  assert.throws(() => V.assertOwner(row, AS_BOB), (e) => e.status === 404);
  assert.throws(() => V.assertOwner(row, ANON), (e) => e.status === 404);
  assert.doesNotThrow(() => V.assertOwner(row, AS_ALICE));
});

test('a forgotten viewer gets the least privilege, not the most', () => {
  // Passing undefined must behave exactly like an anonymous visitor.
  assert.deepEqual(itemsVisibleTo(undefined), itemsVisibleTo(ANON));
});

test('visibleSQL refuses to run without an owner alias', () => {
  // A scope that silently stops scoping is worse than one that throws.
  assert.throws(() => V.visibleSQL(ANON, {}), /requires an owner/);
});

test('effectiveVisibility resolves inherit up the chain', () => {
  const e = V.effectiveVisibility;
  assert.equal(e({ account: 'public', shelf: 'inherit', entry: 'inherit' }), 'public');
  assert.equal(e({ account: 'public', shelf: 'private', entry: 'public' }), 'private');
  assert.equal(e({ account: 'members', shelf: 'public', entry: 'inherit' }), 'members');
  assert.equal(e({ account: 'private', shelf: 'public', entry: 'public' }), 'private');
});

// §15 used to be enforced by refusing to let a new account become public.
// Profiles are public by default now, so it is enforced by refusing to LIST
// one instead — an impersonation account is worth something only when it
// reaches people who were not looking for it.
test('§15 — a new empty account is viewable but not listed', () => {
  const fresh = { email_verified_at: '2026-01-01', created_at: '2026-08-24 00:00:00', books_logged: 0 };
  const now = Date.parse('2026-08-25T00:00:00Z');

  assert.equal(V.canGoPublic(fresh).ok, true, 'a verified account may be public from day one');
  assert.equal(V.isEstablished(fresh, { now }), false, 'but it is not listed yet');

  assert.equal(V.isEstablished({ ...fresh, books_logged: 10 }, { now }), true, 'ten books is enough');
  assert.equal(
    V.isEstablished({ ...fresh, created_at: '2026-08-01 00:00:00' }, { now }), true,
    'seven days is enough'
  );

  // Email verification is absolute on both axes.
  assert.equal(V.canGoPublic({ ...fresh, email_verified_at: null }).ok, false, 'unverified never public');
  assert.equal(
    V.isEstablished({ ...fresh, email_verified_at: null, books_logged: 50 }, { now }), false,
    'unverified never listed, however many books'
  );
});

// ── THE DEFAULT ──────────────────────────────────────────
//
// The contract this product now makes on the way in. It is asserted against
// the real creation path rather than against the column default, because
// createUser writes the value explicitly and that is the code a new reader
// actually goes through.
test('a new account is public, and its library comes with it', async () => {
  const A = await import('../lib/accounts.js');
  const fresh = A.createUser({ email: 'newcomer@example.test', passwordHash: 'x' });

  assert.equal(fresh.profile_visibility, 'public', 'public on the way in');

  // The whole reason the old default was so costly: shelves, entries and
  // reviews all default to 'inherit', so the account setting decided the
  // visibility of the entire library in one go — in the wrong direction.
  assert.equal(
    V.effectiveVisibility({ account: fresh.profile_visibility, shelf: 'inherit', entry: 'inherit' }),
    'public',
    'an inherited shelf is public too'
  );

  // The one thing that does NOT come on. Findable by readers here is what a
  // public profile is for; crawled by Google is a separate decision.
  assert.equal(fresh.search_indexable, 0, 'not indexable without asking');

  // And it is not yet listed anywhere a stranger browses.
  assert.equal(V.isEstablished(fresh), false, 'no distribution on day one');
});
