// The description shows about sixty words. MORE opens the rest in place —
// no modal, no navigation.
const more = document.getElementById('blurb-more');
if (more) {
  more.addEventListener('click', () => {
    document.getElementById('blurb-short')?.setAttribute('hidden', '');
    document.getElementById('blurb-full')?.removeAttribute('hidden');
    more.remove();
  });
}

// The note field grows with its text rather than carrying a scrollbar or a
// resize grabber.
const note = document.getElementById('note-input');
if (note) {
  const fit = () => {
    note.style.height = 'auto';
    note.style.height = `${note.scrollHeight}px`;
  };
  note.addEventListener('input', fit);
  fit();
}
