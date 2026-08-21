const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const textUtils = require(path.join(__dirname, '..', 'lib', 'text-utils'));
const llmJson = require(path.join(__dirname, '..', 'lib', 'llm-json'));
const pure = require(path.join(__dirname, '..', 'public', 'js', 'pure.js'));

// --- lib/text-utils ---

test('normalizePromptText collapses whitespace and trims', () => {
  assert.equal(textUtils.normalizePromptText('  a\n\t b   c  '), 'a b c');
  assert.equal(textUtils.normalizePromptText(''), '');
  assert.equal(textUtils.normalizePromptText(null), '');
  assert.equal(textUtils.normalizePromptText(undefined), '');
});

test('hashPromptText is stable and normalization-insensitive', () => {
  const a = textUtils.hashPromptText(textUtils.normalizePromptText('fix the   bug\nin auth'));
  const b = textUtils.hashPromptText(textUtils.normalizePromptText('fix the bug in auth'));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  // Same input always hashes identically
  assert.equal(textUtils.hashPromptText('hello'), textUtils.hashPromptText('hello'));
  // Different input differs
  assert.notEqual(textUtils.hashPromptText('hello'), textUtils.hashPromptText('hello!'));
});

test('extractErrorSnippet skips trivial structural lines including lone {', () => {
  // Historical case: JSON-body error whose first line is a lone brace
  const snippet = textUtils.extractErrorSnippet([{ type: 'text', text: '{\n  "error": "rate limit exceeded"\n}' }]);
  assert.equal(snippet, '"error": "rate limit exceeded"');
});

test('extractErrorSnippet handles string content, arrays of strings, and empty', () => {
  assert.equal(textUtils.extractErrorSnippet('boom happened\nsecond line'), 'boom happened');
  assert.equal(textUtils.extractErrorSnippet(['```', 'ENOENT: no such file']), 'ENOENT: no such file');
  // Purely structural input falls back to the collapsed joined text
  assert.equal(textUtils.extractErrorSnippet('{ }\n[ ]'), '{ } [ ]');
  assert.equal(textUtils.extractErrorSnippet(null), '');
});

test('extractErrorSnippet truncates to 200 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(textUtils.extractErrorSnippet(long).length, 200);
});

test('normalizeErrorPattern lowercases, strips paths and hex ids', () => {
  assert.equal(textUtils.normalizeErrorPattern(''), '(empty)');
  assert.equal(textUtils.normalizeErrorPattern(null), '(empty)');
  const out = textUtils.normalizeErrorPattern('ENOENT /Users/me/project/file.txt not found');
  assert.equal(out, 'enoent /… not found');
  const hex = textUtils.normalizeErrorPattern('session deadbeef01234567 crashed');
  assert.equal(hex, 'session … crashed');
  // Only first line is used, capped at 120
  assert.equal(textUtils.normalizeErrorPattern('first\nsecond'), 'first');
  assert.ok(textUtils.normalizeErrorPattern('z'.repeat(300)).length <= 120);
});

// --- lib/llm-json ---

test('parseLlmJson parses plain JSON', () => {
  assert.deepEqual(llmJson.parseLlmJson('{"a": 1, "b": [2, 3]}'), { a: 1, b: [2, 3] });
  assert.deepEqual(llmJson.parseLlmJson('[1, 2]'), [1, 2]);
});

test('parseLlmJson extracts fenced JSON', () => {
  assert.deepEqual(llmJson.parseLlmJson('Here you go:\n```json\n{"ok": true}\n```\nDone.'), { ok: true });
  assert.deepEqual(llmJson.parseLlmJson('```\n{"ok": 2}\n```'), { ok: 2 });
});

test('parseLlmJson handles anchored fence containing inner fences', () => {
  const raw = '```json\n{"suggestions": [{"content": "use ```bash\\n...\\n``` blocks"}]}\n```';
  const parsed = llmJson.parseLlmJson(raw);
  assert.ok(parsed && Array.isArray(parsed.suggestions));
});

test('parseLlmJson repairs unescaped inner quotes (real failure shape)', () => {
  // Derived from the real failure: LLM quotes Chinese terms with literal "
  const raw = '```json\n{"overall": ["用户常说 "帮我修复" 这类模板", "第二条"], "suggestions": []}\n```';
  const parsed = llmJson.parseLlmJson(raw);
  assert.ok(parsed, 'expected repaired parse, got null');
  assert.equal(parsed.overall[0], '用户常说 "帮我修复" 这类模板');
  assert.equal(parsed.overall[1], '第二条');
  assert.deepEqual(parsed.suggestions, []);
});

test('parseLlmJson returns null on garbage', () => {
  assert.equal(llmJson.parseLlmJson('no json here at all'), null);
  assert.equal(llmJson.parseLlmJson(''), null);
  assert.equal(llmJson.parseLlmJson(null), null);
});

test('repairLlmJsonQuotes escapes content quotes, keeps terminators', () => {
  assert.equal(llmJson.repairLlmJsonQuotes('{"a": "x "y" z"}'), '{"a": "x \\"y\\" z"}');
  // Already-valid JSON passes through unchanged
  const valid = '{"a": "clean", "b": 1}';
  assert.equal(llmJson.repairLlmJsonQuotes(valid), valid);
});

// --- public/js/pure.js ---

test('pure.js exports the moved helpers via require', () => {
  for (const name of [
    'firstInformativeLine',
    'formatDurationCompact',
    'formatBytes',
    'formatCost',
    'buildTraceTurns',
    'parseTimestampMs',
    'getTextContent',
    'clusterPrefillContent',
  ]) {
    assert.equal(typeof pure[name], 'function', `${name} missing`);
  }
});

test('firstInformativeLine skips structural lines', () => {
  assert.equal(pure.firstInformativeLine('{\n[\n```\nActual error text\nmore'), 'Actual error text');
  assert.equal(pure.firstInformativeLine(''), '');
  assert.equal(pure.firstInformativeLine('plain'), 'plain');
  // All-structural falls back to collapsed whole text
  assert.equal(pure.firstInformativeLine('{}\n[]'), '{} []');
});

test('formatDurationCompact edge cases', () => {
  assert.equal(pure.formatDurationCompact(0), '0s');
  assert.equal(pure.formatDurationCompact(-5), '0s');
  assert.equal(pure.formatDurationCompact(NaN), '0s');
  assert.equal(pure.formatDurationCompact(Infinity), '0s');
  assert.equal(pure.formatDurationCompact(1234), '1.2s'); // sub-10s: one decimal
  assert.equal(pure.formatDurationCompact(9990), '10s'); // rounds to 10 at the boundary
  assert.equal(pure.formatDurationCompact(45000), '45s');
  assert.equal(pure.formatDurationCompact(60000), '1m');
  assert.equal(pure.formatDurationCompact(90000), '1m30s');
  assert.equal(pure.formatDurationCompact(3600000), '1h');
  assert.equal(pure.formatDurationCompact(3660000), '1h1m');
  assert.equal(pure.formatDurationCompact(3605000), '1h5s'); // hours + bare seconds
});

test('formatBytes and formatCost', () => {
  assert.equal(pure.formatBytes(0), '0 B');
  assert.equal(pure.formatBytes(512), '512 B');
  assert.equal(pure.formatBytes(2048), '2.0 KB');
  assert.equal(pure.formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(pure.formatCost(1.234), '$1.23');
  assert.equal(pure.formatCost(0.0012), '$0.0012');
  assert.equal(pure.formatCost(0.01), '$0.01');
});

test('parseTimestampMs', () => {
  assert.equal(pure.parseTimestampMs(null), null);
  assert.equal(pure.parseTimestampMs('not a date'), null);
  assert.equal(pure.parseTimestampMs('2026-01-01T00:00:00.000Z'), 1767225600000);
});

test('getTextContent joins text parts only', () => {
  assert.equal(
    pure.getTextContent([
      { type: 'text', text: 'a' },
      { type: 'toolCall', id: 'x' },
      { type: 'text', text: 'b' },
    ]),
    'a\n\nb'
  );
  assert.equal(pure.getTextContent(null), '');
});

test('clusterPrefillContent uses LCP with $ARGUMENTS for real templates', () => {
  const prefix = 'Please review the following pull request carefully: ';
  const c = { samples: [prefix + 'auth changes', prefix + 'billing refactor'] };
  assert.equal(pure.clusterPrefillContent(c), prefix.trimEnd() + ' $ARGUMENTS');
  // Short common prefix → first example verbatim
  assert.equal(pure.clusterPrefillContent({ samples: ['ab one', 'ab two'] }), 'ab one');
  // No examples → pattern fallback
  assert.equal(pure.clusterPrefillContent({ pattern: 'p' }), 'p');
});

test('pickAutoPlatform picks the first platform with sessions, in order', () => {
  const order = ['openclaw', 'codex', 'claude-code'];
  assert.equal(pure.pickAutoPlatform({ openclaw: 0, codex: 3, 'claude-code': 5 }, order), 'codex');
  assert.equal(pure.pickAutoPlatform({ openclaw: 1, codex: 3 }, order), 'openclaw');
  // Missing counts are treated as empty
  assert.equal(pure.pickAutoPlatform({ 'claude-code': 2 }, order), 'claude-code');
  // All empty / probe not done yet → null (guided empty state)
  assert.equal(pure.pickAutoPlatform({ openclaw: 0, codex: 0, 'claude-code': 0 }, order), null);
  assert.equal(pure.pickAutoPlatform(null, order), null);
  assert.equal(pure.pickAutoPlatform(undefined, order), null);
});

// --- buildTraceTurns on a synthetic session ---

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function syntheticMessages() {
  return [
    { id: 'u1', role: 'user', timestamp: iso(0), content: [{ type: 'text', text: 'first question' }] },
    // Reasoning between user and assistant must NOT advance the clock:
    // the chat span still starts at the user message.
    { id: 'r1', role: 'reasoning', timestamp: iso(2000), content: [{ type: 'text', text: 'thinking' }] },
    {
      id: 'a1',
      role: 'assistant',
      timestamp: iso(5000),
      model: 'vendor/model-x',
      content: [{ type: 'text', text: 'answer' }],
    },
    // Standalone toolCall→toolResult pair (error)
    { id: 'tc1', role: 'toolCall', timestamp: iso(6000), toolCallId: 'call-1', toolName: 'bash' },
    { id: 'tr1', role: 'toolResult', timestamp: iso(8000), toolCallId: 'call-1', isError: true },
    // Second turn
    { id: 'u2', role: 'user', timestamp: iso(20000), content: [{ type: 'text', text: 'second question' }] },
    // Content-part tool_use / tool_result pairing (claude-code shape)
    {
      id: 'a2',
      role: 'assistant',
      timestamp: iso(23000),
      content: [
        { type: 'text', text: 'using a tool' },
        { type: 'tool_use', id: 'call-2', name: 'Read' },
      ],
    },
    {
      id: 'u3',
      role: 'user',
      timestamp: iso(25000),
      content: [{ type: 'tool_result', tool_use_id: 'call-2', is_error: false }],
    },
  ];
}

test('buildTraceTurns splits turns on user messages', () => {
  const turns = pure.buildTraceTurns(syntheticMessages());
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'first question');
  assert.equal(turns[1].text, 'second question');
  assert.equal(turns[0].start, T0);
  assert.equal(turns[1].start, T0 + 20000);
});

test('buildTraceTurns: reasoning does not advance the clock', () => {
  const turns = pure.buildTraceTurns(syntheticMessages());
  const chat = turns[0].spans.find((s) => s.kind === 'chat');
  assert.ok(chat, 'expected a chat span in turn 1');
  // Span starts at the user timestamp (T0), NOT the reasoning timestamp (T0+2000)
  assert.equal(chat.start, T0);
  assert.equal(chat.end, T0 + 5000);
  assert.equal(chat.label, 'model-x'); // vendor prefix stripped
  assert.equal(chat.msgId, 'a1');
});

test('buildTraceTurns pairs standalone toolCall→toolResult and flags errors', () => {
  const turns = pure.buildTraceTurns(syntheticMessages());
  const tool = turns[0].spans.find((s) => s.toolCallId === 'call-1');
  assert.ok(tool, 'expected tool span for call-1');
  assert.equal(tool.kind, 'tool-error');
  assert.equal(tool.label, 'bash');
  assert.equal(tool.start, T0 + 6000);
  assert.equal(tool.end, T0 + 8000);
});

test('buildTraceTurns pairs content-part tool_use→tool_result in the owning turn', () => {
  const turns = pure.buildTraceTurns(syntheticMessages());
  const tool = turns[1].spans.find((s) => s.toolCallId === 'call-2');
  assert.ok(tool, 'expected tool span for call-2');
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.label, 'Read');
  assert.equal(tool.start, T0 + 23000);
  assert.equal(tool.end, T0 + 25000);
});

test('buildTraceTurns: unanswered call gets a 50ms floor span', () => {
  const msgs = [
    { id: 'u1', role: 'user', timestamp: iso(0), content: [{ type: 'text', text: 'q' }] },
    { id: 'tc', role: 'toolCall', timestamp: iso(1000), toolCallId: 'lonely', toolName: 'fetch' },
  ];
  const turns = pure.buildTraceTurns(msgs);
  assert.equal(turns.length, 1);
  const span = turns[0].spans.find((s) => s.toolCallId === 'lonely');
  assert.equal(span.end, T0 + 1000 + 50);
  assert.equal(span.kind, 'tool');
});

test('buildTraceTurns attaches agentSpans to the turn they started in', () => {
  const spans = [
    { name: 'Child1', label: 'scout child', start: T0 + 7000, end: T0 + 15000 },
    { name: 'Child2', start: T0 + 21000, end: null }, // no end → 50ms floor; label falls back to name
  ];
  const turns = pure.buildTraceTurns(syntheticMessages(), spans);
  const a1 = turns[0].spans.find((s) => s.kind === 'agent');
  assert.ok(a1, 'agent span in turn 1');
  assert.equal(a1.label, 'scout child');
  assert.equal(a1.agentName, 'Child1');
  assert.equal(turns[0].end, T0 + 15000); // turn end extended by the agent span
  const a2 = turns[1].spans.find((s) => s.kind === 'agent');
  assert.equal(a2.label, 'Child2');
  assert.equal(a2.end, T0 + 21000 + 50);
});

test('buildTraceTurns drops turns without spans and sorts spans by start', () => {
  // A lone user message with no activity yields no turns
  assert.deepEqual(
    pure.buildTraceTurns([{ id: 'u', role: 'user', timestamp: iso(0), content: [{ type: 'text', text: 'hi' }] }]),
    []
  );
  // Messages without timestamps are ignored entirely
  assert.deepEqual(pure.buildTraceTurns([{ id: 'x', role: 'user', content: [] }]), []);
  const turns = pure.buildTraceTurns(syntheticMessages());
  for (const tn of turns) {
    const starts = tn.spans.map((s) => s.start);
    assert.deepEqual(
      starts,
      [...starts].sort((a, b) => a - b)
    );
  }
});

// --- markdown/escape pipeline (single definition site: frontend/src/lib/markdown.ts,
// bundled into public/js/pure.js for the legacy UI and these tests) ---

test('pure.js exposes the markdown pipeline', () => {
  for (const name of ['escapeHtml', 'renderMarkdownHtml', 'renderMarkdown']) {
    assert.equal(typeof pure[name], 'function', `${name} missing`);
  }
});

test('escapeHtml neutralizes all five HTML metacharacters', () => {
  assert.equal(
    pure.escapeHtml(`<img src=x onerror='a' "b" & c>`),
    '&lt;img src=x onerror=&#39;a&#39; &quot;b&quot; &amp; c&gt;'
  );
  assert.equal(pure.escapeHtml(null), 'null');
});

test('renderMarkdown escapes first, then transforms (XSS-safe)', () => {
  // Raw HTML in the input must never survive as markup
  const html = pure.renderMarkdown('<script>alert(1)</script> **bold**');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.startsWith('<div class="markdown">'));
});

test('renderMarkdownHtml renders headings, lists, links and fenced code', () => {
  const html = pure.renderMarkdownHtml(
    '# Title\n\n- item1\n- item2\n\n1. one\n\n[x](https://e.co/a&b)\n\n```js\ncode<>\n```'
  );
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<ul><li>item1</li><li>item2</li></ul>'));
  assert.ok(html.includes('<ol><li>one</li></ol>'));
  assert.ok(html.includes('<a href="https://e.co/a&amp;b" target="_blank" rel="noopener">x</a>'));
  assert.ok(html.includes('<pre><code data-lang="js">code&lt;&gt;\n</code></pre>'));
});
