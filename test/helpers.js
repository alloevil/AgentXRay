// Test harness: boots an isolated AgentXRay server against a throwaway copy of
// test/fixtures/home. Every data dir (and HOME itself, for the ~/.agentxray and
// ~/.claude.json reads) points into the copy, so tests never touch real user
// data and mutating tests never dirty the checked-in fixtures.

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'home');

function randomPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeTmpHome() {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentxray-test-'));
  await fsp.cp(FIXTURE_HOME, tmpHome, { recursive: true });
  return tmpHome;
}

function serverEnv(home, port) {
  return {
    ...process.env,
    HOME: home,
    PORT: String(port),
    HOST: '127.0.0.1',
    OPENCLAW_DIR: path.join(home, '.openclaw', 'agents'),
    CODEX_DIR: path.join(home, '.codex', 'sessions'),
    CLAUDE_CODE_DIR: path.join(home, '.claude', 'projects'),
    OMP_DIR: path.join(home, '.omp', 'agent', 'sessions'),
    HERMES_DIR: path.join(home, '.hermes'),
    DSH_DIR: path.join(home, '.dsh', 'sessions'),
    AGENTXRAY_LIBRARY_DIR: path.join(home, '.agentxray', 'library'),
    AGENTXRAY_ARCHIVE_DIR: path.join(home, '.agentxray', 'archive'),
  };
}

// Spawn `node server.js` on one candidate port; resolve with the child once
// /api/version answers, reject if the child dies first (e.g. EADDRINUSE).
async function spawnOnce(home, port) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    env: serverEnv(home, port),
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before ready (port ${port}): ${stderr.trim()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) {
        await res.json();
        return child;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(60);
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on port ${port}: ${stderr.trim()}`);
}

// Starts a hermetic server instance. Returns { base, home, stop }.
async function startServer() {
  const home = await makeTmpHome();
  let child = null;
  let lastError = null;
  let port = 0;
  for (let attempt = 0; attempt < 3 && !child; attempt++) {
    port = randomPort();
    try {
      child = await spawnOnce(home, port);
    } catch (error) {
      lastError = error;
    }
  }
  if (!child) {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    throw lastError || new Error('failed to start server');
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000).then(() => child.kill('SIGKILL'))]);
    }
    // Give any fire-and-forget git commit in the library repo a beat to settle
    await sleep(100);
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  return { base: `http://127.0.0.1:${port}`, home, stop };
}

// fetch + JSON with status assertion baked in
async function getJson(base, pathname, expectedStatus = 200) {
  const res = await fetch(base + pathname);
  if (res.status !== expectedStatus) {
    throw new Error(`GET ${pathname} -> ${res.status} (expected ${expectedStatus}): ${await res.text()}`);
  }
  return res.json();
}

async function sendJson(base, method, pathname, body, expectedStatus = 200) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status !== expectedStatus) {
    throw new Error(`${method} ${pathname} -> ${res.status} (expected ${expectedStatus}): ${await res.text()}`);
  }
  return res.json();
}

module.exports = { startServer, getJson, sendJson, FIXTURE_HOME };
