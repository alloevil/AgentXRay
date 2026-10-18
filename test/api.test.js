// Integration tests: each describe block gets a hermetic server whose HOME is
// a temp copy of test/fixtures/home. The read-only groups share one server;
// groups that mutate global stores (library installs, backup archive) start
// their own so runs stay order-independent and repeatable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { startServer, getJson, sendJson } = require('./helpers.js');

const CODEX1 = '01900000-0000-7000-8000-000000000001';
const CODEX2 = '01900000-0000-7000-8000-000000000002';
const CLAUDE_A = 'aaaa1111-2222-4333-8444-555566667777';
const CLAUDE_B = 'bbbb1111-2222-4333-8444-555566667778';
const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
const OMP2 = '019a0000-0000-7000-8000-00000000bbbb';

async function exists(p) {
  return fsp.access(p).then(
    () => true,
    () => false
  );
}

describe('AgentXRay API', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('GET /api/version returns a boot id', async () => {
    const body = await getJson(srv.base, '/api/version');
    assert.equal(typeof body.bootId, 'string');
    assert.ok(body.bootId.length > 0);
  });

  it('every route is rate-limited: 600 requests per minute per IP (lib/rate-limit.js)', async () => {
    for (const route of ['/api/version', '/', '/no/such/page']) {
      const res = await fetch(`${srv.base}${route}`);
      assert.equal(res.status, 200, route);
      const policy = res.headers.get('ratelimit-policy') || '';
      assert.match(policy, /q=600/, `${route} policy: ${policy}`);
      assert.match(policy, /w=60/, `${route} policy: ${policy}`);
      assert.ok(res.headers.get('ratelimit'), `${route} has a RateLimit header`);
      await res.arrayBuffer();
    }
  });

  describe('sessions: codex', () => {
    it('lists sessions newest-first with metadata', async () => {
      const sessions = await getJson(srv.base, '/api/codex/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CODEX2, CODEX1]
      );
      const s1 = sessions[1];
      assert.equal(s1.timestamp, '2026-01-15T10:00:00.000Z');
      assert.equal(s1.cwd, '/fixtures/project-alpha');
      assert.equal(s1.userCount, 2);
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: search-needle-alpha'));
      assert.deepEqual(s1.topTools, [{ name: 'shell', count: 1 }]);
    });

    it('serves a session detail with normalized roles', async () => {
      const { session, messages } = await getJson(srv.base, `/api/codex/sessions/${CODEX1}`);
      assert.equal(session.id, CODEX1);
      assert.equal(session.cwd, '/fixtures/project-alpha');
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolCall', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'shell');
      assert.equal(call.toolCallId, 'call-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'call-fx-1');
      assert.equal(result.isError, false);
      assert.deepEqual(result.details, { status: 'ok', exitCode: 0, durationMs: 400 });
    });
  });

  describe('sessions: claude-code', () => {
    it('lists sessions without leaking subagent transcripts', async () => {
      const sessions = await getJson(srv.base, '/api/claude-code/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CLAUDE_B, CLAUDE_A]
      );
      const a = sessions[1];
      assert.equal(a.toolCallCount, 1);
      assert.equal(a.toolResultCount, 1);
      assert.equal(a.cwd, '/fixtures/project-beta');
      assert.ok(a.firstUserMessage.startsWith('fixture: claude-prompt-one'));
    });

    it('serves a session detail with tool_use/tool_result normalized', async () => {
      const { session, messages } = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}`);
      assert.equal(session.id, CLAUDE_A);
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const assistant = messages.find((m) => m.role === 'assistant');
      const toolCall = assistant.content.find((c) => c.type === 'toolCall');
      assert.equal(toolCall.name, 'Task');
      assert.equal(toolCall.id, 'toolu-fx-1');
      assert.equal(assistant.usage.input_tokens, 10);
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'toolu-fx-1');
      assert.equal(result.content[0].text, 'hello');
    });

    it('exposes subagents via the children endpoints', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children`);
      assert.equal(children.length, 1);
      const child = children[0];
      assert.equal(child.name, 'agent-fx001');
      assert.equal(child.agentType, 'general-purpose');
      assert.equal(child.description, 'Scout the fixture');
      assert.equal(child.messageCount, 2);

      const detail = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children/agent-fx001`);
      assert.deepEqual(
        detail.messages.map((m) => m.role),
        ['user', 'assistant']
      );
      assert.equal(detail.messages[1].content[0].text, 'hello');
    });

    it('a Task-free session has no children', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_B}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('sessions: omp', () => {
    it('lists sessions with title, cost-bearing usage and tool counts', async () => {
      const sessions = await getJson(srv.base, '/api/omp/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [OMP2, OMP1]
      );
      const s1 = sessions[1];
      assert.equal(s1.title, 'Fixture OMP Session');
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: omp-prompt-alpha'));
    });

    it('serves a detail with the toolCall→toolResult error pair and usage.cost', async () => {
      const { session, messages } = await getJson(srv.base, `/api/omp/sessions/${OMP1}`);
      assert.equal(session.id, OMP1);
      assert.equal(session.model, 'fixture/model-x');
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'bash');
      assert.equal(call.toolCallId, 'tc-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'tc-fx-1');
      assert.equal(result.isError, true);
      const assistant = messages.find((m) => m.role === 'assistant');
      assert.equal(assistant.usage.cost.total, 0.003);
      assert.equal(assistant.usage.input, 100);
    });

    it('exposes spawned children next to the session file', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children`);
      assert.equal(children.length, 1);
      assert.equal(children[0].name, 'Scout');
      assert.equal(children[0].file, 'Scout.jsonl');
      assert.equal(children[0].messageCount, 2);

      const detail = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children/Scout`);
      assert.equal(detail.messages.filter((m) => m.role === 'user').length, 1);
      assert.ok(detail.messages.some((m) => m.role === 'assistant'));
    });

    it('a child-free session reports no children', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP2}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('search', () => {
    it('finds a keyword in one platform', async () => {
      const results = await getJson(srv.base, '/api/search?q=search-needle-alpha&platform=codex');
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, CODEX1);
      assert.equal(results[0].platform, 'codex');
      assert.ok(results[0].matches.length >= 1);
      assert.equal(results[0].matches[0].role, 'user');
      assert.ok(results[0].matches[0].snippet.includes('search-needle-alpha'));
    });

    it('multi-keyword search is an AND across the session', async () => {
      const hit = await getJson(srv.base, '/api/search?q=search-needle-alpha+zebra-token&platform=codex');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].sessionId, CODEX1);
      const miss = await getJson(srv.base, '/api/search?q=search-needle-alpha+no-such-token-anywhere&platform=codex');
      assert.deepEqual(miss, []);
    });

    it('platform=all merges hits across platforms', async () => {
      const results = await getJson(srv.base, '/api/search?q=fixture&platform=all&limit=100');
      const platforms = new Set(results.map((r) => r.platform));
      for (const p of ['codex', 'claude-code', 'omp', 'dsh', 'gemini']) {
        assert.ok(platforms.has(p), `missing platform ${p}`);
      }
    });

    it('falls back to claude prompt history for retired sessions', async () => {
      const results = await getJson(srv.base, '/api/search?q=history-needle-gamma&platform=claude-code');
      assert.equal(results.length, 1);
      const hit = results[0];
      assert.equal(hit.history, true);
      assert.equal(hit.sessionId, null);
      assert.equal(hit.file, 'history.jsonl');
      assert.equal(hit.project, '/fixtures/project-beta');
      assert.ok(hit.matches[0].snippet.includes('history-needle-gamma'));
    });

    it('rejects path traversal via the agent query parameter', async () => {
      // Plant a session file OUTSIDE the openclaw data dir, reachable only by
      // escaping it: <home>/.openclaw/agents/../../escape/sessions/evil.jsonl.
      const evilDir = path.join(srv.home, 'escape', 'sessions');
      await fsp.mkdir(evilDir, { recursive: true });
      await fsp.writeFile(
        path.join(evilDir, 'evil.jsonl'),
        `${JSON.stringify({
          type: 'message',
          timestamp: '2026-01-20T08:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'escape-needle-secret' }] },
        })}\n`
      );

      // Search must not follow ../ out of the agents dir
      const results = await getJson(
        srv.base,
        '/api/search?q=escape-needle-secret&platform=openclaw&agent=..%2F..%2Fescape'
      );
      assert.deepEqual(results, []);

      // Insights must not aggregate the escaped file either
      const insights = await getJson(srv.base, '/api/insights?platform=openclaw&agent=..%2F..%2Fescape');
      assert.equal(insights.totalSessions, 0);
    });
  });

  describe('prompts + hidden prompts', () => {
    it('hiding one text collapses every identical occurrence, and unhiding restores it', async () => {
      const beforeData = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(beforeData.totalPrompts, 3);
      assert.equal(beforeData.totalSessions, 2);
      assert.equal(beforeData.groups[0].directory, '/fixtures/project-alpha');

      // The duplicate text lives in both codex sessions: one hide removes both
      const hideRes = await sendJson(srv.base, 'POST', '/api/prompts/hidden', {
        text: 'fixture: duplicate-prompt-omega',
      });
      assert.equal(hideRes.added, 1);
      assert.match(hideRes.hash, /^[0-9a-f]{16}$/);

      const hiddenList = await getJson(srv.base, '/api/prompts/hidden');
      assert.ok(hiddenList.hidden.some((h) => h.hash === hideRes.hash && h.preview.includes('duplicate-prompt-omega')));

      const afterHide = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(afterHide.totalPrompts, beforeData.totalPrompts - 2);
      assert.equal(afterHide.totalSessions, 1); // session 2 only held the duplicate

      // Store lives under the temp HOME, never the real ~/.agentxray
      assert.ok(await exists(path.join(srv.home, '.agentxray', 'hidden-prompts.json')));

      await sendJson(srv.base, 'DELETE', `/api/prompts/hidden/${hideRes.hash}`, undefined);
      const restored = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(restored.totalPrompts, beforeData.totalPrompts);
    });
  });

  describe('tools audit', () => {
    it('aggregates tool rows across platforms and flags unused MCP servers', async () => {
      const audit = await getJson(srv.base, '/api/tools/audit?platform=all');
      const byName = new Map(audit.tools.map((t) => [t.name, t]));

      const shell = byName.get('shell');
      assert.deepEqual(shell.platforms, ['codex']);
      assert.equal(shell.calls, 1);
      assert.equal(shell.errors, 0);
      assert.equal(shell.avgMs, 400);

      const task = byName.get('Task');
      assert.deepEqual(task.platforms, ['claude-code']);
      assert.equal(task.calls, 1);

      const bash = byName.get('bash');
      assert.deepEqual(bash.platforms, ['omp']);
      assert.equal(bash.errors, 1);
      assert.equal(bash.errorRate, 1);
      assert.equal(bash.avgMs, 2000);

      // From the fixture ~/.claude.json mcpServers entry that no tool ever used
      assert.deepEqual(audit.configuredUnused, [{ name: 'fixture-unused-server', source: 'claude-mcp' }]);
    });
  });

  describe('otlp export', () => {
    it('serializes an omp session as one trace with parented spans', async () => {
      const payload = await getJson(srv.base, `/api/otlp/omp/${OMP1}`);
      const resource = payload.resourceSpans[0];
      const attrs = Object.fromEntries(resource.resource.attributes.map((a) => [a.key, a.value.stringValue]));
      assert.equal(attrs['service.name'], 'agentxray');
      assert.equal(attrs['gen_ai.conversation.id'], OMP1);

      const spans = resource.scopeSpans[0].spans;
      assert.ok(spans.every((s) => s.kind === 1));
      assert.ok(spans.every((s) => s.traceId === spans[0].traceId));

      const roots = spans.filter((s) => s.name === 'invoke_agent');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].parentSpanId, undefined);

      const chats = spans.filter((s) => s.name.startsWith('chat '));
      assert.equal(chats.length, 2);
      for (const c of chats) assert.equal(c.parentSpanId, roots[0].spanId);
      const chatAttrs = Object.fromEntries(
        chats[0].attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue])
      );
      assert.equal(chatAttrs['gen_ai.request.model'], 'fixture/model-x');
      assert.equal(chatAttrs['gen_ai.usage.input_tokens'], '100');

      const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'execute_tool bash');
      assert.equal(tools[0].parentSpanId, roots[0].spanId);
      assert.deepEqual(tools[0].status, { code: 2 }); // the fixture tool pair errored
      assert.ok(BigInt(tools[0].endTimeUnixNano) > BigInt(tools[0].startTimeUnixNano));
    });
  });
});

describe('library', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('supports CRUD, install into platform command dirs, and usage stats', async () => {
    const empty = await getJson(srv.base, '/api/library');
    assert.deepEqual(empty.prompts, []);

    const created = await sendJson(
      srv.base,
      'POST',
      '/api/library',
      {
        name: 'fixture-prompt',
        description: 'Fixture prompt for tests',
        tags: ['fixture', 'test'],
        content: 'Run the fixture checks and report.',
      },
      201
    );
    assert.equal(created.prompt.name, 'fixture-prompt');
    assert.deepEqual(created.prompt.tags, ['fixture', 'test']);
    assert.deepEqual(created.prompt.installed, { claude: false, codex: false, omp: false });

    // Duplicate create is rejected
    await sendJson(
      srv.base,
      'POST',
      '/api/library',
      {
        name: 'fixture-prompt',
        content: 'x',
      },
      409
    );

    const listed = await getJson(srv.base, '/api/library');
    assert.equal(listed.prompts.length, 1);

    const updated = await sendJson(srv.base, 'PUT', '/api/library/fixture-prompt', {
      description: 'Updated fixture description',
    });
    assert.equal(updated.prompt.description, 'Updated fixture description');
    assert.equal(updated.prompt.content.trim(), 'Run the fixture checks and report.');

    // Install lands real files inside the temp HOME copy — never the real ~
    const installed = await sendJson(srv.base, 'POST', '/api/library/fixture-prompt/install', {
      targets: ['claude', 'codex'],
    });
    assert.deepEqual(installed.installed, { claude: true, codex: true, omp: false });
    const claudeCmd = path.join(srv.home, '.claude', 'commands', 'fixture-prompt.md');
    const codexCmd = path.join(srv.home, '.codex', 'prompts', 'fixture-prompt.md');
    assert.ok(await exists(claudeCmd));
    assert.ok(await exists(codexCmd));
    const installedBody = await fsp.readFile(claudeCmd, 'utf8');
    assert.ok(installedBody.includes('Run the fixture checks and report.'));

    // Usage: one slash invocation in the omp fixture session + one in claude history
    const usage = await getJson(srv.base, '/api/library/usage');
    const u = usage.usage['fixture-prompt'];
    assert.equal(u.uses, 2);
    assert.equal(u.avgMessages, 1);
    assert.equal(u.errorRate, 0);
    assert.equal(u.lastUsed, '2026-01-21T09:00:02.000Z');

    // Delete removes the entry and its installed copies
    const deleted = await sendJson(srv.base, 'DELETE', '/api/library/fixture-prompt', undefined);
    assert.equal(deleted.ok, true);
    assert.equal(await exists(claudeCmd), false);
    assert.equal(await exists(codexCmd), false);
    const finalList = await getJson(srv.base, '/api/library');
    assert.deepEqual(finalList.prompts, []);
  });
});

describe('backup', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('copies every session log once, then skips everything on the second run', async () => {
    const first = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    // codex 2 + claude 2 + history.jsonl + omp 2 + dsh 2 + gemini 3 (incl. nested subagent transcript)
    assert.equal(first.copied, 12);
    assert.equal(first.skipped, 0);
    assert.equal(first.total, 12);
    assert.deepEqual(first.byPlatform.codex, { copied: 2, skipped: 0 });
    assert.deepEqual(first.byPlatform['claude-code'], { copied: 3, skipped: 0 });
    assert.deepEqual(first.byPlatform.omp, { copied: 2, skipped: 0 });
    assert.deepEqual(first.byPlatform.dsh, { copied: 2, skipped: 0 });
    assert.deepEqual(first.byPlatform.gemini, { copied: 3, skipped: 0 });
    // Archive stays inside the temp HOME
    assert.equal(first.archiveDir, path.join(srv.home, '.agentxray', 'archive'));
    assert.ok(await exists(path.join(first.archiveDir, 'claude-code', 'history.jsonl')));

    const second = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 12);
    assert.equal(second.total, 12);

    const status = await getJson(srv.base, '/api/backup/status');
    assert.equal(status.archiveDir, first.archiveDir);
    assert.equal(status.files, 12);
    assert.ok(status.bytes > 0);
    assert.ok(typeof status.lastBackup === 'string');
  });
});

describe('csrf guard', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  const send = (method, headers, pathname = '/api/prompts/hidden') =>
    fetch(srv.base + pathname, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify({ hash: 'deadbeef' }),
    });

  it('rejects a state-changing request whose Origin is another site', async () => {
    const res = await send('POST', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.reason, /origin https:\/\/evil\.example/);
  });

  it('rejects when Sec-Fetch-Site says cross-site even without Origin', async () => {
    const res = await send('DELETE', { 'Sec-Fetch-Site': 'cross-site' }, '/api/prompts/hidden/deadbeef');
    assert.equal(res.status, 403);
  });

  it('accepts same-origin browser requests and origin-less clients', async () => {
    const host = new URL(srv.base).host;
    const same = await send('POST', { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' });
    assert.notEqual(same.status, 403);
    const curl = await send('POST', {});
    assert.notEqual(curl.status, 403);
  });

  it('never blocks reads, whatever the origin', async () => {
    const res = await send('GET', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, '/api/version');
    assert.equal(res.status, 200);
  });
});

describe('path guards on ?dir= and route params', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  const status = async (pathname) => (await fetch(srv.base + pathname)).status;
  const q = (value) => encodeURIComponent(value);

  it('rejects ?dir= outside the allowed roots with 403', async () => {
    assert.equal(await status(`/api/codex/sessions?dir=${q('/etc')}`), 403);
    assert.equal(await status(`/api/agents?dir=${q(path.dirname(srv.home))}`), 403);
    const res = await fetch(`${srv.base}/api/codex/sessions?dir=${q('/etc')}`);
    assert.match((await res.json()).error, /outside the allowed roots/);
  });

  it('rejects ../ escapes, relative dirs and NUL bytes with 403', async () => {
    const dotdot = `${path.join(srv.home, '.codex', 'sessions')}/../../..`;
    assert.equal(await status(`/api/codex/sessions?dir=${q(dotdot)}`), 403);
    assert.equal(await status(`/api/codex/sessions?dir=${q(`${srv.home}/../${path.basename(srv.home)}`)}`), 403);
    assert.equal(await status(`/api/codex/sessions?dir=${q('.codex/sessions')}`), 403);
    assert.equal(await status(`/api/codex/sessions?dir=${q(`${srv.home}\0/x`)}`), 403);
    assert.equal(await status(`/api/search?q=x&platform=codex&dirCodex=${q('/etc')}`), 403);
  });

  it('rejects a symlink inside HOME that points outside it', async () => {
    const link = path.join(srv.home, 'escape-link');
    await fsp.symlink(path.dirname(srv.home), link);
    assert.equal(await status(`/api/codex/sessions?dir=${q(link)}`), 403);
  });

  it('still serves an explicit ?dir= inside HOME, same as the default', async () => {
    const dflt = await getJson(srv.base, '/api/codex/sessions');
    const explicit = await getJson(srv.base, `/api/codex/sessions?dir=${q(path.join(srv.home, '.codex', 'sessions'))}`);
    assert.deepEqual(
      explicit.map((s) => s.id),
      dflt.map((s) => s.id)
    );
    assert.ok(dflt.length > 0);
    assert.equal(await status('/api/codex/sessions?dir='), 200);
  });

  // fetch() would normalise %2E%2E away per the URL spec, so send the raw path.
  const rawStatus = (rawPath) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(srv.base);
      http
        .get({ hostname, port, path: rawPath }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });

  it('rejects dot-only agent names and session ids with 400', async () => {
    assert.equal(await rawStatus('/api/agents/%2E%2E/sessions'), 400);
    assert.equal(await rawStatus('/api/agents/main/sessions/%2E%2E'), 400);
    assert.equal(await rawStatus('/api/agents/main/sessions/%2E%2E%2E'), 400);
  });
});
