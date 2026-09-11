import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB, makeUser } from './helpers.js';

useTempDB();
// Capture the real housekeeping callback so time-window tests don't wait a day.
const originalInterval = globalThis.setInterval;
let sweepLimits;
globalThis.setInterval = (callback, delay, ...args) => {
  if (delay === 600_000) sweepLimits = callback;
  return originalInterval(callback, delay, ...args);
};
let RL;
try { RL = await import('../lib/auth/ratelimit.js'); }
finally { globalThis.setInterval = originalInterval; }
const { db, run, get, all, sqlTime } = await import('../db/index.js');
const R = await import('../lib/reco.js');
const PILE = await import('../lib/reco-pile.js');
const EMB = await import('../lib/embeddings.js');
const { likesDigest } = await import('../lib/jobs.js');
const { purgeUser } = await import('../lib/purge.js');
const SAFE = await import('../lib/safety.js');

const work = title => Number(run('INSERT INTO works (title) VALUES (?)', title).lastInsertRowid);
const reader = handle => makeUser(db, { handle, visibility: 'public' });
function waiting(user, wid) {
  run("INSERT OR IGNORE INTO shelves (user_id, name, slug) VALUES (?, 'Waiting', 'waiting')", user.id);
  const shelf = get("SELECT id FROM shelves WHERE user_id = ? AND slug = 'waiting'", user.id);
  run('INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, ?)', shelf.id, wid);
}
function storedPile(user, ids) {
  const id = Number(run("INSERT INTO reco_runs (surface, user_id, kinds, probe_ver) VALUES ('pile', ?, '{}', 'test')", user.id).lastInsertRowid);
  ids.forEach((wid, i) => run(`INSERT INTO reco_items (run_id, work_id, rank, score, per_kind, neighbours)
    VALUES (?, ?, ?, 0.5, '{}', '[]')`, id, wid, i + 1));
  return id;
}

test('imported WAITING readings remain eligible for the unread pile', () => {
  const user = reader('pileimport');
  const unread = work('Imported unread'), finished = work('Previously read');
  for (const [wid, status] of [[unread, 'WAITING'], [finished, 'FINISHED']]) {
    waiting(user, wid);
    run('INSERT INTO readings (user_id, work_id, status) VALUES (?, ?, ?)', user.id, wid, status);
  }
  assert.deepEqual(R.pileOf(user.id).map(r => r.work_id), [unread]);
});

test('stored pile suggestions omit books already started or removed without reranking the rest', () => {
  const user = reader('pilestale');
  const [started, removed, keep] = ['Started', 'Removed', 'Keep'].map(work);
  for (const wid of [started, removed, keep]) waiting(user, wid);
  const id = storedPile(user, [started, removed, keep]);
  run("INSERT INTO readings (user_id, work_id, status) VALUES (?, ?, 'READING')", user.id, started);
  run('DELETE FROM shelf_items WHERE work_id = ?', removed);
  assert.deepEqual(PILE.latest(user.id, { limit: 1 }).map(r => r.work_id), [keep]);
  assert.equal(get('SELECT COUNT(*) n FROM reco_items WHERE run_id = ?', id).n, 3, 'stored ranking remains intact');
});

test('missing embedding vectors do not shift the weights of the remaining vectors', () => {
  const centre = EMB.centroid([null, [1, 0], [0, 1]], [50, 1, 3]);
  assert.ok(Math.abs(centre[0] - 1 / Math.sqrt(10)) < 1e-6);
  assert.ok(Math.abs(centre[1] - 3 / Math.sqrt(10)) < 1e-6);
});

test('purge removes new recommendation runs and their stored explanations only for that reader', () => {
  const gone = reader('recopurge'), kept = reader('recokept');
  const wid = work('Recommendation');
  const removedRun = storedPile(gone, [wid]), keptRun = storedPile(kept, [wid]);
  purgeUser(gone.id);
  assert.equal(get('SELECT COUNT(*) n FROM reco_runs WHERE user_id = ?', gone.id).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM reco_items WHERE run_id = ?', removedRun).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM reco_items WHERE run_id = ?', keptRun).n, 1);
});

test('daily limits survive hourly housekeeping and expire after their full window', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  RL.__reset();
  assert.equal(RL.check('exportRun', 'daily-test').ok, true);
  assert.equal(RL.check('exportRun', 'daily-test').ok, true);
  now += 2 * 3600_000;
  sweepLimits();
  assert.equal(RL.check('exportRun', 'daily-test').ok, false);
  now += 23 * 3600_000;
  sweepLimits();
  assert.equal(RL.check('exportRun', 'daily-test').ok, true);
});

test('likes digests cover time since the last digest and count people rather than likes', () => {
  const user = reader('digestwriter'), fan = reader('digestfan');
  const now = Date.now();
  run('UPDATE users SET digest_likes = 1, digest_likes_at = ? WHERE id = ?', sqlTime(now - 3 * 86400_000), user.id);
  SAFE.setPrefs(user.id, ['likes_digest']);
  const wid = work('A reviewed book');
  for (const suffix of ['one', 'two']) {
    const rid = `sweep-review-${suffix}`;
    run('INSERT INTO reviews (id, user_id, work_id, pass, body) VALUES (?, ?, ?, ?, ?)', rid, user.id, wid, suffix === 'one' ? 1 : 2, 'A review');
    run('INSERT INTO review_likes (review_id, user_id, created_at) VALUES (?, ?, ?)', rid, fan.id, sqlTime(now - 2 * 86400_000));
  }
  assert.equal(likesDigest({ now }), 1);
  const notification = get("SELECT subject, url FROM notifications WHERE user_id = ? AND kind = 'likes_digest'", user.id);
  assert.equal(notification.subject, 'One person liked something you wrote');
  assert.equal(notification.url, `/@${user.username}`);
  assert.equal(likesDigest({ now: now + 3600_000 }), 0, 'no duplicate digest inside one day');
});
