import { all, get, run, nowSQL } from '../db/index.js';
import * as S from './seasons.js';
import { computeFacts, rank } from './season-facts.js';
import { computeMovements, saveMovements, movementsOf } from './movements.js';
import { compose } from './lookbook.js';
import { stripFrom } from './colour.js';
import { noteExcerpt } from './vectors.js';
import * as audit from './audit.js';

// ── §3 / §12 — CLOSING AND REGENERATION ──────────────────
//
// §12 is the section that separates this from a reading challenge, and it
// is enforced here rather than in a template, so no view can accidentally
// render a note for a two-book season.
//
//   0 books        date range and nothing else. No message, no prompt.
//   1–2 books      frames and colophon only. No title, note or movements.
//   3–4 books      + a short note if ≥3 facts clear threshold. No movements.
//   ≥5, <3 facts   + plain season name as title, two-sentence factual note.
//   first season   no comparative facts. Absolutes only.
//
// "Never write anything resembling 'a quiet season', 'only two books',
// 'let's aim higher', or 'you'll get there'. A season with two books in it
// shows two books."

export function shapeOf(bookCount, factCount) {
  if (bookCount === 0) return { frames: false, colophon: false, title: false, note: false, movements: false };
  if (bookCount <= 2) return { frames: true, colophon: true, title: false, note: false, movements: false };
  if (bookCount <= 4) return { frames: true, colophon: true, title: false, note: factCount >= 3, movements: false };
  return { frames: true, colophon: true, title: true, note: true, movements: true };
}

/** The fact sets of this reader's prior CLOSED seasons, for §4.7 baselines. */
function priorFactSets(userId, season) {
  return all(
    `SELECT facts FROM seasons
      WHERE user_id = ? AND state = 'closed' AND ends_on < ? AND facts IS NOT NULL
      ORDER BY starts_on`,
    Number(userId), season.starts_on
  ).map((r) => { try { return JSON.parse(r.facts); } catch { return null; } })
   .filter(Boolean);
}

/**
 * Recompute a season from the reader's data.
 *
 * Runs for open seasons too: §3 says an open season shows frames, the
 * colour strip and a running colophon, and all three come from the same
 * computation. What an open season does NOT get is a title, a note or
 * movements — "you cannot review a collection mid-show" — and that is
 * decided here, not by the view.
 */
export async function refresh(userId, code, { localOnly = true, now = new Date(), force = false } = {}) {
  const meta = S.parseCode(code);
  if (!meta) return null;

  const row = S.ensureSeason(userId, meta);
  const readings = S.readingsIn(userId, meta);
  const finished = readings.filter((r) => !r.abandoned);

  S.syncFrames(row, readings);

  // One band per book in finish order — the derived colour, the reader's
  // override, a retiring jacket colour, or nothing. Stored as objects rather
  // than bare hexes because the poster needs to know which of those four a
  // band is: it draws them differently and names only two of them.
  const frames = S.framesOf(row.id);
  const strip = stripFrom(frames);

  // The vectors the desk already builds are what §4.3 clusters over.
  let vectorOf = null;
  try {
    const V = await import('./vectors.js');
    vectorOf = (b) => V.vectorForWork?.(b.work_id) || null;
  } catch { /* clustering is reported as none, per §4.3 */ }

  const rawFacts = computeFacts(userId, meta, { vectorOf });
  const prior = priorFactSets(userId, meta);
  const ranked = rank(rawFacts, prior);

  rawFacts.prior_seasons = prior.length;
  rawFacts.ranked = ranked.facts;
  rawFacts.comparable = ranked.comparable;

  const closed = S.isPast(meta, { now });
  const shape = shapeOf(finished.length, ranked.facts.length);

  // ── Movements (§6) ──
  let movements = [];
  if (closed && shape.movements) {
    movements = computeMovements(frames, rawFacts, meta);
  }

  // ── The note (§5) ──
  let title = null;
  let note = null;
  let source = null;
  let names = {};

  if (closed && (shape.note || shape.title)) {
    // §5.2 — the privacy gate. With local-only on, excerpts are not
    // assembled at all, so there is nothing to omit later.
    const noteExcerpts = localOnly ? [] : finished
      .filter((b) => b.note)
      .slice(0, 12)
      .map((b) => ({ book: b.title, text: noteExcerpt(b.note, '', 160) || String(b.note).slice(0, 160) }));

    const input = {
      facts: ranked.facts,
      comparable: ranked.comparable,
      season: meta,
      books: finished.map((b) => ({
        title: b.title, author: b.author, finished_at: b.finishedOn,
        pages: b.page_count, language: b.original_language, pass: b.pass_number
      })),
      movements,
      noteExcerpts
    };

    const composed = await compose(input, { localOnly });
    title = shape.title ? composed.title : null;
    note = shape.note ? composed.note : null;
    source = composed.source;
    names = composed.movementNames || {};
  }

  if (closed && shape.movements && movements.length) {
    saveMovements(row.id, movements, names, rawFacts);
  } else {
    run('DELETE FROM season_movements WHERE season_id = ?', row.id);
    run('UPDATE season_frames SET movement_id = NULL WHERE season_id = ?', row.id);
  }

  // A note the reader has edited is theirs and is never overwritten by a
  // regeneration (§11.3).
  const keepNote = row.note_edited_by_user && !force;

  run(
    `UPDATE seasons SET
       state = ?, closed_at = ?, facts = ?, colour_strip = ?,
       given_title = COALESCE(?, given_title),
       note = CASE WHEN ? THEN note ELSE ? END,
       note_source = ?, generated_at = ?
     WHERE id = ?`,
    closed ? 'closed' : 'open',
    closed ? (row.closed_at || nowSQL()) : null,
    JSON.stringify(rawFacts),
    JSON.stringify(strip),
    title,
    keepNote ? 1 : 0, note,
    source,
    nowSQL(),
    row.id
  );

  return get('SELECT * FROM seasons WHERE id = ?', row.id);
}

/**
 * §3 — the closing job. Scheduled and IDEMPOTENT: running it twice on the
 * same day must not produce a second close, a second notification, or a
 * different note.
 */
export async function closeDue(userId, { now = new Date(), localOnly = true } = {}) {
  S.backfill(userId, { now });

  const due = all(
    `SELECT * FROM seasons
      WHERE user_id = ? AND state = 'open' AND ends_on < date(?)`,
    Number(userId), new Date(now).toISOString().slice(0, 10)
  );

  const closed = [];
  for (const s of due) {
    await refresh(userId, s.code, { localOnly, now });
    const after = get('SELECT * FROM seasons WHERE id = ?', s.id);
    if (after?.state === 'closed') {
      closed.push(after);
      // §3 — "A single quiet notification: `A/W 26 closed. Nine books.`
      // No modal, no confetti, no 'your season is ready!' screen."
      audit.record({
        actorType: 'system', action: 'season.closed', targetUserId: Number(userId),
        metadata: { code: after.code, books: S.framesOf(after.id).length }
      });
    }
  }

  // The season currently running is kept up to date too, so an open season
  // is never stale.
  const current = S.currentSeason({ now });
  await refresh(userId, current.code, { localOnly, now });

  return closed;
}

// §3 — "The reader may regenerate the analysis once per day, indefinitely.
// Closing is not a one-shot event they can miss."
export function canRegenerate(row, { now = new Date() } = {}) {
  if (!row?.regenerated_today_at) return true;
  const last = Date.parse(`${String(row.regenerated_today_at).replace(' ', 'T')}Z`);
  return now.getTime() - last >= 24 * 3600_000;
}

export async function regenerate(userId, code, { localOnly = true, now = new Date() } = {}) {
  const row = S.seasonByCode(userId, code);
  if (!row) return { ok: false, error: 'No such season.' };
  if (row.state !== 'closed') return { ok: false, error: 'That season is still open.' };
  if (!canRegenerate(row, { now })) return { ok: false, error: 'Once a day. Try tomorrow.' };

  run('UPDATE seasons SET regenerated_today_at = ?, note_edited_by_user = 0 WHERE id = ?', nowSQL(), row.id);
  const out = await refresh(userId, code, { localOnly, now, force: true });
  return { ok: true, season: out };
}

/**
 * §7.6 — the colophon. "The credits page. Two-column label/value pairs in
 * mono. No charts, no bars, no graphs."
 */
export function colophon(facts, frames) {
  // §12 — a season with nothing in it "shows the date range and nothing
  // else". A colophon reading BOOKS 0 is both a violation of that and of
  // the house rule that no value computing to zero is shown as a number.
  if (!facts || !frames.length) return [];
  const v = facts.volume || {};
  const c = facts.composition || {};
  const b = facts.behaviour || {};

  const pairs = [];
  const add = (label, value) => { if (value != null && value !== '') pairs.push({ label, value }); };

  const longest = frames.filter((f) => f.page_count).sort((x, y) => y.page_count - x.page_count)[0];
  const shortest = frames.filter((f) => f.page_count).sort((x, y) => x.page_count - y.page_count)[0];

  add('BOOKS', v.books_finished);

  // A page total is only a page total if the books were measured. Reporting
  // 114 against a seven-book season, where one book had an extent, reads as
  // though the seven came to 114 — so the count of measured books is stated
  // whenever it is not all of them.
  if (v.pages_total && v.pages_n) {
    // Sentence case, because the VALUE column is set in the reading face
    // now. These strings were written to sit in 11px mono capitals, where
    // "1 OF 7 MEASURED" reads as a field; at 17px in a serif it reads as
    // shouting. The label beside it still carries the caps.
    const measured = v.pages_n < v.books_finished ? ` · ${v.pages_n} of ${v.books_finished} measured` : '';
    add('PAGES', `${v.pages_total.toLocaleString('en-GB')}${measured}`);
  }

  // ── LONGEST OF WHAT? ─────────────────────────────────────
  //
  // These are computed over the MEASURED books, because a book with no page
  // count cannot be ranked by length. Labelled plainly LONGEST, that reads
  // as a claim about the season: A/W 25 named a 349-page book as its longest
  // while The Wind-Up Bird Chronicle — six hundred pages, unmeasured because
  // Open Library has no extent for it — sat in the same season, and anybody
  // who knows the book reads the row as simply wrong.
  //
  // The row above already says how many were measured. That is not enough:
  // a reader should not have to carry the caveat from one line to the next.
  // When some books have no extent the label carries it, and when they all
  // have one the label stays clean.
  //
  // Same rule as the nonfiction ratio in lib/season-facts.js: a statistic
  // computed over a subset says which subset, in the sentence, every time.
  const allMeasured = frames.every((f) => f.page_count);
  const of = allMeasured ? '' : ' MEASURED';

  // Longest and shortest are the same book when only one was measured, and
  // printing it twice says nothing twice.
  if (longest && shortest && longest.reading_id !== shortest.reading_id) {
    add(`LONGEST${of}`, `${longest.title} · ${longest.page_count}pp`);
    add(`SHORTEST${of}`, `${shortest.title} · ${shortest.page_count}pp`);
  }
  add('MOST READ', c.authors_repeated?.[0] ? `${c.authors_repeated[0].name} · ${c.authors_repeated[0].n}` : null);
  add('REREADS', b.rereads?.length || null);
  // Only worth a line when there is one. "0 OF 8" is a line about nothing.
  add('TRANSLATED', c.translated_count ? `${c.translated_count} of ${v.books_finished}` : null);
  add('LANGUAGES', c.languages_present?.length > 1 ? c.languages_present.join(', ') : null);
  add('DAYS ACTIVE', v.active_days || null);
  add('LONGEST WAIT', b.longest_wait ? `${b.longest_wait.title} · ${b.longest_wait.days} days` : null);
  add('SET DOWN', b.abandonments?.count || null);

  return pairs;
}
