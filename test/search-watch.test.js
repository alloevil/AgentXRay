// Unit tests for the extracted /api/search and /api/watch business logic:
// snippet extraction / keyword-AND matching (lib/search.js) and byte-offset
// advancement incl. torn-line hold-back (lib/watch.js). The hermetic HTTP
// harness (api.test.js / watch.test.js) keeps covering the route level.

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { extractSnippet, createSessionMatcher } = require(path.join(__dirname, '..', 'lib', 'search'));
const { readNewLines, parseWatchLines } = require(path.join(__dirname, '..', 'lib', 'watch'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));

describe('search snippet extraction', () => {
  it('centers a ±(40/60) window around the first keyword hit with ellipses', () => {
    const pad = 'x'.repeat(100);
    const text = `${pad} needle ${pad}`;
    const snippet = extractSnippet(text, 'needle');
    assert.ok(snippet.startsWith('\u2026'));
    assert.ok(snippet.endsWith('\u2026'));
    assert.ok(snippet.includes('needle'));
    // window: 40 before + keyword + 60 after (+2 ellipses)
    assert.equal(snippet.length, 40 + 'needle'.length + 60 + 2);
  });

  it('omits ellipses at text boundaries', () => {
    assert.equal(extractSnippet('needle here', 'needle'), 'needle here');
    const s = extractSnippet('needle' + 'y'.repeat(100), 'needle');
    assert.ok(!s.startsWith('\u2026'));
    assert.ok(s.endsWith('\u2026'));
  });

  it('matches case-insensitively against the lowercased keyword', () => {
    assert.equal(extractSnippet('The NEEDLE is here', 'needle'), 'The NEEDLE is here');
  });
});

describe('search session matcher', () => {
  it('requires every keyword across the session (AND), snippets from the first', () => {
    const m = createSessionMatcher(['alpha', 'beta']);
    m.consider('alpha only here', 'user', 't1');
    assert.equal(m.satisfied, false); // beta never seen
    m.consider('and beta elsewhere', 'assistant', 't2');
    assert.equal(m.satisfied, true);
    // Only the alpha-bearing message produced a snippet
    assert.equal(m.matches.length, 1);
    assert.equal(m.matches[0].role, 'user');
    assert.ok(m.matches[0].snippet.includes('alpha'));
  });

  it('caps snippets at 3 per session and reports done once all keywords seen', () => {
    const m = createSessionMatcher(['kw']);
    for (let i = 0; i < 5; i++) m.consider(`kw hit ${i}`, 'user', null);
    assert.equal(m.matches.length, 3);
    assert.equal(m.done, true);
    assert.equal(m.satisfied, true);
  });

  it('is unsatisfied when keywords appear but never the first keyword', () => {
    const m = createSessionMatcher(['zzz', 'kw']);
    m.consider('only kw here', 'user', null);
    assert.equal(m.satisfied, false); // zzz missing → no snippet either
    assert.equal(m.matches.length, 0);
  });
});

describe('watch offset advancement', () => {
  async function tmpFile(content) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-watch-'));
    const file = path.join(dir, 'session.jsonl');
    await fsp.writeFile(file, content);
    return { dir, file };
  }

  it('advances only past the last complete newline; a torn tail is held back', async () => {
    const { dir, file } = await tmpFile('{"a":1}\n{"b":2}\n{"torn":');
    try {
      const { lines, newOffset } = await readNewLines(file, 0);
      assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
      assert.equal(newOffset, '{"a":1}\n{"b":2}\n'.length);

      // Nothing new before the torn line completes
      const again = await readNewLines(file, newOffset);
      assert.deepEqual(again.lines, []);
      assert.equal(again.newOffset, newOffset);

      // Once the newline lands, exactly the completed line is delivered
      await fsp.appendFile(file, '3}\n');
      const third = await readNewLines(file, newOffset);
      assert.deepEqual(third.lines, ['{"torn":3}']);
      assert.equal(third.newOffset, newOffset + '{"torn":3}\n'.length);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty without moving the offset when the file has not grown', async () => {
    const { dir, file } = await tmpFile('{"a":1}\n');
    try {
      const first = await readNewLines(file, 0);
      const idle = await readNewLines(file, first.newOffset);
      assert.deepEqual(idle.lines, []);
      assert.equal(idle.newOffset, first.newOffset);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('a buffer with no newline at all yields nothing and keeps offset 0', async () => {
    const { dir, file } = await tmpFile('{"never-finished":');
    try {
      const { lines, newOffset } = await readNewLines(file, 0);
      assert.deepEqual(lines, []);
      assert.equal(newOffset, 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('parseWatchLines routes lines through the platform watchParse', () => {
  const lines = [
    JSON.stringify({ type: 'session', id: 's1', cwd: '/w', timestamp: 't0' }),
    JSON.stringify({
      type: 'message',
      id: 'm1',
      timestamp: 't1',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    'not json at all',
  ];
  const { messages, sessionMeta } = parseWatchLines(PLATFORMS.omp, lines);
  assert.deepEqual(sessionMeta, { id: 's1', cwd: '/w', timestamp: 't0' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content[0].text, 'hi');
});
