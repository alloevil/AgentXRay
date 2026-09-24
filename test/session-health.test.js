const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let diagnoseSession;
let summarizeSessionHealth;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  ({ diagnoseSession, summarizeSessionHealth } = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  ));
});
const call = (id, args = { command: 'synthetic test' }, name = 'bash') => ({
  role: 'toolCall',
  id,
  toolCallId: id,
  toolName: name,
  details: args,
});
const result = (id, state, extra = {}) => ({
  role: 'toolResult',
  id: `${id}-result`,
  toolCallId: id,
  isError: state === 'failure',
  details: null,
  content: [{ type: 'text', text: `Synthetic ${state}` }],
  ompOutcome: { state, evidence: [`synthetic.state=${state}`], warnings: [] },
  ...extra,
});
const summary = (messages) => summarizeSessionHealth(messages, diagnoseSession(messages));

test('empty report has no invented success or live status', () => {
  const health = summary([]);
  assert.equal(health.callCount, 0);
  assert.equal(health.failureRecords, 0);
  assert.equal(health.gaps.length, 0);
  assert.equal(health.orphanResults, 0);
});

test('last result per call distinguishes five states and missing results', () => {
  const states = ['success', 'failure', 'running', 'cancelled', 'unknown'];
  const messages = states.flatMap((state) => [call(state), result(state, state)]);
  messages.push(call('missing'));
  const health = summary(messages);
  assert.equal(health.callCount, 6);
  assert.deepEqual(health.callStates, { success: 1, failure: 1, running: 1, cancelled: 1, unknown: 1, 'no-result': 1 });
  assert.deepEqual(
    health.gaps.map((gap) => gap.state),
    ['running', 'unknown', 'no-result']
  );
  assert.equal(health.gaps[0].message, messages[5]);
  assert.equal(health.gaps[2].message, messages[10]);
});

test('running then completed updates last state rather than double-counting calls', () => {
  const messages = [call('job'), result('job', 'running')];
  assert.equal(summary(messages).callStates.running, 1);
  const health = summary([...messages, result('job', 'success')]);
  assert.equal(health.callCount, 1);
  assert.equal(health.toolResultCount, 2);
  assert.equal(health.callStates.success, 1);
  assert.equal(health.gaps.length, 0);
});

test('orphan or pre-call results do not certify later calls', () => {
  const health = summary([result('later', 'success'), call('later'), result('orphan', 'success')]);
  assert.equal(health.orphanResults, 2);
  assert.equal(health.callStates['no-result'], 1);
});

test('missing and reused IDs remain ambiguous instead of assigning outcomes', () => {
  const health = summary([
    call(null),
    call('duplicate'),
    result('duplicate', 'success'),
    call('duplicate'),
    result('duplicate', 'success'),
  ]);
  assert.equal(health.ambiguousCalls, 3);
  assert.equal(health.callStates.unknown, 3);
  assert.equal(health.unassignedResults, 2);
  assert.ok(health.gaps.every((gap) => gap.reason === 'ambiguous-id'));
});

test('embedded tool calls use their source message for missing-result evidence', () => {
  const embedded = {
    id: 'assistant',
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'one', name: 'Read', arguments: { path: 'a' } },
      { type: 'toolCall', id: 'two', name: 'Read', arguments: { path: 'b' } },
    ],
  };
  const health = summary([embedded, result('one', 'success')]);
  assert.equal(health.callCount, 2);
  assert.equal(health.gaps[0].message, embedded);
  assert.equal(health.gaps[0].toolCallId, 'two');
});

test('repeated unresolved event and recovered record units stay explicit', () => {
  const messages = [call('one'), result('one', 'failure'), call('two'), result('two', 'failure')];
  const health = summary(messages);
  assert.equal(health.failureRecords, 2);
  assert.equal(health.pendingRecords, 2);
  assert.equal(health.pendingEvents, 1);
  assert.equal(health.repeatedEvents, 1);
  assert.equal(health.repeatedRecords, 2);
  const recovered = summary([...messages, call('retry'), result('retry', 'success')]);
  assert.equal(recovered.recoveredRecords, 2);
  assert.equal(recovered.repeatedEvents, 0);
});

test('one follow-up result referenced by two events is counted once by result position', () => {
  const messages = [
    call('first', { command: 'same', i: 1 }),
    result('first', 'failure'),
    call('second', { command: 'same', i: 2 }),
    result('second', 'failure'),
    call('third', { command: 'same', i: 3 }),
    result('third', 'success'),
  ];
  const health = summary(messages);
  assert.equal(health.candidateEvents, 2);
  assert.equal(health.candidateStates.success, 1);
  assert.equal(health.candidateStates.failure, 1);
  assert.equal(health.candidateResults, 2);
  assert.equal(health.recoveredRecords, 0);
});

test('unknown completion and non-OMP running status remain gaps', () => {
  const messages = [
    call('unknown'),
    result('unknown', 'success', { ompOutcome: undefined }),
    call('running'),
    result('running', 'success', { ompOutcome: undefined, details: { status: 'running', exitCode: 0 } }),
  ];
  assert.deepEqual(
    summary(messages).gaps.map((gap) => gap.state),
    ['unknown', 'running']
  );
});

test('health calculation does not change source or original diagnostics', () => {
  const messages = [call('one'), result('one', 'failure'), call('pending')];
  const raw = JSON.stringify(messages);
  const report = diagnoseSession(messages);
  const before = JSON.stringify(report);
  summarizeSessionHealth(messages, report);
  assert.equal(JSON.stringify(report), before);
  assert.equal(JSON.stringify(messages), raw);
});

test('fixed offline transformations preserve exact outcomes and all evidence across 20 seeds', (context) => {
  let checks = 0;
  for (let seed = 0; seed < 20; seed++) {
    const args = { command: `synthetic test ${seed}`, cwd: `/synthetic/${seed}`, i: 'first' };
    const base = [call('failed', args), result('failed', 'failure')];
    const variants = [
      [base, 1, 0],
      [[...base, call('retry', args), result('retry', 'success')], 0, 1],
      [[...base, call('retry', args)], 1, 0],
      [[...base, call('retry', args), result('retry', 'running')], 1, 0],
      [[...base, call('retry', args), result('retry', 'cancelled')], 1, 0],
      [[...base, call('retry', args), result('retry', 'unknown')], 1, 0],
      [[...base, call('retry', { ...args, command: 'other' }), result('retry', 'success')], 1, 0],
      [[...base, call('retry', { ...args, cwd: '/other' }), result('retry', 'success')], 1, 0],
      [[...base, call('retry', { ...args, i: 'next' }), result('retry', 'success')], 1, 0],
      [[base[0], call('parallel', args), base[1], result('parallel', 'success')], 1, 0],
    ];
    for (const [messages, pending, recovered] of variants) {
      const report = diagnoseSession(messages),
        health = summarizeSessionHealth(messages, report);
      assert.equal(health.pendingRecords, pending);
      assert.equal(health.recoveredRecords, recovered);
      const members = report.events.flatMap((event) => event.failures);
      assert.deepEqual(new Set(members), new Set(report.failures));
      assert.equal(members.length, report.failures.length);
      assert.equal(
        Object.values(health.callStates).reduce((sum, value) => sum + value, 0),
        health.callCount
      );
      checks++;
    }
  }
  assert.equal(checks, 200);
  context.diagnostic(
    `Known-case transformations: ${checks}/200 passed; wrong recovery decisions: 0; event evidence partitions: ${checks}/200 complete. Not a real-world accuracy estimate.`
  );
});
