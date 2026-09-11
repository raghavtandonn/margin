// ── PASSKEY ENROLMENT ────────────────────────────────────
//
// The half of §6 that was never written.
//
// /settings/security has an ADD A PASSKEY button, and the server has all
// three endpoints behind it — options, register, remove — but nothing ever
// connected them, so the button did nothing at all. A security control that
// looks present and is inert is worse than one that is absent: somebody
// clicks it, sees no error, and reasonably concludes they now have a
// passkey.

const button = document.getElementById('add-passkey');
const errorLine = document.getElementById('passkey-error');

if (button && window.PublicKeyCredential) {
  // ── base64url ↔ ArrayBuffer ────────────────────────────
  // WebAuthn speaks ArrayBuffers and JSON does not. The server (via
  // SimpleWebAuthn) sends and expects base64url, which is base64 with two
  // characters swapped and the padding dropped.
  const toBuffer = (s) => {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  };

  const toB64url = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {})
    });
    // Fresh-auth middleware returns a page redirect, including when the
    // session expires between the two enrollment requests. Return to the
    // settings page afterward, not to a POST-only enrollment endpoint.
    if (res.redirected) {
      const target = new URL(res.url, window.location.href);
      if (target.pathname === '/reauth' || target.pathname === '/signin') {
        window.location.assign(`${target.pathname}?next=%2Fsettings%2Fsecurity`);
        const error = new Error('Authentication required');
        error.name = 'AbortError';
        throw error;
      }
    }
    return res;
  };

  const fail = (message) => {
    if (!errorLine) return;
    errorLine.textContent = message;
    errorLine.hidden = false;
  };

  button.addEventListener('click', async () => {
    if (errorLine) errorLine.hidden = true;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'WAITING FOR YOUR DEVICE…';

    try {
      const res = await post('/settings/security/passkey/options');
      if (!res.ok) throw new Error('Could not start. Try signing in again.');
      const { options, challengeId } = await res.json();

      // Everything the browser needs as bytes rather than as text.
      const publicKey = {
        ...options,
        challenge: toBuffer(options.challenge),
        user: { ...options.user, id: toBuffer(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({
          ...c, id: toBuffer(c.id)
        }))
      };

      const credential = await navigator.credentials.create({ publicKey });
      if (!credential) throw new Error('No passkey was created.');

      const response = {
        id: credential.id,
        rawId: toB64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: toB64url(credential.response.clientDataJSON),
          attestationObject: toB64url(credential.response.attestationObject),
          transports: credential.response.getTransports?.() || []
        }
      };

      const saved = await post('/settings/security/passkey', {
        challengeId,
        response,
        // Named for where it lives, which is the only thing the browser can
        // tell us and the only thing worth showing in the list.
        nickname: navigator.platform || 'Passkey'
      });

      if (!saved.ok) {
        const body = await saved.json().catch(() => ({}));
        throw new Error(body.error || 'That passkey could not be saved.');
      }

      // The list of keys is rendered server-side, so the new one appears on
      // reload rather than being drawn twice in two places.
      window.location.reload();
    } catch (err) {
      // A user who dismisses the system prompt has not hit an error, and
      // telling them they have is its own small insult.
      const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      if (!cancelled) fail(err?.message || 'That did not work.');
      button.disabled = false;
      button.textContent = label;
    }
  });
} else if (button) {
  // No WebAuthn in this browser. Say so on the control itself rather than
  // leaving a button that silently does nothing, which is the bug this file
  // exists to fix.
  button.disabled = true;
  button.textContent = 'PASSKEYS ARE NOT AVAILABLE IN THIS BROWSER';
}
