// Replay account-scoped reading updates, acknowledging each save exactly.
// The submit listener below supports legacy counter forms. On Press uses
// its own save handlers; this file alone does not make every control offline.

const account = document.querySelector('meta[name="margin-user"]')?.content;
const QUEUE_KEY = account ? `margin.queue.${account}` : null;
// Old queues did not record an owner and cannot safely be replayed.
try { localStorage.removeItem('margin.queue'); } catch { /* storage disabled */ }

const readQueue = () => {
  if (!QUEUE_KEY) return [];
  try {
    const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const writeQueue = (q) => {
  if (!QUEUE_KEY) return;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch { /* private mode: the log still posted, it just is not replayable */ }
};

// Sync state appears once, in the spine footer. No toast, no banner,
// no spinner (B7).
function renderQueueState() {
  const el = document.getElementById('queue-state');
  if (!el) return;
  const n = readQueue().length;
  el.textContent = n ? `${n} IMPRESSION${n === 1 ? '' : 'S'} QUEUED` : '';
}

let flushing = false;
async function flush() {
  if (flushing || !account || !navigator.onLine) return;
  const queue = readQueue();
  if (!queue.length) return;
  flushing = true;
  try {
    // Persist identities BEFORE sending, including older account-scoped
    // entries. A lost response must not turn the retry into a second log.
    for (const item of queue) item.id ||= crypto.randomUUID();
    writeQueue(queue);
    const saved = new Set();
    for (const item of queue) {
      try {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        const target = new URL(item.url, location.origin);
        if (target.origin !== location.origin || !/^\/work\/\d+\/log$/.test(target.pathname)) break;
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-requested-with': 'fetch',
            'x-reading-owner': account,
            'x-reading-request-id': item.id
          },
          body: new URLSearchParams({ ...item.body, _csrf: csrf || '' }),
          redirect: 'manual'
        });
        if (!res.ok) break;
        const reply = await res.json();
        if (reply.ok !== true || reply.requestId !== item.id) break;
        saved.add(item.id);
      } catch {
        // Preserve order: later cumulative positions must not pass a save
        // whose outcome is still unknown.
        break;
      }
    }
    // Keep entries queued while the requests were in flight.
    const remaining = readQueue().filter(item => !saved.has(item.id));
    writeQueue(remaining);
    renderQueueState();
    if (!remaining.length && saved.size) location.reload();
  } finally {
    flushing = false;
  }
}

// Counter submissions go through the queue when the network is down, so the
// form never blocks and the position is never lost.
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form.classList?.contains('counter')) return;
  if (navigator.onLine) return;

  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  const submitter = e.submitter;
  if (submitter?.name) body[submitter.name] = submitter.value;

  const queue = readQueue();
  queue.push({ id: crypto.randomUUID(), url: submitter?.formAction || form.action, body, at: Date.now() });
  writeQueue(queue);
  renderQueueState();

  // Render the new position immediately — the log is real to the reader the
  // moment they make it.
  const field = form.querySelector('.wheels');
  if (field && body.position) field.value = body.position;
});

addEventListener('online', flush);
renderQueueState();
flush();
