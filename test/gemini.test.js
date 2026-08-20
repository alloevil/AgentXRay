// Gemini CLI adapter tests: record-stream folding ($rewindTo/$set/id overwrite),
// normalization (thoughts → reasoning, inline tool results), and the API
// surface over the fixture sessions (test/fixtures/home/.gemini/tmp —
// <projectHash>/chats/session-*.jsonl, one plain session, one exercising
// /rewind, plus a nested subagent transcript that must stay out of the list).

const { describe, it, before, after } = require('node:test');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gemini = require(path.join(__dirname, '..', 'lib', 'platforms', 'gemini'));
const { startServer, getJson } = require('./helpers.js');

const GEM_PLAIN = 'gemini-fixture-session-0001';
const GEM_REWIND = 'gemini-fixture-session-0002';

// --- record-stream folding ---

test('foldGeminiRecords honors $rewindTo: the target and everything after it drop', () => {
  const lines = [
    JSON.stringify({ sessionId: 's', startTime: 't0' }),
    JSON.stringify({ id: 'a', type: 'user', content: 'one' }),
    JSON.stringify({ id: 'b', type: 'gemini', content: 'two' }),
    JSON.stringify({ id: 'c', type: 'user', content: 'three' }),
    JSON.stringify({ $rewindTo: 'b' }),
    JSON.stringify({ id: 'd', type: 'user', content: 'four' }),
  ];
  const { metadata, messages } = gemini.foldGeminiRecords(lines);
  assert.equal(metadata.sessionId, 's');
  assert.deepEqual(
    messages.map((m) => m.id),
    ['a', 'd']
  );
});

test('foldGeminiRecords applies $set: metadata merges and $set.messages replaces history', () => {
  const lines = [
    JSON.stringify({ sessionId: 's', startTime: 't0' }),
    JSON.stringify({ id: 'a', type: 'user', content: 'old' }),
    JSON.stringify({ $set: { lastUpdated: 't9', messages: [{ id: 'z', type: 'user', content: 'checkpoint' }] } }),
  ];
  const { metadata, messages } = gemini.foldGeminiRecords(lines);
  assert.equal(metadata.lastUpdated, 't9');
  assert.deepEqual(
    messages.map((m) => m.id),
    ['z']
  );
});

test('foldGeminiRecords lets a re-appended id supersede the earlier record', () => {
  const lines = [
    JSON.stringify({ id: 'a', type: 'gemini', content: 'draft' }),
    JSON.stringify({ id: 'b', type: 'user', content: 'next' }),
    JSON.stringify({ id: 'a', type: 'gemini', content: 'final' }),
  ];
  const { messages } = gemini.foldGeminiRecords(lines);
  assert.deepEqual(
    messages.map((m) => [m.id, m.content]),
    [
      ['b', 'next'],
      ['a', 'final'],
    ]
  );
});

test('foldGeminiRecords reads legacy single-line sessions with an inline messages[] array', () => {
  const lines = [
    JSON.stringify({ sessionId: 'legacy', startTime: 't0', messages: [{ id: 'a', type: 'user', content: 'hi' }] }),
  ];
  const { metadata, messages } = gemini.foldGeminiRecords(lines);
  assert.equal(metadata.sessionId, 'legacy');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'a');
});

// --- normalization ---

test('normalizeGeminiRecord fans a gemini record into reasoning, assistant, toolCall and toolResult', () => {
  const rec = {
    id: 'g1',
    timestamp: 'T',
    type: 'gemini',
    model: 'gemini-2.5-pro',
    thoughts: [{ subject: 'Plan', description: 'think' }],
    content: [{ text: 'answer' }],
    tokens: { input: 10, output: 5, cached: 3, thoughts: 2 },
    toolCalls: [{ id: 'c1', name: 'read_file', args: { path: '/x' }, result: [{ text: 'data' }], status: 'success' }],
  };
  const out = gemini.normalizeGeminiRecord(rec);
  assert.deepEqual(
    out.map((m) => m.role),
    ['reasoning', 'assistant', 'toolCall', 'toolResult']
  );
  assert.equal(out[0].content[0].text, 'Plan: think');
  assert.equal(out[1].model, 'gemini-2.5-pro');
  assert.deepEqual(out[1].usage, { input: 10, output: 5, cacheRead: 3, reasoning: 2 });
  assert.equal(out[2].toolCallId, 'c1');
  assert.deepEqual(out[2].details, { path: '/x' });
  assert.equal(out[3].toolCallId, 'c1');
  assert.equal(out[3].toolName, 'read_file');
  assert.equal(out[3].content[0].text, 'data');
  assert.equal(out[3].isError, false);
});

test('normalizeGeminiRecord marks error/cancelled tool calls without a result as failed results', () => {
  const out = gemini.normalizeGeminiRecord({
    id: 'g2',
    type: 'gemini',
    content: '',
    toolCalls: [{ id: 'c2', name: 'run_shell_command', args: {}, status: 'cancelled' }],
  });
  const result = out.find((m) => m.role === 'toolResult');
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('cancelled'));
});

test('normalizeGeminiRecord drops info/warning CLI chrome', () => {
  assert.deepEqual(gemini.normalizeGeminiRecord({ id: 'i', type: 'info', content: 'noise' }), []);
});

test('extractGeminiUserPromptText skips slash/at commands and empty content', () => {
  assert.equal(gemini.extractGeminiUserPromptText({ type: 'user', content: '/rewind' }), null);
  assert.equal(gemini.extractGeminiUserPromptText({ type: 'user', content: '  ' }), null);
  assert.equal(gemini.extractGeminiUserPromptText({ type: 'user', content: 'real prompt' }), 'real prompt');
});

// --- API surface over the fixtures ---

describe('sessions: gemini', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('lists sessions newest-first with metadata, excluding nested subagent transcripts', async () => {
    const sessions = await getJson(srv.base, '/api/gemini/sessions');
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((s) => s.id),
      [GEM_REWIND, GEM_PLAIN]
    );

    const plain = sessions[1];
    assert.equal(plain.timestamp, '2026-01-20T10:00:00.000Z');
    assert.equal(plain.lastActivity, '2026-01-20T10:05:00.000Z');
    assert.equal(plain.cwd, '/fixtures/project-zeta');
    assert.equal(plain.userCount, 1);
    assert.equal(plain.assistantCount, 1);
    assert.equal(plain.toolCallCount, 1);
    assert.equal(plain.toolResultCount, 1);
    assert.ok(plain.firstUserMessage.startsWith('fixture: gemini-needle-zeta'));
    assert.deepEqual(plain.topTools, [{ name: 'list_directory', count: 1 }]);
    assert.deepEqual(plain.tokens, { input: 200, output: 50, cacheRead: 120, reasoning: 15 });

    const rewound = sessions[0];
    assert.equal(rewound.title, 'fixture: eta session summary');
    // /rewind removed the first exchange: only the post-rewind pair remains
    assert.equal(rewound.userCount, 1);
    assert.equal(rewound.assistantCount, 1);
  });

  it('serves a session detail with normalized roles and the inline tool result paired', async () => {
    const { session, messages } = await getJson(srv.base, `/api/gemini/sessions/${GEM_PLAIN}`);
    assert.equal(session.id, GEM_PLAIN);
    assert.equal(session.cwd, '/fixtures/project-zeta');
    assert.equal(session.model, 'gemini-2.5-pro');
    const roles = messages.map((m) => m.role);
    for (const role of ['user', 'reasoning', 'assistant', 'toolCall', 'toolResult']) {
      assert.ok(roles.includes(role), `missing role ${role}`);
    }
    // info records are CLI chrome, never conversation content
    assert.ok(!roles.includes('info'));
    const assistant = messages.find((m) => m.role === 'assistant');
    assert.deepEqual(assistant.usage, { input: 200, output: 50, cacheRead: 120, reasoning: 15 });
    const call = messages.find((m) => m.role === 'toolCall');
    assert.equal(call.toolName, 'list_directory');
    assert.deepEqual(call.details, { path: '/fixtures/project-zeta' });
    const result = messages.find((m) => m.role === 'toolResult');
    assert.equal(result.toolCallId, 'call-gem-1');
    assert.equal(result.content[0].text, 'file-a.txt\n');
    assert.equal(result.isError, false);
  });

  it('applies $rewindTo before serving: rewound messages never render', async () => {
    const { messages } = await getJson(srv.base, `/api/gemini/sessions/${GEM_REWIND}`);
    const texts = messages.flatMap((m) => m.content.map((c) => c.text || ''));
    assert.ok(!texts.some((t) => t.includes('rewound-question-never-visible')));
    assert.ok(texts.some((t) => t.includes('gemini-rewind-needle-eta')));
    // The errored tool call surfaces as an error result
    const result = messages.find((m) => m.role === 'toolResult');
    assert.equal(result.isError, true);
  });

  it('finds gemini sessions via full-text search, honoring the rewind fold', async () => {
    const hit = await getJson(srv.base, '/api/search?q=gemini-needle-zeta&platform=gemini');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].sessionId, GEM_PLAIN);
    assert.equal(hit[0].platform, 'gemini');
    assert.ok(hit[0].matches[0].snippet.includes('gemini-needle-zeta'));

    // Rewound content is not searchable — only the post-rewind history is
    const gone = await getJson(srv.base, '/api/search?q=rewound-question-never-visible&platform=gemini');
    assert.deepEqual(gone, []);
    const kept = await getJson(srv.base, '/api/search?q=gemini-rewind-needle-eta&platform=gemini');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].sessionId, GEM_REWIND);
  });

  it('extracts gemini prompts grouped by cwd', async () => {
    const data = await getJson(srv.base, '/api/prompts?platform=gemini');
    assert.equal(data.totalSessions, 2);
    assert.equal(data.totalPrompts, 2);
    const dirs = data.groups.map((g) => g.directory).sort();
    assert.deepEqual(dirs, ['/fixtures/project-eta', '/fixtures/project-zeta']);
  });

  it('aggregates gemini tool usage in the tools audit, counting errored calls', async () => {
    const audit = await getJson(srv.base, '/api/tools/audit?platform=gemini');
    const byName = new Map(audit.tools.map((t) => [t.name, t]));
    const list = byName.get('list_directory');
    assert.ok(list, 'expected list_directory row');
    assert.deepEqual(list.platforms, ['gemini']);
    assert.equal(list.calls, 1);
    assert.equal(list.errors, 0);
    const shell = byName.get('run_shell_command');
    assert.equal(shell.calls, 1);
    assert.equal(shell.errors, 1);
  });

  it('computes gemini insights with token totals and the error cluster', async () => {
    const insights = await getJson(srv.base, '/api/insights?platform=gemini');
    assert.equal(insights.totalSessions, 2);
    assert.equal(insights.totalToolCalls, 2);
    assert.deepEqual(insights.tokenUsage, { input: 290, output: 70, cacheRead: 120 });
    const shell = insights.toolStats.find((t) => t.name === 'run_shell_command');
    assert.equal(shell.errors, 1);
  });

  it('exports a gemini session as OTLP', async () => {
    const payload = await getJson(srv.base, `/api/otlp/gemini/${GEM_PLAIN}`);
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.ok(spans.some((s) => s.name === 'execute_tool list_directory'));
  });

  it('exports a gemini session as Markdown', async () => {
    const res = await fetch(`${srv.base}/api/gemini/sessions/${GEM_PLAIN}/export?format=md`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('gemini-needle-zeta'));
    assert.ok(body.includes('list_directory'));
  });
});
