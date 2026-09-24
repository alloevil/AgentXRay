const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tasks, materialize } = require('./tasks.cjs');

const evaluator = path.join(__dirname, 'evaluate.cjs');
function grade(source, cases) {
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${evaluator}`, evaluator], {
    input: JSON.stringify({ source, cases }), encoding: 'utf8', timeout: 4000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('all reference solutions pass; initial classifications and public tests agree', () => {
  for (const task of tasks) {
    assert.equal(grade(task.reference, task.hiddenCases).passed, true, task.id);
    assert.equal(grade(task.reference, task.publicCases).passed, true, task.id);
    assert.equal(grade(task.source, task.hiddenCases).passed, task.correctInitially, task.id);
    assert.equal(grade(task.source, task.publicCases).passed, true, task.id);
  }
});

test('grading ignores object key order, but preserves array order and types', () => {
  assert.equal(grade('function solve(){return {remaining:0,allowed:false}}', [{ input: null, expected: { allowed: false, remaining: 0 } }]).passed, true);
  assert.equal(grade('function solve(){return [2,1]}', [{ input: null, expected: [1, 2] }]).passed, false);
  assert.equal(grade('function solve(){return "1"}', [{ input: null, expected: 1 }]).passed, false);
});

test('evaluator records missing globals, syntax errors and loop timeouts as failures', () => {
  for (const source of ['function solve(){return process.env}', 'function solve(){return require("fs")}', 'invalid syntax!', 'function solve(){while(true){}}']) {
    assert.equal(grade(source, [{ input: null, expected: true }]).passed, false);
  }
});

test('reports are deterministic, complete and obey the mechanical byte cap', async () => {
  for (const task of tasks) {
    const first = await materialize(task);
    assert.deepEqual(await materialize(task), first, task.id);
    assert.equal(JSON.parse(first.report).complete, true, task.id);
    assert.ok(Buffer.byteLength(first.mechanical) <= first.summaryBudgetBytes);
    assert.ok(JSON.parse(first.mechanical).recent.length > 0);
  }
});

test('tool allowlist, write boundary, public evaluator, intent-independent receipts and budget', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-harness-test-'));
  const receipt = path.join(directory, 'receipt.jsonl');
  const previous = { ...process.env };
  Object.assign(process.env, { AXR_TRIAL_WORK: directory, AXR_TRIAL_RECEIPT: receipt, AXR_TRIAL_EVALUATOR: evaluator });
  try {
    fs.writeFileSync(path.join(directory, 'solution.js'), 'function solve(input){return input}');
    fs.writeFileSync(path.join(directory, 'public-tests.json'), JSON.stringify([{ input: 2, expected: 2 }]));
    const extension = (await import('./tools.ts')).default;
    const schema = { optional() { return this; } };
    let registered;
    let start;
    let active = [];
    let aborted = false;
    extension({ zod: { enum: () => schema, string: () => schema, object: () => schema },
      on: (_event, callback) => { start = callback; }, setActiveTools: (names) => { active = names; },
      getActiveTools: () => active, registerTool: (tool) => { registered = tool; } });
    await start();
    const context = { abort: () => { aborted = true; } };
    const invoke = (params) => registered.execute('test', params, null, context);
    assert.deepEqual(active, ['bench']);
    assert.equal((await invoke({ action: 'read', file: '../hidden.json', i: 'first' })).isError, true);
    assert.equal((await invoke({ action: 'read', file: '../hidden.json', i: 'different' })).isError, true);
    const rows = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[1].inputHash, rows[2].inputHash);
    assert.equal((await invoke({ action: 'write', file: 'public-tests.json', content: '[]' })).isError, true);
    assert.equal((await invoke({ action: 'write', file: 'solution.js', content: 'x'.repeat(12001) })).isError, true);
    assert.equal((await invoke({ action: 'test' })).isError, false);
    assert.equal((await invoke({ action: 'write', file: 'solution.js', content: 'function solve(){return 0}' })).isError, false);
    assert.equal((await invoke({ action: 'test' })).isError, true);
    for (let index = 0; index < 6; index++) await invoke({ action: 'read', file: 'solution.js' });
    assert.equal(aborted, true);
  } finally {
    for (const key of ['AXR_TRIAL_WORK', 'AXR_TRIAL_RECEIPT', 'AXR_TRIAL_EVALUATOR']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
