import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDB } from './helpers.js';

useTempDB();

const { get, all, run } = await import('../db/index.js');
const S = await import('../lib/seasons.js');
const F = await import('../lib/facts.js');
const M = await import('../lib/movements.js');
const LB = await import('../lib/lookbook.js');
const RUN = await import('../lib/season-run.js');
const SF = await import('../lib/season-facts.js');
const C = await import('../lib/colour.js');
const A = await import('../lib/accounts.js');
const NOTES = await import('../lib/notes.js');

const user = A.createUser({ email: 'season@example.test', passwordHash: 'x' });
A.markVerified(user.id);
A.setUsername(user.id, 'seasonal');

// ── A fixture library ────────────────────────────────────
let nextWork = 1;
function addBook({ title, author = 'An Author', finished, started = null, pages = 300,
                   stars = 4, translator = null, subjects = [], year = 2000,
                   pass = 1, note = null, abandonedAt = null, abandonedPage = null,
                   waitingSince = null, uid = user.id }) {
  const id = nextWork++;
  run('INSERT INTO works (id, title, first_published_year, subjects) VALUES (?, ?, ?, ?)',
      id, title, year, JSON.stringify(subjects));

  const personId = 1000 + id;
  run('INSERT INTO people (id, name) VALUES (?, ?)', personId, author);
  run(`INSERT INTO work_people (work_id, person_id, role, ord) VALUES (?, ?, 'AUTHOR', 0)`, id, personId);
  if (translator) {
    run('INSERT INTO people (id, name) VALUES (?, ?)', 2000 + id, translator);
    run(`INSERT INTO work_people (work_id, person_id, role, ord) VALUES (?, ?, 'TRANSLATOR', 0)`, id, 2000 + id);
  }

  run('INSERT INTO editions (work_id, page_count) VALUES (?, ?)', id, pages);
  const ed = get('SELECT id FROM editions WHERE work_id = ? ORDER BY id DESC LIMIT 1', id);

  run(
    `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number, stars,
                           started_at, finished_at, abandoned_at, abandoned_page, total_positions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, id, ed.id, abandonedAt ? 'ABANDONED' : 'FINISHED', pass, stars,
    started, abandonedAt ? null : finished, abandonedAt, abandonedPage, pages
  );

  const reading = get('SELECT * FROM readings WHERE user_id = ? AND work_id = ? AND pass_number = ?',
                      uid, id, pass);
  if (note) NOTES.setNote(reading.id, note);

  if (waitingSince) {
    run(`INSERT OR IGNORE INTO shelves (user_id, name, slug) VALUES (?, 'WAITING', 'waiting')`, uid);
    const sh = get(`SELECT id FROM shelves WHERE user_id = ? AND slug = 'waiting'`, uid);
    run('INSERT OR IGNORE INTO shelf_items (shelf_id, work_id, added_at) VALUES (?, ?, ?)',
        sh.id, id, waitingSince);
  }
  return id;
}

// ── §1 / §2 — DEFINITION AND ASSIGNMENT ──────────────────

test('§1 — two seasons a year, on the retail calendar', async (t) => {
  await t.test('January is Spring/Summer, which looks wrong and is right', () => {
    const s = S.seasonOf('2026-01-15');
    assert.equal(s.code, 'ss26');
    assert.equal(s.label, 'Spring/Summer 26');
    assert.equal(s.short, 'S/S 26');
  });

  await t.test('July is Autumn/Winter', () => {
    assert.equal(S.seasonOf('2026-07-15').code, 'aw26');
  });

  await t.test('no season straddles a year boundary', () => {
    for (const half of ['ss', 'aw']) {
      const s = S.build(2026, half);
      assert.equal(s.starts_on.slice(0, 4), s.ends_on.slice(0, 4));
    }
  });

  await t.test('labels are not inverted for the southern hemisphere', () => {
    // A fashion reference, not a weather report. The label is global.
    assert.equal(S.seasonOf('2026-01-15').label, 'Spring/Summer 26');
  });

  await t.test('the code round-trips', () => {
    assert.equal(S.parseCode('aw26').code, 'aw26');
    assert.equal(S.parseCode('AW26').label, 'Autumn/Winter 26');
    assert.equal(S.parseCode('nonsense'), null);
  });
});

test('§15 — 30 June lands in S/S; 1 July lands in A/W', () => {
  assert.equal(S.seasonOf('2026-06-30').code, 'ss26', '30 June is Spring/Summer');
  assert.equal(S.seasonOf('2026-07-01').code, 'aw26', '1 July is Autumn/Winter');
  assert.equal(S.seasonOf('2026-12-31').code, 'aw26');
  assert.equal(S.seasonOf('2027-01-01').code, 'ss27');
});

test('§2 — a book belongs to the season it was FINISHED in', () => {
  // Started in one season, finished three seasons later.
  addBook({ title: 'A Long One', finished: '2026-08-04', started: '2025-02-01' });
  const aw26 = S.readingsIn(user.id, S.parseCode('aw26'));
  assert.ok(aw26.some((b) => b.title === 'A Long One'));
  assert.equal(S.readingsIn(user.id, S.parseCode('ss25')).length, 0,
    'it does not also appear in the season it was started in');
});

test('§2 — an undated finish belongs to no season at all', () => {
  run(`INSERT INTO works (id, title) VALUES (9001, 'Undated')`);
  run(`INSERT INTO readings (user_id, work_id, status, finished_at) VALUES (?, 9001, 'FINISHED', NULL)`, user.id);
  assert.equal(S.undatedCount(user.id), 1);
  // And it is not quietly dated into the current season.
  for (const s of S.rangeOfSeasons('2019-01-01', new Date('2026-12-31'))) {
    assert.ok(!S.readingsIn(user.id, s).some((b) => b.title === 'Undated'));
  }
  run('DELETE FROM readings WHERE work_id = 9001');
  run('DELETE FROM works WHERE id = 9001');
});

// ── §4 — THE FACT ENGINE ─────────────────────────────────

test('§4.1 — the longest gap carries the books either side of it', () => {
  const books = [
    { finishedOn: '2026-01-05', title: 'First', page_count: 200 },
    { finishedOn: '2026-01-10', title: 'Second', page_count: 200 },
    { finishedOn: '2026-03-01', title: 'Third', page_count: 200 }
  ];
  const v = F.volumeAndPace(books);
  assert.equal(v.longest_gap.days, 50);
  assert.equal(v.longest_gap.before, 'Second');
  assert.equal(v.longest_gap.after, 'Third');
});

test('§4.6 — a changepoint is found, and only when it separates', async (t) => {
  await t.test('a clean split is reported', () => {
    const books = [
      { finishedOn: '2026-01-01', translator: null, subjects: [], page_count: 100, stars: 4 },
      { finishedOn: '2026-02-01', translator: null, subjects: [], page_count: 100, stars: 4 },
      { finishedOn: '2026-03-01', translator: 'A', subjects: [], page_count: 100, stars: 4 },
      { finishedOn: '2026-04-01', translator: 'B', subjects: [], page_count: 100, stars: 4 },
      { finishedOn: '2026-05-01', translator: 'C', subjects: [], page_count: 100, stars: 4 }
    ];
    const cps = F.changepoints(books);
    const t2 = cps.find((c) => c.property === 'translated');
    assert.ok(t2, 'the turn to translation is found');
    assert.equal(t2.on, '2026-03-01');
    assert.ok(t2.score > 1.2);
  });

  await t.test('noise is not', () => {
    // Distinct, increasing dates: duplicates get reordered by the sort and
    // the alternation stops being an alternation.
    const books = Array.from({ length: 8 }, (_, i) => ({
      finishedOn: `2026-01-0${i + 1}`,
      translator: i % 2 ? 'X' : null, subjects: [], page_count: 300, stars: 4
    }));
    const cps = F.changepoints(books);
    assert.ok(!cps.some((c) => c.property === 'translated'),
      'alternating values have no split worth reporting');
  });

  await t.test('at most two are reported', () => {
    const books = Array.from({ length: 10 }, (_, i) => ({
      finishedOn: `2026-${String(i + 1).padStart(2, '0')}-01`,
      translator: i >= 5 ? 'X' : null,
      subjects: i >= 5 ? ['Fiction'] : ['History'],
      page_count: i >= 5 ? 600 : 100,
      stars: i >= 5 ? 5 : 2,
      first_published_year: i >= 5 ? 2020 : 1900
    }));
    assert.ok(F.changepoints(books).length <= 2);
  });
});

test('§4.5 — recurring terms use the reader\'s OWN corpus as background', () => {
  // "Global TF-IDF surfaces 'book' and 'read'; personal TF-IDF surfaces the
  // words unusual FOR THEM this season."
  const season = [
    { title: 'A', note: 'the harbour at dusk, the harbour again' },
    { title: 'B', note: 'a harbour town, and the sea' }
  ];
  const corpus = Array.from({ length: 40 }, () => 'the sea and the sea again');

  const f = F.noteFacts(season, corpus);
  const terms = f.recurring_terms.map((t) => t.term);
  assert.ok(terms.includes('harbour'), 'the unusual word surfaces');
  assert.ok(!terms.includes('sea'), 'the word they always use does not');
});

test('§4.5 — no sentiment is computed anywhere', async () => {
  const src = await (await import('node:fs')).promises.readFile('lib/facts.js', 'utf8');
  assert.ok(!/sentiment|polarity|positive|negative|mood/i.test(src.replace(/\/\/.*$/gm, '')),
    'sentiment is one step from psychologising and is banned');
});

// ── §4.7 — RANKING ───────────────────────────────────────

test('§15 — a first-ever season produces no comparative claims', async () => {
  const solo = A.createUser({ email: 'first@example.test', passwordHash: 'x' });
  A.markVerified(solo.id);
  for (let i = 0; i < 6; i++) {
    addBook({ title: `Solo ${i}`, finished: `2026-02-0${i + 1}`, uid: solo.id, pages: 200 + i });
  }

  const row = await RUN.refresh(solo.id, 'ss26', { now: new Date('2026-08-01') });
  const facts = JSON.parse(row.facts);

  assert.equal(facts.comparable, false, 'fewer than two prior closed seasons');
  for (const f of facts.ranked) assert.equal(f.baseline, null, 'no baselines exist yet');
  assert.ok(!/usual|against|than last|more than|fewer than/i.test(row.note || ''),
    `a first season compares to nothing: ${row.note}`);
});

test('§4.7 — at most two facts from any one subsection', async () => {
  const facts = {
    counts: { finished: 12, abandoned: 2 },
    volume: { books_finished: 12, pages_n: 12, pages_total: 4000, pages_median: 320,
              pages_mean: 333, mean_days_to_finish: 12, longest_gap: { days: 40, before: 'A', after: 'B' },
              slowest_book: { book: { title: 'S' }, d: 90 }, active_days: 60, finish_distribution: {} },
    composition: { translated_share: .5, translated_count: 6, languages_present: ['fr', 'de'],
                   languages_new: ['de'], pub_decade_distribution: {}, pub_year_median: 1990,
                   authors_repeated: [{ name: 'X', n: 3 }], authors_new: [],
                   form_split: { fiction: 8, nonfiction: 4, n: 12 } },
    behaviour: { abandonments: { count: 2, traits: [], books: [] }, rereads: [],
                 longest_wait: null, rating_distribution: {}, rating_mean: 4, rating_n: 12 },
    notes: { notes_written: 5, recurring_terms: [{ term: 'a' }, { term: 'b' }], longest_note: null },
    changepoints: [], clusters: []
  };

  const { facts: top } = SF.rank(facts, []);
  const bySection = {};
  for (const f of top) bySection[f.section] = (bySection[f.section] || 0) + 1;

  for (const [section, n] of Object.entries(bySection)) {
    // The book count is deliberately exempt, so 4.1 may carry three.
    const cap = section === '4.1' ? 3 : 2;
    assert.ok(n <= cap, `${section} carried ${n}`);
  }
  assert.ok(top.length <= 8);
});

// ── §6 — MOVEMENTS ───────────────────────────────────────

test('§15 — a 40-day gap produces an empty movement', () => {
  const frames = [
    { reading_id: 1, finished_at: '2026-01-05' },
    { reading_id: 2, finished_at: '2026-01-08' },
    { reading_id: 3, finished_at: '2026-01-12' },
    // 40 days of nothing.
    { reading_id: 4, finished_at: '2026-02-21' },
    { reading_id: 5, finished_at: '2026-02-25' },
    { reading_id: 6, finished_at: '2026-03-01' }
  ];

  const movements = M.computeMovements(frames, { changepoints: [] }, S.parseCode('ss26'));
  const empty = movements.find((m) => m.is_empty);

  assert.ok(empty, 'the gap became its own movement');
  assert.equal(empty.books.length, 0, 'a count of zero');
  assert.equal(empty.starts_on, '2026-01-13', 'the day after the last finish');
  assert.equal(empty.ends_on, '2026-02-20', 'the day before the next');
  assert.ok(M.emptyName(empty).length, 'it has a name');

  // §6 — every book appears in exactly one movement.
  const placed = movements.reduce((n, m) => n + m.books.length, 0);
  assert.equal(placed, frames.length);
});

test('§6 — a gap under 28 days is a seam, not a movement', () => {
  const frames = [
    { reading_id: 1, finished_at: '2026-01-05' },
    { reading_id: 2, finished_at: '2026-01-08' },
    { reading_id: 3, finished_at: '2026-01-12' },
    { reading_id: 4, finished_at: '2026-02-05' },   // 24 days
    { reading_id: 5, finished_at: '2026-02-09' },
    { reading_id: 6, finished_at: '2026-02-14' }
  ];
  const movements = M.computeMovements(frames, { changepoints: [] }, S.parseCode('ss26'));
  assert.ok(!movements.some((m) => m.is_empty));
  assert.equal(movements.reduce((n, m) => n + m.books.length, 0), 6);
});

test('§6 — fewer than five books means no movements', () => {
  const frames = [
    { reading_id: 1, finished_at: '2026-01-05' },
    { reading_id: 2, finished_at: '2026-03-05' },
    { reading_id: 3, finished_at: '2026-05-05' }
  ];
  assert.deepEqual(M.computeMovements(frames, { changepoints: [] }, S.parseCode('ss26')), []);
});

test('§6 — no book is ever dropped to fit the four-movement cap', () => {
  // Six long gaps would make seven runs; only four movements are allowed.
  const frames = Array.from({ length: 8 }, (_, i) => ({
    reading_id: i + 1,
    finished_at: `2026-0${Math.floor(i / 2) + 1}-${i % 2 ? '25' : '02'}`
  }));
  const movements = M.computeMovements(frames, { changepoints: [] }, S.parseCode('ss26'));
  if (movements.length) {
    assert.ok(movements.length <= 4);
    assert.equal(movements.reduce((n, m) => n + m.books.length, 0), frames.length,
      'every book is in exactly one movement');
  }
});

test('§6 — roman numerals, lowercase', () => {
  assert.equal(M.roman(1), 'i');
  assert.equal(M.roman(2), 'ii');
  assert.equal(M.roman(3), 'iii');
  assert.equal(M.roman(4), 'iv');
});

test('a movement is named for the side of the boundary it is on', () => {
  const facts = { changepoints: [{ property: 'fiction', before: 0, after: 1, on: '2026-03-01' }] };
  const before = { boundary_reason: 'changepoint:fiction', side: 'before', is_empty: false,
                   starts_on: '2026-01-01', ends_on: '2026-02-01', books: [] };
  const after = { ...before, side: 'after' };

  assert.equal(M.describeMovement(before, facts), 'In nonfiction');
  assert.equal(M.describeMovement(after, facts), 'In fiction');
});

// ── §5 — THE NOTE, AND ITS VALIDATION ────────────────────

const sampleInput = {
  facts: [
    { section: '4.1', key: 'books_finished', text: '9 finished', value: 9, baseline: 34, n: 9 },
    { section: '4.6', key: 'cp_translated', text: 'every book finished after 14 October was translated; none before', value: 2.1, n: 9 }
  ],
  books: [
    { title: 'Kokoro', author: 'Natsume Soseki', finished_at: '2026-10-20', pages: 248, language: 'ja', pass: 1 }
  ],
  season: S.parseCode('aw26'),
  comparable: true
};

test('§5.5 — a number not in the facts fails validation', () => {
  const ok = LB.validate('9 finished. Every book finished after 14 October was translated.', sampleInput);
  assert.equal(ok.ok, true, ok.problems.join('; '));

  const bad = LB.validate('42 finished, a record.', sampleInput);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('42')));
});

test('§5.5 — a name not in the facts fails validation', () => {
  const bad = LB.validate('9 finished, mostly Tolstoy.', sampleInput);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /Tolstoy/.test(p)));

  const good = LB.validate('9 finished, including Kokoro.', sampleInput);
  assert.equal(good.ok, true, good.problems.join('; '));
});

test('§5.4 — every banned construction is caught', async (t) => {
  const cases = [
    ['a season of quiet retreat', 'inference about a life'],
    ['A quiet season, by the look of it', 'emotional inference'],
    ['You seem to have been searching for something', 'psychologising'],
    ['An impressive run', 'praise'],
    ['You should try more fiction', 'advice'],
    ['That puts you in the top 5% of readers', 'comparison to others'],
    ['I noticed a pattern here', 'first person'],
    ['Nine books finished!', 'exclamation mark'],
    ['Nine books 📚', 'emoji']
  ];
  for (const [text, why] of cases) {
    await t.test(why, () => {
      assert.ok(LB.findBanned(text).length > 0, `not caught: ${text}`);
    });
  }
});

test('§5.4 — a plain factual note passes', () => {
  assert.deepEqual(LB.findBanned('9 finished, against 34 last season. Every book after 14 October was translated.'), []);
});

test('§5.5.4 — the template note is composed only from the facts', () => {
  const note = LB.templateNote(sampleInput);
  assert.ok(note);
  const check = LB.validate(note, sampleInput);
  assert.equal(check.ok, true, check.problems.join('; '));
  assert.deepEqual(LB.findBanned(note), []);
});

test('§5.3 — a title is read off a fact, or is the season name', () => {
  assert.equal(LB.templateTitle(sampleInput), 'After October');

  const plain = { ...sampleInput, facts: [sampleInput.facts[0]] };
  assert.equal(LB.templateTitle(plain), 'Autumn/Winter 26',
    'no fact supports a distinctive title');
});

test('§15 — 100 synthetic seasons produce no unsupported claim', () => {
  let checked = 0;
  for (let seed = 0; seed < 100; seed++) {
    const n = 3 + (seed % 12);
    const books = Array.from({ length: n }, (_, i) => ({
      title: `Book ${seed}-${i}`, author: `Author ${i}`,
      finished_at: `2026-0${(i % 6) + 1}-1${i % 9}`,
      pages: 120 + ((seed * 7 + i * 13) % 500), language: 'en', pass: 1
    }));
    const facts = [
      { section: '4.1', key: 'books_finished', text: `${n} finished`, value: n, baseline: null, n },
      { section: '4.1', key: 'pages_total', text: `${n * 200} pages`, value: n * 200, baseline: null, n }
    ];
    const input = { facts, books, season: S.parseCode('ss26'), comparable: false };

    const note = LB.templateNote(input);
    const check = LB.validate(note, input);
    assert.equal(check.ok, true, `season ${seed}: ${check.problems.join('; ')}`);
    checked++;
  }
  assert.equal(checked, 100);
});

// ── §12 — RESTRAINT ──────────────────────────────────────

test('§15 — a two-book season produces no title, note, or movements', async () => {
  const quiet = A.createUser({ email: 'quiet@example.test', passwordHash: 'x' });
  A.markVerified(quiet.id);
  addBook({ title: 'One', finished: '2025-02-10', uid: quiet.id });
  addBook({ title: 'Two', finished: '2025-04-15', uid: quiet.id });

  const row = await RUN.refresh(quiet.id, 'ss25', { now: new Date('2026-08-01') });

  assert.equal(row.state, 'closed');
  assert.equal(row.given_title, null, 'no title');
  assert.equal(row.note, null, 'no note');
  assert.equal(M.movementsOf(row.id).length, 0, 'no movements');
  assert.equal(S.framesOf(row.id).length, 2, 'and the two books are shown');
});

test('§12 — the shape of a season is decided by its size', () => {
  assert.deepEqual(RUN.shapeOf(0, 0),
    { frames: false, colophon: false, title: false, note: false, movements: false });
  assert.equal(RUN.shapeOf(2, 8).note, false, 'two books get no note however many facts');
  assert.equal(RUN.shapeOf(4, 2).note, false, 'four books with two facts get none');
  assert.equal(RUN.shapeOf(4, 3).note, true);
  assert.equal(RUN.shapeOf(4, 3).movements, false, 'and still no movements');
  assert.equal(RUN.shapeOf(9, 5).movements, true);
});

test('§12 — nothing resembling encouragement is ever written', async () => {
  const forbidden = /a quiet season|only two books|aim higher|you'll get there|let's|keep going/i;
  for (const code of ['ss25', 'ss26', 'aw26']) {
    const row = S.seasonByCode(user.id, code);
    if (row?.note) assert.ok(!forbidden.test(row.note), `${code}: ${row.note}`);
  }
});

// ── §8 — THE COLOUR SIGNATURE ────────────────────────────

test('§8 — paper white, print black and greys are discarded', async (t) => {
  const px = (n, rgb) => Array.from({ length: n }, () => rgb);

  await t.test('a jacket that is mostly white picks its colour, not the white', () => {
    const colour = C.pickColour([...px(300, [252, 252, 250]), ...px(60, [180, 30, 40])]);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    assert.ok(r > g && r > b, `expected a red, got ${colour}`);
  });

  await t.test('an all-grey jacket falls back rather than returning nothing', () => {
    const colour = C.pickColour([...px(200, [90, 90, 90]), ...px(100, [140, 140, 140])]);
    assert.match(colour, /^#[0-9a-f]{6}$/);
  });

  await t.test('the strip carries one band per book, and says what each one is', () => {
    // §05 — a book with no colour is NOT given one. This used to substitute
    // #2A2622 for a jacketless book, which the colour system forbids by
    // name: an unassigned book is an unfilled hatch, and the band still
    // exists so the sequence is not misreported.
    const out = C.stripFrom([
      // A blend: what is drawn is the mix, and it is not any anchor's hex.
      { colour_id: 'grief', colour_hex: '#3B3A38', colour_name: 'Slate, Kept',
        colour_components: '[{"id":"grief","weight":0.6},{"id":"nostalgia","weight":0.4}]' },
      { season_colour: '#aabbcc' },   // jacket, retiring
      {}                              // nothing
    ]);
    assert.equal(out.length, 3, 'every book keeps its band');
    assert.deepEqual(out.map((b) => b.source), ['derived', 'provisional', 'none']);
    assert.equal(out[0].hex, '#3B3A38', 'the blend is the band');
    assert.equal(out[0].name, 'Slate, Kept');
    assert.equal(out[1].hex, '#aabbcc');
    assert.equal(out[1].name, null, 'a jacket colour is never named');
    assert.equal(out[2].hex, null, 'nothing is substituted for an unassigned book');
  });

  await t.test('a stored strip of bare hexes still reads, as provisional', () => {
    // Fifteen closed seasons hold the old shape. They are not rewritten —
    // re-deriving every colour in every closed season is a network job, not
    // a migration — so they come back as what they are.
    const out = C.bands(['#aabbcc', null, { hex: '#112233', id: 'awe', emotion: 'Awe', source: 'derived' }]);
    assert.deepEqual(out.map((b) => b.source), ['provisional', 'none', 'derived']);
    assert.equal(out[2].emotion, 'Awe');
  });
});

test('§8 — clustering is deterministic', () => {
  const pixels = Array.from({ length: 200 }, (_, i) => [i % 256, (i * 7) % 256, (i * 13) % 256]);
  assert.equal(C.pickColour(pixels), C.pickColour(pixels));
});

test('LAB conversion round-trips within a tolerance', () => {
  for (const rgb of [[180, 30, 40], [12, 90, 200], [240, 235, 220]]) {
    const back = C.labToRgb(C.rgbToLab(rgb));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) <= 2, `${rgb} → ${back}`);
  }
});

// ── §3 — LIFECYCLE ───────────────────────────────────────

test('§3 — an open season has frames and a strip, but no note or movements', async () => {
  const live = A.createUser({ email: 'live@example.test', passwordHash: 'x' });
  A.markVerified(live.id);
  for (let i = 0; i < 7; i++) {
    addBook({ title: `Live ${i}`, finished: `2026-0${(i % 5) + 1}-1${i}`, uid: live.id });
  }

  // Inside the season: 1 March 2026 is in S/S 26.
  const row = await RUN.refresh(live.id, 'ss26', { now: new Date('2026-03-01') });

  assert.equal(row.state, 'open');
  assert.equal(row.note, null, 'you cannot review a collection mid-show');
  assert.equal(row.given_title, null);
  assert.equal(M.movementsOf(row.id).length, 0);
  assert.ok(S.framesOf(row.id).length > 0, 'but the frames are there');
  assert.ok(JSON.parse(row.colour_strip).length > 0, 'and so is the strip');
});

test('§3 — closing is idempotent', async () => {
  const now = new Date('2026-08-01');
  const first = await RUN.closeDue(user.id, { now });
  const firstNote = S.seasonByCode(user.id, 'aw25')?.note;

  const second = await RUN.closeDue(user.id, { now });
  assert.equal(second.length, 0, 'nothing closes twice');
  assert.equal(S.seasonByCode(user.id, 'aw25')?.note, firstNote, 'and the note does not change');
});

test('§3 — regeneration is once a day', async () => {
  const row = S.seasonByCode(user.id, 'aw26');
  if (row) {
    run(`UPDATE seasons SET state = 'closed', regenerated_today_at = NULL WHERE id = ?`, row.id);
    assert.equal(RUN.canRegenerate(S.seasonByCode(user.id, 'aw26')), true);

    const { nowSQL } = await import('../db/index.js');
    run('UPDATE seasons SET regenerated_today_at = ? WHERE id = ?', nowSQL(), row.id);
    assert.equal(RUN.canRegenerate(S.seasonByCode(user.id, 'aw26')), false);

    // And it comes back tomorrow rather than being spent forever.
    assert.equal(
      RUN.canRegenerate(S.seasonByCode(user.id, 'aw26'), { now: new Date(Date.now() + 25 * 3600_000) }),
      true
    );
  }
});

// ── §5.2 — THE PRIVACY GATE ──────────────────────────────

test('§15 — with local-only on, zero outbound requests occur at close', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };

  try {
    const priv = A.createUser({ email: 'private@example.test', passwordHash: 'x' });
    A.markVerified(priv.id);
    for (let i = 0; i < 6; i++) {
      addBook({ title: `Private ${i}`, finished: `2025-0${i + 1}-10`, uid: priv.id,
                note: `A private thought about book ${i}` });
    }

    const row = await RUN.refresh(priv.id, 'ss25', { localOnly: true, now: new Date('2026-08-01') });

    assert.equal(calls, 0, 'nothing left the machine');
    // And a note is still produced from facts alone — not a degraded apology.
    assert.ok(row.note && row.note.length > 20, `a note was still written: ${row.note}`);
    assert.equal(row.note_source, 'template');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('§5.2 — note excerpts are never assembled under local-only', async () => {
  const src = await (await import('node:fs')).promises.readFile('lib/season-run.js', 'utf8');
  assert.match(src, /localOnly \? \[\]/, 'the excerpts are gated at assembly, not at send');
});

// ── §11 — EDITING ────────────────────────────────────────

test('§11 — a hidden book stays in the facts but leaves the frames', async () => {
  const row = S.seasonByCode(user.id, 'aw26');
  const frames = S.framesOf(row.id);
  if (frames.length) {
    const before = JSON.parse(row.facts).counts.finished;
    run('UPDATE season_frames SET hidden = 1 WHERE season_id = ? AND reading_id = ?',
        row.id, frames[0].reading_id);

    const visible = S.framesOf(row.id).filter((f) => !f.hidden);
    assert.equal(visible.length, frames.length - 1, 'it is gone from the frames');

    const after = await RUN.refresh(user.id, 'aw26', { now: new Date('2027-01-05') });
    assert.equal(JSON.parse(after.facts).counts.finished, before, 'and still counted in the facts');

    run('UPDATE season_frames SET hidden = 0 WHERE season_id = ?', row.id);
  }
});

test('§7 — a caption is the first line of the note, verbatim', () => {
  assert.equal(S.defaultCaption('The mice thing stopped registering.\nA second line.'),
               'The mice thing stopped registering.');
  assert.equal(S.defaultCaption(null), null);

  const long = 'x'.repeat(200);
  const cap = S.defaultCaption(long);
  assert.ok(cap.length <= 91, `capped at about 90: ${cap.length}`);
});

test('§11 — an edited note survives a refresh', async () => {
  const row = S.seasonByCode(user.id, 'aw25');
  if (row?.state === 'closed') {
    run(`UPDATE seasons SET note = ?, note_edited_by_user = 1 WHERE id = ?`, 'Mine, written here.', row.id);
    const after = await RUN.refresh(user.id, 'aw25', { now: new Date('2027-01-05') });
    assert.equal(after.note, 'Mine, written here.');
  }
});

// ── §9 — RESTRAINT IN THE INTERFACE ──────────────────────

test('§15 — no screen in this feature has a progress bar', async () => {
  const fs = (await import('node:fs')).promises;
  for (const file of ['views/season.ejs', 'views/seasons.ejs', 'views/partials/frame.ejs']) {
    const src = await fs.readFile(file, 'utf8');
    assert.ok(!/progress|percent|% (complete|done)|goal|target|streak/i.test(src.replace(/<%#[\s\S]*?%>/g, '')),
      `${file} mentions progress`);
  }
});

test('§12 — a season with nothing in it shows the range and nothing else', async () => {
  const empty = A.createUser({ email: 'empty@example.test', passwordHash: 'x' });
  A.markVerified(empty.id);

  const row = await RUN.refresh(empty.id, 'ss24', { now: new Date('2026-08-01') });

  assert.equal(S.framesOf(row.id).length, 0);
  assert.equal(row.note, null);
  assert.equal(row.given_title, null);
  assert.equal(M.movementsOf(row.id).length, 0);

  // Not even a colophon: "BOOKS 0" is both a message and a zero rendered as
  // a number, and §12 allows neither.
  assert.deepEqual(RUN.colophon(JSON.parse(row.facts), []), []);
});
