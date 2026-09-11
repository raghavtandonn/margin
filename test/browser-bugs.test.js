import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('import progress polling resumes after a temporary server error', async () => {
  const line = { dataset: { state: 'running', job: 'job-id' }, textContent: '' };
  const timers = [];
  let requests = 0, reloaded = false;
  runInNewContext(readFileSync(new URL('../public/js/import.js', import.meta.url), 'utf8'), {
    document: { getElementById: id => id === 'import-line' ? line : null },
    fetch: async () => ++requests === 1
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ state: 'done' }) },
    setTimeout: callback => timers.push(callback),
    location: { reload: () => { reloaded = true; } }
  });
  await new Promise(setImmediate);
  assert.equal(timers.length, 1, 'a transient error should schedule another poll');
  await timers.shift()();
  assert.equal(reloaded, true);
});

test('expired passkey enrollment opens reauthentication instead of parsing its HTML as JSON', async () => {
  let click, destination, created = 0;
  const button = { textContent: 'ADD PASSKEY', addEventListener: (name, fn) => { click = fn; } };
  const error = { hidden: true };
  runInNewContext(readFileSync(new URL('../public/js/passkey.js', import.meta.url), 'utf8'), {
    document: {
      getElementById: id => id === 'add-passkey' ? button : error,
      querySelector: () => ({ content: 'csrf' })
    },
    window: {
      PublicKeyCredential: {},
      location: { href: 'https://margin.example/settings/security', assign: value => { destination = value; } }
    },
    navigator: { credentials: { create: async () => { created++; } } },
    fetch: async () => ({ ok: true, redirected: true, url: 'https://margin.example/reauth?next=old',
      json: async () => { throw new Error('HTML is not JSON'); } }),
    URL
  });
  await click();
  assert.equal(destination, '/reauth?next=%2Fsettings%2Fsecurity');
  assert.equal(created, 0);
  assert.equal(error.hidden, true);
});
