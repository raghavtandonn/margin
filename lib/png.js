import zlib from 'node:zlib';

// A minimal PNG reader.
//
// It was written for the spine sampler's 1×8 bitmaps and is now also what
// the season colour signature reads its 64×64 downsamples through, so it
// lives here rather than in one script that another has to reach into.
//
// Only what `sips` actually emits is handled: 8-bit, non-interlaced,
// greyscale / RGB / RGBA. Palette images return empty rather than being
// half-decoded into plausible nonsense.

// Minimal PNG reader, adequate for the 1×8 bitmaps sips produces.
export function decodePNG(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let idat = Buffer.alloc(0);

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, data]);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || bitDepth !== 8) return [];

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || colorType === 3) return [];

  const raw = zlib.inflateSync(idat);
  const stride = width * channels;
  const out = [];
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < width; x++) {
      const o = x * channels;
      // Skip near-transparent pixels; they are not spine colour.
      if (channels === 4 && line[o + 3] < 128) continue;
      out.push(channels >= 3 ? [line[o], line[o + 1], line[o + 2]] : [line[o], line[o], line[o]]);
    }
    prev = line;
  }
  return out;
}
