// Session export endpoint: Markdown / standalone HTML rendering, redaction,
// and error handling — exercised over the API against the fixture home.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderSessionMarkdown, renderSessionHtml, redactSecrets } = require(
  path.join(__dirname, '..', 'lib', 'export')
);
const { startServer } = require('./helpers.js');

const CLAUDE_ID = 'aaaa1111-2222-4333-8444-555566667777';
const DSH_ID = 'dsh-fixture-session-0001';

async function getText(base, pathname, expectedStatus = 200) {
  const res = await fetch(base + pathname);
  const body = await res.text();
  assert.equal(res.status, expectedStatus, `${pathname} → ${res.status}: ${body.slice(0, 200)}`);
  return { body, headers: res.headers };
}

// --- redaction (unit) ---

test('redactSecrets scrubs api keys, auth headers and bearer tokens', () => {
  const input = [
    'key=sk-abc123def456ghi789',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    '"api_key": "super-secret-value"',
    'token ghp_0123456789abcdefghijklmnopqrstuv',
  ].join('\n');
  const out = redactSecrets(input);
  assert.ok(!out.includes('sk-abc123def456ghi789'));
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!out.includes('super-secret-value'));
  assert.ok(!out.includes('ghp_0123456789abcdefghijklmnopqrstuv'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redactSecrets leaves ordinary text alone', () => {
  const input = 'run the tests and check skipped cases in the auth module';
  assert.equal(redactSecrets(input), input);
});

// --- renderers (unit, tiny synthetic payload) ---

const SYNTH = {
  session: { id: 'synth-1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/proj', model: 'test-model' },
  messages: [
    { role: 'user', timestamp: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'hello' }], usage: null },
    {
      role: 'assistant',
      timestamp: '2026-01-01T00:00:05Z',
      content: [
        { type: 'text', text: 'running a tool' },
        { type: 'toolCall', id: 'c1', name: 'run_command', arguments: { command: 'echo hi' } },
      ],
      usage: { input: 10, output: 5 },
    },
    {
      role: 'toolResult',
      timestamp: '2026-01-01T00:00:06Z',
      toolCallId: 'c1',
      toolName: 'run_command',
      content: [{ type: 'text', text: 'hi\nsk-verysecretkey12345' }],
      isError: false,
    },
  ],
};

test('markdown renderer emits metadata table, roles and collapsed tool blocks', () => {
  const md = renderSessionMarkdown('codex', SYNTH);
  assert.ok(md.includes('| Platform | codex |'));
  assert.ok(md.includes('| Model | test-model |'));
  assert.ok(md.includes('## 👤 User'));
  assert.ok(md.includes('## 🤖 Assistant'));
  assert.ok(md.includes('<summary>🔧 Tool call: <code>run_command</code>'));
  assert.ok(md.includes('"command": "echo hi"'));
  assert.ok(md.includes('<summary>📋 Tool result: <code>run_command</code>'));
  // Token summary from usage
  assert.ok(md.includes('input 10'));
  // Redaction applied to tool output
  assert.ok(!md.includes('sk-verysecretkey12345'));
});

test('html renderer is self-contained and escapes content', () => {
  const html = renderSessionHtml('codex', {
    ...SYNTH,
    messages: [
      ...SYNTH.messages,
      { role: 'user', timestamp: null, content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
    ],
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<style>'));
  // no external requests: no src=/href= URLs to other hosts
  assert.ok(!/(?:src|href)\s*=\s*"https?:\/\//.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('maxToolBytes caps tool results', () => {
  const md = renderSessionMarkdown('codex', SYNTH, { maxToolBytes: 2 });
  assert.ok(md.includes('… (truncated'));
});

// --- API surface (fixture sessions) ---

test('export API', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  await t.test('claude-code markdown export contains roles and tool call', async () => {
    const { body, headers } = await getText(srv.base, `/api/claude-code/sessions/${CLAUDE_ID}/export?format=md`);
    assert.match(headers.get('content-type'), /text\/markdown/);
    assert.match(headers.get('content-disposition'), /attachment; filename="agentxray-.*\.md"/);
    assert.ok(body.includes('| Platform | claude-code |'));
    assert.ok(body.includes(`# AgentXRay session ${CLAUDE_ID}`));
    assert.ok(body.includes('## 👤 User'));
    assert.ok(body.includes('🔧 Tool call'));
  });

  await t.test('claude-code html export is standalone', async () => {
    const { body, headers } = await getText(srv.base, `/api/claude-code/sessions/${CLAUDE_ID}/export?format=html`);
    assert.match(headers.get('content-type'), /text\/html/);
    assert.ok(body.startsWith('<!doctype html>'));
    assert.ok(body.includes(CLAUDE_ID));
    assert.ok(!/(?:src|href)\s*=\s*"https?:\/\//.test(body));
  });

  await t.test('dsh markdown export pairs tool call and result', async () => {
    const { body } = await getText(srv.base, `/api/dsh/sessions/${DSH_ID}/export?format=md`);
    assert.ok(body.includes('| Platform | dsh |'));
    assert.ok(body.includes('run_command'));
    assert.ok(body.includes('👤 User'));
    assert.ok(body.includes('dsh-needle-delta'));
  });

  await t.test('validation: bad platform / format / missing session / openclaw agent', async () => {
    await getText(srv.base, `/api/nope/sessions/${DSH_ID}/export?format=md`, 400);
    await getText(srv.base, `/api/dsh/sessions/${DSH_ID}/export?format=pdf`, 400);
    await getText(srv.base, '/api/dsh/sessions/does-not-exist/export?format=md', 404);
    await getText(srv.base, '/api/openclaw/sessions/whatever/export?format=md', 400);
  });
});
