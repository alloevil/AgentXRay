// Integration tests: each describe block gets a hermetic server whose HOME is
// a temp copy of test/fixtures/home. The read-only groups share one server;
// groups that mutate global stores (library installs, backup archive) start
// their own so runs stay order-independent and repeatable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
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
      for (const p of ['codex', 'claude-code', 'omp']) {
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
    // codex 2 + claude 2 + history.jsonl + omp 2 + dsh 2 (subagent transcripts excluded)
    assert.equal(first.copied, 9);
    assert.equal(first.skipped, 0);
    assert.equal(first.total, 9);
    assert.deepEqual(first.byPlatform.codex, { copied: 2, skipped: 0 });
    assert.deepEqual(first.byPlatform['claude-code'], { copied: 3, skipped: 0 });
    assert.deepEqual(first.byPlatform.omp, { copied: 2, skipped: 0 });
    assert.deepEqual(first.byPlatform.dsh, { copied: 2, skipped: 0 });
    // Archive stays inside the temp HOME
    assert.equal(first.archiveDir, path.join(srv.home, '.agentxray', 'archive'));
    assert.ok(await exists(path.join(first.archiveDir, 'claude-code', 'history.jsonl')));

    const second = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 9);
    assert.equal(second.total, 9);

    const status = await getJson(srv.base, '/api/backup/status');
    assert.equal(status.archiveDir, first.archiveDir);
    assert.equal(status.files, 9);
    assert.ok(status.bytes > 0);
    assert.ok(typeof status.lastBackup === 'string');
  });
});
