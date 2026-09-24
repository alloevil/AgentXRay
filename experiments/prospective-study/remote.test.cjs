const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSmoke } = require('./remote-smoke.cjs');
const { openForArm } = require('./disclose.cjs');
const { createBench, workspaceState, MAX_CALLS } = require('./remote-workspace.cjs');
const { telemetry, summarize, runStudy, MODEL } = require('./remote-run.cjs');
const { writeFile } = require('./capture.cjs');

const image = process.env.AXR_TEST_IMAGE;

test('private snapshots do not expose nested configurations to the repository linter', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-lint-output-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configuration = JSON.parse(fs.readFileSync(path.join(__dirname, '../../biome.json')));
  const nested = path.join(directory, 'output/candidate/workspace');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'biome.json'), JSON.stringify(configuration));
  fs.writeFileSync(path.join(directory, 'server.js'), 'module.exports = 42;\n');
  const binary = path.join(__dirname, '../../node_modules/.bin/biome');
  const withoutIgnore = { ...configuration, files: { ...configuration.files, includes: configuration.files.includes.filter((entry) => entry !== '!!output') } };
  fs.writeFileSync(path.join(directory, 'biome.json'), JSON.stringify(withoutIgnore));
  const broken = spawnSync(binary, ['check', '--formatter-enabled=false', '.'], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stdout + broken.stderr, /nested root configuration/);
  fs.writeFileSync(path.join(directory, 'biome.json'), JSON.stringify(configuration));
  const fixed = spawnSync(binary, ['check', '--formatter-enabled=false', '.'], { cwd: directory, encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
});

async function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-remote-unit-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const disclosure = await createSmoke(path.join(directory, 'fixture'), image);
  const payload = openForArm(disclosure, 'raw');
  const work = path.join(directory, 'work');
  fs.mkdirSync(work);
  for (const [file, content] of Object.entries(payload.workspace)) writeFile(work, file, content, payload.modes[file]);
  return { directory, disclosure, payload, work, receipt: path.join(directory, 'tools.jsonl') };
}

test('remote telemetry uses actual model/tool events and preserves usage categories', () => {
  const messages = [{ role: 'assistant', provider: 'mify', model: 'deepseek/deepseek-flash', usage: { input: 10, output: 5, cacheRead: 4, totalTokens: 19 }, content: [{ type: 'toolCall', name: 'bench' }] },
    { role: 'assistant', provider: 'mify', model: 'deepseek/deepseek-flash', usage: { input: 2, output: 3, cacheRead: 6, totalTokens: 11 }, content: [] }];
  const receipts = [{ type: 'active-tools', tools: ['bench'] }, { type: 'tool', action: 'test', ok: true }, { type: 'finish', status: 'done' }];
  const result = telemetry([{ type: 'agent_end', messages }], receipts);
  assert.deepEqual(result.modelSelectors, [MODEL]);
  assert.deepEqual(result.tokens, { input: 12, output: 8, cacheRead: 10, totalTokens: 30 });
  assert.equal(result.actualCalls, 1); assert.equal(result.publicChecks, 1); assert.equal(result.submitted, 'done');
  assert.equal(telemetry([{ type: 'agent_end', messages: [...messages, { ...messages[0], content: [{ type: 'toolCall', name: 'bash' }] }] }], receipts).onlyBenchCalls, false);
  assert.equal(telemetry([], receipts).hasAgentEnd, false);
  assert.equal(telemetry([{ type: 'agent_end', messages: [{ ...messages[0], stopReason: 'error' }] }], receipts).providerErrors, 1);
});

test('summary keeps invalid attempts visible and does not call synthetic trials real tasks', () => {
  const manifest = { origin: 'synthetic-smoke', order: [{}, {}], preprocessing: { raw: { elapsedMs: 0 } } };
  const rows = [{ id: 'one', arm: 'raw', valid: true, hiddenPassed: false, falseCompletion: true, toolCalls: 3, submitted: 'done', tokens: { totalTokens: 20 } },
    { id: 'two', arm: 'xray', valid: false, hiddenPassed: true }];
  const summary = summarize(manifest, rows);
  assert.equal(summary.realTaskCount, 0); assert.equal(summary.complete, false);
  assert.deepEqual(summary.invalid, ['two']); assert.equal(summary.arms.raw.falseCompletions, 1);
  assert.equal(summary.arms.xray.recorded, 1); assert.equal(summary.arms.xray.valid, 0);
});

test('Docker: bench cannot read other arms/oracle or edit checks; public tests operate on copies', { skip: !image }, async (context) => {
  const value = await fixture(context);
  let aborted = false;
  const bench = createBench({ ...value, arm: 'raw' });
  const agent = { abort: () => { aborted = true; } };
  const original = workspaceState(value.work, value.payload).hash;
  for (const file of ['../private/oracle/accept.cjs', '/etc/passwd', 'supplements/xray.json']) {
    assert.equal((await bench.execute({ action: 'read', file }, agent)).isError, true);
  }
  assert.equal((await bench.execute({ action: 'write', file: 'public.cjs', content: 'process.exit(0)' }, agent)).isError, true);
  assert.equal(workspaceState(value.work, value.payload).hash, original);
  const history = await bench.execute({ action: 'read', file: '@history' }, agent);
  assert.ok(!JSON.stringify(history).includes('smoke.user@example.invalid'));
  assert.equal((await bench.execute({ action: 'write', file: 'src/tax.cjs', content: 'module.exports=(subtotal,basisPoints)=>Math.round(subtotal*basisPoints/10000);\n' }, agent)).isError, false);
  const fixed = workspaceState(value.work, value.payload).hash;
  assert.equal((await bench.execute({ action: 'test' }, agent)).isError, false);
  assert.equal(workspaceState(value.work, value.payload).hash, fixed);
  assert.equal((await bench.execute({ action: 'finish', status: 'done' }, agent)).isError, false);
  assert.equal((await bench.execute({ action: 'read', file: '@history' }, agent)).isError, true);
  assert.equal(aborted, true); assert.equal(MAX_CALLS, 40);
});

test('Docker: gate stops sensitive writes without echoing the value or touching source', { skip: !image }, async (context) => {
  const value = await fixture(context);
  let aborted = false;
  const bench = createBench({ ...value, arm: 'raw' });
  const before = workspaceState(value.work, value.payload).hash;
  const result = await bench.execute({ action: 'write', file: 'src/tax.cjs', content: 'smoke.user@example.invalid' }, { abort: () => { aborted = true; } });
  assert.equal(result.isError, true); assert.equal(aborted, true);
  assert.ok(!JSON.stringify(result).includes('smoke.user@example.invalid'));
  assert.equal(workspaceState(value.work, value.payload).hash, before);
  assert.ok(fs.readFileSync(value.receipt, 'utf8').includes('gate-stop'));
});

test('Docker: hidden oracle drift and symlink escape are refused', { skip: !image }, async (context) => {
  const value = await fixture(context);
  const bench = createBench({ ...value, arm: 'raw' });
  fs.unlinkSync(path.join(value.work, 'src/tax.cjs'));
  fs.symlinkSync('/etc/passwd', path.join(value.work, 'src/tax.cjs'));
  let aborted = false;
  const result = await bench.execute({ action: 'read', file: 'src/tax.cjs' }, { abort: () => { aborted = true; } });
  assert.equal(result.isError, true); assert.equal(aborted, true);
  assert.ok(!JSON.stringify(result).includes('root:'));
  fs.appendFileSync(path.join(value.disclosure, 'private/oracle/accept.cjs'), '\n');
  assert.throws(() => openForArm(value.disclosure, 'raw'), /SANITIZED_ORACLE_CHANGED/);
});

test('Docker: a partial study is retained and refused before any model call', { skip: !image }, async (context) => {
  const value = await fixture(context);
  await assert.rejects(runStudy(path.dirname(value.disclosure)), /VERIFIED_DISCLOSURE_REQUIRED/);
  const partial = path.join(value.disclosure, 'private/remote-study');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'partial.txt'), 'retained for audit');
  await assert.rejects(runStudy(value.disclosure), /INTERRUPTED_STUDY_NO_RETRY/);
  assert.equal(fs.readFileSync(path.join(partial, 'partial.txt'), 'utf8'), 'retained for audit');
});
