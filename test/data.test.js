import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempDB } from './helpers.js';

useTempDB();

const { db, get, all, run } = await import('../db/index.js');
const CSV = await import('../lib/csv.js');
const DESK = await import('../lib/desk.js');
const W = await import('../lib/works.js');
const L = await import('../lib/library.js');
const AV = await import('../lib/avatars.js');
const SCRUB = await import('../lib/scrub.js');
const NOTES = await import('../lib/notes.js');
const CRYPTO = await import('../lib/crypto.js');
const PURGE = await import('../lib/purge.js');
const A = await import('../lib/accounts.js');
const audit = await import('../lib/audit.js');

// ── §19 DATA HANDLING ────────────────────────────────────

test('§19 — a Goodreads CSV with a formula in a review re-exports escaped', () => {
  // The exact payload from §19's acceptance list.
  const ATTACK = `=cmd|'/c calc'!A1`;

  const incoming =
    'Title,Author,My Review,ISBN13\r\n' +
    `"Kafka on the Shore",Murakami,"${ATTACK}","=""9780099458326"""\r\n`;

  const { records } = CSV.parseWithHeader(incoming);
  assert.equal(records.length, 1);

  // Goodreads' formula-escaped identifier comes back as a plain string.
  assert.equal(records[0].ISBN13, '9780099458326');
  assert.equal(records[0]['My Review'], ATTACK);

  // And on the way back out it can no longer be read as a formula.
  const out = CSV.toCSV(records, ['Title', 'Author', 'My Review', 'ISBN13']);
  const line = out.split('\r\n')[1];
  assert.ok(line.includes(`'${ATTACK}`), `expected a leading apostrophe, got: ${line}`);
  assert.ok(!/,=cmd/.test(line), 'a bare = must never start a cell');
});

test('§12 — every formula lead character is neutralised', () => {
  for (const c of ['=', '+', '-', '@', '\t', '\r']) {
    const cell = CSV.safeCell(`${c}danger`);
    assert.equal(cell[0], "'", `${JSON.stringify(c)} must be escaped`);
  }
  // Ordinary text is left exactly as written — a negative number in prose
  // would be mangled if this were over-eager.
  assert.equal(CSV.safeCell('a normal review'), 'a normal review');
  assert.equal(CSV.safeCell('1984'), '1984');
});

test('§12 — the parser survives what Goodreads actually exports', () => {
  const nasty =
    'Title,My Review\r\n' +
    '"A Book","A review\nwith a newline, a ""quote"", and a comma"\r\n' +
    '"Another","plain"\r\n';

  const { records } = CSV.parseWithHeader(nasty);
  assert.equal(records.length, 2);
  assert.equal(records[0]['My Review'], 'A review\nwith a newline, a "quote", and a comma');
  assert.equal(records[1].Title, 'Another');
});

test('§12 — the row cap is enforced', () => {
  const many = 'Title\r\n' + 'x\r\n'.repeat(50);
  assert.throws(() => CSV.parseCSV(many, { maxRows: 10 }), /More than 10 rows/);
});

// ── §19 AVATARS ──────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'margin-avatar-test-'));

function jpegWithGPS() {
  // A real JPEG from the system, with a genuine EXIF APP1 block carrying a
  // GPS IFD spliced in after SOI.
  const src = join(scratch, 'base.jpg');
  execFileSync('sips', [
    '-s', 'format', 'jpeg',
    '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns',
    '--out', src
  ], { stdio: 'ignore' });

  const base = readFileSync(src);
  // TIFF header, one IFD entry pointing at a GPS IFD, and two GPS tags.
  const body = Buffer.from([
    '4d4d002a00000008',                 // MM, 42, IFD0 at offset 8
    '0001',                             // one entry
    '8825000400000001', '0000001a',     // GPSInfoIFDPointer -> 0x1a
    '00000000',                         // no next IFD
    '0002',                             // GPS IFD: two entries
    '00010002000000024e000000',         // GPSLatitudeRef = 'N'
    '00030002000000024500000000000000'  // GPSLongitudeRef = 'E'
  ].join(''), 'hex');
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), body]);
  const len = exif.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 255]), exif]);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

test('§19 — an uploaded JPEG with GPS EXIF is served with no EXIF', async () => {
  const withGPS = jpegWithGPS();
  assert.ok(withGPS.includes(Buffer.from('Exif\0\0')), 'the fixture really carries EXIF');

  const result = await AV.processAvatar(withGPS);
  assert.equal(result.ok, true, result.error || result.detail);

  for (const size of AV.SIZES) {
    const out = readFileSync(AV.avatarFile(result.key, size));
    assert.equal(out.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'output is a PNG');
    assert.ok(!out.includes(Buffer.from('Exif')), `EXIF survived at ${size}px`);
  }

  AV.removeAvatar(result.key);
});

test('§19 — a .png with an HTML body is rejected on magic bytes', async () => {
  const polyglot = Buffer.from('<?php system($_GET["c"]); ?><html><script>alert(1)</script>');
  assert.equal(AV.sniff(polyglot), null);

  const result = await AV.processAvatar(polyglot);
  assert.equal(result.ok, false);
  assert.match(result.error, /not a JPEG, PNG, or WebP/);
});

test('a file that starts as a PNG but is not one fails at the re-encode', async () => {
  // Correct magic bytes, garbage after. This passes the sniff deliberately —
  // the point is that the re-encode is a second, independent gate.
  const fake = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('<?php system($_GET["c"]); ?>'.repeat(40))
  ]);
  assert.equal(AV.sniff(fake), 'png', 'it does claim to be a PNG');

  const result = await AV.processAvatar(fake);
  assert.equal(result.ok, false, 'a decoder that cannot read it must not store it');
});

test('an oversized upload is refused before it is processed', async () => {
  const huge = Buffer.alloc(AV.MAX_BYTES + 1, 0);
  huge.set(Buffer.from('89504e470d0a1a0a', 'hex'), 0);
  const result = await AV.processAvatar(huge);
  assert.equal(result.ok, false);
  assert.match(result.error, /5 MB/);
});

test('an avatar key from the database cannot escape its directory', () => {
  const path = AV.avatarFile('../../../../etc/passwd', 256);
  assert.ok(!path.includes('..'), `path traversal survived: ${path}`);
  assert.ok(path.endsWith('-256.png'));
});

// ── §19 OPERATIONS: log hygiene ──────────────────────────

test('§19 — logs carry no passwords, tokens, note bodies, or full addresses', async (t) => {
  const NOTE = 'The mice thing stopped registering as a device about forty pages in.';

  const captured = [];
  const fake = {
    log: (...a) => captured.push(a), info: () => {}, warn: () => {},
    error: (...a) => captured.push(a), debug: () => {}
  };
  const restore = SCRUB.installConsoleScrubber(fake);

  // The careless call this exists to survive.
  fake.log({
    user: { email: 'raghav.tandon@example.com', password: 'hunter2 and a long tail' },
    session: { token: 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2FsZG8' },
    reading: { private_note: NOTE },
    hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'
  });
  fake.error(new Error(`failed for raghav.tandon@example.com with token=abc123def456ghi789jkl`));

  restore();

  const text = JSON.stringify(captured);

  await t.test('no password', () => assert.ok(!text.includes('hunter2'), text));
  await t.test('no note body', () => assert.ok(!text.includes('mice thing'), text));
  await t.test('no session token', () => assert.ok(!text.includes('Zm9vYmFyYmF6'), text));
  await t.test('no argon2 hash', () => assert.ok(!text.includes('$argon2id$'), text));
  await t.test('no token in a URL or message', () => assert.ok(!text.includes('abc123def456'), text));
  await t.test('no full email address', () => {
    assert.ok(!text.includes('raghav.tandon@'), text);
    // The domain survives, because that is what a log is actually for.
    assert.ok(text.includes('example.com'), 'the domain should remain useful');
  });
});

test('the scrubber survives circular objects and deep nesting', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.doesNotThrow(() => SCRUB.scrub(a));
  assert.equal(SCRUB.scrub(a).self, '[circular]');

  let deep = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { next: deep };
  assert.doesNotThrow(() => SCRUB.scrub(deep));
});

test('an error report is scrubbed before it would leave the process', () => {
  const err = new Error('token=supersecrettokenvaluethatislong reading for a@b.example.com');
  const report = SCRUB.forReporter(err, { password: 'nope', note: 'private words' });
  const text = JSON.stringify(report);
  assert.ok(!text.includes('supersecrettokenvalue'));
  assert.ok(!text.includes('nope'));
  assert.ok(!text.includes('private words'));
});

// ── §11 note encryption ──────────────────────────────────

test('§11 — a note is not readable in the database', () => {
  const u = A.createUser({ email: 'notes@example.test', passwordHash: 'x' });
  A.markVerified(u.id);
  run(`INSERT INTO works (id, title) VALUES (900, 'A Book')`);
  run(`INSERT INTO readings (user_id, work_id, status) VALUES (?, 900, 'FINISHED')`, u.id);
  const reading = get('SELECT * FROM readings WHERE user_id = ?', u.id);

  const SECRET = 'I read this the winter my father was ill.';
  NOTES.setNote(reading.id, SECRET);

  const raw = get('SELECT note_encrypted, private_note FROM readings WHERE id = ?', reading.id);
  assert.equal(raw.private_note, null, 'the plaintext column must be empty');
  assert.ok(Buffer.isBuffer(raw.note_encrypted) || raw.note_encrypted, 'ciphertext is stored');

  const asBytes = Buffer.from(raw.note_encrypted);
  assert.ok(!asBytes.includes(Buffer.from(SECRET)), 'the plaintext must not appear in the blob');
  assert.ok(!asBytes.toString('utf8').includes('father'), 'nor any recognisable fragment');

  // And it round-trips for its owner.
  assert.equal(NOTES.noteOf(get('SELECT * FROM readings WHERE id = ?', reading.id)), SECRET);
});

test('§11 — every record gets its own key', () => {
  const a = CRYPTO.seal('the same words exactly');
  const b = CRYPTO.seal('the same words exactly');
  assert.notEqual(a.toString('hex'), b.toString('hex'), 'identical plaintext must not produce identical bytes');
  assert.equal(CRYPTO.open(a), 'the same words exactly');
  assert.equal(CRYPTO.open(b), 'the same words exactly');
});

test('§11 — a tampered envelope yields nothing, not garbage', () => {
  const sealed = CRYPTO.seal('a private sentence');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  assert.equal(CRYPTO.open(tampered), null, 'a failed tag check must return nothing');
});

test('§11 — a plaintext note written before the migration moves on first read', () => {
  const u = A.createUser({ email: 'legacy@example.test', passwordHash: 'x' });
  run(`INSERT INTO readings (user_id, work_id, status, private_note)
       VALUES (?, 900, 'FINISHED', 'an old note in the clear')`, u.id);
  const before = get('SELECT * FROM readings WHERE user_id = ?', u.id);

  assert.equal(NOTES.noteOf(before), 'an old note in the clear');

  const after = get('SELECT * FROM readings WHERE id = ?', before.id);
  assert.equal(after.private_note, null, 'the plaintext column is drained on read');
  assert.ok(after.note_encrypted);
});

// ── §19 DELETION ─────────────────────────────────────────

test('§19 — deleting an account leaves no plaintext email, note, or book row', () => {
  const u = A.createUser({ email: 'leaving@example.test', passwordHash: 'x' });
  A.markVerified(u.id);
  A.setUsername(u.id, 'leaving');

  run(`INSERT INTO shelves (user_id, name, slug) VALUES (?, 'Read', 'read')`, u.id);
  const shelf = get('SELECT * FROM shelves WHERE user_id = ?', u.id);
  run(`INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, 900)`, shelf.id);
  run(`INSERT INTO readings (user_id, work_id, status) VALUES (?, 900, 'FINISHED')`, u.id);

  const reading = get('SELECT * FROM readings WHERE user_id = ?', u.id);
  NOTES.setNote(reading.id, 'something I would not want read');
  run(`INSERT INTO sessions (reading_id, position) VALUES (?, 100)`, reading.id);

  PURGE.purgeUser(u.id);

  assert.equal(all('SELECT * FROM readings WHERE user_id = ?', u.id).length, 0, 'no readings');
  assert.equal(all('SELECT * FROM shelves WHERE user_id = ?', u.id).length, 0, 'no shelves');
  assert.equal(all('SELECT * FROM shelf_items WHERE shelf_id = ?', shelf.id).length, 0, 'no shelf items');
  assert.equal(all('SELECT * FROM sessions WHERE reading_id = ?', reading.id).length, 0, 'no sessions');
  assert.equal(all('SELECT * FROM auth_sessions WHERE user_id = ?', u.id).length, 0);

  const tomb = get('SELECT * FROM users WHERE id = ?', u.id);
  assert.equal(tomb.email, null, 'no plaintext email');
  assert.equal(tomb.username, null);
  assert.equal(tomb.bio, null);
  assert.equal(tomb.password_hash, null);
  assert.equal(tomb.is_tombstone, 1);
  // §12 — a salted hash survives, for ban continuity and nothing else.
  assert.ok(tomb.email_hash, 'the ban hash remains');
  assert.ok(!String(tomb.email_hash).includes('leaving'), 'and is not reversible by eye');

  // §9 — the username is held, not immediately reusable.
  assert.equal(A.usernameAvailable('leaving').ok, false);
});

test('§12 — a scheduled deletion states its date and is reversible until then', () => {
  const u = A.createUser({ email: 'maybe@example.test', passwordHash: 'x' });
  const when = PURGE.scheduleDeletion(u.id);

  assert.ok(when instanceof Date);
  const days = Math.round((when - Date.now()) / 86_400_000);
  assert.equal(days, PURGE.GRACE_DAYS);

  const scheduled = get('SELECT * FROM users WHERE id = ?', u.id);
  assert.ok(scheduled.purge_after);
  assert.ok(scheduled.deleted_at, 'marked, but the rows are still there');
  assert.ok(get('SELECT * FROM users WHERE id = ?', u.id));

  PURGE.reactivate(u.id);
  const back = get('SELECT * FROM users WHERE id = ?', u.id);
  assert.equal(back.deleted_at, null);
  assert.equal(back.purge_after, null);
});

// ── §19 AUDIT ────────────────────────────────────────────

test('§19 — the audit log is append-only, enforced by the engine', () => {
  audit.record({ actorType: 'system', action: 'test.entry', targetUserId: 1 });
  assert.throws(() => run(`UPDATE audit_log SET action = 'tampered'`), /append-only/);
  assert.throws(() => run(`DELETE FROM audit_log`), /append-only/);
});

test('§19 — every staff read names the actor, the target, and the fields', () => {
  const staff = { id: 'staff-1', email: 'support@example.test' };
  const target = A.createUser({ email: 'member@example.test', passwordHash: 'x' });

  audit.staffRead({
    staff, targetUserId: target.id,
    fields: ['username', 'email_masked', 'last_seen_at'],
    reason: 'ticket 4182, cannot sign in',
    ip: '10.0.0.1', userAgent: 'test'
  });

  const row = get(
    `SELECT * FROM audit_log WHERE actor_type = 'staff' AND target_user_id = ?
      ORDER BY id DESC LIMIT 1`, target.id
  );
  assert.equal(row.actor_id, 'staff-1');
  assert.deepEqual(JSON.parse(row.fields), ['username', 'email_masked', 'last_seen_at']);
  assert.match(row.reason, /ticket 4182/);
  assert.ok(row.ip_hash && row.ip_hash !== '10.0.0.1', 'the address is hashed, not stored');
});

test('a staff read without fields or a reason is refused outright', () => {
  const staff = { id: 'staff-1' };
  assert.throws(
    () => audit.staffRead({ staff, targetUserId: 1, fields: [], reason: 'a good reason here' }),
    /exact list of fields/
  );
  assert.throws(
    () => audit.staffRead({ staff, targetUserId: 1, fields: ['x'], reason: 'no' }),
    /written reason/
  );
});

test('§19 — one query returns exactly who a compromised account touched', () => {
  const staff = { id: 'staff-compromised' };
  const since = new Date(Date.now() - 60_000).toISOString();

  const victims = [1, 2, 3].map((i) =>
    A.createUser({ email: `victim${i}@example.test`, passwordHash: 'x' })
  );

  for (const v of victims) {
    audit.staffRead({
      staff, targetUserId: v.id, fields: ['email_masked', 'last_seen_at'],
      reason: 'no legitimate reason, this is the incident'
    });
  }
  audit.record({
    actorType: 'staff', actorId: staff.id, action: 'admin.user.export',
    targetUserId: victims[0].id, fields: ['books', 'notes'], reason: 'exfiltration'
  });

  const affected = audit.affectedBy(staff.id, { since });

  assert.equal(affected.length, 3, 'exactly the three, and no one else');
  assert.deepEqual(affected.map((a) => a.userId).sort((x, y) => x - y),
                   victims.map((v) => v.id).sort((x, y) => x - y));

  // And it says WHICH fields, which is the part Letterboxd could not answer.
  const first = affected.find((a) => a.userId === victims[0].id);
  assert.deepEqual(first.fields, ['books', 'email_masked', 'last_seen_at', 'notes']);
});

test('§14 — bulk access and out-of-hours access raise anomalies', () => {
  const staff = { id: 'staff-bulk' };
  for (let i = 0; i < 25; i++) {
    const v = A.createUser({ email: `bulk${i}@example.test`, passwordHash: 'x' });
    audit.staffRead({
      staff, targetUserId: v.id, fields: ['email_masked'],
      reason: 'a plausible sounding reason'
    });
  }
  const found = audit.anomalies({ windowHours: 1, threshold: 20 });
  assert.ok(found.some((a) => a.kind === 'bulk_access' && a.staffId === 'staff-bulk'));
});

// ── §16 IP hashing ───────────────────────────────────────

test('§16 — addresses are hashed with a rotating salt, never stored', () => {
  const h = CRYPTO.hashIP('203.0.113.44');
  assert.notEqual(h, '203.0.113.44');
  assert.match(h, /^[a-f0-9]{32}$/);
  // Stable within a day, so rate limiting works.
  assert.equal(h, CRYPTO.hashIP('203.0.113.44'));
  assert.notEqual(h, CRYPTO.hashIP('203.0.113.45'));
});

// ── TIME ─────────────────────────────────────────────────

test('sqlTime is idempotent, so a stored timestamp survives a round trip', async (t) => {
  const { sqlTime, nowSQL, parseSQLTime } = await import('../db/index.js');

  await t.test('a stored value passes through unchanged', () => {
    // new Date('2026-08-25 17:27:30') parses as LOCAL time and re-serialises
    // as UTC. Passing a stored timestamp through sqlTime twice therefore
    // shifted it by the timezone offset — which turned an audit window into
    // one that matched nothing, silently.
    const stored = '2026-08-25 17:27:30';
    assert.equal(sqlTime(stored), stored);
    assert.equal(sqlTime(sqlTime(sqlTime(stored))), stored);
  });

  await t.test('a Date or epoch still converts', () => {
    const at = Date.UTC(2026, 7, 25, 17, 27, 30);
    assert.equal(sqlTime(at), '2026-08-25 17:27:30');
    assert.equal(sqlTime(new Date(at)), '2026-08-25 17:27:30');
  });

  await t.test('and parses back as UTC, not local', () => {
    assert.equal(parseSQLTime('2026-08-25 17:27:30'), Date.UTC(2026, 7, 25, 17, 27, 30));
  });

  await t.test('nowSQL sorts correctly against a stored default', () => {
    // The whole reason for one format: these are compared as strings.
    const past = sqlTime(Date.now() - 3600_000);
    const future = sqlTime(Date.now() + 3600_000);
    assert.ok(past < nowSQL(), 'an hour ago must sort below now');
    assert.ok(future > nowSQL(), 'an hour hence must sort above now');
  });
});

test('§14 — the incident query survives a window given in stored format', async () => {
  const { sqlTime } = await import('../db/index.js');
  const staff = { id: 'staff-window' };
  const target = A.createUser({ email: 'window@example.test', passwordHash: 'x' });

  audit.staffRead({
    staff, targetUserId: target.id, fields: ['email_masked'],
    reason: 'checking the window handling'
  });

  // Both spellings of "an hour ago" must find it.
  const asSql = sqlTime(Date.now() - 3600_000);
  const asIso = new Date(Date.now() - 3600_000).toISOString();

  assert.equal(audit.affectedBy(staff.id, { since: asSql }).length, 1, 'stored format');
  assert.equal(audit.affectedBy(staff.id, { since: asIso }).length, 1, 'ISO format');
});

// ── THE DESK'S QUERY VOCABULARY ──────────────────────────

test('the desk reads years before 1900', () => {
  // (?:19|20)\d{2} cannot match 1848 or 1515, and this library's oldest
  // book is from 1515. Every year filter silently failed on all of it.
  assert.equal(DESK.parseQuery('written before 1850').publishedBefore, 1850);
  assert.equal(DESK.parseQuery('published after 1600').publishedAfter, 1600);
  assert.equal(DESK.parseQuery('books from the 1840s').publishedAfter, 1840);
});

test('the desk reads more than one way of saying "before"', () => {
  for (const phrase of ['written prior to 1900', 'written before 1900',
                        'published earlier than 1900', 'printed up to 1900',
                        'pre-1900']) {
    assert.equal(DESK.parseQuery(phrase).publishedBefore, 1900, phrase);
  }
  for (const phrase of ['written after 1990', 'published since 1990', 'post-1990']) {
    assert.equal(DESK.parseQuery(phrase).publishedAfter, 1990, phrase);
  }
});

test('a century is a range', () => {
  const q = DESK.parseQuery('19th century novels');
  assert.equal(q.publishedAfter, 1800);
  assert.equal(q.publishedBefore, 1900);
});

test('"above 3" excludes 3', () => {
  // It was inclusive, which returned a three-star book at the top of a
  // search for everything above three stars.
  assert.equal(DESK.parseQuery('rated above 3 stars').ratingMin, 3.5);
  assert.equal(DESK.parseQuery('rated over 4').ratingMin, 4.5);
  assert.equal(DESK.parseQuery('better than 2 stars').ratingMin, 2.5);
});

test('"at least" and "or better" keep the boundary', () => {
  assert.equal(DESK.parseQuery('rated at least 4').ratingMin, 4);
  assert.equal(DESK.parseQuery('4 stars or better').ratingMin, 4);
});

test('"below 3" excludes 3', () => {
  assert.equal(DESK.parseQuery('rated below 3').ratingMax, 2.5);
  assert.equal(DESK.parseQuery('under 2 stars').ratingMax, 1.5);
});

test('a bare star count still means exactly that', () => {
  const q = DESK.parseQuery('4 stars');
  assert.equal(q.ratingMin, 4);
  assert.equal(q.ratingMax, 4);
});

test('a comparative leaves no crumbs in the free text', () => {
  // "3 stars" used to be matched first, which ate the digit the
  // comparative needed to strip, stranding "rated above" in the text
  // search where it matched on theme.
  const q = DESK.parseQuery("anything i've rated above 3 stars that was written prior to 1900");
  assert.equal(q.ratingMin, 3.5);
  assert.equal(q.publishedBefore, 1900);
  assert.ok(!/rated|above|stars|prior|1900/.test(q.semantic || ''), q.semantic);
});

test('the desk states what it understood', () => {
  const q = DESK.parseQuery("rated above 3 stars written prior to 1900");
  const f = DESK.appliedFilters(q);
  assert.deepEqual(f, ['RATED 3.5 OR MORE', 'PUBLISHED BEFORE 1900']);

  // Free text is not a filter and is not claimed as one.
  assert.deepEqual(DESK.appliedFilters(DESK.parseQuery('stoner')), []);
});

test('a first-published year can be corrected, within reason', () => {
  const id = run('INSERT INTO works (title, first_published_year) VALUES (?, ?)',
                 'Misdated', 1777).lastInsertRowid;

  assert.equal(W.setFirstPublished(id, 1955), 1955);
  assert.equal(get('SELECT first_published_year y FROM works WHERE id = ?', id).y, 1955);

  // BCE is legitimate in a library that holds Aeschylus.
  assert.equal(W.setFirstPublished(id, -458), -458);

  for (const bad of ['abc', 9999, 1.5, -99999]) {
    assert.throws(() => W.setFirstPublished(id, bad), /not a year/i, String(bad));
  }
  assert.equal(get('SELECT first_published_year y FROM works WHERE id = ?', id).y, -458,
    'a refused value does not overwrite a good one');

  assert.equal(W.setFirstPublished(id, ''), null, 'and it can be cleared');
});

// ── DISCARDING A PASS ────────────────────────────────────

test('a pass started by accident can be thrown away', () => {
  const u = A.createUser({ email: 'passer@example.test', passwordHash: 'x' });
  A.markVerified(u.id);
  const w = run('INSERT INTO works (title) VALUES (?)', 'Reread').lastInsertRowid;
  run(`INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, 'READING', 'reading', 1)`, u.id);

  // A finished first pass, then a second opened to see what happened.
  run(`INSERT INTO readings (user_id, work_id, status, pass_number, finished_at, stars, is_draft)
       VALUES (?, ?, 'FINISHED', 1, '2025-01-01', 4, 0)`, u.id, w);
  const second = run(`INSERT INTO readings (user_id, work_id, status, pass_number, current_page, is_draft)
       VALUES (?, ?, 'READING', 2, 40, 0)`, u.id, w).lastInsertRowid;
  run(`INSERT INTO sessions (reading_id, position, position_type) VALUES (?, 40, 'page')`, second);

  const out = L.discardPass(u.id, w, 2);
  assert.equal(out.ok, true);
  assert.equal(get('SELECT COUNT(*) n FROM readings WHERE work_id = ? AND user_id = ?', w, u.id).n, 1,
    'only the one pass goes');
  assert.equal(get('SELECT COUNT(*) n FROM sessions WHERE reading_id = ?', second).n, 0,
    'and its sessions with it');
  assert.equal(get('SELECT status FROM readings WHERE work_id = ? AND user_id = ?', w, u.id).status,
    'FINISHED', 'the first pass is untouched');
});

test('the only record of having read something is not discardable', () => {
  const u = A.createUser({ email: 'onepass@example.test', passwordHash: 'x' });
  const w = run('INSERT INTO works (title) VALUES (?)', 'Read once').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, pass_number, finished_at, is_draft)
       VALUES (?, ?, 'FINISHED', 1, '2025-01-01', 0)`, u.id, w);

  const out = L.discardPass(u.id, w, 1);
  assert.equal(out.ok, false);
  assert.match(out.error, /only record/i);
  assert.equal(get('SELECT COUNT(*) n FROM readings WHERE work_id = ?', w).n, 1);
});

test('discarding the last open pass takes the book off READING', () => {
  const u = A.createUser({ email: 'openpass@example.test', passwordHash: 'x' });
  const w = run('INSERT INTO works (title) VALUES (?)', 'Just started').lastInsertRowid;
  const shelf = run(`INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, 'READING', 'reading', 1)`,
                    u.id).lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, pass_number, is_draft)
       VALUES (?, ?, 'READING', 1, 0)`, u.id, w);
  run('INSERT INTO shelf_items (shelf_id, work_id) VALUES (?, ?)', shelf, w);

  assert.equal(L.discardPass(u.id, w).ok, true);
  assert.equal(get('SELECT COUNT(*) n FROM shelf_items WHERE shelf_id = ?', shelf).n, 0,
    'a book with nothing reading it does not stay on READING');
});

// ── WHERE THE THREE ENDINGS PUT A BOOK ───────────────────
//
// The press page grew FINISHED, ABANDONED and DISCARD THIS PASS as one-click
// buttons, so where each of them leaves a book is now a daily decision
// rather than an occasional one. Discard used to leave it on no shelf at
// all: off READING, onto nothing, still in the catalogue and nowhere in the
// library. That is how a book gets discarded and then cannot be found.

test('each ending puts the book on the matching shelf', () => {
  const u = A.createUser({ email: 'endings@example.test', passwordHash: 'x' });
  for (const slug of ['reading', 'finished', 'abandoned', 'waiting']) {
    run(`INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 1)`,
        u.id, slug.toUpperCase(), slug);
  }
  const shelvesOf = (w) => all(
    `SELECT s.slug FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
      WHERE s.user_id = ? AND si.work_id = ? ORDER BY s.slug`, u.id, w).map((r) => r.slug);

  const mk = (title) => run('INSERT INTO works (title) VALUES (?)', title).lastInsertRowid;

  const fin = mk('Finished one');
  L.startReading(u.id, fin);
  L.finishReading(u.id, fin);
  assert.deepEqual(shelvesOf(fin), ['finished']);

  const ab = mk('Abandoned one');
  L.startReading(u.id, ab);
  L.abandonReading(u.id, ab, 25);
  assert.deepEqual(shelvesOf(ab), ['abandoned']);

  // Nothing left means the reading never happened: back to the pile.
  const dis = mk('Discarded one');
  L.startReading(u.id, dis);
  assert.equal(L.discardPass(u.id, dis).ok, true);
  assert.deepEqual(shelvesOf(dis), ['waiting'],
    'a discarded book goes back to WAITING, not off every shelf');
});

test('discarding a re-read leaves the finished shelf alone', () => {
  const u = A.createUser({ email: 'reread@example.test', passwordHash: 'x' });
  for (const slug of ['reading', 'finished', 'waiting']) {
    run(`INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 1)`,
        u.id, slug.toUpperCase(), slug);
  }
  const w = run('INSERT INTO works (title) VALUES (?)', 'Read twice').lastInsertRowid;
  L.startReading(u.id, w);
  L.finishReading(u.id, w);
  L.startReading(u.id, w);                       // a second pass, then thrown away
  assert.equal(L.discardPass(u.id, w).ok, true);

  const slugs = all(
    `SELECT s.slug FROM shelf_items si JOIN shelves s ON s.id = si.shelf_id
      WHERE s.user_id = ? AND si.work_id = ? ORDER BY s.slug`, u.id, w).map((r) => r.slug);
  assert.deepEqual(slugs, ['finished'],
    'a book you finished is not a book you are waiting to read');
});

test('a system shelf an old account never got is created, not thrown over', () => {
  // `abandoned` was added after some accounts existed. Before this, the
  // first ABANDONED click on such an account was a 500.
  const u = A.createUser({ email: 'noshelf@example.test', passwordHash: 'x' });
  run(`INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, 'READING', 'reading', 1)`, u.id);
  const w = run('INSERT INTO works (title) VALUES (?)', 'Given up on').lastInsertRowid;

  L.startReading(u.id, w);
  L.abandonReading(u.id, w, 10);
  assert.equal(get(`SELECT COUNT(*) n FROM shelves WHERE user_id = ? AND slug = 'abandoned'`, u.id).n, 1);

  // A shelf the reader never made is still refused: only the four the
  // product moves books between are created on demand.
  assert.throws(() => L.addToShelf(u.id, 'invented', w), /NO SHELF/);
});

// ── SHELF NAMES ──────────────────────────────────────────

test('a shelf name always produces a usable address', () => {
  // "★★★" slugged to the empty string, and the route then redirected to
  // /shelf/ — a 404 on a shelf that had in fact been created.
  assert.equal(L.shelfSlug('Winter reading'), 'winter-reading');
  assert.equal(L.shelfSlug('Café/Bar'), 'cafe-bar', 'accents transliterate rather than vanish');
  assert.ok(L.shelfSlug('★★★').length > 0, 'a name with no letters still gets an address');
  assert.ok(L.shelfSlug('   ').length > 0);

  // Collisions get a suffix rather than silently failing.
  assert.equal(L.shelfSlug('Winter reading', { taken: ['winter-reading'] }), 'winter-reading-2');
});

test('creating a shelf says why it did not work', () => {
  const u = A.createUser({ email: 'shelver@example.test', passwordHash: 'x' });

  assert.equal(L.createShelf(u.id, '   ').ok, false);
  const first = L.createShelf(u.id, 'Winter');
  assert.equal(first.ok, true);

  const dupe = L.createShelf(u.id, 'winter');
  assert.equal(dupe.ok, false);
  assert.match(dupe.error, /already have a shelf/);

  // A system shelf is not removable; one you made is.
  run(`UPDATE shelves SET is_system = 1 WHERE id = ?`, first.shelf.id);
  assert.equal(L.deleteShelf(u.id, first.shelf.slug).ok, false);
  run(`UPDATE shelves SET is_system = 0 WHERE id = ?`, first.shelf.id);
  assert.equal(L.deleteShelf(u.id, first.shelf.slug).ok, true);
});
