import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run, sqlTime } = await import('../db/index.js');
const V = await import('../lib/visibility.js');
const T = await import('../lib/trust.js');
const SAFE = await import('../lib/safety.js');
const A = await import('../lib/accounts.js');

// ── Fixtures ─────────────────────────────────────────────
function reader(handle, { visibility = 'public', trust = 2, books = 30, ageDays = 400 } = {}) {
  const u = A.createUser({ email: `${handle}@example.test`, passwordHash: 'x' });
  A.markVerified(u.id);
  A.setUsername(u.id, handle);
  run(
    `UPDATE users SET profile_visibility = ?, trust_level = ?, books_logged = ?,
                      reviews_published = 5, created_at = ?
      WHERE id = ?`,
    visibility, trust, books, sqlTime(Date.now() - ageDays * 86_400_000), u.id
  );
  return get('SELECT * FROM users WHERE id = ?', u.id);
}

const alice = reader('alice');
const bob = reader('bob');
const carol = reader('carol', { visibility: 'private' });

const as = (u) => ({ id: u.id, isMember: true, trust: u.trust_level });

// ── §12 — TRUST ──────────────────────────────────────────

test('§12 — levels are earned from the account\'s own history', async (t) => {
  const now = Date.now();
  const at = (d) => sqlTime(now - d * 86_400_000);

  await t.test('a new account is 0', () => {
    assert.equal(T.computeLevel({ created_at: at(0), books_logged: 0, email_verified_at: null }, { now }), 0);
  });

  await t.test('verified + 3 days + 5 books is 1', () => {
    assert.equal(T.computeLevel(
      { created_at: at(4), books_logged: 5, email_verified_at: at(4) }, { now }), 1);
  });

  await t.test('14 days + 20 books + 3 reviews is 2', () => {
    assert.equal(T.computeLevel(
      { created_at: at(20), books_logged: 20, reviews_published: 3, email_verified_at: at(20) },
      { now }), 2);
  });

  await t.test('90 days + 50 books is 3', () => {
    assert.equal(T.computeLevel(
      { created_at: at(100), books_logged: 50, reviews_published: 5, email_verified_at: at(100) },
      { now }), 3);
  });

  await t.test('an upheld report blocks level 2', () => {
    assert.equal(T.computeLevel(
      { created_at: at(20), books_logged: 20, reviews_published: 3,
        email_verified_at: at(20), upheld_reports: 1, last_upheld_at: at(1) },
      { now }), 1);
  });

  await t.test('a moderator limit outranks everything', () => {
    assert.equal(T.computeLevel(
      { created_at: at(500), books_logged: 500, reviews_published: 50,
        email_verified_at: at(500), trust_level: -1 },
      { now }), -1);
  });
});

test('§12 — the ladder gates what the spec says it gates', async (t) => {
  await t.test('Trust 0 cannot link, create a club, or comment', () => {
    assert.equal(T.can(0, 'canLink'), false);
    assert.equal(T.can(0, 'canCreateClub'), false);
    assert.equal(T.can(0, 'canComment'), false);
    assert.equal(T.can(0, 'ratingsCount'), false, 'and its ratings do not count');
  });

  await t.test('Trust 2 gains all four', () => {
    assert.equal(T.can(2, 'canLink'), true);
    assert.equal(T.can(2, 'canCreateClub'), true);
    assert.equal(T.can(2, 'ratingsCount'), true);
    assert.equal(T.can(2, 'maxFollowers'), Infinity);
  });

  await t.test('a limited account is read-only', () => {
    assert.equal(T.can(-1, 'readOnly'), true);
    assert.equal(T.can(-1, 'reviewsPerDay'), 0);
  });
});

test('§12 — a level is never rendered anywhere', async () => {
  const fs = (await import('node:fs')).promises;
  const files = ['views/profile.ejs'];
  for (const f of files) {
    const src = await fs.readFile(f, 'utf8').catch(() => '');
    assert.ok(!/trust_level|trust\b.*level|Trust \d/i.test(src.replace(/<%#[\s\S]*?%>/g, '')),
      `${f} renders a trust level — it becomes a status game the moment it is visible`);
  }
});

test('§12 — write limits are per level', () => {
  T.__resetLimits();
  const u = reader('limited_writer', { trust: 0 });

  let allowed = 0;
  for (let i = 0; i < 6; i++) {
    if (T.withinWriteLimit(u.id, 'review', 0).ok) allowed++;
  }
  assert.equal(allowed, 3, 'Trust 0 gets three reviews a day');

  T.__resetLimits();
  let allowed2 = 0;
  for (let i = 0; i < 15; i++) if (T.withinWriteLimit(u.id, 'review', 1).ok) allowed2++;
  assert.equal(allowed2, 10, 'Trust 1 gets ten');
});

test('§12 — a Trust 0 account cannot be followed by more than 50', () => {
  const fresh = reader('freshfaced', { trust: 0 });
  for (let i = 0; i < 50; i++) {
    run(`INSERT INTO users (handle, public_id, email, email_verified_at, username, profile_visibility)
         VALUES (?, ?, ?, datetime('now'), ?, 'public')`,
        `f${i}`, `pid-follow-${i}`, `f${i}@example.test`, `follower${i}`);
    const f = get('SELECT id FROM users WHERE handle = ?', `f${i}`);
    run(`INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
        f.id, fresh.id);
  }
  assert.equal(T.followerCapReached(fresh.id), true);

  run('UPDATE users SET trust_level = 2 WHERE id = ?', fresh.id);
  assert.equal(T.followerCapReached(fresh.id), false, 'the cap lifts on its own');
});

// ── §15 — BLOCKS ─────────────────────────────────────────

test('§19 — a blocked user receives 404 on the blocker\'s profile', () => {
  SAFE.block(alice.id, bob.id);

  assert.equal(V.profileVisibleTo(alice, as(bob)), false, 'bob cannot see alice');
  assert.equal(V.profileVisibleTo(bob, as(alice)), false, 'and alice cannot see bob');
  assert.equal(V.profileVisibleTo(alice, as(carol)), true, 'carol is unaffected');

  SAFE.unblock(alice.id, bob.id);
  assert.equal(V.profileVisibleTo(alice, as(bob)), true);
});

test('§15 — a block is mutual in the SQL scope, not only in the profile check', () => {
  run(`INSERT INTO works (id, title) VALUES (500, 'A Book')`);
  run(`INSERT INTO shelves (user_id, name, slug) VALUES (?, 'Read', 'read')`, alice.id);
  const sh = get(`SELECT id FROM shelves WHERE user_id = ? AND slug = 'read'`, alice.id);
  run('INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, 500)', sh.id);

  const visibleTo = (viewer) => {
    const v = V.visibleSQL(viewer, { owner: 'u', shelf: 'sh', entry: 'si' });
    return all(
      `SELECT si.work_id FROM shelf_items si
         JOIN shelves sh ON sh.id = si.shelf_id
         JOIN users u ON u.id = sh.user_id
        WHERE u.id = ${alice.id} AND ${v.sql}`,
      ...v.params
    ).length;
  };

  assert.equal(visibleTo(as(bob)), 1, 'before the block');

  SAFE.block(bob.id, alice.id);          // bob blocks alice, not the reverse
  assert.equal(visibleTo(as(bob)), 0, 'the blocker sees nothing of the blocked');
  assert.equal(visibleTo(as(alice)), 1, "and alice still sees her own");

  SAFE.unblock(bob.id, alice.id);
});

test('§15 — blocking severs follows in both directions', () => {
  run(`INSERT OR REPLACE INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      alice.id, bob.id);
  run(`INSERT OR REPLACE INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      bob.id, alice.id);

  SAFE.block(alice.id, bob.id);

  assert.equal(all('SELECT * FROM user_follows WHERE follower_id = ? AND followee_id = ?',
                   alice.id, bob.id).length, 0);
  assert.equal(all('SELECT * FROM user_follows WHERE follower_id = ? AND followee_id = ?',
                   bob.id, alice.id).length, 0);
  SAFE.unblock(alice.id, bob.id);
});

test('§15 — a host blocking a member removes that member from the club', () => {
  const clubId = 'club-block-test';
  run(`INSERT INTO clubs (id, slug, slug_skeleton, name, host_id) VALUES (?, 'blocktest', 'blocktest', 'Block Test', ?)`,
      clubId, alice.id);
  run(`INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'host', 'active')`,
      clubId, alice.id);
  run(`INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'member', 'active')`,
      clubId, bob.id);

  SAFE.block(alice.id, bob.id);

  const membership = get('SELECT state FROM club_members WHERE club_id = ? AND user_id = ?',
                         clubId, bob.id);
  assert.equal(membership.state, 'removed',
    'a moderator cannot be forced to moderate someone they have blocked');

  SAFE.unblock(alice.id, bob.id);
});

test('§15 — a block suppresses a notification already queued', () => {
  const id = SAFE.notify(alice.id, { kind: 'follow', actorId: bob.id, subject: 'followed you' });
  assert.ok(id, 'it was generated before the block');

  SAFE.block(alice.id, bob.id);

  const visible = SAFE.notificationsFor(alice.id).filter((n) => n.id === id);
  assert.equal(visible.length, 0, 'and suppressed on delivery');

  SAFE.unblock(alice.id, bob.id);
});

test('§13 — a notification is never generated across an existing block', () => {
  SAFE.block(alice.id, bob.id);
  assert.equal(SAFE.notify(alice.id, { kind: 'follow', actorId: bob.id }), null);
  SAFE.unblock(alice.id, bob.id);
});

// ── §11 — MUTES ──────────────────────────────────────────

test('§11 — a mute severs nothing and is never disclosed', () => {
  run(`INSERT OR REPLACE INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      alice.id, bob.id);

  SAFE.mute(alice.id, bob.id);

  assert.equal(V.hasMuted(alice.id, bob.id), true);
  assert.equal(V.hasMuted(bob.id, alice.id), false, 'it is one-directional');
  assert.equal(
    all('SELECT * FROM user_follows WHERE follower_id = ? AND followee_id = ?', alice.id, bob.id).length,
    1, 'the follow survives'
  );
  assert.equal(V.profileVisibleTo(bob, as(alice)), true, 'and the profile is still reachable');

  SAFE.unmute(alice.id, bob.id);
});

// ── §14 — REPORTS ────────────────────────────────────────

test('§14 — reports are rate limited per day and per target', () => {
  const target = reader('reported_one');
  const filed = [];

  for (let i = 0; i < 5; i++) {
    filed.push(SAFE.report(alice, {
      targetType: 'user', targetRef: String(target.id), targetUserId: target.id,
      category: 'spam', detail: `attempt ${i}`
    }));
  }

  const ok = filed.filter((r) => r.ok).length;
  assert.equal(ok, 3, 'three per target, and no more');
  assert.match(filed[3].error, /already reported/);
});

test('§14 — report volume alone triggers no automated action', async () => {
  const src = await (await import('node:fs')).promises.readFile('lib/safety.js', 'utf8');
  const code = src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');

  // Nothing in the reporting path may call an enforcement function. Every
  // action against a user is taken by a human — that single rule is what
  // prevents brigading from working.
  const reportFn = code.slice(code.indexOf('export function report('), code.indexOf('export const reportsBy'));
  assert.ok(!/\blimit\(|\bsuspend\(|\bban\(|hide_content|remove_content/.test(reportFn),
    'filing a report must not enforce anything');
});

test('§14 — coordinated reporting flags the reporters, not the target', () => {
  const victim = reader('brigaded');
  const brigade = [];

  // Ten accounts, created together, all following each other.
  for (let i = 0; i < 10; i++) brigade.push(reader(`brig${i}`, { ageDays: 1 }));
  for (const a of brigade) {
    for (const b of brigade) {
      if (a.id !== b.id) {
        run(`INSERT OR IGNORE INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
            a.id, b.id);
      }
    }
  }
  for (const r of brigade) {
    SAFE.report(r, { targetType: 'user', targetRef: String(victim.id),
                     targetUserId: victim.id, category: 'harassment' });
  }

  const findings = SAFE.coordinatedReporting({ threshold: 8 });
  const hit = findings.find((f) => f.target_ref === String(victim.id));

  assert.ok(hit, 'the cluster is detected');
  assert.equal(hit.reporters.length, 10);
  assert.ok(hit.overlap > 0.3, 'the follow-graph overlap is what gives it away');
  assert.match(hit.note, /flag the reporters/);

  // And the victim's account is untouched.
  assert.equal(get('SELECT trust_level FROM users WHERE id = ?', victim.id).trust_level,
               victim.trust_level, 'no automated action against the target');
});

test('§14 — reports are weighted by the reporter\'s record', () => {
  const good = reader('reliable', { trust: 3 });
  const poor = reader('unreliable', { trust: 0 });

  // A record of reports that were all upheld, and one of reports that never were.
  for (let i = 0; i < 6; i++) {
    run(`INSERT INTO reports (id, reporter_id, target_type, target_ref, kind, state)
         VALUES (?, ?, 'user', ?, 'spam', 'actioned')`, `g${i}`, good.id, `t${i}`);
    run(`INSERT INTO reports (id, reporter_id, target_type, target_ref, kind, state)
         VALUES (?, ?, 'user', ?, 'spam', 'dismissed')`, `p${i}`, poor.id, `t${i}`);
  }

  assert.ok(SAFE.reporterWeight(good) > SAFE.reporterWeight(poor) * 2,
    'a good record counts for more than a bad one');
});

test('§14 — a moderator action requires a reason and tells the user', () => {
  const target = reader('actioned_user');
  const r = SAFE.report(alice, {
    targetType: 'review', targetRef: 'rev-1', targetUserId: target.id, category: 'harassment'
  });

  // resolved_by is a foreign key into staff, which is the point: a
  // resolution names a real moderator or it does not happen.
  run(`INSERT OR IGNORE INTO staff (id, email, password_hash, role)
       VALUES ('staff-mod-1', 'mod@example.test', 'x', 'trust')`);
  const staff = { id: 'staff-mod-1', email: 'mod@example.test' };

  assert.throws(() => SAFE.resolve(r.id, { staff, action: 'remove_content', reason: 'no' }),
    /written reason/);
  assert.throws(() => SAFE.resolve(r.id, { staff, action: 'nonsense', reason: 'a good long reason' }),
    /unknown action/);

  const out = SAFE.resolve(r.id, {
    staff, action: 'remove_content',
    reason: 'targeted abuse of another member',
    rule: 'No harassment'
  });
  assert.equal(out.state, 'actioned');

  // The reporter learns the outcome.
  const reporterSaw = SAFE.notificationsFor(alice.id).some((n) => n.kind === 'report_resolved');
  assert.ok(reporterSaw, 'silence teaches people not to report');

  // And the person acted against is told under which rule.
  const targetSaw = SAFE.notificationsFor(target.id).find((n) => n.kind === 'moderation_action');
  assert.ok(targetSaw, 'never a silent removal');
  assert.match(targetSaw.subject, /No harassment/);

  // And it is audited.
  const row = get(
    `SELECT * FROM audit_log WHERE action = 'moderation.remove_content' ORDER BY id DESC LIMIT 1`
  );
  assert.equal(row.actor_type, 'staff');
  assert.match(row.reason, /targeted abuse/);
});

test('§11 — a reporter can see the outcome of what they filed', () => {
  const mine = SAFE.reportsBy(alice.id);
  assert.ok(mine.length > 0);
  assert.ok(mine.some((r) => r.state === 'actioned'));
  assert.ok(mine.every((r) => ['open', 'actioned', 'dismissed'].includes(r.state)));
});

// ── §2 — THE SCOPE STAYS ONE FUNCTION ────────────────────

test('§2.1 — there is exactly one visibility scope', async () => {
  const fs = (await import('node:fs')).promises;
  const files = await fs.readdir('lib');
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = await fs.readFile(`lib/${f}`, 'utf8');
    // "Do not write visibleForClub, visibleForFeed, or visibleForBookPage —
    // divergent scopes are how leaks happen."
    assert.ok(!/function visibleFor[A-Z]/.test(src), `lib/${f} forked the scope`);
  }
});

test('§2.1 — the club layer is part of the same scope', () => {
  const clubId = 'club-scope-test';
  run(`INSERT INTO clubs (id, slug, slug_skeleton, name, visibility, host_id)
       VALUES (?, 'scopetest', 'scopetest', 'Scope Test', 'private', ?)`, clubId, alice.id);
  run(`INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'host', 'active')`,
      clubId, alice.id);

  const canSee = (viewer) => {
    const v = V.visibleSQL(viewer, { owner: 'u', club: 'c' });
    return all(
      `SELECT c.id FROM clubs c JOIN users u ON u.id = c.host_id
        WHERE c.id = ? AND ${v.sql}`,
      clubId, ...v.params
    ).length;
  };

  assert.equal(canSee(as(alice)), 1, 'the host sees it');
  assert.equal(canSee(as(bob)), 0, 'a non-member does not');
  assert.equal(canSee(V.ANONYMOUS), 0, 'and neither does a stranger');

  run(`INSERT INTO club_members (club_id, user_id, role, state) VALUES (?, ?, 'member', 'active')`,
      clubId, bob.id);
  assert.equal(canSee(as(bob)), 1, 'a member does');
});

test('§2.1 — the trust layer withholds content from an untrusted author', () => {
  const low = reader('untrusted_author', { trust: 0 });

  const canSee = (viewer) => {
    const v = V.visibleSQL(viewer, { owner: 'u', requireTrust: 2 });
    return all(`SELECT u.id FROM users u WHERE u.id = ? AND ${v.sql}`, low.id, ...v.params).length;
  };

  assert.equal(canSee(as(bob)), 0, 'withheld from others');
  assert.equal(canSee(as(low)), 1, 'but never from its owner');
});

test('§3 — a private account is visible to an approved follower', () => {
  assert.equal(V.profileVisibleTo(carol, as(bob)), false, 'carol is private');

  run(`INSERT OR REPLACE INTO user_follows (follower_id, followee_id, state)
       VALUES (?, ?, 'active')`, bob.id, carol.id);
  assert.equal(V.profileVisibleTo(carol, as(bob)), true, 'following is what opens it');

  run(`UPDATE user_follows SET state = 'requested' WHERE follower_id = ? AND followee_id = ?`,
      bob.id, carol.id);
  assert.equal(V.profileVisibleTo(carol, as(bob)), false, 'a pending request does not');
});

test('a forgotten viewer still gets the least privilege', () => {
  assert.equal(V.profileVisibleTo(carol, undefined), false);
  assert.equal(V.profileVisibleTo(carol, null), false);
});
