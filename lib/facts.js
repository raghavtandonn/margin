// ── §4 — THE FACT ENGINE ─────────────────────────────────
//
// "This is the core of the feature and it is entirely deterministic. No
// model touches it. Everything below is computed in code from the reader's
// own data. The quality of the lookbook is set here, not in the writing."
//
// So: no imports from anything that talks to a network, and every function
// here is a pure computation over rows that were handed to it.

const day = 86_400_000;
const at = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() : null);
const days = (a, b) => Math.round((at(b) - at(a)) / day);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

export const monthDay = (d) => {
  const t = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
};

// Fiction is inferred from subject headings. Open Library marks fiction
// explicitly far more often than it marks nonfiction, so absence of the
// marker is not evidence — `null` means unknown, and unknowns are excluded
// from the ratio rather than counted as nonfiction.
const FICTION = /\bfiction\b|\bnovel\b|\bshort stories\b|\bfantasy\b|\bscience fiction\b/i;
const NONFICTION = /\bbiography\b|\bhistory\b|\bessays?\b|\bmemoir\b|\bphilosophy\b|\bpolitics\b|\bscience\b(?! fiction)/i;

export function isFiction(subjects) {
  const joined = (subjects || []).join(' · ');
  if (!joined) return null;
  if (FICTION.test(joined)) return true;
  if (NONFICTION.test(joined)) return false;
  return null;
}

// ── §4.1 Volume and pace ─────────────────────────────────
export function volumeAndPace(finished) {
  const pages = finished.map((b) => b.page_count).filter((p) => p > 0);
  const spans = finished
    .filter((b) => b.started_at && b.finished_at)
    .map((b) => ({ book: b, d: days(b.started_at, b.finished_at) }))
    .filter((x) => x.d >= 0);

  const dates = finished.map((b) => b.finishedOn).filter(Boolean).sort();

  // §4.1 longest_gap — the largest interval between consecutive finishes,
  // with the book on each side of it. The books either side are what make
  // the gap legible rather than merely long.
  let longestGap = null;
  for (let i = 1; i < dates.length; i++) {
    const d = days(dates[i - 1], dates[i]);
    if (!longestGap || d > longestGap.days) {
      longestGap = {
        days: d,
        start: dates[i - 1],
        end: dates[i],
        before: finished.find((b) => b.finishedOn === dates[i - 1])?.title || null,
        after: finished.find((b) => b.finishedOn === dates[i])?.title || null
      };
    }
  }

  const byMonth = {};
  for (const b of finished) {
    if (!b.finishedOn) continue;
    const m = b.finishedOn.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }

  return {
    books_finished: finished.length,
    // How many books contributed an extent at all — the supporting n for
    // every page statistic below it.
    pages_n: pages.length,
    pages_total: pages.reduce((a, b) => a + b, 0),
    pages_mean: pages.length ? Math.round(mean(pages)) : null,
    pages_median: pages.length ? Math.round(median(pages)) : null,
    mean_days_to_finish: spans.length ? Math.round(mean(spans.map((s) => s.d))) : null,
    fastest_book: spans.length
      ? spans.reduce((a, b) => (b.d < a.d ? b : a)) : null,
    slowest_book: spans.length
      ? spans.reduce((a, b) => (b.d > a.d ? b : a)) : null,
    longest_gap: longestGap,
    finish_distribution: byMonth
  };
}

// ── §4.2 Composition ─────────────────────────────────────
export function composition(finished, priorBooks) {
  const translated = finished.filter((b) => b.translator);
  const languages = [...new Set(finished.map((b) => b.original_language).filter(Boolean))];
  const priorLanguages = new Set(priorBooks.map((b) => b.original_language).filter(Boolean));
  const priorAuthors = new Set(priorBooks.map((b) => (b.author || '').toLowerCase()).filter(Boolean));

  const decades = {};
  const years = [];
  for (const b of finished) {
    if (!b.first_published_year) continue;
    years.push(b.first_published_year);
    const dec = Math.floor(b.first_published_year / 10) * 10;
    decades[dec] = (decades[dec] || 0) + 1;
  }

  const counts = {};
  for (const b of finished) {
    const a = (b.author || '').trim();
    if (a) counts[a] = (counts[a] || 0) + 1;
  }

  const forms = finished.map((b) => isFiction(b.subjects)).filter((f) => f !== null);

  return {
    translated_share: finished.length ? translated.length / finished.length : null,
    translated_count: translated.length,
    languages_present: languages,
    languages_new: languages.filter((l) => !priorLanguages.has(l)),
    pub_decade_distribution: decades,
    pub_year_median: years.length ? Math.round(median(years)) : null,
    authors_repeated: Object.entries(counts).filter(([, n]) => n > 1)
      .map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    authors_new: [...new Set(finished.map((b) => b.author).filter(Boolean))]
      .filter((a) => !priorAuthors.has(a.toLowerCase())),
    // Unknowns are excluded rather than assumed. A ratio over three known
    // books out of nine is reported with its own n, and §4.7 suppresses it.
    form_split: forms.length
      ? { fiction: forms.filter(Boolean).length, nonfiction: forms.filter((f) => !f).length, n: forms.length }
      : null
  };
}

// ── §4.4 Behaviour ───────────────────────────────────────
export function behaviour(finished, abandoned, allPasses) {
  const abandonPages = abandoned.map((b) => b.abandoned_page).filter((p) => p > 0);

  // §4.4 — shared traits among abandonments. Only reported when they are
  // unanimous AND there are enough of them to mean anything.
  const traits = [];
  if (abandoned.length >= 2) {
    const forms = abandoned.map((b) => isFiction(b.subjects)).filter((f) => f !== null);
    if (forms.length === abandoned.length && forms.every((f) => f === false)) traits.push('all nonfiction');
    if (forms.length === abandoned.length && forms.every((f) => f === true)) traits.push('all fiction');
    const pages = abandoned.map((b) => b.page_count).filter((p) => p > 0);
    if (pages.length === abandoned.length && pages.every((p) => p > 400)) traits.push('all over 400 pages');
    if (abandoned.every((b) => b.translator)) traits.push('all translated');
  }

  // §4.4 rereads — and the rating delta between passes, which is the fact
  // worth having. Your opinion at nineteen and at thirty-four are two data
  // points, which is why readings are stored per pass in the first place.
  const rereads = [];
  for (const b of finished.filter((x) => x.pass_number > 1)) {
    const earlier = allPasses.filter(
      (p) => p.work_id === b.work_id && p.pass_number < b.pass_number && p.stars != null
    ).sort((x, y) => y.pass_number - x.pass_number)[0];
    rereads.push({
      title: b.title,
      pass: b.pass_number,
      stars: b.stars,
      previous_stars: earlier?.stars ?? null,
      delta: earlier && b.stars != null ? Number((b.stars - earlier.stars).toFixed(1)) : null
    });
  }

  // §4.4 longest_wait — "a book that had waited three years". The spec is
  // right that no other product computes this.
  let longestWait = null;
  for (const b of finished) {
    if (!b.waiting_since || !b.finishedOn) continue;
    const d = days(b.waiting_since, b.finishedOn);
    if (d > 30 && (!longestWait || d > longestWait.days)) {
      longestWait = { title: b.title, author: b.author, days: d, since: String(b.waiting_since).slice(0, 10) };
    }
  }

  const rated = finished.map((b) => b.stars).filter((s) => s != null);
  const dist = {};
  for (const s of rated) dist[s] = (dist[s] || 0) + 1;

  return {
    abandonments: {
      count: abandoned.length,
      mean_abandon_page: abandonPages.length ? Math.round(mean(abandonPages)) : null,
      traits,
      books: abandoned.map((b) => ({ title: b.title, author: b.author, page: b.abandoned_page }))
    },
    rereads,
    waiting_converted: finished.filter((b) => b.waiting_since).length,
    longest_wait: longestWait,
    rating_distribution: dist,
    rating_mean: rated.length ? Number(mean(rated).toFixed(2)) : null,
    rating_n: rated.length
  };
}

// ── §4.5 Notes ───────────────────────────────────────────
//
// "Do not compute sentiment. It is one step from psychologising and it is
// banned in §5.4." Nothing here scores a note; it counts and it ranks terms.
const STOP = new Set(`the a an and or but of to in on at for with from by as is was were be been
being this that these those it its i me my we our you your he she they them his her their not no
so if then than there here when where what which who whom how why all any both each few more most
other some such only own same too very can will just don should now about into over after before
book books read reading page pages one two`.split(/\s+/));

const words = (text) =>
  String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

export function noteFacts(finished, ownCorpus) {
  const withNotes = finished.filter((b) => b.note);
  const counts = withNotes.map((b) => words(b.note).length);

  // §4.5 — "Using the reader's own corpus as background is essential —
  // global TF-IDF surfaces 'book' and 'read'; personal TF-IDF surfaces the
  // words unusual FOR THEM this season."
  const seasonTF = new Map();
  for (const b of withNotes) for (const w of words(b.note)) seasonTF.set(w, (seasonTF.get(w) || 0) + 1);

  const backgroundDF = new Map();
  for (const text of ownCorpus) {
    for (const w of new Set(words(text))) backgroundDF.set(w, (backgroundDF.get(w) || 0) + 1);
  }
  const N = Math.max(1, ownCorpus.length);

  const recurring = [...seasonTF.entries()]
    // A term appearing once is not recurring.
    .filter(([, n]) => n >= 2)
    .map(([term, n]) => ({
      term, n,
      score: n * Math.log(N / (1 + (backgroundDF.get(term) || 0)))
    }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const longest = withNotes.length
    ? withNotes.reduce((a, b) => (words(b.note).length > words(a.note).length ? b : a))
    : null;

  return {
    notes_written: withNotes.length,
    notes_word_count: counts.reduce((a, b) => a + b, 0),
    books_without_a_note: finished.length - withNotes.length,
    longest_note: longest ? { title: longest.title, words: words(longest.note).length } : null,
    recurring_terms: recurring
  };
}

// ── §4.6 Changepoint detection ───────────────────────────
//
// "The single most striking observation type available."
//
//   for each split index i where i >= 2 and (n - i) >= 2:
//       score = |mean(p[0:i]) - mean(p[i:n])| / pooled_stdev(p)
//   report if score > 1.2
//
// Yielding: "every book finished after 14 October was translated; none
// before" — which needs nothing added to it.

const PROPERTIES = [
  { key: 'translated', of: (b) => (b.translator ? 1 : 0), label: 'translated' },
  { key: 'fiction',    of: (b) => { const f = isFiction(b.subjects); return f === null ? null : (f ? 1 : 0); }, label: 'fiction' },
  { key: 'page_count', of: (b) => (b.page_count > 0 ? b.page_count : null), label: 'length' },
  { key: 'pub_year',   of: (b) => b.first_published_year || null, label: 'publication year' },
  { key: 'rating',     of: (b) => (b.stars != null ? b.stars : null), label: 'rating' }
];

export function changepoints(finished) {
  const ordered = [...finished].sort((a, b) => String(a.finishedOn).localeCompare(String(b.finishedOn)));
  const found = [];

  for (const prop of PROPERTIES) {
    const pairs = ordered.map((b) => ({ b, v: prop.of(b) })).filter((p) => p.v !== null);
    const n = pairs.length;
    if (n < 4) continue;

    const values = pairs.map((p) => p.v);
    const sd = stdev(values);
    if (!sd) continue;

    let best = null;
    for (let i = 2; i <= n - 2; i++) {
      const left = values.slice(0, i);
      const right = values.slice(i);
      const score = Math.abs(mean(left) - mean(right)) / sd;
      if (!best || score > best.score) {
        best = {
          score, index: i,
          on: pairs[i].b.finishedOn,
          before: mean(left),
          after: mean(right),
          n_before: left.length,
          n_after: right.length
        };
      }
    }

    if (best && best.score > 1.2) {
      found.push({ property: prop.key, label: prop.label, ...best });
    }
  }

  // §4.6 — "Report at most two changepoints, the highest-scoring ones."
  return found.sort((a, b) => b.score - a.score).slice(0, 2);
}

// ── §4.3 Subject clustering ──────────────────────────────
//
// Agglomerative clustering over the season's book vectors, reported only if
// it clears the threshold. §4.3: "If no cluster clears the threshold, report
// none. Do not lower the threshold to guarantee a result."
export function clusterSubjects(finished, { vectorOf }) {
  const docs = finished
    .map((b) => ({ b, v: vectorOf(b) }))
    .filter((d) => d.v && d.v.size);
  if (docs.length < 6) return [];

  const cos = (a, b) => {
    let s = 0;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    for (const [t, w] of small) { const o = large.get(t); if (o) s += w * o; }
    return s;
  };
  const d = (a, b) => 1 - cos(a, b);

  let best = null;

  for (let k = 2; k <= 4; k++) {
    if (docs.length < k * 2) break;

    // Agglomerative, average linkage, down to k clusters.
    let clusters = docs.map((doc, i) => ({ members: [i] }));
    while (clusters.length > k) {
      let pair = null;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          let sum = 0;
          for (const a of clusters[i].members) for (const b of clusters[j].members) sum += d(docs[a].v, docs[b].v);
          const avg = sum / (clusters[i].members.length * clusters[j].members.length);
          if (!pair || avg < pair.avg) pair = { i, j, avg };
        }
      }
      if (!pair) break;
      clusters[pair.i].members.push(...clusters[pair.j].members);
      clusters.splice(pair.j, 1);
    }

    const labels = new Array(docs.length).fill(-1);
    clusters.forEach((c, ci) => c.members.forEach((m) => { labels[m] = ci; }));

    // Silhouette.
    const sils = docs.map((_, i) => {
      const own = clusters[labels[i]].members.filter((m) => m !== i);
      if (!own.length) return 0;
      const a = mean(own.map((m) => d(docs[i].v, docs[m].v)));
      const others = clusters
        .map((c, ci) => (ci === labels[i] ? null : mean(c.members.map((m) => d(docs[i].v, docs[m].v)))))
        .filter((x) => x !== null);
      if (!others.length) return 0;
      const b = Math.min(...others);
      return (b - a) / Math.max(a, b);
    });

    const score = mean(sils);
    if (!best || score > best.score) best = { k, score, clusters, labels };
  }

  // §4.3 — silhouette > 0.35 AND cluster size >= 3.
  if (!best || best.score <= 0.35) return [];

  return best.clusters
    .filter((c) => c.members.length >= 3)
    .map((c) => ({
      size: c.members.length,
      titles: c.members.map((m) => docs[m].b.title),
      // Labelled by the highest-TF-IDF subject headings within it.
      label: topSubjects(c.members.map((m) => docs[m].b), finished)
    }))
    .filter((c) => c.label);
}

function topSubjects(members, all) {
  const inCluster = new Map();
  for (const b of members) for (const s of new Set(b.subjects || [])) inCluster.set(s, (inCluster.get(s) || 0) + 1);

  const overall = new Map();
  for (const b of all) for (const s of new Set(b.subjects || [])) overall.set(s, (overall.get(s) || 0) + 1);

  const ranked = [...inCluster.entries()]
    .filter(([, n]) => n >= 2)
    .map(([s, n]) => ({ s, score: n * Math.log(all.length / (1 + (overall.get(s) || 0)) + 1) }))
    .sort((a, b) => b.score - a.score);

  return ranked.length ? ranked.slice(0, 2).map((r) => r.s).join(', ') : null;
}
