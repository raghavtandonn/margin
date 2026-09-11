import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run } = await import('../db/index.js');
const IMPORT = await import('../lib/import.js');
const { runImport } = await import('../lib/import-run.js');
const NOTES = await import('../lib/notes.js');
const A = await import('../lib/accounts.js');

const user = A.createUser({ email: 'importer@example.test', passwordHash: 'x' });
A.markVerified(user.id);
A.setUsername(user.id, 'importer');

// ── Real export shapes ───────────────────────────────────
// Header rows copied from what each service actually emits, including the
// columns that make each one identifiable.

const GOODREADS =
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,' +
  'Average Rating,Publisher,Binding,Number of Pages,Year Published,' +
  'Original Publication Year,Date Read,Date Added,Bookshelves,' +
  'Exclusive Shelf,My Review,Private Notes,Read Count\r\n' +
  '2657,"To Kill a Mockingbird","Harper Lee","Lee, Harper",,="0060935464",="9780060935467",5,' +
  '4.27,"Harper Perennial",Paperback,324,2006,1960,"2019/03/14","2018/11/02","classics",' +
  'read,"Read it in two nights.","",1\r\n' +
  '4671,"The Great Gatsby","F. Scott Fitzgerald","Fitzgerald, F. Scott",,="0743273567",="9780743273565",0,' +
  '3.93,"Scribner",Paperback,180,2004,1925,"","2020/01/05","",' +
  'to-read,"","",0\r\n' +
  '11588,"Shantaram","Gregory David Roberts","Roberts, Gregory David",,="0312330537",="9780312330538",4,' +
  '4.24,"St. Martin\'s Griffin",Paperback,933,2005,2003,"","2021/06/01","",' +
  'currently-reading,"","",0\r\n';

const STORYGRAPH =
  'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,' +
  'Star Rating,Review,Tags,Owned?\r\n' +
  '"Piranesi","Susanna Clarke",,"9781635575637",paperback,read,2021/02/01,2021/02/14,4.5,' +
  '"A house that is a world.","fantasy",Yes\r\n' +
  '"Klara and the Sun","Kazuo Ishiguro",,"9780571364886",hardcover,to-read,2021/03/02,,,,"",No\r\n';

const LIBRARYTHING =
  'Title,Primary Author,Secondary Author,Publication,Date,ISBN,Page Count,' +
  'Rating,Review,Collections,Tags,Entry Date,Date Read\r\n' +
  '"Ficciones","Jorge Luis Borges",,"Grove Press",1962,"9780802130303",174,5,' +
  '"Read it as one story.","Your library","short stories",2020-04-11,2020-05-02\r\n';

const PLAIN =
  'Title,Author\r\n' +
  '"The Sailor Who Fell from Grace with the Sea","Yukio Mishima"\r\n' +
  '"Silence","Shusaku Endo"\r\n';

// ── Detection ────────────────────────────────────────────

test('§12 — the format is detected from the headers, never asked for', async (t) => {
  const detect = (csv) => IMPORT.analyse(csv).source?.id;

  await t.test('Goodreads, by Exclusive Shelf and Book Id', () => {
    assert.equal(detect(GOODREADS), 'goodreads');
  });
  await t.test('StoryGraph, by Read Status', () => {
    assert.equal(detect(STORYGRAPH), 'storygraph');
  });
  await t.test('LibraryThing, by Entry Date', () => {
    assert.equal(detect(LIBRARYTHING), 'librarything');
  });
  await t.test('and a plain list falls through to a plain list', () => {
    assert.equal(detect(PLAIN), 'plain');
  });

  await t.test('a file with extra columns bolted on still resolves', () => {
    const withExtras = GOODREADS.replace('Read Count', 'Read Count,Spoiler,Owned');
    assert.equal(IMPORT.analyse(withExtras).source?.id, 'goodreads');
  });

  await t.test('and only an unrecognisable file asks', () => {
    const nonsense = 'alpha,beta,gamma\r\n1,2,3\r\n';
    const result = IMPORT.analyse(nonsense);
    assert.equal(result.ok, false);
    assert.equal(result.needsSource, true);
    assert.deepEqual(result.header, ['alpha', 'beta', 'gamma']);
  });
});

// ── Preview ──────────────────────────────────────────────

test('§12 — the preview reports what is there before anything is written', () => {
  const a = IMPORT.analyse(GOODREADS);

  assert.equal(a.counts.rows, 3);
  assert.equal(a.counts.finished, 1);
  assert.equal(a.counts.waiting, 1);
  assert.equal(a.counts.reading, 1);

  // Nothing has been written by analysing.
  assert.equal(all('SELECT id FROM works').length, 0);
  assert.equal(all('SELECT id FROM readings').length, 0);
});

test('the summary line omits zeroes rather than printing them', () => {
  assert.equal(
    IMPORT.summarise({ rows: 412, finished: 71, waiting: 336, reading: 4, abandoned: 0, unmatched: 1 }),
    '412 rows · 71 finished · 336 waiting · 4 reading · 1 unmatched'
  );
  assert.equal(
    IMPORT.summarise({ rows: 2, finished: 2, waiting: 0, reading: 0, abandoned: 0, unmatched: 0 }),
    '2 rows · 2 finished'
  );
});

test('§12 — the shelf mapping is proposed in their vocabulary, not translated away', () => {
  const a = IMPORT.analyse(GOODREADS);
  const byValue = Object.fromEntries(a.mapping.map((m) => [m.value, m.status]));

  // Their words survive as the keys.
  assert.deepEqual(Object.keys(byValue).sort(), ['currently-reading', 'read', 'to-read']);
  assert.equal(byValue['read'], 'FINISHED');
  assert.equal(byValue['to-read'], 'WAITING');
  assert.equal(byValue['currently-reading'], 'READING');
});

test('the proposed mapping handles the other services\' words too', () => {
  assert.equal(IMPORT.guessStatus('read'), 'FINISHED');
  assert.equal(IMPORT.guessStatus('to-read'), 'WAITING');
  assert.equal(IMPORT.guessStatus('currently-reading'), 'READING');
  assert.equal(IMPORT.guessStatus('did-not-finish'), 'ABANDONED');
  assert.equal(IMPORT.guessStatus('Read'), 'FINISHED');
  assert.equal(IMPORT.guessStatus('Want to Read'), 'WAITING');
  assert.equal(IMPORT.guessStatus('Your library'), 'WAITING', 'owning a book is not having read it');
});

// ── Unmatched ────────────────────────────────────────────

test('§12 — a row with no title is kept, not dropped', () => {
  const withHole = GOODREADS + '999,"","",,,,,0,,,,,,,,"2020/01/01","",to-read,"","",0\r\n';
  const a = IMPORT.analyse(withHole);

  assert.equal(a.counts.unmatched, 1);
  assert.equal(a.unmatched.length, 1);
  // The line number is what makes it fixable by hand.
  assert.equal(a.unmatched[0].line, 5);
  assert.equal(a.rows.length, 3, 'the usable rows are unaffected');
});

// ── Writing ──────────────────────────────────────────────

const mappingFor = (a) => Object.fromEntries(a.mapping.map((m) => [m.value, m.status]));

test('§12 — an import writes what the preview promised', async () => {
  const a = IMPORT.analyse(GOODREADS);
  const result = await runImport(user.id, a.rows, mappingFor(a));

  assert.equal(result.imported, 3);
  assert.equal(result.failed.length, 0);

  const statuses = all(
    `SELECT w.title, r.status, r.stars FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? ORDER BY w.title`, user.id
  );
  // Ordered by title: Shantaram, The Great Gatsby, To Kill a Mockingbird.
  assert.deepEqual(statuses.map((s) => s.status), ['READING', 'WAITING', 'FINISHED']);

  // §2 — a Goodreads rating of 0 means unrated, not one star.
  const gatsby = statuses.find((s) => s.title === 'The Great Gatsby');
  assert.equal(gatsby.stars, null, 'a zero rating must not become a star');

  const mockingbird = statuses.find((s) => s.title === 'To Kill a Mockingbird');
  assert.equal(mockingbird.stars, 5);
});

test('§12 — a review lands in notes, marked imported, with a date', () => {
  const reading = get(
    `SELECT r.* FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND w.title = 'To Kill a Mockingbird'`, user.id
  );

  assert.equal(NOTES.noteOf(reading), 'Read it in two nights.');
  assert.equal(reading.note_imported, 1, 'it must be distinguishable from a note written here');
  assert.match(reading.note_imported_at, /^\d{4}-\d{2}-\d{2}$/);

  // And it is encrypted like every other note, not stored in the clear.
  assert.equal(reading.private_note, null);
  assert.ok(reading.note_encrypted);
});

test('§19 — running the same file twice does not duplicate a library', async (t) => {
  const before = {
    works: all('SELECT id FROM works').length,
    editions: all('SELECT id FROM editions').length,
    readings: all('SELECT id FROM readings WHERE user_id = ?', user.id).length,
    items: all('SELECT id FROM shelf_items').length
  };

  const a = IMPORT.analyse(GOODREADS);
  await runImport(user.id, a.rows, mappingFor(a));

  const after = {
    works: all('SELECT id FROM works').length,
    editions: all('SELECT id FROM editions').length,
    readings: all('SELECT id FROM readings WHERE user_id = ?', user.id).length,
    items: all('SELECT id FROM shelf_items').length
  };

  await t.test('no new works', () => assert.equal(after.works, before.works));
  await t.test('no new editions', () => assert.equal(after.editions, before.editions));
  await t.test('no new readings', () => assert.equal(after.readings, before.readings));
  await t.test('no new shelf entries', () => assert.equal(after.items, before.items));
});

test('a file with no ISBN is idempotent too', async () => {
  const a = IMPORT.analyse(PLAIN);
  await runImport(user.id, a.rows, mappingFor(a));
  const first = all('SELECT id FROM editions').length;
  const works = all('SELECT id FROM works').length;

  await await runImport(user.id, IMPORT.analyse(PLAIN).rows, mappingFor(a));

  // An edition with no ISBN has nothing unique about it, so a naive insert
  // would add one on every pass and the library would quietly double.
  assert.equal(all('SELECT id FROM editions').length, first);
  assert.equal(all('SELECT id FROM works').length, works);
});

test('§12 — an import is additive: it never blanks what is already there', async () => {
  const reading = get(
    `SELECT r.* FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND w.title = 'The Great Gatsby'`, user.id
  );

  // The reader rates it and writes their own note — neither is in the file.
  run('UPDATE readings SET stars = 3 WHERE id = ?', reading.id);
  NOTES.setNote(reading.id, 'Mine, written here.');
  run('UPDATE readings SET note_imported = 0, note_imported_at = NULL WHERE id = ?', reading.id);

  const a = IMPORT.analyse(GOODREADS);
  await runImport(user.id, a.rows, mappingFor(a));

  const after = get('SELECT * FROM readings WHERE id = ?', reading.id);
  assert.equal(after.stars, 3, 'an empty rating in the file must not clear a real one');
  assert.equal(NOTES.noteOf(after), 'Mine, written here.', 'a note written here is never overwritten');
  assert.equal(after.note_imported, 0);
});

test('a skipped shelf writes nothing', async () => {
  const a = IMPORT.analyse(STORYGRAPH);
  const mapping = { ...mappingFor(a), 'to-read': 'SKIP' };
  const before = all('SELECT id FROM works').length;

  const result = await runImport(user.id, a.rows, mapping);
  assert.equal(result.skipped, 1);

  // Piranesi came in; Klara did not.
  assert.ok(get(`SELECT id FROM works WHERE title = 'Piranesi'`));
  assert.equal(get(`SELECT id FROM works WHERE title = 'Klara and the Sun'`), undefined);
  assert.equal(all('SELECT id FROM works').length, before + 1);
});

test('each service\'s columns are read, not just its shelf names', () => {
  const sg = IMPORT.analyse(STORYGRAPH).rows.find((r) => r.title === 'Piranesi');
  assert.equal(sg.author, 'Susanna Clarke');
  assert.equal(sg.isbn13, '9781635575637');
  assert.equal(sg.rating, 4.5);
  assert.equal(sg.review, 'A house that is a world.');
  assert.equal(sg.dateRead, '2021-02-14');

  const lt = IMPORT.analyse(LIBRARYTHING).rows[0];
  assert.equal(lt.title, 'Ficciones');
  assert.equal(lt.author, 'Jorge Luis Borges');
  assert.equal(lt.pages, 174);
  assert.equal(lt.dateAdded, '2020-04-11');

  // Goodreads wraps identifiers as ="9780060935467" so Excel keeps them.
  const gr = IMPORT.analyse(GOODREADS).rows[0];
  assert.equal(gr.isbn13, '9780060935467');
  assert.equal(gr.pages, 324);
});

test('§12 — the 50,000 row cap is enforced', () => {
  const many = 'Title,Author\r\n' + '"A Book","An Author"\r\n'.repeat(60);
  assert.throws(() => IMPORT.analyse(many, { maxRows: 50 }), /More than 50 rows/);
});

// ── THE GOODREADS DATA EXPORT ────────────────────────────
//
// The folder of zipped JSON that "Request my data" sends, which is a
// different and much poorer file from the CSV: no author, no ISBN, no page
// count, no date read.
//
// The absence of an author is the dangerous part. Every one of these rows
// reaches the last branch of resolveWork, and before this was handled that
// branch created a new work for every row — so importing this file on top of
// a library that already held those books silently doubled it, four hundred
// authorless duplicates that could never be merged back.

const GX = await import('../lib/goodreads-export.js');

// One record, plus the prose "explanation" element these files really carry
// as their first array entry.
const dataExport = (rows) => JSON.stringify([
  { explanation: ['Your shelving and review of a book.'] },
  ...rows.map((r) => ({
    rating: r.rating || 0, read_status: r.status || 'read',
    review: r.review || '(not provided)', book: r.book,
    created_at: '2024-03-01 10:00:00 UTC', user: 'A Reader',
    includes_spoilers: 'No', notes: '(not provided)'
  }))
]);

test('a data export is recognised by its contents, not its name', () => {
  const parsed = JSON.parse(dataExport([{ book: 'Stoner' }]));
  assert.equal(GX.identify(parsed), 'library');

  // The prose element is not a book. Reading it as one produces a phantom
  // row with no title.
  assert.equal(GX.libraryCSV(parsed).split('\n').length, 2);
});

test('the series number comes off a title, an imprint does not', () => {
  assert.equal(GX.cleanTitle('Wolf Hall (Thomas Cromwell, #1)'), 'Wolf Hall');
  assert.equal(GX.cleanTitle('The Human Use of Human Beings (Da Capo)'),
               'The Human Use of Human Beings (Da Capo)');
});

test('an authorless import matches a library instead of doubling it', async () => {
  const owner = A.createUser({ email: 'dataexport@example.test', passwordHash: 'x' });

  // A library as it would already stand: two books, both with authors.
  const seeded = IMPORT.analyse(
    'Title,Author,Exclusive Shelf\r\n' +
    '"Stoner","John Williams","read"\r\n' +
    '"Dune","Frank Herbert","read"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));
  const before = get('SELECT COUNT(*) n FROM works').n;

  // The same two books arriving from the data export, which names neither
  // author and puts an imprint in one of the titles.
  const a = IMPORT.analyse(GX.libraryCSV(JSON.parse(dataExport([
    { book: 'Stoner', rating: 5 },
    { book: 'Dune (Vintage)' }
  ]))));
  const res = await runImport(owner.id, a.rows, mappingFor(a));

  assert.equal(res.newWorks, 0, 'no new works: both books are already here');
  assert.equal(get('SELECT COUNT(*) n FROM works').n, before);

  // And the rating the data export carried is applied to the book that was
  // already there rather than to a duplicate of it.
  const stoner = get(
    `SELECT r.stars FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND w.title = 'Stoner'`, owner.id
  );
  assert.equal(stoner.stars, 5);
});

test('two of your own books with one title are refused, not guessed at', async () => {
  const owner = A.createUser({ email: 'twotitles@example.test', passwordHash: 'x' });

  const seeded = IMPORT.analyse(
    'Title,Author,Exclusive Shelf\r\n' +
    '"Leviathan","Thomas Hobbes","read"\r\n' +
    '"Leviathan","Paul Auster","read"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));

  const a = IMPORT.analyse(GX.libraryCSV(JSON.parse(dataExport([
    { book: 'Leviathan', rating: 4 }
  ]))));
  const res = await runImport(owner.id, a.rows, mappingFor(a));

  assert.equal(res.newWorks, 0, 'and no third Leviathan is invented either');
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /two of your books/);

  // Neither Hobbes nor Auster gets a rating it did not earn.
  const rated = all(
    `SELECT r.stars FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND w.title = 'Leviathan' AND r.stars IS NOT NULL`, owner.id
  );
  assert.equal(rated.length, 0);
});

test('notes and dates attach to books that are here, and never create one', async () => {
  const SUP = await import('../lib/supplement.js');
  const owner = A.createUser({ email: 'supplement@example.test', passwordHash: 'x' });

  const seeded = IMPORT.analyse(
    'Title,Author,Exclusive Shelf\r\n"Wolf Hall","Hilary Mantel","read"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));
  const works = get('SELECT COUNT(*) n FROM works').n;

  const plan = SUP.planSupplement(owner.id, 'notes', [
    { title: 'Wolf Hall', text: 'this shit is so dense', at: '2024-01-20' },
    { title: 'A Book Not In The Library', text: 'unreachable', at: '2024-01-20' }
  ]);

  assert.equal(plan.applied.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].why, /no book of that name/);

  assert.equal(SUP.applySupplement(owner.id, plan), 1);
  assert.equal(get('SELECT COUNT(*) n FROM works').n, works, 'a supplement creates nothing');

  // Running the same file again is a no-op rather than a second copy.
  const again = SUP.planSupplement(owner.id, 'notes', [
    { title: 'Wolf Hall', text: 'this shit is so dense', at: '2024-01-20' }
  ]);
  assert.equal(again.applied.length, 0);
  assert.match(again.skipped[0].why, /already imported/);
});

test('a supplement never overwrites a date that is already there', async () => {
  const SUP = await import('../lib/supplement.js');
  const owner = A.createUser({ email: 'dates@example.test', passwordHash: 'x' });

  // Book Id is what makes this detect as Goodreads rather than as a plain
  // list, and a plain list has no status column, so nothing would be
  // FINISHED and no finish date would be written at all.
  const seeded = IMPORT.analyse(
    'Book Id,Title,Author,Exclusive Shelf,Date Read\r\n' +
    '"1","Stoner","John Williams","read","2023-05-05"\r\n' +
    '"2","Dune","Frank Herbert","read",""\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));

  const plan = SUP.planSupplement(owner.id, 'activity', [
    { title: 'Stoner', field: 'finished_at', at: '2019-01-01' },
    { title: 'Dune', field: 'finished_at', at: '2024-08-08' }
  ]);

  assert.equal(plan.applied.length, 1, 'only the missing one');
  assert.equal(plan.applied[0].title, 'Dune');
  assert.match(plan.skipped[0].why, /already has a finished date/);

  SUP.applySupplement(owner.id, plan);
  const stoner = get(
    `SELECT r.finished_at f FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND w.title = 'Stoner'`, owner.id
  );
  assert.equal(stoner.f, '2023-05-05', 'the date that was already there survived');
});

// ── TITLE MATCHING ───────────────────────────────────────

const TM = await import('../lib/title-match.js');

test('titles that render identically compare identically', () => {
  // This library really holds a title with a NO-BREAK SPACE inside it where
  // the export has an ordinary space. They look the same on screen, they
  // compared unequal, and that one invisible character was enough to make
  // the importer create a second copy of the book.
  assert.equal(
    TM.titleKey('Imperial Powers, 1618-1850 (History of Warfare, 75)'),
    TM.titleKey('Imperial Powers, 1618-1850 (History of Warfare, 75)')
  );

  // The other invisible differences: curly quotes, en dashes, accents.
  assert.equal(TM.titleKey('The Handmaid’s Tale'), TM.titleKey("The Handmaid's Tale"));
  assert.equal(TM.titleKey('1914–1918'), TM.titleKey('1914-1918'));
  assert.equal(TM.titleKey('Café Society'), TM.titleKey('Cafe Society'));
});

test('the forms of a title are tried most specific first', () => {
  const v = TM.variants('Tosca: Libretto (Libretti d\'opera) (Italian Edition)');
  assert.equal(v[0], TM.titleKey('Tosca: Libretto (Libretti d\'opera) (Italian Edition)'));
  assert.ok(v.includes(TM.titleKey('Tosca: Libretto')), 'both parentheticals come off');

  // A bracketed transliteration, which is how the export writes them.
  assert.ok(TM.variants('キッチン [Kitchin]').includes(TM.titleKey('キッチン')));
});

test('two books with one title are told apart by the day they were shelved', async () => {
  const owner = A.createUser({ email: 'leviathan@example.test', passwordHash: 'x' });

  // Two real books with one title, shelved eighteen months apart.
  const seeded = IMPORT.analyse(
    'Book Id,Title,Author,Exclusive Shelf,Date Added\r\n' +
    '"1","Leviathan","Thomas Hobbes","to-read","2023-11-06"\r\n' +
    '"2","Leviathan","Paul Auster","to-read","2022-08-15"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));

  const idOf = (author) => get(
    `SELECT w.id FROM works w JOIN work_people wp ON wp.work_id = w.id
       JOIN people p ON p.id = wp.person_id WHERE w.title = 'Leviathan' AND p.name = ?`,
    author
  ).id;

  // The export names neither author. Only the date can decide.
  const auster = TM.matchAuthorless(owner.id, {
    title: 'Leviathan', dateAdded: '2022-08-15', sourceShelf: 'to-read', rating: null
  });
  assert.equal(auster.workId, idOf('Paul Auster'));
  assert.match(auster.why, /shelved/);

  const hobbes = TM.matchAuthorless(owner.id, {
    title: 'Leviathan', dateAdded: '2023-11-06', sourceShelf: 'to-read', rating: null
  });
  assert.equal(hobbes.workId, idOf('Thomas Hobbes'));
});

test('a day of slack, because the export stamps UTC and the library stored local', async () => {
  const owner = A.createUser({ email: 'timezone@example.test', passwordHash: 'x' });
  const seeded = IMPORT.analyse(
    'Book Id,Title,Author,Exclusive Shelf,Date Added\r\n' +
    '"1","The Secret History","Procopius","to-read","2025-01-20"\r\n' +
    '"2","The Secret History","Donna Tartt","read","2022-09-18"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));

  // 2025-01-21 01:13 UTC was 2025-01-20 where the reader was.
  const m = TM.matchAuthorless(owner.id, {
    title: 'The Secret History', dateAdded: '2025-01-21', sourceShelf: 'to-read', rating: null
  });
  const procopius = get(
    `SELECT w.id FROM works w JOIN work_people wp ON wp.work_id = w.id
       JOIN people p ON p.id = wp.person_id WHERE p.name = 'Procopius'`
  ).id;
  assert.equal(m.workId, procopius);
});

test('a tie is left unresolved rather than decided by row order', async () => {
  const owner = A.createUser({ email: 'tied@example.test', passwordHash: 'x' });
  const seeded = IMPORT.analyse(
    'Book Id,Title,Author,Exclusive Shelf,Date Added\r\n' +
    '"1","Gold","Chris Cleave","to-read","2020-01-01"\r\n' +
    '"2","Gold","Dan Rhodes","to-read","2020-01-01"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));

  // Same title, same day, same status, no rating: nothing distinguishes
  // them, so neither is chosen and neither is invented.
  const m = TM.matchAuthorless(owner.id, {
    title: 'Gold', dateAdded: '2020-01-01', sourceShelf: 'to-read', rating: null
  });
  assert.equal(m.workId, null);
  assert.ok(!m.create, 'and it does not fall through to creating a third Gold');
  assert.match(m.why, /share this title/);
});

test('a book the reader does not have is still created', () => {
  const owner = A.createUser({ email: 'brandnew@example.test', passwordHash: 'x' });
  const m = TM.matchAuthorless(owner.id, {
    title: 'Something Nobody Here Owns', dateAdded: '2024-01-01', sourceShelf: 'to-read', rating: null
  });
  assert.equal(m.workId, null);
  assert.equal(m.create, true, 'matching is not the same as refusing');
});

test('a whole authorless library merges into an existing one without doubling it', async () => {
  const owner = A.createUser({ email: 'nodouble@example.test', passwordHash: 'x' });

  const seeded = IMPORT.analyse(
    'Book Id,Title,Author,Exclusive Shelf,Date Added\r\n' +
    '"1","Stoner","John Williams","read","2022-01-01"\r\n' +
    '"2","Dune","Frank Herbert","read","2022-02-02"\r\n' +
    '"3","Leviathan","Thomas Hobbes","to-read","2023-11-06"\r\n' +
    '"4","Leviathan","Paul Auster","to-read","2022-08-15"\r\n'
  );
  await runImport(owner.id, seeded.rows, mappingFor(seeded));
  const before = get('SELECT COUNT(*) n FROM works').n;

  // The same four books as the data export sees them: no authors, an
  // imprint welded into one title, a no-break space in another.
  const a = IMPORT.analyse(GX.libraryCSV(JSON.parse(dataExport([
    { book: 'Stoner', rating: 5 },
    { book: 'Dune (Vintage)' },
    { book: 'Leviathan' },
    { book: 'Leviathan' }
  ]))));
  // dataExport stamps one shared date, so the two Leviathans tie and are
  // reported rather than guessed at. The other two must still merge.
  const res = await runImport(owner.id, a.rows, mappingFor(a));

  assert.equal(res.newWorks, 0, 'nothing is created');
  assert.equal(get('SELECT COUNT(*) n FROM works').n, before);
  assert.equal(res.failed.length, 2, 'and the genuinely undecidable pair is reported');
});

// ── §12 — A LIST SOMEBODY TYPED ──────────────────────────
//
// The format was advertised on the import screen from the beginning and the
// product could not read one: with no header row, the CSV parser took the
// first book as a column name and every book after it arrived with no title.
// These tests are the shape of that bug, not just its instance.

test('§12 — a bare list of titles is read as books, not as a header row', () => {
  const a = IMPORT.analyse('The Secret History\nStoner\nGilead');

  assert.equal(a.ok, true);
  assert.equal(a.source.id, 'list');
  assert.deepEqual(a.rows.map((r) => r.title), ['The Secret History', 'Stoner', 'Gilead']);
  assert.equal(a.counts.unmatched, 0, 'nothing is unmatched: every line was a title');
});

test('§12 — the separators a person actually types', () => {
  const a = IMPORT.analyse(
    '1. Stoner by John Williams\n' +
    '2. Gilead — Marilynne Robinson\n' +
    '- The Secret History – Donna Tartt\n' +
    '• Anti-Oedipus\n' +
    '"Housekeeping"\n' +
    'Beloved\tToni Morrison'
  );

  assert.deepEqual(a.rows.map((r) => [r.title, r.author]), [
    ['Stoner', 'John Williams'],
    ['Gilead', 'Marilynne Robinson'],
    ['The Secret History', 'Donna Tartt'],
    // A hyphen with no space around it is part of a word, not a separator.
    ['Anti-Oedipus', null],
    ['Housekeeping', null],
    ['Beloved', 'Toni Morrison']
  ]);
});

test('§12 — "Death by Water by Kenzaburo Oe" keeps its title', () => {
  const [row] = IMPORT.analyse('Death by Water by Kenzaburo Oe').rows;
  assert.equal(row.title, 'Death by Water');
  assert.equal(row.author, 'Kenzaburo Oe');
});

test('§12 — a comma is a separator only when the whole file agrees', () => {
  // A file where nearly every line is "title, author" reads as two columns.
  const pairs = IMPORT.analyse(
    'Cloud Atlas, David Mitchell\nStoner, John Williams\nGilead, Marilynne Robinson'
  );
  assert.deepEqual(pairs.rows.map((r) => r.author),
    ['David Mitchell', 'John Williams', 'Marilynne Robinson']);

  // A file of titles that happen to contain commas does not. Nothing in
  // "Goodbye, Columbus" says which it is — only the company it keeps does.
  const titles = IMPORT.analyse(
    'Goodbye, Columbus\nThe Lion, the Witch and the Wardrobe\nEat, Pray, Love'
  );
  assert.deepEqual(titles.rows.map((r) => r.title),
    ['Goodbye, Columbus', 'The Lion, the Witch and the Wardrobe', 'Eat, Pray, Love']);
  assert.equal(titles.rows.every((r) => r.author === null), true);
});

test('§12 — "Tartt, Donna" is turned round; a trailing year is taken off', () => {
  const [a] = IMPORT.analyse('The Secret History by Tartt, Donna').rows;
  assert.equal(a.author, 'Donna Tartt');

  const [b] = IMPORT.analyse('Stoner by John Williams (1965)').rows;
  assert.equal(b.title, 'Stoner');
  assert.equal(b.year, 1965);
});

test('§12 — a real table is still a table, and an unknown one still asks', () => {
  // Detection must not be stolen by the list parser.
  assert.equal(IMPORT.analyse(GOODREADS).source.id, 'goodreads');
  assert.equal(IMPORT.analyse(STORYGRAPH).source.id, 'storygraph');
  assert.equal(IMPORT.analyse(LIBRARYTHING).source.id, 'librarything');

  // Columns we do not recognise, in a shape only a table has. Reading this
  // as a list would silently eat the header and mangle every row.
  const foreign = 'Titre,Auteur,Note,Date\nStoner,John Williams,5,2020\nGilead,M. Robinson,4,2021';
  const a = IMPORT.analyse(foreign);
  assert.equal(a.needsSource, true);
});

test('§12 — a list goes through the same preview, mapping and write', async () => {
  const reader = A.createUser({ email: 'lister@example.test', passwordHash: 'x' });
  A.markVerified(reader.id);

  const a = IMPORT.analyse('Stoner by John Williams\nGilead by Marilynne Robinson\nHousekeeping');

  // One mapping row, because a list makes no distinctions — and it is still
  // shown, because what these books ARE is the one thing the file cannot say.
  assert.equal(a.mapping.length, 1);
  assert.equal(a.mapping[0].status, 'WAITING');
  assert.equal(a.list.withAuthor, 2);
  assert.equal(a.list.withoutAuthor, 1);

  const result = await runImport(reader.id, a.rows, mappingFor(a));
  assert.equal(result.imported, 3);
  assert.equal(result.failed.length, 0);

  const shelved = all(
    `SELECT w.title FROM shelf_items si
       JOIN shelves s ON s.id = si.shelf_id
       JOIN works w ON w.id = si.work_id
      WHERE s.user_id = ? AND s.slug = 'waiting' ORDER BY w.title`,
    reader.id
  ).map((r) => r.title);
  assert.deepEqual(shelved, ['Gilead', 'Housekeeping', 'Stoner']);
});

test('§12 — an empty paste is an error, not an empty import', () => {
  assert.equal(IMPORT.analyse('   \n\n  \n').ok, false);
});
