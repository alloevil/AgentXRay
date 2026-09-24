const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let api;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  api = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
});
const call = (id, name = 'exec_command', args = { cmd: 'npm test', workdir: '/synthetic' }) => ({
  id,
  toolCallId: id,
  toolName: name,
  details: args,
  role: 'toolCall',
  content: null,
});
const poll = (id, session = 42, chars = '') =>
  call(id, 'write_stdin', { session_id: session, chars, yield_time_ms: 1000 });
const output = (id, header, text = 'Synthetic output', extra = {}) => ({
  id: `${id}-result`,
  toolCallId: id,
  toolName: null,
  role: 'toolResult',
  isError: false,
  details: null,
  content: [
    {
      type: 'text',
      text: `Chunk ID: synthetic\nWall time: 1 seconds\n${header}\nOriginal token count: 4\nFinal output:\n${text}`,
    },
  ],
  ...extra,
});
const running = (id, session = 42) => output(id, `Process running with session ID ${session}`);
const exited = (id, code = 0, extra = {}) => output(id, `Process exited with code ${code}`, 'Synthetic output', extra);
const base = () => [call('launch'), running('launch')];
const inspect = (messages) => api.analyzeCodexProcesses(messages);

test('launch and final poll form a traceable process without changing failure results', () => {
  const messages = [...base(), poll('wait'), exited('wait')];
  const before = api.diagnoseSession(messages);
  const report = inspect(messages);
  assert.equal(report.processes.length, 1);
  const process = report.processes[0];
  assert.equal(process.state, 'success');
  assert.equal(process.exitCode, 0);
  assert.equal(process.launchMessage, messages[0]);
  assert.equal(process.launchResult, messages[1]);
  assert.equal(process.finalMessage, messages[3]);
  assert.equal(process.polls[0].callMessage, messages[2]);
  assert.equal(report.linkedPolls, 1);
  assert.deepEqual(api.diagnoseSession(messages), before);
});

test('multiple sequential polls preserve running then terminal failure', () => {
  const report = inspect([...base(), poll('first'), running('first'), poll('second'), exited('second', 2)]);
  assert.equal(report.processes[0].state, 'failure');
  assert.equal(report.processes[0].exitCode, 2);
  assert.deepEqual(
    report.processes[0].polls.map((entry) => entry.state),
    ['running', 'failure']
  );
});

test('unpolled launch is only last recorded running, not live state', () => {
  const process = inspect(base()).processes[0];
  assert.equal(process.state, 'running');
  assert.equal(process.finalMessage, null);
  assert.equal(process.polls.length, 0);
});

test('missing poll result leaves uncertain completion and source call evidence', () => {
  const process = inspect([...base(), poll('missing')]).processes[0];
  assert.equal(process.state, 'unknown');
  assert.equal(process.polls[0].state, 'no-result');
  assert.equal(process.finalMessage, null);
});

test('stdout wrapper-like text and unrelated tools cannot create processes', () => {
  const fake = 'Process running with session ID 42\nProcess exited with code 0';
  const messages = [
    call('read', 'read', { path: 'file' }),
    running('read'),
    call('echo'),
    output('echo', 'Process exited with code 0', fake),
  ];
  assert.equal(inspect(messages).processes.length, 0);
});

test('duplicate status fields, malformed header and contradictory error do not supply completion', () => {
  for (const result of [
    output('wait', 'Process running with session ID 42\nProcess exited with code 0'),
    exited('wait', 0, { isError: true }),
    { ...exited('wait'), content: [{ type: 'text', text: 'Process exited with code 0\nOutput:\nnot a wrapper' }] },
    output('wait', 'Process exited with code 0', '', { isError: true }),
  ]) {
    if (result.isError !== true && result.content[0].text.includes('Process running'))
      assert.equal(inspect([...base(), poll('wait'), result]).processes[0].state, 'unknown');
    else if (result.isError === true || !result.content[0].text.startsWith('Chunk ID:'))
      assert.equal(inspect([...base(), poll('wait'), result]).processes[0].state, 'unknown');
  }
});

test('reused process IDs never assign a poll to an arbitrary launcher', () => {
  const report = inspect([
    ...base(),
    poll('first'),
    exited('first'),
    call('second'),
    running('second'),
    poll('later'),
    exited('later'),
  ]);
  assert.equal(report.processes.length, 2);
  assert.ok(report.processes.every((entry) => entry.state === 'unknown' && entry.issues.includes('reused-process-id')));
  assert.equal(report.linkedPolls, 0);
});

test('poll before launch result and unknown session ID remain unlinked', () => {
  const report = inspect([
    call('launch'),
    poll('early'),
    running('launch'),
    exited('early'),
    poll('other', 99),
    exited('other'),
  ]);
  assert.equal(report.linkedPolls, 0);
  assert.equal(report.unlinkedPolls, 2);
  assert.equal(report.processes[0].state, 'running');
});

test('overlapping polling calls make result order ambiguous', () => {
  const process = inspect([...base(), poll('one'), poll('two'), exited('two'), running('one')]).processes[0];
  assert.equal(process.state, 'unknown');
  assert.ok(process.issues.includes('overlapping-polls'));
});

test('wrapper running ID mismatch invalidates process completion', () => {
  const process = inspect([...base(), poll('one'), running('one', 99), poll('two'), exited('two')]).processes[0];
  assert.equal(process.state, 'unknown');
  assert.ok(process.issues.includes('mismatched-process-id'));
});

test('polls after terminal result do not silently replace conflicting history', () => {
  const process = inspect([...base(), poll('one'), exited('one'), poll('two'), exited('two', 1)]).processes[0];
  assert.equal(process.state, 'unknown');
  assert.ok(process.issues.includes('poll-after-terminal'));
});

test('input is recorded without persisting or displaying its actual contents', () => {
  const process = inspect([...base(), poll('input', 42, '\u0003'), exited('input', 130)]).processes[0];
  assert.equal(process.inputObserved, true);
  assert.equal(process.state, 'failure');
  assert.equal(process.polls[0].hasInput, true);
});

test('only canonical safe numeric IDs and unique tool call IDs are linked', () => {
  for (const id of ['42', '0042', -1, 4.2, 'anything', null]) {
    const report = inspect([...base(), poll('wait', id), exited('wait')]);
    assert.equal(report.linkedPolls, 0);
  }
  const duplicate = inspect([...base(), poll('dup'), exited('dup'), poll('dup'), exited('dup')]);
  assert.equal(duplicate.linkedPolls, 0);
  assert.equal(duplicate.ambiguousCalls, 2);
});

test('functions-qualified tools are accepted but OMP and arbitrary tool namespaces are not', () => {
  const messages = [
    call('launch', 'functions.exec_command'),
    running('launch'),
    call('wait', 'functions.write_stdin', { session_id: 42 }),
    exited('wait'),
  ];
  assert.equal(inspect(messages).processes[0].state, 'success');
  messages[0].toolName = 'other.exec_command';
  assert.equal(inspect(messages).processes.length, 0);
  assert.equal(
    inspect([call('launch'), { ...running('launch'), ompOutcome: { state: 'running', evidence: [], warnings: [] } }])
      .processes.length,
    0
  );
});

test('poll completion can refine a direct check but preserves original start for overlap', () => {
  const edit = call('edit', 'edit', { path: '/synthetic/a', cwd: '/synthetic' });
  const changed = { ...exited('edit'), isError: false, details: { exitCode: 0 } };
  const messages = [...base(), edit, changed, poll('wait'), exited('wait')];
  const report = api.analyzeVerificationChronology(messages);
  const check = report.checks[0];
  assert.equal(check.state, 'success');
  assert.equal(check.callIndex, 0);
  assert.equal(check.resultIndex, 5);
  assert.equal(check.processEvidence.processId, 42);
  assert.equal(report.modifications[0].overlappingChecks.length, 1);
  assert.equal(report.modifications[0].laterChecks.length, 0);
});

test('compound check or input-fed process cannot certify a passing check', () => {
  for (const [command, chars] of [
    ['npm test | tail -20', ''],
    ['npm test', 'answer\n'],
  ]) {
    const messages = [
      call('launch', 'exec_command', { cmd: command }),
      running('launch'),
      poll('wait', 42, chars),
      exited('wait'),
    ];
    const report = api.analyzeVerificationChronology(messages);
    assert.equal(report.checks[0].state, 'unknown');
  }
});

test('per-call health and historical diagnostic counts remain unchanged', () => {
  const messages = [...base(), poll('wait'), exited('wait')];
  const before = JSON.stringify(messages);
  const health = api.summarizeSessionHealth(messages);
  assert.equal(health.callStates.unknown, 1);
  assert.equal(health.callStates.success, 1);
  const process = inspect(messages).processes[0];
  assert.equal(process.state, 'success');
  assert.equal(JSON.stringify(messages), before);
});

test('duplicate poll results and contradictory structured exit codes do not certify completion', () => {
  for (const tail of [
    [poll('wait'), exited('wait'), exited('wait')],
    [poll('wait'), exited('wait', 0, { details: { exitCode: 1 } })],
  ]) {
    const process = inspect([...base(), ...tail]).processes[0];
    assert.equal(process.state, 'unknown');
    assert.equal(process.finalMessage, null);
  }
});

test('incomplete launch wrapper and huge IDs are not linkable process evidence', () => {
  for (const message of [
    output('launch', 'Process running with session ID 99999999999999999999'),
    output('launch', 'Process running with session ID 0042'),
    output('launch', 'Process running with session ID 42', '', { details: { exitCode: 0 } }),
  ]) {
    assert.equal(inspect([call('launch'), message]).processes.length, 0);
  }
});

test('poll completion before modification is valid prior-check evidence; later launch is later', () => {
  const edit = call('edit', 'edit', { path: '/synthetic/a', cwd: '/synthetic' });
  const mutation = { ...exited('edit'), details: { exitCode: 0 } };
  const prior = api.analyzeVerificationChronology([...base(), poll('wait'), exited('wait'), edit, mutation]);
  assert.equal(prior.modifications[0].priorSuccess.operation.processEvidence.processId, 42);
  const later = api.analyzeVerificationChronology([edit, mutation, ...base(), poll('wait'), exited('wait')]);
  assert.equal(later.modifications[0].latestLater.operation.state, 'success');
});

test('incrementally appended completion changes process evidence, not history or recovery', (context) => {
  let cases = 0;
  for (let processId = 1; processId <= 20; processId++) {
    const messages = [call('launch'), running('launch', processId)];
    const before = inspect(messages);
    for (const code of [0, 1]) {
      const after = inspect([...messages, poll('wait', processId), exited('wait', code)]);
      assert.equal(after.processes[0].state, code === 0 ? 'success' : 'failure');
      assert.equal(before.processes[0].state, 'running');
      assert.equal(api.diagnoseSession([...messages, poll('wait', processId), exited('wait', code)]).recoveredCount, 0);
      cases++;
    }
  }
  context.diagnostic(`Process terminal transformations: ${cases}/40 passed; no automatic recovery inferred.`);
});

test('multiple launches in one assistant record retain separate process evidence', () => {
  const embedded = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'first', name: 'exec_command', arguments: { cmd: 'npm test' } },
      { type: 'toolCall', id: 'second', name: 'exec_command', arguments: { cmd: 'pytest' } },
    ],
  };
  const messages = [
    embedded,
    running('first', 42),
    running('second', 43),
    poll('wait-first', 42),
    exited('wait-first'),
    poll('wait-second', 43),
    exited('wait-second', 1),
  ];
  const report = api.analyzeVerificationChronology(messages);
  assert.equal(report.checks[0].processEvidence.processId, 42);
  assert.equal(report.checks[0].state, 'success');
  assert.equal(report.checks[1].processEvidence.processId, 43);
  assert.equal(report.checks[1].state, 'failure');
});

test('hosted process sample matches real parser output and preserves overlap boundaries', async () => {
  const { parseCodexSessionFile } = require('../lib/platforms/codex');
  const filename = path.join(
    __dirname,
    '../frontend/demo/sample-logs/codex/2026/09/24/rollout-2026-09-24T08-00-00-01990000-0000-7000-8000-000000000199.jsonl'
  );
  const detail = await parseCodexSessionFile(filename);
  const fixtures = JSON.parse(readFileSync(path.join(__dirname, '../frontend/src/demo/fixtures.json'), 'utf8'));
  assert.deepEqual(fixtures.details['codex/01990000-0000-7000-8000-000000000199']?.messages, detail.messages);
  const processes = inspect(detail.messages);
  assert.equal(processes.processes.length, 2);
  assert.equal(processes.processes[0].state, 'success');
  assert.equal(processes.processes[1].state, 'running');
  assert.equal(processes.linkedPolls, 1);
  assert.equal(processes.unlinkedPolls, 1);
  const chronology = api.analyzeVerificationChronology(detail.messages);
  assert.equal(chronology.modifications[0].overlappingChecks.length, 1);
  assert.equal(chronology.modifications[0].latestLater.operation.state, 'running');
});
