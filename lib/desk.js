import { all, get } from '../db/index.js';

// ── THE DESK ─────────────────────────────────────────────
// A search system, not an assistant. It finds things. It does not talk, does
// not act, and does not have a name in the interface.
//
// Progressive escalation is the whole design: tier 0 and 1 are pure SQL,
// tier 2 is local cosine, and tier 3 (a model) fires only when the first
// three come up short AND local-only is off. Most queries never leave the
// machine.

// ── The shape every tier produces and consumes ───────────
export function emptyQuery() {
  return {
    text: '',
    terms: [],
    shelf: null,
    pageCountMin: null,
    pageCountMax: null,
    finishedAfter: null,
    finishedBefore: null,
    publishedAfter: null,
    publishedBefore: null,
    ratingMin: null,
    ratingMax: null,
    unrated: false,
    translated: null,
    author: null,
    excludeAuthors: [],
    semantic: null,
    unsupportedField: null,
    isCommand: false
  };
}

// ── Tier 1 vocabulary ────────────────────────────────────
const SHELVES = {
  unread: 'waiting', waiting: 'waiting', 'to read': 'waiting', 'to-read': 'waiting',
  finished: 'finished', read: 'finished', done: 'finished',
  abandoned: 'abandoned', dnf: 'abandoned', 'gave up': 'abandoned', 'gave up on': 'abandoned',
  reading: 'reading', 'in progress': 'reading', 'on press': 'reading',
  favorites: 'favorites', favourites: 'favorites'
};

// Phrased as an instruction. The desk searches the words anyway.
const COMMAND = /\b(move|add|delete|remove|create|rename|set|mark|tag|change|put|sort|organi[sz]e)\b/i;

// Fields the library does not carry. Asking for them returns nothing and
// says so, rather than silently returning everything.
const ABSENT_FIELDS = [
  { re: /\b(by|from)\s+(men|man|male)s?\b|\bnothing by men\b/i, field: 'author gender' },
  { re: /\b(by|from)\s+(women|woman|female)s?\b/i, field: 'author gender' },
  { re: /\bnonbinary\b/i, field: 'author gender' },
  { re: /\bmood\b|\bvibe\b/i, field: 'mood' }
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

const pad = (n) => String(n).padStart(2, '0');
const monthWindow = (year, month) => {
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return [`${year}-${pad(month)}-01`, end];
};

// ── Tier 1: structured parse ─────────────────────────────
// Pure token extraction. No network, no model, runs in under a millisecond.
export function parseQuery(text) {
  const q = emptyQuery();
  q.text = String(text || '').trim();
  if (!q.text) return q;

  const s = q.text.toLowerCase();
  const now = new Date();
  const year = now.getFullYear();
  let consumed = s;

  q.isCommand = COMMAND.test(s);

  for (const f of ABSENT_FIELDS) {
    if (f.re.test(s)) q.unsupportedField = f.field;
  }

  // shelf
  for (const [word, slug] of Object.entries(SHELVES)) {
    if (new RegExp(`\\b${word}\\b`).test(s)) {
      q.shelf = slug;
      consumed = consumed.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ');
      break;
    }
  }

  // length
  const under = s.match(/\b(?:under|below|less than|fewer than|shorter than)\s+(\d{2,4})\s*(?:pp|pages?)?\b/);
  if (under) { q.pageCountMax = Number(under[1]); consumed = consumed.replace(under[0], ' '); }

  const over = s.match(/\b(?:over|above|more than|longer than)\s+(\d{2,4})\s*(?:pp|pages?)?\b/);
  if (over) { q.pageCountMin = Number(over[1]); consumed = consumed.replace(over[0], ' '); }

  if (/\b(short|slim|thin)\b/.test(s) && !q.pageCountMax) { q.pageCountMax = 200; consumed = consumed.replace(/\b(short|slim|thin)\b/g, ' '); }
  if (/\b(long|doorstop|chunky|huge|thick)\b/.test(s) && !q.pageCountMin) { q.pageCountMin = 500; consumed = consumed.replace(/\b(long|doorstop|chunky|huge|thick)\b/g, ' '); }

  // date read
  const inYear = s.match(/\bin\s+((?:19|20)\d{2})\b/);
  if (inYear) {
    q.finishedAfter = `${inYear[1]}-01-01`;
    q.finishedBefore = `${Number(inYear[1]) + 1}-01-01`;
    consumed = consumed.replace(inYear[0], ' ');
  }
  if (/\blast year\b/.test(s)) {
    q.finishedAfter = `${year - 1}-01-01`;
    q.finishedBefore = `${year}-01-01`;
    consumed = consumed.replace(/\blast year\b/g, ' ');
  }
  if (/\bthis year\b/.test(s)) {
    q.finishedAfter = `${year}-01-01`;
    q.finishedBefore = `${year + 1}-01-01`;
    consumed = consumed.replace(/\bthis year\b/g, ' ');
  }

  const inMonth = s.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (inMonth) {
    const m = MONTHS[inMonth[1]];
    // The most recent occurrence of that month, which is what "in March"
    // means when spoken.
    const y = m > now.getMonth() + 1 ? year - 1 : year;
    [q.finishedAfter, q.finishedBefore] = monthWindow(y, m);
    consumed = consumed.replace(inMonth[0], ' ');
  }

  const season = s.match(/\b(this|last)?\s*(winter|spring|summer|autumn|fall)\b/);
  if (season) {
    const spans = { winter: [12, 2], spring: [3, 5], summer: [6, 8], autumn: [9, 11], fall: [9, 11] };
    const [a, b] = spans[season[2]];
    const y = season[1] === 'last' ? year - 1 : year;
    q.finishedAfter = a === 12 ? `${y - 1}-12-01` : `${y}-${pad(a)}-01`;
    q.finishedBefore = `${y}-${pad(b === 2 ? 3 : b + 1)}-01`;
    consumed = consumed.replace(season[0], ' ');
  }

  const YEAR = '(1[0-9]{3}|20[0-9]{2})';
  const beforeYear = s.match(new RegExp(`\\bbefore\\s+${YEAR}\\b`));
  if (beforeYear) { q.finishedBefore = `${beforeYear[1]}-01-01`; consumed = consumed.replace(beforeYear[0], ' '); }

  // publication date
  const decade = s.match(/\b(?:published|written|from)?\s*(?:in\s+)?the\s+((?:1[0-9]|20)?\d0)s\b/);
  if (decade) {
    let d = Number(decade[1]);
    if (d < 100) d += d < 30 ? 2000 : 1900;
    q.publishedAfter = d;
    q.publishedBefore = d + 10;
    consumed = consumed.replace(decade[0], ' ');
  }
  // "before" is not the only way anybody says this, and the vocabulary
  // being short is why "written prior to 1900" parsed as nothing at all and
  // then quietly became a text search that matched a book ABOUT 1848.
  const BEFORE = '(?:before|prior\\s+to|earlier\\s+than|up\\s+to|older\\s+than)';
  const AFTER  = '(?:after|since|later\\s+than|newer\\s+than|from)';
  const WROTE  = '(?:published|written|printed|from)';

  const pubBefore = s.match(new RegExp(`\\b${WROTE}\\s+${BEFORE}\\s+${YEAR}\\b`));
  if (pubBefore) {
    q.publishedBefore = Number(pubBefore[1]);
    consumed = consumed.replace(pubBefore[0], ' ');
  }

  const pubAfter = s.match(new RegExp(`\\b${WROTE}\\s+${AFTER}\\s+${YEAR}\\b`));
  if (pubAfter) {
    q.publishedAfter = Number(pubAfter[1]);
    consumed = consumed.replace(pubAfter[0], ' ');
  }

  // "pre-1900" and "post-1945" with no verb at all.
  const preYear = s.match(new RegExp(`\\bpre-?\\s*${YEAR}\\b`));
  if (preYear && !q.publishedBefore) {
    q.publishedBefore = Number(preYear[1]);
    consumed = consumed.replace(preYear[0], ' ');
  }
  const postYear = s.match(new RegExp(`\\bpost-?\\s*${YEAR}\\b`));
  if (postYear && !q.publishedAfter) {
    q.publishedAfter = Number(postYear[1]);
    consumed = consumed.replace(postYear[0], ' ');
  }

  // Bare "19th century" / "nineteenth century".
  const century = s.match(/\b(\d{1,2})(?:st|nd|rd|th)[- ]century\b/);
  if (century) {
    const c = Number(century[1]);
    if (c >= 10 && c <= 21) {
      q.publishedAfter = (c - 1) * 100;
      q.publishedBefore = c * 100;
      consumed = consumed.replace(century[0], ' ');
    }
  }

  if (/\bpre-?war\b/.test(s)) { q.publishedBefore = 1939; consumed = consumed.replace(/\bpre-?war\b/g, ' '); }

  // rating
  // "above 3" excludes 3. It was inclusive, which is why a query for
  // anything ABOVE three stars came back with a three-star book at the top.
  // Ratings move in half stars, so the next value up is exactly +0.5.
  const above = s.match(/\b(?:rated\s+)?(?:above|over|better\s+than|more\s+than)\s+([1-5](?:\.5)?)\b/);
  if (above) {
    q.ratingMin = Number(above[1]) + 0.5;
    q.ratingMax = null;
    consumed = consumed.replace(above[0], ' ');
  }

  // "at least 4" / "4 or better" keep the boundary.
  const atLeast = s.match(/\b(?:rated\s+)?(?:at\s+least|no\s+less\s+than)\s+([1-5](?:\.5)?)\b/)
    || s.match(/\b([1-5](?:\.5)?)\s*(?:stars?\s+)?or\s+(?:better|more|higher|above)\b/);
  if (atLeast) {
    q.ratingMin = Number(atLeast[1]);
    q.ratingMax = null;
    consumed = consumed.replace(atLeast[0], ' ');
  }

  const below = s.match(/\b(?:rated\s+)?(?:below|under|less\s+than|worse\s+than)\s+([1-5](?:\.5)?)\b/);
  if (below) {
    q.ratingMax = Number(below[1]) - 0.5;
    q.ratingMin = null;
    consumed = consumed.replace(below[0], ' ');
  }

  // "4 stars", meaning exactly four. It runs last and only if no
  // comparative already claimed the number: matching it first is what left
  // "rated above" stranded in the free text of "rated above 3 stars",
  // because the comparative could no longer find the digit to strip.
  if (q.ratingMin == null && q.ratingMax == null) {
    const stars = s.match(/\b([1-5])(?:\.5)?\s*star/);
    if (stars) {
      q.ratingMin = Number(stars[1]);
      q.ratingMax = Number(stars[1]);
      consumed = consumed.replace(stars[0], ' ');
    }
  } else {
    // A comparative already set the bound; the trailing word is decoration.
    consumed = consumed.replace(/\b[1-5](?:\.5)?\s*stars?\b/g, ' ').replace(/\bstars?\b/g, ' ');
  }

  if (/\bunrated\b/.test(s)) { q.unrated = true; consumed = consumed.replace(/\bunrated\b/g, ' '); }
  if (/\b(my )?(favourites?|favorites?)\b/.test(s) && !q.shelf) { q.ratingMin = 4; }

  // language / translation
  if (/\bnot\s+translated\b|\boriginally\s+english\b/.test(s)) { q.translated = false; consumed = consumed.replace(/\bnot\s+translated\b|\boriginally\s+english\b/g, ' '); }
  else if (/\btranslated\b|\bin translation\b/.test(s)) { q.translated = true; consumed = consumed.replace(/\btranslated\b|\bin translation\b/g, ' '); }

  // author, matched against the library's own people
  const authors = all(
    `SELECT DISTINCT p.name FROM people p JOIN work_people wp ON wp.person_id = p.id WHERE wp.role = 'AUTHOR'`
  ).map((r) => r.name);

  const negated = /\b(not|except|other than|besides|apart from)\b/.test(s);
  for (const name of authors) {
    const surname = name.split(/\s+/).pop().toLowerCase();
    if (surname.length < 4) continue;
    if (new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) {
      if (negated) q.excludeAuthors.push(name);
      else q.author = name;
      consumed = consumed.replace(new RegExp(surname, 'g'), ' ');
      break;
    }
  }

  // Whatever is left is the semantic remainder.
  const STOP = new Set(['the','a','an','of','and','or','in','on','at','to','for','with','my','me','i','it','that','this','those','these','things','thing','stuff','book','books','one','ones','something','anything','everything','all','some','was','were','is','are','about','by','from','had','have','been','did','do']);
  const rest = consumed
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

  q.terms = rest;
  q.semantic = rest.join(' ') || null;
  return q;
}

const hasStructure = (q) =>
  q.shelf || q.pageCountMin || q.pageCountMax || q.finishedAfter || q.finishedBefore ||
  q.publishedAfter || q.publishedBefore || q.ratingMin != null || q.ratingMax != null ||
  q.unrated || q.translated != null || q.author || q.excludeAuthors.length;

// ── The row every tier returns ───────────────────────────
// One shape, so results render through the existing shelf views unmodified.
const ROW = `
  SELECT
    w.id AS work_id, w.title, w.first_published_year, w.subjects, w.blurb,
    e.id AS edition_id, e.page_count, e.format, e.publisher, e.isbn13,
    e.cover_url, e.cover_cache_key, e.spine_color,
    (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
     WHERE wp.work_id = w.id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS authorLine,
    r.stars, r.status, r.finished_at, r.abandoned_page, r.current_page,
    r.total_positions, r.position_type, r.id AS reading_id,
    r.note_encrypted, r.private_note, r.review
  FROM works w
  LEFT JOIN editions e ON e.id = (
    SELECT e2.id FROM editions e2 WHERE e2.work_id = w.id
    ORDER BY (e2.cover_cache_key IS NULL), (e2.cover_url IS NULL), (e2.page_count IS NULL), e2.published_year DESC LIMIT 1
  )
  LEFT JOIN readings r ON r.id = (
    SELECT r2.id FROM readings r2 WHERE r2.work_id = w.id AND r2.user_id = ?
    ORDER BY r2.pass_number DESC LIMIT 1
  )`;

// ── Tier 0: literal ──────────────────────────────────────
// Case-insensitive substring over title, author, series, translator,
// publisher. Fires on every keystroke.
export function tier0(userId, text, { limit = 60 } = {}) {
  const t = String(text || '').trim();
  if (t.length < 2) return [];
  const like = `%${t.toLowerCase()}%`;

  return all(
    `${ROW}
     WHERE lower(w.title) LIKE ?
        OR EXISTS (SELECT 1 FROM work_people wp JOIN people p ON p.id = wp.person_id
                   WHERE wp.work_id = w.id AND lower(p.name) LIKE ?)
        OR EXISTS (SELECT 1 FROM series_works sw JOIN series s ON s.id = sw.series_id
                   WHERE sw.work_id = w.id AND lower(s.name) LIKE ?)
        OR EXISTS (SELECT 1 FROM editions e3 WHERE e3.work_id = w.id AND lower(e3.publisher) LIKE ?)
     ORDER BY (lower(w.title) = ?) DESC, length(w.title)
     LIMIT ?`,
    Number(userId), like, like, like, like, t.toLowerCase(), limit
  );
}

// ── Tier 1: structured ───────────────────────────────────
export function tier1(userId, q, { limit = 200 } = {}) {
  const where = [];
  const params = [Number(userId)];

  if (q.shelf) {
    where.push(`EXISTS (SELECT 1 FROM shelf_items si JOIN shelves sh ON sh.id = si.shelf_id
                        WHERE si.work_id = w.id AND sh.user_id = ? AND sh.slug = ?)`);
    params.push(Number(userId), q.shelf);
  }
  if (q.pageCountMax) { where.push('e.page_count IS NOT NULL AND e.page_count <= ?'); params.push(q.pageCountMax); }
  if (q.pageCountMin) { where.push('e.page_count IS NOT NULL AND e.page_count >= ?'); params.push(q.pageCountMin); }
  if (q.finishedAfter) { where.push('COALESCE(r.finished_at, r.abandoned_at) >= ?'); params.push(q.finishedAfter); }
  if (q.finishedBefore) { where.push('COALESCE(r.finished_at, r.abandoned_at) < ?'); params.push(q.finishedBefore); }
  if (q.publishedAfter) { where.push('w.first_published_year >= ?'); params.push(q.publishedAfter); }
  if (q.publishedBefore) { where.push('w.first_published_year < ?'); params.push(q.publishedBefore); }
  if (q.unrated) where.push('r.stars IS NULL');
  if (q.ratingMin != null) { where.push('r.stars >= ?'); params.push(q.ratingMin); }
  if (q.ratingMax != null) { where.push('r.stars <= ?'); params.push(q.ratingMax); }

  if (q.translated === true) {
    where.push(`EXISTS (SELECT 1 FROM edition_credits ec JOIN editions e4 ON e4.id = ec.edition_id
                        WHERE e4.work_id = w.id AND ec.role = 'TRANSLATION')`);
  } else if (q.translated === false) {
    where.push(`NOT EXISTS (SELECT 1 FROM edition_credits ec JOIN editions e4 ON e4.id = ec.edition_id
                            WHERE e4.work_id = w.id AND ec.role = 'TRANSLATION')`);
  }

  if (q.author) {
    where.push(`EXISTS (SELECT 1 FROM work_people wp JOIN people p ON p.id = wp.person_id
                        WHERE wp.work_id = w.id AND p.name = ?)`);
    params.push(q.author);
  }
  for (const name of q.excludeAuthors) {
    where.push(`NOT EXISTS (SELECT 1 FROM work_people wp JOIN people p ON p.id = wp.person_id
                            WHERE wp.work_id = w.id AND p.name = ?)`);
    params.push(name);
  }

  if (!where.length) return [];
  params.push(limit);

  return all(`${ROW} WHERE ${where.join(' AND ')} ORDER BY w.title LIMIT ?`, ...params);
}

export { hasStructure };

// ── Tier 2 + orchestration ───────────────────────────────
import { semanticSearch, noteExcerpt } from './vectors.js';

const byId = (rows) => new Map(rows.map((r) => [r.work_id, r]));

function hydrate(userId, workIds) {
  if (!workIds.length) return [];
  const rows = all(
    `${ROW} WHERE w.id IN (${workIds.map(() => '?').join(',')})`,
    Number(userId), ...workIds
  );
  const m = byId(rows);
  return workIds.map((id) => m.get(id)).filter(Boolean);
}

// The one entry point. Escalates only as far as it has to.
export function search(userId, text, { localOnly = true } = {}) {
  const q = parseQuery(text);
  // `caption` carries MESSAGES only — that the field does not exist, that
  // the filters matched nothing and these are the nearest, that the desk
  // does not take commands. It used to also carry a summary of the results
  // ("One, all finished."), which on a single row is a tautology and on
  // several was a sentence nobody asked for.
  const out = { query: q, tier: 0, rows: [], caption: null, widened: false };
  if (!q.text) return out;

  // §6 — a field the library does not carry returns nothing and says so,
  // rather than quietly returning everything.
  if (q.unsupportedField) {
    out.caption = 'No such field.';
    return out;
  }

  // Tier 0 — literal.
  const literal = tier0(userId, q.text);

  // Tier 1 — structured, when the sentence carried any structure at all.
  let structured = [];
  if (hasStructure(q)) {
    structured = tier1(userId, q);
    out.tier = 1;
  }

  // A structured query with a semantic remainder narrows within its filters.
  if (structured.length && q.semantic) {
    const sem = new Map(semanticSearch(q.semantic, { userId, limit: 200 }).map((r) => [r.work_id, r]));
    const narrowed = structured
      .filter((r) => sem.has(r.work_id))
      .sort((a, b) => sem.get(b.work_id).score - sem.get(a.work_id).score);
    if (narrowed.length) {
      out.tier = 2;
      out.rows = narrowed.map((r) => attachNote(r, sem.get(r.work_id), q.semantic));
      return out;
    }
  }

  if (structured.length) {
    out.rows = structured;
    return out;
  }

  // Literal beats semantic when it is confident — an exact title should not
  // be outranked by a thematic neighbour.
  if (literal.length) {
    out.rows = literal;
    return out;
  }

  // Tier 2 — semantic.
  const sem = semanticSearch(q.semantic || q.text, { userId, limit: 60 });
  if (sem.length) {
    out.tier = 2;
    const rows = hydrate(userId, sem.map((r) => r.work_id));
    const m = new Map(sem.map((r) => [r.work_id, r]));
    out.rows = rows.map((r) => attachNote(r, m.get(r.work_id), q.semantic || q.text));
    // The sentence carried filters that matched nothing. Widening is fine;
    // widening silently is not.
    out.widened = hasStructure(q);
    // Widening is fine; widening silently is not.
    if (out.widened) out.caption = 'Nothing exact. Closest below.';
    return out;
  }

  out.caption = q.isCommand ? 'The desk only finds things.' : 'Nothing.';
  return out;
}

// When a note carried the match, the row shows the reader's own sentence
// rather than a blurb — verbatim, never summarised (§7).
function attachNote(row, hit, query) {
  if (!hit || hit.kind !== 'note' || !hit.excerpt) return row;
  return { ...row, noteExcerpt: noteExcerpt(hit.excerpt, query) };
}

// ── §8 Caption voice ─────────────────────────────────────
// One line, fifteen words maximum, no first person, no explanation of how
// the search worked, and none at all when there is nothing to say.
const COUNT_WORD = ['Nothing', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const countWord = (n) => COUNT_WORD[n] || String(n);


// ── Tier 3: model parse ──────────────────────────────────
// Fires only when tiers 0–2 return fewer than three results, the query is
// longer than four words, and local-only is off.
//
// The model's ONLY job is to turn a sentence into a StructuredQuery plus a
// semantic string. It does not rank, and it never sees the library — it sees
// the query text and the schema, nothing else (§11). The filters it returns
// are then executed locally through tiers 1 and 2, so ranking stays
// deterministic and identical whether or not a model was involved.

const TIER3_TIMEOUT_MS = 2000;

const SCHEMA_PROMPT = `Translate a reader's sentence about their own book collection into JSON.

Return ONLY this shape, no prose:
{"filters":{"shelf":null,"pageCountMin":null,"pageCountMax":null,"finishedAfter":null,"finishedBefore":null,"publishedAfter":null,"publishedBefore":null,"ratingMin":null,"translated":null,"excludeAuthors":[]},"semantic":null}

shelf is one of: waiting, finished, abandoned, reading, favorites, or null.
Dates are YYYY-MM-DD. Years are integers. translated is true, false, or null.
semantic is a short phrase describing subject matter, or null.
Never invent titles or authors.`;

export async function tier3(text, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIER3_TIMEOUT_MS);

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
        max_tokens: 300,
        temperature: 0,
        system: SCHEMA_PROMPT,
        messages: [{ role: 'user', content: String(text).slice(0, 400) }]
      })
    });
    if (!res.ok) return null;

    const data = await res.json();
    const raw = data?.content?.[0]?.text || '';
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Malformed, slow, or unreachable: fall through in silence. The reader
    // must not be able to tell a model call happened.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Merge a model-returned shape into a locally parsed query. Local wins on
// anything it already established.
export function mergeTier3(q, parsed) {
  if (!parsed?.filters) return q;
  const f = parsed.filters;
  const merged = { ...q };
  const take = (key, val) => { if (merged[key] == null && val != null) merged[key] = val; };

  if (['waiting', 'finished', 'abandoned', 'reading', 'favorites'].includes(f.shelf)) take('shelf', f.shelf);
  take('pageCountMin', Number.isFinite(f.pageCountMin) ? f.pageCountMin : null);
  take('pageCountMax', Number.isFinite(f.pageCountMax) ? f.pageCountMax : null);
  take('finishedAfter', typeof f.finishedAfter === 'string' ? f.finishedAfter : null);
  take('finishedBefore', typeof f.finishedBefore === 'string' ? f.finishedBefore : null);
  take('publishedAfter', Number.isFinite(f.publishedAfter) ? f.publishedAfter : null);
  take('publishedBefore', Number.isFinite(f.publishedBefore) ? f.publishedBefore : null);
  take('ratingMin', Number.isFinite(f.ratingMin) ? f.ratingMin : null);
  if (merged.translated == null && typeof f.translated === 'boolean') merged.translated = f.translated;
  if (typeof parsed.semantic === 'string' && parsed.semantic.trim()) merged.semantic = parsed.semantic.trim();
  return merged;
}

// The escalating entry point. Callers that cannot await use search().
export async function searchAsync(userId, text, { localOnly = true } = {}) {
  const first = search(userId, text, { localOnly });

  const words = String(text || '').trim().split(/\s+/).length;
  const eligible = !localOnly && first.rows.length < 3 && words > 4 &&
    !first.query.isCommand && !first.query.unsupportedField;
  if (!eligible) return first;

  const parsed = await tier3(text);
  if (!parsed) return first;

  const q = mergeTier3(first.query, parsed);
  const rows = hasStructure(q) ? tier1(userId, q) : [];

  let out = rows;
  if (q.semantic) {
    const sem = new Map(semanticSearch(q.semantic, { limit: 200 }).map((r) => [r.work_id, r]));
    if (rows.length) {
      const narrowed = rows.filter((r) => sem.has(r.work_id));
      out = narrowed.length ? narrowed : rows;
    } else {
      out = hydrate(userId, [...sem.keys()].slice(0, 60));
    }
  }

  if (!out.length) return first;
  return { query: q, tier: 3, rows: out, caption: null, widened: false };
}

// ── WHAT IT ACTUALLY FILTERED ON ─────────────────────────
/**
 * The query as the desk understood it.
 *
 * Without this a wrong-looking result is a mystery: one book came back for
 * "rated above 3 stars, written prior to 1900" and there was no way to see
 * whether the sentence had been misread or the book's recorded year was
 * wrong. It was the second, and the page gave the reader nothing to tell
 * them apart.
 *
 * Only what was understood is listed. Free text is not a filter and does
 * not appear here.
 */
export function appliedFilters(q) {
  if (!q) return [];
  const f = [];

  if (q.shelf) f.push(`ON ${String(q.shelf).toUpperCase()}`);

  if (q.ratingMin != null && q.ratingMax != null && q.ratingMin === q.ratingMax) {
    f.push(`RATED ${q.ratingMin}`);
  } else {
    if (q.ratingMin != null) f.push(`RATED ${q.ratingMin} OR MORE`);
    if (q.ratingMax != null) f.push(`RATED ${q.ratingMax} OR LESS`);
  }
  if (q.unrated) f.push('UNRATED');

  if (q.publishedAfter && q.publishedBefore) f.push(`PUBLISHED ${q.publishedAfter}–${q.publishedBefore}`);
  else if (q.publishedAfter) f.push(`PUBLISHED FROM ${q.publishedAfter}`);
  else if (q.publishedBefore) f.push(`PUBLISHED BEFORE ${q.publishedBefore}`);

  if (q.pageCountMin) f.push(`OVER ${q.pageCountMin}PP`);
  if (q.pageCountMax) f.push(`UNDER ${q.pageCountMax}PP`);

  if (q.finishedAfter) f.push(`FINISHED FROM ${String(q.finishedAfter).slice(0, 10)}`);
  if (q.finishedBefore) f.push(`FINISHED BEFORE ${String(q.finishedBefore).slice(0, 10)}`);

  if (q.translated === true) f.push('TRANSLATED');
  if (q.translated === false) f.push('NOT TRANSLATED');
  if (q.author) f.push(`BY ${String(q.author).toUpperCase()}`);
  for (const a of q.excludeAuthors || []) f.push(`NOT ${String(a).toUpperCase()}`);

  return f;
}
