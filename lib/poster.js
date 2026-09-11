import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, accessSync,
         existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ── §10 — THE POSTER ─────────────────────────────────────
//
// "Server-rendered PNG at 1080×1920 (stories) and 1080×1350 (feed).
// Contents: colour strip, given title, season code, and the note. Nothing
// else." The spec said the title was to be set in a serif; it is set in the
// grot the rest of MARGIN is set in, because a poster that does not look
// like the site it came from is someone else's poster.
//
// Rendered through headless Chromium against a page with NO network access
// and locally-installed fonts, so §15's "renders byte-identically across two
// machines with pinned fonts" is achievable: the only inputs are the HTML
// this file writes and the font files in public/fonts.
//
// Deliberately absent: a logo lockup bigger than the mono wordmark, a QR
// code, and a big number. §10 lists all three as things it is not.

export const SHAPES = {
  story: { w: 1080, h: 1920 },   // the vertical one, for a phone
  feed:  { w: 1080, h: 1350 },   // the portrait crop most feeds prefer
  // Square, because it is the one shape that survives being cropped by
  // something you do not control.
  square: { w: 1080, h: 1080 }
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// ── THE SHEET ────────────────────────────────────────────
//
// A strip, a title, a claim, and the marks that say whose it is. In that
// order, and nothing else on the sheet.
//
// The strip IS the picture now. It used to be a 22px rule above a grid of
// the jackets themselves, on the argument that "the books ARE the poster" —
// which was more information and a worse object. Nine covers at 300px is a
// contact sheet, and a contact sheet has no line of sight: the eye has
// nowhere to land, every jacket is someone else's art direction, and the
// title got whatever was left at the bottom. The colours are what remains
// when you stop showing the books and show the season. They are still
// sampled from those jackets, so nobody art-directed these either, and no
// two seasons come out alike.

/**
 * Type and margin, per trim.
 *
 * Every shape is 1080 wide, so these are absolute rather than relative: the
 * only thing that changes between a story and a square is how much height
 * the text block may spend before it starts crowding the strip.
 */
const SCALE = {
  story:  { pad: 88, title: 128, titleLong: 96, note: 42, meta: 22 },
  feed:   { pad: 76, title: 112, titleLong: 84, note: 38, meta: 21 },
  square: { pad: 64, title:  96, titleLong: 72, note: 34, meta: 20 }
};

// Solved against the ground rather than picked: the quiet inks are the ones
// that carry the metadata, and metadata nobody can read is decoration.
const GROUND = '#0E0D0F';
const BONE   = '#EDEAE3';   // the title, and the sentence that lands
const DIM    = '#8F897E';   // 5.60:1 — the sentences leading up to it
const QUIET  = '#807B72';   // 4.62:1 — the label and the foot

/**
 * The note, as the poster sets it.
 *
 * Sentences, not a line: the old poster took `firstSentence(note)` and set
 * it grey, which reduced every season to one statistic. A note is an
 * argument in three moves — what happened, what changed, what that means —
 * and the poster keeps the moves, quiet, so the last one can land in full
 * ink. That final sentence is the only thing on the sheet that is a claim.
 *
 * Split on sentence ends followed by a capital or a digit, so `4.33 stars`
 * and `S/S 26` stay whole: neither has a space after the mark.
 */
const SENTENCE_END = /(?<=[.!?])\s+(?=["'“]?[A-Z0-9])/;

export function noteLines(note, { max = 3, budget = 170 } = {}) {
  const out = [];
  let len = 0;
  for (const raw of String(note || '').trim().split(SENTENCE_END)) {
    const s = raw.trim();
    if (!s) continue;
    if (out.length >= max) break;
    // The budget is a height guard, not an editorial one — three long
    // sentences push the foot off the bottom of a square.
    if (out.length && len + s.length > budget) break;
    out.push(s);
    len += s.length + 1;
  }
  return out;
}

// A season with no given title is still allowed a title. The count, spelled
// out, is the one thing that is true of every season without anyone having
// written anything — and it beats repeating AUTUMN/WINTER 25 in 128px
// directly under the line that already says it.
const SPELLED = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
                 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
                 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen',
                 'Nineteen', 'Twenty'];

export const countTitle = (n) =>
  Number(n) === 1 ? 'One book' : `${SPELLED[n] ?? String(n)} books`;

/**
 * The poster as a standalone HTML document.
 *
 * Fonts are referenced by absolute file:// path rather than by a served URL,
 * because the renderer is given no network at all.
 */
export function posterHTML({ title, code, label, count = 0, note, firstLine,
                             strip, shape = 'story' }) {
  const { w, h } = SHAPES[shape] || SHAPES.story;
  const s = SCALE[shape] || SCALE.story;
  const grot = fontFor('Inter Tight');
  const mono = fontFor('Martian Mono');

  const head = String(title || '').trim() || countTitle(count);
  const lines = noteLines(note || firstLine);

  // AUTUMN/WINTER 25 → AUTUMN / WINTER 25. At .22em of tracking the slash
  // is already sitting in its own space; the spaces make it deliberate.
  const stamp = String(label || code || '').toUpperCase().replace(/\s*\/\s*/g, ' / ');

  // One band per book. A book with no colour is not given one: it is drawn
  // as the same hatch the page uses, because a poster that quietly fills in
  // the gaps is a poster that lies about what was read.
  //
  // Hairlines between every band, universally (amendment §7.7). Two grief
  // books in a row are two bands of #23262B, which without a rule between
  // them is one wide band and a miscount — and `Pitch, Oxidised` against
  // this plinth is 1.12:1, which is not a dark band but no band at all.
  //
  // Both shapes are accepted. Fifteen closed seasons still hold a stored
  // array of bare hexes, and the poster does not import the sampler it is
  // replacing just to normalise them — four lines here is the cheaper
  // coupling.
  const list = (strip && strip.length ? strip : [{ hex: '#2A2622', source: 'provisional' }])
    .map((b) => (typeof b === 'string'
      ? { hex: b, name: null, source: 'provisional' }
      : { hex: b?.hex ?? null, name: b?.name ?? null, source: b?.source || 'derived' }));
  const bands = list.map((b) => {
    if (!b.hex) return `<i class="empty"></i>`;
    const cls = b.source === 'provisional' ? ' class="prov"' : '';
    return `<i${cls} style="background:${esc(b.hex)}"></i>`;
  }).join('');

  // §04 — the plinth carries the swatch names, and §05 requires the emotion
  // word beside every swatch in every view. This is that, for the poster:
  // the words in reading order, so the strip above is legible as meaning
  // rather than as decoration.
  //
  // The BLEND's own name, not its nearest anchor's emotion.
  //
  // Naming by anchor collapsed the plinth: S/S 25's three derived colours
  // are all in the violet-slate range, so all three rounded to Disorientation
  // and a four-band poster carried one word. The generated names are
  // distinct because the blends are — Smoke Violet, Washed is not Harbour
  // Grey, Distant — and they are what the lookbook prints beside each book.
  const words = [...new Set(list.map((b) => b.name).filter(Boolean))];

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${grot ? `@font-face { font-family: "Poster Grot"; src: url("file://${join(FONT_DIR, grot)}") format("woff2"); font-weight: 100 900; font-display: block; }` : ''}
  ${mono ? `@font-face { font-family: "Poster Mono"; src: url("file://${join(FONT_DIR, mono)}") format("woff2"); font-weight: 400; font-display: block; }` : ''}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; }
  body {
    background: ${GROUND}; color: ${BONE};
    display: flex; flex-direction: column;
    font-family: "Poster Grot", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* §9 — "flush, no gaps, no radius". Flush means edge to edge: the strip
     bleeds on three sides, because a colour field with a margin round it is
     a graphic ON the poster rather than the top of it.

     It takes whatever the text block does not, down to a floor: a season
     whose note runs long still gets a picture rather than a caption with a
     stripe over it. */
  .strip { display: flex; flex: 1 1 auto; min-height: 34%; width: 100%; }
  .strip i { flex: 1 1 0; display: block; box-shadow: inset -1px 0 0 rgba(237,234,227,.22); }
  .strip i:last-child { box-shadow: none; }
  /* No colour. The hatch the page uses, at the poster's scale. */
  .strip i.empty {
    background: repeating-linear-gradient(45deg,
      transparent 0 14px, rgba(237,234,227,.20) 14px 17px);
  }
  /* A jacket colour still holding the wall while it retires. */
  .strip i.prov { opacity: .5; }

  .body { flex: 0 0 auto; padding: ${s.pad}px ${s.pad}px ${Math.round(s.pad * 0.82)}px; }

  .label {
    font-family: "Poster Mono", monospace; font-size: ${s.meta}px;
    letter-spacing: .22em; color: ${QUIET}; text-transform: uppercase;
  }
  /* Two lines, hard. A title long enough to want three is a title that has
     stopped being a title. */
  .title {
    font-size: ${head.length > 22 ? s.titleLong : s.title}px; font-weight: 400;
    line-height: 1.02; letter-spacing: -.028em;
    margin-top: ${Math.round(s.pad * 0.34)}px; color: ${BONE};
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Narrow on purpose. The measure is the ragged column of a lookbook page,
     not a paragraph of body copy, and it holds the eye at the left edge
     where the title left it. */
  /* One colour, one weight, all the way through.
     It used to set the last sentence in full bone and leave the rest grey,
     which put a tonal break in the middle of a paragraph and made whichever
     figure happened to end a sentence — "285." — look like a highlight. A
     stat block is one statement.
     Bone at reduced opacity rather than a grey: a mixed grey goes muddy
     against this black, where the same bone the title uses stays clean. */
  .note {
    font-size: ${s.note}px; line-height: 1.42;
    color: ${BONE}; opacity: .72;
    margin-top: ${Math.round(s.pad * 0.34)}px; max-width: 21ch;
    letter-spacing: -.008em;
  }

  /* The names. Set in the label face at the label size, because they are a
     key to the picture rather than part of the argument the note makes. */
  .words {
    font-family: "Poster Mono", monospace; font-size: ${s.meta - 3}px;
    letter-spacing: .16em; color: ${QUIET}; text-transform: uppercase;
    margin-top: ${Math.round(s.pad * 0.30)}px;
    line-height: 1.8;
  }

  /* The rule sits inside the text column, so it measures the margin rather
     than the sheet — the one line on the poster that says where the type
     block ends. */
  .foot {
    margin-top: ${Math.round(s.pad * 0.5)}px;
    padding-top: ${Math.round(s.pad * 0.34)}px;
    border-top: 1px solid #2C2A28;
    font-family: "Poster Mono", monospace; font-size: ${s.meta - 2}px;
    letter-spacing: .22em; color: ${QUIET}; text-transform: uppercase;
    display: flex; justify-content: space-between;
  }
</style></head><body>
  <div class="strip">${bands}</div>
  <div class="body">
    <div class="label">${esc(stamp)}</div>
    <h1 class="title">${esc(head)}</h1>
    ${lines.length ? `<p class="note">${lines.map(esc).join(' ')}</p>` : ''}
    ${words.length ? `<div class="words">${words.map(esc).join(' · ')}</div>` : ''}
    <div class="foot"><span>${esc(code)}</span><span>MARGIN.CO</span></div>
  </div>
</body></html>`;
}

// The self-hosted font files are named by Google's content hash, so the
// right one is found by reading public/css/fonts.css rather than by
// guessing at filenames or picking the biggest file in the directory.
//
// The latin block is the one wanted: a poster title is Latin text, and the
// Cyrillic and Greek subsets would only add weight.
const FONT_DIR = join(here, '..', 'public', 'fonts');

let resolved = null;
function fontFor(family) {
  if (!resolved) {
    resolved = {};
    try {
      const css = readFileSync(join(here, '..', 'public', 'css', 'fonts.css'), 'utf8');
      // Each @font-face block, in order. Google emits the latin subset last,
      // and its unicode-range is the one containing U+0000-00FF.
      for (const block of css.split('@font-face').slice(1)) {
        const fam = /font-family:\s*'([^']+)'/.exec(block)?.[1];
        const file = /url\(\/fonts\/([^)]+)\)/.exec(block)?.[1];
        const latin = /U\+0000-00FF/.test(block);
        if (fam && file && latin && !resolved[fam]) resolved[fam] = file;
      }
    } catch { /* the poster falls back to a system face */ }
  }
  return resolved[family] || null;
}

/**
 * Render the poster.
 *
 * Returns null rather than throwing when no renderer is available: a poster
 * is a share affordance, and its absence must not take the lookbook down.
 */
/**
 * Where rendered posters live.
 *
 * A poster is a pure function of the season it is made from, so it is
 * cached on disk under a hash of its own inputs. Rendering took thirty
 * seconds; doing that again on every click, for a picture that had not
 * changed, was the difference between a button that works and a button
 * that appears not to.
 */
const POSTER_DIR = process.env.MARGIN_POSTER_DIR || join(here, '..', 'data', 'posters');

/**
 * The key is the picture.
 *
 * It used to hash `opts.label` and `opts.note` — two fields the route has
 * never passed — while leaving out `title`, which it does. So renaming a
 * season kept serving the old poster with the old name on it, indefinitely,
 * and the only thing that could clear it was adding a book. Hashing exactly
 * the arguments that reach the page fixes that, and `v` retires every
 * poster made by the jacket-grid version.
 */
const cacheKey = (opts) =>
  createHash('sha256').update(JSON.stringify({
    v: 2,
    title: opts.title, code: opts.code, label: opts.label,
    count: opts.count, note: opts.note ?? opts.firstLine,
    strip: opts.strip, shape: opts.shape
  })).digest('hex').slice(0, 24);

export async function posterPNG(opts) {
  const chrome = chromePath();
  if (!chrome) return null;

  mkdirSync(POSTER_DIR, { recursive: true });
  const cached = join(POSTER_DIR, `${cacheKey(opts)}.png`);
  if (existsSync(cached)) {
    try { return readFileSync(cached); } catch { /* fall through and re-render */ }
  }

  const { w, h } = SHAPES[opts.shape] || SHAPES.story;
  const dir = mkdtempSync(join(tmpdir(), 'margin-poster-'));

  try {
    const html = join(dir, 'poster.html');
    const out = join(dir, 'poster.png');
    writeFileSync(html, posterHTML(opts));

    // Chrome writes the screenshot in about a second and then does not
    // exit for another thirty. We were waiting on the process, so every
    // click paid that — and the slower seasons hit the timeout and returned
    // nothing at all, which is why the button looked broken.
    //
    // So: start it, wait for the FILE, then kill it. The picture is what
    // was wanted; the browser's own shutdown is not.
    await screenshot(chrome, html, out, w, h);
    const png = readFileSync(out);
    try { writeFileSync(cached, png); } catch { /* an uncacheable poster still renders */ }
    return png;
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

/**
 * Run Chrome until the screenshot exists, then stop it.
 *
 * The file is considered done when its size stops changing between polls —
 * a PNG that is still being written would otherwise be read half-formed.
 */
function screenshot(chrome, html, out, w, h) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      // No network at all: the page is a local file with local fonts, so
      // there is nothing to fetch and nothing that could vary by machine.
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=0E0D0F',
      `--window-size=${w},${h}`,
      `--screenshot=${out}`,
      `--user-data-dir=${join(dirname(out), 'profile')}`,
      `file://${html}`
    ], { stdio: 'ignore' });

    let done = false;
    let lastSize = -1;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(giveUp);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      err ? reject(err) : resolve();
    };

    const poll = setInterval(() => {
      if (!existsSync(out)) return;
      const size = statSync(out).size;
      if (size > 0 && size === lastSize) finish(null);
      lastSize = size;
    }, 120);

    // A real ceiling, for a machine where Chrome never renders at all.
    const giveUp = setTimeout(() => finish(new Error('POSTER TIMED OUT')), 45_000);

    child.on('error', finish);
    child.on('exit', () => { if (existsSync(out)) finish(null); });
  });
}

function chromePath() {
  const candidates = [
    process.env.MARGIN_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ].filter(Boolean);

  for (const c of candidates) {
    try { accessSync(c); return c; } catch { /* try the next */ }
  }
  return null;
}
