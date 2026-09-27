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
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_JSON');
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
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_RECORD');
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
  assert.equal(JSON.parse(result.stdout).error.code, 'INPUT_CHANGED');
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

function expand(file, report, line, options = []) {
  return run([
    'evidence',
    '--platform',
    report.source.platform,
    file,
    '--sha256',
    report.source.sha256,
    '--line',
    String(line),
    ...options,
  ]);
}

test('summary preserves full aggregate facts, omits raw data and is deterministic', () => {
  const file = fixture('summary.jsonl', records());
  const full = JSON.parse(jsonReport(file).stdout);
  const first = jsonReport(file, 'omp', ['--summary']);
  const summary = JSON.parse(first.stdout);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, jsonReport(file, 'omp', ['--summary']).stdout);
  assert.equal(summary.kind, 'summary');
  assert.equal(summary.schemaVersion, 1);
  assert.deepEqual(summary.source, full.source);
  assert.deepEqual(summary.engine, full.engine);
  assert.deepEqual(summary.summary, full.summary);
  assert.equal(summary.coverage.issueCount, 0);
  assert.deepEqual(summary.references.failures.items, [{ line: 4, messageIndex: 4 }]);
  assert.doesNotMatch(first.stdout, /PRIVATE_|summary.jsonl/);
  const gated = jsonReport(file, 'omp', ['--summary', '--fail-on', 'pending-failures']);
  assert.equal(gated.status, 2);
  assert.equal(gated.stdout, first.stdout);
});

test('summary bounds references without hiding their totals or counting groups as failures', () => {
  const entries = [];
  for (let index = 0; index < 50; index++) entries.push(ompCall(`call-${index}`), ompResult(`call-${index}`));
  const file = fixture('many-failures.jsonl', entries);
  const full = jsonReport(file);
  const compact = jsonReport(file, 'omp', ['--summary']);
  const summary = JSON.parse(compact.stdout);
  assert.equal(summary.summary.pendingRecords, 50);
  assert.equal(summary.summary.pendingEvents, 1);
  assert.equal(summary.references.failures.total, 50);
  assert.equal(summary.references.failures.shown, 5);
  assert.equal(summary.references.failures.truncated, true);
  assert.equal(summary.references.failures.items.length, 5);
  assert.ok(Buffer.byteLength(compact.stdout) < Buffer.byteLength(full.stdout));
  for (const category of Object.values(summary.references)) assert.ok(category.items.length <= 5);
});

test('summary keeps process, chronology and gap evidence from the same full report', () => {
  const file = path.join(
    ROOT,
    'frontend/demo/sample-logs/codex/2026/09/24/rollout-2026-09-24T08-00-00-01990000-0000-7000-8000-000000000199.jsonl'
  );
  const full = JSON.parse(jsonReport(file, 'codex').stdout);
  const summary = JSON.parse(jsonReport(file, 'codex', ['--summary']).stdout);
  assert.deepEqual(summary.summary, full.summary);
  assert.equal(summary.processes.launches, full.processes.entries.length);
  assert.equal(
    Object.values(summary.processes.states).reduce((total, count) => total + count, 0),
    full.processes.entries.length
  );
  assert.equal(summary.chronology.recognizedChecks, full.chronology.checks.length);
  assert.equal(summary.chronology.changedAfterLastPassedCheck, full.chronology.changedAfterLastPassedCheck);
  assert.ok(summary.references.processes.total > 0);
  const expected = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.messageIndex) expected.add(`${value.line}:${value.messageIndex}`);
    Object.values(value).forEach(visit);
  };
  visit(full);
  for (const category of Object.values(summary.references)) {
    for (const reference of category.items) assert.ok(expected.has(`${reference.line}:${reference.messageIndex}`));
  }
});

test('JSON errors have stable codes, safe messages and no source content regardless of flag order', () => {
  const file = fixture('errors.jsonl', records());
  for (const options of [
    ['--bad', '--json'],
    ['--json', '--bad'],
    ['--platform', 'omp', '--json'],
    ['--platform', 'omp', file, '--json', '--json'],
    ['--summary', '--json'],
  ]) {
    const result = run(['inspect', ...options]);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stdout);
    assert.equal(error.kind, 'error');
    assert.equal(error.schemaVersion, 1);
    assert.equal(error.error.code, 'INVALID_ARGUMENT');
  }
  for (const [filename, platform, code] of [
    [path.join(home, 'PRIVATE_MISSING'), 'omp', 'INPUT_UNREADABLE'],
    [home, 'omp', 'NOT_REGULAR_FILE'],
    [file, 'private-platform', 'UNSUPPORTED_PLATFORM'],
    [fixture('empty-error.jsonl', []), 'omp', 'NO_SUPPORTED_MESSAGES'],
  ]) {
    const result = jsonReport(filename, platform);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|private-platform|axr-inspect-/);
  }
});

test('non-JSON inspect errors stay on stderr and summary requires explicit JSON mode', () => {
  const file = fixture('summary-text.jsonl', records());
  const result = run(['inspect', '--platform', 'omp', file, '--summary']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--summary requires --json/);
  fixture('--json', records());
  const literal = run(['inspect', '--platform', 'omp', '--', '--json'], { cwd: home });
  assert.equal(literal.status, 0);
  assert.match(literal.stdout, /offline evidence report/);
});

test('evidence expands only the selected physical record with an explicit matching hash', () => {
  const file = fixture('evidence.jsonl', records());
  const full = JSON.parse(jsonReport(file).stdout);
  const result = expand(file, full, full.events[0].failures[0].line);
  const evidence = JSON.parse(result.stdout);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidence.kind, 'evidence');
  assert.deepEqual(evidence.source, full.source);
  assert.deepEqual(evidence.reference, { line: 4 });
  assert.equal(evidence.content, fs.readFileSync(file, 'utf8').split('\n')[3]);
  assert.match(evidence.content, /PRIVATE_OUTPUT/);
  assert.doesNotMatch(evidence.content, /PRIVATE_PROMPT|PRIVATE_COMMAND/);
  assert.equal(evidence.returnedBytes, Buffer.byteLength(evidence.content));
  assert.equal(evidence.nextOffset, null);
  assert.equal(evidence.truncated, false);
  assert.equal(result.stdout, expand(file, full, 4, ['--json']).stdout);
});

test('evidence rejects changed hashes and snapshots before returning any raw content', () => {
  const file = fixture('stale-evidence.jsonl', records());
  const full = JSON.parse(jsonReport(file).stdout);
  fs.appendFileSync(file, '\n');
  const mismatch = expand(file, full, 4);
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).error.code, 'SOURCE_HASH_MISMATCH');
  assert.doesNotMatch(mismatch.stdout + mismatch.stderr, /PRIVATE_|stale-evidence|axr-inspect-/);
  const guard = path.join(home, 'evidence-changing.cjs');
  fs.writeFileSync(
    guard,
    `const fs=require('node:fs/promises');const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);const stat=handle.stat.bind(handle);let count=0;handle.stat=async()=>{const value=await stat();if(++count>1)value.ctimeMs++;return value;};return handle;};`
  );
  const changed = run(['evidence', '--platform', 'omp', file, '--sha256', full.source.sha256, '--line', '4'], {
    env: { ...process.env, HOME: home, NODE_OPTIONS: `--require=${guard}` },
  });
  assert.equal(JSON.parse(changed.stdout).error.code, 'INPUT_CHANGED');
});

test('evidence default cap and UTF-8 byte pagination reassemble a long Unicode record', () => {
  const entries = records();
  entries[3].message.content[0].text = '你好🌍'.repeat(700);
  const file = fixture('unicode-evidence.jsonl', entries);
  const full = JSON.parse(jsonReport(file).stdout);
  const first = JSON.parse(expand(file, full, 4).stdout);
  assert.ok(first.returnedBytes <= 4096);
  assert.equal(first.truncated, true);
  assert.ok(first.nextOffset > 0);
  const chunks = [];
  let offset = 0;
  do {
    const response = expand(file, full, 4, ['--offset', String(offset), '--max-bytes', '511']);
    assert.equal(response.status, 0, response.stderr);
    const page = JSON.parse(response.stdout);
    assert.equal(page.offset, offset);
    assert.ok(page.returnedBytes <= 511 && page.returnedBytes > 0);
    assert.equal(page.returnedBytes, Buffer.byteLength(page.content));
    chunks.push(page.content);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(chunks.join(''), JSON.stringify(entries[3]));
  const bytes = Buffer.from(JSON.stringify(entries[3]));
  const inside = bytes.indexOf(Buffer.from('你')) + 1;
  assert.equal(JSON.parse(expand(file, full, 4, ['--offset', String(inside)]).stdout).error.code, 'INVALID_OFFSET');
});

test('evidence preserves BOM, blank lines, CRLF and a final record without a newline', () => {
  const file = fixture('line-shape.jsonl', records());
  const original = `\ufeff${JSON.stringify(records()[0])}\r\n\r\n${JSON.stringify(ompCall('one'))}\r\n${JSON.stringify(ompResult('one'))}`;
  fs.writeFileSync(file, original);
  const full = JSON.parse(jsonReport(file).stdout);
  for (let line = 1; line <= 4; line++) {
    const result = expand(file, full, line);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).content, original.split('\n')[line - 1]);
  }
  assert.equal(JSON.parse(expand(file, full, 5).stdout).error.code, 'LINE_OUT_OF_RANGE');
});

test('evidence rejects invalid options and enforces content bounds without clamping silently', () => {
  const file = fixture('bounds.jsonl', records());
  const full = JSON.parse(jsonReport(file).stdout);
  for (const [options, code] of [
    [['--max-bytes', '0'], 'INVALID_ARGUMENT'],
    [['--max-bytes', '3'], 'INVALID_ARGUMENT'],
    [['--max-bytes', '16385'], 'INVALID_ARGUMENT'],
    [['--offset', '1.5'], 'INVALID_ARGUMENT'],
    [['--offset', '9007199254740992'], 'INVALID_ARGUMENT'],
    [['--offset', '999999'], 'OFFSET_OUT_OF_RANGE'],
    [['--fail-on', 'pending-failures'], 'INVALID_ARGUMENT'],
    [['--summary'], 'INVALID_ARGUMENT'],
  ]) {
    const result = expand(file, full, 4, options);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.doesNotMatch(result.stdout, /PRIVATE_/);
  }
  for (const args of [[], ['--platform', 'omp', file], ['--platform', 'omp', file, '--sha256', 'bad', '--line', '1']]) {
    assert.equal(JSON.parse(run(['evidence', ...args]).stdout).error.code, 'INVALID_ARGUMENT');
  }
  const total = Buffer.byteLength(JSON.stringify(records()[3]));
  const exhausted = JSON.parse(expand(file, full, 4, ['--offset', String(total)]).stdout);
  assert.equal(exhausted.content, '');
  assert.equal(exhausted.nextOffset, null);
  assert.equal(exhausted.returnedBytes, 0);
});

test('incomplete coverage retains summary and explicit evidence data with structured stderr', () => {
  const file = fixture('coverage-detail.jsonl', [
    {
      type: 'user',
      uuid: 'mixed',
      message: {
        content: [
          { type: 'text', text: 'PRIVATE_TEXT' },
          { type: 'tool_result', tool_use_id: 'one', content: 'PRIVATE_OUTPUT', is_error: true },
        ],
      },
    },
  ]);
  const fullResult = jsonReport(file, 'claude-code');
  const full = JSON.parse(fullResult.stdout);
  assert.equal(JSON.parse(fullResult.stderr).error.code, 'COVERAGE_INCOMPLETE');
  const summaryResult = jsonReport(file, 'claude-code', ['--summary', '--fail-on', 'pending-failures']);
  const summary = JSON.parse(summaryResult.stdout);
  assert.equal(summaryResult.status, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.coverage.issueCount, full.coverage.issues.length);
  assert.deepEqual(summary.references.coverage.items, [{ line: 1 }]);
  const raw = expand(file, full, 1);
  assert.equal(raw.status, 1);
  assert.equal(JSON.parse(raw.stdout).kind, 'evidence');
  assert.equal(JSON.parse(raw.stdout).complete, false);
  assert.equal(JSON.parse(raw.stderr).error.code, 'COVERAGE_INCOMPLETE');
});

test('summary and evidence require no network, server or filesystem writes', () => {
  const file = fixture('no-side-effects.jsonl', records());
  const report = JSON.parse(jsonReport(file).stdout);
  const guard = path.join(home, 'detail-offline-guard.cjs');
  fs.writeFileSync(
    guard,
    `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(['express','http','https','net','node:http','node:https','node:net'].includes(name)||name.endsWith('/server.js'))throw Error('Forbidden');return load.call(this,name,...args);};`
  );
  const entries = fs.readdirSync(home).sort();
  const bytes = fs.readFileSync(file);
  for (const args of [
    ['inspect', '--platform', 'omp', file, '--summary', '--json'],
    ['evidence', '--platform', 'omp', file, '--sha256', report.source.sha256, '--line', '4'],
  ]) {
    const result = run(args, { env: { ...process.env, HOME: home, NODE_OPTIONS: `--require=${guard}` } });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(home).sort(), entries);
});

test('structured errors expose distinct invalid UTF-8 and unsupported-record codes', () => {
  const file = path.join(home, 'bad-utf8.jsonl');
  fs.writeFileSync(file, Buffer.from([255]));
  assert.equal(JSON.parse(jsonReport(file).stdout).error.code, 'INVALID_UTF8');
  const invalid = fixture('invalid-record-shape.jsonl', [
    { type: 'message', message: { role: 'assistant', content: [null] } },
  ]);
  assert.equal(JSON.parse(jsonReport(invalid).stdout).error.code, 'UNSUPPORTED_RECORD');
});

test('evidence validates the entire input even when the requested line is well formed', () => {
  const { createHash } = require('node:crypto');
  const file = fixture('evidence-invalid-tail.jsonl', [...records(), '{"PRIVATE_BROKEN":']);
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const response = run(['evidence', '--platform', 'omp', file, '--sha256', digest, '--line', '4']);
  assert.equal(response.status, 1);
  assert.equal(JSON.parse(response.stdout).error.code, 'INVALID_JSON');
  assert.doesNotMatch(response.stdout + response.stderr, /PRIVATE_/);
});

test('evidence handles a four-byte boundary, case-insensitive hashes and trailing LF correctly', () => {
  const entries = records();
  entries[3].message.content[0].text = '🌍中';
  const file = fixture('four-byte.jsonl', [...entries, '']);
  const report = JSON.parse(jsonReport(file).stdout);
  report.source.sha256 = report.source.sha256.toUpperCase();
  const raw = Buffer.from(JSON.stringify(entries[3]));
  const offset = raw.indexOf(Buffer.from('🌍'));
  const response = expand(file, report, 4, ['--offset', String(offset), '--max-bytes', '4']);
  assert.equal(response.status, 0, response.stderr);
  const page = JSON.parse(response.stdout);
  assert.equal(page.content, '🌍');
  assert.equal(page.returnedBytes, 4);
  assert.equal(page.nextOffset, offset + 4);
  assert.equal(JSON.parse(expand(file, report, 5).stdout).error.code, 'LINE_OUT_OF_RANGE');
});

test('missing bundled implementation and unexpected runtime errors remain structured and safe', () => {
  const file = fixture('runtime-error.jsonl', records());
  for (const [name, body, expected] of [
    ['load', 'if(name==="../lib/inspect")throw Error("PRIVATE_LOAD");', 'RULES_UNAVAILABLE'],
    [
      'runtime',
      'if(name==="../lib/inspect"){const value=load.call(this,name,...args);return {...value,inspectFile:async()=>{throw Error("PRIVATE_RUNTIME")}};}',
      'INSPECTION_FAILED',
    ],
  ]) {
    const guard = path.join(home, `${name}-error.cjs`);
    fs.writeFileSync(
      guard,
      `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){${body}return load.call(this,name,...args)};`
    );
    const response = run(['inspect', '--platform', 'omp', file, '--json'], {
      env: { ...process.env, HOME: home, NODE_OPTIONS: `--require=${guard}` },
    });
    assert.equal(response.status, 1);
    assert.equal(JSON.parse(response.stdout).error.code, expected);
    assert.doesNotMatch(response.stdout + response.stderr, /PRIVATE_|at .*\.js/);
  }
});
