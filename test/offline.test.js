import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/js/offline.js', import.meta.url), 'utf8');
const key = 'margin.queue.reader-a';
const entry = () => ({ id: randomUUID(), url: '/work/1/log', body: { advance: '10', _csrf: 'old-token' } });
function browser(queue, fetcher) {
  const storage = new Map([[key, JSON.stringify(queue)]]);
  const events = new Map();
  let reloads = 0;
  const context = {
    document: {
      querySelector: selector => ({ content: selector.includes('margin-user') ? 'reader-a' : 'current-token' }),
      getElementById: () => null,
      addEventListener: () => {}
    },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, value) => storage.set(k, value),
      removeItem: k => storage.delete(k)
    },
    navigator: { onLine: false },
    location: { origin: 'https://margin.example', reload: () => reloads++ },
    crypto: { randomUUID }, URL, URLSearchParams,
    fetch: fetcher,
    addEventListener: (name, fn) => events.set(name, fn)
  };
  runInNewContext(source, context);
  return {
    flush: () => { context.navigator.onLine = true; return events.get('online')(); },
    queue: () => JSON.parse(storage.get(key)),
    append: item => storage.set(key, JSON.stringify([...JSON.parse(storage.get(key)), item])),
    reloads: () => reloads
  };
}

test('offline replay removes only explicitly acknowledged updates and sends the current account and CSRF proof', async () => {
  const item = entry();
  const b = browser([item], async (url, request) => {
    assert.equal(url.pathname, '/work/1/log');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers['x-requested-with'], 'fetch');
    assert.equal(request.headers['x-reading-owner'], 'reader-a');
    assert.equal(request.body.get('_csrf'), 'current-token');
    return { ok: true, json: async () => ({ ok: true, requestId: item.id }) };
  });
  await b.flush();
  assert.deepEqual(b.queue(), []);
  assert.equal(b.reloads(), 1);
});

test('a lost save response retries with the same ID and holds later updates in order', async () => {
  const first = entry(), second = entry(), attempts = [];
  const b = browser([first, second], async (url, request) => {
    const id = request.headers['x-reading-request-id'];
    attempts.push(id);
    if (attempts.length === 1) throw new Error('Response lost after saving');
    return { ok: true, json: async () => ({ ok: true, requestId: id }) };
  });
  await b.flush();
  assert.equal(b.queue().length, 2);
  assert.deepEqual(attempts, [first.id]);
  await b.flush();
  assert.deepEqual(attempts, [first.id, first.id, second.id]);
  assert.deepEqual(b.queue(), []);
});

test('redirects, account changes, and unrelated successful responses never consume queued updates', async () => {
  for (const response of [
    { ok: false, status: 302 }, { ok: false, status: 409 },
    { ok: true, json: async () => ({ ok: true, requestId: 'different' }) }
  ]) {
    const b = browser([entry()], async () => response);
    await b.flush();
    assert.equal(b.queue().length, 1);
    assert.equal(b.reloads(), 0);
  }
});

test('updates added during replay survive and overlapping flushes do not double-send', async () => {
  const first = entry(), second = entry();
  let resolveFetch, sent = 0;
  const b = browser([first], async () => {
    sent++;
    return new Promise(resolve => { resolveFetch = resolve; });
  });
  const flushing = b.flush();
  b.append(second);
  await b.flush();
  resolveFetch({ ok: true, json: async () => ({ ok: true, requestId: first.id }) });
  await flushing;
  assert.equal(sent, 1);
  assert.deepEqual(b.queue(), [second]);
  assert.equal(b.reloads(), 0);
});
