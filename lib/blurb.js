// ── BLURB HYGIENE ────────────────────────────────────────
// Jacket copy arrives full of sales matter: bestseller flags, award lists,
// "from the author of", and praise quotes from other novelists. That junk is
// most of why blurbs look cheap, and it is filtered at INGEST rather than at
// render — a stored blurb should already be clean.
//
// Nothing here writes prose. A book with no description renders nothing. An
// empty slot is honest; an invented blurb is a lie about a real book.

// Whole lines that are marketing rather than description.
const JUNK_LINE = [
  /^\s*[*_#>\-–—\s]*(a\s+)?(#\s*1\s+)?(new york times|nyt|sunday times|usa today|wall street journal|national|international|instant)\b.*(bestseller|best seller)/i,
  /^\s*[*_#>\-–—\s]*(winner|finalist|shortlisted|longlisted|nominated)\b/i,
  /^\s*[*_#>\-–—\s]*(from|by)\s+the\s+(award-winning\s+|bestselling\s+|beloved\s+)?author of\b/i,
  /^\s*[*_#>\-–—\s]*(named|selected|chosen)\s+(one\s+of\s+)?(the\s+)?best\b/i,
  /^\s*[*_#>\-–—\s]*(a|an)\s+(best|notable|top)\s+book of\b/i,
  /^\s*[*_#>\-–—\s]*(praise|acclaim)\s+for\b/i,
  /^\s*[*_#>\-–—\s]*(over|more than)\s+[\d.,]+\s*(million|thousand)\s+copies\b/i,
  /^\s*[*_#>\-–—\s]*(soon to be|now)\s+a\s+(major\s+)?(motion picture|film|netflix|hbo|major television)/i,
  /^\s*[*_#>\-–—\s]*(includes?|with)\s+a?\s*(new\s+)?(introduction|afterword|reading group guide|p\.?s\.?\s+section)/i,
  /^\s*[*_#>\-–—\s]*(translated (in)?to|available in)\s+\d+\s+languages/i,
  // A praise quote: a sentence in quotes attributed with an em dash.
  /^\s*[""'"].{10,}[""'"]\s*[—–-]\s*\w/,
  // Wikipedia and Open Library source footers.
  /^\s*\(?\[?(source|from wikipedia|contains? spoilers)/i,
  /^\s*-{3,}\s*$/
];

// Fragments removed wherever they appear.
const JUNK_INLINE = [
  /\s*\*{1,2}[^*]{0,80}bestseller[^*]{0,40}\*{1,2}\s*/gi,
  /\s*\(\[?Wikipedia\]?\([^)]*\)[^)]*\)\s*/gi,
  /\s*\[?source:?[^\]\n]*\]?\s*$/gi,
  /\s*\(?\[?From the publisher\]?\)?:?\s*/gi,
  /\s*-{3,}\s*/g
];

const SHOUT = /\b[A-Z][A-Z' ]{6,}\b/g;

export function cleanBlurb(raw) {
  if (!raw) return null;

  let text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]+>/g, ' ');

  for (const re of JUNK_INLINE) text = text.replace(re, ' ');

  const kept = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !JUNK_LINE.some((re) => re.test(l)))
    // A line that is mostly capitals is a shout, not a description.
    .filter((l) => {
      const shouted = (l.match(SHOUT) || []).join('').length;
      return shouted / l.length < 0.4;
    });

  text = kept
    .join('\n\n')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')   // markdown emphasis
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // What is left has to be a description, not a fragment of one.
  if (text.length < 40) return null;
  return text;
}

// Show enough to remember what a book is, not the full sales pitch.
// Roughly sixty words or three sentences, whichever comes first.
export function shortBlurb(text, { words = 60, sentences = 3 } = {}) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();

  const bySentence = clean.match(/[^.!?]+[.!?]+(\s|$)/g);
  let head = clean;
  if (bySentence && bySentence.length > sentences) {
    head = bySentence.slice(0, sentences).join('').trim();
  }

  const w = head.split(/\s+/);
  if (w.length > words) head = w.slice(0, words).join(' ').replace(/[,;:]$/, '') + '…';

  return { head, truncated: head.length < clean.length, full: clean };
}
