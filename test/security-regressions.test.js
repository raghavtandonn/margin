import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB, makeUser } from './helpers.js';

useTempDB();
const { db, get, all, run } = await import('../db/index.js');
const N = await import('../lib/notes.js');
const V = await import('../lib/vectors.js');
const D = await import('../lib/desk.js');
const S = await import('../lib/seasons.js');
const LB = await import('../lib/lookbook-seasonal.js');
const L = await import('../lib/library.js');
const C = await import('../lib/clubs.js');
const READERS = await import('../lib/readers.js');
const { purgeUser } = await import('../lib/purge.js');
const { zip, unzip } = await import('../lib/zip.js');
const { spawnSync } = await import('node:child_process');
const { privateText } = await import('../lib/crypto.js');
const { libraryBaseline } = await import('../lib/season-colour-note.js');
const { Router } = await import('../lib/router.js');
const { addressAllowlist } = await import('../lib/network.js');

const alice = makeUser(db, { handle: 'securityalice', visibility: 'public' });
const bob = makeUser(db, { handle: 'securitybob', visibility: 'private' });
const anonymous = { id: null, isMember: false };
function book(user, { title = 'A catalogue title', visibility = 'inherit', pass = 1, work = null } = {}) {
  const wid = work ?? Number(run('INSERT INTO works (title) VALUES (?)', title).lastInsertRowid);
  const rid = Number(run(`INSERT INTO readings
    (user_id, work_id, status, pass_number, stars, finished_at, visibility)
    VALUES (?, ?, 'FINISHED', ?, 4, '2025-08-10', ?)`, user.id, wid, pass, visibility).lastInsertRowid);
  return { wid, rid };
}

test('season colour baselines use only the requested owner and fail closed without one', () => {
  const first = makeUser(db, { handle: 'baselinefirst', visibility: 'public' });
  const second = makeUser(db, { handle: 'baselinesecond', visibility: 'private' });
  for (const [user, colour] of [[first, 'grief'], [second, 'dread']]) {
    const { wid } = book(user);
    run('UPDATE works SET colour_components = ? WHERE id = ?', JSON.stringify([{ id: colour, weight: 1 }]), wid);
    const season = S.ensureSeason(user.id, S.parseCode('aw25'));
    S.syncFrames(season, S.readingsIn(user.id, season));
  }
  assert.deepEqual([...libraryBaseline(first.id)], [['grief', 1]]);
  assert.deepEqual([...libraryBaseline(second.id)], [['dread', 1]]);
  assert.equal(libraryBaseline(), null);
});

test('private note search is scoped to its owner and remains current after edits', () => {
  const { rid } = book(bob);
  N.setNote(rid, 'quartzfalcon confidential diary sentence');
  V.reindex();
  assert.equal(D.search(alice.id, 'quartzfalcon').rows.length, 0);
  assert.match(D.search(bob.id, 'quartzfalcon').rows[0]?.noteExcerpt || '', /confidential diary/);
  N.setNote(rid, null);
  assert.equal(D.search(bob.id, 'quartzfalcon').rows.length, 0);
});

test('building the search index does not persist private note plaintext or vocabulary', () => {
  const { rid } = book(bob);
  N.setNote(rid, 'velvetkestrel confidential diary sentence');
  V.reindex();
  const stored = JSON.stringify(all('SELECT * FROM desk_vectors'));
  assert.ok(!stored.includes('velvetkestrel'));
});

test('lookbook previews ignore legacy read privacy but exclude hidden frames and private notes', () => {
  const privateBook = book(alice, { title: 'Private seasonal title', visibility: 'private' });
  const hiddenBook = book(alice, { title: 'Hidden seasonal title' });
  const publicBook = book(alice, { title: 'Public seasonal title' });
  N.setNote(publicBook.rid, 'This sentence must remain private.');
  const season = S.ensureSeason(alice.id, S.parseCode('aw25'));
  S.syncFrames(season, S.readingsIn(alice.id, season));
  run('UPDATE season_frames SET hidden = 1 WHERE reading_id = ?', hiddenBook.rid);
  const catalogue = LB.build(alice.id, 'aw25', { owner: false, viewer: anonymous });
  assert.ok(catalogue.looks.some(l => l.work.id === publicBook.wid));
  assert.ok(catalogue.looks.some(l => l.work.id === privateBook.wid));
  assert.ok(!catalogue.looks.some(l => l.work.id === hiddenBook.wid));
  assert.ok(!JSON.stringify(catalogue).includes('This sentence must remain private.'));
});

test('reading history includes all passes regardless of legacy read privacy', () => {
  const user = makeUser(db, { handle: 'receiptaudit', visibility: 'public' });
  const { wid } = book(user);
  book(user, { work: wid, pass: 2, visibility: 'private' });
  book(user, { title: 'Private receipt title', visibility: 'private' });
  const receipt = L.getReceipt(user.id, { year: 2025, viewer: anonymous });
  assert.equal(receipt.lines.length, 3);
  assert.equal(receipt.totals.finished, 3);
});

test('hard deletion removes imported notes, community bodies, and derived season records', () => {
  const user = makeUser(db, { handle: 'purgeaudit' });
  const { wid } = book(user);
  run('INSERT INTO reading_notes (user_id, work_id, body) VALUES (?, ?, ?)', user.id, wid, 'Private imported note');
  run('INSERT INTO reviews (id, user_id, work_id, body) VALUES (?, ?, ?, ?)', 'purge-review', user.id, wid, 'Review to delete');
  run('INSERT INTO review_revisions (id, review_id, body) VALUES (?, ?, ?)', 'purge-revision', 'purge-review', 'Old review');
  S.ensureSeason(user.id, S.parseCode('aw25'));
  purgeUser(user.id);
  assert.equal(get('SELECT COUNT(*) n FROM reading_notes WHERE user_id = ?', user.id).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM reviews WHERE user_id = ?', user.id).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM review_revisions WHERE review_id = ?', 'purge-review').n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM seasons WHERE user_id = ?', user.id).n, 0);
});

test('ZIP extraction rejects declared lengths that differ from decompressed content', () => {
  const archive = zip([{ name: 'notes.json', data: 'x'.repeat(4096) }]);
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(1, central + 24);
  assert.throws(() => unzip(archive));
});

test('a reaction cannot address a post belonging to another club', () => {
  run(`INSERT INTO clubs (id, slug, slug_skeleton, name, host_id) VALUES
    ('audit-club-a', 'audit-a', 'audita', 'Audit A', ?),
    ('audit-club-b', 'audit-b', 'auditb', 'Audit B', ?)`, alice.id, bob.id);
  run(`INSERT INTO club_members (club_id, user_id, role) VALUES ('audit-club-a', ?, 'host')`, alice.id);
  run(`INSERT INTO club_posts (id, club_id, user_id, body) VALUES ('audit-post-b', 'audit-club-b', ?, 'Private club post')`, bob.id);
  const result = C.react(alice.id, 'audit-post-b', 'agreed', { clubId: 'audit-club-a' });
  assert.equal(result.ok, false);
  assert.equal(get('SELECT COUNT(*) n FROM post_reactions WHERE post_id = ?', 'audit-post-b').n, 0);
});

test('startup migrates legacy plaintext note copies without losing their contents', () => {
  const { wid, rid } = book(bob);
  run('INSERT INTO reading_notes (user_id, work_id, body) VALUES (?, ?, ?)', bob.id, wid, 'Legacy imported sentence');
  run('INSERT INTO sessions (reading_id, position, note) VALUES (?, 1, ?)', rid, 'Legacy session sentence');
  const season = S.ensureSeason(bob.id, S.parseCode('aw25'));
  run('INSERT INTO season_frames (season_id, reading_id, work_id, ordinal, caption) VALUES (?, ?, ?, 1, ?)',
    season.id, rid, wid, 'Legacy caption sentence');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./db/index.js')"], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  for (const [table, column, where, value] of [
    ['reading_notes', 'body', 'work_id', wid], ['sessions', 'note', 'reading_id', rid], ['season_frames', 'caption', 'reading_id', rid]
  ]) {
    const row = get(`SELECT ${column} AS value, typeof(${column}) AS kind FROM ${table} WHERE ${where} = ?`, value);
    assert.equal(row.kind, 'blob');
    assert.match(privateText(row.value), /^Legacy /);
  }
});

test('rejected async route handlers are forwarded to error middleware', async () => {
  const router = Router();
  const failure = new Error('Validation failed');
  router.get('/validation', async () => { throw failure; });
  const error = await new Promise(resolve => router.handle({ method: 'GET', url: '/validation' }, {}, resolve));
  assert.equal(error, failure);
});

test('staff address allowlists use exact addresses and real network prefixes', () => {
  const exact = addressAllowlist(['10.0.0.1']);
  assert.equal(exact('10.0.0.1'), true);
  assert.equal(exact('10.0.0.10'), false);
  assert.equal(exact('::ffff:10.0.0.1'), true);
  const subnet = addressAllowlist(['192.168.2.0/24', '2001:db8::/32']);
  assert.equal(subnet('192.168.2.10'), true);
  assert.equal(subnet('192.168.3.10'), false);
  assert.equal(subnet('2001:db8::1'), true);
  assert.throws(() => addressAllowlist(['10.0.0.1/invalid']));
  assert.equal(addressAllowlist([])('127.0.0.1'), false);
});

test('shared reading comparisons ignore legacy read privacy but still respect account privacy', () => {
  const first = makeUser(db, { handle: 'comparisonone', visibility: 'public' });
  const second = makeUser(db, { handle: 'comparisontwo', visibility: 'public' });
  const { wid } = book(first);
  book(second, { work: wid, visibility: 'private' });
  run("INSERT INTO user_follows (follower_id, followee_id, state) VALUES (?, ?, 'active')", first.id, second.id);
  assert.ok(READERS.sharedGround(first.id, second.id));
  const result = READERS.onWork(wid, { id: first.id, isMember: true });
  assert.equal(result.rail.length, 1);
  run("UPDATE users SET profile_visibility = 'private' WHERE id = ?", second.id);
  assert.equal(READERS.sharedGround(first.id, second.id), null);
  assert.equal(READERS.onWork(wid, { id: first.id, isMember: true }).rail.length, 0);
});
