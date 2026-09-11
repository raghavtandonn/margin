import { Router } from '../lib/router.js';
import * as LB from '../lib/lookbook-seasonal.js';
import { requireAuth } from '../lib/auth/middleware.js';
import * as COMP from '../lib/reco-season.js';


const router = Router();

// ── THE SEASONAL LOOKBOOK ────────────────────────────────
//
// The catalogue is a different object from the season page, not a skin on
// it. /season/:code stays exactly as it is — the honest, quiet record. This
// is the printed artefact made from the same season, and it is reached
// deliberately rather than being what a reader lands on.

/** The reader's own lookbook. */
router.get('/season/:code/lookbook', requireAuth, (req, res) => {
  const book = LB.build(req.user.id, req.params.code, { owner: true });
  if (!book) return res.status(404).render('404', { title: 'Not found' });

  render(req, res, book, { owner: true, username: req.user.username });
});

// Retire the leftover public URL explicitly, including for signed-in users.
// The personal route above always resolves its owner from the session.
router.get('/@:username/:code/lookbook', (req, res) => {
  res.status(404).render('404', { title: 'Not found' });
});

// The published lookbook is gone. A season could be minted as one link
// anybody could open, and the safety of it was real — `owner: false` kept
// the pulp and the marginalia out — but the object itself is personal. A
// record of what one person read, with their own writing in the margins,
// does not need a public URL; if they want to show somebody, they can show
// them.

function render(req, res, book, opts) {
  // The complements page (recommendation spec §07). Read from the frozen
  // run, never recomputed: a lookbook is printed matter, and a page that
  // changed every time the pile did would not be one.
  let complements = [];
  try {
    complements = book?.season?.state === 'closed' && req.user
      ? COMP.forSeason(req.user.id, book.season.id) : [];
  } catch { complements = []; }

  res.render('lookbook', {
    complements,
    title: `${book.meta.short || book.season.code.toUpperCase()} · MARGIN`,
    book,
    ...opts,
    // §01 — "The bruise color rotates each season and is the only thing that
    // changes." It is the one value the stylesheet cannot know in advance,
    // so it arrives as a nonce-safe generated rule rather than an inline
    // style attribute, which the CSP forbids outright.
    styleRules: res.locals.styleRules
  });
}

export default router;
