import { deflateRawSync, inflateRawSync } from 'node:zlib';

// A minimal ZIP writer, and a reader for one archive at a time.
//
// Node ships deflate but not an archive format, and the alternative to these
// eighty lines is a dependency in a project that has three. Only what a
// single-shot export needs is implemented: no encryption, no ZIP64, no
// streaming, no directory entries.
//
// The reader exists because a Goodreads data export arrives as a folder of
// zipped JSON rather than as the CSV everybody remembers. Asking somebody to
// unzip 44 files by hand before they can use their own reading history is
// not an import flow.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS date and time, which is what the format stores. Seconds have
// two-second resolution; this is not a bug in the arithmetic.
function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @returns {Buffer}
 */
export function zip(files, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });

    // Storing beats deflating when deflating makes it bigger, which happens
    // with tiny or already-compressed payloads.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    chunks.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0o644 << 16, 38);   // external attrs
    dir.writeUInt32LE(offset, 42);

    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ── READING ──────────────────────────────────────────────

const MAX_ENTRIES = 64;
const MAX_UNPACKED = 64 * 1024 * 1024;

/**
 * Read a ZIP archive.
 *
 * Walks the central directory rather than scanning for local headers, which
 * is the only way to get the true compressed size when a writer used a data
 * descriptor. Stored (0) and deflated (8) are the only methods Goodreads
 * emits, and the only two supported.
 *
 * Both limits are decompression bombs, not politeness: an archive that
 * claims a gigabyte is refused before it is inflated, not after.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a ZIP file.');

  // The end-of-central-directory record lives at the tail, after a comment
  // of unknown length, so it is found by scanning backwards for its
  // signature rather than by arithmetic.
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end === -1) throw new Error('Not a ZIP file.');

  const count = buf.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new Error(`That archive holds ${count} files.`);

  let p = buf.readUInt32LE(end + 16);
  const out = [];
  let unpacked = 0;

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid ZIP directory.');

    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    p += 46 + nameLen + extraLen + commentLen;

    // Directory entries, and anything a zip-slip would need.
    if (name.endsWith('/') || name.includes('..')) continue;

    unpacked += size;
    if (unpacked > MAX_UNPACKED) throw new Error('That archive unpacks to too much.');

    // The local header repeats the name and extra fields, and its extra
    // length is frequently NOT the one in the central directory.
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) continue;
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + compressed);
    if (dataAt + compressed > buf.length) throw new Error('Truncated ZIP entry.');
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    if (data) {
      if (data.length !== size) throw new Error('Invalid ZIP entry size.');
      out.push({ name, data });
    }
    // Anything else is a method this project does not produce and Goodreads
    // does not use. Skipped rather than guessed at.
  }

  return out;
}
