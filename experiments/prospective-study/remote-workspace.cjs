const fs = require('node:fs');
const path = require('node:path');
const { openForArm, guardToolResponse } = require('./disclose.cjs');
const { readRegular, directoryFiles, hash, json, fail } = require('./capture.cjs');
const { isolatedCheck } = require('./isolate.cjs');

const MAX_CALLS = 40;
const MAX_WRITE = 128 * 1024;

function workspaceState(workspace, payload) {
  const files = directoryFiles(workspace);
  if (json(files) !== json(Object.keys(payload.workspace).sort())) fail('WORKSPACE_FILE_SET_CHANGED');
  const inventory = files.map((file) => {
    const value = readRegular(workspace, file);
    if (!payload.writable.includes(file) && hash(value.bytes) !== hash(payload.workspace[file])) fail('READ_ONLY_FILE_CHANGED');
    if (value.mode !== payload.modes[file]) fail('WORKSPACE_MODE_CHANGED');
    return { path: file, hash: hash(value.bytes), mode: value.mode };
  });
  return { hash: hash(json(inventory)), inventory };
}

function createBench({ disclosure, arm, work, receipt, containerLabel, scratchRoot, gateHash }) {
  const frozenGateHash = hash(readRegular(path.join(disclosure, 'private'), 'gate.json').bytes);
  if (gateHash && gateHash !== frozenGateHash) fail('REMOTE_GATE_CHANGED');
  const payload = openForArm(disclosure, arm);
  let calls = 0;
  let finished = false;
  const append = (row) => fs.appendFileSync(receipt, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });
  const execute = async (params, context) => {
    calls++;
    if (finished || calls > MAX_CALLS) {
      append({ type: 'budget-stop', calls, reason: finished ? 'already-submitted' : 'tool-cap' });
      context.abort();
      return errorResult('No further tool calls are permitted.');
    }
    const start = performance.now();
    try {
      if (hash(readRegular(path.join(disclosure, 'private'), 'gate.json').bytes) !== frozenGateHash) fail('REMOTE_GATE_CHANGED');
      const before = workspaceState(work, payload);
      let output;
      let ok = true;
      if (params.action === 'list') output = { files: Object.keys(payload.workspace).sort(), history: '@history', writable: payload.writable };
      else if (params.action === 'read') {
        if (params.file !== '@history' && !Object.hasOwn(payload.workspace, params.file)) {
          ok = false; output = { error: 'File is outside the allowlist.' };
        } else {
          const offset = params.offset ?? 0;
          const limit = params.limit ?? 16384;
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16384) {
            ok = false; output = { error: 'Use a nonnegative character offset and limit from 1 to 16384.' };
          } else {
            const text = params.file === '@history' ? payload.history : readRegular(work, params.file).bytes.toString('utf8');
            guardToolResponse(disclosure, text);
            output = { file: params.file, offset, totalCharacters: text.length, content: text.slice(offset, offset + limit) };
          }
        }
      } else if (params.action === 'write') {
        if (!payload.writable.includes(params.file) || typeof params.content !== 'string' || Buffer.byteLength(params.content) > MAX_WRITE) {
          ok = false; output = { error: 'Only declared writable files, up to 128 KiB each, may be changed.' };
        } else {
          guardToolResponse(disclosure, params.content);
          readRegular(work, params.file);
          const descriptor = fs.openSync(path.join(work, params.file), fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
          try { fs.writeFileSync(descriptor, params.content); } finally { fs.closeSync(descriptor); }
          output = { written: params.file };
        }
      } else if (params.action === 'test') {
        const result = isolatedCheck({ image: payload.image, workspace: work, command: payload.publicCommand, containerLabel, scratchRoot });
        if (result.infrastructureFailure) fail('PUBLIC_CHECK_INFRASTRUCTURE_FAILURE');
        guardToolResponse(disclosure, JSON.stringify(result));
        ok = result.passed;
        output = { passed: result.passed, code: result.code, stdout: result.stdout.slice(0, 16384), stderr: result.stderr.slice(0, 16384),
          truncated: result.stdout.length > 16384 || result.stderr.length > 16384 };
      } else if (params.action === 'finish' && ['done', 'blocked'].includes(params.status)) {
        output = { submitted: params.status, instruction: 'Return your final answer without further tools.' };
      } else { ok = false; output = { error: 'Unsupported action or missing submission status.' }; }
      const text = guardToolResponse(disclosure, JSON.stringify(output));
      if (hash(readRegular(path.join(disclosure, 'private'), 'gate.json').bytes) !== frozenGateHash) fail('REMOTE_GATE_CHANGED');
      const after = workspaceState(work, payload);
      if (ok && params.action === 'finish') {
        finished = true;
        append({ type: 'finish', status: params.status, sourceHash: after.hash });
      }
      append({ type: 'tool', call: calls, action: params.action, file: params.file || null, ok,
        inputHash: hash(JSON.stringify([params.action, params.file || null, params.offset ?? null, params.limit ?? null,
          typeof params.content === 'string' ? hash(params.content) : null, params.status || null, before.hash])),
        sourceHash: after.hash, elapsedMs: performance.now() - start });
      return { isError: !ok, content: [{ type: 'text', text }] };
    } catch (error) {
      try { append({ type: 'gate-stop', call: calls, reason: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'WORKSPACE_OR_GATE_FAILURE' }); } catch {}
      context.abort();
      return errorResult('The disclosure or execution gate stopped this trial. No further actions are permitted.');
    }
  };
  return { execute };
}

module.exports = { createBench, workspaceState, MAX_CALLS };
