import { all, get, run, tx, reindexWork, fold } from '../db/index.js';
import { starsFromImport } from './stars.js';
import { normalizeISBN, formatISBN } from './artifacts.js';

const peopleFor = (workId, role = 'AUTHOR') =>
  all(
    `SELECT p.id, p.name FROM work_people wp
     JOIN people p ON p.id = wp.person_id
     WHERE wp.work_id = ? AND wp.role = ? ORDER BY wp.ord`,
    workId,
    role
  );

export function authorLine(workId) {
  const names = peopleFor(workId).map((p) => p.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export function getWork(id) {
  const work = get('SELECT * FROM works WHERE id = ?', Number(id));
  if (!work) return null;
  work.authors = peopleFor(work.id);
  work.authorLine = authorLine(work.id);
  work.series = get(
    `SELECT s.id, s.name, sw.position FROM series_works sw
     JOIN series s ON s.id = sw.series_id WHERE sw.work_id = ?`,
    work.id
  );
  return work;
}

export function getEditions(workId) {
  const editions = all(
    'SELECT * FROM editions WHERE work_id = ? ORDER BY published_year DESC, id',
    Number(workId)
  );
  for (const e of editions) {
    e.isbnFormatted = formatISBN(e.isbn13);
    e.colophon = getColophon(e.id);
  }
  return editions;
}

export function getEdition(id) {
  const e = get('SELECT * FROM editions WHERE id = ?', Number(id));
  if (!e) return null;
  e.isbnFormatted = formatISBN(e.isbn13);
  e.colophon = getColophon(e.id);
  return e;
}

// §08: the colophon makes jacket designers linkable entities. This is the
// feature that gets the publishing industry itself to use the product.
export function getColophon(editionId) {
  const base = get('SELECT * FROM colophons WHERE edition_id = ?', Number(editionId)) || {};
  base.credits = all(
    `SELECT p.id, p.name, ec.role FROM edition_credits ec
     JOIN people p ON p.id = ec.person_id
     WHERE ec.edition_id = ? ORDER BY ec.role`,
    Number(editionId)
  );
  return base;
}

// ── The cover for a work (§1.4, §3) ──────────────────────
// One place decides which edition's jacket represents a work, so every
// surface in the app shows the same one. A verified cover always wins over
// an edition that merely happens to be newer.
export function coverForWork(workId, preferEditionId = null) {
  const row = get(
    `SELECT id AS edition_id, cover_url, cover_cache_key, spine_color, format,
            page_count, isbn13, publisher, published_year
     FROM editions
     WHERE work_id = ?
     ORDER BY (id != COALESCE(?, -1)),
              (cover_url IS NULL),
              (page_count IS NULL),
              published_year DESC
     LIMIT 1`,
    Number(workId),
    preferEditionId ? Number(preferEditionId) : null
  );
  if (!row) return null;

  // The preferred edition may itself have no jacket; fall back to any
  // edition of the same work that does rather than showing a galley plate
  // for a book we plainly have a cover for.
  if (!row.cover_url) {
    const withCover = get(
      `SELECT id AS edition_id, cover_url, cover_cache_key, spine_color, format,
              page_count, isbn13, publisher, published_year
       FROM editions WHERE work_id = ? AND cover_url IS NOT NULL
       ORDER BY (page_count IS NULL), published_year DESC LIMIT 1`,
      Number(workId)
    );
    if (withCover) return withCover;
  }
  return row;
}

// §12 — the work/edition graph is the product. An edition id that belongs to
// a different work must never be attached to this one: it would silently
// give a reading the wrong page count, cover, and colophon.
export function editionBelongsTo(workId, editionId) {
  if (!editionId) return null;
  const e = get(
    'SELECT id FROM editions WHERE id = ? AND work_id = ?',
    Number(editionId),
    Number(workId)
  );
  return e ? e.id : null;
}

// ── Search (§12) ─────────────────────────────────────────
// Trigram FTS gives substring and typo tolerance. An ISBN query short-circuits
// to an exact lookup because a scanned barcode should never be ranked.
export function search(query, { limit = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const asISBN = normalizeISBN(q);
  if (asISBN && /^[\d-]{10,17}$/.test(q)) {
    const hit = get(
      'SELECT work_id FROM editions WHERE isbn13 = ? OR isbn10 = ?',
      asISBN,
      q.replace(/-/g, '')
    );
    if (hit) return [decorateResult(getWork(hit.work_id), 'EXACT ISBN MATCH')];
  }

  // Trigram MATCH needs >= 3 chars; below that, fall back to a prefix scan.
  if (q.length < 3) {
    return all(
      'SELECT id FROM works WHERE title LIKE ? ORDER BY title LIMIT ?',
      `${q}%`,
      limit
    ).map((r) => decorateResult(getWork(r.id), 'TITLE PREFIX'));
  }

  const folded = fold(q);

  // Exact substring first: an exact hit should never be outranked by a fuzzy one.
  const rows = all(
    `SELECT work_id, bm25(works_fts, 10.0, 5.0, 3.0, 1.0) AS score
     FROM works_fts WHERE works_fts MATCH ?
     ORDER BY score LIMIT ?`,
    `"${folded.replace(/"/g, '""')}"`,
    limit
  );

  if (rows.length) {
    return rows.map((r) =>
      // §02 P2: if an algorithm ranked something, the ranking reason is printed
      // next to it. Nothing is a black box that could be a glass one.
      decorateResult(getWork(r.work_id), `BM25 ${r.score.toFixed(2)}`)
    );
  }

  return fuzzySearch(folded, limit);
}

const trigrams = (s) => {
  const padded = ` ${s.replace(/\s+/g, ' ').trim()} `;
  const out = new Set();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
};

// §00 failure 3 — "Typo tolerance is near zero" is one of the four structural
// failures this product exists to fix. A misspelling that shares most of its
// trigrams with a title is a match; the index supplies candidates and the
// Dice coefficient ranks them.
function fuzzySearch(folded, limit) {
  const queryGrams = trigrams(folded);
  if (!queryGrams.size) return [];

  // Candidates: anything sharing at least one trigram. This uses the index
  // rather than scanning the corpus.
  const clause = [...queryGrams]
    .filter((g) => g.trim().length === 3)
    .map((g) => `"${g.replace(/"/g, '""')}"`)
    .join(' OR ');
  if (!clause) return [];

  const candidates = all(
    `SELECT work_id, title, authors FROM works_fts WHERE works_fts MATCH ? LIMIT 400`,
    clause
  );

  const scored = candidates
    .map((c) => {
      // Score against the best-matching field rather than the concatenation,
      // so a short title is not penalised for sitting beside a long author list.
      const best = [c.title, c.authors].reduce((acc, field) => {
        const g = trigrams(field || '');
        if (!g.size) return acc;
        let shared = 0;
        for (const t of queryGrams) if (g.has(t)) shared++;
        return Math.max(acc, (2 * shared) / (queryGrams.size + g.size));
      }, 0);
      return { work_id: c.work_id, score: best };
    })
    // Below this the "match" is noise rather than a typo.
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) =>
    decorateResult(getWork(s.work_id), `FUZZY ${(s.score * 100).toFixed(0)}%`)
  );
}

function decorateResult(work, reason) {
  if (!work) return null;
  work.rankReason = reason;
  work.editionCount = get(
    'SELECT COUNT(*) AS n FROM editions WHERE work_id = ?',
    work.id
  ).n;
  work.cover = coverForWork(work.id);
  return work;
}

// §12: series-order awareness. Correct ordering is a data problem, and
// getting it wrong is one of the four structural failures in §00.
export function getSeries(seriesId) {
  const series = get('SELECT * FROM series WHERE id = ?', Number(seriesId));
  if (!series) return null;
  series.works = all(
    `SELECT w.id, sw.position FROM series_works sw
     JOIN works w ON w.id = sw.work_id
     WHERE sw.series_id = ? ORDER BY sw.position`,
    Number(seriesId)
  ).map((r) => ({ ...getWork(r.id), position: r.position }));
  return series;
}

// A person's catalog — the reason jacket designers are entities at all.
export function getPerson(id) {
  const person = get('SELECT * FROM people WHERE id = ?', Number(id));
  if (!person) return null;

  person.written = all(
    `SELECT DISTINCT w.id FROM work_people wp
     JOIN works w ON w.id = wp.work_id
     WHERE wp.person_id = ? AND wp.role = 'AUTHOR'`,
    person.id
  ).map((r) => getWork(r.id));

  person.credits = all(
    `SELECT ec.role, e.id AS edition_id, e.work_id, e.publisher, e.published_year, e.cover_url
     FROM edition_credits ec
     JOIN editions e ON e.id = ec.edition_id
     WHERE ec.person_id = ? ORDER BY e.published_year DESC`,
    person.id
  ).map((c) => ({ ...c, work: getWork(c.work_id) }));

  return person;
}

export function createWork({ title, subtitle, year, authors = [], firstLines, firstLinesSource, description, olKey }) {
  return tx(() => {
    const { lastInsertRowid } = run(
      `INSERT INTO works (title, subtitle, first_published_year, description, first_lines, first_lines_source, ol_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      title,
      subtitle || null,
      year || null,
      description || null,
      firstLines || null,
      firstLinesSource || null,
      olKey || null
    );
    const workId = Number(lastInsertRowid);

    authors.forEach((name, i) => {
      const person = upsertPerson(name);
      run(
        'INSERT OR IGNORE INTO work_people (work_id, person_id, role, ord) VALUES (?, ?, ?, ?)',
        workId,
        person.id,
        'AUTHOR',
        i
      );
    });

    reindexWork(workId);
    return workId;
  });
}

export function upsertPerson(name, olKey = null) {
  const clean = String(name).trim();
  const existing = get('SELECT * FROM people WHERE name = ?', clean);
  if (existing) return existing;
  const { lastInsertRowid } = run(
    'INSERT INTO people (name, sort_name, ol_key) VALUES (?, ?, ?)',
    clean,
    clean.split(' ').slice(-1)[0],
    olKey
  );
  return get('SELECT * FROM people WHERE id = ?', Number(lastInsertRowid));
}

export function addEdition(workId, e) {
  const isbn13 = normalizeISBN(e.isbn13 || e.isbn10);
  const { lastInsertRowid } = run(
    `INSERT INTO editions (work_id, isbn13, isbn10, publisher, published_year, page_count, format, binding_note, cover_url, paper_bulk, ol_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Number(workId),
    isbn13,
    e.isbn10 || null,
    e.publisher || null,
    e.published_year || null,
    e.page_count || null,
    e.format || 'PAPERBACK',
    e.binding_note || null,
    e.cover_url || null,
    e.paper_bulk ?? 0.1,
    e.ol_key || null
  );
  const editionId = Number(lastInsertRowid);

  if (e.colophon) {
    const c = e.colophon;
    run(
      `INSERT INTO colophons (edition_id, set_in, paper, printer, number_line, print_run, first_printing)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      editionId,
      c.set_in || null,
      c.paper || null,
      c.printer || null,
      c.number_line || null,
      c.print_run || null,
      c.first_printing || null
    );
    for (const [role, name] of Object.entries(c.credits || {})) {
      if (!name) continue;
      const person = upsertPerson(name);
      run(
        'INSERT OR IGNORE INTO edition_credits (edition_id, person_id, role) VALUES (?, ?, ?)',
        editionId,
        person.id,
        role
      );
    }
  }

  reindexWork(workId);
  return editionId;
}

/**
 * Correct a work's first-published year.
 *
 * Open Library's work-level year is dirty in a way that is not detectable
 * automatically: it reports whatever edition record happens to be earliest,
 * which for a classic is an early printing and for a bad record is nonsense.
 * This library holds Lolita at 1777, The Jungle at 1791 and The Secret
 * History at 1623, all with nothing but modern editions attached.
 *
 * No heuristic separates those from The Prince at 1515, which is right. So
 * the reader corrects it, and the desk's year filters get better one book
 * at a time instead of being quietly wrong forever.
 */
export function setFirstPublished(workId, year) {
  const w = get('SELECT id FROM works WHERE id = ?', Number(workId));
  if (!w) throw new Error('NO SUCH WORK.');

  if (year === '' || year == null) {
    run("UPDATE works SET first_published_year = NULL, updated_at = datetime('now') WHERE id = ?", w.id);
    return null;
  }

  const n = Number(year);
  // Negative years are BCE and entirely legitimate in a library that holds
  // Aeschylus. The upper bound is next year, for books announced ahead.
  const max = new Date().getFullYear() + 1;
  if (!Number.isInteger(n) || n < -3000 || n > max) throw new Error('THAT IS NOT A YEAR.');

  run("UPDATE works SET first_published_year = ?, updated_at = datetime('now') WHERE id = ?", n, w.id);
  return n;
}
