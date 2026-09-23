const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { normalizeOmpRecord } = require('../lib/platforms/omp');

let diagnoseSession;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  ({ diagnoseSession } = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  ));
});

function result(toolName, details, isError = false, text = 'Synthetic result', id = 'result') {
  return normalizeOmpRecord({
    type: 'message',
    id,
    message: { role: 'toolResult', toolName, toolCallId: id, details, isError, content: [{ type: 'text', text }] },
  })[0];
}

function call(id, toolName = 'bash') {
  return { id, role: 'toolCall', toolCallId: id, toolName, details: { command: 'synthetic check' } };
}

const cases = [
  ['eval nested error', 'eval', { isError: true, cells: [{ status: 'error', exitCode: 1 }] }, false, 'failure'],
  ['eval timeout without exit', 'eval', { isError: true, cells: [{ status: 'error' }] }, false, 'failure'],
  ['cell failure without aggregate flag', 'eval', { cells: [{ status: 'error', exitCode: 1 }] }, false, 'failure'],
  ['search provider failure', 'web_search', { error: 'Synthetic provider failure' }, false, 'failure'],
  ['stop with daemon failure', 'hub', { op: 'stop', daemon: { exitCode: 1 } }, false, 'cancelled'],
  ['failed stop request', 'hub', { op: 'stop' }, true, 'failure'],
  ['historical failure in list', 'hub', { op: 'list', daemons: [{ exitCode: 1 }] }, false, 'unknown'],
  ['hub wait is not task completion', 'hub', { op: 'wait', jobs: [{ status: 'completed' }] }, false, 'unknown'],
  ['sync bash complete', 'bash', { timeoutSeconds: 30, wallTimeMs: 123 }, false, 'success'],
  ['bash no completion metadata', 'bash', {}, false, 'unknown'],
  ['bash timeout', 'bash', { timedOut: true, wallTimeMs: 123 }, false, 'failure'],
  ['async starting', 'bash', { async: { state: 'running' }, wallTimeMs: 123, exitCode: 0 }, false, 'running'],
  ['async completed', 'bash', { async: { state: 'completed' } }, false, 'success'],
  ['async failed', 'bash', { async: { state: 'failed' } }, false, 'failure'],
  ['async cancelled', 'bash', { async: { state: 'cancelled' } }, true, 'cancelled'],
  ['unknown async schema', 'bash', { async: true, wallTimeMs: 123 }, false, 'unknown'],
  ['unknown async state', 'bash', { async: { state: 'future' }, exitCode: 0 }, false, 'unknown'],
  ['pending cell', 'eval', { cells: [{ status: 'pending' }] }, false, 'running'],
  [
    'mixed finished and running cells',
    'eval',
    { cells: [{ status: 'complete', exitCode: 0 }, { status: 'running' }] },
    false,
    'running',
  ],
  ['unknown cell schema', 'eval', { cells: [{}] }, false, 'unknown'],
  ['eval missing cells', 'eval', {}, false, 'unknown'],
  ['completed cells', 'eval', { cells: [{ status: 'complete', exitCode: 0 }] }, false, 'success'],
  ['failure beats zero exit', 'bash', { exitCode: 0 }, true, 'failure'],
  [
    'failure beats completed cells',
    'eval',
    { isError: true, cells: [{ status: 'complete', exitCode: 0 }] },
    false,
    'failure',
  ],
  ['arbitrary nested error is data', 'read', { value: { error: 'sample', exitCode: 1 } }, false, 'success'],
];

for (const [name, toolName, details, isError, expected] of cases) {
  test(`OMP outcome: ${name}`, () => {
    const message = result(toolName, details, isError);
    assert.equal(message.ompOutcome?.state, expected);
    assert.ok(message.ompOutcome.evidence.length);
    assert.equal(message.isError, isError);
    assert.deepEqual(message.details, details);
  });
}

test('OMP zero-exit probes retain observation paths, not task failure', () => {
  const message = result('eval', {
    cells: [{ status: 'complete', exitCode: 0, statusEvents: [{ error: 'Synthetic probe' }] }],
    statusEvents: [{ error: 'Synthetic probe' }],
  });
  assert.equal(message.ompOutcome?.state, 'success');
  assert.deepEqual(message.ompOutcome.warnings, [
    'details.statusEvents[0].error',
    'details.cells[0].statusEvents[0].error',
  ]);
  assert.equal(diagnoseSession([message]).failureCount, 0);
});

test('OMP exact ask cancellation is not a failure or successful retry', () => {
  for (const text of ['Ask tool was cancelled by the user', 'Ask input was cancelled']) {
    assert.equal(result('ask', {}, true, text).ompOutcome?.state, 'cancelled');
  }
  assert.equal(
    result('eval', { isError: true }, false, 'KeyboardInterrupt after timeout').ompOutcome?.state,
    'failure'
  );
  assert.equal(result('read', {}, true, 'Ask input was cancelled').ompOutcome?.state, 'failure');
});

test('OMP superseded read is unknown, not a fresh execution failure', () => {
  assert.equal(result('read', {}, true, '[Superseded by a newer read of this file]').ompOutcome?.state, 'unknown');
});

test('OMP missing raw error flag cannot certify sync bash completion', () => {
  const [message] = normalizeOmpRecord({
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'bash',
      details: { wallTimeMs: 123 },
      content: [],
    },
  });
  assert.equal(message.ompOutcome?.state, 'unknown');
});

test('OMP nested errors feed diagnosis with actual evidence paths', () => {
  const message = result('eval', { isError: true, cells: [{ status: 'error', exitCode: 1 }] });
  const report = diagnoseSession([call('result', 'eval'), message]);
  assert.equal(report.failureCount, 1);
  assert.match(report.failures[0].evidence, /details\.isError=true/);
  assert.doesNotMatch(report.failures[0].evidence, /日志标记 isError=true/);
});

test('OMP sync completion closes same-argument failures; async start does not', () => {
  const failed = [call('first'), result('bash', { exitCode: 1 }, true, 'Synthetic failure', 'first')];
  const pending = [...failed, call('second'), result('bash', { async: { state: 'running' } }, false, '', 'second')];
  assert.equal(diagnoseSession(pending).recoveredCount, 0);
  const completed = [...pending, call('third'), result('bash', { wallTimeMs: 10 }, false, '', 'third')];
  assert.equal(diagnoseSession(completed).recoveredCount, 1);
});

test('OMP cancelled and unknown management results never close failures', () => {
  for (const details of [{ op: 'stop', daemon: { exitCode: 1 } }, { op: 'list' }]) {
    const report = diagnoseSession([
      call('first', 'hub'),
      result('hub', {}, true, '', 'first'),
      call('second', 'hub'),
      result('hub', details, false, '', 'second'),
    ]);
    assert.equal(report.failureCount, 1);
    assert.equal(report.recoveredCount, 0);
  }
});
