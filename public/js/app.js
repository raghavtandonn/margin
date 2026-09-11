// ── §08 THE BARCODE — permalink ──────────────────────────
// Tap to copy the link, long-press for the citation in four formats.
(function barcode() {
  const el = document.querySelector('.barcode');
  if (!el) return;

  const permalink = el.dataset.permalink;
  const note = document.createElement('div');
  note.className = 'mono-s orange';
  el.after(note);

  let timer = null;
  let longPressed = false;

  const say = (msg) => {
    note.textContent = msg;
    setTimeout(() => { note.textContent = ''; }, 2600);
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      say(label);
    } catch {
      say('CLIPBOARD UNAVAILABLE. LINK: ' + permalink);
    }
  };

  const citations = () => {
    const title = document.querySelector('h1')?.textContent.trim() || '';
    const author = document.querySelector('.d3 a')?.textContent.trim() || '';
    const isbn = el.dataset.isbn;
    const year = new Date().getFullYear();
    return [
      `MLA: ${author}. ${title}. ISBN ${isbn}.`,
      `APA: ${author} (${year}). ${title}. ISBN ${isbn}.`,
      `Chicago: ${author}. ${title}. ISBN ${isbn}.`,
      `BibTeX: @book{${isbn}, title={${title}}, author={${author}}, isbn={${isbn}}}`
    ].join('\n');
  };

  const start = () => {
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      copy(citations(), 'CITATIONS COPIED — FOUR FORMATS');
    }, 550);
  };
  const end = () => clearTimeout(timer);

  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (!longPressed) copy(permalink, 'PERMALINK COPIED');
  });
})();

// ── §08 THE RECEIPT — export as PNG ──────────────────────
// Receipt aspect ratio, which is why it will be posted everywhere in January.
(function receiptPNG() {
  const btn = document.getElementById('receipt-png');
  const receipt = document.getElementById('receipt');
  if (!btn || !receipt) return;

  btn.addEventListener('click', () => {
    const rect = receipt.getBoundingClientRect();
    const scale = 2;
    const styles = getComputedStyle(document.body);

    // Rendered via foreignObject so the receipt exports exactly as it renders,
    // rather than as a second implementation that can drift from the first.
    const clone = receipt.cloneNode(true);
    clone.style.margin = '0';

    const css = `
      .receipt{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.04em;
        background:${styles.getPropertyValue('--stock-white') || '#FDFDFC'};
        color:${styles.getPropertyValue('--press-black') || '#0B0B0B'};
        border:1px solid currentColor;padding:22px 20px;width:${Math.round(rect.width)}px;box-sizing:border-box}
      .receipt-line{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
      .receipt-rule{border-top:1px dashed currentColor;margin:10px 0}
      .receipt-perf{border-top:2px dashed currentColor;margin-top:14px;padding-top:8px;text-align:center}
      .dim{opacity:.5}.mark{font-weight:700;font-size:14px}
      .mono-s{font-size:10px;letter-spacing:.12em;text-transform:uppercase}
      *{margin:0;box-sizing:border-box}`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${clone.outerHTML}</div>
      </foreignObject></svg>`;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = rect.width * scale;
      canvas.height = rect.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = styles.getPropertyValue('--stock-white') || '#FDFDFC';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'margin-receipt.png';
        a.click();
        URL.revokeObjectURL(url);
      });
    };
    img.onerror = () => { btn.textContent = 'PNG EXPORT UNAVAILABLE'; };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
})();

// ── §07 THE STAMP ────────────────────────────────────────
// Presses on when a shelf action succeeds, then settles.
(function stampOnAdd() {
  if (new URLSearchParams(location.search).has('stamped')) {
    document.querySelector('.stamp')?.classList.add('stamp-press');
  }
})();

// ── §2 HALF-STAR INPUT (FOUR FEATURES) ───────────────────
// A real <input type="range"> carries keyboard and form semantics; pointer
// and touch are layered on top. Ten valid values, 0.5 … 5.0, plus null.
(function halfStars() {
  const range = document.getElementById('stars');
  const row = document.getElementById('star-row');
  const fill = document.getElementById('star-fill');
  const value = document.getElementById('star-value');
  const clear = document.getElementById('star-clear');
  if (!range || !row || !fill) return;

  let committed = Number(range.value) || 0;

  const paint = (v) => {
    fill.style.width = `${(v / 5) * 100}%`;
    if (value) value.textContent = v > 0 ? `${v.toFixed(1)}★` : 'UNRATED';
  };

  // Hovering the left half of a star previews n − 0.5, the right half n.
  const fromPointer = (e) => {
    const r = row.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.max(0.5, Math.ceil(ratio * 10) / 2);
  };

  row.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !e.buttons) return;
    paint(fromPointer(e));
  });
  row.addEventListener('pointerleave', () => paint(committed));

  row.addEventListener('pointerup', (e) => {
    // Dragging left of the first star clears the rating entirely.
    const r = row.getBoundingClientRect();
    committed = e.clientX < r.left ? 0 : fromPointer(e);
    range.value = String(committed);
    paint(committed);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    // Clicking a star IS the save. No SAVE button, and no accent spent on
    // a utility control.
    range.form?.requestSubmit?.();
  });

  range.addEventListener('input', () => {
    committed = Number(range.value) || 0;
    paint(committed);
  });

  // Home clears, per the spec's keyboard contract.
  range.addEventListener('keydown', (e) => {
    if (e.key === 'Home') {
      e.preventDefault();
      committed = 0;
      range.value = '0';
      paint(0);
    }
  });

  clear?.addEventListener('click', () => {
    committed = 0;
    range.value = '0';
    paint(0);
  });

  paint(committed);
})();

// A cover that fails to load removes itself, so the typographic fallback
// underneath shows through instead of a broken-image icon.
//
// This is a single capture-phase listener rather than an onerror attribute
// on every <img>: inline handlers are blocked by script-src, and error does
// not bubble, so capture is what catches them all — including images that
// have already failed by the time this module runs.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.hasAttribute('data-cover')) img.remove();
}, true);

// The avatar form posts a file, and a multipart body is invisible to the
// CSRF middleware's body check — so the token goes in the header, which is
// the same check, reached a different way.
const avatarInput = document.getElementById('avatar-file');
if (avatarInput) {
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;

    const note = document.getElementById('avatar-note');
    const say = (text) => { if (note) note.textContent = text; };
    say('Working…');

    const form = new FormData();
    form.set('file', file);

    try {
      const res = await fetch('/settings/avatar', {
        method: 'POST',
        headers: { 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
        body: form
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return say(json.error || 'That did not work.');
      location.reload();
    } catch {
      say('That did not work.');
    }
  });
}
