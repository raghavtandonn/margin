// ── §5 — THE INTERPRETATION PASS ─────────────────────────
//
// One model call, at season close. "The model interprets; it never
// calculates." Every number in the note was computed by lib/facts.js before
// this file was reached, and §5.5's validator refuses anything the model
// added that is not in the fact set.
//
// §14.8 — "Build validation BEFORE display." So the validator and the
// template fallback are the load-bearing parts of this file; the model call
// is the optional decoration on top of them.

const TIMEOUT_MS = 12_000;

// ── §5.4 — the prohibitions ──────────────────────────────
//
// "The prohibitions matter more than the permissions." Each of these is a
// specific failure the spec names, not a general tone filter.
const BANNED = [
  // Inference about the reader's life or emotional state. "When they happen
  // to be right they are worse, not better."
  /\b(quiet|difficult|hard|turbulent|restless|lonely|anxious|hopeful)\s+(season|few months|year|stretch|period)\b/i,
  /\byou (seem|appear|must have|were probably|clearly)\b/i,
  /\ba season of\b/i,
  /\bsearching for\b/i,
  /\bretreat\b/i,

  // Praise, encouragement, congratulation.
  /\b(impressive|amazing|incredible|fantastic|wonderful|great job|well done|crushed it|nailed it)\b/i,
  /\bwhat a (season|year)\b/i,
  /\bkeep it up\b/i,
  /\bcongratulations\b/i,

  // Advice and second-person imperatives.
  /\b(you should|try reading|why not|consider reading|next time)\b/i,

  // Comparison to other users.
  //
  // No trailing \b: it sits after "%", which is not a word character, so
  // the boundary can never match and the whole alternation was dead —
  // "the top 5% of readers" sailed through the filter it was written for.
  /\btop \d+\s*%/i,
  /\bpercentiles?\b/i,
  /\bmore than \d+\s*% of\b/i,
  /\b(compared to|against) (other|most) readers\b/i,
  /\bmost readers\b/i,
  /\bthan (other|most) (readers|people)\b/i,

  // First person.
  /\bI (noticed|see|think|found|suspect)\b/i,

  // Exclamation marks and emoji.
  /!/,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
];

export function findBanned(text) {
  return BANNED.filter((re) => re.test(String(text || ''))).map((re) => re.source);
}

// ── §5.5 — validation ────────────────────────────────────
//
// "Regex-extract every number, date, and proper noun from note. Assert each
// appears in the supplied fact set or book list."
//
// This is the step that makes the feature trustworthy: a note that is
// elegant and wrong is worse than a plain one that is right.

const NUMBER = /\b\d[\d,.]*\b/g;
// Capitalised runs that are not sentence-initial.
const PROPER = /(?<![.!?]\s)(?<!^)\b([A-Z][a-z']+(?:\s+[A-Z][a-z']+)*)\b/gm;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Words that begin a sentence or are ordinary English rather than names.
const COMMON = new Set(['the', 'a', 'an', 'and', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'none', 'every', 'all', 'both', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'nothing', 'no', 'this', 'that', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'spring', 'summer', 'autumn', 'winter', 'pass', 'read', 'books', 'book', 'pages', 'page',
  'stars', 'star', 'days', 'day', 'first', 'last', 'median', 'mean', 'translated']);

/**
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validate(note, { facts, books, season }) {
  const problems = [];
  const text = String(note || '');

  if (!text.trim()) return { ok: false, problems: ['empty'] };

  // Every number the facts vouch for, in every form it might be written.
  const allowedNumbers = new Set();
  const allow = (v) => {
    if (v == null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    allowedNumbers.add(norm(String(n)));
    allowedNumbers.add(norm(n.toLocaleString('en-GB')));
    allowedNumbers.add(norm(String(Math.round(n))));
  };

  for (const f of facts) {
    allow(f.value);
    // The baseline is a computed fact too — §4.7 defines it — so a note
    // comparing to it is supported. Without this the validator rejected the
    // template's own output: "against a usual 34" with 34 nowhere allowed.
    allow(f.baseline);
    // Numbers inside the fact's own sentence are vouched for by definition.
    for (const m of String(f.text).match(NUMBER) || []) allowedNumbers.add(norm(m));
  }
  for (const b of books) {
    allow(b.pages);
    if (b.finished_at) {
      const d = String(b.finished_at).slice(0, 10);
      allowedNumbers.add(norm(d.slice(0, 4)));
      allowedNumbers.add(norm(String(Number(d.slice(8, 10)))));
    }
    if (b.pass) allow(b.pass);
  }
  allow(books.length);
  if (season?.short) for (const m of season.short.match(NUMBER) || []) allowedNumbers.add(norm(m));

  for (const m of text.match(NUMBER) || []) {
    if (!allowedNumbers.has(norm(m))) problems.push(`number not in the facts: ${m}`);
  }

  // Proper nouns must be a title, an author, a language, or a month.
  const allowedNames = new Set(COMMON);
  const addName = (s) => {
    if (!s) return;
    allowedNames.add(norm(s));
    for (const w of String(s).split(/\s+/)) allowedNames.add(norm(w));
  };
  for (const b of books) { addName(b.title); addName(b.author); addName(b.language); }
  for (const f of facts) addName(f.text);
  addName(season?.label);
  addName(season?.short);

  for (const m of text.matchAll(PROPER)) {
    const phrase = m[1];
    if (allowedNames.has(norm(phrase))) continue;
    if (phrase.split(/\s+/).every((w) => allowedNames.has(norm(w)))) continue;
    problems.push(`name not in the facts: ${phrase}`);
  }

  const banned = findBanned(text);
  for (const b of banned) problems.push(`banned construction: ${b}`);

  return { ok: problems.length === 0, problems };
}

// ── §5.5.4 — the template note ───────────────────────────
//
// "On a second failure, fall back to a template-composed note built
// directly from the top 3 facts. A plainer true note beats an elegant false
// one."
//
// It is also what runs when there is no model configured at all, and §5.2
// is explicit that the no-model path "must work well, not be a degraded
// apology". So this is written to be read, not to be a placeholder.

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function templateNote({ facts, season, comparable }) {
  if (!facts.length) return null;

  const parts = [];

  // How many books is the shape of the season, not a fact competing for
  // interest — it is looked up across the WHOLE ranked set rather than the
  // top four, because the §4.7 per-section cap can otherwise push it out
  // and leave the note opening on a page-count average.
  const count = facts.find((f) => f.key === 'books_finished');
  const rest = facts.filter((f) => f.key !== 'books_finished').slice(0, 3);

  if (count) {
    // §4.7 defines the baseline as the MEAN over prior seasons, so the
    // phrasing has to be "a usual", not "the season before" — and a book
    // count is a whole number however the mean comes out. "Against 2.69
    // the season before" was wrong twice over.
    const baseline = comparable && count.baseline != null
      ? `, against a usual ${Math.round(count.baseline)}`
      : '';
    parts.push(sentence(`${count.text}${baseline}.`));
  }

  // Then up to three more, each stated and left alone. §5.4: "Where a fact
  // is odd, state it and stop."
  for (const f of rest.slice(0, 3)) parts.push(sentence(`${f.text}.`));

  return parts.join(' ');
}

/**
 * §5.3 — the title. 2–4 words, and it "must be readable off a supplied
 * fact. If no fact supports a distinctive title, return the plain season
 * name."
 */
export function templateTitle({ facts, season }) {
  const cp = facts.find((f) => f.section === '4.6');
  if (cp) {
    // "After October" — the spec's own example, and it is readable straight
    // off a changepoint.
    const m = /after (\d+ )?([A-Z][a-z]+)/.exec(cp.text);
    if (m) return `After ${m[2]}`;
  }

  const wait = facts.find((f) => f.key === 'longest_wait');
  if (wait) return 'The Long Wait';

  const lang = facts.find((f) => f.key === 'translated');
  if (lang && lang.value >= 0.6) return 'In Translation';

  const cluster = facts.find((f) => f.key === 'cluster');
  if (cluster) {
    const label = String(cluster.text).split(' on ').pop();
    const words = label.split(/[\s,]+/).filter(Boolean).slice(0, 3);
    if (words.length) return words.map((w) => sentence(w)).join(' ');
  }

  // §5.3 — no fact supports a distinctive title.
  return season.label;
}

// ── §5.1 / §5.2 — the model call ─────────────────────────
const SYSTEM = `You write one short note for a reader's completed reading season.

You interpret. You never calculate. Every number, date and name you use must
already appear in the facts you are given.

Return JSON only:
{ "title": "2-4 words", "note": "60-80 words, one paragraph",
  "movements": [{ "boundary_id": 0, "name": "2-5 words" }] }

Rules:
- Every sentence traces to a supplied fact.
- Plain declaratives. Numbers stated as numbers.
- Comparisons only to this reader's own prior seasons, and only if given.
- Where a fact is odd, state it and stop.

Never: infer anything about the reader's life or emotional state; praise,
encourage or congratulate; give advice or use imperatives; compare to other
readers or use percentiles; describe books you have no facts about; use the
first person; use emoji or exclamation marks; manufacture a pattern the
facts do not show.

If a title cannot be read off a fact, return the season label as the title.`;

/**
 * §5.2 — THE PRIVACY GATE.
 *
 * "If local-only mode is on, note_excerpts is omitted entirely."
 *
 * And more than omitted: with local-only on this function is never called
 * at all, so §15's "zero outbound requests occur at season close" is a
 * property of the caller, not a promise made inside a request that has
 * already been built.
 */
export async function interpret({ facts, books, season, movements, noteExcerpts = [] },
                                { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) return null;

  const payload = {
    season: season.short,
    facts: facts.map((f) => ({ text: f.text, value: f.value })),
    books: books.map((b) => ({
      title: b.title, author: b.author, finished_at: b.finished_at,
      pages: b.pages, language: b.language, pass: b.pass
    })),
    // Computed in §6, never proposed by the model.
    movement_boundaries: movements.map((m, i) => ({
      boundary_id: i,
      starts_on: m.starts_on, ends_on: m.ends_on,
      books: m.books.map((b) => b.title),
      is_empty: !!m.is_empty
    })).filter((m) => !m.is_empty)
  };

  if (noteExcerpts.length) payload.note_excerpts = noteExcerpts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        // §5.4 — "enough life for a title, not enough to invent."
        temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!res.ok) return null;

    const data = await res.json();
    const raw = data?.content?.[0]?.text || '';
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole §5 pass: generate, validate, regenerate once, then fall back.
 *
 * Returns `{ title, note, movementNames, source }`, and `source` is carried
 * to the page so the lookbook can say which one wrote it rather than
 * implying a model did when a template did.
 */
export async function compose(input, { apiKey = process.env.ANTHROPIC_API_KEY, localOnly = true } = {}) {
  const fallback = () => ({
    title: templateTitle(input),
    note: templateNote(input),
    movementNames: {},
    source: 'template'
  });

  // §5.2 — local-only omits the excerpts, and this omits the call.
  if (localOnly || !apiKey) return fallback();

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await interpret(input, { apiKey });
    if (!out?.note) continue;

    const check = validate(out.note, input);
    if (!check.ok) continue;                      // §5.5.3 — regenerate once

    const titleCheck = validate(out.title || '', input);

    return {
      title: titleCheck.ok && out.title ? out.title : templateTitle(input),
      note: out.note,
      movementNames: Object.fromEntries(
        (out.movements || [])
          .filter((m) => typeof m.boundary_id === 'number' && m.name)
          .map((m) => [m.boundary_id, String(m.name).slice(0, 60)])
      ),
      source: 'model'
    };
  }

  // §5.5.4 — a plainer true note beats an elegant false one.
  return fallback();
}
