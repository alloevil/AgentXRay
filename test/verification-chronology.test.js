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
const call = (id, toolName, details) => ({ id, role: 'toolCall', toolCallId: id, toolName, details });
const edit = (id, extra = {}) => call(id, 'edit', { path: '/synthetic/file.ts', oldText: 'a', newText: 'b', ...extra });
const check = (id, command = 'npm test', extra = {}) => call(id, 'bash', { command, ...extra });
const result = (id, state = 'success', extra = {}) => ({
  id: `${id}-result`,
  role: 'toolResult',
  toolCallId: id,
  isError: state === 'failure',
  content: [{ type: 'text', text: `Synthetic ${state}` }],
  details: null,
  timestamp: null,
  ompOutcome: { state, evidence: [`synthetic.state=${state}`], warnings: [] },
  ...extra,
});
const inspect = (messages) => api.analyzeVerificationChronology(messages);

test('prior passed check followed by edit is not post-change verification', () => {
  const messages = [check('test'), result('test'), edit('edit'), result('edit')];
  const report = inspect(messages);
  assert.equal(report.successfulModifications, 1);
  assert.equal(report.withoutLaterCheck, 1);
  assert.equal(report.changedAfterLastPassedCheck, 1);
  const row = report.modifications[0];
  assert.equal(row.priorSuccess.operation.resultMessage, messages[1]);
  assert.equal(row.operation.resultMessage, messages[3]);
  assert.equal(row.laterChecks.length, 0);
});

test('check after completed edit is a temporal relation, never file coverage', () => {
  const messages = [edit('edit'), result('edit'), check('test'), result('test')];
  const report = inspect(messages);
  assert.equal(report.withoutLaterCheck, 0);
  assert.equal(report.withLaterCheck, 1);
  const later = report.modifications[0].laterChecks[0];
  assert.equal(later.scope, 'unknown');
  assert.equal(later.operation.state, 'success');
  assert.equal(later.operation.resultMessage, messages[3]);
  assert.equal(report.modifications[0].priorSuccess, null);
});

test('in-flight and overlapping checks are not counted as post-edit checks', () => {
  for (const messages of [
    [check('test'), edit('edit'), result('edit'), result('test')],
    [edit('edit'), check('test'), result('edit'), result('test')],
    [check('test'), edit('edit'), result('edit')],
  ]) {
    const row = inspect(messages).modifications[0];
    assert.equal(row.laterChecks.length, 0);
    assert.equal(row.overlappingChecks.length, 1);
    assert.equal(row.priorSuccess, null);
  }
});

test('latest later check remains failed even when an earlier later check passed', () => {
  const report = inspect([
    edit('edit'),
    result('edit'),
    check('pass'),
    result('pass'),
    check('fail'),
    result('fail', 'failure'),
  ]);
  assert.deepEqual(
    report.modifications[0].laterChecks.map((entry) => entry.operation.state),
    ['success', 'failure']
  );
  assert.equal(report.modifications[0].latestLater.operation.state, 'failure');
});

test('running, cancelled, unknown and missing check outcomes retain their distinction', () => {
  for (const state of ['running', 'cancelled', 'unknown', 'no-result']) {
    const messages = [edit('edit'), result('edit'), check('test')];
    if (state !== 'no-result') messages.push(result('test', state));
    const later = inspect(messages).modifications[0].latestLater;
    assert.equal(later.operation.state, state);
    assert.equal(later.operation.callMessage, messages[2]);
  }
});

test('failed or incomplete edit calls are counted, not asserted as successful modifications', () => {
  for (const state of ['failure', 'running', 'cancelled', 'unknown', 'no-result']) {
    const messages = [edit('edit')];
    if (state !== 'no-result') messages.push(result('edit', state));
    const report = inspect(messages);
    assert.equal(report.modificationCalls, 1);
    assert.equal(report.successfulModifications, 0);
    assert.equal(report.unconfirmedModifications, 1);
  }
});

test('known different or conflicting working directories are excluded', () => {
  for (const extra of [{ cwd: '/different' }, { cwd: '/synthetic', workdir: '/different' }]) {
    const row = inspect([
      edit('edit', { cwd: '/synthetic' }),
      result('edit'),
      check('test', 'npm test', extra),
      result('test'),
    ]).modifications[0];
    assert.equal(row.laterChecks.length, 0);
    assert.equal(row.excludedScopeChecks, 1);
  }
  const same = inspect([
    edit('edit', { cwd: '/synthetic' }),
    result('edit'),
    check('test', 'pytest', { workdir: '/synthetic' }),
    result('test'),
  ]);
  assert.equal(same.modifications[0].latestLater.scope, 'same-recorded-directory');
});

test('unknown directory stays unknown and does not imply path coverage', () => {
  const row = inspect([
    edit('edit', { path: 'relative.ts' }),
    result('edit'),
    check('test', 'pytest', { cwd: '/synthetic' }),
    result('test'),
  ]).modifications[0];
  assert.equal(row.operation.directory, null);
  assert.equal(row.latestLater.scope, 'unknown');
  assert.equal(row.operation.target, 'relative.ts');
});

test('direct runner and conventional script recognition is bounded', () => {
  const commands = [
    'npm test',
    'npm run build',
    'npm run lint -- --quiet',
    'npm run typecheck',
    'pnpm test',
    'pnpm run lint',
    'yarn test',
    'pytest tests/test_sample.py -q',
    'python -m pytest',
    'python3 -m pytest tests',
    'node --test test/sample.test.js',
  ];
  const report = inspect(
    commands.flatMap((command, index) => [check(`check-${index}`, command), result(`check-${index}`)])
  );
  assert.equal(report.checks.length, commands.length);
  assert.equal(report.checks.filter((entry) => entry.basis === 'runner-command').length, 4);
  assert.equal(report.checks.filter((entry) => entry.basis === 'script-name').length, commands.length - 4);
});

test('substitutions, quoted mentions, control flow and non-verifying commands are not guessed', () => {
  const commands = [
    'echo npm test',
    'FOO=bar npm test',
    'npm run deploy',
    'npm run check',
    'npm test -- --watch',
    'pytest --collect-only',
    'pytest --help',
    'node --test --version',
    'npm --prefix /other test',
    'pnpm -C /other test',
    'npm test -- --cwd=/other',
    'python -c "print(1)"',
    'npm test $(echo x)',
    'echo "pytest file.py; npm test"',
    'if true; then npm test; fi',
    'npm test --dry-run',
    'npm test &&',
    'npm test |',
    'npm test `echo x`',
  ];
  const report = inspect(commands.map((command, index) => check(`check-${index}`, command)));
  assert.equal(report.checks.length, 0);
  assert.equal(report.unclassifiedShellCalls, commands.length);
});

test('bounded compound fragments are visible but whole-command success is never test success', () => {
  for (const command of [
    'npm test && git status',
    'npm test; echo ok',
    'npm test | tee out',
    'npm test > out',
    'npm test\nnode other.js',
    'cd /synthetic && npm install && npm run lint 2>&1 | tail -30',
  ]) {
    const report = inspect([check('compound', command), result('compound'), edit('edit'), result('edit')]);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].commandMode, 'compound-fragment');
    assert.equal(report.checks[0].state, 'unknown');
    assert.equal(report.modifications[0].priorSuccess, null);
  }
});

test('single absolute cd prefix supplies explicit directory and zero exit, but failed cd is unknown', () => {
  const command = 'cd /synthetic/project && npm test';
  const passed = inspect([check('test', command), result('test')]);
  assert.equal(passed.checks[0].state, 'success');
  assert.equal(passed.checks[0].directory, '/synthetic/project');
  assert.equal(passed.checks[0].commandMode, 'directory-prefix');
  assert.equal(inspect([check('test', command), result('test', 'failure')]).checks[0].state, 'unknown');
  assert.equal(
    inspect([check('test', 'cd relative && npm test'), result('test')]).checks[0].commandMode,
    'compound-fragment'
  );
});

test('literal quoted arguments do not split into executable checks', () => {
  const report = inspect([
    check('echo', 'echo "npm test; pytest"'),
    result('echo'),
    check('python', 'python -c \'print("npm test")\''),
    result('python'),
    check('quoted', "pytest 'file with spaces.py'"),
    result('quoted'),
  ]);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].command, "pytest 'file with spaces.py'");
  assert.equal(report.checks[0].commandMode, 'direct');
});

test('a compound fragment after an edit records an unknown attempt, never a successful verification', () => {
  const row = inspect([edit('edit'), result('edit'), check('test', 'npm test 2>&1 | tail -20'), result('test')])
    .modifications[0];
  assert.equal(row.latestLater.operation.state, 'unknown');
  assert.equal(row.latestLater.operation.commandMode, 'compound-fragment');
  assert.match(row.latestLater.operation.evidence, /无法确认片段是否执行/);
});

test('compound checks retain provable initial or cd directory evidence without certifying exit status', () => {
  for (const [command, args] of [
    ['npm test | tail -20', { cwd: '/other' }],
    ['cd /other && npm test | tail -20', { cwd: '/initial' }],
  ]) {
    const report = inspect([
      edit('edit', { cwd: '/synthetic' }),
      result('edit'),
      check('test', command, args),
      result('test'),
    ]);
    assert.equal(report.checks[0].directory, '/other');
    assert.equal(report.checks[0].state, 'unknown');
    assert.equal(report.modifications[0].excludedScopeChecks, 1);
    assert.equal(report.modifications[0].laterChecks.length, 0);
  }
});

test('checks started in one assistant message have no uniquely latest call', () => {
  const simultaneous = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'pass', name: 'bash', arguments: { command: 'npm test' } },
      { type: 'toolCall', id: 'fail', name: 'bash', arguments: { command: 'npm run lint' } },
    ],
  };
  const row = inspect([edit('edit'), result('edit'), simultaneous, result('pass'), result('fail', 'failure')])
    .modifications[0];
  assert.equal(row.latestOrderAmbiguous, true);
  assert.equal(row.latestLater, null);
  assert.equal(row.laterChecks.length, 2);
});

test('conflicting command fields and non-shell tools do not masquerade as checks', () => {
  const report = inspect([
    check('bad', 'npm test', { cmd: 'echo done' }),
    call('read', 'Read', { command: 'npm test' }),
  ]);
  assert.equal(report.checks.length, 0);
});

test('ambiguous identities cannot manufacture modification or successful check evidence', () => {
  const report = inspect([edit('same'), result('same'), edit('same'), result('same'), check(null), result(null)]);
  assert.equal(report.successfulModifications, 0);
  assert.equal(report.modificationCalls, 2);
  assert.equal(report.checks[0].state, 'unknown');
});

test('embedded simultaneous call positions remain overlapping', () => {
  const message = {
    role: 'assistant',
    id: 'embedded',
    content: [
      { type: 'toolCall', id: 'edit', name: 'Edit', arguments: { file_path: '/synthetic/file.ts' } },
      { type: 'toolCall', id: 'test', name: 'Bash', arguments: { command: 'npm test' } },
    ],
  };
  const row = inspect([message, result('edit'), result('test')]).modifications[0];
  assert.equal(row.overlappingChecks.length, 1);
  assert.equal(row.operation.callMessage, message);
});

test('later completion appended to a check updates its state without new execution', () => {
  const messages = [edit('edit'), result('edit'), check('test'), result('test', 'running')];
  assert.equal(inspect(messages).modifications[0].latestLater.operation.state, 'running');
  const finished = inspect([...messages, result('test')]);
  assert.equal(finished.checks.length, 1);
  assert.equal(finished.modifications[0].latestLater.operation.state, 'success');
});

test('unsupported modification encodings are counted, not silently parsed', () => {
  const report = inspect([
    call('patch', 'apply_patch', '*** Begin Patch\n*** End Patch'),
    result('patch'),
    edit('ambiguous', { path: '/one', file_path: '/two' }),
    result('ambiguous'),
    edit('missing', { path: null }),
    result('missing'),
  ]);
  assert.equal(report.modifications.length, 0);
  assert.equal(report.unclassifiedModificationCalls, 3);
});

test('same turn is not required, but latest message order is not a timestamp guess', () => {
  const messages = [
    check('test'),
    result('test', 'success', { timestamp: '2099-01-01T00:00:00Z' }),
    { role: 'user', content: [{ type: 'text', text: 'Synthetic later task' }] },
    edit('edit'),
    result('edit', 'success', { timestamp: '2000-01-01T00:00:00Z' }),
  ];
  assert.equal(inspect(messages).changedAfterLastPassedCheck, 1);
});

test('chronology leaves original diagnostic output and input unchanged', () => {
  const messages = [check('test'), result('test', 'failure'), edit('edit'), result('edit')];
  const serialized = JSON.stringify(messages),
    before = api.diagnoseSession(messages);
  inspect(messages);
  assert.equal(JSON.stringify(messages), serialized);
  assert.deepEqual(api.diagnoseSession(messages), before);
});

test('known temporal permutations preserve before/after/overlap facts across 20 fixed bases', (context) => {
  let checks = 0;
  for (let index = 0; index < 20; index++) {
    const change = edit('edit', { path: `/synthetic/file-${index}.ts` });
    const verification = check('test', index % 2 ? 'pytest' : 'npm test');
    const cases = [
      [[verification, result('test'), change, result('edit')], 1, 0, 0],
      [[change, result('edit'), verification, result('test')], 0, 1, 0],
      [[verification, change, result('edit'), result('test')], 1, 0, 1],
      [[change, verification, result('edit'), result('test', 'failure')], 1, 0, 1],
      [[change, result('edit'), verification], 0, 1, 0],
      [[change, result('edit')], 1, 0, 0],
    ];
    for (const [messages, missing, later, overlap] of cases) {
      const report = inspect(messages);
      assert.equal(report.withoutLaterCheck, missing);
      assert.equal(report.withLaterCheck, later);
      assert.equal(report.modifications[0].overlappingChecks.length, overlap);
      assert.equal(report.withoutLaterCheck + report.withLaterCheck, report.successfulModifications);
      checks++;
    }
  }
  context.diagnostic(`Temporal transformations: ${checks}/120 PASS; no model judge or human labels.`);
});
