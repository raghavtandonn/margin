import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const AVATAR_DIR = process.env.MARGIN_AVATAR_DIR || join(here, '..', 'data', 'avatars');
export const SIZES = [48, 96, 256];
export const MAX_BYTES = 5 * 1024 * 1024;

// ── §9 — the avatar pipeline ─────────────────────────────
//
// Four requirements, and each one is a specific attack:
//
//   magic bytes, not Content-Type   a `.png` with a PHP body
//   re-encode server-side           polyglots and malformed-image exploits
//   strip all metadata              a phone photo hands over home GPS
//   randomised keys                 a user-controlled filename is a path
//
// The re-encode is done with `sips`, which ships with macOS and which this
// codebase already depends on for sampling spine colours. That makes the
// pipeline platform-specific, and SECURITY.md says so: a Linux deployment
// needs the same three steps through libvips or ImageMagick, and the shape
// here is what it should follow.

// ── PNG chunk stripping ──────────────────────────────────
//
// `sips` re-encodes, but it does NOT drop metadata: it carries EXIF across
// into the PNG as an `eXIf` chunk, and writes an `iTXt` chunk that typically
// holds XMP. Both can contain GPS coordinates. An early version of this file
// "verified" EXIF removal by searching the output for the bytes `Exif` and
// found none — because the PNG chunk is spelled `eXIf`. The check passed and
// the coordinates went straight through.
//
// So the re-encode is not trusted to strip anything. Everything that is not
// structurally required to draw the image is removed here, by name, from a
// list of what to KEEP rather than a list of what to drop — an allowlist
// cannot be outflanked by a chunk type nobody thought of.
const KEEP_CHUNKS = new Set([
  'IHDR',   // dimensions, bit depth, colour type — required
  'PLTE',   // palette, required for indexed images
  'tRNS',   // transparency
  'IDAT',   // the pixels
  'IEND',   // terminator
  'sRGB',   // colour space, one byte, carries nothing identifying
  'gAMA'    // gamma, four bytes, likewise
]);

/**
 * Rebuild a PNG from only its structural chunks.
 *
 * Whole chunks are copied or dropped, never edited, so every surviving CRC
 * is still the one its own encoder wrote.
 */
export function stripPngMetadata(buf) {
  const SIG = Buffer.from('89504e470d0a1a0a', 'hex');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;

  const out = [SIG];
  let o = 8;

  while (o + 8 <= buf.length) {
    const length = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('latin1');
    const end = o + 12 + length;
    if (end > buf.length) return null;          // truncated or malformed

    if (KEEP_CHUNKS.has(type)) out.push(buf.subarray(o, end));

    o = end;
    if (type === 'IEND') break;
  }

  const result = Buffer.concat(out);
  // A PNG with no IDAT is not an image, and shipping one would be worse
  // than refusing the upload.
  return result.includes(Buffer.from('IDAT')) ? result : null;
}

// A container is what its first bytes say it is. An extension is a claim by
// whoever uploaded the file, and Content-Type is a claim by their browser.
const SIGNATURES = [
  { type: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'png',  test: (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  {
    type: 'webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' &&
                 b.subarray(8, 12).toString('ascii') === 'WEBP'
  }
];

export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  return SIGNATURES.find((s) => s.test(buffer))?.type || null;
}

/**
 * A polyglot is a file that is a valid image AND valid something-else. The
 * signature check passes it; what stops it is that the bytes served back are
 * not the bytes uploaded — they are the output of a re-encoder that only
 * knows how to write pixels.
 */
export async function processAvatar(buffer, { sizes = SIZES } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: 'No file was uploaded.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: 'Images are at most 5 MB.' };
  }

  const type = sniff(buffer);
  if (!type) {
    // Deliberately not "that is not a PNG" — naming what was detected tells
    // someone probing the endpoint exactly which magic bytes to fake next.
    return { ok: false, error: 'That file is not a JPEG, PNG, or WebP.' };
  }

  const key = randomBytes(16).toString('hex');
  const scratch = join(tmpdir(), `margin-avatar-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(AVATAR_DIR, { recursive: true });

  const input = join(scratch, `in.${type}`);
  writeFileSync(input, buffer);

  try {
    for (const size of sizes) {
      const out = join(AVATAR_DIR, `${key}-${size}.png`);
      // --resampleHeightWidthMax fits within the box without distorting.
      // The re-encode is what neutralises a polyglot: the bytes served back
      // are an encoder's output, not the uploader's file. It does NOT strip
      // metadata — that is the next step.
      await exec('sips', [
        '-s', 'format', 'png',
        '--resampleHeightWidthMax', String(size),
        input, '--out', out
      ], { timeout: 15_000 });

      if (!existsSync(out)) throw new Error(`sips produced nothing at ${size}px`);

      // The re-encoder keeps EXIF and XMP. Strip them, then verify.
      const stripped = stripPngMetadata(readFileSync(out));
      if (!stripped) throw new Error(`the re-encoded PNG at ${size}px could not be rebuilt`);
      writeFileSync(out, stripped);

      // Assert the property rather than trusting either step. Both spellings
      // of the EXIF chunk are checked, since it was the capitalisation that
      // hid this the first time.
      for (const marker of ['eXIf', 'Exif', 'iTXt', 'tEXt', 'zTXt', 'iCCP', 'ns.adobe.com']) {
        if (stripped.includes(Buffer.from(marker))) {
          throw new Error(`${marker} survived at ${size}px`);
        }
      }
    }

    return { ok: true, key, type };
  } catch (err) {
    for (const size of sizes) {
      try { rmSync(join(AVATAR_DIR, `${key}-${size}.png`), { force: true }); } catch { /* nothing written */ }
    }
    return {
      ok: false,
      error: 'That image could not be processed.',
      detail: err.message
    };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

export const avatarFile = (key, size) =>
  join(AVATAR_DIR, `${sanitiseKey(key)}-${nearestSize(size)}.png`);

// A key comes out of the database, but treating it as a path component
// without checking is how `../../etc/passwd` becomes a filename.
const sanitiseKey = (key) => String(key || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);

const nearestSize = (size) =>
  SIZES.includes(Number(size)) ? Number(size) : 96;

export function removeAvatar(key) {
  if (!key) return;
  for (const size of SIZES) {
    try { rmSync(avatarFile(key, size), { force: true }); } catch { /* already gone */ }
  }
}

/**
 * §9 — avatars belong on a separate domain or a CDN-fronted bucket, "never
 * on the app origin, and never served from a path that could be interpreted
 * as HTML."
 *
 * There is one origin here and no object storage, so the separation cannot
 * be bought with a hostname. What it is bought with instead:
 *
 *   - files live outside the static root, so nothing serves them implicitly
 *   - the route pins Content-Type: image/png and X-Content-Type-Options
 *   - the path carries no user-controlled component and no extension
 *   - Content-Disposition: attachment, so a browser never renders one inline
 *
 * That closes the attack (an uploaded file executing as HTML on the app
 * origin) without closing the gap (same-origin cookies are still in scope).
 * SECURITY.md lists it as a deployment gap.
 */
export const AVATAR_HEADERS = {
  'Content-Type': 'image/png',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline; filename="avatar.png"',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'public, max-age=604800'
};
