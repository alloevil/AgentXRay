const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let diagnoseSession;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostics.ts'), 'utf8');
  ({ diagnoseSession } = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  ));
});

const user = () => ({ role: 'user', content: [{ type: 'text', text: 'Synthetic task' }] });
const call = (id, details = { command: 'synthetic check' }, toolName = 'bash') => ({
  id,
  role: 'toolCall',
  toolCallId: id,
  toolName,
  details,
});
const result = (id, code = 1, timestamp = null) => ({
  id: `${id}-result`,
  role: 'toolResult',
  toolCallId: id,
  timestamp,
  details: { exitCode: code },
  isError: code !== 0,
  content: [{ type: 'text', text: `Synthetic result ${id}` }],
});

function coverage(report) {
  const members = report.events.flatMap((event) => event.failures);
  assert.equal(members.length, report.failures.length);
  assert.equal(new Set(members).size, report.failures.length);
  assert.deepEqual(new Set(members), new Set(report.failures));
}

test('66 failures become one event without losing any evidence', () => {
  const messages = [user()];
  for (let index = 0; index < 66; index++) {
    messages.push(call(`call-${index}`), result(`call-${index}`, 1, new Date(100000 + index * 1000).toISOString()));
  }
  const report = diagnoseSession(messages);
  assert.equal(report.failureCount, 66);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].failures.length, 66);
  assert.equal(report.events[0].userTurn, 1);
  assert.equal(report.events[0].spanMs, 65000);
  assert.equal(report.events[0].failures[0].message, messages[2]);
  assert.equal(report.events[0].failures[65].message, messages[132]);
  coverage(report);
});

test('different user turns remain distinct events', () => {
  const report = diagnoseSession([user(), call('first'), result('first'), user(), call('second'), result('second')]);
  assert.deepEqual(
    report.events.map((event) => event.userTurn),
    [1, 2]
  );
  coverage(report);
});

test('a delayed result belongs to its call turn, not its arrival turn', () => {
  const report = diagnoseSession([user(), call('first'), user(), call('second'), result('first'), result('second')]);
  assert.deepEqual(
    report.events.map((event) => event.userTurn),
    [1, 2]
  );
});

test('unknown calls and missing arguments are never grouped', () => {
  const report = diagnoseSession([
    result('orphan'),
    result('other-orphan'),
    call('missing', null),
    result('missing'),
    call('other-missing', null),
    result('other-missing'),
  ]);
  assert.equal(report.events.length, 4);
  assert.ok(report.events.every((event) => event.argumentsText === null));
  coverage(report);
});

test('all argument values and tool names remain significant', () => {
  const report = diagnoseSession([
    call('first', { command: 'check', i: 'first', cwd: '/synthetic/a' }),
    result('first'),
    call('second', { command: 'check', i: 'second', cwd: '/synthetic/a' }),
    result('second'),
    call('third', { command: 'check', i: 'first', cwd: '/synthetic/b' }),
    result('third'),
    call('fourth', { command: 'check', i: 'first', cwd: '/synthetic/a' }, 'shell'),
    result('fourth'),
  ]);
  assert.equal(report.events.length, 4);
});

test('object key order is ignored but array order is preserved', () => {
  const report = diagnoseSession([
    call('first', { command: ['one', 'two'], env: { FIRST: 1, SECOND: 2 } }),
    result('first'),
    call('second', JSON.stringify({ env: { SECOND: 2, FIRST: 1 }, command: ['one', 'two'] })),
    result('second'),
    call('third', { command: ['two', 'one'], env: { FIRST: 1, SECOND: 2 } }),
    result('third'),
  ]);
  assert.deepEqual(
    report.events.map((event) => event.failures.length),
    [2, 1]
  );
});

test('unrelated intervening results do not split the same-operation group', () => {
  const report = diagnoseSession([
    call('first'),
    result('first'),
    call('other', { command: 'other' }),
    result('other', 0),
    call('second'),
    result('second'),
  ]);
  assert.equal(report.events.length, 1);
});

test('parallel failures can share an event without being considered recovered', () => {
  const report = diagnoseSession([call('first'), call('parallel'), result('first'), result('parallel')]);
  assert.equal(report.events.length, 1);
  assert.equal(report.recoveredCount, 0);
});

test('successful results split groups even when they cannot recover parallel failures', () => {
  const report = diagnoseSession([
    call('first'),
    call('parallel'),
    result('first'),
    result('parallel', 0),
    call('second'),
    result('second'),
  ]);
  assert.equal(report.events.length, 2);
  assert.equal(report.recoveredCount, 0);
});

test('a recovered episode cannot absorb a later failure', () => {
  const report = diagnoseSession([
    call('first'),
    result('first'),
    call('retry'),
    result('retry', 0),
    call('later'),
    result('later'),
  ]);
  assert.equal(report.failureCount, 2);
  assert.equal(report.recoveredCount, 1);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].failures[0].message.toolCallId, 'later');
  coverage(report);
});

test('event ranking uses repetition count and stable first-occurrence ties', () => {
  const report = diagnoseSession([
    call('single', { command: 'single' }),
    result('single'),
    call('first'),
    result('first'),
    call('second'),
    result('second'),
    call('last', { command: 'last' }),
    result('last'),
  ]);
  assert.deepEqual(
    report.events.map((event) => event.failures[0].message.toolCallId),
    ['first', 'single', 'last']
  );
  coverage(report);
});

test('missing, invalid or out-of-order timestamps do not invent elapsed time', () => {
  for (const stamps of [
    [null, null],
    ['invalid', '2026-09-23'],
    ['2026-09-24', '2026-09-23'],
    ['2026-09-23', null, '2026-09-25'],
    ['2026-09-23', '2026-09-25', '2026-09-24'],
  ]) {
    const report = diagnoseSession(
      stamps.flatMap((stamp, index) => [call(`call-${index}`), result(`call-${index}`, 1, stamp)])
    );
    assert.equal(report.events[0].spanMs, null);
  }
});

test('appending success removes an event without mutating the prior report or input', () => {
  const messages = [call('first'), result('first'), call('second'), result('second')];
  const snapshot = JSON.stringify(messages);
  const previous = diagnoseSession(messages);
  const report = diagnoseSession([...messages, call('success'), result('success', 0)]);
  assert.equal(report.events.length, 0);
  assert.equal(report.recoveredCount, 2);
  assert.equal(previous.events[0].failures.length, 2);
  assert.equal(JSON.stringify(messages), snapshot);
  coverage(report);
});

test('event IDs stay stable when appended failures change ranking', () => {
  const messages = [call('first'), result('first'), call('other', { command: 'other' }), result('other')];
  const before = diagnoseSession(messages);
  const after = diagnoseSession([...messages, call('more', { command: 'other' }), result('more')]);
  assert.equal(before.events[0].id, after.events[1].id);
  assert.equal(before.events[1].id, after.events[0].id);
});

test('embedded calls and separate child transcripts preserve event boundaries', () => {
  const embedded = (id) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'Read', arguments: { path: 'synthetic' } }],
  });
  const parent = diagnoseSession([embedded('first'), result('first'), embedded('second'), result('second')]);
  const child = diagnoseSession([embedded('child'), result('child', 0)]);
  assert.equal(parent.events.length, 1);
  assert.equal(parent.events[0].userTurn, 0);
  assert.equal(child.events.length, 0);
});
