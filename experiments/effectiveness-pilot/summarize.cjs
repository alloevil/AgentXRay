const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tasks } = require('./tasks.cjs');

const output = path.resolve(__dirname, '../../output/effectiveness-pilot');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};
const count = (rows, key) => rows.filter((row) => row[key]).length;

function summarize(manifest, results) {
  const arms = {};
  for (const arm of manifest.arms) {
    const rows = results.filter((result) => result.arm === arm && result.valid);
    const correct = rows.filter((result) => result.initiallyCorrect);
    const broken = rows.filter((result) => !result.initiallyCorrect);
    const tokens = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoningTokens']) {
      tokens[key] = { total: rows.reduce((sum, row) => sum + (row.tokens[key] || 0), 0), mean: mean(rows.map((row) => row.tokens[key] || 0)) };
    }
    arms[arm] = { trials: rows.length, hiddenPasses: count(rows, 'hiddenPassed'),
      brokenTaskPasses: count(broken, 'hiddenPassed'), brokenTaskTrials: broken.length,
      falseCompletions: count(rows, 'falseCompletion'), missingFinish: rows.filter((row) => row.finishedStatus === 'not-submitted').length,
      correctTaskTrials: correct.length, unnecessaryWrites: count(correct, 'unnecessaryWrite'), harmfulChanges: count(correct, 'harmfulChange'),
      budgetStops: count(rows, 'budgetStopped'), logReadTrials: rows.filter((row) => row.logReads > 0).length,
      toolsTotal: rows.reduce((sum, row) => sum + row.toolCalls, 0), toolsMean: mean(rows.map((row) => row.toolCalls)),
      publicTestFailures: rows.reduce((sum, row) => sum + row.publicTestFailures, 0), repeatedFailedActions: rows.reduce((sum, row) => sum + row.repeatedFailedActions, 0),
      elapsedMsMean: mean(rows.map((row) => row.elapsedMs)), elapsedMsMedian: median(rows.map((row) => row.elapsedMs)), tokens };
  }
  const pairs = {};
  for (const control of ['raw', 'mechanical']) {
    const paired = [];
    for (const item of manifest.order.filter((entry) => entry.arm === 'xray')) {
      const candidate = results.find((row) => row.id === item.id && row.valid);
      const otherId = manifest.order.find((entry) => entry.task === item.task && entry.repeat === item.repeat && entry.arm === control)?.id;
      const other = results.find((row) => row.id === otherId && row.valid);
      if (candidate && other) paired.push({ task: item.task, repeat: item.repeat,
        passDifference: Number(candidate.hiddenPassed) - Number(other.hiddenPassed),
        toolsDifference: candidate.toolCalls - other.toolCalls,
        totalTokensDifference: candidate.tokens.totalTokens - other.tokens.totalTokens,
        elapsedMsDifference: candidate.elapsedMs - other.elapsedMs });
    }
    pairs[`xray-minus-${control}`] = { count: paired.length, wins: paired.filter((row) => row.passDifference > 0).length,
      losses: paired.filter((row) => row.passDifference < 0).length, ties: paired.filter((row) => row.passDifference === 0).length,
      meanPassDifference: mean(paired.map((row) => row.passDifference)), meanToolsDifference: mean(paired.map((row) => row.toolsDifference)),
      meanTotalTokensDifference: mean(paired.map((row) => row.totalTokensDifference)), meanElapsedMsDifference: mean(paired.map((row) => row.elapsedMsDifference)), rows: paired };
  }
  return { kind: 'descriptive-synthetic-pilot', planned: manifest.order.length, recorded: results.length,
    valid: count(results, 'valid'), invalid: results.filter((row) => !row.valid).map((row) => row.id),
    complete: results.length === manifest.order.length && results.every((row) => row.valid), arms, pairs,
    perTask: manifest.tasks.map((task) => ({ task: task.id, arms: Object.fromEntries(manifest.arms.map((arm) => {
      const rows = results.filter((row) => row.task === task.id && row.arm === arm && row.valid);
      return [arm, { passes: count(rows, 'hiddenPassed'), trials: rows.length }];
    })) })) };
}

function main() {
  const manifest = json(path.join(output, 'manifest.json'));
  const results = [];
  for (const item of manifest.order) {
    const directory = path.join(output, 'trials', item.id);
    if (!fs.existsSync(path.join(directory, 'result.json'))) continue;
    const result = json(path.join(directory, 'result.json'));
    assert.equal(result.id, item.id);
    assert.equal(result.task, item.task);
    assert.equal(result.arm, item.arm);
    const source = fs.readFileSync(path.join(directory, 'solution.js'), 'utf8');
    assert.equal(hash(source), result.sourceHash);
    const task = tasks.find((entry) => entry.id === item.task);
    const execution = spawnSync(process.execPath, [path.join(__dirname, 'evaluate.cjs')], {
      input: JSON.stringify({ source, cases: task.hiddenCases }), encoding: 'utf8', timeout: 4000,
    });
    assert.equal(JSON.parse(execution.stdout).passed, result.hiddenPassed, item.id);
    if (result.valid) {
      assert.deepEqual(result.modelSelectors, [manifest.model]);
      assert.deepEqual(result.activeTools, ['bench']);
      const tools = jsonl(path.join(directory, 'tools.jsonl'));
      assert.equal(tools.filter((row) => row.type === 'tool').length, result.toolCalls);
      const end = jsonl(path.join(directory, 'events.jsonl')).findLast((event) => event.type === 'agent_end');
      assert.ok(end, item.id);
      const usage = {};
      for (const message of end.messages.filter((entry) => entry.role === 'assistant')) {
        assert.equal(`${message.provider}/${message.model}`, manifest.model);
        for (const [key, value] of Object.entries(message.usage || {})) if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
      }
      assert.deepEqual(usage, result.tokens, item.id);
    }
    results.push(result);
  }
  const summary = { manifestHash: hash(fs.readFileSync(path.join(output, 'manifest.json'))), ...summarize(manifest, results) };
  fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.complete) process.exitCode = 1;
}

module.exports = { summarize };
if (require.main === module) main();
