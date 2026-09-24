const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function git(repo, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: MAX_FILE, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0) fail('GIT_READ_FAILED');
  return result.stdout;
}

function safeRelative(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\\') || file.includes('\0') ||
    file.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) fail('UNSAFE_PATH');
  if (file.split('/').some((part) => /^(\.env(?:\..*)?|id_(rsa|ed25519)|credentials(?:\..*)?)$|\.(pem|key|p12)$/i.test(part))) fail('SECRET_LIKE_PATH');
  return file;
}

function readRegular(root, file) {
  safeRelative(file);
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('SYMLINK_NOT_SUPPORTED');
  }
  const descriptor = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_FILE) fail('FILE_LIMIT_OR_TYPE');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('UNSTABLE_FILE');
    return { bytes, mode: before.mode & 0o111 ? 0o755 : 0o644 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function inventory(repo) {
  const stages = git(repo, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  if (stages.some((entry) => !/^(100644|100755) [0-9a-f]+ 0\t/.test(entry))) fail('GIT_SPECIAL_ENTRY');
  const names = [...new Set(git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  if (names.length > 4096) fail('FILE_COUNT_LIMIT');
  const entries = [];
  let size = 0;
  for (const name of names) {
    safeRelative(name);
    let value;
    try { value = readRegular(repo, name); } catch (error) {
      if (error.code === 'ENOENT') { entries.push({ path: name, deleted: true }); continue; }
      throw error;
    }
    size += value.bytes.length;
    if (size > MAX_TOTAL) fail('TOTAL_SIZE_LIMIT');
    entries.push({ path: name, hash: hash(value.bytes), bytes: value.bytes.length, mode: value.mode, content: value.bytes });
  }
  return entries;
}

function metadata(entries) {
  return entries.map(({ content, ...entry }) => entry);
}

function directoryFiles(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelative(name);
    if (entry.isSymbolicLink()) fail('SYMLINK_NOT_SUPPORTED');
    return entry.isDirectory() ? directoryFiles(root, name) : [name];
  }).sort();
}

function readOracle(contract, repo) {
  if (!contract) return null;
  if (contract.provenance !== 'independent-task-specific') fail('ORACLE_PROVENANCE_REQUIRED');
  if (!/^sha256:[0-9a-f]{64}$/.test(contract.image)) fail('PINNED_IMAGE_REQUIRED');
  for (const command of [contract.publicCommand, contract.hiddenCommand]) {
    if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) fail('INVALID_COMMAND');
  }
  if (!Array.isArray(contract.writable) || !contract.writable.length || contract.writable.length > 256) fail('WRITABLE_PATHS_REQUIRED');
  contract.writable.forEach(safeRelative);
  const root = fs.realpathSync(contract.oracleDirectory);
  if (root === repo || root.startsWith(`${repo}${path.sep}`)) fail('ORACLE_MUST_BE_EXTERNAL');
  const names = directoryFiles(root);
  if (!names.length || names.length > 256) fail('ORACLE_FILE_COUNT');
  const entries = names.map((name) => ({ path: name, ...readRegular(root, name) }));
  if (entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > MAX_FILE) fail('ORACLE_SIZE_LIMIT');
  const referenceFiles = contract.referenceFiles || [];
  if (!Array.isArray(referenceFiles) || referenceFiles.length > 256) fail('INVALID_REFERENCE');
  const destinations = new Set();
  for (const entry of referenceFiles) {
    safeRelative(entry.from); safeRelative(entry.to);
    if (!names.includes(entry.from) || !contract.writable.includes(entry.to) || destinations.has(entry.to)) fail('INVALID_REFERENCE');
    destinations.add(entry.to);
  }
  if (contract.expectedInitial !== undefined && !['pass', 'fail'].includes(contract.expectedInitial)) fail('INVALID_INITIAL_EXPECTATION');
  return { root, entries, contract: {
    provenance: contract.provenance, image: contract.image, publicCommand: contract.publicCommand,
    hiddenCommand: contract.hiddenCommand, writable: [...new Set(contract.writable)].sort(),
    referenceFiles, expectedInitial: contract.expectedInitial || null,
    oracleFiles: entries.map((entry) => ({ path: entry.path, hash: hash(entry.bytes), bytes: entry.bytes.length, mode: entry.mode })),
  } };
}

function writeFile(root, relative, bytes, mode = 0o600) {
  const file = path.join(root, safeRelative(relative));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode });
}

function capture({ repo, output, prompt, history, sessionId = '', origin = 'omp-before-agent-start', contract, beforeVerify }) {
  repo = fs.realpathSync(repo);
  output = path.resolve(output);
  if (git(repo, ['rev-parse', '--show-toplevel']).trim() !== repo) fail('REPOSITORY_ROOT_REQUIRED');
  if (output.startsWith(`${repo}${path.sep}`)) {
    let current = repo;
    for (const part of path.relative(repo, output).split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink()) fail('SYMLINK_NOT_SUPPORTED');
      if (!stat.isDirectory()) fail('OUTPUT_NOT_DIRECTORY');
    }
    const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '--quiet', '--no-index', output]);
    if (ignored.status !== 0) fail('OUTPUT_MUST_BE_IGNORED');
  } else fail('OUTPUT_MUST_BE_IN_REPOSITORY');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_FILE) fail('INVALID_PROMPT');
  if (typeof history !== 'string' || Buffer.byteLength(history) > MAX_FILE) fail('HISTORY_LIMIT');
  try { for (const line of history.split('\n').filter(Boolean)) JSON.parse(line); } catch { fail('INVALID_HISTORY'); }
  if (!['omp-before-agent-start', 'synthetic-smoke', 'infrastructure-check'].includes(origin)) fail('INVALID_ORIGIN');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const directory = path.join(output, 'candidates', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = performance.now();
  try {
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = inventory(repo);
    const oracle = readOracle(contract, repo);
    if (beforeVerify) beforeVerify();
    if (json(metadata(entries)) !== json(metadata(inventory(repo))) || head !== git(repo, ['rev-parse', 'HEAD']).trim() ||
      status !== git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) fail('UNSTABLE_WORKTREE');
    if (oracle && json(oracle.contract) !== json(readOracle(contract, repo).contract)) fail('UNSTABLE_ORACLE');
    for (const entry of entries) if (!entry.deleted) writeFile(directory, `workspace/${entry.path}`, entry.content, entry.mode);
    if (oracle) for (const entry of oracle.entries) writeFile(directory, `oracle/${entry.path}`, entry.bytes, entry.mode);
    writeFile(directory, 'prompt.txt', prompt);
    writeFile(directory, 'history.jsonl', history);
    const manifest = {
      schemaVersion: 1, id, capturedAt: new Date().toISOString(), origin, dataPolicy: 'local-private',
      repoHash: hash(repo), sessionHash: hash(sessionId), head, statusHash: hash(status),
      coverage: 'tracked plus nonignored untracked bytes; ignored files, dependencies and services excluded; two-pass consistency, not atomic filesystem snapshot',
      files: metadata(entries), promptHash: hash(prompt), historyHash: hash(history),
      oracle: oracle?.contract || null, eligibility: oracle ? 'frozen-oracle-needs-preflight' : 'pending-independent-oracle',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      captureMs: performance.now() - started,
    };
    writeFile(directory, 'manifest.json', json(manifest));
    writeFile(directory, 'manifest.sha256', hash(json(manifest)));
    fs.appendFileSync(path.join(output, 'intake.jsonl'), `${JSON.stringify({ id, at: manifest.capturedAt, origin, state: manifest.eligibility, manifestHash: hash(json(manifest)) })}\n`, { mode: 0o600 });
    return { directory, manifest };
  } catch (error) {
    const reason = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'CAPTURE_FAILED';
    writeFile(directory, 'failure.json', json({ id, origin, reason }));
    fs.appendFileSync(path.join(output, 'intake.jsonl'), `${JSON.stringify({ id, origin, state: 'excluded', reason })}\n`, { mode: 0o600 });
    error.receipted = true;
    throw error;
  }
}

function verifyCapture(directory) {
  const bytes = fs.readFileSync(path.join(directory, 'manifest.json'));
  if (hash(bytes) !== fs.readFileSync(path.join(directory, 'manifest.sha256'), 'utf8')) fail('MANIFEST_CHANGED');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.dataPolicy !== 'local-private') fail('INVALID_CAPTURE_SCHEMA');
  const expected = [];
  for (const entry of manifest.files) {
    safeRelative(entry.path);
    if (entry.deleted) {
      if (fs.existsSync(path.join(directory, 'workspace', entry.path))) fail('SNAPSHOT_CHANGED');
      continue;
    }
    const value = readRegular(path.join(directory, 'workspace'), entry.path);
    if (hash(value.bytes) !== entry.hash || value.mode !== entry.mode) fail('SNAPSHOT_CHANGED');
    expected.push(entry.path);
  }
  if (json(expected.sort()) !== json(directoryFiles(path.join(directory, 'workspace')))) fail('SNAPSHOT_CHANGED');
  for (const [name, expectedHash] of [['prompt.txt', manifest.promptHash], ['history.jsonl', manifest.historyHash]]) {
    if (hash(readRegular(directory, name).bytes) !== expectedHash) fail('CONTEXT_CHANGED');
  }
  if (manifest.oracle) {
    for (const entry of manifest.oracle.oracleFiles) {
      const value = readRegular(path.join(directory, 'oracle'), entry.path);
      if (hash(value.bytes) !== entry.hash || value.mode !== entry.mode) fail('ORACLE_CHANGED');
    }
    if (json(manifest.oracle.oracleFiles.map((entry) => entry.path).sort()) !== json(directoryFiles(path.join(directory, 'oracle')))) fail('ORACLE_CHANGED');
  }
  return manifest;
}

module.exports = { capture, verifyCapture, safeRelative, readRegular, directoryFiles, hash, json, fail, writeFile };
