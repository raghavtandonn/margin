// "THE DESK" — field behaviour only.
//
// There is no chat here, no transcript, no suggestion dropdown, no spinner,
// no follow-up. Browser history is the transcript. Do not add one.

const field = document.getElementById('desk-field');
if (field) {
  // "/" focuses from anywhere; Esc blurs and restores the page underneath.
  addEventListener('keydown', (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;

    if (e.key === '/' && !typing) {
      e.preventDefault();
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      return;
    }

    if (e.key === 'Escape' && document.activeElement === field) {
      e.preventDefault();
      field.blur();
      // Restoring the page underneath means going back to it, not clearing
      // a box — the URL is the state.
      if (field.value && location.pathname === '/desk') history.back();
      else field.value = '';
    }
  });

  // The only permitted indicator that a call is in flight: the rule shifts
  // and the caret stops. No spinner, no skeleton, no shimmer.
  field.form?.addEventListener('submit', () => {
    field.form.classList.add('is-working');
  });
}
