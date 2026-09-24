const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin/agentxray.js');
let home;
let rules;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-inspect-'));
  const source = fs.readFileSync(path.join(ROOT, 'frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  rules = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

function fixture(name, records) {
  const filename = path.join(home, name);
  fs.writeFileSync(
    filename,
    records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')
  );
  return filename;
}
const ompCall = (id, args = { command: 'PRIVATE_COMMAND' }, name = 'bash') => ({
  type: 'message',
  id: `${id}-call`,
  message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
});
const ompResult = (id, error = true) => ({
  type: 'message',
  id: `${id}-result`,
  message: {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    isError: error,
    details: { exitCode: error ? 1 : 0 },
    content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }],
  },
});
const records = () => [
  { type: 'session', id: 'PRIVATE_SESSION', cwd: '/PRIVATE_PATH' },
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] } },
  ompCall('PRIVATE_CALL'),
  ompResult('PRIVATE_CALL'),
];
function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 15000,
    ...options,
  });
}
function jsonReport(file, platform = 'omp', options = []) {
  return run(['inspect', '--platform', platform, file, '--json', ...options]);
}

test('offline inspect emits deterministic versioned minimized JSON and defaults to exit zero on findings', () => {
  const file = fixture('private-name.jsonl', records());
  const first = jsonReport(file),
    second = jsonReport(file);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.complete, true);
  assert.equal(report.summary.pendingRecords, 1);
  assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.engine.rulesSha256, /^[a-f0-9]{64}$/);
  assert.match(report.engine.adapterSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first.stdout, /PRIVATE_|private-name|agentxray-test|toolCallId|timestamp/);
  assert.deepEqual(report.events[0].failures, [{ line: 4, messageIndex: 4 }]);
});

test('pending failure policy exits two but does not alter report contents', () => {
  const file = fixture('policy.jsonl', records());
  const plain = jsonReport(file),
    gated = jsonReport(file, 'omp', ['--fail-on', 'pending-failures']);
  assert.equal(gated.status, 2);
  assert.equal(gated.stdout, plain.stdout);
  const recovered = fixture('recovered.jsonl', [...records(), ompCall('retry'), ompResult('retry', false)]);
  const result = jsonReport(recovered, 'omp', ['--fail-on', 'pending-failures']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.recoveredRecords, 1);
});

test('plain text is a factual summary with limits, not a task success assertion', () => {
  const result = run(['inspect', '--platform=omp', fixture('text.jsonl', records())]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pending failure records: 1/);
  assert.match(result.stdout, /not a task-success verdict/i);
  assert.doesNotMatch(result.stdout, /PRIVATE_/);
});

test('malformed or truncated line fails with safe line number instead of partial green report', () => {
  const file = fixture('broken.jsonl', [...records(), '{"PRIVATE_SECRET":']);
  const result = jsonReport(file);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /line 5/i);
  assert.doesNotMatch(result.stderr, /PRIVATE_SECRET|broken.jsonl|SyntaxError|\n\s+at /);
});

test('invalid UTF-8 and non-object records fail safely', () => {
  const file = path.join(home, 'utf8.jsonl');
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
  assert.equal(jsonReport(file).status, 1);
  for (const value of ['null', '[]', '42', '"secret"']) {
    const result = jsonReport(fixture('invalid-object.jsonl', [value]));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('wrong platform, unsupported format, empty files and metadata-only files cannot pass', () => {
  const file = fixture('wrong.jsonl', records());
  assert.equal(jsonReport(file, 'codex').status, 1);
  assert.equal(jsonReport(file, 'hermes').status, 1);
  assert.equal(jsonReport(fixture('empty.jsonl', [])).status, 1);
  assert.equal(jsonReport(fixture('metadata.jsonl', [{ type: 'session', id: 'only-meta' }])).status, 1);
});

test('directories, nonexistent files and oversized regular files fail without disclosing paths', () => {
  for (const file of [home, path.join(home, 'PRIVATE_NONEXISTENT')]) {
    const result = jsonReport(file);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /PRIVATE_NONEXISTENT|axr-inspect-/);
  }
  const file = path.join(home, 'large.jsonl');
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  const result = jsonReport(file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /64 MiB/);
});

test('inspect requires explicit single path/platform and validates flags', () => {
  const file = fixture('flags.jsonl', records());
  for (const args of [
    [],
    [file],
    ['--platform'],
    ['--platform', 'omp'],
    ['--platform', 'omp', file, file],
    ['--platform', 'omp', file, '--bad'],
    ['--platform', 'omp', file, '--fail-on', 'success'],
    ['--platform', 'omp', '--platform', 'codex', file],
    ['--platform', 'omp', file, '--fail-on'],
  ]) {
    assert.equal(run(['inspect', ...args]).status, 1);
  }
  const help = run(['inspect', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--platform/);
  assert.match(run(['--help']).stdout, /inspect/);
});

test('blank lines and CRLF retain original physical source positions', () => {
  const file = fixture('blank.jsonl', ['', JSON.stringify(ompCall('call')), '', JSON.stringify(ompResult('call')), '']);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  const result = jsonReport(file);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).events[0].failures, [{ line: 4, messageIndex: 3 }]);
});

test('Claude multi-result adapter loss is reported, never silently accepted as complete', () => {
  const file = fixture('claude-multi.jsonl', [
    {
      type: 'assistant',
      uuid: 'call',
      message: {
        content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: {} },
          { type: 'tool_use', id: 'two', name: 'Read', input: {} },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'results',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'one', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'two', content: 'PRIVATE_ERROR', is_error: true },
        ],
      },
    },
  ]);
  const result = jsonReport(file, 'claude-code', ['--fail-on', 'pending-failures']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, false);
  assert.equal(report.coverage.rawToolResults, 2);
  assert.equal(report.coverage.normalizedToolResults, 1);
  assert.ok(report.coverage.issues.some((issue) => issue.line === 2));
  assert.doesNotMatch(result.stdout, /PRIVATE_ERROR/);
});

test('mixed Claude text/result record remains visible as a coverage gap', () => {
  const file = fixture('claude-mixed.jsonl', [
    {
      type: 'user',
      uuid: 'mixed',
      message: {
        content: [
          { type: 'text', text: 'PRIVATE_PROMPT' },
          { type: 'tool_result', tool_use_id: 'one', content: 'PRIVATE_OUTPUT', is_error: true },
        ],
      },
    },
  ]);
  const result = jsonReport(file, 'claude-code');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).complete, false);
});

for (const [platform, relative] of [
  ['omp', 'frontend/demo/sample-logs/omp/-demo-diagnostics/2026-09-23T08-00-00-000Z_0199demo-diagnostics.jsonl'],
  [
    'codex',
    'frontend/demo/sample-logs/codex/2026/09/24/rollout-2026-09-24T08-00-00-01990000-0000-7000-8000-000000000199.jsonl',
  ],
  ['claude-code', 'frontend/demo/sample-logs/claude/-demo-webapp/synthetic-feature-dark-mode.jsonl'],
]) {
  test(`${platform} CLI summary matches UI rules and every evidence reference points into the input`, () => {
    const { normalizeRecords } = require('../lib/inspect');
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    const normalized = normalizeRecords(bytes, platform);
    const expected = rules.diagnoseSession(normalized.messages);
    const result = jsonReport(path.join(ROOT, relative), platform);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.failureRecords, expected.failureCount);
    assert.equal(report.summary.pendingRecords, expected.failures.length);
    assert.equal(report.summary.recoveredRecords, expected.recoveredCount);
    const checkRefs = (value) => {
      if (!value || typeof value !== 'object') return;
      if ('messageIndex' in value) {
        const message = normalized.messages[value.messageIndex - 1];
        assert.ok(message);
        assert.equal(normalized.lineOf.get(message), value.line);
      }
      for (const item of Object.values(value)) checkRefs(item);
    };
    checkRefs(report);
    assert.equal(report.events.flatMap((event) => event.failures).length, expected.failures.length);
  });
}

test('no service/network or writes to input/HOME are needed to inspect', () => {
  const file = fixture('readonly.jsonl', records());
  const guard = path.join(home, 'guard.cjs');
  fs.writeFileSync(
    guard,
    `const Module=require('node:module');const load=Module._load;Module._load=function(name,...rest){if(['express','http','https','net','node:http','node:https','node:net'].includes(name)||name.endsWith('/server.js'))throw Error('Forbidden runtime dependency');return load.call(this,name,...rest)};`
  );
  const before = fs.readFileSync(file);
  const entries = fs.readdirSync(home).sort();
  const result = jsonReport(file, 'omp', []);
  const isolated = run(['inspect', '--platform', 'omp', file, '--json'], {
    env: { ...process.env, HOME: home, NODE_OPTIONS: `--require=${guard}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.stdout, result.stdout);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(home).sort(), entries);
});

test('packaged rules are generated from the UI source and drift check passes', () => {
  const result = spawnSync(process.execPath, ['scripts/build-diagnostics.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('changed input metadata rejects the read instead of claiming a stable snapshot', () => {
  const file = fixture('changing.jsonl', records());
  const guard = path.join(home, 'changed-stat.cjs');
  fs.writeFileSync(
    guard,
    `const fs=require('node:fs/promises');const open=fs.open;fs.open=async function(...args){const handle=await open.apply(this,args);const stat=handle.stat.bind(handle);let reads=0;handle.stat=async()=>{const value=await stat();if(++reads>1)value.mtimeMs+=1;return value;};return handle;};`
  );
  const result = run(['inspect', '--platform', 'omp', file, '--json'], {
    env: { ...process.env, HOME: home, NODE_OPTIONS: `--require=${guard}` },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /changed during inspection/);
});

test('unrecognized private tool names are minimized and source content is never returned', () => {
  const file = fixture('private-tool.jsonl', [
    ompCall('PRIVATE_ID', { secret: 'PRIVATE_ARGUMENT' }, 'PRIVATE_TOOL'),
    ompResult('PRIVATE_ID'),
  ]);
  const result = jsonReport(file);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.events[0].tool, 'other');
  assert.doesNotMatch(result.stdout, /PRIVATE/);
});

test('input option terminator allows a dash-prefixed literal filename', () => {
  fixture('-literal.jsonl', records());
  const result = run(['inspect', '--json', '--platform', 'omp', '--', '-literal.jsonl'], { cwd: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.pendingRecords, 1);
});
