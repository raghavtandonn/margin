#!/usr/bin/env node
// Re-resolve the jackets that are missing or too small to print.
//
//   node scripts/covers-upgrade.mjs --audit    say what is wrong, change nothing
//   node scripts/covers-upgrade.mjs            fix it
//   node scripts/covers-upgrade.mjs --limit 20 fix the first twenty
//
// Two things are wrong with a library imported from a list of titles. Some
// books never resolved a cover at all. Others resolved one and stopped,
// because the old code accepted the first image that loaded rather than the
// best — so a 95x148 thumbnail became the permanent answer for a book whose
// work-level cover was 333x500.
//
// Open Library caps its large size at 500px on the long edge, so this is not
// an upscaling pass and it will not make a good jacket better. It fixes the
// bottom of the distribution, which is where the visible damage is.
//
// It is also, deliberately, NOT an AI task: which of two JPEGs is bigger is
// arithmetic, and asking a model to judge cover art it cannot see would be
// theatre.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run } from '../db/index.js';
import { dimensions, resolveCover, MIN_COVER_WIDTH } from '../lib/covers.js';

const args = process.argv.slice(2);
const auditOnly = args.includes('--audit');
// --all revisits every jacket, not only the small and the missing.
//
// The size pass fixed the bottom of the distribution and left the actual
// complaint untouched: Open Library files ONE default cover per work and
// picks it arbitrarily, so a shelf of English books came back with Do
// Androids Dream in Cyrillic, The Great Gatsby as Der Grosse Gatsby and The
// Road as La Carretera. Those covers are the right size. They are the wrong
// object — not a jacket anybody in this library ever held.
//
// coverIdForWork now asks the work for an ENGLISH edition first, so every
// cover is worth re-asking for, including the ones that look fine.
const relanguage = args.includes('--all');
const limit = Number((args.find((a) => a.startsWith('--limit')) || '').split(/[= ]/)[1]) ||
              Number(args[args.indexOf('--limit') + 1]) || Infinity;

const COVERS = join(process.cwd(), 'data', 'covers');
const sizeOfCached = (key) => {
  if (!key) return null;
  const f = join(COVERS, key + '.jpg');
  if (!existsSync(f)) return null;
  try { return dimensions(readFileSync(f)); } catch { return null; }
};

// One row per WORK: the best jacket it currently has anywhere, and the
// edition that would be improved. A work is judged by its best edition
// because that is what every page in the product displays.
const works = all(`
  SELECT w.id, w.title,
         (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
           WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author
    FROM works w ORDER BY w.title`);

const jobs = [];
for (const w of works) {
  // The edition the PRODUCT actually shows, not the lowest-numbered one.
  //
  // Resolving editions[0] fixed a row nothing displays: shelves join on
  // COALESCE(si.edition_id, best-with-a-cover), so a work whose shelf item
  // points at edition 3 kept its German Gatsby jacket while a better cover
  // was quietly written onto edition 1. Same for the reading list.
  const displayed = all(
    `SELECT DISTINCT e.id, e.isbn13, e.isbn10, e.cover_cache_key
       FROM editions e
      WHERE e.work_id = ?
        AND (e.id IN (SELECT edition_id FROM shelf_items WHERE work_id = ? AND edition_id IS NOT NULL)
          OR e.id IN (SELECT edition_id FROM readings WHERE work_id = ? AND edition_id IS NOT NULL)
          OR e.id = (SELECT e2.id FROM editions e2 WHERE e2.work_id = ?
                      ORDER BY (e2.cover_url IS NULL), (e2.page_count IS NULL), e2.published_year DESC
                      LIMIT 1))`,
    w.id, w.id, w.id, w.id
  );
  const editions = displayed.length ? displayed : all(
    'SELECT id, isbn13, isbn10, cover_cache_key FROM editions WHERE work_id = ? ORDER BY id',
    w.id
  );
  if (!editions.length) { jobs.push({ ...w, why: 'no editions', width: 0, edition: null }); continue; }

  let widest = 0;
  for (const e of editions) {
    const d = sizeOfCached(e.cover_cache_key);
    if (d && d.w > widest) widest = d.w;
  }

  if (widest === 0) jobs.push({ ...w, why: 'no cover', width: 0, edition: editions[0], editions });
  else if (widest < MIN_COVER_WIDTH) jobs.push({ ...w, why: `${widest}px`, width: widest, edition: editions[0], editions });
  else if (relanguage) jobs.push({ ...w, why: 'recheck', width: widest, edition: editions[0], editions });
}

console.log(`${works.length} works · ${jobs.length} need a better jacket · floor is ${MIN_COVER_WIDTH}px`);
console.log(`  ${jobs.filter((j) => j.why === 'no cover' || j.why === 'no editions').length} with no cover at all`);
console.log(`  ${jobs.filter((j) => /px$/.test(j.why)).length} too small to print\n`);

if (auditOnly) {
  for (const j of jobs) console.log(`  ${String(j.why).padStart(10)}  ${j.title.slice(0, 60)}`);
  process.exit(0);
}

let improved = 0, unchanged = 0, still = 0;
let n = 0;
for (const j of jobs) {
  if (n++ >= limit) break;
  if (!j.edition) { console.log(`  SKIP      ${j.title.slice(0, 52)} (no edition to attach one to)`); continue; }

  process.stdout.write(`  ${String(j.why).padStart(9)} → ${j.title.slice(0, 46).padEnd(47)}`);

  let out = null;
  try {
    // Every edition the product might display, so the jacket is consistent
    // wherever the book appears.
    for (const e of j.editions) {
      // Strict whenever a jacket ALREADY EXISTS, not only on a recheck.
      //
      // Tying this to `recheck` alone left the small-cover path loose, and
      // that is how Dostoevsky's White Nights — a 128px jacket, so it was
      // filed as "too small" rather than "recheck" — was replaced with Ann
      // Cleeves' thriller of the same name. Replacing a cover demands an
      // author-confirmed match no matter why we are replacing it. Only a
      // book with NO cover at all can afford the looser search.
      const got = await resolveCover(e, {
        title: j.title, author: j.author, preferEnglish: j.width > 0
      });
      if (got && (!out || e.id === j.edition.id)) out = got;
    }
  } catch (err) {
    console.log(`error: ${err.message}`);
    continue;
  }

  const after = sizeOfCached(out?.cached);
  if (!after) {
    // On a recheck this means no ENGLISH jacket exists for the book. The
    // cover already on the shelf is left exactly as it was: a foreign
    // jacket is better than a blank plate, and swapping it for a different
    // foreign one is churn.
    console.log(j.why === 'recheck' ? 'no english edition; kept what was there' : 'nothing found');
    still++; continue;
  }

  // On a recheck the new jacket wins on PROVENANCE rather than on size: it
  // came from an English edition of this work, where the old one was Open
  // Library's arbitrary default. Only a materially smaller image is refused,
  // because a correct-language cover at 300px beats a wrong-language one at
  // 333px and there is no way to measure the difference from the pixels.
  const acceptable = j.why === 'recheck'
    ? after.w >= MIN_COVER_WIDTH && after.w >= j.width * 0.8
    : after.w > j.width;

  if (acceptable) {
    const how = j.why === 'recheck'
      ? (out.cached === j.edition.cover_cache_key ? 'unchanged' : `re-jacketed ${after.w}x${after.h}`)
      : `${after.w}x${after.h}  ${after.w >= MIN_COVER_WIDTH ? 'good' : 'better'}`;
    console.log(how);
    if (out.cached !== j.edition.cover_cache_key) improved++; else unchanged++;
  } else {
    // The old jacket was already the best available. Put it back rather than
    // leaving the work worse off than it started.
    if (j.edition.cover_cache_key && after.w < j.width) {
      run('UPDATE editions SET cover_cache_key = ? WHERE id = ?', j.edition.cover_cache_key, j.edition.id);
      console.log(`kept ${j.width}px (found only ${after.w})`);
    } else {
      console.log(`no better one exists (${after.w}x${after.h})`);
    }
    unchanged++;
  }
}

console.log(`\n${improved} improved · ${unchanged} already the best available · ${still} still without one`);
