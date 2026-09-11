// "THE WALL" — interaction and export (v0.5.1 §5.5, §5.6).

const wall = document.getElementById('wall');

// ── The caption rail ────────────────────────────────────
// Thin spines carry no title, so leaning in — hovering — fills the rail
// beneath the shelf instead of floating a box over the books.
if (wall) {
  const rail = document.getElementById('caption-rail');

  // ── BUILT, NOT INTERPOLATED ─────────────────────────────
  //
  // These were template strings assigned to innerHTML, and `d.title` and
  // `d.author` come from `data-` attributes on the spine. EJS escapes when
  // it WRITES those attributes — but reading them back through `dataset`
  // returns the original characters, so the escaping is undone on the way
  // in and a work titled `<img src=x onerror=…>` ran script on hover.
  //
  // Titles come from Open Library, which anybody can edit. textContent
  // cannot be escaped out of.
  const cell = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  };

  const show = (el) => {
    if (!rail) return;
    const d = el.dataset;
    const bits = [cell('rail-title', d.title || '')];
    if (d.author) bits.push(cell('rail-author dim', d.author));
    if (d.year) bits.push(cell('dim', d.year));
    if (d.extent) bits.push(cell('dim', `${d.extent}PP`));
    if (d.stars) bits.push(cell('dim', `${d.stars}\u2605`));
    if (d.state && d.state !== 'FINISHED') bits.push(cell('dim', d.state));
    rail.replaceChildren(...bits);
  };

  const clear = () => { if (rail) rail.replaceChildren(cell('dim', 'HOVER A SPINE')); };

  wall.addEventListener('pointerover', (e) => {
    const el = e.target.closest('.spine-book');
    if (el) show(el);
  });
  wall.addEventListener('pointerleave', clear);
  wall.addEventListener('focusin', (e) => {
    const el = e.target.closest('.spine-book');
    if (el) show(el);
  });

  // Keyboard: arrows along and between rows.
  wall.addEventListener('keydown', (e) => {
    const el = e.target.closest('.spine-book');
    if (!el) return;
    const rows = [...wall.querySelectorAll('.wall-row')];
    const row = el.parentElement;
    const inRow = [...row.querySelectorAll('.spine-book')];
    const i = inRow.indexOf(el);
    const r = rows.indexOf(row);
    let next = null;

    if (e.key === 'ArrowRight') next = inRow[i + 1] || rows[r + 1]?.querySelector('.spine-book');
    else if (e.key === 'ArrowLeft') {
      if (i > 0) next = inRow[i - 1];
      else {
        const prev = rows[r - 1]?.querySelectorAll('.spine-book');
        next = prev?.[prev.length - 1];
      }
    } else if (e.key === 'ArrowDown') {
      const below = rows[r + 1]?.querySelectorAll('.spine-book');
      next = below?.[Math.min(i, below.length - 1)];
    } else if (e.key === 'ArrowUp') {
      const above = rows[r - 1]?.querySelectorAll('.spine-book');
      next = above?.[Math.min(i, above.length - 1)];
    }

    if (next) { e.preventDefault(); next.focus(); }
  });
}

// ── §5.6 Export ──────────────────────────────────────────
// Full height, no cropping, stock-white ground, wordmark and count at the
// foot. This is the thing that gets shown to people.
const exportBtn = document.getElementById('wall-export');

if (exportBtn && wall) {
  exportBtn.addEventListener('click', async () => {
    const label = exportBtn.textContent;
    exportBtn.textContent = 'RENDERING…';

    try {
      const scale = 2;
      const pad = 40;
      const footer = 46;
      const rows = [...wall.querySelectorAll('.wall-row')];

      // Measure from the live DOM so the export matches exactly what is on
      // screen, rather than being a second implementation that can drift.
      const width = wall.getBoundingClientRect().width;
      const height = rows.reduce((h, r) => h + r.getBoundingClientRect().height + 26, 0);

      const canvas = document.createElement('canvas');
      canvas.width = (width + pad * 2) * scale;
      canvas.height = (height + pad * 2 + footer) * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      const css = getComputedStyle(document.body);
      const ink = css.getPropertyValue('--press-black').trim() || '#0B0B0B';
      const stock = css.getPropertyValue('--stock-white').trim() || '#FDFDFC';

      ctx.fillStyle = stock;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const wallRect = wall.getBoundingClientRect();
      let count = 0;

      for (const row of rows) {
        const rowRect = row.getBoundingClientRect();
        for (const el of row.querySelectorAll('.spine-book')) {
          const r = el.getBoundingClientRect();
          const x = r.left - wallRect.left + pad;
          const y = r.top - wallRect.top + pad;
          const s = getComputedStyle(el);

          ctx.fillStyle = s.backgroundColor;
          ctx.fillRect(x, y, r.width, r.height);
          ctx.strokeStyle = 'rgba(11,11,11,.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, r.width - 1, r.height - 1);

          const text = el.querySelector('.spine-label');
          if (text && r.width >= 20) {
            const ts = getComputedStyle(text);
            ctx.save();
            ctx.fillStyle = ts.color;
            ctx.font = `500 ${ts.fontSize} "Inter Tight", Helvetica, Arial, sans-serif`;
            if (el.classList.contains('is-reading')) {
              ctx.textAlign = 'center';
              ctx.fillText(el.dataset.title, x + r.width / 2, y + r.height / 2 + 3, r.width - 12);
            } else {
              ctx.translate(x + r.width / 2 + 4, y + 8);
              ctx.rotate(Math.PI / 2);
              ctx.fillText(text.textContent.trim(), 0, 0, r.height - 16);
            }
            ctx.restore();
          }
          count++;
        }
        // The shelf board.
        ctx.fillStyle = ink;
        ctx.fillRect(pad, rowRect.bottom - wallRect.top + pad, width, 3);
      }

      ctx.fillStyle = ink;
      ctx.font = '700 15px "Inter Tight", Helvetica, Arial, sans-serif';
      ctx.fillText('MARGIN', pad, height + pad + 28);
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(`${count} BOOKS AT TRUE SCALE`, pad + 86, height + pad + 28);

      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'margin-wall.png';
        a.click();
        URL.revokeObjectURL(url);
        exportBtn.textContent = label;
      }, 'image/png');
    } catch {
      exportBtn.textContent = 'EXPORT UNAVAILABLE';
      setTimeout(() => { exportBtn.textContent = label; }, 2400);
    }
  });
}
