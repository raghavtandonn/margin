#!/usr/bin/env node
// Build composition history cards for the books in a season.
//
//   node scripts/histories.mjs aw25            one season
//   node scripts/histories.mjs aw25 --note     and the closing note
//   node scripts/histories.mjs --all           every closed season
//   node scripts/histories.mjs --all --note --redo
//                                              rewrite what is already there
//
// --redo throws away the cards and notes for the seasons named and writes
// them again. Both are cached — a card is written once and a closing note is
// returned from the cache forever after — so a change to the PROMPTS is
// invisible without it. Retrieved sources are NOT cleared: those are what
// Wikipedia said, they cost a rate limit to fetch, and they have not changed.
//
// Retrieval runs whether or not there is a key: the confidence flag and the
// material card both come from what was FOUND, not from what was written.
// With no ANTHROPIC_API_KEY set, every book gets a thin card built from
// facts the catalogue can prove, and nothing is invented — which is the
// state this ships in.

import { get, all, run } from '../db/index.js';
import * as H from '../lib/history.js';

const args = process.argv.slice(2);
const wantNote = args.includes('--note');
const redo = args.includes('--redo');
const codes = args.filter((a) => !a.startsWith('--'));

const key = process.env.ANTHROPIC_API_KEY;
console.log(key ? '  model: available' : '  model: no key — retrieval and material cards only');

const seasons = args.includes('--all')
  ? all(`SELECT * FROM seasons WHERE state = 'closed' ORDER BY starts_on`)
  : codes.map((c) => get('SELECT * FROM seasons WHERE code = ?', c)).filter(Boolean);

if (!seasons.length) {
  console.log('  no such season. try: node scripts/histories.mjs --all');
  process.exit(1);
}

for (const season of seasons) {
  const books = all(
    `SELECT DISTINCT w.id, w.title,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
       FROM readings r JOIN works w ON w.id = r.work_id
      WHERE r.user_id = ? AND r.finished_at IS NOT NULL
        AND date(r.finished_at) BETWEEN ? AND ?
      ORDER BY r.finished_at`,
    season.user_id, season.starts_on, season.ends_on
  );

  console.log(`\n${season.code.toUpperCase()} — ${books.length} books`);

  if (redo) {
    // A card the reader has edited by hand is theirs and is never thrown
    // away by a rerun. Everything the model wrote is fair game.
    let dropped = 0;
    for (const b of books) {
      dropped += run(
        'DELETE FROM history_cards WHERE work_id = ? AND edited_by_user = 0', b.id
      ).changes || 0;
    }
    const notes = run('DELETE FROM season_notes WHERE season_id = ?', season.id).changes || 0;
    console.log(`  --redo: cleared ${dropped} cards and ${notes} note${notes === 1 ? '' : 's'}`);
  }

  let documented = 0, thin = 0;
  for (const book of books) {
    process.stdout.write(`  ${book.title.slice(0, 42).padEnd(43)}`);
    let card;
    try {
      card = await H.generate(book.id, { apiKey: key });
    } catch (err) {
      // Being rate limited is not evidence that a book has no history. The
      // run stops rather than writing a shelf of false thin cards that
      // would then be cached and never revisited.
      if (err.name === 'RetrievalUnavailable') {
        console.log(`\n\n  STOPPED — ${err.message}.`);
        console.log('  Nothing was written for the books after this one. Run it again later;');
        console.log('  the books already done are cached and will not be fetched twice.');
        process.exit(2);
      }
      console.log(`ERROR ${err.message}`);
      continue;
    }

    if (card?.kind === 'written') { documented++; console.log('documented'); }
    else if (card?.kind === 'material') { thin++; console.log(`thin (${card.facts.length} facts)`); }
    else { thin++; console.log('nothing provable'); }
  }

  console.log(`  ${documented} documented, ${thin} thin`);

  if (wantNote && key) {
    const note = await H.seasonNote(season.id, books.map((b) => ({ ...b, work_id: b.id })), { apiKey: key });
    if (note?.body) console.log(`\n  CLOSING NOTE\n  ${note.body}`);
    else if (note?.skipped) console.log(`\n  no closing note: ${note.skipped}`);
    else console.log(`\n  no closing note: written and refused — ${(note?.rejected || []).join('; ')}`);
  }
}
