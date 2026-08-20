// SSE /api/watch tests: exercise the byte-offset advance logic against a live
// server. The torn-line case is the regression guard — a writer appending a
// JSONL line in two chunks must not lose the message (the plain-JSONL branch
// must only advance past the last complete newline, like the zstd branch).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('./helpers.js');

const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
const OMP1_FILE = path.join(
  '.omp',
  'agent',
  'sessions',
  '-fixtures-project-gamma',
  '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal SSE client: connects, collects {event, data} pairs, skips pings.
async function connectSse(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);
  const events = [];
  let buffer = '';
  const decoder = new TextDecoder();
  (async () => {
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted on close */
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    async waitFor(name, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.event === name);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for SSE event ${name}`);
        await sleep(25);
      }
    },
  };
}

function ompUserLine(id, text) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-20T09:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' },
  });
}

describe('watch SSE', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('a torn line is held back until its newline lands, then delivered intact', async () => {
    const sse = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
    try {
      const connected = await sse.waitFor('connected');
      assert.ok(connected.data.messageCount > 0);

      const filePath = path.join(srv.home, OMP1_FILE);
      const torn = ompUserLine('om-5', 'fixture: torn-line survivor');
      const follower = ompUserLine('om-6', 'fixture: post-torn message');

      // Write only half of the line — the watcher must neither emit anything
      // nor advance its offset past the incomplete tail.
      await fsp.appendFile(filePath, torn.slice(0, 40));
      await sleep(400); // debounce is 80ms; give the change event time to fire
      assert.deepEqual(
        sse.events.filter((e) => e.event === 'newMessages'),
        []
      );
      assert.deepEqual(
        sse.events.filter((e) => e.event === 'error'),
        []
      );

      // Complete the torn line and append a second full line: both messages
      // must arrive, in order, with the torn one intact.
      await fsp.appendFile(filePath, `${torn.slice(40)}\n${follower}\n`);
      const ev = await sse.waitFor('newMessages');
      const texts = ev.data.messages.map((m) => m.content[0].text);
      assert.deepEqual(texts, ['fixture: torn-line survivor', 'fixture: post-torn message']);
    } finally {
      sse.close();
    }
  });
});
