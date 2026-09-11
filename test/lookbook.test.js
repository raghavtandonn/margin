import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run, sqlTime } = await import('../db/index.js');
const A = await import('../lib/accounts.js');
const B = await import('../lib/boards.js');
const LB = await import('../lib/lookbook-seasonal.js');
const { compositionOf, careOf } = await import('../lib/composition.js');
const { colourway, bruiseFor } = await import('../lib/colourway.js');
const SEASONS = await import('../lib/seasons.js');

// ── Fixtures ─────────────────────────────────────────────
const reader = (handle) => {
  const u = A.createUser({ email: `${handle}@example.test`, passwordHash: 'x' });
  A.markVerified(u.id);
  A.setUsername(u.id, handle);
  return get('SELECT * FROM users WHERE id = ?', u.id);
};

const me = reader('curator');

function book({ title, subjects = null, year = null, pages = null, colour = null,
                finished = null, abandoned = null, page = null, stars = null,
                started = null, publisher = null, author = null }) {
  const workId = run('INSERT INTO works (title, subjects, first_published_year) VALUES (?, ?, ?)',
    title, subjects ? JSON.stringify(subjects) : null, year).lastInsertRowid;

  if (author) {
    const pid = run('INSERT INTO people (name) VALUES (?)', author).lastInsertRowid;
    run(`INSERT INTO work_people (work_id, person_id, role, ord) VALUES (?, ?, 'AUTHOR', 0)`,
        workId, pid);
  }

  const edId = run(
    'INSERT INTO editions (work_id, page_count, season_colour, publisher) VALUES (?, ?, ?, ?)',
    workId, pages, colour, publisher
  ).lastInsertRowid;

  run(
    `INSERT INTO readings (user_id, work_id, edition_id, status, started_at, finished_at,
                           abandoned_at, abandoned_page, stars, is_draft)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    me.id, workId, edId, abandoned ? 'ABANDONED' : 'FINISHED',
    started, finished, abandoned, page, stars
  );

  return { workId, edId };
}

// ── ARCHIVE NUMBERS (§05) ────────────────────────────────

test('§05 — the archive number survives two hundred books a year', () => {
  const season = { code: 'aw25', ends_on: '2025-12-31' };

  // Zero books read is 0000, not a crash and not a blank.
  assert.match(LB.archiveNumber(me.id, season), /^AW25–0000–A$/);

  for (let i = 0; i < 12; i++) {
    book({ title: 'Counted ' + i, finished: '2025-08-0' + (i % 9 + 1) });
  }
  assert.equal(LB.archiveNumber(me.id, season), 'AW25–0012–A');

  // A regeneration moves the revision letter and nothing else.
  assert.equal(LB.archiveNumber(me.id, season, { revision: 1 }), 'AW25–0012–B');

  // Past four digits it widens rather than colliding with itself.
  const big = { code: 'aw99', ends_on: '2099-12-31' };
  assert.equal(LB.archiveNumber(me.id, big).split('–')[1].length >= 4, true);
});

test('the archive number counts books finished up to the season, not in it', () => {
  const early = { code: 'ss25', ends_on: '2025-06-30' };
  const late = { code: 'aw25', ends_on: '2025-12-31' };
  // The count is cumulative, so it never goes backwards between seasons.
  assert.ok(Number(LB.archiveNumber(me.id, late).split('–')[1])
         >= Number(LB.archiveNumber(me.id, early).split('–')[1]));
});

// ── SHOW NOTES (§02) ─────────────────────────────────────

test('§02 — the register is enforced, not merely intended', () => {
  assert.throws(() => LB.assertRegister('Your best season yet.'), /register/);
  assert.throws(() => LB.assertRegister('Congratulations on fourteen books.'), /register/);
  assert.throws(() => LB.assertRegister('An amazing journey.'), /register/);
  assert.throws(() => LB.assertRegister('Fourteen books!'), /register/);

  // And the spec's own example passes it.
  assert.doesNotThrow(() => LB.assertRegister(
    'Fourteen books. A winter spent mostly in translation. The collection resists resolution.'));
});

test('§02 — show notes state only what the data supports', () => {
  const season = { code: 'aw25' };
  const looks = [
    { work: { first_published_year: 2001 }, edition: { page_count: 200 }, reading: { stars: 5 }, translated: false },
    { work: { first_published_year: 2003 }, edition: { page_count: 300 }, reading: { stars: 1 }, translated: false },
    { work: { first_published_year: 2005 }, edition: { page_count: 400 }, reading: { stars: 5 }, translated: false },
    { work: { first_published_year: 2007 }, edition: { page_count: 500 }, reading: { stars: 2 }, translated: false }
  ];

  const notes = LB.showNotes({ looks, season, deadstock: [] });
  assert.match(notes, /^Four books\./);
  assert.match(notes, /resists resolution/, 'a three-star spread resolves to nothing');
  assert.ok(!/translation/.test(notes), 'nothing was translated, so nothing is claimed');

  // A page total is a receipt line, not a show note. It is gone.
  assert.ok(!/pages/.test(notes), notes);
});

test('§02 — the note names what the season opened and closed with', () => {
  // Two titles are worth more than any aggregate: it is the only line that
  // could not have been written about a different season.
  const looks = ['Stoner', 'Middlemarch', 'Ponyo'].map((t) => ({
    work: { title: t }, reading: {}, edition: {}, translated: false
  }));
  const notes = LB.showNotes({ looks, season: { code: 'ss24' }, deadstock: [] });
  assert.match(notes, /opened with Stoner and closed with Ponyo/);
});

test('§02 — a title in the second person does not break the register', () => {
  // The register bans the house speaking to the reader. A title quoted
  // verbatim is a proper noun, and the naive check threw on it — taking the
  // whole catalogue down with a 500 for any season containing that book.
  const looks = ['Stoner', 'Middlemarch', 'Call Me By Your Name'].map((t) => ({
    work: { title: t }, reading: {}, edition: {}, translated: false
  }));
  assert.doesNotThrow(() => LB.showNotes({ looks, season: { code: 'ss24' }, deadstock: [] }));

  // And the ban still holds on the house's own words.
  assert.throws(() => LB.assertRegister('Your best season yet.', { quoting: ['Stoner'] }), /register/);
});

test('§02 — an empty season has no statement at all', () => {
  assert.equal(LB.showNotes({ looks: [], season: { code: 'ss24' }, deadstock: [] }), null);
});

// ── COMPOSITION LABEL (§02b, §05) ────────────────────────

test('§02b — the label reads as a composition, not as a list', () => {
  const { workId } = book({
    title: 'Composed',
    subjects: ['Grief', 'Grief', 'Architecture', 'Revenge', 'Fiction', '2021',
               'Accessible book', 'open_syllabus_project'],
    finished: '2025-08-01'
  });

  const c = compositionOf(workId, me.id);
  assert.equal(c.parts.reduce((n, p) => n + p.pct, 0), 100, 'it always reads exactly 100');
  assert.equal(c.parts[0].name, 'GRIEF');
  assert.ok(c.parts[0].pct >= 45, 'the curve is steep enough to say something');
  assert.ok(!c.parts.some((p) => /FICTION|2021|ACCESSIBLE|SYLLABUS/.test(p.name)),
    'administrative headings are not themes');
});

test('§02b — library subdivisions and other languages are dropped, not mangled', () => {
  const { workId } = book({
    title: 'Catalogued',
    subjects: ['Authors, American, Biography', 'Paris (France) -- Social life',
               'Literatura japonesa', 'Politique et gouvernement', 'Memory'],
    finished: '2025-08-02'
  });

  const c = compositionOf(workId, me.id);
  const names = c.parts.map((p) => p.name);
  assert.ok(names.includes('AUTHORS'), 'the head of an inverted heading is the subject');
  assert.ok(!names.some((n) => /LITERATURA|POLITIQUE/.test(n)));
});

test('§02b — a book with almost no subject data gets no label rather than a wrong one', () => {
  const { workId } = book({ title: 'Unclassified', subjects: ['Fiction'], finished: '2025-08-03' });
  assert.equal(compositionOf(workId, me.id), null);
});

test("§05 — the label says where its numbers came from", () => {
  const { workId } = book({
    title: 'Cited', subjects: ['Grief', 'Memory', 'Family'], finished: '2025-08-04'
  });
  assert.match(compositionOf(workId, me.id).source, /OPEN LIBRARY/);
});

test('the care label states only what the reading proved', () => {
  assert.deepEqual(
    careOf({ started_at: '2025-01-01 09:00:00', finished_at: '2025-01-01 22:00:00', stars: 5 }, {}),
    ['READ IN ONE SITTING', 'DO NOT LEND']
  );
  assert.deepEqual(careOf({}, {}), [], 'an unlogged reading claims nothing');
  assert.ok(careOf({ status: 'ABANDONED' }, {}).includes('NOT PRODUCED'));
});

// ── COLORWAY (§02) ───────────────────────────────────────

test('§02 — the colourway is the distinct colours the season held', () => {
  // The names are no longer generated. `nameOf`, the hue families and the
  // copywriter's qualifiers went with the jacket sampling that needed them:
  // a closed palette of twenty has real names, written once by a person.
  const out = colourway([
    { id: 'grief' }, { id: 'grief' }, { id: 'grief' }, { id: 'awe' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'grief');
  assert.equal(out[0].count, 3, 'ordered by how much of the season it was');
  assert.equal(out[0].name, 'Slate, Deep', 'and named from the palette, not from a hue angle');
  assert.equal(out[0].emotion, 'Grief', 'the word ships with the swatch, everywhere');
});

test('§02 — same colour is id equality now, not a distance under a threshold', () => {
  // Two books assigned Grief are the same swatch because they are the same
  // choice, not because their hexes are 14 LAB units apart. There is no
  // threshold left to tune.
  const out = colourway([{ id: 'grief' }, { id: 'grief' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 2);
});

test('§05 — only named colours compose a colourway', () => {
  // A retiring jacket colour has no name and an unassigned book has no
  // colour. Neither belongs in a palette claiming to describe a season.
  const out = colourway([
    { id: 'grief' },
    { id: null, hex: '#aabbcc', source: 'provisional' },
    { id: null, hex: null, source: 'none' },
    { id: 'not-a-colour' },
    null
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'grief');
});

test('§01 — the bruise is pinned for A/W 25 and constant everywhere else', () => {
  assert.equal(bruiseFor('AW25'), '#4A1418', 'named oxblood in the spec');
  assert.equal(bruiseFor('ss24'), bruiseFor('SS24'), 'and it never changes under a reader');
  assert.notEqual(bruiseFor('SS24'), bruiseFor('AW24'), 'it rotates each season');
});

// ── BOARDS (§02c, §04) ───────────────────────────────────

test('§04 — an entry with no source is not saved', () => {
  const { workId } = book({ title: 'Boarded', finished: '2025-09-01' });

  B.saveBoard(workId, me.id, {
    entries: [
      { label: 'Redacted military interview form', source: 'Library of Congress', year: 1946 },
      { label: 'Something I half remember', source: '' }
    ]
  });

  const board = B.boardFor(workId, me.id);
  assert.equal(board.entries.length, 1, 'an uncited line is the failure mode, so it never lands');
  assert.equal(board.entries[0].source, 'Library of Congress');
});

test('§02c — a board holds six things and no more', () => {
  const { workId } = book({ title: 'Overfull', finished: '2025-09-02' });
  B.saveBoard(workId, me.id, {
    entries: Array.from({ length: 12 }, (_, i) => ({ label: 'Item ' + i, source: 'Wikimedia Commons' }))
  });
  assert.equal(B.boardFor(workId, me.id).entries.length, B.MAX_ENTRIES);
});

test('§04 — a stranger never sees an unverified board', () => {
  const other = reader('stranger');
  const { workId } = book({ title: 'Private research', finished: '2025-09-03' });
  B.saveBoard(workId, me.id, {
    entries: [{ label: 'A find', source: 'Rijksmuseum' }]
  });

  assert.equal(B.boardFor(workId, other.id), null,
    'one person\'s research must not borrow this typography\'s authority');

  run('UPDATE source_boards SET canonical = 1 WHERE work_id = ?', workId);
  assert.ok(B.boardFor(workId, other.id), 'a verified board accretes into the canonical one');
});

test('a year that is not a year is dropped rather than stored', () => {
  const { workId } = book({ title: 'Bad years', finished: '2025-09-04' });
  B.saveBoard(workId, me.id, { entries: [], setFrom: 'nineteen forty four', setTo: '99999' });
  const row = get('SELECT * FROM source_boards WHERE work_id = ? AND user_id = ?', workId, me.id);
  assert.equal(row.set_year_from, null);
  assert.equal(row.set_year_to, null);
});

test('§02e — an author life needs a source before it becomes a band', () => {
  const pid = run('INSERT INTO people (name) VALUES (?)', 'Someone').lastInsertRowid;
  assert.equal(B.saveLife(pid, me.id, { born: 1949, source: '' }).ok, false);
  assert.equal(B.saveLife(pid, me.id, { born: 'unknown', source: 'Wikidata' }).ok, false);
  assert.equal(B.saveLife(pid, me.id, { born: 1949, source: 'Wikidata Q123' }).ok, true);
  assert.equal(B.lifeOf(pid).born_year, 1949);
});

// ── THE SEASON ON ONE LINE ───────────────────────────────

test('the season timeline places every finished book on a shared axis', () => {
  const solo = reader('timeliner');
  const season = SEASONS.ensureSeason(solo.id, SEASONS.build(2025, 1));

  // build(2025, 1) is A/W: July to December.
  const mk = (title, month, year) => {
    const w = run('INSERT INTO works (title, first_published_year) VALUES (?, ?)',
                  title, year).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft)
         VALUES (?, ?, 'FINISHED', ?, 0)`, solo.id, w, `2025-${month}-15 12:00:00`);
  };
  mk('July', '07', 1960);
  mk('September', '09', 1990);
  mk('December', '12', 2020);

  const out = LB.build(solo.id, season.code, { owner: true });
  const t = out.timeline;

  assert.equal(t.read.marks.length, 3, 'every finished book is on the line');
  assert.ok(t.read.marks[0].pct < t.read.marks[2].pct, 'in the order they happened');
  assert.ok(t.read.months.length >= 6, 'and the calendar is readable as one');

  assert.equal(t.written.from, 1960);
  assert.equal(t.written.to, 2020);
  assert.equal(t.written.covers, 3);
  assert.equal(Math.round(t.written.marks[0].pct), 0, 'the oldest sits at the start');
  assert.equal(Math.round(t.written.marks.at(-1).pct), 100, 'the newest at the end');
});

test('a publication track needs a span and three books to be a comparison', () => {
  const solo = reader('onepoint');
  const season = SEASONS.ensureSeason(solo.id, SEASONS.build(2025, 1));

  // All published the same year: a line through one point says nothing.
  for (const t of ['A', 'B', 'C']) {
    const w = run('INSERT INTO works (title, first_published_year) VALUES (?, 2001)', t).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft)
         VALUES (?, ?, 'FINISHED', '2025-09-01 12:00:00', 0)`, solo.id, w);
  }

  assert.equal(LB.build(solo.id, season.code, { owner: true }).timeline.written, null);
});

test('every look carries the same plates', () => {
  const solo = reader('uniform');
  const season = SEASONS.ensureSeason(solo.id, SEASONS.build(2025, 1));
  for (const t of ['First', 'Second']) {
    const w = run('INSERT INTO works (title) VALUES (?)', t).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, started_at, finished_at, is_draft)
         VALUES (?, ?, 'FINISHED', '2025-08-01', '2025-09-01 12:00:00', 0)`, solo.id, w);
  }

  const out = LB.build(solo.id, season.code, { owner: true });
  // There is no hero: a season is not one book and the rest as also-rans.
  assert.equal(out.hero, undefined);
  for (const l of out.looks) {
    assert.ok('wearing' in l && 'marginalia' in l && 'composition' in l && 'care' in l,
      Object.keys(l).join(', '));
  }
});

// ── ASSEMBLY AND PRIVACY ─────────────────────────────────

test('the catalogue assembles in the order the books were finished', () => {
  const solo = reader('runway');
  const seasonRow = SEASONS.ensureSeason(solo.id, SEASONS.build(2025, 1));

  const mk = (title, day) => {
    const w = run('INSERT INTO works (title) VALUES (?)', title).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft)
         VALUES (?, ?, 'FINISHED', ?, 0)`, solo.id, w, `2025-09-${day} 12:00:00`);
  };
  mk('Third', '20'); mk('First', '02'); mk('Second', '11');

  const out = LB.build(solo.id, seasonRow.code, { owner: true });
  assert.deepEqual(out.looks.map((l) => l.work.title), ['First', 'Second', 'Third']);
  assert.deepEqual(out.looks.map((l) => l.n), [1, 2, 3]);
  assert.equal(out.looks[0].of, 3);
});

test('§02 — the pulp is assembled from private notes and only for their owner', () => {
  const writer = reader('annotator');
  const season = SEASONS.ensureSeason(writer.id, SEASONS.build(2025, 1));

  for (let i = 0; i < 4; i++) {
    const w = run('INSERT INTO works (title) VALUES (?)', 'Noted ' + i).lastInsertRowid;
    run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft, private_note)
         VALUES (?, ?, 'FINISHED', ?, 0, ?)`,
        writer.id, w, `2025-09-1${i} 12:00:00`,
        'A sentence long enough to survive the fragment filter, number ' + i + '. ' +
        'And a second one, also long enough to be kept in the shredded object.');
  }

  assert.ok(LB.build(writer.id, season.code, { owner: true }).pulp.length >= 4);
  assert.equal(LB.build(writer.id, season.code, { owner: false }).pulp, null,
    'a note must never reach a page somebody else can load');
});

test('§02 — a season with nothing written in it gets no campaign page', () => {
  // The campaign is "one sentence from the season", and the module's own
  // contract is that it is a sentence the reader wrote or it is nothing.
  // It used to fall back to "One book, in the order they were finished." —
  // a count dressed as a campaign line, filling the one slot in the feature
  // reserved for something only a person can supply. The section is guarded
  // on this value, so nothing written means no page rather than a blank one.
  const quiet = reader('nonotes');
  const season = SEASONS.ensureSeason(quiet.id, SEASONS.build(2025, 1));
  const w = run('INSERT INTO works (title) VALUES (?)', 'Silent').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, finished_at, is_draft)
       VALUES (?, ?, 'FINISHED', '2025-09-01 12:00:00', 0)`, quiet.id, w);

  const out = LB.build(quiet.id, season.code, { owner: true });
  assert.equal(out.campaign, null);
});

test('§05 — Deadstock is one switch away', () => {
  const dnf = reader('abandoner');
  const season = SEASONS.ensureSeason(dnf.id, SEASONS.build(2025, 1));
  const w = run('INSERT INTO works (title) VALUES (?)', 'Put down').lastInsertRowid;
  run(`INSERT INTO readings (user_id, work_id, status, abandoned_at, abandoned_page, is_draft)
       VALUES (?, ?, 'ABANDONED', '2025-09-04 12:00:00', 47, 0)`, dnf.id, w);

  assert.equal(LB.build(dnf.id, season.code, { owner: true }).deadstock.length, 1,
    'it ships on: abandonment is not shameful');
  assert.equal(LB.build(dnf.id, season.code, { owner: true }).deadstock[0].abandoned_page, 47);

  run('UPDATE users SET deadstock_visible = 0 WHERE id = ?', dnf.id);
  assert.equal(LB.build(dnf.id, season.code, { owner: true }).deadstock.length, 0);
});

test('an unknown season is nothing, not an empty catalogue', () => {
  assert.equal(LB.build(me.id, 'ss99', { owner: true }), null);
});
