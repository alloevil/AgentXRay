const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let diagnoseSession;
let reviews;
before(async () => {
  const load = async (file) => {
    const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions', file), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  };
  ({ diagnoseSession } = await load('diagnostics.ts'));
  reviews = await load('diagnostic-reviews.ts');
});

const call = (id, args, toolName = 'bash') => ({ role: 'toolCall', id, toolCallId: id, toolName, details: args });
const result = (id, state = 'success', options = {}) => ({
  role: 'toolResult',
  id: `${id}-result`,
  toolCallId: id,
  timestamp: null,
  isError: state === 'failure',
  details: null,
  content: [{ type: 'text', text: `Synthetic ${id} result` }],
  ompOutcome: { state, evidence: [`synthetic.state=${state}`], warnings: [] },
  ...options,
});
const user = { role: 'user', content: [{ type: 'text', text: 'Synthetic next task' }] };
const failed = (args = { command: 'synthetic test', i: 'first' }, tool = 'bash') => [
  call('first', args, tool),
  result('first', 'failure'),
];
const candidates = (messages) => diagnoseSession(messages).events[0].relatedOperations;

test('only-i follow-up success is evidence, not automatic recovery', () => {
  const messages = [...failed(), call('retry', { i: 'second', command: 'synthetic test' }), result('retry')];
  const report = diagnoseSession(messages);
  assert.equal(report.failureCount, 1);
  assert.equal(report.recoveredCount, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.events[0].relatedOperations.length, 1);
  const entry = report.events[0].relatedOperations[0];
  assert.equal(entry.relation, 'only-i');
  assert.equal(entry.state, 'success');
  assert.equal(entry.message, messages[3]);
  assert.equal(entry.callIndex, 2);
  assert.equal(entry.index, 3);
  assert.match(entry.evidence, /synthetic.state=success/);
});

for (const state of ['failure', 'running', 'cancelled', 'unknown']) {
  test(`only-i candidate preserves ${state} instead of claiming verification`, () => {
    const rows = candidates([
      ...failed(),
      call('later', { command: 'synthetic test', i: 'second' }),
      result('later', state),
    ]);
    assert.equal(rows[0].state, state);
    assert.equal(rows[0].relation, 'only-i');
  });
}

test('only-i matching compares full arguments and exact tools, including nested values', () => {
  const original = { command: 'synthetic test', config: { FIRST: 1, SECOND: 2 }, i: 'first' };
  const rows = candidates([
    ...failed(original),
    call('changed', { ...original, config: { FIRST: 1, SECOND: 3 }, i: 'next' }),
    result('changed'),
    call('other-tool', { ...original, i: 'next' }, 'shell'),
    result('other-tool'),
    call('match', JSON.stringify({ i: 'next', config: { SECOND: 2, FIRST: 1 }, command: 'synthetic test' })),
    result('match'),
  ]);
  assert.deepEqual(
    rows.map((row) => row.message.toolCallId),
    ['match']
  );
});

test('only-i without meaningful remaining parameters or equal arguments is not a relation', () => {
  assert.equal(candidates([...failed({ i: 'first' }), call('next', { i: 'next' }), result('next')]).length, 0);
  assert.equal(
    candidates([...failed(), call('same', { command: 'synthetic test', i: 'first' }), result('same', 'running')])
      .length,
    0
  );
  assert.equal(
    candidates([
      ...failed({ command: ['a', 'b'], i: 'first' }),
      call('different', { command: ['b', 'a'], i: 'next' }),
      result('different'),
    ]).length,
    0
  );
});

test('adding or removing top-level i is supported and can cross call user turns', () => {
  const rows = candidates([
    ...failed({ command: 'synthetic test' }),
    user,
    call('next', { command: 'synthetic test', i: 'next' }),
    result('next'),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userTurn, 1);
  assert.equal(rows[0].relation, 'only-i');
});

test('same-file modifications need the same turn and explicitly resolved path context', () => {
  const args = { path: '/synthetic/file.ts', oldText: 'first', newText: 'second' };
  const rows = candidates([
    ...failed(args, 'edit'),
    call('write', { file_path: '/synthetic/file.ts', content: 'different content' }, 'Write'),
    result('write'),
    call('unrelated', { path: '/synthetic/other.ts', content: 'different content' }, 'write'),
    result('unrelated'),
    call('read', { path: '/synthetic/file.ts' }, 'read'),
    result('read'),
    user,
    call('next-turn', { ...args, newText: 'third' }, 'edit'),
    result('next-turn'),
  ]);
  assert.deepEqual(
    rows.map((row) => row.message.toolCallId),
    ['write']
  );
  assert.equal(rows[0].relation, 'same-file');
});

test('relative paths require equal explicit absolute cwd and aliases are not guessed', () => {
  for (const [first, second, expected] of [
    [{ path: 'file.ts' }, { path: 'file.ts', content: 'next' }, 0],
    [{ path: 'file.ts', cwd: '/synthetic' }, { path: 'file.ts', cwd: '/synthetic', content: 'next' }, 1],
    [{ path: 'file.ts', cwd: '/one' }, { path: 'file.ts', cwd: '/two', content: 'next' }, 0],
    [{ path: 'file.ts', cwd: '/one' }, { path: 'file.ts', workdir: '/one', content: 'next' }, 0],
    [{ path: '/file.ts', cwd: '/one' }, { path: '/file.ts', cwd: '/two', content: 'next' }, 0],
    [{ path: '/a/../file.ts' }, { path: '/file.ts', content: 'next' }, 0],
    [{ path: 'file.ts', cwd: 'relative' }, { path: 'file.ts', cwd: 'relative', content: 'next' }, 0],
    [{ path: '/one', file_path: '/two' }, { path: '/one', content: 'next' }, 0],
  ]) {
    assert.equal(candidates([...failed(first, 'edit'), call('next', second, 'edit'), result('next')]).length, expected);
  }
});

test('same-file relation does not infer paths from shell commands or patch text', () => {
  assert.equal(
    candidates([
      ...failed({ command: 'edit /synthetic/file.ts' }),
      call('next', { path: '/synthetic/file.ts', content: 'next' }, 'write'),
      result('next'),
    ]).length,
    0
  );
});

test('earlier-started parallel calls and missing results do not become follow-up evidence', () => {
  const args = { command: 'synthetic test', i: 'next' };
  const rows = candidates([
    call('first', { command: 'synthetic test', i: 'first' }),
    call('parallel', args),
    result('first', 'failure'),
    result('parallel'),
    call('pending', args),
    result('orphan'),
  ]);
  assert.equal(rows.length, 0);
});

test('candidates start after the last failure, not merely the first event member', () => {
  const args = { path: '/synthetic/file.ts', content: 'first' };
  const report = diagnoseSession([
    ...failed(args, 'write'),
    call('middle', { ...args, content: 'middle' }, 'write'),
    result('middle'),
    call('repeat', args, 'write'),
    result('repeat', 'failure'),
    call('last', { ...args, content: 'last' }, 'write'),
    result('last'),
  ]);
  assert.equal(report.events[0].failures.length, 2);
  assert.deepEqual(
    report.events[0].relatedOperations.map((row) => row.message.toolCallId),
    ['last']
  );
});

test('call user turn, not delayed result turn, controls same-file relation', () => {
  const args = { path: '/synthetic/file.ts', content: 'first' };
  const rows = candidates([
    ...failed(args, 'write'),
    call('later', { ...args, content: 'next' }, 'write'),
    user,
    result('later'),
  ]);
  assert.equal(rows[0].relation, 'same-file');
  assert.equal(rows[0].userTurn, 0);
});

test('a result matching both relations is listed once with the more specific only-i reason', () => {
  const args = { path: '/synthetic/file.ts', content: 'first', i: 'first' };
  const rows = candidates([...failed(args, 'write'), call('later', { ...args, i: 'next' }, 'write'), result('later')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relation, 'only-i');
});

test('five-state evidence follows explicit source fields for non-OMP logs too', () => {
  const examples = [
    [{ details: { exitCode: 0 } }, 'success'],
    [{ details: { exitCode: 2 } }, 'failure'],
    [{ details: { status: 'running', exitCode: 0 } }, 'running'],
    [{ details: null }, 'unknown'],
    [
      { details: null, content: [{ type: 'text', text: 'Wall time: 1 seconds\nExit code: 0\nOutput:\nSynthetic' }] },
      'success',
    ],
  ];
  for (const [overrides, expected] of examples) {
    const rows = candidates([
      ...failed(),
      call('later', { command: 'synthetic test', i: 'next' }),
      result('later', 'success', { ompOutcome: undefined, isError: false, ...overrides }),
    ]);
    assert.equal(rows[0].state, expected);
    assert.ok(rows[0].evidence.length);
  }
});

test('all candidates stay ordered and raw input is not mutated', () => {
  const messages = failed();
  for (let index = 0; index < 12; index++)
    messages.push(call(`next-${index}`, { command: 'synthetic test', i: index }), result(`next-${index}`));
  const before = JSON.stringify(messages);
  const report = diagnoseSession(messages);
  assert.equal(report.events[0].relatedOperations.length, 12);
  assert.equal(report.recoveredCount, 0);
  assert.deepEqual(
    report.events[0].relatedOperations.map((row) => row.index),
    Array.from({ length: 12 }, (_, index) => index * 2 + 3)
  );
  assert.equal(JSON.stringify(messages), before);
});

test('new candidates invalidate old human notes but preserve storage keys', async () => {
  const messages = failed();
  const before = diagnoseSession(messages).events[0];
  const after = diagnoseSession([...messages, call('next', { command: 'synthetic test', i: 'next' }), result('next')])
    .events[0];
  const original = await reviews.createReviewIdentity('scope', before);
  const changed = await reviews.createReviewIdentity('scope', after);
  assert.equal(original.storageKey, changed.storageKey);
  assert.notEqual(original.fingerprint, changed.fingerprint);
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  reviews.saveReview(storage, original, 'expected', 'Synthetic old review');
  assert.equal(reviews.reviewState(reviews.readReview(storage, changed)), 'unreviewed');
});

test('candidate output beyond displayed preview participates in review fingerprint', async () => {
  const messages = [
    ...failed(),
    call('next', { command: 'synthetic test', i: 'next' }),
    result('next', 'success', { content: [{ type: 'text', text: 'x'.repeat(700) }] }),
  ];
  const before = await reviews.createReviewIdentity('scope', diagnoseSession(messages).events[0]);
  messages[3].content[0].text += 'changed';
  const after = await reviews.createReviewIdentity('scope', diagnoseSession(messages).events[0]);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test('no candidates preserves prior fingerprint contract and exact recovery remains unchanged', async () => {
  const event = diagnoseSession(failed()).events[0];
  const legacy = { ...event };
  delete legacy.relatedOperations;
  assert.deepEqual(
    await reviews.createReviewIdentity('scope', event),
    await reviews.createReviewIdentity('scope', legacy)
  );
  const report = diagnoseSession([
    ...failed(),
    call('exact', { command: 'synthetic test', i: 'first' }),
    result('exact'),
  ]);
  assert.equal(report.recoveredCount, 1);
  assert.equal(report.events.length, 0);
});

test('explicit cancellation and unrecognized status do not turn into a successful candidate', () => {
  for (const [status, expected] of [
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['future-state', 'unknown'],
  ]) {
    const rows = candidates([
      ...failed({ path: '/synthetic/read.txt', i: 'first' }, 'Read'),
      call('next', { path: '/synthetic/read.txt', i: 'next' }, 'Read'),
      result('next', 'success', { ompOutcome: undefined, details: { status }, isError: false }),
    ]);
    assert.equal(rows[0].state, expected);
  }
});

test('embedded calls link to their own result while missing arguments are not inferred', () => {
  const embedded = (id, input) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'Edit', input }] });
  const args = { file_path: '/synthetic/file.ts', old_string: 'a', new_string: 'b' };
  const rows = candidates([
    embedded('first', args),
    result('first', 'failure'),
    embedded('later', { ...args, new_string: 'c' }),
    result('later'),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message.toolCallId, 'later');
  assert.equal(rows[0].relation, 'same-file');
  assert.equal(candidates([...failed(null, 'Edit'), embedded('later', args), result('later')]).length, 0);
});
