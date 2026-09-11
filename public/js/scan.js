// "SCAN" (v0.3 B2) — the camera, and the primary path for physical books.
//
// BarcodeDetector where available; the page degrades to search with an
// explanation rather than a dead screen when it is not, or when camera
// permission is denied.

// Only offer the camera where the browser can actually decode a barcode.
// A START CAMERA button that always fails is worse than no button.
const offer = document.getElementById('scan-offer');
if (offer && 'BarcodeDetector' in window && navigator.mediaDevices?.enumerateDevices) {
  // A machine with no camera still reports getUserMedia, so probe for a real
  // video input rather than offering a button that can only fail.
  navigator.mediaDevices
    .enumerateDevices()
    .then((devices) => {
      if (devices.some((d) => d.kind === 'videoinput')) offer.hidden = false;
    })
    .catch(() => {});
}

const startBtn = document.getElementById('scan-start');
const stopBtn = document.getElementById('scan-stop');
const scanner = document.getElementById('scanner');
const video = document.getElementById('scan-video');
const note = document.getElementById('scan-note');
const countEl = document.getElementById('scan-count');
const results = document.getElementById('scan-results');

if (startBtn) {
  let stream = null;
  let detector = null;
  let running = false;
  let count = 0;
  const seen = new Set();

  const say = (msg) => { if (note) note.textContent = msg; };

  // Only 978/979 prefixes are books. A cereal box is rejected with a clear
  // message rather than a silent failure.
  const isBookEAN = (raw) => /^97[89]\d{10}$/.test(raw);

  async function handle(raw) {
    if (seen.has(raw)) return;
    seen.add(raw);

    if (!isBookEAN(raw)) {
      say(`${raw} IS NOT A BOOK BARCODE. NEEDS A 978 OR 979 PREFIX.`);
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
      return;
    }

    if (navigator.vibrate) navigator.vibrate(18);
    say(`RESOLVING ${raw}…`);

    // ── THE ROW ────────────────────────────────────────────
    //
    // Built as DOM nodes, not as an innerHTML template.
    //
    // It was a template string, and `data.title`, `data.author` and
    // `data.cover` were interpolated into it raw. Those come from the
    // editions table, which is populated from Open Library — third-party
    // data that anybody can edit. A work titled `<img src=x onerror=…>`
    // would have run script in the reader's page.
    //
    // The CSP would have caught the specific `onerror` case, but only where
    // it is enforced rather than report-only, and "another layer stops it"
    // is not a reason to build the hole. textContent cannot be escaped out
    // of, so nothing here depends on getting escaping right.
    const row = document.createElement('div');
    row.className = 'ticket scan-row';
    results.prepend(row);

    const cell = (cls, text) => {
      const el = document.createElement('span');
      el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };

    /** Replace the row's contents with the given nodes. */
    const fill = (...nodes) => { row.replaceChildren(...nodes); };

    fill(
      cell('mono-s dim', '…'),
      (() => { const m = cell('ticket-main'); m.append(cell('ticket-title mono', raw)); return m; })(),
      cell('mono-s dim', 'LOOKING UP')
    );

    try {
      const res = await fetch('/capture/isbn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbn: raw })
      });
      const data = await res.json();

      if (!data.ok) {
        // Unresolvable ISBNs are queued, not discarded (A1 / B2).
        const main = cell('ticket-main');
        main.append(cell('ticket-title mono', raw), cell('mono-s dim', data.error || 'NOT FOUND'));
        fill(cell('mono-s dim', '—'), main, cell('mono-s orange', 'NEEDS REGISTRATION'));
        return;
      }

      count++;
      if (countEl) countEl.textContent = `${count} SCANNED`;

      const frame = cell('frame frame-sm');
      if (data.cover) {
        const img = document.createElement('img');
        // Assigned as a property, so a value that is not a URL cannot end
        // up as another attribute.
        img.src = data.cover;
        img.alt = '';
        frame.append(img);
      }

      const link = document.createElement('a');
      link.className = 'ticket-title';
      link.href = '/work/' + encodeURIComponent(data.workId);
      link.textContent = data.title || '';

      const meta = cell('ticket-meta');
      meta.append(cell('b2 dim', data.author || ''), cell('id dim', raw));

      const main = cell('ticket-main');
      main.append(link, meta);

      fill(frame, main, cell('mono-s orange', String(data.shelf || '').toUpperCase()));
      say('');
    } catch {
      const main = cell('ticket-main');
      main.append(cell('ticket-title mono', raw));
      fill(cell('mono-s dim', '—'), main, cell('mono-s dim', 'OFFLINE — QUEUED'));
    }
  }

  async function loop() {
    if (!running) return;
    try {
      const codes = await detector.detect(video);
      for (const c of codes) await handle(c.rawValue);
    } catch { /* a frame that will not decode is not an error */ }
    if (running) requestAnimationFrame(loop);
  }

  startBtn.addEventListener('click', async () => {
    if (!('BarcodeDetector' in window)) {
      say('THIS BROWSER HAS NO BARCODE DETECTOR. USE SEARCH, OR REGISTER MANUALLY BELOW.');
      return;
    }
    try {
      detector = new window.BarcodeDetector({ formats: ['ean_13', 'upc_a'] });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      video.srcObject = stream;
      await video.play();
      scanner.hidden = false;
      running = true;
      say('CONTINUOUS MODE. IT FIRES ON A CONFIDENT DECODE.');
      loop();
    } catch (err) {
      // Permission denial falls through to search with an explanation,
      // never a dead screen (B2).
      say('NO CAMERA ACCESS. USE SEARCH, OR REGISTER MANUALLY BELOW.');
      scanner.hidden = true;
    }
  });

  stopBtn?.addEventListener('click', () => {
    running = false;
    scanner.hidden = true;
    stream?.getTracks().forEach((t) => t.stop());
    say(count ? `${count} SCANNED.` : '');
  });
}
