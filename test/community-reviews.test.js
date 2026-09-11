import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run, sqlTime } = await import('../db/index.js');
const M = await import('../lib/markdown.js');
const R = await import('../lib/reviews.js');
const AGG = await import('../lib/aggregates.js');
const F = await import('../lib/following.js');
const SAFE = await import('../lib/safety.js');
const T = await import('../lib/trust.js');
const V = await import('../lib/visibility.js');
const NOTES = await import('../lib/notes.js');
const A = await import('../lib/accounts.js');

// Ids are assigned by SQLite rather than counted here: the import test
// creates four hundred works of its own, and a hand-rolled counter collides
// with them.
function book(title, { author = 'An Author' } = {}) {
  run('INSERT INTO works (title) VALUES (?)', title);
  const id = get('SELECT id FROM works ORDER BY id DESC LIMIT 1').id;
  run('INSERT INTO people (name) VALUES (?)', author);
  const pid = get('SELECT id FROM people ORDER BY id DESC LIMIT 1').id;
  run(`INSERT INTO work_people (work_id, person_id, role, ord) VALUES (?, ?, 'AUTHOR', 0)`, id, pid);
  return id;
}

function reader(handle, { trust = 2, ageDays = 400, visibility = 'public', name = null } = {}) {
  const u = A.createUser({ email: `${handle}@example.test`, passwordHash: 'x' });
  A.markVerified(u.id);
  A.setUsername(u.id, handle);
  run(
    `UPDATE users SET trust_level = ?, created_at = ?, profile_visibility = ?,
                      books_logged = 40, reviews_published = 5, display_name = ?
      WHERE id = ?`,
    trust, sqlTime(Date.now() - ageDays * 86_400_000), visibility, name, u.id
  );
  return get('SELECT * FROM users WHERE id = ?', u.id);
}

const rate = (user, workId, stars, { finished = '2026-01-01' } = {}) => {
  run(
    `INSERT INTO readings (user_id, work_id, status, stars, finished_at, pass_number)
     VALUES (?, ?, 'FINISHED', ?, ?, 1)
     ON CONFLICT (user_id, work_id, pass_number) DO UPDATE SET stars = excluded.stars`,
    user.id, workId, stars, finished
  );
};

const as = (u) => ({ id: u.id, isMember: true, trust: u.trust_level });

const alice = reader('alice');
const bob = reader('bob');
const w1 = book('A Shared Book');

// ── §4.1 — THE BOUNDARY ──────────────────────────────────

test('§19 — importing 400 reviews publishes zero reviews', async () => {
  const IMPORT = await import('../lib/import.js');
  const { runImport } = await import('../lib/import-run.js');

  const rows = ['Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,My Review,Date Added'];
  for (let i = 0; i < 400; i++) {
    rows.push(`${i},"Imported ${i}","Author ${i}",,,4,read,"A strong opinion about book ${i}",2020/01/01`);
  }

  const a = IMPORT.analyse(rows.join('\r\n') + '\r\n');
  const mapping = Object.fromEntries(a.mapping.map((m) => [m.value, m.status]));
  const result = await runImport(alice.id, a.rows, mapping);

  assert.equal(result.imported, 400);
  assert.equal(
    get('SELECT COUNT(*) n FROM reviews WHERE user_id = ?', alice.id).n, 0,
    'a reader who imports 400 reviews has not consented to publishing 400 reviews'
  );

  // They landed as notes, private and marked imported.
  const noted = get(
    `SELECT COUNT(*) n FROM readings WHERE user_id = ? AND note_imported = 1`, alice.id
  ).n;
  assert.ok(noted >= 400, 'they are notes');
});

test('§4.1 — promoting a note copies it; the note is untouched', () => {
  const w = book('Noted Book');
  run(`INSERT INTO readings (user_id, work_id, status, stars, pass_number)
       VALUES (?, ?, 'FINISHED', 5, 1)`, bob.id, w);
  const reading = get('SELECT * FROM readings WHERE user_id = ? AND work_id = ?', bob.id, w);
  NOTES.setNote(reading.id, 'A private thought I might publish.');

  const composer = R.composerFromNote(bob.id, w);
  assert.equal(composer.body, 'A private thought I might publish.');
  assert.equal(composer.fromNote, true);

  // Nothing is published by opening a composer.
  assert.equal(get('SELECT COUNT(*) n FROM reviews WHERE user_id = ? AND work_id = ?', bob.id, w).n, 0);

  // Publishing creates a NEW record and leaves the note as it was.
  R.publish(bob, { workId: w, body: 'An edited, public version.' });
  assert.equal(get('SELECT COUNT(*) n FROM reviews WHERE user_id = ? AND work_id = ?', bob.id, w).n, 1);
  assert.equal(
    NOTES.noteOf(get('SELECT * FROM readings WHERE id = ?', reading.id)),
    'A private thought I might publish.',
    'the note stays private and unchanged'
  );
});

test('§19 — no note is readable through any community surface', () => {
  const w = book('Secret Note Book');
  run(`INSERT INTO readings (user_id, work_id, status, pass_number) VALUES (?, ?, 'FINISHED', 1)`,
      bob.id, w);
  const reading = get('SELECT * FROM readings WHERE user_id = ? AND work_id = ?', bob.id, w);
  const SEEDED = 'zarquon-the-distinctive-string';
  NOTES.setNote(reading.id, `A note containing ${SEEDED} and nothing else.`);

  R.publish(bob, { workId: w, body: 'A public review that says something else.' });

  const surfaces = [
    JSON.stringify(R.forWork(w, as(alice))),
    JSON.stringify(R.byUser(bob.id, as(alice))),
    JSON.stringify(R.topForWork(w, as(alice))),
    JSON.stringify(AGG.display(w)),
    JSON.stringify(F.counts(bob.id)),
    JSON.stringify(SAFE.notificationsFor(alice.id))
  ];

  for (const s of surfaces) {
    assert.ok(!s.includes(SEEDED), 'a note reached a community surface');
  }
});

// ── §4.2 — THE REVIEW OBJECT ─────────────────────────────

test('§4.2 — one review per user per book PER PASS', () => {
  const w = book('Reread Book');
  R.publish(alice, { workId: w, pass: 1, body: 'At nineteen, this was everything.' });
  R.publish(alice, { workId: w, pass: 2, body: 'At thirty-four, less so.' });

  const rows = all('SELECT * FROM reviews WHERE user_id = ? AND work_id = ? ORDER BY pass', alice.id, w);
  assert.equal(rows.length, 2, 'a second pass is a second review, not an overwrite');
  assert.equal(rows[0].body, 'At nineteen, this was everything.');
});

test('§4.2 — deleting keeps a tombstone so counts do not orphan', () => {
  const w = book('Deleted Review Book');
  const { id } = R.publish(alice, { workId: w, body: 'Something I later withdrew.' });
  R.like(id, bob.id);

  R.remove(id, alice.id);

  const row = get('SELECT * FROM reviews WHERE id = ?', id);
  assert.ok(row, 'the row survives');
  assert.equal(row.body, '', 'the text does not');
  assert.equal(row.body_html, null);
  assert.ok(row.deleted_at);
  assert.equal(get('SELECT COUNT(*) n FROM review_likes WHERE review_id = ?', id).n, 1,
    'and the like has something to point at');

  assert.equal(R.forWork(w, as(bob)).length, 0, 'but it is gone from the page');
});

test('§4.2 — an edit keeps the previous body for moderation', () => {
  const w = book('Edited Book');
  const { id } = R.publish(alice, { workId: w, body: 'The first thing I said.' });
  R.publish(alice, { workId: w, body: 'The second thing I said.' });

  const revisions = all('SELECT * FROM review_revisions WHERE review_id = ?', id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].body, 'The first thing I said.');
  assert.ok(get('SELECT edited_at FROM reviews WHERE id = ?', id).edited_at);
});

// ── §13.3 — AUTHORS ──────────────────────────────────────

test('§19 — an account credited as author cannot rate or review its own book', () => {
  const w = book('My Own Book', { author: 'Sylvia Author' });
  const author = reader('sylvia_author', { name: 'Sylvia Author' });

  const out = R.publish(author, { workId: w, body: 'A masterpiece, obviously.' });
  assert.equal(out.ok, false);
  assert.match(out.error, /credited on this book/);

  // And somebody else can.
  assert.equal(R.publish(bob, { workId: w, body: 'It was fine.' }).ok, true);
});

// ── §6 — SPOILERS ────────────────────────────────────────

test('§19 — a reader at page 40 sees a chapter-12 review masked; one at 300 does not', () => {
  const w = book('Spoiler Book');
  const early = reader('early_reader');
  const late = reader('late_reader');

  run(`INSERT INTO readings (user_id, work_id, status, current_page, pass_number)
       VALUES (?, ?, 'READING', 40, 1)`, early.id, w);
  run(`INSERT INTO readings (user_id, work_id, status, current_page, pass_number)
       VALUES (?, ?, 'READING', 300, 1)`, late.id, w);

  const review = {
    contains_spoilers: 1, spoiler_through_page: 210, spoiler_through_chapter: null
  };

  const forEarly = R.spoilerState(review, R.progressOf(early.id, w));
  assert.equal(forEarly.masked, true);
  assert.match(forEarly.label, /through page 210/);

  const forLate = R.spoilerState(review, R.progressOf(late.id, w));
  assert.equal(forLate.masked, false);
});

test('§6 — a viewer with nothing logged is treated as at page zero', () => {
  const w = book('Unread Book');
  const stranger = reader('stranger_reader');
  assert.equal(R.progressOf(stranger.id, w), 0);

  const state = R.spoilerState({ contains_spoilers: 1, spoiler_through_page: 10 }, 0);
  assert.equal(state.masked, true, 'not shown everything for want of a record');
});

test('§6 — someone who finished it is past every point', () => {
  const w = book('Finished Book');
  const done = reader('finished_reader');
  run(`INSERT INTO readings (user_id, work_id, status, current_page, pass_number)
       VALUES (?, ?, 'FINISHED', 12, 1)`, done.id, w);

  const state = R.spoilerState({ contains_spoilers: 1, spoiler_through_page: 900 },
                                R.progressOf(done.id, w));
  assert.equal(state.masked, false);
});

test('§6 — a blanket spoiler flag with no position is always masked', () => {
  const state = R.spoilerState({ contains_spoilers: 1 }, Number.MAX_SAFE_INTEGER);
  assert.equal(state.masked, true, 'there is nothing to compare against');
});

// ── §5 — AGGREGATES ──────────────────────────────────────

test('§19 — a book with 12 eligible ratings displays no aggregate', () => {
  const w = book('Thinly Rated');
  for (let i = 0; i < 12; i++) {
    rate(reader(`thin${i}`), w, 4);
  }
  const d = AGG.display(w);
  assert.equal(d.suppressed, true);
  assert.equal(d.median, null, 'no number at all, not a number with a caveat');
  assert.equal(d.count, 12);
  assert.ok(d.distribution.some((n) => n > 0), 'the distribution is still shown');
});

test('§5 — above the threshold, a median and a distribution', () => {
  const w = book('Well Rated');
  for (let i = 0; i < 25; i++) rate(reader(`well${i}`), w, i % 5 + 1);

  const d = AGG.display(w);
  assert.equal(d.suppressed, false);
  assert.ok(d.median != null);
  assert.equal(d.count, 25);
  assert.equal(d.distribution.reduce((a, b) => a + b, 0), 25);
});

test('§19 — an account under 14 days old contributes nothing to any aggregate', () => {
  const w = book('Fresh Voter Book');
  for (let i = 0; i < 25; i++) rate(reader(`mature${i}`), w, 5);
  const before = AGG.recompute(w).eligible_count;

  for (let i = 0; i < 20; i++) rate(reader(`fresh${i}`, { ageDays: 2, trust: 2 }), w, 1);
  const after = AGG.recompute(w).eligible_count;

  assert.equal(after, before, 'twenty new accounts changed nothing');
});

test('§19 — 50 accounts rating one book 1 star move the aggregate by zero and flag it', () => {
  const w = book('Bombed Book');

  // A settled history: thirty mature accounts, mostly positive.
  for (let i = 0; i < 30; i++) {
    rate(reader(`settled${i}`), w, 4);
    run(`UPDATE readings SET created_at = ? WHERE user_id = ? AND work_id = ?`,
        sqlTime(Date.now() - 20 * 86_400_000), get('SELECT id FROM users WHERE username = ?', `settled${i}`).id, w);
  }
  AGG.recompute(w);
  const before = AGG.display(w).median;
  assert.ok(before >= 4);

  // Then fifty accounts, created within the hour, all rating 1.
  for (let i = 0; i < 50; i++) rate(reader(`mob${i}`, { ageDays: 0, trust: 2 }), w, 1);

  const finding = AGG.detectBombing(w);
  assert.ok(finding, 'the pattern is detected');
  assert.ok(finding.velocity > 5, `velocity ${finding.velocity}`);
  assert.ok(finding.new_share > 0.4, `new-account share ${finding.new_share}`);

  AGG.freeze(w, finding);
  const after = AGG.display(w);

  assert.equal(after.frozen, true);
  assert.equal(after.median, before, 'the displayed number did not move');
  assert.match(after.notice, /under review/);

  // §13.1 — the flag names the contributing accounts for a human.
  const flag = get(`SELECT * FROM bombing_flags WHERE work_id = ? AND state = 'open'`, w);
  assert.ok(flag);
  assert.ok(JSON.parse(flag.accounts).length >= 50);
});

test('§5 — no page ranks books by aggregate', async () => {
  const fs = (await import('node:fs')).promises;
  const files = await fs.readdir('lib');
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = (await fs.readFile(`lib/${f}`, 'utf8')).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    assert.ok(!/ORDER BY[^;]*(trimmed_mean|median)\b/i.test(src),
      `lib/${f} orders by an aggregate — a leaderboard is a target`);
  }
});

// ── §7 — LIKES AND RANKING ───────────────────────────────

test('§19 — top reviews differ between two viewers who follow different people', () => {
  const w = book('Contested Book');
  const authors = [];
  for (let i = 0; i < 5; i++) {
    const a = reader(`writer${i}`, { trust: 3 });
    authors.push(a);
    R.publish(a, { workId: w, body: `A considered opinion number ${i}, of reasonable length.` });
  }

  const viewerA = reader('viewer_a');
  const viewerB = reader('viewer_b');
  F.follow(viewerA, authors[4].id);
  F.follow(viewerB, authors[0].id);

  const forA = R.topForWork(w, as(viewerA));
  const forB = R.topForWork(w, as(viewerB));

  assert.equal(forA.following[0]?.user_id, authors[4].id);
  assert.equal(forB.following[0]?.user_id, authors[0].id);
  assert.notEqual(forA.following[0]?.id, forB.following[0]?.id,
    'there is no single top slot to attack');
});

test('§7 — a like count is public; who liked it is not, beyond who you follow', () => {
  const w = book('Liked Book');
  const author = reader('liked_author', { trust: 3 });
  const { id } = R.publish(author, { workId: w, body: 'Something people liked.' });

  const likers = [reader('liker1'), reader('liker2'), reader('liker3')];
  for (const l of likers) R.like(id, l.id);

  const viewer = reader('like_viewer');
  F.follow(viewer, likers[0].id);

  const count = get('SELECT like_count FROM reviews WHERE id = ?', id).like_count;
  assert.equal(count, 3, 'the count is the true total');

  const visible = R.likersVisibleTo(id, as(viewer));
  assert.equal(visible.length, 1, 'and only the followed one is named');
  assert.equal(visible[0].username, 'liker1');
});

// ── §15 — BLOCKS ON THE BOOK PAGE ────────────────────────

test('§19 — a blocked user sees none of the blocker\'s reviews on any book page', () => {
  const w = book('Blocked Review Book');
  R.publish(alice, { workId: w, body: 'Alice on this book.' });
  R.publish(bob, { workId: w, body: 'Bob on this book.' });

  assert.equal(R.forWork(w, as(bob)).length, 2, 'before the block');

  SAFE.block(alice.id, bob.id);
  const forBob = R.forWork(w, as(bob));
  assert.equal(forBob.length, 1, "alice's review is gone");
  assert.equal(forBob[0].user_id, bob.id);

  const forAlice = R.forWork(w, as(alice));
  assert.equal(forAlice.length, 1, 'and it is mutual');

  SAFE.unblock(alice.id, bob.id);
});

test('§19 — a private account\'s review does not appear to a signed-out visitor', () => {
  const w = book('Private Reviewer Book');
  const hidden = reader('hidden_reviewer', { visibility: 'private' });
  R.publish(hidden, { workId: w, body: 'A review from a private account.' });

  assert.equal(R.forWork(w, V.ANONYMOUS).length, 0);
  assert.equal(R.forWork(w, as(hidden)).length, 1, 'but its author sees it');
});

// ── §12 — TRUST GATES ────────────────────────────────────

test('§19 — an account below Trust 2 cannot post a link', () => {
  const w = book('Link Book');
  const low = reader('low_trust', { trust: 1 });

  R.publish(low, { workId: w, body: 'Read more at [my site](https://spam.example).' });
  const row = get('SELECT body_html FROM reviews WHERE user_id = ? AND work_id = ?', low.id, w);

  assert.ok(!row.body_html.includes('<a '), 'the link is dropped to its label');
  assert.ok(row.body_html.includes('my site'), 'and nobody loses what they wrote');
});

test('§12 — a limited account cannot publish at all', () => {
  const w = book('Limited Book');
  const limited = reader('limited_one', { trust: -1 });
  const out = R.publish(limited, { workId: w, body: 'Anything.' });
  assert.equal(out.ok, false);
  assert.match(out.error, /read-only/);
});

// ── §3 — FOLLOWING ───────────────────────────────────────

test('§3 — public follows are instant; private ones are requests', () => {
  const open = reader('open_account');
  const shut = reader('shut_account', { visibility: 'private' });
  const seeker = reader('seeker');

  assert.equal(F.follow(seeker, open.id).state, 'active');
  assert.equal(F.follow(seeker, shut.id).state, 'requested');

  assert.equal(F.pendingRequests(shut.id).length, 1);
  F.approve(shut.id, seeker.id);
  assert.equal(F.relationship(seeker.id, shut.id).following, true);
});

test('§3 — declining is silent', () => {
  const shut = reader('shut_two', { visibility: 'private' });
  const seeker = reader('seeker_two');
  F.follow(seeker, shut.id);

  const before = SAFE.notificationsFor(seeker.id).length;
  F.decline(shut.id, seeker.id);

  assert.equal(F.pendingRequests(shut.id).length, 0);
  assert.equal(SAFE.notificationsFor(seeker.id).length, before,
    'no notification to the requester');
});

test('§15 — following across a block fails as if the account does not exist', () => {
  const a = reader('blocker_f');
  const b = reader('blocked_f');
  SAFE.block(a.id, b.id);

  assert.throws(() => F.follow(b, a.id), (e) => e.status === 404);
  SAFE.unblock(a.id, b.id);
});

test('§8 — follower lists paginate with opaque cursors, not offsets', () => {
  const popular = reader('popular_one');
  for (let i = 0; i < 45; i++) {
    const f = reader(`fan${i}`);
    F.follow(f, popular.id);
  }

  const page1 = F.followers(popular.id, as(popular));
  assert.equal(page1.rows.length, 40);
  assert.ok(page1.next, 'there is a cursor');
  assert.ok(!/^\d+$/.test(page1.next), 'and it is not an offset');

  const page2 = F.followers(popular.id, as(popular), { cursor: page1.next });
  assert.ok(page2.rows.length > 0);
  const overlap = page2.rows.filter((r) => page1.rows.some((x) => x.follower_id === r.follower_id));
  assert.equal(overlap.length, 0, 'and the pages do not overlap');
});

test('§8 — list depth is capped for anyone who is not the owner', () => {
  const popular = get(`SELECT * FROM users WHERE username = 'popular_one'`);
  const stranger = reader('nosy');

  const deep = F.followers(popular.id, as(stranger), { page: 5 });
  assert.equal(deep.capped, true, 'a scraper cannot walk the whole graph');
  assert.equal(F.followers(popular.id, as(popular), { page: 5 }).capped, false,
    'but the owner can see their own');
});

test('§2.1 — no reputation number is rendered on a profile', async () => {
  const fs = (await import('node:fs')).promises;
  const src = await fs.readFile('views/profile.ejs', 'utf8').catch(() => '');
  const body = src.replace(/<%#[\s\S]*?%>/g, '');
  assert.ok(!/reviewer|leaderboard|rank\b|badge|verified/i.test(body),
    'reviewer ranking is what created the bot-account economy');
});
