const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capture, verifyCapture, hash, json } = require('./capture.cjs');
const { prepare, submit, check } = require('./prepare.cjs');
const { isolatedCheck } = require('./isolate.cjs');
const { status } = require('./cli.cjs');

const image = process.env.AXR_TEST_IMAGE;
const history = [
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Synthetic infrastructure smoke. Implement increment.' }] } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'smoke-check', name: 'bash', arguments: { command: 'npm test' } }] } },
  { type: 'message', message: { role: 'toolResult', toolCallId: 'smoke-check', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Synthetic failing assertion: expected 2, received 0.' }] } },
].map(JSON.stringify).join('\n') + '\n';

function fixture(context) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-study-test-'));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repo');
  const oracleDirectory = path.join(temporary, 'oracle');
  fs.mkdirSync(repo); fs.mkdirSync(oracleDirectory);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'output/\nignored.txt\n');
  fs.writeFileSync(path.join(repo, 'index.cjs'), 'module.exports = value => value - 1;\n');
  fs.writeFileSync(path.join(repo, 'public.cjs'), 'require("node:assert/strict").equal(typeof require("./index.cjs"), "function");\n');
  fs.writeFileSync(path.join(repo, 'delete.txt'), 'tracked, then deleted');
  fs.writeFileSync(path.join(repo, 'executable.sh'), 'exit 0\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Infrastructure Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic fixture']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  }
  fs.writeFileSync(path.join(oracleDirectory, 'accept.cjs'), 'const assert = require("node:assert/strict"); const solve = require("/work/index.cjs"); assert.equal(solve(1),2); assert.equal(solve(-1),0); console.log("HIDDEN_PASS");\n');
  const contract = { provenance: 'independent-task-specific', image: image || `sha256:${'0'.repeat(64)}`,
    publicCommand: ['node', 'public.cjs'], hiddenCommand: ['node', '/oracle/accept.cjs'], writable: ['index.cjs'], oracleDirectory };
  const options = { repo, output: path.join(repo, 'output/prospective-study'), prompt: 'Synthetic smoke: increment the input by one.', history, origin: 'synthetic-smoke' };
  return { ...options, options, contract, oracleDirectory, temporary };
}

test('capture preserves dirty, untracked, deleted and executable files without changing HEAD/index', (context) => {
  const value = fixture(context);
  const originalIndex = fs.readFileSync(path.join(value.repo, '.git/index'));
  fs.writeFileSync(path.join(value.repo, 'index.cjs'), 'module.exports = value => value - 2;\n');
  fs.writeFileSync(path.join(value.repo, 'new.txt'), 'untracked bytes');
  fs.writeFileSync(path.join(value.repo, 'ignored.txt'), 'not captured');
  fs.unlinkSync(path.join(value.repo, 'delete.txt'));
  fs.chmodSync(path.join(value.repo, 'executable.sh'), 0o755);
  const result = capture(value.options);
  const manifest = verifyCapture(result.directory);
  assert.equal(fs.readFileSync(path.join(result.directory, 'workspace/new.txt'), 'utf8'), 'untracked bytes');
  assert.equal(fs.existsSync(path.join(result.directory, 'workspace/ignored.txt')), false);
  assert.equal(manifest.files.find((entry) => entry.path === 'delete.txt').deleted, true);
  assert.equal(manifest.files.find((entry) => entry.path === 'executable.sh').mode, 0o755);
  assert.deepEqual(fs.readFileSync(path.join(value.repo, '.git/index')), originalIndex);
  assert.equal(manifest.eligibility, 'pending-independent-oracle');
  assert.equal(manifest.dataPolicy, 'local-private');
  assert.equal(status(value.output).realCaptured, 0);
});

test('unstable worktree is excluded, retained and not silently retried', (context) => {
  const value = fixture(context);
  assert.throws(() => capture({ ...value.options, beforeVerify: () => fs.writeFileSync(path.join(value.repo, 'index.cjs'), 'changed concurrently') }), /UNSTABLE_WORKTREE/);
  const receipts = fs.readFileSync(path.join(value.output, 'intake.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'excluded');
});

test('symlinks, secret-like paths and nonignored output are rejected', (context) => {
  const value = fixture(context);
  fs.symlinkSync('/etc/passwd', path.join(value.repo, 'linked.txt'));
  assert.throws(() => capture(value.options), /SYMLINK_NOT_SUPPORTED/);
  fs.unlinkSync(path.join(value.repo, 'linked.txt'));
  fs.writeFileSync(path.join(value.repo, '.env'), 'SYNTHETIC_ONLY=1');
  assert.throws(() => capture(value.options), /SECRET_LIKE_PATH/);
  fs.unlinkSync(path.join(value.repo, '.env'));
  assert.throws(() => capture({ ...value.options, output: path.join(value.repo, 'not-ignored') }), /OUTPUT_MUST_BE_IGNORED/);
});

test('symlinked output cannot redirect private capture outside the repository', (context) => {
  const value = fixture(context);
  fs.symlinkSync(value.oracleDirectory, path.join(value.repo, 'output'));
  assert.throws(() => capture(value.options), /SYMLINK_NOT_SUPPORTED/);
  assert.deepEqual(fs.readdirSync(value.oracleDirectory), ['accept.cjs']);
});

test('manifest, source, context and oracle tampering are rejected', (context) => {
  const value = fixture(context);
  const result = capture({ ...value.options, contract: value.contract });
  const target = path.join(result.directory, 'workspace/index.cjs');
  const original = fs.readFileSync(target);
  fs.writeFileSync(target, 'tampered');
  assert.throws(() => verifyCapture(result.directory), /SNAPSHOT_CHANGED/);
  fs.writeFileSync(target, original);
  fs.appendFileSync(path.join(result.directory, 'history.jsonl'), '\n');
  assert.throws(() => verifyCapture(result.directory), /CONTEXT_CHANGED/);
  fs.writeFileSync(path.join(result.directory, 'history.jsonl'), history);
  fs.appendFileSync(path.join(result.directory, 'oracle/accept.cjs'), '\n');
  assert.throws(() => verifyCapture(result.directory), /ORACLE_CHANGED/);
  fs.appendFileSync(path.join(result.directory, 'manifest.json'), '\n');
  assert.throws(() => verifyCapture(result.directory), /MANIFEST_CHANGED/);
});

test('no oracle is pending, not a successful task or runnable model trial', async (context) => {
  const value = fixture(context);
  const result = capture(value.options);
  await assert.rejects(prepare(result.directory), /NO_FROZEN_INDEPENDENT_ORACLE/);
  const execution = spawnSync(process.execPath, [path.join(__dirname, 'cli.cjs'), 'run', result.directory], { encoding: 'utf8' });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /VERIFIED_DISCLOSURE_REQUIRED/);
  assert.equal(status(value.output).localInferenceAllowed, false);
  assert.equal(status(value.output).productivityEstablished, false);
});

test('oracle is frozen before work, requires provenance and cannot live in candidate repository', (context) => {
  const value = fixture(context);
  assert.throws(() => capture({ ...value.options, contract: { ...value.contract, provenance: 'ordinary-regression' } }), /ORACLE_PROVENANCE_REQUIRED/);
  assert.throws(() => capture({ ...value.options, contract: { ...value.contract, oracleDirectory: value.repo } }), /ORACLE_MUST_BE_EXTERNAL/);
  const result = capture({ ...value.options, contract: value.contract });
  fs.writeFileSync(path.join(value.oracleDirectory, 'accept.cjs'), 'changed after capture');
  assert.equal(verifyCapture(result.directory).oracle.provenance, 'independent-task-specific');
});

test('OMP hook captures before changes, ignores other repositories and preserves normal work on failure', async (context) => {
  const value = fixture(context);
  fs.mkdirSync(value.output, { recursive: true });
  fs.writeFileSync(path.join(value.output, 'config.json'), json({ enabled: true, infrastructureProbe: true }));
  const { registerCapture } = await import('./capture-extension.ts');
  const handlers = {};
  registerCapture({ on: (name, handler) => { handlers[name] = handler; } }, value.repo, value.output);
  const session = { cwd: value.repo, hasUI: false, sessionManager: {
    getBranch: () => history.trim().split('\n').map(JSON.parse), getSessionId: () => 'synthetic-hook-session',
  } };
  await handlers.before_agent_start({ prompt: value.prompt }, { ...session, cwd: value.temporary });
  assert.equal(status(value.output).infrastructureCaptures, 0);
  await handlers.before_agent_start({ prompt: value.prompt }, session);
  assert.equal(status(value.output).infrastructureCaptures, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(value.output, 'intake.jsonl'), 'utf8').trim());
  const captured = path.join(value.output, 'candidates', receipt.id);
  fs.writeFileSync(path.join(value.repo, 'index.cjs'), 'agent changes after before_agent_start');
  assert.equal(verifyCapture(captured).files.find((entry) => entry.path === 'index.cjs').hash, hash('module.exports = value => value - 1;\n'));
  await handlers.agent_end();
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.output, 'observations.jsonl'))).observation, 'original-agent-ended-not-task-acceptance');
  await handlers.before_agent_start({ prompt: value.prompt, images: [{}] }, session);
  assert.equal(status(value.output).excluded, 1);
  fs.unlinkSync(path.join(value.output, 'config.json'));
  fs.writeFileSync(path.join(value.output, 'config.json'), 'malformed');
  fs.unlinkSync(path.join(value.output, 'intake.jsonl'));
  fs.mkdirSync(path.join(value.output, 'intake.jsonl'));
  await assert.doesNotReject(handlers.before_agent_start({ prompt: value.prompt }, session));
});

test('Docker: three arms restore identical snapshots; checks and hidden acceptance are separate', { skip: !image }, async (context) => {
  const value = fixture(context);
  const captured = capture({ ...value.options, contract: value.contract });
  const result = await prepare(captured.directory);
  assert.equal(result.plan.order.length, 6);
  assert.equal(result.initial.passed, false);
  assert.equal(result.initial.infrastructureFailure, false);
  assert.ok(result.plan.supplements.mechanical.bytes <= result.plan.supplements.xray.bytes);
  for (const trial of result.plan.order) {
    const work = path.join(result.prepared, trial.id, 'workspace');
    assert.equal(hash(fs.readFileSync(path.join(work, 'index.cjs'))), captured.manifest.files.find((entry) => entry.path === 'index.cjs').hash);
    assert.equal(fs.existsSync(path.join(work, 'oracle')), false);
  }
  const id = result.plan.order[0].id;
  assert.throws(() => check(captured.directory, id, 'hidden'), /ENOENT/);
  assert.equal(check(captured.directory, id, 'public').passed, true);
  fs.writeFileSync(path.join(result.prepared, id, 'workspace/index.cjs'), 'module.exports = value => value + 1;\n');
  submit(captured.directory, id, 'done');
  fs.writeFileSync(path.join(result.prepared, id, 'workspace/index.cjs'), 'modified after submission');
  assert.equal(check(captured.directory, id, 'hidden').passed, true);
  assert.throws(() => check(captured.directory, id, 'hidden'), /HIDDEN_CHECK_ALREADY_RECORDED/);
  assert.throws(() => submit(captured.directory, id, 'done'), /ALREADY_SUBMITTED/);
  await assert.rejects(prepare(captured.directory), /ALREADY_PREPARED_NO_RETRY/);
  assert.equal(result.plan.modelTrials, 0);
});

test('Docker: no network, host credentials, oracle in public checks, or persistent public-test writes', { skip: !image }, (context) => {
  const value = fixture(context);
  process.env.AXR_SENTINEL_SECRET = 'must-not-enter-container';
  context.after(() => delete process.env.AXR_SENTINEL_SECRET);
  const code = 'const fs=require("node:fs"),assert=require("node:assert/strict");assert.equal(process.env.AXR_SENTINEL_SECRET,undefined);assert.equal(fs.existsSync("/oracle"),false);assert.equal(fs.existsSync("/var/run/docker.sock"),false);assert.ok(Object.keys(require("node:os").networkInterfaces()).every(name=>name==="lo"));assert.throws(()=>fs.writeFileSync("/root-write-denied","x"));fs.writeFileSync("/work/index.cjs","discarded");console.log("ISOLATION_PASS")';
  const original = fs.readFileSync(path.join(value.repo, 'index.cjs'));
  const result = isolatedCheck({ image, workspace: value.repo, command: ['node', '-e', code] });
  assert.equal(result.passed, true, result.stderr);
  assert.match(result.stdout, /ISOLATION_PASS/);
  assert.deepEqual(fs.readFileSync(path.join(value.repo, 'index.cjs')), original);
});

test('Docker: changes to test files are refused before submission', { skip: !image }, async (context) => {
  const value = fixture(context);
  const captured = capture({ ...value.options, contract: value.contract });
  const result = await prepare(captured.directory);
  const id = result.plan.order[0].id;
  fs.writeFileSync(path.join(result.prepared, id, 'workspace/public.cjs'), 'process.exit(0)');
  assert.throws(() => submit(captured.directory, id, 'done'), /NON_WRITABLE_CHANGE/);
});

test('Docker: timed-out candidate does not leave a running check container', { skip: !image }, (context) => {
  const value = fixture(context);
  const containerLabel = `axr-timeout-${hash(value.repo).slice(0, 16)}`;
  const result = isolatedCheck({ image, workspace: value.repo, command: ['node', '-e', 'while(true){}'], timeoutMs: 1000, containerLabel });
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  const running = spawnSync('docker', ['ps', '--filter', `label=agentxray.trial=${containerLabel}`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  assert.equal(running.stdout.trim(), '');
});
