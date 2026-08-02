const path = require('path');
const fsp = require('fs/promises');

const HOME = process.env.HOME || '/root';
const DATA_DIR = process.env.OPENCLAW_DIR || path.join(HOME, '.openclaw', 'agents');
const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex', 'sessions');
const CLAUDE_CODE_DIR = process.env.CLAUDE_CODE_DIR || path.join(HOME, '.claude', 'projects');
const HERMES_DIR = process.env.HERMES_DIR || path.join(HOME, '.hermes');
const OMP_DIR = process.env.OMP_DIR || path.join(HOME, '.omp', 'agent', 'sessions');
// Persisted analysis results live here (prompt analysis + tool audit)
const ANALYSIS_DIR = path.join(HOME, '.agentxray', 'analysis');
const LIBRARY_DIR = process.env.AGENTXRAY_LIBRARY_DIR || path.join(HOME, '.agentxray', 'library');
const ARCHIVE_DIR = process.env.AGENTXRAY_ARCHIVE_DIR || path.join(HOME, '.agentxray', 'archive');

const SESSION_ID_RE = /^[0-9a-zA-Z._:-]+$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// ========= Session Metadata Cache =========
// Key: absolute file path  →  { mtime: number, data: sessionMetadataObject }
const sessionMetaCache = new Map();

function resolveDir(queryDir, defaultDir) {
  if (!queryDir || typeof queryDir !== 'string') return defaultDir;
  if (!path.isAbsolute(queryDir)) return defaultDir;
  if (queryDir.includes('..')) return defaultDir;
  return queryDir;
}

function isArchivedFile(fileName) {
  return fileName.includes('.jsonl.reset.') || fileName.includes('.jsonl.deleted.');
}

function isSessionLogFile(fileName) {
  return fileName.endsWith('.jsonl') || isArchivedFile(fileName);
}

function sanitizeAgentName(name) {
  return AGENT_NAME_RE.test(name) ? name : null;
}

function sanitizeSessionId(id) {
  return SESSION_ID_RE.test(id) ? id : null;
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
