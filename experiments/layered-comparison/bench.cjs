const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'bin/agentxray.js');
const EVALUATOR = path.join(ROOT, 'experiments/effectiveness-pilot/evaluate.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function grade(node, source, cases) {
  const execution = spawnSync(node, ['--permission', `--allow-fs-read=${EVALUATOR}`, '--max-old-space-size=64', EVALUATOR], {
    input: JSON.stringify({ source, cases }), encoding: 'utf8', timeout: 4000, maxBuffer: 100000, env: { PATH: process.env.PATH },
  });
  if (execution.status !== 0 || execution.error) throw new Error('EVALUATOR_FAILED');
  const result = JSON.parse(execution.stdout);
  if (typeof result.passed !== 'boolean' || !Array.isArray(result.cases) || result.cases.length !== cases.length) throw new Error('EVALUATOR_INVALID');
  return result;
}

function executeCli(node, file, params) {
  let args;
  if (params.action === 'inspect') {
    if (!['full', 'summary'].includes(params.view)) throw new Error('INVALID_VIEW');
    args = ['inspect', '--platform', 'codex', file, '--json'];
    if (params.view === 'summary') args.push('--summary');
  } else {
    if (typeof params.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(params.sha256) || !Number.isSafeInteger(params.line) || params.line < 1 ||
      !Number.isSafeInteger(params.offset ?? 0) || (params.offset ?? 0) < 0 || !Number.isSafeInteger(params.maxBytes ?? 4096) ||
      (params.maxBytes ?? 4096) < 4 || (params.maxBytes ?? 4096) > 16384) throw new Error('INVALID_EVIDENCE_ARGUMENTS');
    args = ['evidence', '--platform', 'codex', file, '--sha256', params.sha256, '--line', String(params.line),
      '--offset', String(params.offset ?? 0), '--max-bytes', String(params.maxBytes ?? 4096), '--json'];
  }
  const start = performance.now();
  const execution = spawnSync(node, [CLI, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH } });
  if (execution.error || ![0, 1, 2].includes(execution.status)) throw new Error('CLI_PROCESS_FAILED');
  const report = JSON.parse(execution.stdout);
  return { text: execution.stdout, code: execution.status, report, elapsedMs: performance.now() - start };
}

function createBench({ work, receipt, node }) {
  const allowed = ['solution.js', 'public-tests.json', 'session.jsonl'];
  const log = fs.readFileSync(path.join(work, 'session.jsonl'));
  const publicTests = fs.readFileSync(path.join(work, 'public-tests.json'));
  const append = (row) => fs.appendFileSync(receipt, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  let calls = 0;
  let finished = false;
  async function execute(params, context) {
    calls++;
    if (finished || calls > 12) {
      append({ type: 'budget-stop', call: calls, reason: finished ? 'after-finish' : 'call-limit' });
      context.abort();
      return { isError: true, content: [{ type: 'text', text: 'No further tool calls are permitted.' }] };
    }
    const start = performance.now();
    const originalSource = fs.readFileSync(path.join(work, 'solution.js'), 'utf8');
    let output;
    let ok = true;
    let cli;
    try {
      if (!fs.readFileSync(path.join(work, 'session.jsonl')).equals(log) || !fs.readFileSync(path.join(work, 'public-tests.json')).equals(publicTests)) throw new Error('READ_ONLY_INPUT_CHANGED');
      if (params.action === 'read') {
        if (!allowed.includes(params.file)) { ok = false; output = JSON.stringify({ error: 'Only solution.js, public-tests.json and session.jsonl can be read.' }); }
        else output = JSON.stringify({ file: params.file, content: fs.readFileSync(path.join(work, params.file), 'utf8') });
      } else if (params.action === 'write') {
        if (params.file !== 'solution.js' || typeof params.content !== 'string' || Buffer.byteLength(params.content) > 12000) {
          ok = false; output = JSON.stringify({ error: 'Only solution.js up to 12000 bytes can be written.' });
        } else { fs.writeFileSync(path.join(work, 'solution.js'), params.content); output = JSON.stringify({ written: 'solution.js' }); }
      } else if (params.action === 'test') {
        const result = grade(node, originalSource, JSON.parse(publicTests));
        ok = result.passed; output = JSON.stringify(result);
      } else if (['inspect', 'evidence'].includes(params.action)) {
        try { cli = executeCli(node, path.join(work, 'session.jsonl'), params); }
        catch (error) {
          if (['INVALID_VIEW', 'INVALID_EVIDENCE_ARGUMENTS'].includes(error.message)) {
            ok = false; output = JSON.stringify({ error: error.message });
          } else throw error;
        }
        if (cli) { output = cli.text; ok = cli.code === 0; }
      } else if (params.action === 'finish' && ['done', 'blocked'].includes(params.status)) {
        finished = true;
        append({ type: 'finish', status: params.status });
        output = JSON.stringify({ submitted: params.status, instruction: 'Now return your final answer without more tools.' });
      } else { ok = false; output = JSON.stringify({ error: 'Unsupported action or finish status.' }); }
    } catch (error) {
      append({ type: 'infrastructure-stop', call: calls, reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'TOOL_INFRASTRUCTURE_FAILED' });
      context.abort();
      return { isError: true, content: [{ type: 'text', text: 'Infrastructure stopped this trial; no retry.' }] };
    }
    const semantic = [params.action, params.file ?? null, params.view ?? null, params.sha256 ?? null, params.line ?? null,
      params.offset ?? null, params.maxBytes ?? null, typeof params.content === 'string' ? hash(params.content) : null,
      params.status ?? null, hash(originalSource)];
    const response = { isError: !ok, content: [{ type: 'text', text: output }] };
    append({ type: 'tool', call: calls, action: params.action, file: params.file || null, view: params.view || null,
      line: params.line ?? null, offset: params.offset ?? null, maxBytes: params.maxBytes ?? null,
      ok, inputHash: hash(JSON.stringify(semantic)), sourceHash: hash(fs.readFileSync(path.join(work, 'solution.js'))),
      outputHash: hash(output), responseTextBytes: Buffer.byteLength(output), responseEnvelopeBytes: Buffer.byteLength(JSON.stringify(response)),
      cliMs: cli?.elapsedMs || 0, cliExit: cli?.code ?? null, truncated: cli?.report.truncated ?? null,
      returnedBytes: cli?.report.returnedBytes ?? null, nextOffset: cli?.report.nextOffset ?? null,
      errorCode: cli?.report.error?.code || null, elapsedMs: performance.now() - start });
    return response;
  }
  return { execute };
}

module.exports = { hash, grade, executeCli, createBench };
