// LLM backend abstraction (#14): settings API, OpenAI-compatible endpoint
// path, and the explicit no-backend error. The claude CLI is disabled in
// every test via AGENTXRAY_CLAUDE_BIN pointing at a nonexistent binary, so
// results don't depend on the machine running the suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, getJson, sendJson } = require('./helpers');

const NO_CLI = { AGENTXRAY_CLAUDE_BIN: '/nonexistent/claude-cli-disabled' };

// Minimal OpenAI-compatible /chat/completions mock. Records requests.
function startMockOpenAi(replyContent) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization || null, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replyContent } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('LLM settings API: defaults, save, key redaction and validation', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    // Fresh home: nothing configured, no claude CLI → backend null
    const initial = await getJson(base, '/api/settings/llm');
    assert.deepEqual(initial, { baseUrl: '', model: '', hasApiKey: false, backend: null });

    // Save an endpoint; the key must never be echoed back
    const saved = await sendJson(base, 'PUT', '/api/settings/llm', {
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'test-model',
      apiKey: 'sk-secret',
    });
    assert.equal(saved.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(saved.model, 'test-model');
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.backend, 'openai');
    assert.equal('apiKey' in saved, false);

    // Omitted apiKey keeps the stored key
    const kept = await sendJson(base, 'PUT', '/api/settings/llm', {
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'other-model',
    });
    assert.equal(kept.hasApiKey, true);

    // Validation: baseUrl without model, non-http baseUrl
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: 'http://x', model: '' }, 400);
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: 'ftp://x', model: 'm' }, 400);

    // Clearing baseUrl also clears the stored key
    const cleared = await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: '', model: '' });
    assert.deepEqual(cleared, { baseUrl: '', model: '', hasApiKey: false, backend: null });
  } finally {
    await stop();
  }
});

test('rewrite goes through a configured OpenAI-compatible endpoint', async () => {
  const reply = JSON.stringify({ rewrite: '改写后的 prompt 内容', rationale: '更明确' });
  const mock = await startMockOpenAi(reply);
  const { base, stop } = await startServer(NO_CLI);
  try {
    await sendJson(base, 'PUT', '/api/settings/llm', {
      baseUrl: `${mock.base}/v1`,
      model: 'mock-model',
      apiKey: 'sk-mock',
    });

    const result = await sendJson(base, 'POST', '/api/prompts/rewrite', { text: 'fix the login bug' });
    assert.equal(result.rewrite, '改写后的 prompt 内容');
    assert.equal(result.rationale, '更明确');

    // The mock actually served the request, with auth + model + prompt wired through
    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.auth, 'Bearer sk-mock');
    assert.equal(req.body.model, 'mock-model');
    assert.ok(req.body.messages[0].content.includes('fix the login bug'));
  } finally {
    await stop();
    await mock.close();
  }
});

test('suggest-name uses the endpoint and shapes the reply into a library name', async () => {
  const mock = await startMockOpenAi('Fix Login Bug\n');
  const { base, stop } = await startServer(NO_CLI);
  try {
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: mock.base, model: 'mock-model' });
    const result = await sendJson(base, 'POST', '/api/library/suggest-name', { text: 'please fix login' });
    assert.equal(result.name, 'fix-login-bug');
    // No apiKey configured → no Authorization header sent
    assert.equal(mock.requests[0].auth, null);
  } finally {
    await stop();
    await mock.close();
  }
});

test('no backend configured: rewrite explains itself, suggest-name degrades to null', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    const res = await fetch(`${base}/api/prompts/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'anything' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'NO_LLM_BACKEND');
    assert.ok(body.error.includes('设置'), 'error carries setup guidance');
    assert.ok(body.error.includes('claude'), 'error mentions the CLI fallback');

    // suggest-name keeps its { name: null } contract
    const suggest = await sendJson(base, 'POST', '/api/library/suggest-name', { text: 'anything' });
    assert.equal(suggest.name, null);
  } finally {
    await stop();
  }
});

test('clustering analysis still works without any LLM backend (skipLlm path intact)', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    const analysis = await getJson(base, '/api/prompts/analyze?platform=codex&refresh=1&skipLlm=1');
    assert.equal(analysis.platform, 'codex');
    assert.ok(Array.isArray(analysis.clusters));
    assert.equal(analysis.llmError, null);
  } finally {
    await stop();
  }
});

test('analysis without skipLlm surfaces the no-backend error as llmError, clusters intact', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    const analysis = await getJson(base, '/api/prompts/analyze?platform=codex&refresh=1');
    assert.equal(analysis.platform, 'codex');
    assert.ok(Array.isArray(analysis.clusters));
    assert.ok(String(analysis.llmError || '').includes('未配置 LLM 后端'));
  } finally {
    await stop();
  }
});
