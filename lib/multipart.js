// A minimal multipart/form-data reader.
//
// One file field, read with a hard cap enforced WHILE reading rather than
// after — a limit applied to what gets stored is not a limit on what gets
// buffered.
//
// This is deliberately not a dependency: two forms in the whole product
// upload a file, and both want exactly this.

export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return m ? `--${m[1] || m[2]}` : null;
}

/** Reads the request body, refusing anything over `limit` bytes. */
export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit + 4096) {
      req.destroy();
      const err = new Error('too large');
      err.tooLarge = true;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The first part carrying a filename, with the name it was given. */
export function firstFile(body, boundary) {
  const bound = Buffer.from(boundary);
  let start = body.indexOf(bound);

  while (start !== -1) {
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) return null;

    const headers = body.subarray(start, headerEnd).toString('latin1');
    const next = body.indexOf(bound, headerEnd);
    if (next === -1) return null;

    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (filename) {
      return {
        filename,
        // -2 drops the CRLF that precedes the next boundary.
        data: body.subarray(headerEnd + 4, next - 2)
      };
    }
    start = next;
  }
  return null;
}

/** The non-file fields, so a form can carry a CSRF token alongside a file. */
export function fields(body, boundary) {
  const bound = Buffer.from(boundary);
  const out = {};
  let start = body.indexOf(bound);

  while (start !== -1) {
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString('latin1');
    const next = body.indexOf(bound, headerEnd);
    if (next === -1) break;

    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name && !/filename="/i.test(headers)) {
      out[name] = body.subarray(headerEnd + 4, next - 2).toString('utf8');
    }
    start = next;
  }
  return out;
}
