import { run, get, all, reindexAll } from '../db/index.js';
import * as W from '../lib/works.js';

// Demo data. Single user, stars only, no community — v0.5.1 §1.2 cuts
// everything that assumes a second reader.
//
//   npm run seed              demo library
//   npm run seed -- --empty   reader and system shelves only

const BOOKS = [
  {
    title: 'Wuthering Heights', year: 1847, authors: ['Emily Brontë'],
    firstLines:
      '1801 — I have just returned from a visit to my landlord — the solitary neighbour that I shall be troubled with. This is certainly a beautiful country! In all England, I do not believe that I could have fixed on a situation so completely removed from the stir of society.',
    firstLinesSource: 'PUBLIC DOMAIN · TRANSCRIBED FROM SET TEXT',
    editions: [
      {
        isbn13: '9780141439556', publisher: 'Penguin Classics', published_year: 2003,
        page_count: 416, format: 'PAPERBACK',
        colophon: {
          set_in: 'Dante MT 10.25 / 12.75', paper: 'Munken Print Cream 80gsm',
          printer: 'Clays Ltd, Bungay, Suffolk', number_line: '10 9 8 7 6 5 4 3 2 1',
          credits: { JACKET_DESIGN: 'Coralie Bickford-Smith', INTRODUCTION: 'Pauline Nestor' }
        }
      },
      {
        isbn13: '9780393284997', publisher: 'Norton', published_year: 2019,
        page_count: 528, format: 'PAPERBACK',
        colophon: { set_in: 'Fairfield 10 / 13', credits: { EDITOR: 'Richard J. Dunn' } }
      },
      {
        isbn13: '9780008115333', publisher: 'Folio Society', published_year: 2011,
        page_count: 384, format: 'HARDCOVER',
        colophon: {
          set_in: 'Bembo 12 / 15', paper: 'Abbey Wove',
          credits: { COVER_ILLUSTRATION: 'Rovina Cai', TYPOGRAPHY: 'Sara Morris' }
        }
      }
    ]
  },
  {
    title: 'Piranesi', year: 2020, authors: ['Susanna Clarke'],
    firstLines:
      'When the Moon rose in the Third Northern Hall I went to the Ninth Vestibule to witness the joining of three Tides.',
    firstLinesSource: 'EXCERPT — FAIR USE',
    editions: [{
      isbn13: '9781635575637', publisher: 'Bloomsbury', published_year: 2020,
      page_count: 245, format: 'HARDCOVER',
      colophon: {
        set_in: 'Adobe Caslon 11.5 / 15', printer: 'Berryville Graphics',
        credits: { JACKET_DESIGN: 'David Mann', EDITOR: 'Alexandra Pringle' }
      }
    }]
  },
  {
    title: 'Blood Meridian', year: 1985, authors: ['Cormac McCarthy'],
    firstLines: 'See the child. He is pale and thin, he wears a thin and ragged linen shirt.',
    firstLinesSource: 'EXCERPT — FAIR USE',
    editions: [{
      isbn13: '9780679728757', publisher: 'Vintage', published_year: 1992,
      page_count: 351, format: 'PAPERBACK',
      colophon: { set_in: 'Sabon 10 / 13', credits: { JACKET_DESIGN: 'Chip Kidd' } }
    }]
  },
  {
    title: 'The Left Hand of Darkness', year: 1969, authors: ['Ursula K. Le Guin'],
    firstLines:
      'I will make my report as if I told a story, for I was taught as a child on my homeworld that Truth is a matter of the imagination.',
    firstLinesSource: 'EXCERPT — FAIR USE',
    editions: [{
      isbn13: '9780441478125', publisher: 'Ace', published_year: 2000,
      page_count: 304, format: 'PAPERBACK',
      colophon: { set_in: 'Electra 10 / 12', credits: { JACKET_DESIGN: 'Fred Gambino' } }
    }]
  },
  {
    title: 'Beloved', year: 1987, authors: ['Toni Morrison'],
    firstLines: "124 was spiteful. Full of a baby's venom.",
    firstLinesSource: 'EXCERPT — FAIR USE',
    editions: [{
      isbn13: '9781400033416', publisher: 'Vintage', published_year: 2004,
      page_count: 324, format: 'PAPERBACK',
      colophon: { set_in: 'Adobe Garamond 11 / 14', credits: { JACKET_DESIGN: 'John Gall' } }
    }]
  },
  {
    title: 'Housekeeping', year: 1980, authors: ['Marilynne Robinson'],
    firstLines: 'My name is Ruth. I grew up with my younger sister, Lucille, under the care of my grandmother.',
    firstLinesSource: 'EXCERPT — FAIR USE',
    editions: [{
      isbn13: '9780312424091', publisher: 'Picador', published_year: 2004,
      page_count: 219, format: 'PAPERBACK',
      colophon: { set_in: 'Janson 11 / 14', credits: { JACKET_DESIGN: 'Henry Sene Yee' } }
    }]
  },
  {
    title: 'Titus Groan', year: 1946, authors: ['Mervyn Peake'],
    editions: [{
      isbn13: '9781585679218', publisher: 'Overlook', published_year: 2007,
      page_count: 506, format: 'PAPERBACK'
    }],
    series: { name: 'Gormenghast', position: 1 }
  },
  {
    title: 'Gormenghast', year: 1950, authors: ['Mervyn Peake'],
    editions: [{
      isbn13: '9781585679225', publisher: 'Overlook', published_year: 2007,
      page_count: 528, format: 'PAPERBACK'
    }],
    series: { name: 'Gormenghast', position: 2 }
  },
  {
    title: 'Titus Alone', year: 1959, authors: ['Mervyn Peake'],
    editions: [{
      isbn13: '9781585679232', publisher: 'Overlook', published_year: 2007,
      page_count: 263, format: 'PAPERBACK'
    }],
    series: { name: 'Gormenghast', position: 3 }
  },
  {
    title: 'A Little Life', year: 2015, authors: ['Hanya Yanagihara'],
    editions: [{
      isbn13: '9780804172707', publisher: 'Anchor', published_year: 2016,
      page_count: 832, format: 'PAPERBACK',
      colophon: { set_in: 'Fournier 10 / 13.5', credits: { JACKET_DESIGN: 'Cardon Webb' } }
    }]
  }
];

const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function seed() {
  if (get('SELECT COUNT(*) AS n FROM works').n > 0) {
    console.log('ALREADY SEEDED. RUN `npm run reset` TO REBUILD.');
    return;
  }

  run(
    `INSERT INTO users (handle, display_name, library_card, settings)
     VALUES ('you', 'You', 'Seattle Public Library', '{}')`
  );
  const me = get(`SELECT * FROM users WHERE handle = 'you'`);

  for (const slug of ['reading', 'finished', 'abandoned', 'waiting']) {
    run(
      'INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 1)',
      me.id, slug.toUpperCase(), slug
    );
  }
  const shelf = (slug) =>
    get('SELECT id FROM shelves WHERE user_id = ? AND slug = ?', me.id, slug).id;

  if (process.argv.includes('--empty')) {
    console.log('"MARGIN" — EMPTY LIBRARY READY');
    console.log('  READER @you · 4 SYSTEM SHELVES · 0 WORKS');
    console.log('  NEXT: npm run import:paste -- <your-export.txt>');
    return;
  }

  const workIds = {};
  for (const b of BOOKS) {
    const workId = W.createWork({
      title: b.title, year: b.year, authors: b.authors,
      firstLines: b.firstLines, firstLinesSource: b.firstLinesSource
    });
    workIds[b.title] = workId;
    for (const e of b.editions) W.addEdition(workId, e);

    if (b.series) {
      run('INSERT OR IGNORE INTO series (name) VALUES (?)', b.series.name);
      const s = get('SELECT id FROM series WHERE name = ?', b.series.name);
      run(
        'INSERT OR IGNORE INTO series_works (series_id, work_id, position) VALUES (?, ?, ?)',
        s.id, workId, b.series.position
      );
    }
  }

  // ── Finished, with stars (§2) ──────────────────────────
  for (const [title, stars, daysAgo] of [
    ['Piranesi', 5, 18],
    ['Beloved', 5, 40],
    ['The Left Hand of Darkness', 4.5, 65],
    ['Housekeeping', 5, 120]
  ]) {
    const workId = workIds[title];
    const ed = get('SELECT id, page_count FROM editions WHERE work_id = ? LIMIT 1', workId);
    const startedAt = daysFromNow(-daysAgo - 14);

    run(
      `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number,
                             current_page, total_positions, stars, started_at, finished_at)
       VALUES (?, ?, ?, 'FINISHED', 1, ?, ?, ?, ?, ?)`,
      me.id, workId, ed.id, ed.page_count, ed.page_count, stars, startedAt, daysFromNow(-daysAgo)
    );
    run(
      'INSERT INTO shelf_items (shelf_id, work_id, edition_id, added_at) VALUES (?, ?, ?, ?)',
      shelf('finished'), workId, ed.id, startedAt
    );
  }

  // ── In progress, with a real pace including a visible stall ──
  for (const [title, page, daysHeld] of [['Wuthering Heights', 148, 34]]) {
    const workId = workIds[title];
    const ed = get('SELECT id, page_count FROM editions WHERE work_id = ? LIMIT 1', workId);
    const startedAt = daysFromNow(-daysHeld);

    run(
      `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number,
                             current_page, total_positions, started_at, due_date)
       VALUES (?, ?, ?, 'READING', 1, ?, ?, ?, ?)`,
      me.id, workId, ed.id, page, ed.page_count, startedAt, daysFromNow(12)
    );
    const reading = get(
      'SELECT id FROM readings WHERE user_id = ? AND work_id = ?', me.id, workId
    );

    // Daily gains are scaled so progress lands on `page` on the last day,
    // rather than saturating early and reporting every later day as stalled.
    const isStalled = (d) => d > daysHeld * 0.35 && d < daysHeld * 0.62;
    const activeDays = [];
    for (let d = 0; d < daysHeld; d++) if (!isStalled(d)) activeDays.push(d);
    const weights = activeDays.map((d) => 0.35 + Math.abs(Math.sin(d * 2.3)));
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    let p = 0;
    activeDays.forEach((d, i) => {
      p = i === activeDays.length - 1
        ? page
        : Math.min(page, p + Math.round((weights[i] / totalWeight) * page));
      const at = `${daysFromNow(-daysHeld + d)} 20:00:00`;
      run(
        `INSERT INTO sessions (reading_id, position, position_type, occurred_at, logged_at, source)
         VALUES (?, ?, 'page', ?, ?, 'manual')`,
        reading.id, p, at, at
      );
    });

    run(
      'INSERT INTO shelf_items (shelf_id, work_id, edition_id, added_at) VALUES (?, ?, ?, ?)',
      shelf('reading'), workId, ed.id, startedAt
    );
  }

  // ── Abandoned, kept with the page it stopped at ────────
  const alWork = workIds['A Little Life'];
  const alEd = get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', alWork);
  run(
    `INSERT INTO readings (user_id, work_id, edition_id, status, pass_number,
                           current_page, abandoned_page, started_at, abandoned_at)
     VALUES (?, ?, ?, 'ABANDONED', 1, 112, 112, ?, ?)`,
    me.id, alWork, alEd.id, daysFromNow(-95), daysFromNow(-74)
  );
  run(
    'INSERT INTO shelf_items (shelf_id, work_id, edition_id) VALUES (?, ?, ?)',
    shelf('abandoned'), alWork, alEd.id
  );

  // An imported rating: stars, straight through (§2).
  run(
    `INSERT INTO readings (user_id, work_id, status, pass_number, stars)
     VALUES (?, ?, 'FINISHED', 1, 3)`,
    me.id, workIds['Titus Alone']
  );

  // ── Waiting ────────────────────────────────────────────
  for (const title of ['Blood Meridian', 'Gormenghast', 'Titus Groan', 'Titus Alone']) {
    const ed = get('SELECT id FROM editions WHERE work_id = ? LIMIT 1', workIds[title]);
    run(
      'INSERT OR IGNORE INTO shelf_items (shelf_id, work_id, edition_id) VALUES (?, ?, ?)',
      shelf('waiting'), workIds[title], ed.id
    );
  }

  reindexAll();

  console.log('"MARGIN" — SEEDED');
  for (const [k, v] of Object.entries({
    works: get('SELECT COUNT(*) AS n FROM works').n,
    editions: get('SELECT COUNT(*) AS n FROM editions').n,
    people: get('SELECT COUNT(*) AS n FROM people').n,
    readings: get('SELECT COUNT(*) AS n FROM readings').n,
    rated: get('SELECT COUNT(*) AS n FROM readings WHERE stars IS NOT NULL').n,
    sessions: get('SELECT COUNT(*) AS n FROM sessions').n
  })) {
    console.log(`  ${k.toUpperCase().padEnd(10)} ${v}`);
  }
  console.log('\n  NEXT: npm run covers   (resolve jackets)');
}

seed();
