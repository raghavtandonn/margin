import { all, get } from '../db/index.js';
import * as F from './facts.js';
import { readingsIn } from './seasons.js';
import { noteOf } from './notes.js';

// ── §4 assembled, and §4.7 ranked ────────────────────────
//
// §4.7: "A fact is interesting when it deviates from THIS READER'S OWN
// baseline — never from other users." There are no percentiles in this
// product and no ranking against anybody else, so the only comparison
// available is to the reader's own prior closed seasons — and before there
// are two of those, there is no comparison at all.

const pct = (x) => `${Math.round(x * 100)}%`;

/** Everything the reader finished before this season, for baselines. */
function priorBooks(userId, season) {
  return all(
    `SELECT r.*, w.title, w.subjects, w.original_language, w.first_published_year,
            e.page_count,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author,
            (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
              WHERE wp.work_id = w.id AND wp.role = 'TRANSLATOR' ORDER BY wp.ord LIMIT 1) AS translator
       FROM readings r
       JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = r.edition_id
      WHERE r.user_id = ? AND r.status = 'FINISHED'
        AND r.finished_at IS NOT NULL AND date(r.finished_at) < ?`,
    Number(userId), season.starts_on
  ).map((r) => ({ ...r, subjects: safeJSON(r.subjects) }));
}

const safeJSON = (s) => { try { return JSON.parse(s || '[]') || []; } catch { return []; } };

/** Compute the whole fact set for one season. Deterministic throughout. */
export function computeFacts(userId, season, { vectorOf = null } = {}) {
  const readings = readingsIn(userId, season);
  const finished = readings.filter((r) => !r.abandoned);
  const abandoned = readings.filter((r) => r.abandoned);

  const prior = priorBooks(userId, season);
  const allPasses = all(
    `SELECT work_id, pass_number, stars FROM readings WHERE user_id = ?`, Number(userId)
  );

  // §4.5 — the background corpus for personal TF-IDF is every note the
  // reader has ever written, not a global one.
  const ownCorpus = all(
    `SELECT note_encrypted, private_note, id FROM readings WHERE user_id = ?`, Number(userId)
  ).map((r) => noteOf(r)).filter(Boolean);

  // §4.1 active_days — distinct days with a logged page update.
  const activeDays = get(
    `SELECT COUNT(DISTINCT date(s.occurred_at)) n
       FROM sessions s JOIN readings r ON r.id = s.reading_id
      WHERE r.user_id = ? AND date(s.occurred_at) BETWEEN ? AND ?`,
    Number(userId), season.starts_on, season.ends_on
  ).n;

  return {
    season: season.code,
    computed_at: new Date().toISOString(),
    counts: { finished: finished.length, abandoned: abandoned.length },
    volume: { ...F.volumeAndPace(finished), active_days: activeDays },
    composition: F.composition(finished, prior),
    behaviour: F.behaviour(finished, abandoned, allPasses),
    notes: F.noteFacts(finished, ownCorpus),
    changepoints: F.changepoints(finished),
    clusters: vectorOf ? F.clusterSubjects(finished, { vectorOf }) : [],
    prior_seasons: 0            // filled by rank(), which knows the history
  };
}

// ── §4.7 — interestingness ───────────────────────────────
//
// Each candidate carries the SUBSECTION it came from, because §4.7 caps the
// note at two facts from any one of them: without that, eight facts about
// page counts is a legal answer and a useless one.

function candidates(facts) {
  const out = [];
  const v = facts.volume;
  const c = facts.composition;
  const b = facts.behaviour;
  const n = facts.notes;

  const add = (section, key, text, value, supporting) =>
    out.push({ section, key, text, value, n: supporting });

  // 4.1 — volume and pace
  add('4.1', 'books_finished', `${v.books_finished} finished`, v.books_finished, v.books_finished);
  // The supporting n for a page statistic is the number of books that
  // actually HAVE a page count, not the size of the season. Passing the
  // season size let "a median of 114 pages" through on a seven-book season
  // where exactly one book had an extent — which reads as though seven
  // books came to 114 pages.
  //
  // The supporting n decides whether the fact is SHOWN. It does not qualify
  // the sentence, and an unqualified "1,286 pages" on a seven-book season
  // where six were measured is a number the reader cannot reconcile with
  // anything else on the page. Where the extent is partial, say so — the
  // same rule the colophon and the nonfiction ratio now follow.
  const partial = v.pages_n && v.pages_n < v.books_finished;
  const across = partial ? ` across ${v.pages_n} of ${v.books_finished}` : '';
  if (v.pages_total) {
    add('4.1', 'pages_total',
        `${v.pages_total.toLocaleString('en-GB')} pages${across}`, v.pages_total, v.pages_n);
  }
  if (v.pages_median) {
    add('4.1', 'pages_median',
        `a median of ${v.pages_median} pages${across}`, v.pages_median, v.pages_n);
  }
  if (v.mean_days_to_finish != null) {
    add('4.1', 'mean_days', `${v.mean_days_to_finish} days a book on average`, v.mean_days_to_finish, v.books_finished);
  }
  if (v.longest_gap && v.longest_gap.days >= 21) {
    add('4.1', 'longest_gap',
        `${v.longest_gap.days} days between ${v.longest_gap.before} and ${v.longest_gap.after}`,
        v.longest_gap.days, 2);
  }
  if (v.slowest_book && v.slowest_book.d >= 30) {
    add('4.1', 'slowest', `${v.slowest_book.book.title} took ${v.slowest_book.d} days`, v.slowest_book.d, 1);
  }

  // 4.2 — composition
  // "0 of 9 were translated" is a sentence about nothing. §1.5 of the house
  // rules: no value that computes to zero is displayed as a number.
  if (c.translated_count > 0 && facts.counts.finished >= 3) {
    add('4.2', 'translated', `${c.translated_count} of ${facts.counts.finished} were translated`,
        c.translated_share, facts.counts.finished);
  }
  if (c.languages_present.length > 1) {
    add('4.2', 'languages', `${c.languages_present.length} original languages`, c.languages_present.length, facts.counts.finished);
  }
  if (c.languages_new.length) {
    add('4.2', 'languages_new', `${c.languages_new.join(' and ')} for the first time`, c.languages_new.length, c.languages_new.length);
  }
  if (c.pub_year_median) {
    add('4.2', 'pub_median', `a median publication year of ${c.pub_year_median}`, c.pub_year_median, facts.counts.finished);
  }
  for (const a of c.authors_repeated.slice(0, 1)) {
    add('4.2', 'repeat_author', `${a.n} by ${a.name}`, a.n, a.n);
  }
  // ── THE DENOMINATOR HAS TO BE THE ONE THE READER IS HOLDING ──
  //
  // `form_split.n` counts books whose form could be CLASSIFIED, not books
  // read: a work with no subject headings is excluded rather than guessed
  // at, which is the right call for the ratio and the wrong number to print
  // beside "7 finished". A/W 25 read "7 finished … 1 of 6 were nonfiction"
  // in the same paragraph, and nothing on the page explained the 6.
  //
  // So when every book classified, say the total. When some did not, say so
  // in the sentence — "1 of 6 classified" is longer and it is the only
  // version a reader can check.
  if (c.form_split && c.form_split.n >= 3 && c.form_split.nonfiction > 0) {
    const allKnown = c.form_split.n === facts.counts.finished;
    const phrase = allKnown
      ? `${c.form_split.nonfiction} of ${c.form_split.n} were nonfiction`
      : `${c.form_split.nonfiction} of the ${c.form_split.n} classified were nonfiction`;
    add('4.2', 'form', phrase, c.form_split.nonfiction / c.form_split.n, c.form_split.n);
  }

  // 4.4 — behaviour
  if (b.abandonments.count) {
    const traits = b.abandonments.traits.length ? `, ${b.abandonments.traits[0]}` : '';
    add('4.4', 'abandoned', `${b.abandonments.count} set down${traits}`, b.abandonments.count, b.abandonments.count);
  }
  if (b.rereads.length) {
    const r = b.rereads[0];
    add('4.4', 'reread',
        r.delta != null
          ? `${r.title} read again, ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'level at'} ${Math.abs(r.delta) || r.stars} stars`
          : `${r.title} read again`,
        b.rereads.length, b.rereads.length);
  }
  if (b.longest_wait) {
    const y = Math.floor(b.longest_wait.days / 365);
    const wait = y >= 1 ? `${y} year${y > 1 ? 's' : ''}` : `${b.longest_wait.days} days`;
    add('4.4', 'longest_wait', `${b.longest_wait.title} had waited ${wait}`, b.longest_wait.days, 1);
  }
  if (b.rating_n >= 3) {
    add('4.4', 'rating_mean', `a mean of ${b.rating_mean} stars`, b.rating_mean, b.rating_n);
  }

  // 4.5 — notes
  if (n.notes_written) {
    add('4.5', 'notes_written', `${n.notes_written} noted`, n.notes_written, n.notes_written);
  }
  if (n.recurring_terms.length >= 2) {
    add('4.5', 'recurring',
        `the words ${n.recurring_terms.slice(0, 3).map((t) => t.term).join(', ')} recur`,
        n.recurring_terms.length, n.notes_written);
  }

  // 4.6 — changepoints. These are the striking ones and they are phrased
  // as the spec phrases them: state it and stop.
  for (const cp of facts.changepoints) {
    if (cp.property === 'translated') {
      const after = cp.after > cp.before;
      add('4.6', 'cp_translated',
          `every book finished after ${F.monthDay(cp.on)} was translated; ${cp.before === 0 ? 'none before' : 'few before'}`,
          cp.score, cp.n_before + cp.n_after);
      if (!after) out.pop();       // only worth saying in the direction it happened
    } else if (cp.property === 'page_count') {
      add('4.6', 'cp_pages',
          `books got ${cp.after > cp.before ? 'longer' : 'shorter'} after ${F.monthDay(cp.on)}, ${Math.round(cp.before)} pages to ${Math.round(cp.after)}`,
          cp.score, cp.n_before + cp.n_after);
    } else if (cp.property === 'pub_year') {
      add('4.6', 'cp_year',
          `after ${F.monthDay(cp.on)} the books were ${cp.after > cp.before ? 'newer' : 'older'}, a median around ${Math.round(cp.after)}`,
          cp.score, cp.n_before + cp.n_after);
    } else if (cp.property === 'rating') {
      add('4.6', 'cp_rating',
          `ratings ${cp.after > cp.before ? 'rose' : 'fell'} after ${F.monthDay(cp.on)}`,
          cp.score, cp.n_before + cp.n_after);
    } else if (cp.property === 'fiction') {
      add('4.6', 'cp_fiction',
          `after ${F.monthDay(cp.on)} the reading turned ${cp.after > cp.before ? 'to fiction' : 'to nonfiction'}`,
          cp.score, cp.n_before + cp.n_after);
    }
  }

  // 4.3 — clusters
  for (const cl of (facts.clusters || []).slice(0, 1)) {
    add('4.3', 'cluster', `${cl.size} of them clustered on ${cl.label}`, cl.size, cl.size);
  }

  return out;
}

/**
 * §4.7 — rank by deviation from the reader's own prior seasons.
 *
 * Requires ≥2 prior closed seasons. Before that, comparative facts are
 * suppressed entirely and only absolutes are reported: "A first season gets
 * a shorter, plainer note, and that is correct."
 */
export function rank(facts, priorFactSets) {
  const comparable = priorFactSets.length >= 2;

  const baselines = {};
  if (comparable) {
    const priorCandidates = priorFactSets.map((f) => new Map(candidates(f).map((c) => [c.key, c.value])));
    const keys = new Set(priorCandidates.flatMap((m) => [...m.keys()]));
    for (const k of keys) {
      const vals = priorCandidates.map((m) => m.get(k)).filter((v) => typeof v === 'number');
      if (vals.length < 2) continue;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, x) => a + (x - m) ** 2, 0) / (vals.length - 1));
      baselines[k] = { mean: m, stdev: sd };
    }
  }

  const scored = candidates(facts)
    // §4.7 — "Suppress any fact with supporting n < 3."  The changepoints
    // and the single striking facts carry their own n and are exempt only
    // where the fact IS the single book (a reread, a long wait).
    .filter((c) => c.n >= 3 || ['longest_wait', 'reread', 'languages_new', 'slowest'].includes(c.key))
    .map((c) => {
      const b = baselines[c.key];
      const deviation = b && b.stdev > 0 ? Math.abs(c.value - b.mean) / b.stdev : null;
      return {
        ...c,
        deviation,
        baseline: b ? Number(b.mean.toFixed(2)) : null,
        // With no baseline everything is an absolute, ranked by how much of
        // the season it accounts for rather than by a comparison that does
        // not exist yet.
        score: deviation ?? (c.section === '4.6' ? 2.0 : 1.0)
      };
    })
    .sort((a, b) => b.score - a.score);

  // §4.7 — "maximum 2 facts from any one subsection (4.1–4.6), so the note
  // isn't five statistics about page counts."
  //
  // How many books were finished is exempt. It is the shape of the season
  // rather than an observation competing for interest, and the cap was
  // evicting it — leaving notes that opened on a page-count average and
  // never said how much had been read.
  const count = scored.find((c) => c.key === 'books_finished');
  const perSection = count ? { '4.1': 1 } : {};
  const top = count ? [count] : [];

  for (const c of scored) {
    if (c.key === 'books_finished') continue;
    perSection[c.section] = (perSection[c.section] || 0) + 1;
    if (perSection[c.section] > 2) continue;
    top.push(c);
    if (top.length === 8) break;
  }

  return { facts: top, comparable, prior_seasons: priorFactSets.length };
}
