import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run, sqlTime } = await import('../db/index.js');
const C = await import('../lib/clubs.js');
const SAFE = await import('../lib/safety.js');
const A = await import('../lib/accounts.js');
const { latestFor } = await import('../lib/latest.js');
const T = await import('../lib/trust.js');

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

const host = reader('host');
const member = reader('member');
const stranger = reader('stranger');
const newcomer = reader('newcomer', { trust: 0, books: 0, ageDays: 0 });

const as = (u) => ({ id: u.id, isMember: true, trust: u.trust_level });

const club = (over = {}) => {
  const out = C.create(host, {
    name: 'Club ' + Math.random().toString(36).slice(2, 8),
    visibility: 'public', joinPolicy: 'open', ...over
  });
  assert.ok(out.ok, out.error);
  return get('SELECT * FROM clubs WHERE id = ?', out.id);
};

// ── §9.1 — CREATION ──────────────────────────────────────

test('§9.1 — a club always has exactly one host', () => {
  const c = club();
  assert.equal(c.host_id, host.id);
  assert.equal(C.membership(c.id, host.id).role, 'host');
  assert.equal(C.memberCount(c.id), 1);
});

test('§11 — creation needs Trust 2', () => {
  const out = C.create(newcomer, { name: 'Too soon' });
  assert.equal(out.ok, false);
  assert.match(out.error, /fortnight/);
});

test('§13.4 — a confusable slug collides with the one it imitates', () => {
  const c = club({ name: 'Paperbacks' });
  // Cyrillic а in place of the Latin one.
  const out = C.create(host, { name: 'Imposter', slug: c.slug.replace('a', 'а') });
  assert.equal(out.ok, false, 'a homograph must not get its own URL');
});

test('a reserved word cannot become a club slug', () => {
  assert.equal(C.create(host, { name: 'Settings', slug: 'settings' }).ok, false);
});

// ── §9.1 — VISIBILITY ────────────────────────────────────

test('§9.1 — a private club is invisible rather than forbidden', () => {
  const c = club({ visibility: 'private', joinPolicy: 'invite_only' });

  assert.equal(C.bySlug(c.slug, as(stranger)), null, 'a non-member gets nothing');
  assert.equal(C.bySlug(c.slug, null), null, 'and so does anonymous');
  assert.ok(C.bySlug(c.slug, as(host)), 'its host can see it');
});

test('§9.1 — an unlisted club is reachable by link but in no directory', () => {
  const c = club({ visibility: 'unlisted' });

  assert.ok(C.bySlug(c.slug, as(stranger)), 'the link works');
  assert.ok(!C.discover(as(stranger)).some((d) => d.id === c.id), 'the directory does not list it');
});

test('a club outlives its host account', () => {
  const c = club();
  // A club is a container, not owned content: the account layer is nobody's.
  run('UPDATE clubs SET host_id = NULL WHERE id = ?', c.id);
  assert.ok(C.bySlug(c.slug, as(stranger)), 'it must not vanish with the host');
});

test('a host with a private profile does not hide their public club', () => {
  const quiet = reader('quiet', { visibility: 'private' });
  const out = C.create(quiet, { name: 'Quiet host club' });
  assert.ok(C.bySlug(out.slug, as(stranger)), 'the club is public even if its host is not');
});

// ── §8 of the security spec — MEMBER LISTS ───────────────

test('a member list is for members', () => {
  const c = club();
  assert.equal(C.members(c.id, as(stranger)), null);
  assert.ok(Array.isArray(C.members(c.id, as(host))));
});

// ── §9.2 — ROLES ─────────────────────────────────────────

test('§2.2 — a role is resolved from club_members, never from a claim', () => {
  const c = club();
  C.join(member, c);

  // Whatever the caller asserts about itself, the check reads the table.
  assert.throws(() => C.requireRole(c.id, member.id, ['host']), /Not permitted/);
  assert.throws(() => C.setRole({ id: member.id, trust_level: 3 }, c, host.id, 'member'),
    /Not permitted/);
  assert.equal(C.membership(c.id, host.id).role, 'host', 'the host is still the host');
});

test('§9.2 — the admin cap stops a takeover by mass promotion', () => {
  const c = club();
  const admins = [];
  for (let i = 0; i < 12; i++) {
    const r = reader('promo' + i);
    C.join(r, c);
    admins.push(r);
  }

  let refused = 0;
  for (const a of admins) if (!C.setRole(host, c, a.id, 'admin').ok) refused++;
  assert.ok(refused >= 2, 'the cap is 10 or 5% of members, whichever is greater');
});

test('§11 — an admin must be Trust 2', () => {
  const c = club();
  C.join(newcomer, c);
  run(`UPDATE club_members SET state = 'active' WHERE club_id = ? AND user_id = ?`,
      c.id, newcomer.id);
  const out = C.setRole(host, c, newcomer.id, 'admin');
  assert.equal(out.ok, false);
  assert.match(out.error, /too new/);
});

test('§9.2 — a host leaving hands over, or the club archives', () => {
  const withHeir = club();
  C.join(member, withHeir);
  C.setRole(host, withHeir, member.id, 'admin');
  C.leave(host.id, withHeir);
  assert.equal(get('SELECT host_id FROM clubs WHERE id = ?', withHeir.id).host_id, member.id);
  assert.equal(C.membership(withHeir.id, member.id).role, 'host');

  const alone = club();
  C.leave(host.id, alone);
  assert.ok(get('SELECT archived_at FROM clubs WHERE id = ?', alone.id).archived_at,
    'never leave a club ownerless');
});

test('§9.2 — hosting transfers only when the recipient accepts', () => {
  const c = club();
  C.join(member, c);
  C.offerHosting(host, c, member.id);

  assert.equal(get('SELECT host_id FROM clubs WHERE id = ?', c.id).host_id, host.id,
    'the offer alone changes nothing');
  assert.ok(SAFE.notificationsFor(member.id).some((n) => n.kind === 'club_hosting_offer'));

  C.acceptHosting(member.id, c);
  assert.equal(get('SELECT host_id FROM clubs WHERE id = ?', c.id).host_id, member.id);
  assert.equal(C.membership(c.id, host.id).role, 'admin', 'the old host stays as an admin');
});

// ── §11 of the security spec — REMOVAL ───────────────────

test('§11 — a removed member is told, and the removal is audited', () => {
  const c = club();
  C.join(member, c);

  const out = C.removeMember(host, c, member.id, { reason: 'off topic' });
  assert.ok(out.ok);

  const told = SAFE.notificationsFor(member.id).find((n) => n.kind === 'club_removed');
  assert.ok(told, 'silent removal is how communities become paranoid');
  assert.match(told.subject, new RegExp(c.name), 'and it names the club');

  const logged = all(`SELECT * FROM audit_log WHERE action = 'club.member_removed'`);
  assert.ok(logged.length, 'an admin action against a person is always logged');
});

test('§11 — the host cannot be removed by an admin', () => {
  const c = club();
  C.join(member, c);
  C.setRole(host, c, member.id, 'admin');
  assert.equal(C.removeMember(member, c, host.id).ok, false);
});

test('§11 — removals are rate limited', () => {
  const c = club();
  const victims = [];
  for (let i = 0; i < 55; i++) {
    const r = reader('victim' + i);
    C.join(r, c);
    victims.push(r);
  }
  let refused = 0;
  for (const v of victims) if (!C.removeMember(host, c, v.id).ok) refused++;
  assert.ok(refused >= 5, 'a compromised admin account is bounded');
});

// ── §15 — BLOCKS ─────────────────────────────────────────

test('§15 — a blocked user\'s request to join the blocker\'s club goes nowhere, silently', () => {
  const c = club({ joinPolicy: 'request' });
  SAFE.block(host.id, stranger.id, {});

  const out = C.join(stranger, c);
  assert.equal(out.ok, true, 'it must not read as a refusal');
  assert.equal(C.membership(c.id, stranger.id), null, 'and nothing is recorded');
});

// ── §9.3 — THE PICK ──────────────────────────────────────

test('§9.3 — setting a pick announces it once and notifies members once', () => {
  const c = club();
  C.join(member, c);
  const work = run('INSERT INTO works (title) VALUES (?)', 'The Pick').lastInsertRowid;

  C.setPick(host, c, { workId: work, announcement: 'We start Monday.' });

  const posts = all(`SELECT * FROM club_posts WHERE club_id = ? AND kind = 'announcement'`, c.id);
  assert.equal(posts.length, 1);

  const notes = SAFE.notificationsFor(member.id).filter((n) => n.kind === 'club_pick');
  assert.equal(notes.length, 1, 'once, not once per member per surface');

  const hostNotes = SAFE.notificationsFor(host.id).filter((n) => n.kind === 'club_pick');
  assert.equal(hostNotes.length, 0, 'and never to the person who did it');
});

test('§9.3 — one active pick, and a queue of at most three behind it', () => {
  const c = club();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push(run('INSERT INTO works (title) VALUES (?)', 'Queued ' + i).lastInsertRowid);
  }
  for (const id of ids) C.setPick(host, c, { workId: id });

  assert.equal(C.activePick(c.id).work_id, ids[0]);
  assert.ok(C.queue(c.id).length <= 3);
});

test('§9.3 — progress is anonymous, and silent below five readers', () => {
  const c = club();
  const work = run('INSERT INTO works (title) VALUES (?)', 'Measured').lastInsertRowid;
  C.setPick(host, c, { workId: work });
  const pick = C.activePick(c.id);

  let seq = 0;
  const enroll = (n) => {
    for (let i = 0; i < n; i++) {
      const r = reader('prog' + work + '_' + (seq++));
      C.join(r, c);
      C.participate(r.id, pick.id, 'in');
      run(`INSERT INTO readings (user_id, work_id, status, current_page, is_draft)
           VALUES (?, ?, 'READING', ?, 0)`, r.id, work, 100 + i * 10);
    }
  };

  enroll(4);
  assert.equal(C.pickProgress(pick).tooFew, true, 'four readers is a list of individuals');

  enroll(2);
  const p = C.pickProgress(pick);
  assert.equal(p.tooFew, false);
  assert.equal(typeof p.median, 'number');
  assert.ok(!('pages' in p), 'never a per-member position');
});

// ── §9.4 — CHECKPOINTS ───────────────────────────────────

test('§9.4 — a thread does not open before its date', () => {
  const c = club();
  const work = run('INSERT INTO works (title) VALUES (?)', 'Gated').lastInsertRowid;
  C.setPick(host, c, { workId: work });
  const pick = C.activePick(c.id);

  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const { id } = C.addCheckpoint(host, c, pick.id, { label: 'Part two', throughPage: 200, opensOn: soon });
  const cp = get('SELECT * FROM club_checkpoints WHERE id = ?', id);

  assert.equal(C.checkpointOpen(cp), false);
  assert.equal(C.post(host, c, { body: 'early', checkpointId: id }).ok, false);

  const past = C.addCheckpoint(host, c, pick.id, { label: 'Part one', throughPage: 100 });
  assert.equal(C.checkpointOpen(get('SELECT * FROM club_checkpoints WHERE id = ?', past.id)), true);
});

// ── §9.5 — DISCUSSION ────────────────────────────────────

test('§9.5 — a non-member cannot post, whatever they send', () => {
  const c = club();
  assert.throws(() => C.post(stranger, c, { body: 'hello' }), /Not permitted/);
});

test('§9.5 — a post is stored as sanitised markup, never as raw HTML', () => {
  const c = club();
  C.join(member, c);
  const { id } = C.post(member, c, { body: 'Careful: <script>alert(1)</script> **bold**' });

  const p = get('SELECT * FROM club_posts WHERE id = ?', id);
  assert.ok(!/<script/i.test(p.body_html));
  assert.match(p.body_html, /<strong>bold<\/strong>/);
});

test('§9.5 — external links need Trust 2', () => {
  const c = club();
  const low = reader('lowtrust', { trust: 1 });
  C.join(low, c);
  const { id } = C.post(low, c, { body: 'See https://example.com/spam' });
  assert.ok(!/<a /i.test(get('SELECT body_html FROM club_posts WHERE id = ?', id).body_html));
});

test('§15 — a blocked member leaves no gap in a thread', () => {
  const c = club();
  C.join(member, c);
  C.post(member, c, { body: 'Something I said.' });

  const before = C.postsIn(c.id, as(host)).length;
  SAFE.block(host.id, member.id, {});
  const after = C.postsIn(c.id, as(host));

  assert.equal(after.length, before - 1);
  assert.ok(!after.some((p) => p.body.includes('Something I said.')));
  // Nothing counts what is missing: a visible gap is a taunt.
  assert.ok(!after.some((p) => /hidden/i.test(p.body_html || '')));
  SAFE.unblock(host.id, member.id);
});

test('§9.5 — a reaction toggles and nobody is named', () => {
  const c = club();
  C.join(member, c);
  const { id } = C.post(member, c, { body: 'A claim.' });

  C.react(host.id, id, 'agreed');
  assert.equal(C.reactionsFor(id).find((r) => r.reaction === 'agreed').n, 1);
  C.react(host.id, id, 'agreed');
  assert.equal(C.reactionsFor(id).length, 0);
  assert.equal(C.react(host.id, id, 'brilliant').ok, false, 'the four are the four');
});

// ── §10 — NOTIFICATIONS ──────────────────────────────────

test('§10 — per-type toggles are honoured inside notify, not at the call site', () => {
  const u = reader('prefs');
  SAFE.setPrefs(u.id, SAFE.NOTIFY_KINDS.map((k) => k.kind).filter((k) => k !== 'follow'));

  assert.equal(SAFE.notify(u.id, { kind: 'follow', subject: 'x' }), null);
  assert.ok(SAFE.notify(u.id, { kind: 'club_pick', subject: 'x' }));
});

test('§10 — the likes digest defaults to off', () => {
  const u = reader('digestoff');
  assert.equal(SAFE.prefsFor(u.id).find((k) => k.kind === 'likes_digest').on, false);
  assert.equal(SAFE.wants(u.id, 'likes_digest'), false);
});

test('§10 — pause everything stops everything except account security', () => {
  const u = reader('paused');
  SAFE.setPaused(u.id, true);

  assert.equal(SAFE.notify(u.id, { kind: 'follow', subject: 'x' }), null);
  assert.equal(SAFE.notify(u.id, { kind: 'club_pick', subject: 'x' }), null);
  assert.ok(SAFE.notify(u.id, { kind: 'security', subject: 'new sign-in' }),
    'you must still learn your account was taken');
});

test('§10 — a kind with no switch on the settings page cannot be sent', () => {
  const u = reader('unknownkind');
  assert.equal(SAFE.notify(u.id, { kind: 'streak_broken', subject: 'nope' }), null);
});

test('§10 — every kind used anywhere in the codebase is deliverable', () => {
  const u = reader('coverage');
  // A kind that resolves to no preference is silently dropped, so a call
  // site added without a matching entry is a bug that never raises.
  const used = [
    'follow', 'follow_request', 'follow_approved', 'review_reply',
    'club_pick', 'club_checkpoint', 'club_request', 'club_approved',
    'club_hosting', 'club_hosting_offer', 'club_removed',
    'moderation', 'moderation_action', 'report_resolved', 'likes_digest'
  ];
  SAFE.setPrefs(u.id, SAFE.NOTIFY_KINDS.map((k) => k.kind));
  for (const kind of used) {
    assert.ok(SAFE.wants(u.id, kind), `${kind} is sent by some call site but has no preference`);
  }
});

// ── §8 — LATEST ──────────────────────────────────────────

test('§8 — Latest is empty for anonymous and bounded for everyone else', () => {
  assert.deepEqual(latestFor(null).entries, []);

  const out = latestFor(as(host));
  assert.ok(Array.isArray(out.entries));
  assert.ok(out.entries.length <= 100);
  assert.equal(out.ended, true, 'the page finishes');
});

test('§8 — one person, one kind, one day is one entry', () => {
  const watcher = reader('watcher');
  const watched = reader('watched');
  run(`INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      watcher.id, watched.id);

  const day = sqlTime(Date.now() - 3600_000);
  for (let i = 0; i < 6; i++) {
    const w = run('INSERT INTO works (title) VALUES (?)', 'Sunday ' + i).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, visibility)
         VALUES (?, ?, 'FINISHED', ?, 0, 'public')`, watched.id, w, day);
  }

  const { entries } = latestFor(as(watcher));
  const finished = entries.filter((e) => e.kind === 'finished' && e.user_id === watched.id);
  assert.equal(finished.length, 1, 'six books on a Sunday is one line, not six');
  assert.equal(finished[0].items.length, 6);
});

test('§8 — a muted account is absent from Latest and nowhere else', () => {
  const watcher = reader('muter');
  const noisy = reader('noisy');
  run(`INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      watcher.id, noisy.id);

  const w = run('INSERT INTO works (title) VALUES (?)', 'Loud').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, visibility)
       VALUES (?, ?, 'FINISHED', ?, 0, 'public')`, noisy.id, w, sqlTime(Date.now() - 3600_000));

  assert.ok(latestFor(as(watcher)).entries.some((e) => e.user_id === noisy.id));
  SAFE.mute(watcher.id, noisy.id);
  assert.ok(!latestFor(as(watcher)).entries.some((e) => e.user_id === noisy.id));

  // The mute severs nothing else: the follow still stands.
  assert.ok(get(`SELECT 1 AS x FROM user_follows WHERE follower_id = ? AND followee_id = ?`,
                watcher.id, noisy.id));
});

test('§8 — nothing from an account you do not follow', () => {
  const solo = reader('solo');
  const elsewhere = reader('elsewhere');
  const w = run('INSERT INTO works (title) VALUES (?)', 'Unrelated').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, visibility)
       VALUES (?, ?, 'FINISHED', ?, 0, 'public')`, elsewhere.id, w, sqlTime(Date.now() - 3600_000));

  assert.ok(!latestFor(as(solo)).entries.some((e) => e.user_id === elsewhere.id),
    'there is no discovery surface here');
});

// ── The feed is other people ─────────────────────────────

test('§8 — your own activity is not in your own feed', () => {
  const solo = reader('narcissus');
  const w = run('INSERT INTO works (title) VALUES (?)', 'Mine').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, visibility)
       VALUES (?, ?, 'FINISHED', ?, 0, 'public')`, solo.id, w, sqlTime(Date.now() - 3600_000));

  // Your own reading is the rail beside the feed. A feed that reports your
  // activity back to you is the shape that becomes a scoreboard.
  assert.ok(!latestFor(as(solo)).entries.some((e) => e.user_id === solo.id));
});

test('§8 — a spoiler-marked review does not put its first line on the feed', () => {
  const watcher = reader('spoilerwatcher');
  const writer = reader('spoilerwriter');
  run(`INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      watcher.id, writer.id);

  const w = run('INSERT INTO works (title) VALUES (?)', 'Twisty').lastInsertRowid;
  run(`INSERT INTO reviews (id, user_id, work_id, pass, body, body_html, published_at,
                            contains_spoilers, spoiler_through_page)
       VALUES ('rev-spoil', ?, ?, 1, ?, '<p>x</p>', ?, 1, 200)`,
      writer.id, w, 'The killer is the brother.', sqlTime(Date.now() - 3600_000));

  const entries = latestFor(as(watcher)).entries;
  assert.ok(!entries.some((e) => e.review_id === 'rev-spoil'),
    'a gated review is not summarised on a surface with no gate');
});

test('§8 — a caption is one sentence or nothing', () => {
  const watcher = reader('captionwatcher');
  const writer = reader('captionwriter');
  run(`INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')`,
      watcher.id, writer.id);

  const w = run('INSERT INTO works (title) VALUES (?)', 'Captioned').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, visibility, review)
       VALUES (?, ?, 'FINISHED', ?, 0, 'public', ?)`,
      writer.id, w, sqlTime(Date.now() - 3600_000),
      'Different book at thirty than it was at nineteen. Then a great deal more that belongs on the review itself.');

  const entry = latestFor(as(watcher)).entries.find((e) => e.work_id === w);
  assert.equal(entry.caption, 'Different book at thirty than it was at nineteen.');
  assert.ok(!/\.\.\.|…/.test(entry.caption), 'never a mid-word truncation');
});

// ── §12 — THE GATE, AND WHO IT IS FOR ────────────────────

test('§12 — the instance operator is not a probationary account', () => {
  const day1 = A.createUser({ email: 'operator@example.test', passwordHash: 'x' });
  A.markVerified(day1.id);
  A.setUsername(day1.id, 'operator');
  // Brand new, no books, no reviews: Trust 0 by every rule in the table.
  run('UPDATE users SET created_at = ?, books_logged = 0, reviews_published = 0 WHERE id = ?',
      sqlTime(Date.now()), day1.id);

  const before = get('SELECT * FROM users WHERE id = ?', day1.id);
  assert.equal(T.can(T.levelOf(before), 'canCreateClub'), false);

  run('UPDATE users SET is_owner = 1 WHERE id = ?', day1.id);
  const after = get('SELECT * FROM users WHERE id = ?', day1.id);

  assert.equal(T.levelOf(after), 3, 'ownership is answered without waiting for a sweep');
  assert.equal(T.can(T.levelOf(after), 'canCreateClub'), true);
  assert.ok(C.create(after, { name: 'The operator club' }).ok);
});

test('§12 — ownership does not leak to anyone else', () => {
  const ordinary = reader('ordinary', { trust: 0, books: 0, ageDays: 0 });
  assert.equal(T.levelOf(ordinary), 0);
  assert.equal(C.create(ordinary, { name: 'Too soon' }).ok, false);
});

test('§12 — a gate says what it is waiting on, and never says a level', () => {
  const fresh = reader('freshgate', { trust: 0, books: 0, ageDays: 0 });
  // The fixture publishes reviews by default; a genuinely new account has
  // written none, and the message has to name that too.
  run('UPDATE users SET reviews_published = 0 WHERE id = ?', fresh.id);
  const why = T.whyNot(get('SELECT * FROM users WHERE id = ?', fresh.id), 'canCreateClub');

  assert.ok(why, 'a locked door that says nothing is indistinguishable from a missing feature');
  assert.match(why, /fortnight/);
  assert.match(why, /books logged/);
  assert.match(why, /reviews written/);

  // §12 — "Never display a level ... it becomes a status game the moment
  // it is visible."
  assert.ok(!/trust|level/i.test(why), why);

  // It names only what is actually outstanding.
  const partway = reader('partway', { trust: 0, books: 40, ageDays: 400 });
  run('UPDATE users SET reviews_published = 0 WHERE id = ?', partway.id);
  const why2 = T.whyNot(get('SELECT * FROM users WHERE id = ?', partway.id), 'canCreateClub');
  assert.match(why2, /reviews written/);
  assert.ok(!/fortnight/.test(why2), 'a requirement already met is not listed');
  assert.ok(!/books logged/.test(why2));
});

test('§12 — nothing is said to someone who can already do it', () => {
  const able = reader('ablegate', { trust: 2 });
  assert.equal(T.whyNot(able, 'canCreateClub'), null);
});

test('§12 — a limited account is told that, not a checklist', () => {
  const limited = reader('limitedgate', { trust: -1 });
  assert.match(T.whyNot(limited, 'canCreateClub'), /read-only/i);
});
