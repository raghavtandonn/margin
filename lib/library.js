import { seal, privateText } from './crypto.js';
import { all, get, run, tx } from '../db/index.js';
import { setNote, noteOf } from './notes.js';
import { clampStars } from './stars.js';
import { visibleReadingSQL } from './visibility.js';
import { stampRotation, spineWidth, spineHeight, paceStrip, trimAspect, daysSince } from './artifacts.js';

const today = () => new Date().toISOString().slice(0, 10);

export function getUser(handleOrId) {
  const col = typeof handleOrId === 'number' ? 'id' : 'handle';
  const u = get(`SELECT * FROM users WHERE ${col} = ?`, handleOrId);
  if (u) u.settings = JSON.parse(u.settings || '{}');
  return u;
}

export function updateSettings(userId, patch) {
  const u = getUser(Number(userId));
  const next = { ...u.settings, ...patch };
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(next), Number(userId));
  return next;
}

// ── Shelves (§09.2) ──────────────────────────────────────
export function getShelves(userId) {
  return all(
    `SELECT s.*, COUNT(si.id) AS item_count
     FROM shelves s LEFT JOIN shelf_items si ON si.shelf_id = s.id
     WHERE s.user_id = ? GROUP BY s.id ORDER BY s.is_system DESC, s.name`,
    Number(userId)
  );
}

/**
 * A shelf's slug.
 *
 * The old rule was `[^a-z0-9]+ -> -`, applied to the raw name. That threw
 * away every accent ("Café/Bar" became "caf-bar") and, for a name with no
 * ASCII letters at all, produced the EMPTY STRING — which the route then
 * redirected to as `/shelf/`, a 404. The shelf had actually been created;
 * the reader just landed on a dead page and concluded it had not been.
 *
 * So: decompose accents to their base letters first, and if nothing usable
 * survives, fall back to a name that is at least a URL.
 */
export function shelfSlug(name, { taken = [] } = {}) {
  const base = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // café -> cafe
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // A name of pure punctuation or emoji leaves nothing. It is still a name
  // somebody chose, so it gets a shelf; it just cannot BE the address.
  let slug = base || 'shelf';

  if (!taken.includes(slug)) return slug;
  for (let n = 2; n < 500; n++) {
    if (!taken.includes(`${slug}-${n}`)) return `${slug}-${n}`;
  }
  return `${slug}-${Date.now()}`;
}

/**
 * Make a shelf.
 *
 * Returns a result rather than throwing, because the only caller is a form
 * and every failure here is something the reader needs told: the name was
 * blank, or they already have that shelf.
 */
export function createShelf(userId, name) {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) return { ok: false, error: 'Give the shelf a name.' };

  const existingByName = get(
    'SELECT * FROM shelves WHERE user_id = ? AND lower(name) = lower(?)',
    Number(userId), clean
  );
  if (existingByName) {
    return { ok: false, error: `You already have a shelf called ${existingByName.name}.`,
             shelf: existingByName };
  }

  const taken = all('SELECT slug FROM shelves WHERE user_id = ?', Number(userId)).map((r) => r.slug);
  const slug = shelfSlug(clean, { taken });

  const id = run(
    'INSERT INTO shelves (user_id, name, slug) VALUES (?, ?, ?)',
    Number(userId), clean, slug
  ).lastInsertRowid;

  return { ok: true, shelf: get('SELECT * FROM shelves WHERE id = ?', id) };
}

export function renameShelf(userId, slug, name) {
  const shelf = getShelf(userId, slug);
  if (!shelf) return { ok: false, error: 'No such shelf.' };
  if (shelf.is_system) return { ok: false, error: 'That shelf is part of the system.' };

  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) return { ok: false, error: 'Give the shelf a name.' };

  run('UPDATE shelves SET name = ? WHERE id = ?', clean, shelf.id);
  return { ok: true, shelf: get('SELECT * FROM shelves WHERE id = ?', shelf.id) };
}

export function deleteShelf(userId, slug) {
  const shelf = getShelf(userId, slug);
  if (!shelf) return { ok: false, error: 'No such shelf.' };
  // §4 — the system shelves are what status means. Removing one would leave
  // finished books with nowhere to be.
  if (shelf.is_system) return { ok: false, error: 'That shelf is part of the system.' };

  run('DELETE FROM shelf_items WHERE shelf_id = ?', shelf.id);
  run('DELETE FROM shelves WHERE id = ?', shelf.id);
  return { ok: true };
}

export function getShelf(userId, slug) {
  return get('SELECT * FROM shelves WHERE user_id = ? AND slug = ?', Number(userId), slug);
}

const SORTS = {
  ADDED: 'si.added_at DESC',
  TITLE: 'w.title COLLATE NOCASE',
  AUTHOR: 'author_sort COLLATE NOCASE',
  RATING: 'r.stars DESC NULLS LAST',
  FINISHED: 'r.finished_at DESC',
  PAGES: 'e.page_count DESC',
  // A joke about interior decorators who buy books by the yard. Also
  // occasionally useful, and it took twenty minutes to build (§09.2).
  'SPINE HEIGHT': "CASE e.format WHEN 'HARDCOVER' THEN 3 WHEN 'PAPERBACK' THEN 2 ELSE 1 END DESC, e.page_count DESC"
};

export const SORT_KEYS = Object.keys(SORTS);

export function getShelfItems(userId, shelfId, sort = 'HUE') {
  const orderBy = SORTS[sort] || 'si.added_at DESC';

  const rows = all(
    `SELECT
       si.id AS item_id, si.added_at, si.work_id,
       w.title, w.first_published_year,
       e.id AS edition_id, e.page_count, e.format, e.publisher, e.isbn13, e.cover_url, e.paper_bulk,
       e.cover_cache_key, e.spine_color,
       (SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = si.work_id AND wp.role = 'AUTHOR' ORDER BY wp.ord LIMIT 1) AS author_sort,
       r.stars,
       r.status, r.current_page, r.total_positions, r.position_type,
       r.finished_at, r.abandoned_page, r.due_date
     FROM shelf_items si
     JOIN works w ON w.id = si.work_id
     -- The shelf item's own edition when it has one; otherwise the work's
     -- best edition, preferring one that actually carries a cover. An import
     -- shelves a work before its editions are resolved, so without this
     -- fallback every frame on the contact sheet renders as a blank galley.
     LEFT JOIN editions e ON e.id = COALESCE(si.edition_id, (
       SELECT e2.id FROM editions e2 WHERE e2.work_id = si.work_id
       -- cover_cache_key, not cover_url: the cache key is what actually
       -- renders, and an edition can hold one while its url is null.
       ORDER BY (e2.cover_cache_key IS NULL), (e2.page_count IS NULL), e2.published_year DESC
       LIMIT 1
     ))
     LEFT JOIN readings r ON r.id = (
       SELECT r3.id FROM readings r3
       WHERE r3.work_id = si.work_id AND r3.user_id = ?
       ORDER BY r3.pass_number DESC LIMIT 1
     )
     WHERE si.shelf_id = ?
     ORDER BY ${orderBy}`,
    Number(userId),
    Number(shelfId)
  );

  const items = rows.map(decorateItem);

  return items;
}

function decorateItem(row) {
  return {
    ...row,
    authorLine: authorNames(row.work_id),
    stampRotation: stampRotation(row.isbn13 || row.work_id),
    spineWidth: spineWidth(row.page_count, row.paper_bulk),
    spineHeight: spineHeight(row.format),
    // A2 — covers are never cropped; the frame takes the edition's true trim.
    trimAspect: trimAspect(row.format)
  };
}

function authorNames(workId) {
  return all(
    `SELECT p.name FROM work_people wp JOIN people p ON p.id = wp.person_id
     WHERE wp.work_id = ? AND wp.role = 'AUTHOR' ORDER BY wp.ord`,
    Number(workId)
  ).map((r) => r.name).join(', ');
}

// The four shelves the product moves books between on its own. They are
// seeded at signup, but an account that predates a shelf — `abandoned` was
// added after some accounts existed — would otherwise throw the first time
// it was moved there, which since the press page grew an ABANDONED button
// is one click from the daily screen.
const SYSTEM_SHELVES = ['reading', 'finished', 'abandoned', 'waiting'];

function ensureShelf(userId, slug) {
  const shelf = getShelf(userId, slug);
  if (shelf) return shelf;
  if (!SYSTEM_SHELVES.includes(slug)) return null;
  run(
    'INSERT INTO shelves (user_id, name, slug, is_system) VALUES (?, ?, ?, 1)',
    Number(userId), slug.toUpperCase(), slug
  );
  return getShelf(userId, slug);
}

export function addToShelf(userId, shelfSlug, workId, editionId = null) {
  const shelf = ensureShelf(userId, shelfSlug);
  if (!shelf) throw new Error(`NO SHELF "${shelfSlug}"`);
  run(
    `INSERT INTO shelf_items (shelf_id, work_id, edition_id) VALUES (?, ?, ?)
     ON CONFLICT (shelf_id, work_id) DO UPDATE SET edition_id = COALESCE(excluded.edition_id, shelf_items.edition_id)`,
    shelf.id,
    Number(workId),
    editionId ? Number(editionId) : null
  );
  return shelf;
}

export function removeFromShelf(userId, shelfSlug, workId) {
  const shelf = getShelf(userId, shelfSlug);
  if (!shelf) return;
  run('DELETE FROM shelf_items WHERE shelf_id = ? AND work_id = ?', shelf.id, Number(workId));
}

// ── Reading (§09.3) ──────────────────────────────────────
// The current pass: the highest pass_number for this work.
export function getReading(userId, workId) {
  const r = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId),
    Number(workId)
  );
  return r ? decorateReading(r) : null;
}

export function getReadingById(id) {
  const r = get('SELECT * FROM readings WHERE id = ?', Number(id));
  return r ? decorateReading(r) : null;
}

// "PRESSINGS" — every pass, with its own dates, pace, and its own rating.
// A re-read gets its own stars and the earlier one survives (§2).
export function getPassages(userId, workId) {
  return all(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ? ORDER BY pass_number`,
    Number(userId),
    Number(workId)
  ).map(decorateReading);
}

// §2 — the rating lives on the pass, so a re-read gets its own.
export function rate(userId, workId, stars, { review, readingId } = {}) {
  const r = readingId
    ? get('SELECT id FROM readings WHERE id = ? AND user_id = ?', Number(readingId), Number(userId))
    : get(
        `SELECT id FROM readings WHERE user_id = ? AND work_id = ?
         ORDER BY pass_number DESC LIMIT 1`,
        Number(userId), Number(workId)
      );
  if (!r) return null;

  const parts = [];
  const vals = [];
  if (stars !== undefined) { parts.push('stars = ?'); vals.push(clampStars(stars)); }
  if (review !== undefined) { parts.push('review = ?'); vals.push(review || null); }
  if (!parts.length) return getReadingById(r.id);

  run(`UPDATE readings SET ${parts.join(', ')} WHERE id = ?`, ...vals, r.id);
  return getReadingById(r.id);
}

export function setPrivateNote(userId, workId, text) {
  const r = get(
    `SELECT id FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId), Number(workId)
  );
  if (!r) return null;
  // §11 — the note is encrypted at the application layer. Writing to
  // `private_note` directly would put a reader's private writing in plaintext
  // in every database backup from here on.
  setNote(r.id, text);
  return getReadingById(r.id);
}

// B4 — STALLED is automatic and neutral after 21 days without a session.
// A stalled book is a fact about a shelf, not a failure requiring
// intervention. It never sends a notification.
const STALL_DAYS = 21;

/**
 * How long the book is.
 *
 * The reader's own edition first, because that is the object in their hands.
 * Failing that, the LARGEST page count across the work's other editions —
 * the same sibling-edition fallback the covers already use, and largest
 * rather than smallest so a translation running long is never clamped
 * against a shorter printing. It is a ceiling, not a measurement.
 *
 * Without this a reading whose edition happens to omit a page count has no
 * total at all: no percent, no mark on the rule, and no way to tell P.3000
 * from a real position.
 */
/**
 * The absurdity ceiling.
 *
 * Only reached when NOTHING knows how long the book is: no stated extent on
 * the reading, no page count on any edition of the work. It is not a guess
 * at how long books are, it is the point past which a number is certainly a
 * typo. Proust entire is about 4,200 pages; the longest single bound object
 * anyone reads is well under this.
 */
export const MAX_POSITION = 20000;

export function pageCountFor(workId, editionId, { stated = null } = {}) {
  if (stated) return stated;

  if (editionId) {
    const own = get('SELECT page_count FROM editions WHERE id = ?', Number(editionId));
    if (own?.page_count) return own.page_count;
  }

  const sibling = get(
    'SELECT MAX(page_count) AS n FROM editions WHERE work_id = ? AND page_count IS NOT NULL',
    Number(workId)
  );
  return sibling?.n || null;
}

function decorateReading(r) {
  // §11 — one place decrypts, so every screen that shows a note reads the
  // same decrypted field and no screen has to remember to.
  r = { ...r, private_note: noteOf(r), note_encrypted: undefined };
  const edition = r.edition_id ? get('SELECT * FROM editions WHERE id = ?', r.edition_id) : null;
  const sessions = all(
    'SELECT position, position_type, occurred_at, note FROM sessions WHERE reading_id = ? ORDER BY occurred_at',
    r.id
  ).map(s => ({ ...s, note: privateText(s.note) }));

  const total = pageCountFor(r.work_id, r.edition_id, { stated: r.total_positions });

  // The write path clamps, but rows logged before it did still hold values
  // past the end of the book — P.3000 on a 559-page novel. Clamping on read
  // as well means nothing is ever DISPLAYED that cannot be true, and the
  // stored value repairs itself the next time the reader logs a page.
  const page = total && r.current_page > total ? total : r.current_page;
  const last = sessions.length ? sessions[sessions.length - 1].occurred_at : null;
  const sinceLog = last != null ? daysSince(last) : null;
  const stalled = r.status === 'READING' && sinceLog != null && sinceLog >= STALL_DAYS;

  return {
    ...r,
    edition,
    sessions,
    cover_url: edition?.cover_url || null,
    cover_cache_key: edition?.cover_cache_key || null,
    trimAspect: trimAspect(edition?.format),
    pageCount: total,
    totalPositions: total,
    // §09.3: position is a page number. Percentage is derived and shown small.
    current_page: page,
    percent: total ? Math.min(100, Math.round((page / total) * 100)) : null,
    pace: paceStrip(
      sessions.map((s) => ({ page: s.position, at: s.occurred_at })),
      { startedAt: r.started_at, endAt: r.finished_at || r.abandoned_at }
    ),
    // The full span, so the strip can say what it is not showing.
    daysHeld: r.started_at
      ? Math.max(
          1,
          Math.round(
            (new Date(String(r.finished_at || r.abandoned_at || new Date().toISOString()).slice(0, 10)) -
              new Date(String(r.started_at).slice(0, 10))) / 86400000
          )
        )
      : null,
    // B7 — an imported reading with no sessions renders a labeled flat band,
    // not an error. That is honest and it is not broken.
    hasSessionData: sessions.length > 1,
    lastLoggedAt: last,
    daysSinceLog: sinceLog,
    stalled,
    displayStatus: stalled ? 'STALLED' : r.status,
    stampRotation: stampRotation(edition?.isbn13 || r.work_id),
    dueSoon: r.due_date ? daysUntil(r.due_date) <= 3 && daysUntil(r.due_date) >= 0 : false,
    daysUntilDue: r.due_date ? daysUntil(r.due_date) : null,
    // It cannot be extended more than twice, at which point the interface
    // suggests abandoning — without judgment (§09.3).
    canExtend: r.due_extensions < 2
  };
}

function daysUntil(date) {
  return Math.round((new Date(date) - new Date(today())) / 86400000);
}

// B4 — sorted by most recently logged, which is the order a reader thinks in.
// STALLED passes are included: a stalled book is still on the press.
export function getCurrentlyReading(userId) {
  return all(
    `SELECT r.*,
            (SELECT MAX(s.occurred_at) FROM sessions s WHERE s.reading_id = r.id) AS last_logged
     FROM readings r
     WHERE r.user_id = ? AND r.status IN ('READING', 'STALLED')
     ORDER BY COALESCE(last_logged, r.started_at, r.created_at) DESC`,
    Number(userId)
  ).map((r) => {
    const d = decorateReading(r);
    const w = get('SELECT title FROM works WHERE id = ?', r.work_id);
    // The reading's own edition is usually null on an imported pass, so fall
    // back to the work's best jacket rather than showing a galley plate for a
    // book we plainly have a cover for.
    const e = get(
      `SELECT cover_url, cover_cache_key, format FROM editions
       WHERE work_id = ?
       ORDER BY (id != COALESCE(?, -1)), (cover_cache_key IS NULL), (cover_url IS NULL), (page_count IS NULL), published_year DESC
       LIMIT 1`,
      r.work_id, r.edition_id
    );
    return {
      ...d,
      title: w?.title,
      authorLine: authorNames(r.work_id),
      cover_url: e?.cover_url || null,
      cover_cache_key: e?.cover_cache_key || null,
      trimAspect: trimAspect(e?.format)
    };
  });
}

// B5 — starting a book that already has a closed pass creates a NEW pass.
// The prior pass is untouched: its dates, sessions, pace, notes, and
// print all survive intact. This is the case Goodreads has never handled.
/**
 * Throw a pass away.
 *
 * A second pass started to see what the feature did has no way out: it
 * cannot be finished (it was never read), abandoning it records a decision
 * nobody made, and it sits on the reading page forever. Reading is the one
 * place in this product where an experiment is expensive, and it should not
 * be.
 *
 * Destructive on purpose and narrow on purpose: it removes ONE pass and the
 * sessions logged against it, never the work, never the other passes, never
 * anything on a shelf. The last remaining pass of a book that was actually
 * finished is not discardable — that is history, and losing it to a
 * mis-click is not a trade worth making.
 */
export function discardPass(userId, workId, passNumber = null) {
  const passes = all(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ? ORDER BY pass_number`,
    Number(userId), Number(workId)
  );
  if (!passes.length) return { ok: false, error: 'Nothing to discard.' };

  const pass = passNumber != null
    ? passes.find((p) => p.pass_number === Number(passNumber))
    : passes[passes.length - 1];
  if (!pass) return { ok: false, error: 'No such pass.' };

  if (passes.length === 1 && pass.status === 'FINISHED') {
    return {
      ok: false,
      error: 'That is the only record of having read it. Nothing else here can bring it back.'
    };
  }

  return tx(() => {
    run('DELETE FROM sessions WHERE reading_id = ?', pass.id);
    run('DELETE FROM readings WHERE id = ?', pass.id);

    // A discarded pass leaves the book on READING with nothing reading it.
    const left = all(
      `SELECT status FROM readings WHERE user_id = ? AND work_id = ?`,
      Number(userId), Number(workId)
    );
    if (!left.some((r) => r.status === 'READING')) {
      removeFromShelf(userId, 'reading', workId);
    }

    // And it has to land somewhere. Discarding the last pass used to take
    // the book off READING and put it on nothing at all: it left the
    // library entirely while still sitting in the catalogue, which is how a
    // book can be discarded and then be nowhere to be found.
    //
    // Nothing left means the reading never happened, so the book goes back
    // to WAITING — unread, still owned, still to be read. If a FINISHED or
    // ABANDONED pass survives, those shelves are already correct and are
    // left alone: a book you finished is not one you are waiting to read.
    if (!left.length) addToShelf(userId, 'waiting', workId);

    return { ok: true, remaining: left.length };
  });
}

export function startReading(userId, workId, editionId = null, opts = {}) {
  const current = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId),
    Number(workId)
  );

  const edition = editionId
    ? get('SELECT page_count FROM editions WHERE id = ?', Number(editionId))
    : null;

  // An open pass is resumed rather than duplicated.
  if (current && (current.status === 'READING' || current.status === 'WAITING')) {
    run(
      `UPDATE readings SET status = 'READING',
         edition_id = COALESCE(?, edition_id),
         total_positions = COALESCE(total_positions, ?),
         started_at = COALESCE(started_at, datetime('now'))
       WHERE id = ?`,
      editionId ? Number(editionId) : null,
      edition?.page_count ?? null,
      current.id
    );
    addToShelf(userId, 'reading', workId, editionId);
    return getReading(userId, workId);
  }

  const passNumber = (current?.pass_number ?? 0) + 1;
  run(
    `INSERT INTO readings
       (user_id, work_id, edition_id, status, pass_number, format, position_type,
        total_positions, started_at)
     VALUES (?, ?, ?, 'READING', ?, ?, ?, ?, datetime('now'))`,
    Number(userId),
    Number(workId),
    editionId ? Number(editionId) : null,
    passNumber,
    opts.format || 'print',
    opts.positionType || 'page',
    opts.totalPositions ?? edition?.page_count ?? null
  );

  addToShelf(userId, 'reading', workId, editionId);
  removeFromShelf(userId, 'waiting', workId);
  return getReading(userId, workId);
}

// ── B3 "THE IMPRESSION COUNTER" ──────────────────────────
// position is cumulative. Logging a position LOWER than the previous one is
// permitted without warning — people re-read chapters and abandon backward.
/**
 * How long THIS reader's copy is.
 *
 * Stored on the reading rather than on the edition, because it is a fact
 * about the object in their hands: a large-print copy and a mass-market one
 * of the same work are different lengths and both are correct.
 *
 * Setting it below the current position pulls the position down with it.
 * Leaving a book recorded as being on page 400 of 300 is exactly the state
 * this whole function exists to prevent.
 */
export function setExtent(userId, workId, total) {
  const r = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId), Number(workId)
  );
  if (!r) throw new Error('NO OPEN PASS.');

  // Empty clears it, and the catalogue's own page count takes over again.
  if (total === '' || total == null) {
    run('UPDATE readings SET total_positions = NULL WHERE id = ?', r.id);
    return getReading(userId, workId);
  }

  const n = Number(total);
  if (!Number.isInteger(n) || n < 1 || n > MAX_POSITION) {
    throw new Error('THAT IS NOT A LENGTH.');
  }

  return tx(() => {
    run('UPDATE readings SET total_positions = ? WHERE id = ?', n, r.id);
    if (r.current_page > n) {
      run('UPDATE readings SET current_page = ? WHERE id = ?', n, r.id);
    }
    return getReading(userId, workId);
  });
}

export function logSession(userId, workId, position, opts = {}) {
  const r = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId),
    Number(workId)
  );
  if (!r) throw new Error('NO OPEN PASS.');

  let pos = Number(position);
  if (!Number.isFinite(pos) || pos < 0) throw new Error('POSITION MUST BE A NUMBER.');

  // A page number cannot exceed the book. Without this a typo — 3000 for
  // 300 — is stored verbatim and then shown forever as "P.3000 · 100%" on a
  // 559-page novel, which reads as a broken product rather than a slip.
  // Clamped rather than rejected: the intent is obvious and refusing the
  // save would lose it.
  const type = opts.positionType || r.position_type;
  const known = type === 'percent' ? 100
    : type === 'page' ? pageCountFor(r.work_id, r.edition_id, { stated: r.total_positions })
    : null;

  // Clamp to the book where the book's length is known, and to the
  // absurdity ceiling where it is not. The second half matters more than it
  // looks: most of an imported library has no page count on any edition, so
  // without it there was effectively no bound at all and page 800 of a
  // 300-page novel saved happily.
  const ceiling = known || MAX_POSITION;
  pos = Math.min(pos, ceiling);

  return tx(() => {
    if (opts.clientRequestId) {
      const prior = get(`SELECT s.client_request_hash FROM sessions s
        JOIN readings r ON r.id = s.reading_id
        WHERE s.client_request_id = ? AND r.user_id = ? AND r.work_id = ?`,
      opts.clientRequestId, Number(userId), Number(workId));
      if (prior) {
        if (prior.client_request_hash !== opts.clientRequestHash) throw new Error('UPDATE ID ALREADY USED.');
        return getReading(userId, workId);
      }
    }
    run(
      `INSERT INTO sessions (reading_id, position, position_type, occurred_at, duration_minutes, note, source,
                             client_request_id, client_request_hash)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?)`,
      r.id,
      pos,
      type,
      opts.occurredAt || null,
      opts.durationMinutes ?? null,
      seal(opts.note || null),
      opts.source || 'manual',
      opts.clientRequestId || null,
      opts.clientRequestHash || null
    );

    // A stalled pass returns to READING the moment it is logged again.
    run(
      `UPDATE readings SET current_page = ?, status = CASE WHEN status = 'STALLED' THEN 'READING' ELSE status END
       WHERE id = ?`,
      pos,
      r.id
    );
    return getReading(userId, workId);
  });
}

export function finishReading(userId, workId, opts = {}) {
  const r = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId), Number(workId)
  );
  if (!r) throw new Error('NO OPEN PASS.');

  run(
    `UPDATE readings SET status = 'FINISHED',
       finished_at = COALESCE(?, datetime('now')),
       current_page = COALESCE(total_positions, current_page)
     WHERE id = ?`,
    opts.endedAt || null,
    r.id
  );
  addToShelf(userId, 'finished', workId);
  removeFromShelf(userId, 'reading', workId);
  return getReading(userId, workId);
}

// §08 / B5: abandoning is a first-class action with a real label. It captures
// the page you stopped at, because a book abandoned at page 12 and one
// abandoned at page 340 are entirely different events and no product records
// the difference. No confirmation dialog.
export function abandonReading(userId, workId, atPage) {
  const r = get(
    `SELECT * FROM readings WHERE user_id = ? AND work_id = ?
     ORDER BY pass_number DESC LIMIT 1`,
    Number(userId), Number(workId)
  );
  if (!r) throw new Error('NO OPEN PASS.');

  const at = atPage === '' || atPage == null ? r.current_page : Number(atPage);
  run(
    `UPDATE readings SET status = 'ABANDONED', abandoned_at = datetime('now'),
       abandoned_page = ?, current_page = ?
     WHERE id = ?`,
    at, at, r.id
  );
  addToShelf(userId, 'abandoned', workId);
  removeFromShelf(userId, 'reading', workId);
  return getReading(userId, workId);
}

export function setDue(userId, workId, date) {
  const r = get('SELECT * FROM readings WHERE user_id = ? AND work_id = ?', Number(userId), Number(workId));
  if (!r) throw new Error('NOT READING');
  const isExtension = r.due_date && date > r.due_date;
  if (isExtension && r.due_extensions >= 2) {
    return { ...decorateReading(r), refused: 'EXTENDED TWICE. CONSIDER ABANDONING.' };
  }
  run(
    `UPDATE readings SET due_date = ?, due_extensions = due_extensions + ?, due_notified = 0 WHERE id = ?`,
    date,
    isExtension ? 1 : 0,
    r.id
  );
  return getReading(userId, workId);
}

// ── "THE RECEIPT" (§08) ──────────────────────────────────
// A monospace till receipt. Line items are books with dates, page counts,
// and channel values. Totals at the bottom.
export function getReceipt(userId, { year, viewer = null } = {}) {
  const y = year || new Date().getFullYear();
  const scope = viewer ? visibleReadingSQL(viewer, { owner: 'u', entry: 'r' }) : null;

  const lines = all(
    `SELECT w.title, r.finished_at, r.abandoned_at, r.status, r.abandoned_page,
            r.pass_number, r.total_positions, r.stars, e.page_count, r.work_id
     FROM readings r
     JOIN users u ON u.id = r.user_id
     JOIN works w ON w.id = r.work_id
     LEFT JOIN editions e ON e.id = r.edition_id
     WHERE r.user_id = ?
       AND (strftime('%Y', r.finished_at) = ? OR strftime('%Y', r.abandoned_at) = ?)
       ${scope ? `AND r.is_draft = 0 AND ${scope.sql}` : ''}
     ORDER BY COALESCE(r.finished_at, r.abandoned_at)`,
    Number(userId),
    String(y),
    String(y), ...(scope?.params || [])
  ).map((l) => ({
    ...l,
    authorLine: authorNames(l.work_id),
    // A finished book counts its full page count; an abandoned one counts
    // only the pages actually read. No inflation.
    pagesRead: l.status === 'ABANDONED'
      ? l.abandoned_page || 0
      : l.total_positions || l.page_count || 0
  }));

  const finished = lines.filter((l) => l.status === 'FINISHED');
  const abandoned = lines.filter((l) => l.status === 'ABANDONED');
  const rated = lines.filter((l) => l.stars != null);

  return {
    year: y,
    lines,
    totals: {
      finished: finished.length,
      abandoned: abandoned.length,
      pages: lines.reduce((s, l) => s + l.pagesRead, 0),
      rated: rated.length,
      // §1.5 — a zero average is not a number worth printing.
      meanStars: rated.length
        ? rated.reduce((s, l) => s + l.stars, 0) / rated.length
        : null
    }
  };
}

// ── Export (§12) ─────────────────────────────────────────
// One click, open format, including ratings, notes, dates, and
// abandonment records. Your reading life is not a hostage.
export function exportAll(userId) {
  const u = getUser(Number(userId));
  return {
    format: 'margin-export/v1',
    exported_at: new Date().toISOString(),
    user: { handle: u.handle, display_name: u.display_name },
    shelves: getShelves(u.id).map((s) => ({
      name: s.name,
      slug: s.slug,
      items: all(
        `SELECT w.title, si.added_at, e.isbn13
         FROM shelf_items si JOIN works w ON w.id = si.work_id
         LEFT JOIN editions e ON e.id = si.edition_id WHERE si.shelf_id = ?`,
        s.id
      )
    })),
    readings: all(
      `SELECT w.title, e.isbn13, r.id AS reading_id, r.status, r.pass_number,
              r.format, r.position_type, r.current_page, r.total_positions,
              r.stars, r.review, r.note_encrypted, r.private_note,
              r.started_at, r.finished_at, r.abandoned_at, r.abandoned_page, r.due_date
       FROM readings r JOIN works w ON w.id = r.work_id
       LEFT JOIN editions e ON e.id = r.edition_id WHERE r.user_id = ?
       ORDER BY w.title, r.pass_number`,
      u.id
    ).map((r) => {
      // Decrypted once, here, on the way out to the owner's own export.
      const { note_encrypted, private_note, ...rest } = r;
      return { ...rest, private_note: noteOf({ id: r.reading_id, note_encrypted, private_note }) };
    }),
    sessions: all(
      `SELECT s.reading_id, s.position, s.position_type, s.occurred_at,
              s.duration_minutes, s.note, s.source
       FROM sessions s JOIN readings r ON r.id = s.reading_id
       WHERE r.user_id = ? ORDER BY s.occurred_at`,
      u.id
    ).map(s => ({ ...s, note: privateText(s.note) })),

  };
}

export function exportCSV(userId) {
  const data = exportAll(userId);
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const header =
    'title,isbn13,pass,status,stars,' +
    'started_at,finished_at,abandoned_at,abandoned_position,review';

  // One row per pass, so a re-read exports separately rather than collapsing
  // into whichever pass happened to be found first.
  const rows = data.readings.map((r) =>
    [
      r.title, r.isbn13, r.pass_number, r.status, r.stars,
      r.started_at, r.finished_at, r.abandoned_at, r.abandoned_page, r.review
    ].map(esc).join(',')
  );

  return [header, ...rows].join('\n');
}
