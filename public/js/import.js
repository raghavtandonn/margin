// ── §12 — the import screen ──────────────────────────────
//
// Two jobs: make the whole drop zone a drop target, and print one line while
// the job runs. Deliberately no progress bar, no spinner, and no percentage
// animating itself upward — the count is the only thing that actually
// changed, so it is the only thing that moves.

const drop = document.getElementById('drop');
const file = document.getElementById('drop-file');

if (drop && file) {
  // The form now holds a textarea as well as the file input, so only a drag
  // carrying FILES is intercepted. Dragging a few lines of text into the box
  // is a perfectly reasonable way to paste a list, and swallowing it to show
  // a drop-zone highlight would take that away.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { if (!hasFiles(e)) return; stop(e); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => { if (!hasFiles(e)) return; stop(e); drop.classList.remove('over'); });
  }

  drop.addEventListener('drop', (e) => {
    const dropped = e.dataTransfer?.files;
    if (!dropped || !dropped.length) return;
    file.files = dropped;
    drop.submit();
  });

  // Choosing a file is the same gesture as dropping one, so it submits too
  // rather than leaving a second button to press.
  file.addEventListener('change', () => { if (file.files.length) drop.submit(); });
}

// ── The line ─────────────────────────────────────────────
const line = document.getElementById('import-line');

if (line && line.dataset.state === 'running') {
  const id = line.dataset.job;
  const after = document.getElementById('import-after');

  const tick = async () => {
    try {
      const res = await fetch(`/settings/import/${id}/progress`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) setTimeout(tick, 1200);
        return;
      }
      const job = await res.json();

      if (job.state === 'running') {
        line.textContent = `IMPORTING · ${job.done} / ${job.total}`;
        return setTimeout(tick, 400);
      }

      if (job.state === 'failed') {
        line.textContent = 'IMPORT FAILED';
        return;
      }

      // Finished. Reload so the result is server-rendered rather than
      // assembled twice, once here and once in the template.
      location.reload();
    } catch {
      // A dropped request is not a failed import. Try again.
      setTimeout(tick, 1200);
    }
  };

  tick();
}
