const fsp = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  resolveDir,
  isArchivedFile,
  readAgents,
} = require('../config');
const {
  codexSessionIdFromFile,
  findCodexSessionFile,
  listCodexSessions,
  normalizeCodexRecord,
  parseCodexSessionFile,
} = require('./codex');
const {
  findClaudeCodeSessionFile,
  listClaudeCodeSessions,
  normalizeClaudeCodeRecord,
  parseClaudeCodeSessionFile,
} = require('./claude');
const {
  ompSessionIdFromFile,
  findOmpSessionFile,
  listOmpSessions,
  normalizeOmpRecord,
  parseOmpSessionFile,
} = require('./omp');
const { findDshSessionFile, listDshSessions, normalizeDshEvents, parseDshSessionFile } = require('./dsh');
const {
  findGeminiSessionFile,
  readGeminiMetadataLine,
  listGeminiSessions,
  normalizeGeminiRecord,
  parseGeminiSessionFile,
} = require('./gemini');
const { listHermesSessions, getHermesSession } = require('./hermes');
const { listSessionsForAgent, resolveSessionFile, normalizeMessage, parseSessionFile } = require('./openclaw');

// --- The platform registry: single source of platform truth ---
// Adding a platform = write one adapter file in lib/platforms/ + register it
// here. Every generic surface (session routes, search, watch, insights,
// prompts, tool audit, OTLP and Markdown/HTML export) resolves platforms
// through this table.
//
// Entry shape:
//   id            registry key, used in URLs (/api/<id>/sessions)
//   label         human-readable name (boot log)
//   defaultDir()  platform's session root (env-overridable via lib/config)
//   list(dir)                       → session summaries, newest first
//   find(dir, sessionId, opts?)     → session file path | null (null entry: not file-based)
//   parse(filePath)                 → { session, messages } (normalized)
//   getSession(dir, sessionId, opts?) → { session, messages } | null
//   collectFiles(dir, opts?)        → [{ path, file, sessionId, agent? }] for bulk scans
//   watchParse(rec, line)           → { messages?, session? } | null for the SSE tail
//   needsAgent    true when find/getSession require opts.agent (openclaw)

function fileBasedGetSession(find, parse) {
  return async (dir, sessionId, opts = {}) => {
    const filePath = await find(dir, sessionId, opts);
    return filePath ? parse(filePath) : null;
  };
}

const PLATFORMS = {
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    needsAgent: true,
    defaultDir: () => DATA_DIR,
    list: null, // per-agent listing: listSessionsForAgent(dir, agent) via /api/agents/:name/sessions
    find: (dir, sessionId, opts = {}) => (opts.agent ? resolveSessionFile(dir, opts.agent, sessionId) : null),
    parse: parseSessionFile,
    getSession: async (dir, sessionId, opts = {}) => {
      if (!opts.agent) return null;
      const filePath = await resolveSessionFile(dir, opts.agent, sessionId);
      return filePath ? parseSessionFile(filePath) : null;
    },
    collectFiles: async (dir, opts = {}) => {
      const files = [];
      const agents = opts.agent ? [opts.agent] : await readAgents(dir).catch(() => []);
      for (const agent of agents) {
        const agentDir = path.join(dir, agent, 'sessions');
        let entries;
        try {
          entries = await fsp.readdir(agentDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl') && !isArchivedFile(e.name)) {
            files.push({
              path: path.join(agentDir, e.name),
              file: e.name,
              sessionId: e.name.replace(/\.jsonl$/, ''),
              agent,
            });
          }
        }
      }
      return files;
    },
    watchParse: (rec) => {
      if (rec.type === 'session') return { session: { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp } };
      if (rec.type === 'message') return { messages: [normalizeMessage(rec)] };
      return null;
    },
  },

  codex: {
    id: 'codex',
    label: 'Codex',
    defaultDir: () => CODEX_DIR,
    list: listCodexSessions,
    find: findCodexSessionFile,
    parse: parseCodexSessionFile,
    getSession: fileBasedGetSession(findCodexSessionFile, parseCodexSessionFile),
    collectFiles: async (dir) => {
      const files = [];
      // Codex sessions live at <dir>/YYYY/MM/DD/rollout-*.jsonl
      const years = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const y of years) {
        if (!y.isDirectory()) continue;
        const months = await fsp.readdir(path.join(dir, y.name), { withFileTypes: true }).catch(() => []);
        for (const m of months) {
          if (!m.isDirectory()) continue;
          const days = await fsp.readdir(path.join(dir, y.name, m.name), { withFileTypes: true }).catch(() => []);
          for (const d of days) {
            if (!d.isDirectory()) continue;
            const dirPath = path.join(dir, y.name, m.name, d.name);
            const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
            for (const f of entries) {
              if (f.isFile() && f.name.endsWith('.jsonl')) {
                // Session ids are the trailing UUID, not the full rollout-* stem
                const uuid = f.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
                files.push({
                  path: path.join(dirPath, f.name),
                  file: f.name,
                  sessionId: uuid ? uuid[1] : codexSessionIdFromFile(f.name),
                });
              }
            }
          }
        }
      }
      return files;
    },
    watchParse: (rec) => {
      const normalized = normalizeCodexRecord(rec);
      return normalized ? { messages: [normalized] } : null;
    },
  },

  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    defaultDir: () => CLAUDE_CODE_DIR,
    list: listClaudeCodeSessions,
    find: findClaudeCodeSessionFile,
    parse: parseClaudeCodeSessionFile,
    getSession: fileBasedGetSession(findClaudeCodeSessionFile, parseClaudeCodeSessionFile),
    collectFiles: async (dir, opts = {}) => {
      const files = [];
      // Claude Code sessions live at <dir>/<project-slug>/*.jsonl
      const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const projDir = path.join(dir, p.name);
        const entries = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
        for (const f of entries) {
          if (f.isFile() && f.name.endsWith('.jsonl')) {
            files.push({ path: path.join(projDir, f.name), file: f.name, sessionId: f.name.replace(/\.jsonl$/, '') });
          }
        }
        if (opts.subagents === false) continue;
        const subDir = path.join(projDir, 'subagents');
        const subEntries = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
        for (const f of subEntries) {
          if (f.isFile() && f.name.endsWith('.jsonl')) {
            files.push({ path: path.join(subDir, f.name), file: f.name, sessionId: f.name.replace(/\.jsonl$/, '') });
          }
        }
      }
      return files;
    },
    watchParse: (rec) => {
      const normalized = normalizeClaudeCodeRecord(rec);
      return normalized ? { messages: [normalized] } : null;
    },
  },

  omp: {
    id: 'omp',
    label: 'OMP',
    defaultDir: () => OMP_DIR,
    list: listOmpSessions,
    find: findOmpSessionFile,
    parse: parseOmpSessionFile,
    getSession: fileBasedGetSession(findOmpSessionFile, parseOmpSessionFile),
    collectFiles: async (dir) => {
      const files = [];
      const slugs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const s of slugs) {
        if (!s.isDirectory()) continue;
        const slugDir = path.join(dir, s.name);
        const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
        for (const f of entries) {
          if (f.isFile() && f.name.endsWith('.jsonl')) {
            files.push({ path: path.join(slugDir, f.name), file: f.name, sessionId: ompSessionIdFromFile(f.name) });
          }
        }
      }
      return files;
    },
    watchParse: (rec) => {
      if (rec.type === 'session') return { session: { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp } };
      const normalized = normalizeOmpRecord(rec);
      return normalized && normalized.length ? { messages: normalized } : null;
    },
  },

  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    defaultDir: () => DSH_DIR,
    list: listDshSessions,
    find: findDshSessionFile,
    parse: parseDshSessionFile,
    getSession: fileBasedGetSession(findDshSessionFile, parseDshSessionFile),
    collectFiles: async (dir) => {
      const files = [];
      // dsh sessions live at <dir>/<projectKey>/<sessionId>/session.jsonl[.zstd]
      const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const projDir = path.join(dir, p.name);
        const sessionDirs = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
        for (const s of sessionDirs) {
          if (!s.isDirectory()) continue;
          const sessionDir = path.join(projDir, s.name);
          const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
          const logFile = entries.find(
            (f) => f.isFile() && (f.name === 'session.jsonl.zstd' || f.name === 'session.jsonl')
          );
          if (logFile) files.push({ path: path.join(sessionDir, logFile.name), file: logFile.name, sessionId: s.name });
        }
      }
      return files;
    },
    watchParse: (rec, line) => {
      if (rec.type === 'session') {
        return {
          session: {
            id: rec.id,
            cwd: rec.cwd || null,
            timestamp: typeof rec.createdAt === 'number' ? new Date(rec.createdAt).toISOString() : null,
          },
        };
      }
      const normalized = normalizeDshEvents([line]);
      return normalized.length ? { messages: normalized } : null;
    },
  },

  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    defaultDir: () => GEMINI_DIR,
    list: listGeminiSessions,
    find: findGeminiSessionFile,
    parse: parseGeminiSessionFile,
    getSession: fileBasedGetSession(findGeminiSessionFile, parseGeminiSessionFile),
    collectFiles: async (dir, opts = {}) => {
      const files = [];
      // gemini sessions live at <dir>/<projectHash>/chats/session-*.jsonl
      const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const chatsDir = path.join(dir, p.name, 'chats');
        const entries = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
        for (const f of entries) {
          if (f.isFile() && /^session-.*\.jsonl$/.test(f.name)) {
            const filePath = path.join(chatsDir, f.name);
            const stem = f.name.replace(/\.jsonl$/, '');
            let sessionId = stem;
            if (opts.resolveIds !== false) {
              const meta = await readGeminiMetadataLine(filePath);
              sessionId = (meta && meta.sessionId) || stem;
            }
            files.push({ path: filePath, file: f.name, sessionId });
          }
        }
      }
      return files;
    },
    watchParse: (rec) => {
      // Appended records carry an id; a re-appended id supersedes the
      // earlier one, which the client-side reload handles. Metadata lines
      // ({sessionId, …}) and $set/$rewindTo folds carry no new messages.
      if (typeof rec.id === 'string') {
        const normalized = normalizeGeminiRecord(rec);
        return normalized.length ? { messages: normalized } : null;
      }
      if (typeof rec.sessionId === 'string') {
        return { session: { id: rec.sessionId, cwd: null, timestamp: rec.startTime || null } };
      }
      return null;
    },
  },

  hermes: {
    id: 'hermes',
    label: 'Hermes',
    defaultDir: () => HERMES_DIR,
    // SQLite-backed: no session files to find/collect/tail; the watch route
    // has a dedicated WAL-watch branch.
    list: (dir) => listHermesSessions(dir),
    find: null,
    parse: null,
    getSession: (dir, sessionId) => getHermesSession(dir, sessionId),
    collectFiles: null,
    watchParse: null,
  },
};

// Collect all session file paths for a platform, resolving the dir override.
// Non-file platforms (hermes) yield [].
async function collectSessionFiles(platform, agentName, dirOverride, opts = {}) {
  const p = PLATFORMS[platform];
  if (!p || !p.collectFiles) return [];
  const dir = resolveDir(dirOverride, p.defaultDir());
  return p.collectFiles(dir, { agent: agentName || '', ...opts });
}

module.exports = {
  PLATFORMS,
  collectSessionFiles,
};
