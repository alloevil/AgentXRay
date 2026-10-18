const path = require('path');
const fsp = require('fs/promises');
const { resolveAllowedDir } = require('./safe-path');

const HOME = process.env.HOME || '/root';
const DATA_DIR = process.env.OPENCLAW_DIR || path.join(HOME, '.openclaw', 'agents');
const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex', 'sessions');
const CLAUDE_CODE_DIR = process.env.CLAUDE_CODE_DIR || path.join(HOME, '.claude', 'projects');
const HERMES_DIR = process.env.HERMES_DIR || path.join(HOME, '.hermes');
const OMP_DIR = process.env.OMP_DIR || path.join(HOME, '.omp', 'agent', 'sessions');
// dsh itself resolves its home via DSH_HOME; honor both, DSH_DIR wins.
const DSH_DIR =
  process.env.DSH_DIR ||
  (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : path.join(HOME, '.dsh', 'sessions'));
// Gemini CLI project temp dirs: <GEMINI_DIR>/<projectHash>/chats/session-*.jsonl
const GEMINI_DIR = process.env.GEMINI_DIR || path.join(HOME, '.gemini', 'tmp');
// Persisted analysis results live here (prompt analysis + tool audit)
const ANALYSIS_DIR = path.join(HOME, '.agentxray', 'analysis');
const LIBRARY_DIR = process.env.AGENTXRAY_LIBRARY_DIR || path.join(HOME, '.agentxray', 'library');
const ARCHIVE_DIR = process.env.AGENTXRAY_ARCHIVE_DIR || path.join(HOME, '.agentxray', 'archive');

const SESSION_ID_RE = /^[0-9a-zA-Z._:-]+$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// ========= Session Metadata Cache =========
// Key: absolute file path  →  { mtime: number, data: sessionMetadataObject }
const sessionMetaCache = new Map();

// Directory override from a request (?dir= and friends). No override → the
// default. Otherwise it must be an absolute path whose realpath lies inside an
// allowed root (lib/safe-path.js); anything else throws PathEscapeError (403)
// instead of silently reading another directory.
function resolveDir(queryDir, defaultDir) {
  if (queryDir === undefined || queryDir === null || queryDir === '') return defaultDir;
  return resolveAllowedDir(queryDir, [
    HOME,
    DATA_DIR,
    CODEX_DIR,
    CLAUDE_CODE_DIR,
    HERMES_DIR,
    OMP_DIR,
    DSH_DIR,
    GEMINI_DIR,
    ANALYSIS_DIR,
    LIBRARY_DIR,
    ARCHIVE_DIR,
  ]);
}

function isArchivedFile(fileName) {
  return fileName.includes('.jsonl.reset.') || fileName.includes('.jsonl.deleted.');
}

function isSessionLogFile(fileName) {
  return fileName.endsWith('.jsonl') || isArchivedFile(fileName);
}

// Both character sets allow '.', so a name made only of dots ('.', '..') would
// pass the regex and address the parent directory once joined; reject those.
const DOTS_ONLY_RE = /^\.+$/;

function sanitizeAgentName(name) {
  return typeof name === 'string' && AGENT_NAME_RE.test(name) && !DOTS_ONLY_RE.test(name) ? name : null;
}

function sanitizeSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !DOTS_ONLY_RE.test(id) ? id : null;
}

async function ensureDirectory(dirPath) {
  const stat = await fsp.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

async function readAgents(baseDir) {
  const dir = baseDir || DATA_DIR;
  await ensureDirectory(dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = {
  HOME,
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  ANALYSIS_DIR,
  LIBRARY_DIR,
  ARCHIVE_DIR,
  SESSION_ID_RE,
  AGENT_NAME_RE,
  sessionMetaCache,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  sanitizeAgentName,
  sanitizeSessionId,
  ensureDirectory,
  readAgents,
};
