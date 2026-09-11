# "MARGIN" — security

What is implemented, and what is not. The second list is the more useful one.

Everything below maps to a section of `docs/accounts-and-security-spec.md`.

The [7 September 2026 security review](docs/security-audit-2026-09-07.md) records confirmed issues, fixes, regression coverage, migration behavior, and remaining deployment work. It supersedes older implementation claims where they differ; this document is not a security certification.

---

## Implemented

### §4 Registration
- Email/password registration, email normalised by trimming and lowercasing only — Gmail dots and plus-addressing are preserved, because deduplicating them silently merges two people's accounts.
- Argon2id via `hash-wasm` at OWASP parameters (`m=19456 KiB, t=2, p=1`), encoded string stored, transparent rehash on sign-in when parameters are below policy.
- NIST SP 800-63B policy: 8-character minimum, all Unicode, **no composition rules, no forced rotation**.
- Breach check against Have I Been Pwned via the k-anonymity range API — only the first five hex characters of the SHA-1 leave the process. Falls back to a bundled list when the API is unreachable, so being offline never silently skips the check.
- NFKC normalisation before hashing.
- Verification links: 32 bytes CSPRNG, stored hashed, single-use, 24-hour expiry, consumed atomically inside a transaction.
- Username chosen **after** verification, so a throwaway signup cannot squat a name.
- Unverified accounts work privately, cannot publish anything, and are purged after 7 days.

### §5 Authentication
- Sign in by email or username.
- Enumeration-safe: identical body, status, and timing. A dummy Argon2 verification runs against a fixed hash when the account does not exist — measured at a **0.4 ms** median difference (`test/auth.test.js`).
- One failure message: `Those details don't match.`
- Registering an existing address returns the same screen and mails that address a "someone tried to register" notice.
- Layered rate limits: per-IP auth (20/10 min), per-IP registration (5/hr), per-email verify and reset (3/hr), and per-account exponential backoff (5 free, then 30 s doubling to a 15-minute cap).
- **Backoff, never lockout.** The per-account counter is persisted, so restarting the process is not a free reset of an attacker's budget.
- Circuit breaker alerts on abnormal auth volume without locking anyone out.
- New-device sign-in notice with a one-click "this wasn't me" that revokes every session and forces a reset.

### §6 Two-factor and passkeys
- TOTP: RFC 6238, SHA-1, 6 digits, 30-second step, ±1 drift. Verified against the RFC's own published test vectors.
- **Replay prevention.** `last_used_step` is stored, and any code at or below it is refused — checked and written inside one `BEGIN IMMEDIATE` transaction so two racing requests cannot both pass. This is the gap §6 identifies in Letterboxd's implementation.
- Secrets envelope-encrypted at rest, never logged, never returned after enrollment. Enrollment requires one valid code before it is switched on.
- **No SMS. No email as a second factor.**
- Recovery codes: 10, single-use, Argon2id-hashed, displayed once, consumption warns by email, prompt to regenerate below three.
- Passkey enrollment via `@simplewebauthn/server`, with fresh authentication and authenticator user verification required. Multiple credentials can be named and revoked. Enrollment does not raise session assurance. Authentication library functions exist, but passkey sign-in routes are not yet wired.
- Step-up re-authentication (5-minute freshness) on password change, email change, 2FA disable, passkey enrollment/removal, export, and deletion. Accounts with TOTP enabled must supply it during reauthentication.

### §7 Sessions
- Opaque 32-byte tokens, stored as SHA-256. Not JWTs, because revocation is the point.
- `HttpOnly; Secure; SameSite=Lax; Path=/`, `__Host-` prefix in production.
- Idle 30 days, absolute maximum 90, sliding refresh.
- **Token rotates on every privilege change** — login, password change, 2FA toggle, step-up. The pre-rotation token stops resolving immediately.
- Password change and reset revoke every other session; the settings list shows device, last active, and a revoke per row.

### §8 Reset and email change
- Identical response whether or not the address exists.
- Reset tokens: 15 minutes, single-use, consumed atomically.
- **A reset does not bypass 2FA.** A second factor or recovery code is required, and it is demanded *before* the token is consumed, so a wrong code does not burn the link.
- Email change: step-up required, confirmation to the new address, and a 72-hour revoke link to the old address — which is what catches a takeover in progress.

### §9 Profile and avatars
- Six fields, and no more: display name, bio (280, plain text), avatar, location, one link, username.
- Username rules: 3–20 `[a-z0-9_]`, reserved list including every route, changeable once per 30 days, old name held 90 days.
- **Confusable normalisation** — `аdmin` with a Cyrillic а is refused, as is a homograph of a taken name.
- `/@username`, returning **404 for private profiles**, never 403.
- Avatars: magic-byte validation, server-side re-encode, all metadata stripped, randomised keys, 5 MB cap enforced while reading rather than after.
  - `sips` does **not** strip EXIF — it carries it into the PNG as an `eXIf` chunk and adds `iTXt` (usually XMP). Both can hold GPS. Chunks are stripped explicitly against a keep-list, and the result asserted.

### §10 Privacy
- Shelf collections use account, shelf, and shelf-entry visibility. Reading history follows the profile; individual reads have no privacy setting, and a private shelf does not hide its books from reading history.
- Shared SQL visibility helpers in `lib/visibility.js` scope public reads. Regression tests cover the repaired profiles, receipts, seasons, lookbooks, and reader comparisons; new read paths must apply these helpers too.
- `search_indexable` separate from `public`, defaulting off, driving `X-Robots-Tag`, `robots.txt`, and the sitemap.
- Visible counts are counts of *what the viewer may see*, so a private item cannot be inferred by subtraction.

### §11 Notes
- Never public: there is no visibility setting for a note, by construction.
- AES-256-GCM at the application layer, per-record keys derived by HKDF from a root key held outside the database.
- Excluded from staff tooling entirely — there is no gated view of note bodies at all.
- Log scrubber wrapping `console` itself, with tests asserting no password, token, note body, Argon2 hash, or full email address survives.
- Excluded from every public and API path (tested across seven).
- Purged in the **first** pass of account deletion.
- Private notes are searched in memory for their owner; the shared desk index stores catalogue metadata only. Imported notes, session notes, and season captions are encrypted, with legacy-row migration on startup. Historical backups may still contain older plaintext copies.

### §12 Import, export, deletion
- CSV parsing that survives Goodreads' embedded newlines, inconsistent quoting, and `=""ISBN""` escaping.
- **Formula-injection escaping on export** for `=`, `+`, `-`, `@`, tab, and CR.
- Export: JSON + CSV in a zip, step-up required, single-use link expiring in an hour, 2/day. Export completeness for newer features, including supplementary imported notes, still needs reconciliation with the schema.
- Deletion: 30-day grace with a stated date, then a hard delete of books, notes, sessions, tokens, credentials, and avatar files, leaving a tombstone of id, timestamp, and a salted email hash.

### §13 Application security
- Nonce-based CSP with **no `unsafe-inline`**. It defaults to report-only; set `MARGIN_CSP=enforce` and exercise the current UI in a browser before deployment. The September review did not repeat historical browser CSP checks.
- HSTS (over TLS), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, CORP, `frame-ancestors 'none'`, `base-uri 'none'`, no `X-Powered-By`.
- Signed double-submit CSRF on every state-changing request.
- Parameterised queries throughout; sort columns validated against an allowlist.
- Boundary validation that **rejects** unknown fields rather than ignoring them.
- Ownership derived from the session, never from a parameter; IDOR returns 404.

### §14 Admin and audit
- Staff in a **separate table** with a separate login route and no shared session.
- Mandatory 2FA for staff, with no opt-out.
- IP allowlist evaluated **before** authentication, answering 404.
- Step-up for every data-reading action, not once per session.
- Member lookup returns a hard-coded field list with a masked email, requires a written reason, and writes the audit row **before** rendering.
- The bulk export requires a **second staff member's approval**; self-approval is refused.
- `audit_log` is append-only, enforced by SQLite triggers rather than by convention.
- `affectedBy()` answers §14's question — given a staff account and a window, exactly which members and which fields — in one query.
- Anomaly detection for bulk access, out-of-hours access, and every export.

### Seasons (`docs/seasons-and-lookbook-spec.md`)
- The season note is written locally by default. With local-only on — the default — **zero outbound requests occur at season close**, asserted by a test that counts `fetch` calls.
- Note excerpts are not assembled at all under local-only, rather than assembled and then withheld.
- Lookbooks and generated posters are accessed through the signed-in owner's personal routes. The old public lookbook URL returns 404. Separate closed-season history pages remain on profiles and exclude personal notes.
- A hidden book appears in no frame and in no poster.

### §15 Abuse
- **The public API enforces the same `visibleTo` scope as the web app.** It did not: it served a private account's whole shelf list and reading receipt to anonymous callers under `Access-Control-Allow-Origin: *`, and `/work/:id/passes` read a hard-coded `getUser(1)` and handed out the first account's reading history to anyone. Both are fixed and covered by tests. CORS is now open for the catalogue only.
- The community layer includes reviews, replies, reactions, and clubs. These require authorization, visibility, moderation, and abuse controls alongside the reading library.
- Verification required before any public action; new accounts cannot go public until 7 days or 10 books.
- Write rate limits; abuse reports with a real staff queue.

---

## Not implemented, and why

These are honest gaps, not oversights. Nothing above is weakened to hide one.

### Requires infrastructure this deployment does not have

| Spec | Status |
|---|---|
| **SPF, DKIM, DMARC at `p=reject`** | Not configured — DNS on a sending domain, not code. The mailer writes to `data/outbox/` and prints links; `MARGIN_MAIL_TRANSPORT=smtp` is the seam for a real sender. **No mail is actually delivered.** |
| **KMS-held envelope keys** | The root key is a local 0600 file (or `MARGIN_KEY`). Encryption protects encrypted fields when the database is taken without its key; historical backups may still contain plaintext from older versions. Hardware custody, rotation, and per-use audit are not implemented. |
| **Postgres row-level security** (§13.4 backstop) | SQLite has none. `lib/visibility.js` is therefore load-bearing alone, which is why it has its own test file. |
| **Redis-backed rate limiting** | In-process. Correct for one process, wrong the moment there are two. The per-account backoff is persisted for exactly this reason. |
| **Avatars on a separate domain / CDN bucket** | One origin, no object storage. Mitigated by serving from outside the static root with a pinned `Content-Type`, `nosniff`, and a sandboxed CSP of its own. The XSS-on-app-origin attack is closed; the same-origin separation is not. |
| **CDN cache purge on visibility change** | No CDN. |
| **Cloudflare Turnstile** | Needs keys. Registration is gated by email verification and per-IP limits instead. |
| **Sentry** | No DSN. `lib/scrub.js` `forReporter()` is the seam, and it scrubs before anything would leave. |
| **CI: `npm audit`, gitleaks, CodeQL/Semgrep, Dependabot** | No CI. Four direct dependencies (`express`, `ejs`, `hash-wasm`, `@simplewebauthn/server`) plus their transitive dependencies. The September local audit reported zero known vulnerabilities in the updated lockfile. |
| **Encrypted automated backups + quarterly restore drill** | Not set up. **An untested backup is not a backup** — and there is no backup. |
| **TLS 1.2+/HSTS preload** | A deployment concern. HSTS is emitted only when the request is already HTTPS. |
| **External penetration test / OWASP ASVS L2 pass** | Not done. §16 makes this a precondition for a real launch. |

### Deliberately deferred

- **§9 avatar re-encode is macOS-only.** It shells out to `sips`, as the spine sampler already does. A Linux deployment needs the same three steps (magic-byte check → re-encode → strip metadata → assert) through libvips or ImageMagick. `stripPngMetadata()` is platform-independent and stays as-is.
- **§12 import runs synchronously.** The `import_jobs` table and preview/confirm flow exist; the job is not yet driven by a queue.
- **IP geolocation** for the new-device email says `unknown`. Adding it means sending reader IPs to a third party, which is a poor trade for one line of an email.
- **§14 quarterly access review** is a process, not code. There is no runbook.

---

## Reporting

`/.well-known/security.txt` carries the contact address. Set `MARGIN_SECURITY_CONTACT` before deploying — it defaults to an `example.invalid` address that goes nowhere.

## Configuration that must be set before deploying

```
MARGIN_KEY               root key for note encryption (or a keyfile at secrets/master.key)
MARGIN_CSRF_SECRET       falls back to MARGIN_KEY, then a key derived from the installation keyfile
MARGIN_IP_SALT           rotating-salt seed for IP hashing
MARGIN_BASE_URL          absolute HTTPS origin, used in every emailed link
MARGIN_RP_ID             WebAuthn relying-party id — a passkey is bound to it permanently
MARGIN_ORIGIN            WebAuthn expected origin
MARGIN_STAFF_ALLOWLIST   exact IPs/CIDRs; production denies all by default, development allows loopback
MARGIN_SECURITY_CONTACT  security.txt contact
MARGIN_CSP=enforce       CSP is Report-Only by default (§13.1, §18.14)
MARGIN_TRUST_PROXY       only where a proxy is genuinely in front
NODE_ENV=production      enables Secure cookies and the __Host- prefix
```

**Back up `secrets/master.key`.** Losing it makes every stored note permanently unreadable.

---

## Tests

`npm run verify` — 579 passing tests after the product corrections, plus route, template, and SQL literal checks. Security-focused files include:

```
test/visibility.test.js   the three-layer model, IDOR, the publish gate
test/auth.test.js         timing parity, backoff, TOTP replay, rotation, reset-vs-2FA
test/data.test.js         CSV injection, EXIF, log scrubbing, note encryption, purge, audit
test/http.test.js         the real server: IDOR 404s, profile leaks, CSRF, headers,
                          and the public API's scope
test/security-regressions.test.js  cross-account notes, migration, purge, ZIP limits,
                                  club authorization, profile-scoped reading history, async errors, IP boundaries
test/offline.test.js      save acknowledgements, stable retry IDs, ordered replay, concurrent queue changes
```
