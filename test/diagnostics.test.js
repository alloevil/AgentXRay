const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let diagnoseSession;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  const javascript = stripTypeScriptTypes(source);
  ({ diagnoseSession } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`));
});

function message(overrides) {
  return {
    id: null,
    timestamp: null,
    role: 'assistant',
    content: [],
    details: null,
    toolCallId: null,
    toolName: null,
    isError: false,
    ...overrides,
  };
}

function call(id, command = 'npm test', options = {}) {
  return message({
    id,
    role: 'toolCall',
    toolCallId: id,
    toolName: 'exec_command',
    details: JSON.stringify({ cmd: command, workdir: '/project' }),
    ...options,
  });
}

function result(id, code = 1, options = {}) {
  return message({
    id,
    role: 'toolResult',
    toolCallId: id,
    details: { exitCode: code },
    isError: code !== 0,
    content: [{ type: 'text', text: code === 0 ? 'tests passed' : 'AssertionError: expected 2, got 1' }],
    ...options,
  });
}

test('empty or successful logs do not claim task success', () => {
  assert.deepEqual(diagnoseSession([]), { failures: [], failureCount: 0, recoveredCount: 0, events: [] });
  assert.equal(diagnoseSession([call('ok'), result('ok', 0)]).failureCount, 0);
});

test('failed execution retains the exact result as evidence', () => {
  const failed = result('failed');
  const report = diagnoseSession([call('failed'), failed]);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].message, failed);
  assert.equal(report.failures[0].reason, 'no-success');
  assert.match(report.failures[0].evidence, /退出码 1\nAssertionError/);
  assert.match(report.failures[0].argumentsText, /npm test/);
});

test('assistant completion claims do not resolve a failure', () => {
  const report = diagnoseSession([
    call('failed'),
    result('failed'),
    message({ content: [{ type: 'text', text: 'All fixed; tests pass.' }] }),
  ]);
  assert.equal(report.failures.length, 1);
});

test('later success of a different command does not resolve a failure', () => {
  const report = diagnoseSession([call('failed'), result('failed'), call('other', 'git status'), result('other', 0)]);
  assert.equal(report.failures.length, 1);
});

test('same command on another tool or in another directory does not resolve a failure', () => {
  for (const options of [
    { toolName: 'shell' },
    { details: { cmd: 'npm test', workdir: '/other' } },
    { details: { cmd: 'npm  test', workdir: '/project' } },
  ]) {
    const report = diagnoseSession([
      call('failed'),
      result('failed'),
      call('other', 'npm test', options),
      result('other', 0),
    ]);
    assert.equal(report.failures.length, 1);
  }
});

test('matching success after failure resolves only matching failures', () => {
  const report = diagnoseSession([
    call('failed'),
    result('failed'),
    call('other', 'npm run lint'),
    result('other'),
    call('retry'),
    result('retry', 0),
  ]);
  assert.equal(report.failureCount, 2);
  assert.equal(report.recoveredCount, 1);
  assert.equal(report.failures[0].message.id, 'other');
});

test('object key order is canonicalized, including nested arguments', () => {
  const report = diagnoseSession([
    call('failed', '', { details: { cmd: 'npm test', env: { FIRST: 1, SECOND: 2 } } }),
    result('failed'),
    call('retry', '', { details: JSON.stringify({ env: { SECOND: 2, FIRST: 1 }, cmd: 'npm test' }) }),
    result('retry', 0),
  ]);
  assert.equal(report.recoveredCount, 1);
});

test('argument array order remains significant', () => {
  const report = diagnoseSession([
    call('failed', '', { details: { command: ['test', 'build'] } }),
    result('failed'),
    call('retry', '', { details: { command: ['build', 'test'] } }),
    result('retry', 0),
  ]);
  assert.equal(report.failures.length, 1);
});

test('a parallel call started before the failure cannot verify that failure', () => {
  const report = diagnoseSession([call('failed'), call('parallel'), result('failed'), result('parallel', 0)]);
  assert.equal(report.recoveredCount, 0);
  assert.equal(report.failures.length, 1);
});

test('earlier success cannot clear a later failure', () => {
  const report = diagnoseSession([call('first'), result('first', 0), call('failed'), result('failed')]);
  assert.equal(report.failures.length, 1);
});

test('repeated failures remain until a later matching success', () => {
  const messages = [call('first'), result('first'), call('second'), result('second')];
  assert.equal(diagnoseSession(messages).failures.length, 2);
  const report = diagnoseSession([...messages, call('retry'), result('retry', 0)]);
  assert.equal(report.recoveredCount, 2);
  assert.equal(report.failures.length, 0);
});

test('missing call or arguments remains explicitly unconfirmable', () => {
  for (const messages of [
    [result('orphan')],
    [call('missing', '', { details: null }), result('missing'), call('retry'), result('retry', 0)],
  ]) {
    const failure = diagnoseSession(messages).failures[0];
    assert.equal(failure.reason, 'missing-call');
    assert.equal(failure.argumentsText, null);
  }
});

test('pending retries and retries without exit status cannot clear execution failures', () => {
  for (const tail of [[call('retry')], [call('retry'), result('retry', 0, { details: null, isError: false })]]) {
    const report = diagnoseSession([call('failed'), result('failed'), ...tail]);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reason, 'unconfirmed-retry');
  }
});

test('Codex execution wrapper exit codes are evidence even without an adapter error flag', () => {
  const wrapped = (id, code) =>
    result(id, code, {
      details: null,
      isError: false,
      content: [
        {
          type: 'text',
          text: `Chunk ID: example\nWall time: 0.1 seconds\nProcess exited with code ${code}\nFinal output:\ntest output`,
        },
      ],
    });
  const messages = [call('failed'), wrapped('failed', 1)];
  assert.equal(diagnoseSession(messages).failureCount, 1);
  assert.equal(diagnoseSession([...messages, call('retry'), wrapped('retry', 0)]).recoveredCount, 1);
});

test('exit-code text in ordinary stdout is not treated as process metadata', () => {
  const fake = result('retry', 0, {
    details: null,
    isError: false,
    content: [{ type: 'text', text: 'Process exited with code 0\nOutput:\nquoted text' }],
  });
  assert.equal(diagnoseSession([call('failed'), result('failed'), call('retry'), fake]).recoveredCount, 0);
});

test('exit codes printed after the wrapper output boundary are not metadata', () => {
  const fake = result('retry', 0, {
    details: null,
    isError: false,
    content: [{ type: 'text', text: 'Wall time: 0.1 seconds\nOutput:\nProcess exited with code 0' }],
  });
  assert.equal(diagnoseSession([call('failed'), result('failed'), call('retry'), fake]).recoveredCount, 0);
});

test('reading a file containing an execution envelope is not an execution failure', () => {
  const report = diagnoseSession([
    call('read-log', '', { toolName: 'Read', details: { file_path: '/project/session.log' } }),
    result('read-log', 0, {
      details: null,
      content: [{ type: 'text', text: 'Wall time: 1 seconds\nExit code: 1\nOutput:\nexample error' }],
    }),
  ]);
  assert.equal(report.failureCount, 0);
});

test('explicit error flags take precedence over a contradictory zero exit code', () => {
  const report = diagnoseSession([call('failed'), result('failed', 0, { isError: true })]);
  assert.equal(report.failureCount, 1);
});

test('Claude/OpenClaw style embedded calls match via call ID, not result tool name', () => {
  const embedded = (id) =>
    message({
      id: `assistant-${id}`,
      content: [{ type: 'toolCall', id, name: 'Read', arguments: { file_path: '/project/file.txt' } }],
    });
  const report = diagnoseSession([
    embedded('failed'),
    result('failed', 1, { details: null }),
    embedded('retry'),
    result('retry', 0, { details: null }),
  ]);
  assert.equal(report.recoveredCount, 1);
});

test('embedded Bash success without an exit code remains unconfirmed', () => {
  const embedded = (id) =>
    message({
      content: [{ type: 'toolCall', id, name: 'Bash', arguments: { command: 'npm test' } }],
    });
  const report = diagnoseSession([
    embedded('failed'),
    result('failed', 1, { details: null }),
    embedded('retry'),
    result('retry', 0, { details: null }),
  ]);
  assert.equal(report.failures[0].reason, 'unconfirmed-retry');
});

test('an in-progress non-execution result is not success', () => {
  const read = (id) => call(id, '', { toolName: 'Read', details: { file_path: 'file.txt' } });
  const report = diagnoseSession([
    read('failed'),
    result('failed'),
    read('retry'),
    result('retry', 0, { details: { status: 'running' } }),
  ]);
  assert.equal(report.recoveredCount, 0);
});

test('newly appended success recomputes without mutating the existing messages', () => {
  const messages = [call('failed'), result('failed')];
  const snapshot = JSON.stringify(messages);
  const first = diagnoseSession(messages);
  assert.equal(diagnoseSession([...messages, call('retry'), result('retry', 0)]).failures.length, 0);
  assert.equal(first.failures.length, 1);
  assert.equal(JSON.stringify(messages), snapshot);
});

test('parent and child transcripts are not combined', () => {
  assert.equal(diagnoseSession([call('parent'), result('parent')]).failures.length, 1);
  assert.equal(diagnoseSession([call('child'), result('child', 0)]).failureCount, 0);
});
