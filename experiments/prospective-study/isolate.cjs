const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fail } = require('./capture.cjs');

function imageMetadata(image) {
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) fail('PINNED_IMAGE_REQUIRED');
  const result = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) fail('IMAGE_NOT_AVAILABLE');
  const details = JSON.parse(result.stdout)[0];
  if (details.Id !== image) fail('IMAGE_ID_MISMATCH');
  return { id: details.Id, os: details.Os, architecture: details.Architecture, digests: details.RepoDigests || [] };
}

function isolatedCheck({ image, workspace, oracle, command, timeoutMs = 30000, containerLabel, scratchRoot }) {
  imageMetadata(image);
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) fail('INVALID_COMMAND');
  const temporary = fs.mkdtempSync(path.join(scratchRoot || os.tmpdir(), 'axr-private-check-'));
  const work = path.join(temporary, 'work');
  const hidden = path.join(temporary, 'oracle');
  const name = `axr-check-${randomUUID()}`;
  const started = performance.now();
  try {
    fs.cpSync(workspace, work, { recursive: true, dereference: false });
    if (oracle) fs.cpSync(oracle, hidden, { recursive: true, dereference: false });
    const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--cpus=1',
      '--user', `${process.getuid()}:${process.getgid()}`, '--workdir=/work',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=bind,src=${work},dst=/work`,
      '--env', 'HOME=/tmp', '--env', 'TZ=UTC'];
    if (oracle) args.push('--mount', `type=bind,src=${hidden},dst=/oracle,readonly`);
    if (containerLabel) {
      if (!/^axr-[a-z0-9-]+$/.test(containerLabel)) fail('INVALID_CONTAINER_LABEL');
      args.push('--label', `agentxray.trial=${containerLabel}`);
    }
    args.push('--entrypoint', command[0], image, ...command.slice(1));
    const execution = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    const timedOut = execution.error?.code === 'ETIMEDOUT';
    return { passed: execution.status === 0 && !execution.error, code: execution.status, timedOut,
      runnerError: execution.error?.code || null, infrastructureFailure: !!execution.error || [125, 126, 127].includes(execution.status),
      elapsedMs: performance.now() - started, stdout: execution.stdout || '', stderr: execution.stderr || '',
      isolation: { image, network: 'none', root: 'read-only', disposableWorkspace: true, hiddenMounted: !!oracle } };
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 10000 });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { imageMetadata, isolatedCheck };
