import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// ── §8 — outbound mail ───────────────────────────────────
//
// There is no SMTP credential in this environment and there is no sending
// domain, so nothing here can actually deliver a message. Rather than
// pretend, the default transport writes each message to `data/outbox/` and
// prints the actionable link to the console — which is what makes the whole
// verification and reset surface testable end to end.
//
// SPF, DKIM, and DMARC at p=reject are a DNS configuration, not code. They
// are listed in SECURITY.md under deployment gaps, unticked.

const here = dirname(fileURLToPath(import.meta.url));
const OUTBOX = process.env.MARGIN_OUTBOX || join(here, '..', 'data', 'outbox');

export const BASE_URL = (process.env.MARGIN_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// §8 — "no user-supplied content interpolated into subject lines or
// headers". A newline in a display name is a header injection, and the fix
// is to make it structurally impossible rather than to trust the caller.
const headerSafe = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);

// §16 — never log a full address. The local part is what identifies someone.
export const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '(invalid)';
  const head = local.slice(0, 2);
  return `${head}${'·'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};

const transports = {
  // Default. Writes the message where a developer or a test can read it.
  outbox({ to, subject, text }) {
    mkdirSync(OUTBOX, { recursive: true });
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const body = `To: ${to}\nSubject: ${subject}\nDate: ${new Date().toUTCString()}\n\n${text}\n`;
    writeFileSync(join(OUTBOX, `${id}.eml`), body);

    const link = /https?:\/\/\S+/.exec(text)?.[0];
    console.log(`  ✉  ${maskEmail(to)} — ${subject}`);
    if (link) console.log(`     ${link}`);
    return { id };
  },

  // A real deployment sets MARGIN_SMTP_URL and supplies this.
  async smtp(message) {
    throw new Error(
      'SMTP transport is not configured. Set MARGIN_SMTP_URL and provide a sender, ' +
      'or leave MARGIN_MAIL_TRANSPORT unset to use the local outbox.'
    );
  }
};

export async function send({ to, subject, text }) {
  const name = process.env.MARGIN_MAIL_TRANSPORT || 'outbox';
  const transport = transports[name];
  if (!transport) throw new Error(`unknown mail transport: ${name}`);

  return transport({
    to: headerSafe(to),
    subject: headerSafe(subject),
    // Only the body may carry arbitrary text, and it is never interpreted.
    text: String(text ?? '')
  });
}

// ── The messages ─────────────────────────────────────────
// §17 — the copy voice is the product's: sparse, lowercase-leaning, no
// exclamation marks, no "Welcome back!", no emoji. These read like a note
// from a person who runs a press, because that is the whole conceit.

const url = (path) => `${BASE_URL}${path}`;

export const mail = {
  verify: (to, token) => send({
    to,
    subject: 'Confirm your address',
    text:
      `Confirm this address to finish setting up your account.\n\n` +
      `${url(`/verify?token=${token}`)}\n\n` +
      `The link is good for 24 hours. If you didn't sign up, ignore this and ` +
      `the account will be removed within a week.`
  }),

  // §5 — signing up with an address that already has an account must not
  // confirm that it does. The screen says "check your email" either way, and
  // THIS is what arrives, so the existing owner learns about the attempt.
  alreadyRegistered: (to) => send({
    to,
    subject: 'Someone tried to register with your address',
    text:
      `Someone tried to create an account with this address. It already has one, ` +
      `so nothing was created and nothing changed.\n\n` +
      `If that was you, sign in instead:\n${url('/signin')}\n\n` +
      `If you've forgotten your password:\n${url('/reset')}`
  }),

  reset: (to, token) => send({
    to,
    subject: 'Reset your password',
    text:
      `A password reset was requested for this account.\n\n` +
      `${url(`/reset/${token}`)}\n\n` +
      `The link is good for 15 minutes and can be used once. If you didn't ask ` +
      `for it, nothing has happened and you can ignore this.`
  }),

  passwordChanged: (to) => send({
    to,
    subject: 'Your password changed',
    text:
      `The password on your account was changed just now, and every other ` +
      `signed-in device was signed out.\n\n` +
      `If this wasn't you, reset it immediately:\n${url('/reset')}`
  }),

  emailChange: (to, token) => send({
    to,
    subject: 'Confirm your new address',
    text:
      `Confirm this address to move your account to it.\n\n` +
      `${url(`/settings/email/confirm?token=${token}`)}\n\n` +
      `The link is good for 24 hours. Until you use it, the account keeps its ` +
      `old address.`
  }),

  // §8 — this is the message that catches a takeover in progress, which is
  // why it goes to the OLD address and carries a revoke link.
  emailChangeNotice: (to, newEmail, revokeToken) => send({
    to,
    subject: 'Your address is being changed',
    text:
      `A request was made to move this account to ${maskEmail(newEmail)}.\n\n` +
      `If that was you, no action is needed. Confirm from the new address.\n\n` +
      `If it was not, stop it here:\n${url(`/settings/email/revoke?token=${revokeToken}`)}\n\n` +
      `That link works for 72 hours and will also sign out every device and ` +
      `force a password reset.`
  }),

  // §5 — a login from somewhere new, with a one-click way to undo it.
  newDevice: (to, { when, device, place, token }) => send({
    to,
    subject: 'A new sign-in',
    text:
      `Your account was signed into from a device we haven't seen before.\n\n` +
      `  when    ${when}\n` +
      `  device  ${device}\n` +
      `  place   ${place}\n\n` +
      `If that was you, there's nothing to do.\n\n` +
      `If it wasn't, this signs out every device and forces a reset:\n` +
      `${url(`/security/not-me?token=${token}`)}`
  }),

  recoveryCodeUsed: (to, remaining) => send({
    to,
    subject: 'A recovery code was used',
    text:
      `One of your recovery codes was just used to sign in. ` +
      `${remaining} ${remaining === 1 ? 'code remains' : 'codes remain'}.\n\n` +
      (remaining < 3
        ? `That's running low. Generate a new set:\n${url('/settings/security')}\n\n`
        : '') +
      `If this wasn't you, reset your password now:\n${url('/reset')}`
  }),

  exportReady: (to, token) => send({
    to,
    subject: 'Your export is ready',
    text:
      `Everything in your library, as JSON and CSV.\n\n` +
      `${url(`/settings/export/${token}`)}\n\n` +
      `The link is good for one hour and can be used once.`
  }),

  deletionScheduled: (to, when) => send({
    to,
    subject: 'Your account is scheduled for deletion',
    text:
      `Your account will be deleted on ${when}, along with every book, note, ` +
      `and rating in it.\n\n` +
      `Until then, signing in cancels the deletion. After it, nothing can be ` +
      `recovered. That is the point of it.\n\n` +
      `${url('/signin')}`
  })
};
