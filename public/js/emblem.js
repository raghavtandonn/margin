// The club emblem upload.
//
// A file input posting to a JSON endpoint, so the page does not reload and
// the new emblem appears where the old one was. Nothing here writes an
// inline style or an inline handler — the CSP forbids both, and this file
// is loaded with the response nonce like every other module.

const input = document.getElementById('club-emblem-file');
if (input) {
  const img = document.getElementById('club-emblem');
  const msg = document.getElementById('club-emblem-msg');
  const blank = document.querySelector('.grp-emblem-blank');

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    msg.textContent = 'UPLOADING…';

    const body = new FormData();
    body.append('emblem', file);

    try {
      const res = await fetch(input.dataset.emblemPost, {
        method: 'POST',
        headers: {
          'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || ''
        },
        body
      });
      const out = await res.json();

      if (!res.ok || !out.ok) {
        msg.textContent = (out.error || 'That did not upload.').toUpperCase();
        return;
      }

      img.src = out.url;
      img.classList.remove('is-empty');
      if (blank) blank.remove();
      msg.textContent = 'SAVED.';
    } catch {
      msg.textContent = 'THAT DID NOT UPLOAD.';
    }
  });
}
