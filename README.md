# MARGIN

Reading, c/o the reader. A reading log built as a printed object: a work and
edition graph, a shelf you can look at, seasons that close into catalogues,
and a small community layer — with a privacy model enforced in SQL rather
than in templates.

Built against a set of written specs — the product, accounts and security,
community, seasons and the lookbook, the colour system and recommendations —
together with the audits written when the product was measured against them.
Those specs and the reference HTML the design was drawn from are kept
privately and are not part of this repository.

---

## Quick start

```bash
npm install
npm run seed          # a small library to look at
npm run dev:account   # an account you can sign in with
npm start             # http://localhost:3000
```

`npm run dev:account` creates `admin` / `admin`. It deliberately bypasses the
password policy and the reserved-username list, says so every time it runs,
and is fine on a laptop and nowhere else.

If you already have a seeded library and want to attach credentials to *that*
reader rather than create a second account, use `npm run claim` instead — the
library predates accounts, and claiming it avoids stranding the books.

```bash
npm run dev           # restarts on change
npm run reset         # rebuild the database from scratch
npm run reset:empty   # rebuild with no books, ready for an import
```

---

## Requirements

- **Node ≥ 22.5.0.** The database is the built-in `node:sqlite`, which is why
  there is no build step and no schema tooling. Developed on Node 26.
- **Four packages carry the product** — Express, EJS, `hash-wasm` (Argon2id,
  WebAssembly) and `@simplewebauthn/server` (passkeys, pure JS). Nothing in
  that list is native and nothing needs a toolchain.
- **A fifth carries recommendations**, and it is the one exception worth
  stating plainly rather than discovering in `node_modules`.
  `@huggingface/transformers` runs the embedding model in-process and brings
  roughly 115 transitive packages with it, including **prebuilt** native
  binaries (`onnxruntime-node`, and `sharp` where it installs). They are
  downloaded, not compiled, so `npm install` still needs no toolchain — but
  "no native dependencies" stopped being true the day the pile recommender
  shipped, and this file went on saying it for a while afterwards.

  Nothing else depends on it. Skip `npm run embed` and the recommendation
  surfaces are simply absent, which is a state the product already knows how
  to render.

The database is a single file at `data/margin.db`. Fonts are served from
`public/fonts/`, not from Google, so the strict Content-Security-Policy holds
and no third party receives a request per reader per page.

---

## Verifying a change

```bash
npm run verify
```

Runs the tests and three static checks. Use this before believing a change is
finished; each check exists because something got past the ones before it.

| Command | What it proves |
|---|---|
| `npm test` | 590 tests, including regression coverage for every issue found in the security review |
| `npm run check:routes` | Every `<form action>` **and every `<a href>`** resolves to a route that exists, and every POST route is reachable from somewhere |
| `npm run check:templates` | Every template compiles, every `include` resolves, and every page template is rendered by some route |
| `npm run check:css` | The stylesheet's shadowing census — the same selector declared twice with different values |
| `npm run check:dead` | Exports nothing imports; CSS classes no template uses |
| `npm run test:csp` | Boots with `MARGIN_CSP=enforce` so violations break rather than report |

`SECURITY.md` records what is built, what is not, and what cannot be built without infrastructure this deployment does not have. Read it before deploying anything.

**Why the link check matters.** `check:routes` originally validated form
actions only. A regex edit deleted `GET /reviews`; a later one took
`GET /season/:code/poster.png` and the public season page with it. Both were
linked from views, both 404'd for every reader, and the checker reported
everything fine. It now checks links too, and understands routers that are
not named `router` — `publicRouter.get(...)` used to be invisible to it.

`check:css` can also diff:

```bash
node scripts/css-resolve.mjs --snapshot before.json
# …edit the stylesheet…
node scripts/css-resolve.mjs --check before.json   # names every changed declaration
```

That is how a 2,800-line stylesheet was consolidated with a proof that no
computed value moved except the ones intended.

---

## Getting your books in

### From the browser — `/settings/import`

The scripts below predate accounts and are still the fastest way to load a
laptop from a shell. **A reader arriving with their own library uses the
import page**, which takes three things and puts all three through the same
preview, the same shelf mapping and the same confirm step. Nothing is written
until you have seen what it is about to write.

| What you have | What to do |
|---|---|
| `goodreads_library_export.csv`, or a StoryGraph or LibraryThing CSV | Drop it. The format is read from the column headers; you are only asked which service it came from if they are unrecognisable |
| **A folder of 44 zip files** from "Request my data" | Drop **`review.zip`** — that one is your library. Still zipped; don't unzip anything |
| Neither — just a list of titles | Type them into the box, one a line |

**The folder of 44 zips is the confusing one**, because Goodreads calls two
entirely different things "your export" and they share no format. Only four
of the 44 hold reading:

| File | What it adds |
|---|---|
| `review.zip` | **Your library** — books, shelves, ratings. Import this first |
| `notes.zip` | Notes you left while reading |
| `activity.zip` | When you started and finished things |
| `user_quote.zip` | Quotes you saved |

The last three attach to books that are already there and **cannot create
one**, so they do nothing until `review.zip` has gone in. Each is previewed
row by row — every note named against the book it will land on, and every row
that will be skipped, with the reason — because a supplement cannot double a
library but it can put a note on the wrong book.

That folder is the **worse** export: it carries no author, no ISBN and no
page count, so books are matched on title alone. Where you have both, use the
CSV, and keep these four for the notes and dates the CSV has never carried.

**A typed list** needs no export at all. One book a line; the author is
optional and improves matching when it is there:

```
The Secret History by Donna Tartt
Stoner — John Williams
Gilead
```

`by`, an en/em dash, a spaced hyphen, a tab and a pipe all separate title
from author. A comma does too, but only when the file as a whole reads that
way — `Cloud Atlas, David Mitchell` splits and `Goodbye, Columbus` does not,
because nothing in either line settles it and only the company it keeps does.
Numbered lines, bullets and surrounding quotes are stripped; `Anti-Oedipus`
keeps its hyphen because an unspaced hyphen is part of a word.

### Fastest — paste the table view

Goodreads → My Books → `table view`, scroll to the bottom so every row loads,
select all, copy.

```bash
npm run reset:empty
pbpaste > data/goodreads-paste.txt
npm run import:paste -- data/goodreads-paste.txt --resolve
```

`pbpaste` writes the clipboard straight to a file, so nothing is truncated.
The table view carries **no ISBNs**, so resolution is a separate, resumable
step — re-run it to retry the books that missed:

```bash
npm run enrich -- --resolve
```

Roughly one book in six will not resolve confidently. Those keep their rating,
review, shelf and dates, and their page reads `EDITION DATA UNAVAILABLE. WORK
DATA SHOWN.` A weak match is refused on purpose: a wrong cover on your shelf
is worse than a blank one.

**Things learned the hard way about that paste:**

- Copying the page yields **every row twice** — the table is rendered twice in
  the DOM. Records are deduplicated on title + author.
- Two copy shapes exist. One duplicates the title from the cover's alt text
  and puts five stars on one line; the other has a single title line and five
  separate star lines. Both parse.
- Your rating is the **bracketed** star (`[ 4 of 5 stars ]`). No brackets means
  unrated, which is not zero.
- Open Library indexes translated authors under their native script — Murakami
  as 村上春樹, Dostoevsky in Cyrillic — so author-string matching alone fails.
  Title-only search meanwhile ranks "Summary of X" above the novel. The
  resolver scores both and refuses anything weak.

### Better data, slower — the full export

Goodreads mails you a ZIP (My Books → Import and Export). It carries real
ISBNs, page counts and publishers, so nothing needs guessing.

```bash
npm run reset:empty
npm run import:goodreads -- ~/Downloads/goodreads_library_export.csv
npm run enrich -- --editions      # covers and sibling editions
```

The importer matches on ISBN first, then on title + author, so **re-running it
updates rather than duplicating**. Where two of your books share a title, it
disambiguates on date read, rating and shelf state rather than guessing.

### One at a time

Search for anything from the desk. If it is not in your library the miss
offers Open Library results with an ADD button, which pulls the work and up to
eight real editions. If neither knows the book, the desk's empty state offers
**register it by hand**.

**Open Library needs no API key**, no account and no auth. It supplies book
metadata only — covers, editions, page counts, publishers. It has no idea what
you have read; that comes from your export.

**Goodreads profile scraping does not work.** Shelf listings are behind a
login wall, and a public profile exposes only shelf names, counts,
currently-reading and a few favourites. The export is the only complete path.

---

## Seasons and the lookbook

Every six months a reader's reading closes into a collection — two a year, on
the fashion retail calendar (`S/S` is January to June, which looks wrong for a
moment and is correct to the reference).

```bash
npm run colours:derive   # give each book its colour (see below)
npm run seasons          # close what is due, and print what came out
```

A closed season has a page, a **lookbook** (an editorial catalogue of the
books) and a **poster** (`/season/:code/poster.png`, with `?shape=story|feed|square`).

What is worth knowing:

- **Nothing is a target.** No streak, no completion percentage, no progress bar.
- **The empty movement.** A gap over 28 days becomes its own movement — named,
  dated and empty. A month you did not read is part of your season.
- **The facts are computed, never generated.** Every number comes from
  `lib/facts.js`. A model, where one is configured, only interprets, and
  anything it writes is validated against the fact set before it is shown.
- **Local-only is on by default.** With it on, nothing leaves the machine at
  season close.
- **Restraint.** A two-book season shows two books: no title, no note, no
  movements, no message of any kind.

### The colour system (optional, needs a key)

Every book gets one colour, **blended from a fixed palette of twenty
anchors** — each anchor an emotion with a name (`Grief — Slate, Deep`,
`Nostalgia — Amber, Kept`). The colours are the atom the season colourway and
the poster are built from.

The colour is **derived from the book**. There is no reader override: the
colour is what it is.

```bash
npm run colours:derive              # finished books that have no colour yet
node scripts/colours-derive.mjs --dry     # retrieve only: what is even eligible?
node scripts/colours-derive.mjs --all
npm run colours:audit               # the review you do by eye, not by test
```

A derivation returns **three emotions with weights**, each carrying its own
verbatim citation, blended in **Oklab** — not hex, which loses chroma and
drifts toward grey. Three is a hard cap: past it everything averages toward
the palette centroid, a mid brown, and every book comes out a shade of it.
The name comes from a fixed two-slot grammar (`Slate, Kept` is grief nearest
with nostalgia behind it), never from a model.

The rules it works under are not tunable, and the reason is that the obvious
failure here is a model answering "what colour is this book?" out of its own
memory — confidently, in good type, and wrong at scale in the direction of
cliché.

- **Retrieved text is the only permitted source.** Wikipedia's Themes, Style,
  Characters and Analysis sections, cached like the composition histories. The
  retrieval is not there to jog a model's memory; it is all there is.
- **The reasoning is cited.** Which section it came from is stored and shown
  under the swatch on the book page. Anything in the citation that is not
  traceable to that section is rejected, however true it is.
- **The evidence is copied, not written.** A verbatim span from the section,
  checked against it. A paraphrase fails even when it is accurate, because
  nothing downstream can tell an accurate paraphrase from an invention.
- **Themes over plot, where there is a choice.** A plot summary is a list of
  what happens, and what happens is mostly where and when. Plot is citable
  only when the article has nothing else — which is often, and is why the
  interpretive-section *gate* was built, measured and reversed.
- **Setting is never the answer.** A book set in a desert can be tender. This
  is enforced by the validator, by pinned fixtures in
  `test/colour-derive.test.js` that assert the *reasoning* rather than the
  colour — Heart of Darkness passes on the severed heads at the Inner Station
  and fails on the oppressive river — and by `npm run colours:audit`.
- **No evidence, no colour.** An unassigned book renders as an unfilled hatch,
  on the page and on the poster. It is a state, not a gap.
- **Every component is grounded on its own.** A blend cannot smuggle an
  ungrounded emotion in behind two good ones.

**Run it in batches, and read the audit between them.**

```bash
node scripts/colours-derive.mjs --limit 20   # then look
npm run colours:audit
node scripts/colours-derive.mjs --limit 30   # then look again
```

It resumes where it stopped — the query only picks up books with no colour —
so batching costs nothing and tells you early. Twenty cards is enough to see
a problem you would otherwise pay for fifty times.

**`npm run colours:audit` is the part no test can do.** Every card can pass
every rule and the colours can still all land in the same small patch of the
space. It measures **Oklab distance, not palette reach** — reach stopped
meaning anything once colours became blends, since two books can both be
nearest Grief and be visibly different. It reports the library's mean radius
against the palette's own 0.198, flags any season whose books sit inside a
0.07 radius, and cross-tabs plot-backed against themes-backed blends.

`npm run colours` is the old jacket sampler and is **retiring**. What it wrote
still renders, hatched and dimmed and never named, until the book it belongs
to has been derived.

### Composition histories (optional, needs a key)

Each book in a lookbook can carry a short account of the conditions under
which it was written, retrieved from Wikipedia and written by a model against
that retrieved text — never from the model's own memory. Every card carries a
confidence flag, and a book with no documented history gets a shorter card
built only from verifiable material facts.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node scripts/histories.mjs aw25 --note      # one season, and its closing note
node scripts/histories.mjs --all --note     # every closed season
node scripts/histories.mjs --all --note --redo   # rewrite what is already there
```

`--redo` exists because cards and notes are both cached, so a change to the
prompts is otherwise invisible. It never discards a card you have edited by
hand.

**Without a key this still runs.** Retrieval happens either way, and every
book gets a thin card built from facts the catalogue can prove. A run with no
key will never overwrite a card that was already written — absence of a key is
a fact about the run, not about the book.

---

## Recommendations

Two surfaces, and one
sentence that governs both: this is **content-based similarity ranking, not
personalization**. There is no interaction data anywhere in it. It ranks books
by how much they resemble what you finish, it does not learn your taste, and
nothing in the product is permitted to say that it does.

```bash
npm run embed          # one vector per book, from text already retrieved
npm run probe -- --kind text-plot     # does this kind carry anything at all?
npm run reco:eval      # leave-one-out — the number that decides
npm run reco:run       # generate and store a pile run
```

**The pile** (`lib/reco-pile.js`) answers one question: of the books you own
and have not opened, which should you read next? **Season complements**
(`lib/reco-season.js`) put three books beside a closed season — the one
nearest what the season was about, one that fills something the season had
none of, and one that follows the season's odd book out.

What is worth knowing:

- **The measurement overruled the probe, and the code says so.** A linear
  probe ranked criticism best of any single kind by AUC (0.652). Leave-one-out
  ranked it *below random* (MRR 0.9×). A kind can separate two classes without
  ordering within them, and ordering is the actual task — so the weights are
  `text-plot` alone, and the reasoning is recorded in `lib/reco.js` rather
  than in a commit message nobody will find.
- **Both colour kinds are absent, and that is a finding.** They probed at or
  below random (AUC 0.473 and 0.359). The colour system is the right
  substrate for the lookbook and is not one for recommendation.
- **Absence is a state, never a zero.** A book with no vector is unrankable
  and does not appear, rather than being scored zero and buried. Coverage is
  reported as its own metric.
- **A run is frozen when it is written.** Per-kind similarities and
  neighbours are stored alongside it, so an explanation still explains the
  thing it was about after the embeddings are versioned forward.
- **The guards run after scoring and before display**, because they are
  presentation rules: one book per author, nothing already read in any
  edition, and a small week-seeded rotation among near-equal scores so the
  same ten do not sit there forever. Deterministic within a week — a
  recommendation that changes on refresh is one nobody can act on.
- **Nothing on the page is a raw cosine.** The reader sees ranks, counts and
  percentages. "Of all 146, this one came closest" is the same arithmetic as
  `.84`, and it is the only one of the two that means anything.

Embedding runs in-process on `Xenova/bge-small-en-v1.5` — 384 dimensions,
L2-normalised at write, byte-identical across runs. This is the one part of
the product with a native dependency; see **Requirements**.

---

## Accounts and privacy

**`SECURITY.md` is the
honest accounting** — what is built, and what cannot be built without
infrastructure this deployment does not have (no real mail delivery, no KMS,
no CI, no backups). Read it before deploying anything.

- Argon2id at OWASP parameters, breach-checked passwords, no composition rules
- TOTP with replay prevention, passkeys, recovery codes, step-up re-auth
- Opaque revocable sessions that rotate on every privilege change
- Three-layer visibility — account, shelf, entry — enforced in SQL through a
  single `visibleSQL()` scope, never in templates
- Notes encrypted at rest, excluded from staff tooling, scrubbed from logs
- Deletion that actually deletes, on a schedule, leaving a tombstone
- A nonce-based CSP with no `unsafe-inline`

**A new account is public.** Shelves, entries and reviews all default to
"same as profile", so private-by-default made the entire library private and a
reader had to find a settings page before anybody could see a single thing
they had read.

§15's protection against throwaway impersonation accounts did not go away — it
moved to where it bites. A new account is **viewable** by anyone with the link
from the first minute, and **listed** — in `/readers`, in reader search — only
after seven days or ten books. An impersonator's account is worth something
only if it reaches people who were not looking for it.

**`search_indexable` stays off.** "Public" and "indexable by Google" are two
separate switches, and only the first is on.

---

## Environment

Everything has a working default; none of this is required to run locally.

| Variable | Default | What |
|---|---|---|
| `PORT` | `3000` | |
| `MARGIN_DB` | `data/margin.db` | Database file. Tests set this per-file |
| `MARGIN_KEY` / `MARGIN_KEY_FILE` | dev key | Note encryption at rest |
| `MARGIN_CSRF_SECRET` | falls back to `MARGIN_KEY` | Signs the double-submit token |
| `MARGIN_IP_SALT` | dev salt | Salts hashed IPs in the audit log |
| `MARGIN_CSP` | report-only | `enforce` makes violations break |
| `MARGIN_ORIGIN` / `MARGIN_BASE_URL` | localhost | Absolute URLs, passkey origin |
| `MARGIN_RP_ID` | localhost | WebAuthn relying party |
| `MARGIN_MAIL_TRANSPORT` | outbox | Mail is written to `data/outbox/` |
| `MARGIN_STAFF_ALLOWLIST` | — | CIDRs permitted to reach `/staff` |
| `MARGIN_TRUST_PROXY` | off | Set only behind a proxy you control |
| `ANTHROPIC_API_KEY` | — | Composition histories and season notes |
| `MARGIN_SECURITY_CONTACT` | — | The address in `/.well-known/security.txt` |
| `MARGIN_CHROME` | — | Path to a Chrome binary, for poster rendering |
| `MARGIN_COVER_DIR` `MARGIN_AVATAR_DIR` `MARGIN_POSTER_DIR` `MARGIN_EXPORT_DIR` `MARGIN_OUTBOX` | under `data/` | Where each kind of file is written |

Set secrets in the environment. A `.env` in this directory is gitignored, and
nothing in the repository reads one for you.

---

## Where things are

| Path | What |
|---|---|
| `server.js` | Middleware order, router mounts, CSP nonce |
| `db/schema*.sql`, `db/migrate.js` | Schema, and idempotent additive migrations |
| `lib/visibility.js` | The three-layer privacy model. Every read path goes through `visibleSQL()` |
| `lib/auth/` | Passwords, sessions, tokens, TOTP, passkeys, rate limits |
| `lib/accounts.js` | Usernames, confusable folding, account creation |
| `lib/notes.js` | Notes, encrypted at the application layer |
| `lib/audit.js` | The append-only audit log |
| `lib/scrub.js` | Log hygiene — wraps `console` so a careless log cannot leak |
| `lib/works.js`, `lib/library.js` | The work/edition graph; shelves and reading state |
| `lib/desk.js` | Search: parsing, trigram matching, filters |
| `lib/covers.js` | Cover resolution, English-edition preference, caching |
| `lib/seasons.js`, `lib/season-run.js` | Season definition, assignment, lifecycle |
| `lib/facts.js`, `lib/movements.js` | The fact engine; movements, including the empty one |
| `lib/lookbook-seasonal.js`, `lib/poster.js` | The catalogue and the poster |
| `lib/history.js` | Composition histories: retrieval, prompts, validation |
| `lib/colour.js`, `lib/colourway.js` | Jacket colour signatures, k-means in LAB |
| `lib/reviews.js`, `lib/clubs.js`, `lib/following.js`, `lib/readers.js` | The community layer |
| `lib/import.js`, `lib/import-run.js` | Format detection, the preview, and the write |
| `lib/parse-list.js`, `lib/parse-paste.js` | A list somebody typed; a table view somebody copied |
| `lib/goodreads-export.js`, `lib/supplement.js` | The 44-zip data export, and the three files that attach to books already here |
| `lib/embeddings.js` | The vector store. Frozen at write, normalised at write, absent when absent |
| `lib/reco.js`, `lib/reco-pile.js`, `lib/reco-season.js` | Profile and scoring; the pile; season complements |
| `lib/view-helpers.js` | Frames, stars, stamps, avatar plates, marks, barcodes |
| `routes/` | `pages`, `auth`, `settings`, `profile`, `community`, `clubs`, `seasons`, `lookbook`, `api`, `staff` |
| `public/css/margin.css` | The app. `public/css/lookbook.css` is deliberately a separate object |
| `scripts/check-*.mjs` | The static checks behind `npm run verify` |

---

## Every script

**Running**

| | |
|---|---|
| `npm start` | Serve on `PORT` |
| `npm run dev` | Serve, restarting on change |

**Database and accounts**

| | |
|---|---|
| `npm run seed` | A small library to look at |
| `npm run reset` | Delete the database and re-seed |
| `npm run reset:empty` | Delete the database and seed no books |
| `npm run dev:account` | An account that bypasses policy. Local only |
| `npm run claim` | Attach credentials to the already-seeded reader |
| `npm run accounts` | List accounts and their state |
| `npm run staff:add` | Grant a staff role |
| `npm run purge` | Run due deletions |
| `npm run migrate`, `npm run migrate:v05` | Version migrations. Each backs itself up first |

**Books**

| | |
|---|---|
| `npm run import:goodreads -- <csv>` | Import the full export |
| `npm run import:paste -- <txt> [--resolve]` | Import a copied table view |
| `npm run enrich -- --resolve` | Resolve unmatched books. Resumable |
| `npm run enrich -- --editions` | Fetch covers and sibling editions |
| `npm run covers`, `npm run audit:covers` | Fetch covers; report what is missing |
| `npm run subjects`, `npm run index` | Subject headings; rebuild the search index |
| `npm run spines` | Compute spine widths for the wall |
| `node scripts/covers-upgrade.mjs` | Replace low-resolution and foreign-language jackets |
| `node scripts/backfill-pages.mjs` | Fill missing page counts |

**Seasons**

| | |
|---|---|
| `npm run colours:derive` | Derive each book's colour from retrieved text |
| `npm run colours:audit` | The fifty-card review: distribution, collapse, setting leakage |
| `npm run colours` | The old jacket sampler — **retiring**, do not run |
| `npm run seasons` | Close what is due |
| `node scripts/histories.mjs [code] [--all] [--note] [--redo]` | Composition histories |
| `npm run gap:corpus` | Build the corpus behind The Gap |

**Recommendations**

| | |
|---|---|
| `npm run embed` | Embed every book that has text and no vector. Resumable |
| `npm run probe -- --kind <kind>` | Whether one embedding kind carries anything. Records the result |
| `npm run reco:eval` | Leave-one-out ranking, against a random baseline |
| `npm run reco:run` | Generate and store a pile run |

**Checking**

| | |
|---|---|
| `npm run verify` | Tests plus every static check |
| `npm test` | 590 tests |
| `npm run check:routes` / `:templates` / `:css` / `:dead` | Individually |
| `npm run test:csp` | Boot with CSP enforcing |

---

## Notes on the spec

Two places where the implementation departs from the written spec, both
recorded because the reasoning matters more than the outcome:

**Marginalia is not edition-scoped.** Scoping notes to an edition emptied the
margin whenever a reader switched editions, which violates §06's "never empty"
rule. Notes belong to the work; a note anchored to a different edition is
labelled with that edition's year, because a page number only means something
against a pagination.

**The colour swatch is gone.** v0.1's three-channel print metaphor (craft,
momentum, feeling as C/M/Y) was removed in a later pass. Jacket colour
sampling survives it and is what the season strip, the poster and the lookbook
are built from.

The specs this was built from, and the record of what happened when the
product was measured against them, are kept outside this repository.
