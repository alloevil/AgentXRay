const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tasks, materialize } = require('../effectiveness-pilot/tasks.cjs');
const { grade, executeCli, createBench, hash } = require('./bench.cjs');
const { telemetry, aggregate } = require('./run.cjs');

test('all original task references and classifications agree without changing tasks', () => {
  for (const task of tasks) {
    assert.equal(grade(process.execPath, task.reference, task.hiddenCases).passed, true, task.id);
    assert.equal(grade(process.execPath, task.source, task.publicCases).passed, true, task.id);
    assert.equal(grade(process.execPath, task.source, task.hiddenCases).passed, task.correctInitially, task.id);
  }
});

async function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-layered-selftest-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const work = path.join(directory, 'work');
  fs.mkdirSync(work);
  const data = await materialize(tasks[0]);
  fs.writeFileSync(path.join(work, 'solution.js'), 'function solve(input){return input;}');
  fs.writeFileSync(path.join(work, 'public-tests.json'), JSON.stringify([{ input: 1, expected: 2 }]));
  fs.writeFileSync(path.join(work, 'session.jsonl'), data.log);
  return { work, receipt: path.join(directory, 'tools.jsonl'), node: process.execPath };
}

test('real CLI full/summary facts agree; bounded evidence paginates and rejects changed hash', async (context) => {
  const spec = await fixture(context);
  const file = path.join(spec.work, 'session.jsonl');
  const full = executeCli(process.execPath, file, { action: 'inspect', view: 'full' });
  const summary = executeCli(process.execPath, file, { action: 'inspect', view: 'summary' });
  assert.equal(full.code, 0); assert.equal(summary.code, 0);
  assert.deepEqual(full.report.summary, summary.report.summary);
  assert.equal(summary.report.kind, 'summary');
  assert.equal(executeCli(process.execPath, file, { action: 'inspect', view: 'full' }).text, full.text);
  const first = executeCli(process.execPath, file, { action: 'evidence', sha256: full.report.source.sha256, line: 2, maxBytes: 32 });
  assert.equal(first.code, 0); assert.equal(first.report.returnedBytes, 32); assert.equal(first.report.nextOffset, 32);
  const second = executeCli(process.execPath, file, { action: 'evidence', sha256: full.report.source.sha256, line: 2, maxBytes: 32, offset: 32 });
  assert.equal(second.report.offset, 32);
  const wrong = executeCli(process.execPath, file, { action: 'evidence', sha256: '0'.repeat(64), line: 2 });
  assert.equal(wrong.code, 1); assert.equal(wrong.report.error.code, 'SOURCE_HASH_MISMATCH');
  assert.throws(() => executeCli(process.execPath, file, { action: 'inspect', view: '--help' }), /INVALID_VIEW/);
  assert.throws(() => executeCli(process.execPath, file, { action: 'evidence', sha256: full.report.source.sha256, line: '2;ls' }), /INVALID_EVIDENCE/);
});

test('bench enforces allowlisted reads and fixed tests and records actual response bytes', async (context) => {
  const spec = await fixture(context);
  const bench = createBench(spec);
  let aborted = false;
  const agent = { abort: () => { aborted = true; } };
  assert.equal((await bench.execute({ action: 'read', file: '../hidden.json' }, agent)).isError, true);
  assert.equal((await bench.execute({ action: 'write', file: 'public-tests.json', content: '[]' }, agent)).isError, true);
  assert.equal((await bench.execute({ action: 'test' }, agent)).isError, true);
  const response = await bench.execute({ action: 'write', file: 'solution.js', content: 'function solve(input){return input+1;}' }, agent);
  assert.equal(response.isError, false);
  const passed = await bench.execute({ action: 'test' }, agent);
  assert.equal(passed.isError, false);
  await bench.execute({ action: 'finish', status: 'done' }, agent);
  await bench.execute({ action: 'test' }, agent);
  assert.equal(aborted, true);
  const rows = fs.readFileSync(spec.receipt, 'utf8').trim().split('\n').map(JSON.parse);
  const write = rows.find((row) => row.action === 'write' && row.ok);
  assert.equal(write.responseTextBytes, Buffer.byteLength(response.content[0].text));
  assert.equal(write.responseEnvelopeBytes, Buffer.byteLength(JSON.stringify(response)));
  assert.equal(write.outputHash, hash(response.content[0].text));
  assert.ok(rows.some((row) => row.type === 'finish'));
  assert.ok(rows.some((row) => row.type === 'budget-stop'));
});

test('bench stops at 12 calls; original-input tampering is infrastructure failure', async (context) => {
  const spec = await fixture(context);
  const bench = createBench(spec);
  let aborted = false;
  const agent = { abort: () => { aborted = true; } };
  for (let index = 0; index < 13; index++) await bench.execute({ action: 'read', file: 'solution.js' }, agent);
  assert.equal(aborted, true);
  const rows = fs.readFileSync(spec.receipt, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((row) => row.type === 'tool').length, 12);
  const second = createBench({ ...spec, receipt: spec.receipt + '.other' });
  fs.appendFileSync(path.join(spec.work, 'session.jsonl'), '\n');
  const response = await second.execute({ action: 'read', file: 'session.jsonl' }, agent);
  assert.equal(response.isError, true);
  assert.match(fs.readFileSync(spec.receipt + '.other', 'utf8'), /READ_ONLY_INPUT_CHANGED/);
});

test('telemetry audits model/tool/response identity, usage and evidence counters', () => {
  const text = '{"kind":"evidence"}';
  const events = [{ type: 'agent_end', messages: [
    { role: 'assistant', provider: 'mify', model: 'deepseek/deepseek-flash', content: [{ type: 'toolCall', name: 'bench' }],
      usage: { input: 10, output: 5, cacheRead: 7, totalTokens: 22 } },
    { role: 'toolResult', content: [{ type: 'text', text }] },
  ] }];
  const receipts = [{ type: 'active-tools', tools: ['bench'] },
    { type: 'tool', action: 'evidence', offset: 32, ok: true, outputHash: hash(text), responseTextBytes: Buffer.byteLength(text), responseEnvelopeBytes: 100, elapsedMs: 20, cliMs: 19, truncated: true },
    { type: 'finish', status: 'done' }];
  const result = telemetry(events, receipts);
  assert.equal(result.onlyBench, true); assert.equal(result.usagePresent, true);
  assert.equal(result.receiptCallsAgree, true); assert.equal(result.responseHashesAgree, true);
  assert.equal(result.evidenceCalls, 1); assert.equal(result.evidenceContinuations, 1); assert.equal(result.truncatedEvidence, 1);
  assert.equal(result.tokens.totalTokens, 22); assert.equal(result.toolMs, 20);
  assert.equal(telemetry([], receipts).hasAgentEnd, false);
  assert.equal(telemetry(events, receipts.slice(0, 1)).receiptCallsAgree, false);
});

test('aggregate pairs task/repeat and keeps invalid or missing trials visible', () => {
  const manifest = { order: [{ id: 'f', task: 'one', repeat: 0, arm: 'full' }, { id: 'l', task: 'one', repeat: 0, arm: 'layered' }] };
  const base = { valid: true, tokens: { totalTokens: 10 }, hiddenPassed: true, toolCalls: 5, endToEndMs: 20,
    setupMs: 1, initialCliMs: 2, toolMs: 3, cliToolMs: 1, modelMs: 15, evaluationMs: 2, submitted: 'done' };
  const full = { ...base, ...manifest.order[0] };
  const layered = { ...base, ...manifest.order[1], tokens: { totalTokens: 8 }, toolCalls: 6 };
  const report = aggregate(manifest, [full, layered]);
  assert.equal(report.complete, true); assert.equal(report.paired.ties, 1);
  assert.equal(report.paired.meanTokensDifference, -2); assert.equal(report.paired.meanToolsDifference, 1);
  assert.equal(report.realTasks, 0);
  assert.equal(aggregate(manifest, [full]).complete, false);
  assert.deepEqual(aggregate(manifest, [full]).missing, ['l']);
  assert.deepEqual(aggregate(manifest, [full, { ...layered, valid: false }]).invalid, ['l']);
});
