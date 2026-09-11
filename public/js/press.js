// ── "ON PRESS" ───────────────────────────────────────────
//
// The page number is the input. Click it, type, blur saves. There is no
// button because a number field that saves itself does not need a verb, and
// "LOG IMPRESSION" was a pun that cost more comprehension than it bought.
//
// The mark on the hairline moves when the number does, so the only feedback
// is the thing that actually changed.

const rows = document.querySelectorAll('.press-row');

for (const row of rows) {
  const input = row.querySelector('.press-number');
  const form = row.querySelector('.press-count');
  const track = row.querySelector('.press-track');
  if (!input || !form) continue;

  const csrf = form.querySelector('input[name="_csrf"]')?.value || '';

  const save = async (position) => {
    const body = new URLSearchParams({ _csrf: csrf, position: String(position) });

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'fetch'
        },
        body: body.toString()
      });
      if (!res.ok) return false;

      const json = await res.json();
      if (!json.ok) return false;

      input.value = json.position ?? '';
      input.dataset.value = input.value;
      moveMark(json.percent);

      // The rule under the number goes red for a moment. That is the whole
      // confirmation: no toast, no tick, no "saved" that has to be dismissed.
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 900);
      return true;
    } catch {
      return false;
    }
  };

  function moveMark(percent) {
    if (!track) return;
    let mark = track.querySelector('.press-mark');
    if (!percent) { mark?.remove(); return; }
    if (!mark) {
      mark = document.createElement('i');
      mark.className = 'press-mark';
      track.appendChild(mark);
    }
    mark.style.left = `${Math.max(0, Math.min(100, percent))}%`;
  }

  input.addEventListener('blur', () => {
    const next = input.value.trim();
    if (next === (input.dataset.value || '')) return;      // nothing changed
    if (next === '') { input.value = input.dataset.value || ''; return; }
    if (!/^\d+$/.test(next)) { input.value = input.dataset.value || ''; return; }
    save(next);
  });

  // Enter commits without submitting the form, so the page never reloads.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = input.dataset.value || ''; input.blur(); }
  });

  // Clicking the number selects it, so typing replaces rather than appends.
  input.addEventListener('focus', () => input.select());

  // +10 +25 +50 advance from where the book actually is.
  for (const add of row.querySelectorAll('.press-add[name="advance"]')) {
    add.addEventListener('click', (e) => {
      e.preventDefault();
      const from = Number(input.dataset.value || 0);
      save(from + Number(add.value));
    });
  }
}

// ── THE EXTENT ───────────────────────────────────────────
//
// How long the book is, beside how far in you are. Same interaction as the
// page number: click, type, blur saves.
//
// It exists because most of an imported library has no page count on any
// edition, and without one there is no ceiling to clamp a typo against —
// page 800 of a 300-page novel saved happily and then sat there. The reader
// is the only one who can settle it, so the field is where they will notice
// it is missing rather than inside a form they will never open.

for (const row of document.querySelectorAll('.press-row')) {
  const extent = row.querySelector('.press-extent');
  const number = row.querySelector('.press-number');
  const track = row.querySelector('.press-track');
  const form = row.querySelector('.press-count');
  if (!extent || !form) continue;

  const csrf = form.querySelector('input[name="_csrf"]')?.value || '';

  const saveExtent = async (total) => {
    try {
      const res = await fetch(extent.dataset.extentPost, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'fetch'
        },
        body: new URLSearchParams({ _csrf: csrf, total: String(total) }).toString()
      });
      const json = await res.json().catch(() => ({ ok: false }));

      if (!res.ok || !json.ok) {
        extent.value = extent.dataset.value || '';
        return;
      }

      extent.value = json.total ?? '';
      extent.dataset.value = extent.value;

      // Setting a shorter extent pulls the position down with it, so the
      // number beside it has to follow or the row contradicts itself.
      if (number) {
        number.value = json.position ?? '';
        number.dataset.value = number.value;
        number.dataset.total = extent.value;
      }
      setMark(track, json.percent);

      extent.classList.add('saved');
      setTimeout(() => extent.classList.remove('saved'), 900);
    } catch {
      extent.value = extent.dataset.value || '';
    }
  };

  extent.addEventListener('blur', () => {
    const next = extent.value.trim();
    if (next === (extent.dataset.value || '')) return;
    if (next !== '' && !/^\d+$/.test(next)) {
      extent.value = extent.dataset.value || '';
      return;
    }
    saveExtent(next);
  });

  extent.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); extent.blur(); }
    if (e.key === 'Escape') { extent.value = extent.dataset.value || ''; extent.blur(); }
  });
  extent.addEventListener('focus', () => extent.select());
}

function setMark(track, percent) {
  if (!track) return;
  let mark = track.querySelector('.press-mark');
  if (!percent) { mark?.remove(); return; }
  if (!mark) {
    mark = document.createElement('i');
    mark.className = 'press-mark';
    track.appendChild(mark);
  }
  mark.style.left = `${Math.max(0, Math.min(100, percent))}%`;
}
