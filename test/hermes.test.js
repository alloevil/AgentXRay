// Hermes is the one SQLite-backed platform. The reader uses node:sqlite (built in
// since Node 22.13) instead of a native addon, so the test builds a real state.db
// in the throwaway HOME and drives the public HTTP surface against it: list,
// detail with normalized roles, and search (LIKE fallback — no FTS table here).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, getJson } = require('./helpers.js');

const S1 = 'hermes-session-0001';
const S2 = 'hermes-session-0002';
const T0 = 1737000000; // 2025-01-16T04:00:00Z

function seedHermesDb(home) {
  const dir = path.join(home, '.hermes');
  return fsp.mkdir(dir, { recursive: true }).then(() => {
    const db = new DatabaseSync(path.join(dir, 'state.db'));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, user_id TEXT, model TEXT, title TEXT,
        started_at INTEGER, ended_at INTEGER, message_count INTEGER, tool_call_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, parent_session_id TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
        tool_call_id TEXT, tool_name TEXT, timestamp INTEGER, token_count INTEGER, reasoning TEXT
      );
    `);
    const ins = db.prepare(
      'INSERT INTO sessions (id, source, model, title, started_at, ended_at, message_count, tool_call_count, input_tokens, output_tokens, estimated_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    ins.run(S1, 'cli', 'hermes-4', 'first', T0, T0 + 60, 4, 1, 120, 40, 0.0031);
    ins.run(S2, 'cli', 'hermes-4', 'second', T0 + 3600, null, 1, 0, 10, 0, null);
    const msg = db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, timestamp, token_count, reasoning) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    msg.run(S1, 'user', 'fixture: hermes-needle please list files', null, null, null, T0 + 1, null, null);
    msg.run(
      S1,
      'assistant',
      'Listing.',
      JSON.stringify([{ id: 'call-h-1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }]),
      null,
      null,
      T0 + 2,
      37,
      'need to run ls'
    );
    msg.run(S1, 'tool', 'a.txt\nb.txt', null, 'call-h-1', 'terminal', T0 + 3, null, null);
    msg.run(S1, 'assistant', 'Two files.', null, null, null, T0 + 4, 9, null);
    msg.run(S2, 'user', 'unrelated question', null, null, null, T0 + 3601, null, null);
    db.close();
  });
}

describe('sessions: hermes (node:sqlite)', () => {
  let srv;
  before(async () => {
    // The reader opens state.db per request, so seeding after boot is fine.
    srv = await startServer();
    await seedHermesDb(srv.home);
  });
  after(async () => {
    await srv.stop();
  });

  it('lists sessions by last activity with per-session stats', async () => {
    const sessions = await getJson(srv.base, '/api/hermes/sessions');
    assert.deepEqual(
      sessions.map((s) => s.id),
      [S2, S1]
    );
    const s1 = sessions[1];
    assert.equal(s1.timestamp, new Date(T0 * 1000).toISOString());
    assert.equal(s1.userCount, 1);
    assert.equal(s1.assistantCount, 2);
    assert.equal(s1.toolResultCount, 1);
    assert.equal(s1.toolCallCount, 1);
    assert.deepEqual(s1.topTools, [{ name: 'terminal', count: 1 }]);
    assert.ok(s1.firstUserMessage.startsWith('fixture: hermes-needle'));
    assert.equal(s1.status, 'archived');
    assert.equal(sessions[0].status, 'active');
    assert.equal(s1.estimatedCost, 0.0031);
  });

  it('serves a session detail with normalized roles and reasoning', async () => {
    const { session, messages } = await getJson(srv.base, `/api/hermes/sessions/${S1}`);
    assert.equal(session.id, S1);
    assert.equal(session.model, 'hermes-4');
    assert.equal(session.inputTokens, 120);
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'toolResult', 'assistant']
    );
    // Hermes stores tool_calls as JSON on the assistant row; they surface as toolCall content blocks
    const call = messages[1].content.find((c) => c.type === 'toolCall');
    assert.equal(call.name, 'terminal');
    assert.equal(call.id, 'call-h-1');
    assert.deepEqual(call.arguments, { command: 'ls' });
    assert.equal(messages[1].reasoning, 'need to run ls');
    assert.deepEqual(messages[1].usage, { total_tokens: 37 });
    assert.equal(messages[2].toolCallId, 'call-h-1');
    assert.equal(messages[2].toolName, 'terminal');
  });

  it('404s an unknown session id', async () => {
    const res = await fetch(`${srv.base}/api/hermes/sessions/does-not-exist`);
    assert.equal(res.status, 404);
  });

  it('search falls back to LIKE when there is no FTS table', async () => {
    const results = await getJson(srv.base, '/api/search?q=hermes-needle&platform=hermes');
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, S1);
    assert.equal(results[0].platform, 'hermes');
    assert.equal(results[0].matches[0].role, 'user');
    assert.ok(results[0].matches[0].snippet.includes('hermes-needle'));
  });
});
