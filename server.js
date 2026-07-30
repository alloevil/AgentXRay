const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3800;
const HOST = process.env.HOST || '0.0.0.0';
const HOME = process.env.HOME || '/root';
const DATA_DIR = process.env.OPENCLAW_DIR || path.join(HOME, '.openclaw', 'agents');

// ========= Session Metadata Cache =========
// Key: absolute file path  →  { mtime: number, data: sessionMetadataObject }
const sessionMetaCache = new Map();
const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex', 'sessions');
const CLAUDE_CODE_DIR = process.env.CLAUDE_CODE_DIR || path.join(HOME, '.claude', 'projects');
const HERMES_DIR = process.env.HERMES_DIR || path.join(HOME, '.hermes');
const OMP_DIR = process.env.OMP_DIR || path.join(HOME, '.omp', 'agent', 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_ID_RE = /^[0-9a-zA-Z._:-]+$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

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

function stripOpenClawNoise(text) {
  let texts = text;
  // Strip all System: lines
  texts = texts.replace(/^System:.*\n?/gm, '');
  // Strip metadata blocks: any block ending with ```json...```
  texts = texts.replace(/^[A-Za-z ]+\([^)]*\):\n```[\s\S]*?```\n?/gm, '');
  // Strip [message_id: ...] lines
  texts = texts.replace(/^\[message_id:[^\]]*\].*\n?/gm, '');
  // Strip ou_xxx: sender prefix from quoted message lines
  texts = texts.replace(/^ou_[a-z0-9]+:\s*/gm, '');
  // Strip subagent context injection
  texts = texts.replace(/^\[.*?\] \[Subagent Context\][\s\S]*/m, '');
  // Strip bare timestamp+channel prefix lines
  texts = texts.replace(/^\[\w{3} \d{4}-\d{2}-\d{2}[^\]]*\][^\n]*\n?/gm, '');
  // Strip heartbeat lines
  texts = texts.replace(/^HEARTBEAT_OK.*\n?/gm, '');
  return texts.trim();
}

async function parseSessionMetadata(filePath, fileName) {
  // Check mtime cache first
  try {
    const stat = await fsp.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = sessionMetaCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.data;
    }
  } catch {
    // If stat fails, fall through to parse
  }

  const data = await _parseSessionMetadataRaw(filePath, fileName);

  // Update cache
  try {
    const stat = await fsp.stat(filePath);
    sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
  } catch {
    // Non-critical — just skip caching
  }

  return data;
}

async function _parseSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let spawnCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const toolNames = {};
  const modelCounts = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        continue;
      }
      if (!session && record.type === 'session') {
        session = {
          id: record.id || fileName.split('.jsonl')[0],
          timestamp: record.timestamp || null
        };
      }
      if (record.type === 'message') {
        messageCount += 1;
        const msg = record.message || {};
        const role = msg.role;
        const content = Array.isArray(msg.content) ? msg.content : [];

        if (role === 'user') {
          userCount++;
          if (!firstUserMessage) {
            const texts = stripOpenClawNoise(content.filter(c => c.type === 'text').map(c => c.text || '').join(' ').trim());
            if (texts) firstUserMessage = texts.slice(0, 120);
          }
        }
        if (role === 'assistant') assistantCount++;
        if (role === 'toolResult') toolResultCount++;

        // Count tool calls and spawn calls within assistant messages
        for (const c of content) {
          if (c.type === 'toolCall') {
            toolCallCount++;
            const name = c.name || 'unknown';
            toolNames[name] = (toolNames[name] || 0) + 1;

            // Detect spawn
            if (name === 'sessions_spawn') {
              spawnCount++;
            } else if (name === 'exec') {
              const cmd = ((c.arguments || {}).command || '').toLowerCase();
              if (cmd.includes('codex ') || cmd.includes('claude ')) {
                spawnCount++;
              }
            }
          }
        }

        if (record.timestamp) lastTimestamp = record.timestamp;

        // Track model usage
        const msgModel = msg.model;
        if (msgModel && msgModel !== 'delivery-mirror') {
          modelCounts[msgModel] = (modelCounts[msgModel] || 0) + 1;
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Top 5 most used tools
  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Most common model (skip delivery-mirror)
  const model = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    id: session?.id || fileName.split('.jsonl')[0],
    timestamp: session?.timestamp || null,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    spawnCount,
    topTools,
    model,
    firstUserMessage: firstUserMessage || null,
    status: isArchivedFile(fileName) ? 'archived' : 'active',
    file: fileName
  };
}

async function listSessionsForAgent(baseDir, agentName, includeArchived) {
  const dir = baseDir || DATA_DIR;
  const agentDir = path.join(dir, agentName, 'sessions');
  await ensureDirectory(agentDir);
  const entries = await fsp.readdir(agentDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && isSessionLogFile(entry.name))
    .filter((entry) => includeArchived || !isArchivedFile(entry.name))
    .map((entry) => entry.name);

  const sessions = await Promise.all(
    sessionFiles.map((fileName) => parseSessionMetadata(path.join(agentDir, fileName), fileName))
  );

  sessions.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });

  return sessions;
}

async function resolveSessionFile(baseDir, agentName, sessionId) {
  const dir = baseDir || DATA_DIR;
  const agentDir = path.join(dir, agentName, 'sessions');
  await ensureDirectory(agentDir);
  const entries = await fsp.readdir(agentDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && isSessionLogFile(entry.name))
    .map((entry) => entry.name)
    .filter((fileName) => fileName === `${sessionId}.jsonl` || fileName.startsWith(`${sessionId}.jsonl.`))
    .sort((a, b) => {
      if (a === `${sessionId}.jsonl`) {
        return -1;
      }
      if (b === `${sessionId}.jsonl`) {
        return 1;
      }
      return b.localeCompare(a);
    });

  if (candidates.length === 0) {
    return null;
  }

  return path.join(agentDir, candidates[0]);
}

function normalizeMessage(record) {
  const message = record.message || {};
  return {
    id: record.id || null,
    timestamp: record.timestamp || message.timestamp || null,
    role: message.role || null,
    content: Array.isArray(message.content) ? message.content : [],
    usage: message.usage || null,
    model: message.model || null,
    provider: message.provider || null,
    toolCallId: message.toolCallId || null,
    toolName: message.toolName || null,
    details: message.details || null,
    isError: Boolean(message.isError)
  };
}

async function parseSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        continue;
      }
      if (record.type === 'session') {
        session = {
          id: record.id || null,
          cwd: record.cwd || null,
          timestamp: record.timestamp || null,
          version: record.version || null
        };
      } else if (record.type === 'message') {
        messages.push(normalizeMessage(record));
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { session, messages };
}

// ========= Insights: aggregate analytics across sessions =========
const insightsCache = new Map(); // key → { expires: number, data: object }
const INSIGHTS_TTL_MS = 60_000;

function getInsightsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

// Collect all JSONL session file paths for a given platform
async function collectSessionFiles(platform, agentName, dirOverride) {
  const files = []; // { path, sessionId }

  if (platform === 'openclaw') {
    const dir = resolveDir(dirOverride, DATA_DIR);
    const agents = agentName ? [agentName] : await readAgents(dir).catch(() => []);
    for (const agent of agents) {
      const agentDir = path.join(dir, agent, 'sessions');
      let entries;
      try { entries = await fsp.readdir(agentDir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl') && !isArchivedFile(e.name)) {
          files.push({ path: path.join(agentDir, e.name), sessionId: e.name.replace(/\.jsonl$/, '') });
        }
      }
    }
  } else if (platform === 'codex') {
    const dir = resolveDir(dirOverride, CODEX_DIR);
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
              files.push({ path: path.join(dirPath, f.name), sessionId: f.name.replace(/\.jsonl$/, '') });
            }
          }
        }
      }
    }
  } else if (platform === 'claude-code') {
    const dir = resolveDir(dirOverride, CLAUDE_CODE_DIR);
    const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(dir, p.name);
      const entries = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(projDir, f.name), sessionId: f.name.replace(/\.jsonl$/, '') });
        }
      }
      // Also check subagents/
      const subDir = path.join(projDir, 'subagents');
      const subEntries = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
      for (const f of subEntries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(subDir, f.name), sessionId: f.name.replace(/\.jsonl$/, '') });
        }
      }
    }
  } else if (platform === 'omp') {
    const dir = resolveDir(dirOverride, OMP_DIR);
    const slugs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(dir, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(slugDir, f.name), sessionId: ompSessionIdFromFile(f.name) });
        }
      }
    }
  }

  return files;
}

// Extract first non-empty text line from content array
function extractErrorSnippet(content) {
  if (!Array.isArray(content)) return '';
  for (const c of content) {
    if (c.type === 'text' && c.text) {
      const line = c.text.trim().split('\n')[0].trim();
      if (line) return line.slice(0, 200);
    }
    if (typeof c === 'string') {
      const line = c.trim().split('\n')[0].trim();
      if (line) return line.slice(0, 200);
    }
  }
  return '';
}

// Normalize error pattern: take first line, lowercase, strip variable parts
function normalizeErrorPattern(snippet) {
  if (!snippet) return '(empty)';
  const line = snippet.split('\n')[0].trim().toLowerCase();
  // Strip file paths
  const stripped = line.replace(/\/[^\s]+/g, '/…');
  // Strip hex ids
  return stripped.replace(/[0-9a-f]{8,}/g, '…').slice(0, 120);
}

// Scan a single JSONL file for insights data
// Supports both standard format (type:'message' with toolCall/toolResult roles)
// and Claude Code format (type:'assistant'/'user' with tool_use/tool_result content blocks)
async function scanFileForInsights(filePath, sessionId) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let sessionDate = null;
  const toolStats = {};   // name → { calls, errors, totalDurationMs }
  const errorExamples = []; // { toolName, snippet, pattern }

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      // Session timestamp
      if (rec.type === 'session' && rec.timestamp) {
        sessionDate = rec.timestamp.slice(0, 10);
      }
      // Claude Code: timestamp at top level on type:'user'/'assistant'
      if ((rec.type === 'user' || rec.type === 'assistant') && !sessionDate && rec.timestamp) {
        sessionDate = rec.timestamp.slice(0, 10);
      }

      // --- Standard format: type === 'message' ---
      if (rec.type === 'message') {
        messageCount++;
        const msg = rec.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];

        if (msg.usage) {
          totalInputTokens += msg.usage.input || 0;
          totalOutputTokens += msg.usage.output || 0;
          totalCacheRead += msg.usage.cacheRead || msg.usage.cache_read || 0;
        }

        for (const c of content) {
          if (c.type === 'toolCall') {
            toolCallCount++;
            const name = c.name || 'unknown';
            if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
            toolStats[name].calls++;
          }
        }

        if (msg.role === 'toolResult') {
          toolResultCount++;
          const name = msg.toolName || '?';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };

          if (msg.isError) {
            errorCount++;
            toolStats[name].errors++;
            const snippet = extractErrorSnippet(msg.content);
            const pattern = normalizeErrorPattern(snippet);
            errorExamples.push({ toolName: name, snippet, pattern, sessionId, timestamp: rec.timestamp || null });
          }

          if (msg.details && typeof msg.details.durationMs === 'number') {
            toolStats[name].totalDurationMs += msg.details.durationMs;
          } else if (msg.details && typeof msg.details.wallTimeMs === 'number') {
            toolStats[name].totalDurationMs += Math.round(msg.details.wallTimeMs);
          }
        }
      }

      // --- Claude Code format: type === 'assistant' with tool_use blocks ---
      if (rec.type === 'assistant') {
        messageCount++;
        const msg = rec.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];

        // Token usage
        if (msg.usage) {
          totalInputTokens += msg.usage.input_tokens || msg.usage.input || 0;
          totalOutputTokens += msg.usage.output_tokens || msg.usage.output || 0;
          totalCacheRead += msg.usage.cache_creation_input_tokens || msg.usage.cache_read_input_tokens || 0;
        }

        for (const c of content) {
          if (c.type === 'tool_use') {
            toolCallCount++;
            const name = c.name || 'unknown';
            if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
            toolStats[name].calls++;
          }
        }
      }

      // --- Claude Code format: type === 'user' with tool_result blocks ---
      if (rec.type === 'user') {
        messageCount++;
        const msg = rec.message || {};
        const content = Array.isArray(msg.content) ? msg.content : [];

        for (const c of content) {
          if (c.type === 'tool_result') {
            toolResultCount++;
            // tool_result blocks don't carry the tool name directly;
            // we use a generic label since we can't easily correlate tool_use id
            const name = 'tool';

            if (c.is_error) {
              errorCount++;
              if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
              toolStats[name].errors++;
              // Extract error text from tool_result content
              let errorText = '';
              if (typeof c.content === 'string') {
                errorText = c.content;
              } else if (Array.isArray(c.content)) {
                errorText = c.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
              }
              const snippet = errorText.trim().split('\n')[0].trim().slice(0, 200);
              const pattern = normalizeErrorPattern(snippet);
              errorExamples.push({ toolName: name, snippet, pattern, sessionId, timestamp: rec.timestamp || null });
            }
          }
        }
      }

      // --- Codex format: type === 'response_item' with payload.type === 'function_call'/'function_call_output' ---
      if (rec.type === 'response_item') {
        const payload = rec.payload || {};
        if (payload.type === 'message') {
          messageCount++;
        }
        if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
          toolCallCount++;
          const name = payload.name || 'unknown';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
        if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
          toolResultCount++;
          const name = 'tool';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          const output = payload.output;
          let outputText = '';
          let isErr = false;
          if (typeof output === 'string') {
            outputText = output;
            isErr = outputText.includes('Process exited with code') && !outputText.includes('exited with code 0');
          } else if (output && typeof output === 'object') {
            outputText = output.output || JSON.stringify(output);
            if (output.metadata && output.metadata.exit_code !== undefined) {
              isErr = output.metadata.exit_code !== 0;
            }
          }
          if (isErr) {
            errorCount++;
            toolStats[name].errors++;
            const snippet = outputText.trim().split('\n')[0].trim().slice(0, 200);
            const pattern = normalizeErrorPattern(snippet);
            errorExamples.push({ toolName: name, snippet, pattern, sessionId, timestamp: rec.timestamp || null });
          }
          if (output && typeof output === 'object' && output.metadata && output.metadata.duration_seconds) {
            toolStats[name].totalDurationMs += Math.round(output.metadata.duration_seconds * 1000);
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { messageCount, toolCallCount, toolResultCount, errorCount, totalInputTokens, totalOutputTokens, totalCacheRead, sessionDate, toolStats, errorExamples };
}

// Scan a single Hermes session for insights (from SQLite)
function scanHermesSessionForInsights(db, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sessionDate = null;
  const toolStats = {};
  const errorExamples = [];

  const rows = db.prepare(`
    SELECT role, content, tool_calls, tool_name, token_count, timestamp
    FROM messages WHERE session_id = ?
    ORDER BY rowid
  `).all(sessionId);

  for (const row of rows) {
    messageCount++;
    totalInputTokens += row.token_count || 0;

    if (!sessionDate && row.timestamp) {
      sessionDate = new Date(row.timestamp * 1000).toISOString().slice(0, 10);
    }

    // Parse tool calls from assistant messages
    if (row.role === 'assistant' && row.tool_calls) {
      let calls;
      try { calls = JSON.parse(row.tool_calls); } catch { continue; }
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.function?.name || tc?.name || 'unknown';
          toolCallCount++;
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }
    }

    // Tool results
    if (row.role === 'tool') {
      toolResultCount++;
      const name = row.tool_name || 'tool';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      // Detect errors from content (no is_error column in Hermes)
      const content = row.content || '';
      const isErr = content.includes('"isError":true') || content.includes('"isError": true') ||
                    content.toLowerCase().includes('error') && content.includes('exit code') && !content.includes('exit code 0');
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        const snippet = content.trim().split('\n')[0].trim().slice(0, 200);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({ toolName: name, snippet, pattern, sessionId, timestamp: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null });
      }
    }
  }

  return { messageCount, toolCallCount, toolResultCount, errorCount, totalInputTokens, totalOutputTokens, totalCacheRead: 0, sessionDate, toolStats, errorExamples };
}

async function computeInsights(platform, agentName, dirOverride) {
  // Hermes uses SQLite
  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    const db = openHermesDb(dir);
    if (!db) return null;
    try {
      const sessions = db.prepare('SELECT id FROM sessions').all();
      let totalSessions = sessions.length;
      let totalMessages = 0, totalToolCalls = 0, totalToolResultCount = 0, totalErrors = 0;
      let totalInput = 0, totalOutput = 0;
      const toolStats = {};
      const allErrors = [];
      const dailyTrend = {};

      for (const s of sessions) {
        const data = scanHermesSessionForInsights(db, s.id);
        totalMessages += data.messageCount;
        totalToolCalls += data.toolCallCount;
        totalToolResultCount += data.toolResultCount;
        totalErrors += data.errorCount;
        totalInput += data.totalInputTokens;
        totalOutput += data.totalOutputTokens;

        for (const [name, st] of Object.entries(data.toolStats)) {
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls += st.calls;
          toolStats[name].errors += st.errors;
          toolStats[name].totalDurationMs += st.totalDurationMs;
        }
        allErrors.push(...data.errorExamples);

        if (data.sessionDate) {
          if (!dailyTrend[data.sessionDate]) dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0 };
          dailyTrend[data.sessionDate].sessions++;
          dailyTrend[data.sessionDate].errors += data.errorCount;
          dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
        }
      }

      return buildInsightsResponse(totalSessions, totalMessages, totalToolCalls, totalToolResultCount, totalErrors, totalInput, totalOutput, 0, toolStats, allErrors, dailyTrend);
    } finally {
      db.close();
    }
  }

  // JSONL-based platforms: openclaw, codex, claude-code, omp
  const files = await collectSessionFiles(platform, agentName, dirOverride);
  if (files.length === 0) return null;

  let totalSessions = files.length;
  let totalMessages = 0, totalToolCalls = 0, totalToolResultCount = 0, totalErrors = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  const toolStats = {};
  const allErrors = [];
  const dailyTrend = {};

  for (const f of files) {
    const data = await scanFileForInsights(f.path, f.sessionId).catch(() => null);
    if (!data) continue;

    totalMessages += data.messageCount;
    totalToolCalls += data.toolCallCount;
    totalToolResultCount += data.toolResultCount;
    totalErrors += data.errorCount;
    totalInput += data.totalInputTokens;
    totalOutput += data.totalOutputTokens;
    totalCacheRead += data.totalCacheRead;

    for (const [name, st] of Object.entries(data.toolStats)) {
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls += st.calls;
      toolStats[name].errors += st.errors;
      toolStats[name].totalDurationMs += st.totalDurationMs;
    }
    allErrors.push(...data.errorExamples);

    if (data.sessionDate) {
      if (!dailyTrend[data.sessionDate]) dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0 };
      dailyTrend[data.sessionDate].sessions++;
      dailyTrend[data.sessionDate].errors += data.errorCount;
      dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
    }
  }

  return buildInsightsResponse(totalSessions, totalMessages, totalToolCalls, totalToolResultCount, totalErrors, totalInput, totalOutput, totalCacheRead, toolStats, allErrors, dailyTrend);
}

function buildInsightsResponse(totalSessions, totalMessages, totalToolCalls, totalToolResultCount, totalErrors, totalInput, totalOutput, totalCacheRead, toolStats, allErrors, dailyTrend) {
  const errorRate = totalToolResultCount > 0 ? totalErrors / totalToolResultCount : 0;

  // Tool stats array
  const toolStatsArray = Object.entries(toolStats)
    .map(([name, st]) => ({
      name,
      calls: st.calls,
      errors: st.errors,
      errorRate: st.calls > 0 ? st.errors / st.calls : 0,
      avgDurationMs: st.calls > 0 ? Math.round(st.totalDurationMs / st.calls) : null
    }))
    .sort((a, b) => b.calls - a.calls);

  // Error clusters: group by normalized pattern
  const clusters = {};
  for (const err of allErrors) {
    const key = err.pattern;
    if (!clusters[key]) clusters[key] = { pattern: err.snippet, count: 0, examples: [] };
    clusters[key].count++;
    if (clusters[key].examples.length < 5) {
      clusters[key].examples.push({ sessionId: err.sessionId, toolName: err.toolName, snippet: err.snippet, timestamp: err.timestamp });
    }
  }
  const errorClusters = Object.values(clusters).sort((a, b) => b.count - a.count).slice(0, 20);

  // Daily trend sorted by date
  const trend = Object.entries(dailyTrend)
    .map(([date, d]) => ({ date, sessions: d.sessions, errors: d.errors, toolCalls: d.toolCalls }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSessions,
    totalMessages,
    totalToolCalls,
    errorRate: Math.round(errorRate * 10000) / 10000,
    tokenUsage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead },
    toolStats: toolStatsArray,
    errorClusters,
    trend
  };
}

app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: false, lastModified: false }));
app.use(express.json({ limit: '256kb' }));

// Disable all caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

app.get('/api/agents', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const agents = await readAgents(dir);
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Prompts view: extract real human prompts per session, grouped by directory ---

const promptsCache = new Map();
const PROMPTS_TTL_MS = 60_000;

function getPromptsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

async function extractOpenClawPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!timestamp && record.type === 'session') timestamp = record.timestamp || null;
      if (record.type !== 'message') continue;
      if (record.timestamp) lastActivity = record.timestamp;
      const msg = record.message || {};
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = stripOpenClawNoise(content.filter(c => c.type === 'text').map(c => c.text || '').join(' ').trim());
      if (text) prompts.push({ text, timestamp: record.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { timestamp, lastActivity, prompts };
}

async function extractCodexPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.timestamp) lastActivity = rec.timestamp;
      const payload = rec.payload || {};
      if (rec.type === 'session_meta') {
        if (!cwd && payload.cwd) cwd = payload.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if (rec.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
      if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
      const text = extractCodexUserPromptText(payload);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, prompts };
}

async function extractOmpPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  let title = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (rec.type === 'session') {
        if (!cwd && rec.cwd) cwd = rec.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }
      if (rec.type !== 'message') continue;
      const msg = rec.message || {};
      if (msg.role !== 'user') continue;
      const text = extractOmpUserPromptText(msg);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, title, prompts };
}

async function extractClaudeCodePrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let slug = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (!timestamp && rec.timestamp && (rec.type === 'user' || rec.type === 'assistant')) timestamp = rec.timestamp;
      if (rec.type !== 'user') continue;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!slug && rec.slug) slug = rec.slug;
      const text = extractClaudeCodeUserPromptText(rec);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, slug, timestamp, lastActivity, prompts };
}

function extractHermesPromptGroups(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT m.session_id, m.content, m.timestamp, s.source, s.title, s.started_at, s.ended_at
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'user' AND m.content IS NOT NULL AND m.content != ''
      ORDER BY m.session_id, m.rowid
    `).all();

    const sessionMap = new Map();
    for (const row of rows) {
      let sess = sessionMap.get(row.session_id);
      if (!sess) {
        sess = {
          id: row.session_id,
          file: 'state.db',
          timestamp: unixToIso(row.started_at),
          lastActivity: unixToIso(row.ended_at),
          slug: null,
          title: row.title || null,
          directory: row.source || '(no directory)',
          prompts: []
        };
        sessionMap.set(row.session_id, sess);
      }
      sess.prompts.push({ text: row.content, timestamp: unixToIso(row.timestamp) });
    }

    const groupMap = new Map();
    for (const sess of sessionMap.values()) {
      const key = sess.directory;
      if (!groupMap.has(key)) groupMap.set(key, []);
      const { directory, ...rest } = sess;
      groupMap.get(key).push({ ...rest, promptCount: sess.prompts.length });
    }
    return Array.from(groupMap.entries()).map(([directory, sessions]) => ({ directory, sessions }));
  } finally {
    db.close();
  }
}

async function computePrompts(platform, agentName, dirOverride) {
  let groups;

  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    groups = extractHermesPromptGroups(dir);
  } else {
    const files = await collectSessionFiles(platform, agentName, dirOverride);
    const groupMap = new Map();
    const results = await Promise.all(files.map(async (f) => {
      const extractor = platform === 'codex' ? extractCodexPrompts
        : platform === 'claude-code' ? extractClaudeCodePrompts
        : platform === 'omp' ? extractOmpPrompts
        : extractOpenClawPrompts;
      const result = await extractor(f.path).catch(() => null);
      return result ? { file: f, result } : null;
    }));
    for (const item of results) {
      if (!item || item.result.prompts.length === 0) continue;
      const { file: f, result } = item;
      let key;
      if (platform === 'openclaw') {
        // File lives at {dir}/{agent}/sessions/x.jsonl
        key = `agent: ${path.basename(path.dirname(path.dirname(f.path)))}`;
      } else {
        key = result.cwd || '(no directory)';
      }
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push({
        id: f.sessionId,
        file: path.basename(f.path),
        timestamp: result.timestamp,
        lastActivity: result.lastActivity,
        slug: result.slug || null,
        title: result.title || null,
        promptCount: result.prompts.length,
        prompts: result.prompts
      });
    }
    groups = Array.from(groupMap.entries()).map(([directory, sessions]) => ({ directory, sessions }));
  }

  let totalSessions = 0;
  let totalPrompts = 0;
  for (const g of groups) {
    g.sessions.sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));
    g.sessionCount = g.sessions.length;
    g.promptCount = g.sessions.reduce((sum, s) => sum + s.promptCount, 0);
    totalSessions += g.sessionCount;
    totalPrompts += g.promptCount;
  }
  groups.sort((a, b) => b.promptCount - a.promptCount);

  return { platform, totalSessions, totalPrompts, groups };
}

// --- Prompt analysis: clustering, attribution, claude CLI suggestions ---

const analyzeCache = new Map();
const analyzeInFlight = new Map();
const ANALYZE_TOP_K = 8;
const ATTRIBUTION_FILE_CAP = 150;

function promptFingerprint(text) {
  const firstLine = text.split('\n').find(l => l.trim()) || '';
  let p = firstLine.trim().toLowerCase();
  p = p.replace(/\/[^\s]+/g, '/…');
  p = p.replace(/[0-9a-f]{8,}/g, '…');
  p = p.replace(/\d+/g, '#');
  return p.slice(0, 120) || '(empty)';
}

function clusterPrompts(promptsData) {
  const clusters = new Map();
  for (const g of promptsData.groups) {
    for (const s of g.sessions) {
      for (const p of s.prompts) {
        const pattern = promptFingerprint(p.text);
        let c = clusters.get(pattern);
        if (!c) {
          c = { pattern, count: 0, sessionIds: new Set(), directories: new Set(), totalLength: 0, shortest: null, longest: null };
          clusters.set(pattern, c);
        }
        c.count++;
        c.sessionIds.add(s.id);
        c.directories.add(g.directory);
        c.totalLength += p.text.length;
        if (!c.shortest || p.text.length < c.shortest.length) c.shortest = p.text;
        if (!c.longest || p.text.length > c.longest.length) c.longest = p.text;
      }
    }
  }
  return Array.from(clusters.values())
    .map(c => ({
      pattern: c.pattern,
      count: c.count,
      sessionIds: Array.from(c.sessionIds),
      directories: Array.from(c.directories),
      avgLength: Math.round(c.totalLength / c.count),
      samples: c.shortest === c.longest
        ? [c.shortest.slice(0, 2000)]
        : [c.shortest.slice(0, 2000), c.longest.slice(0, 2000)]
    }))
    .sort((a, b) => b.count - a.count);
}

async function attributeClusters(clusters, platform, agentName, dirOverride) {
  const top = clusters.slice(0, ANALYZE_TOP_K);
  if (platform === 'hermes' || top.length === 0) return;

  const files = await collectSessionFiles(platform, agentName, dirOverride);
  const pathById = new Map(files.map(f => [f.sessionId, f.path]));

  const neededIds = new Set();
  const perClusterCap = Math.max(10, Math.floor(ATTRIBUTION_FILE_CAP / top.length));
  for (const c of top) {
    let added = 0;
    for (const sid of c.sessionIds) {
      if (added >= perClusterCap || neededIds.size >= ATTRIBUTION_FILE_CAP) break;
      if (pathById.has(sid)) { neededIds.add(sid); added++; }
    }
  }

  const scans = new Map();
  await Promise.all(Array.from(neededIds).map(async (sid) => {
    const result = await scanFileForInsights(pathById.get(sid), sid).catch(() => null);
    if (result) scans.set(sid, result);
  }));

  for (const c of top) {
    let sessions = 0, messages = 0, toolCalls = 0, toolResults = 0, errors = 0, outputTokens = 0;
    for (const sid of c.sessionIds) {
      const scan = scans.get(sid);
      if (!scan) continue;
      sessions++;
      messages += scan.messageCount || 0;
      toolCalls += scan.toolCallCount || 0;
      toolResults += scan.toolResultCount || 0;
      errors += scan.errorCount || 0;
      outputTokens += scan.totalOutputTokens || 0;
    }
    if (sessions > 0) {
      c.attribution = {
        sampledSessions: sessions,
        avgMessages: Math.round(messages / sessions),
        avgToolCalls: Math.round(toolCalls / sessions * 10) / 10,
        errorRate: toolResults > 0 ? Math.round(errors / toolResults * 1000) / 10 : 0,
        avgOutputTokens: Math.round(outputTokens / sessions)
      };
    }
  }
}

function runClaudeCli(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile('claude', ['-p'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

function parseLlmJson(raw) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.search(/[[{]/);
  if (start > 0) text = text.slice(start);
  try { return JSON.parse(text); } catch { return null; }
}

async function runClaudeAnalysis(clusters) {
  const top = clusters.filter(c => c.count > 1).slice(0, ANALYZE_TOP_K);
  if (top.length === 0) return { suggestions: [], overall: [] };

  const clusterDescriptions = top.map((c, i) => {
    const attr = c.attribution
      ? `归因(采样${c.attribution.sampledSessions}个session): 平均${c.attribution.avgMessages}条消息/${c.attribution.avgToolCalls}次工具调用, 工具错误率${c.attribution.errorRate}%, 平均输出${c.attribution.avgOutputTokens} tokens`
      : '无归因数据';
    return `## 模板 ${i + 1}
指纹: ${c.pattern}
出现次数: ${c.count}
${attr}
样例:
"""
${c.samples[0].slice(0, 1500)}
"""`;
  }).join('\n\n');

  const input = `你是 prompt 工程专家。以下是从 AI agent 会话日志中聚类出的高频 prompt 模板(按出现次数降序),附带每个模板对应 session 的效果归因数据。

请针对每个模板给出优化建议。评估维度: 意图明确性、上下文充分性、约束与输出格式定义、避免模型误解的措辞。归因数据中,高消息数/高工具调用/高错误率可能暗示 prompt 引导不足。

${clusterDescriptions}

只输出一个 JSON 对象,不要任何其它文字或 markdown 围栏,结构:
{
  "suggestions": [
    { "index": 1, "assessment": "一句话诊断", "issues": ["问题1", "问题2"], "rewrite": "改写后的完整模板(变量部分用 {占位符} 表示)", "rationale": "改写理由" }
  ],
  "overall": ["跨模板的整体建议1", "建议2"]
}
suggestions 数组按模板顺序,每个模板一项。用中文回答。`;

  const raw = await runClaudeCli(input, 240_000);
  const parsed = parseLlmJson(raw);
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return { suggestions: [], overall: [], rawText: raw.trim().slice(0, 8000) };
  }
  return { suggestions: parsed.suggestions, overall: Array.isArray(parsed.overall) ? parsed.overall : [] };
}

async function computePromptAnalysis(platform, agentName, dirOverride, skipLlm) {
  const promptsData = await computePrompts(platform, agentName, dirOverride);
  const clusters = clusterPrompts(promptsData);
  await attributeClusters(clusters, platform, agentName, dirOverride);

  const result = {
    platform,
    generatedAt: new Date().toISOString(),
    totalPrompts: promptsData.totalPrompts,
    totalClusters: clusters.length,
    clusters: clusters.slice(0, 50),
    overall: [],
    llmError: null
  };

  if (!skipLlm) {
    try {
      const llm = await runClaudeAnalysis(clusters);
      if (llm.rawText) {
        result.rawText = llm.rawText;
      } else {
        const top = clusters.filter(c => c.count > 1).slice(0, ANALYZE_TOP_K);
        for (const s of llm.suggestions) {
          const target = top[(s.index || 0) - 1];
          if (target) target.suggestion = { assessment: s.assessment, issues: s.issues || [], rewrite: s.rewrite, rationale: s.rationale };
        }
        result.overall = llm.overall;
      }
    } catch (error) {
      result.llmError = error.message;
    }
  }

  return result;
}

// Insights: aggregate analytics across sessions
app.get('/api/insights', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = req.query.agent || '';
    const dir = req.query.dir || '';

    const cacheKey = getInsightsCacheKey(platform, agent, dir);
    const cached = insightsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.data);
    }

    const data = await computeInsights(platform, agent, dir);
    if (!data) {
      return res.json({ totalSessions: 0, totalMessages: 0, totalToolCalls: 0, errorRate: 0, tokenUsage: { input: 0, output: 0, cacheRead: 0 }, toolStats: [], errorClusters: [], trend: [] });
    }

    insightsCache.set(cacheKey, { data, expires: Date.now() + INSIGHTS_TTL_MS });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prompts: real human prompts per session, grouped by directory
app.get('/api/prompts', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = req.query.agent || '';
    const dir = req.query.dir || '';

    const cacheKey = getPromptsCacheKey(platform, agent, dir);
    const cached = promptsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.data);
    }

    const data = await computePrompts(platform, agent, dir);
    if (!data) {
      return res.json({ platform, totalSessions: 0, totalPrompts: 0, groups: [] });
    }

    promptsCache.set(cacheKey, { data, expires: Date.now() + PROMPTS_TTL_MS });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prompt analysis: cluster + attribute + claude CLI suggestions
app.get('/api/prompts/analyze', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = req.query.agent || '';
    const dir = req.query.dir || '';
    const refresh = req.query.refresh === '1';
    const skipLlm = req.query.skipLlm === '1';
    const cacheKey = getPromptsCacheKey(platform, agent, dir);

    if (!refresh && analyzeCache.has(cacheKey)) {
      return res.json(analyzeCache.get(cacheKey));
    }
    // Coalesce concurrent identical requests into one computation
    if (analyzeInFlight.has(cacheKey)) {
      const data = await analyzeInFlight.get(cacheKey);
      return res.json(data);
    }

    const promise = computePromptAnalysis(platform, agent, dir, skipLlm);
    analyzeInFlight.set(cacheKey, promise);
    try {
      const data = await promise;
      if (!skipLlm) analyzeCache.set(cacheKey, data);
      res.json(data);
    } finally {
      analyzeInFlight.delete(cacheKey);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rewrite a single prompt via claude CLI
app.post('/api/prompts/rewrite', async (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').slice(0, 8000);
    if (!text.trim()) return res.status(400).json({ error: 'text is required' });

    const input = `你是 prompt 工程专家。请改写下面这条给 AI agent 的 prompt,使其意图更明确、上下文更充分、约束与期望输出更清晰,同时保留原始意图。

原始 prompt:
"""
${text}
"""

只输出一个 JSON 对象,不要任何其它文字或 markdown 围栏:
{ "rewrite": "改写后的完整 prompt", "rationale": "改动说明(中文,简短)" }`;

    const raw = await runClaudeCli(input, 120_000);
    const parsed = parseLlmJson(raw);
    if (!parsed || !parsed.rewrite) {
      return res.json({ rewrite: raw.trim().slice(0, 8000), rationale: null, raw: true });
    }
    res.json({ rewrite: parsed.rewrite, rationale: parsed.rationale || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Full-text search across sessions
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const platform = req.query.platform || 'openclaw';
    const agent = req.query.agent || '';
    const maxResults = Math.min(parseInt(req.query.limit) || 50, 100);
    if (!q) return res.json([]);

    let sessionFiles = [];

    if (platform === 'openclaw' && agent) {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const agentDir = path.join(dir, agent, 'sessions');
      try {
        const entries = await fsp.readdir(agentDir);
        sessionFiles = entries
          .filter(f => f.endsWith('.jsonl') && !isArchivedFile(f))
          .map(f => ({ path: path.join(agentDir, f), file: f, platform: 'openclaw' }));
      } catch { /* no sessions */ }
    } else if (platform === 'codex') {
      const dir = resolveDir(req.query.dir, CODEX_DIR);
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const jsonlPath = path.join(dir, e.name, 'conversation.jsonl');
          try { await fsp.access(jsonlPath); sessionFiles.push({ path: jsonlPath, file: e.name, platform: 'codex' }); } catch {}
        }
      } catch {}
    } else if (platform === 'hermes') {
      const dir = resolveDir(req.query.dir, HERMES_DIR);
      const hermesResults = searchHermesSessions(dir, q, maxResults);
      return res.json(hermesResults);
    } else if (platform === 'claude-code') {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      try {
        const entries = await fsp.readdir(dir);
        sessionFiles = entries
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ path: path.join(dir, f), file: f, platform: 'claude-code' }));
      } catch {}
    } else if (platform === 'omp') {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      try {
        const slugs = await fsp.readdir(dir, { withFileTypes: true });
        for (const s of slugs) {
          if (!s.isDirectory()) continue;
          const slugDir = path.join(dir, s.name);
          const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
          for (const f of entries) {
            if (f.isFile() && f.name.endsWith('.jsonl')) {
              sessionFiles.push({ path: path.join(slugDir, f.name), file: f.name, sessionId: ompSessionIdFromFile(f.name), platform: 'omp' });
            }
          }
        }
      } catch {}
    }

    const results = [];

    for (const sf of sessionFiles) {
      if (results.length >= maxResults) break;
      const matches = [];
      const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let sessionId = sf.sessionId || sf.file.split('.jsonl')[0];

      try {
        for await (const line of rl) {
          if (matches.length >= 3) break; // max 3 matches per session
          if (!line.includes(q) && !line.toLowerCase().includes(q)) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }

          // Extract session id
          if (rec.type === 'session' && rec.id) sessionId = rec.id;
          if (rec.payload?.id && !sessionId) sessionId = rec.payload.id;
          if (rec.sessionId) sessionId = rec.sessionId;

          // Extract text content for matching
          let text = '';
          let role = '';
          const msg = rec.message || rec.payload || {};
          role = msg.role || rec.type || '';
          const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
          text = content
            .filter(c => c.type === 'text' || c.type === 'input_text')
            .map(c => c.text || '')
            .join(' ');

          if (text.toLowerCase().includes(q)) {
            // Extract snippet around match
            const idx = text.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + q.length + 60);
            const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
            matches.push({ role, snippet, timestamp: rec.timestamp || null });
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }

      if (matches.length > 0) {
        results.push({ sessionId, file: sf.file, platform: sf.platform, matches });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:name/sessions', async (req, res) => {
  const agentName = sanitizeAgentName(req.params.name);
  if (!agentName) {
    return res.status(400).json({ error: 'Invalid agent name' });
  }

  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const sessions = await listSessionsForAgent(dir, agentName, req.query.include_archived === 'true');
    res.json(sessions);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:name/sessions/:sessionId', async (req, res) => {
  const agentName = sanitizeAgentName(req.params.name);
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!agentName || !sessionId) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const filePath = await resolveSessionFile(dir, agentName, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Build a map of spawn relationships: which agent/session spawned which sub-agent sessions
// Detects: sessions_spawn tool calls, exec calls containing codex/claude commands
async function buildSpawnMap(baseDir) {
  const dir = baseDir || DATA_DIR;
  const spawnLinks = [];
  const agents = await readAgents(dir);

  for (const agentName of agents) {
    const agentDir = path.join(dir, agentName, 'sessions');
    let entries;
    try {
      entries = await fsp.readdir(agentDir, { withFileTypes: true });
    } catch { continue; }

    const sessionFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !isArchivedFile(e.name))
      .map((e) => e.name);

    for (const fileName of sessionFiles) {
      const sessionId = fileName.split('.jsonl')[0];
      const filePath = path.join(agentDir, fileName);
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of rl) {
          if (!line.includes('toolCall') && !line.includes('sessions_spawn')) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.type !== 'message') continue;
          const msg = record.message || {};
          const content = Array.isArray(msg.content) ? msg.content : [];

          for (const c of content) {
            if (c.type !== 'toolCall') continue;
            const args = c.arguments || {};

            // sessions_spawn: has agentId and task
            if (c.name === 'sessions_spawn' && args.agentId) {
              spawnLinks.push({
                parentAgent: agentName,
                parentSession: sessionId,
                toolCallId: c.id,
                toolName: c.name,
                childAgent: args.agentId,
                childLabel: args.label || null,
                task: (args.task || '').slice(0, 200),
                timestamp: record.timestamp
              });
            }

            // exec calls with codex/claude in the command
            if (c.name === 'exec' && typeof args.command === 'string') {
              const cmd = args.command.toLowerCase();
              if (cmd.includes('codex ') || cmd.includes('claude ')) {
                const inferredAgent = cmd.includes('codex') ? 'codex' : 'claude-code';
                spawnLinks.push({
                  parentAgent: agentName,
                  parentSession: sessionId,
                  toolCallId: c.id,
                  toolName: 'exec',
                  childAgent: inferredAgent,
                  childLabel: null,
                  task: (args.command || '').slice(0, 200),
                  timestamp: record.timestamp,
                  isExecSpawn: true
                });
              }
            }
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }
  }

  return spawnLinks;
}

app.get('/api/spawn-map', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const spawnLinks = await buildSpawnMap(dir);
    res.json(spawnLinks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Build spawn tree: recursive spawn relationships across sessions
async function buildSpawnTree(baseDir) {
  const dir = baseDir || DATA_DIR;

  // Scan ALL sessions, collect spawn metadata, then build tree
  const agents = await readAgents(dir);
  const sessionInfo = new Map();
  const spawnCalls = [];

  for (const agentName of agents) {
    const agentDir = path.join(dir, agentName, 'sessions');
    let entries;
    try {
      entries = await fsp.readdir(agentDir, { withFileTypes: true });
    } catch { continue; }

    const sessionFiles = entries
      .filter((e) => e.isFile() && isSessionLogFile(e.name))
      .map((e) => e.name);

    for (const fileName of sessionFiles) {
      const sessionId = fileName.split('.jsonl')[0];
      const filePath = path.join(agentDir, fileName);
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let firstUserMsg = null;
      let sessionTimestamp = null;
      let lastActivity = null;

      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }

          if (record.type === 'session' && !sessionTimestamp) {
            sessionTimestamp = record.timestamp || null;
          }

          if (record.type === 'message') {
            const msg = record.message || {};
            if (record.timestamp) lastActivity = record.timestamp;

            if (msg.role === 'user' && !firstUserMsg) {
              let texts = (Array.isArray(msg.content) ? msg.content : [])
                .filter(c => c.type === 'text').map(c => c.text || '').join(' ').trim();
              texts = texts.replace(/^System:.*\n?/gm, '');
              texts = texts.replace(/^[A-Za-z ]+\([^)]*\):\n```[\s\S]*?```\n?/gm, '');
              texts = texts.replace(/^\[message_id:[^\]]*\].*\n?/gm, '');
              texts = texts.replace(/^ou_[a-z0-9]+:\s*/gm, '');
              texts = texts.replace(/^\[.*?\] \[Subagent Context\][\s\S]*/m, '');
              texts = texts.replace(/^\[\w{3} \d{4}-\d{2}-\d{2}[^\]]*\][^\n]*\n?/gm, '');
              texts = texts.replace(/^HEARTBEAT_OK.*\n?/gm, '');
              texts = texts.trim();
              if (texts) firstUserMsg = texts.slice(0, 120);
            }

            const content = Array.isArray(msg.content) ? msg.content : [];
            for (const c of content) {
              if (c.type !== 'toolCall') continue;
              const args = c.arguments || {};

              if (c.name === 'sessions_spawn' && args.agentId) {
                spawnCalls.push({
                  parentSession: sessionId,
                  parentAgent: agentName,
                  childAgent: args.agentId,
                  childLabel: args.label || null,
                  task: (args.task || '').slice(0, 120),
                  toolCallId: c.id,
                  timestamp: record.timestamp
                });
              }

              if (c.name === 'exec' && typeof args.command === 'string') {
                const cmd = args.command.toLowerCase();
                if (cmd.includes('codex ') || cmd.includes('claude ')) {
                  const inferredAgent = cmd.includes('codex') ? 'codex' : 'claude-code';
                  spawnCalls.push({
                    parentSession: sessionId,
                    parentAgent: agentName,
                    childAgent: inferredAgent,
                    childLabel: null,
                    task: (args.command || '').slice(0, 120),
                    toolCallId: c.id,
                    timestamp: record.timestamp,
                    isExecSpawn: true
                  });
                }
              }
            }
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }

      // Only set if not already set, or if this entry has better data
      const existing = sessionInfo.get(sessionId);
      if (!existing || (!existing.timestamp && sessionTimestamp)) {
        sessionInfo.set(sessionId, {
          agent: agentName,
          firstUserMsg: firstUserMsg || existing?.firstUserMsg,
          timestamp: sessionTimestamp || existing?.timestamp,
          lastActivity: lastActivity || existing?.lastActivity
        });
      }
    }
  }

  // Match spawn calls to actual child sessions by time proximity
  const parentToChildren = new Map();

  for (const sc of spawnCalls) {
    const candidates = [];
    const childAgentLower = (sc.childAgent || '').toLowerCase();
    for (const [sid, info] of sessionInfo) {
      if (sid === sc.parentSession) continue;
      // Case-insensitive agent match
      if (childAgentLower && info.agent.toLowerCase() !== childAgentLower) continue;
      // If no agentId, we can't match by agent alone — skip (would be too noisy)
      if (!childAgentLower) continue;
      if (info.timestamp && sc.timestamp) {
        const spawnTime = new Date(sc.timestamp).getTime();
        const sessionTime = new Date(info.timestamp).getTime();
        // Match within 5 minutes (wider window for slower agents)
        if (sessionTime >= spawnTime && sessionTime - spawnTime < 300000) {
          candidates.push({ sid, diff: sessionTime - spawnTime });
        }
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.diff - b.diff);
      const childId = candidates[0].sid;
      if (!parentToChildren.has(sc.parentSession)) {
        parentToChildren.set(sc.parentSession, []);
      }
      // Dedup: don't add same child twice
      const existing = parentToChildren.get(sc.parentSession);
      if (!existing.some(e => e.sessionId === childId)) {
        existing.push({
          sessionId: childId,
          task: sc.task,
          label: sc.childLabel,
          timestamp: sc.timestamp,
          isExecSpawn: sc.isExecSpawn || false
        });
      }
    }
  }

  // Build tree recursively
  const visited = new Set();
  function buildNode(sessionId, depth) {
    if (depth > 6 || visited.has(sessionId)) return null;
    visited.add(sessionId);

    const info = sessionInfo.get(sessionId);
    if (!info) return null;

    const rawChildren = parentToChildren.get(sessionId) || [];
    const children = rawChildren
      .map(child => {
        const childInfo = sessionInfo.get(child.sessionId);
        return {
          id: child.sessionId,
          agent: childInfo?.agent || child.label || 'unknown',
          label: child.label,
          task: child.task || childInfo?.firstUserMsg || '(no task)',
          timestamp: child.timestamp || childInfo?.timestamp,
          isExecSpawn: child.isExecSpawn,
          children: []
        };
      })
      .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    for (const child of children) {
      const subtree = buildNode(child.id, depth + 1);
      if (subtree) {
        child.children = subtree.children;
        child.agent = subtree.agent;
        if (!child.task || child.task === '(no task)') {
          child.task = subtree.task;
        }
      }
    }

    return {
      id: sessionId,
      agent: info.agent,
      task: info.firstUserMsg || '(no task)',
      timestamp: info.timestamp,
      lastActivity: info.lastActivity,
      children
    };
  }

  // Add Hermes sessions with parent_session_id
  try {
    const hermesDb = openHermesDb(HERMES_DIR);
    if (hermesDb) {
      // Add all Hermes sessions to sessionInfo
      const allHermes = hermesDb.prepare(`
        SELECT id, source, title, started_at, ended_at, parent_session_id
        FROM sessions
      `).all();
      for (const hs of allHermes) {
        if (!sessionInfo.has(hs.id)) {
          sessionInfo.set(hs.id, {
            agent: hs.source || 'hermes',
            firstUserMsg: hs.title || null,
            timestamp: unixToIso(hs.started_at),
            lastActivity: unixToIso(hs.ended_at)
          });
        }
        if (hs.parent_session_id) {
          if (!parentToChildren.has(hs.parent_session_id)) {
            parentToChildren.set(hs.parent_session_id, []);
          }
          const existing = parentToChildren.get(hs.parent_session_id);
          if (!existing.some(e => e.sessionId === hs.id)) {
            existing.push({
              sessionId: hs.id,
              task: hs.title || '(Hermes sub-agent)',
              label: hs.source,
              timestamp: unixToIso(hs.started_at),
              isExecSpawn: false
            });
          }
        }
      }
      hermesDb.close();
    }
  } catch {}

  // Rebuild roots with Hermes data included
  const childSessionIds = new Set();
  for (const children of parentToChildren.values()) {
    for (const c of children) childSessionIds.add(c.sessionId);
  }

  const roots = [];
  visited.clear();
  for (const [parentId] of parentToChildren) {
    if (!childSessionIds.has(parentId)) {
      visited.clear();
      const tree = buildNode(parentId, 0);
      if (tree) roots.push(tree);
    }
  }

  roots.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return {
    trees: roots,
    totalSessions: sessionInfo.size,
    totalSpawnCalls: spawnCalls.length,
    matchedLinks: parentToChildren.size
  };
}

app.get('/api/spawn-tree', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const tree = await buildSpawnTree(dir);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spawn-tree/:sessionId', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const full = await buildSpawnTree(dir);
    const sid = req.params.sessionId;
    // Find tree rooted at this session, or find this session as a child
    function findNode(nodes, targetId) {
      for (const n of nodes) {
        if (n.id === targetId) return n;
        const found = findNode(n.children || [], targetId);
        if (found) return found;
      }
      return null;
    }
    // Find parent of this session
    function findParent(nodes, targetId, parent) {
      for (const n of nodes) {
        if (n.id === targetId) return parent;
        const found = findParent(n.children || [], targetId, n);
        if (found) return found;
      }
      return null;
    }
    const node = findNode(full.trees, sid);
    const parent = findParent(full.trees, sid, null);
    res.json({ node: node || null, parent: parent || null, totalSessions: full.totalSessions, totalSpawnCalls: full.totalSpawnCalls, matchedLinks: full.matchedLinks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Codex platform ---

function codexSessionIdFromFile(fileName) {
  // rollout-2026-03-31T13-18-02-019d4253-d114-7da1-89b7-826bb51867b6.jsonl
  return fileName.replace(/\.jsonl$/, '');
}

async function findCodexSessionFile(baseDir, sessionId) {
  const dir = baseDir || CODEX_DIR;
  // Walk the YYYY/MM/DD tree to find the file
  // sessionId can be a UUID (019d4d08-...) or a full rollout filename (rollout-2026-03-31T...)
  const years = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  if (!years || !years.length) return null;
  for (const y of years) {
    if (!y.isDirectory()) continue;
    const months = await fsp.readdir(path.join(dir, y.name), { withFileTypes: true });
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const days = await fsp.readdir(path.join(dir, y.name, m.name), { withFileTypes: true });
      for (const d of days) {
        if (!d.isDirectory()) continue;
        const dirPath = path.join(dir, y.name, m.name, d.name);
        // Try exact filename match first
        const exact = path.join(dirPath, sessionId + '.jsonl');
        try { await fsp.access(exact); return exact; } catch {}
        // Try matching by UUID suffix (file: rollout-{ts}-{uuid}.jsonl)
        const files = await fsp.readdir(dirPath, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const base = f.name.replace(/\.jsonl$/, '');
          if (base.endsWith(sessionId) || base === sessionId) {
            return path.join(dirPath, f.name);
          }
        }
      }
    }
  }
  return null;
}

// Returns the real human prompt text from a Codex user message payload, or null
// for synthetic session-start injections (<environment_context>, <user_instructions>)
function extractCodexUserPromptText(payload) {
  const content = Array.isArray(payload.content)
    ? payload.content
    : (typeof payload.content === 'string' ? [{ type: 'input_text', text: payload.content }] : []);
  const text = content.filter(c => c.type === 'input_text' || c.type === 'text').map(c => c.text || '').join(' ').trim();
  if (!text) return null;
  if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) return null;
  return text;
}

async function parseCodexSessionMetadata(filePath, fileName) {
  // Check mtime cache first
  try {
    const stat = await fsp.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = sessionMetaCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.data;
    }
  } catch {
    // If stat fails, fall through to parse
  }

  const data = await _parseCodexSessionMetadataRaw(filePath, fileName);

  // Update cache
  try {
    const stat = await fsp.stat(filePath);
    sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
  } catch {
    // Non-critical — just skip caching
  }

  return data;
}

async function _parseCodexSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionMeta = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const toolNames = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      const t = rec.type;
      const payload = rec.payload || {};

      if (t === 'session_meta' && !sessionMeta) {
        sessionMeta = {
          id: payload.id || codexSessionIdFromFile(fileName),
          timestamp: payload.timestamp || null,
          cwd: payload.cwd || null
        };
      }

      if (t === 'response_item') {
        const pt = payload.type;
        if (pt === 'message') {
          messageCount++;
          if (payload.role === 'user') {
            userCount++;
            if (!firstUserMessage) {
              const content = Array.isArray(payload.content) ? payload.content : (typeof payload.content === 'string' ? [{ type: 'input_text', text: payload.content }] : []);
              const texts = content.filter(c => c.type === 'input_text' || c.type === 'text').map(c => c.text || '').join(' ').trim();
              if (texts) firstUserMessage = texts.slice(0, 120);
            }
          }
          if (payload.role === 'assistant') assistantCount++;
        } else if (pt === 'function_call' || pt === 'custom_tool_call') {
          toolCallCount++;
          const name = payload.name || 'unknown';
          toolNames[name] = (toolNames[name] || 0) + 1;
        } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
          toolResultCount++;
        }
        // reasoning counts as assistant activity but not a separate message
        if (rec.timestamp) lastTimestamp = rec.timestamp;
      }

      if (t === 'event_msg' && rec.timestamp) {
        lastTimestamp = rec.timestamp;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    id: sessionMeta?.id || codexSessionIdFromFile(fileName),
    timestamp: sessionMeta?.timestamp || null,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    cwd: sessionMeta?.cwd || null,
    file: fileName
  };
}

async function listCodexSessions(baseDir) {
  const dir = baseDir || CODEX_DIR;
  const sessions = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }

  for (const y of entries) {
    if (!y.isDirectory()) continue;
    const months = await fsp.readdir(path.join(dir, y.name), { withFileTypes: true }).catch(() => []);
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const days = await fsp.readdir(path.join(dir, y.name, m.name), { withFileTypes: true }).catch(() => []);
      for (const d of days) {
        if (!d.isDirectory()) continue;
        const dirPath = path.join(dir, y.name, m.name, d.name);
        const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          sessions.push(parseCodexSessionMetadata(path.join(dirPath, f.name), f.name));
        }
      }
    }
  }

  const resolved = await Promise.all(sessions);
  resolved.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return resolved;
}

function normalizeCodexRecord(rec) {
  const payload = rec.payload || {};
  const t = payload.type;

  if (t === 'message') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    return {
      id: payload.id || null,
      timestamp: rec.timestamp || null,
      role: payload.role || null,
      content: content.map((c) => ({
        type: c.type === 'input_text' || c.type === 'output_text' ? 'text' : (c.type || 'text'),
        text: c.text || ''
      })),
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    };
  }

  if (t === 'function_call') {
    return {
      id: payload.call_id || null,
      timestamp: rec.timestamp || null,
      role: 'toolCall',
      content: [],
      usage: null,
      model: null,
      provider: null,
      toolCallId: payload.call_id || null,
      toolName: payload.name || null,
      details: payload.arguments || null,
      isError: false
    };
  }

  if (t === 'custom_tool_call') {
    return {
      id: payload.call_id || null,
      timestamp: rec.timestamp || null,
      role: 'toolCall',
      content: [],
      usage: null,
      model: null,
      provider: null,
      toolCallId: payload.call_id || null,
      toolName: payload.name || null,
      details: payload.arguments || null,
      isError: false
    };
  }

  if (t === 'function_call_output') {
    let outputText = '';
    const output = payload.output;
    if (typeof output === 'string') {
      outputText = output;
    } else if (output && typeof output === 'object') {
      outputText = output.output || JSON.stringify(output);
    }
    const metadata = (output && typeof output === 'object') ? output.metadata : null;
    return {
      id: payload.call_id || null,
      timestamp: rec.timestamp || null,
      role: 'toolResult',
      content: [{ type: 'text', text: outputText }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: payload.call_id || null,
      toolName: null,
      details: metadata ? { status: metadata.exit_code === 0 ? 'ok' : 'error', exitCode: metadata.exit_code, durationMs: metadata.duration_seconds ? Math.round(metadata.duration_seconds * 1000) : null } : null,
      isError: metadata ? metadata.exit_code !== 0 : false
    };
  }

  if (t === 'custom_tool_call_output') {
    let outputText = '';
    const output = payload.output;
    if (typeof output === 'string') {
      outputText = output;
    } else if (output && typeof output === 'object') {
      outputText = output.output || JSON.stringify(output);
    }
    const metadata = (output && typeof output === 'object') ? output.metadata : null;
    return {
      id: payload.call_id || null,
      timestamp: rec.timestamp || null,
      role: 'toolResult',
      content: [{ type: 'text', text: outputText }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: payload.call_id || null,
      toolName: null,
      details: metadata ? { status: metadata.exit_code === 0 ? 'ok' : 'error', exitCode: metadata.exit_code, durationMs: metadata.duration_seconds ? Math.round(metadata.duration_seconds * 1000) : null } : null,
      isError: metadata ? metadata.exit_code !== 0 : false
    };
  }

  if (t === 'reasoning') {
    return {
      id: null,
      timestamp: rec.timestamp || null,
      role: 'reasoning',
      content: [{ type: 'text', text: payload.text || '' }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    };
  }

  return null;
}

async function parseCodexSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      if (rec.type === 'session_meta') {
        const p = rec.payload || {};
        session = {
          id: p.id || null,
          cwd: p.cwd || null,
          timestamp: p.timestamp || null,
          version: p.cli_version || null,
          model: p.model_provider || null
        };
      } else if (rec.type === 'response_item') {
        const msg = normalizeCodexRecord(rec);
        if (msg) messages.push(msg);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { session, messages };
}

app.get('/api/codex/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, CODEX_DIR);
    const sessions = await listCodexSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/codex/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, CODEX_DIR);
    const filePath = await findCodexSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseCodexSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- OMP platform ---

function ompSessionIdFromFile(fileName) {
  // 2026-07-27T09-38-24-417Z_019fa2f0-9821-7000-b125-0afafe16410a.jsonl
  const base = fileName.replace(/\.jsonl$/, '');
  const idx = base.indexOf('_');
  return idx >= 0 ? base.slice(idx + 1) : base;
}

async function findOmpSessionFile(baseDir, sessionId) {
  const dir = baseDir || OMP_DIR;
  // Files live one level deep: {dir}/{cwd-slug}/{timestamp}_{uuid}.jsonl
  const slugs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    const slugDir = path.join(dir, s.name);
    const files = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base.endsWith('_' + sessionId) || base === sessionId) {
        return path.join(slugDir, f.name);
      }
    }
  }
  return null;
}

// Returns the real human prompt text from an OMP user message, or null for
// injected noise (<system-notice>, command echoes) and empty content
function extractOmpUserPromptText(msg) {
  if (msg.attribution && msg.attribution !== 'user') return null;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text || '').join(' ').trim();
  if (!text) return null;
  if (text.startsWith('<')) return null;
  return text;
}

async function parseOmpSessionMetadata(filePath, fileName) {
  // Check mtime cache first
  try {
    const stat = await fsp.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = sessionMetaCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.data;
    }
  } catch {
    // If stat fails, fall through to parse
  }

  const data = await _parseOmpSessionMetadataRaw(filePath, fileName);

  // Update cache
  try {
    const stat = await fsp.stat(filePath);
    sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
  } catch {
    // Non-critical — just skip caching
  }

  return data;
}

async function _parseOmpSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionMeta = null;
  let title = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const toolNames = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      if (rec.timestamp) lastTimestamp = rec.timestamp;

      if (rec.type === 'session' && !sessionMeta) {
        sessionMeta = {
          id: rec.id || ompSessionIdFromFile(fileName),
          timestamp: rec.timestamp || null,
          cwd: rec.cwd || null
        };
        continue;
      }

      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }

      if (rec.type !== 'message') continue;
      messageCount++;
      const msg = rec.message || {};
      if (msg.role === 'user') {
        userCount++;
        if (!firstUserMessage) {
          const text = extractOmpUserPromptText(msg);
          if (text) firstUserMessage = text.slice(0, 120);
        }
      } else if (msg.role === 'assistant') {
        assistantCount++;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const c of content) {
          if (c.type === 'toolCall') {
            toolCallCount++;
            const name = c.name || 'unknown';
            toolNames[name] = (toolNames[name] || 0) + 1;
          }
        }
      } else if (msg.role === 'toolResult') {
        toolResultCount++;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    id: sessionMeta?.id || ompSessionIdFromFile(fileName),
    timestamp: sessionMeta?.timestamp || null,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    title: title || firstUserMessage || null,
    cwd: sessionMeta?.cwd || null,
    file: fileName
  };
}

async function listOmpSessions(baseDir) {
  const dir = baseDir || OMP_DIR;
  const sessions = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }

  for (const s of entries) {
    if (!s.isDirectory()) continue;
    const slugDir = path.join(dir, s.name);
    const files = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      sessions.push(parseOmpSessionMetadata(path.join(slugDir, f.name), f.name));
    }
  }

  const resolved = await Promise.all(sessions);
  resolved.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return resolved;
}

// Maps one OMP record to an array of normalized messages (an assistant record
// fans out into reasoning / text / toolCall entries, codex-style), or null for
// metadata records (title, session, model_change, custom, custom_message,
// ttsr_injection, thinking_level_change)
function normalizeOmpRecord(rec) {
  if (rec.type !== 'message') return null;
  const msg = rec.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];

  if (msg.role === 'user') {
    return [{
      id: rec.id || null,
      timestamp: rec.timestamp || null,
      role: 'user',
      content: content.filter(c => c.type === 'text').map(c => ({ type: 'text', text: c.text || '' })),
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    }];
  }

  if (msg.role === 'assistant') {
    const messages = [];
    const thinkingText = content.filter(c => c.type === 'thinking').map(c => c.thinking || '').join('\n\n').trim();
    if (thinkingText) {
      messages.push({
        id: null,
        timestamp: rec.timestamp || null,
        role: 'reasoning',
        content: [{ type: 'text', text: thinkingText }],
        usage: null,
        model: null,
        provider: null,
        toolCallId: null,
        toolName: null,
        details: null,
        isError: false
      });
    }
    messages.push({
      id: rec.id || null,
      timestamp: rec.timestamp || null,
      role: 'assistant',
      content: content.filter(c => c.type === 'text').map(c => ({ type: 'text', text: c.text || '' })),
      usage: msg.usage || null,
      model: msg.model || null,
      provider: msg.provider || null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    });
    for (const c of content) {
      if (c.type !== 'toolCall') continue;
      messages.push({
        id: c.id || null,
        timestamp: rec.timestamp || null,
        role: 'toolCall',
        content: [],
        usage: null,
        model: null,
        provider: null,
        toolCallId: c.id || null,
        toolName: c.name || null,
        details: c.arguments || null,
        isError: false
      });
    }
    return messages;
  }

  if (msg.role === 'toolResult') {
    return [{
      id: rec.id || null,
      timestamp: rec.timestamp || null,
      role: 'toolResult',
      content: content.filter(c => c.type === 'text').map(c => ({ type: 'text', text: c.text || '' })),
      usage: null,
      model: null,
      provider: null,
      toolCallId: msg.toolCallId || null,
      toolName: msg.toolName || null,
      details: msg.details || null,
      isError: Boolean(msg.isError)
    }];
  }

  return null;
}

async function parseOmpSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  let model = null;
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      if (rec.type === 'session') {
        session = {
          id: rec.id || null,
          cwd: rec.cwd || null,
          timestamp: rec.timestamp || null,
          version: rec.version || null,
          model: null
        };
      } else if (rec.type === 'model_change') {
        if (rec.model) model = rec.model;
      } else if (rec.type === 'message') {
        if (rec.message && rec.message.model) model = rec.message.model;
        const msgs = normalizeOmpRecord(rec);
        if (msgs) messages.push(...msgs);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (session) session.model = model;
  return { session, messages };
}

app.get('/api/omp/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const sessions = await listOmpSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/omp/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const filePath = await findOmpSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseOmpSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Hermes platform (SQLite) ---

function getHermesDbPath(dir) {
  const base = dir || HERMES_DIR;
  return path.join(base, 'state.db');
}

function openHermesDb(dir) {
  const dbPath = getHermesDbPath(dir);
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    return null;
  }
}

function unixToIso(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

function listHermesSessions(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const sessions = db.prepare(`
      SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
             s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
             s.estimated_cost_usd, s.parent_session_id
      FROM sessions s
    `).all();

    if (sessions.length === 0) return [];

    // One query: aggregate all per-session stats from messages
    const stats = db.prepare(`
      SELECT session_id,
             SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_count,
             SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistant_count,
             SUM(CASE WHEN role='tool' THEN 1 ELSE 0 END) as tool_result_count,
             MAX(timestamp) as last_ts
      FROM messages
      GROUP BY session_id
    `).all();
    const statsMap = new Map(stats.map(r => [r.session_id, r]));

    // First user message per session (one query)
    const firstUsers = db.prepare(`
      SELECT session_id, content FROM messages
      WHERE role = 'user' AND rowid IN (
        SELECT MIN(rowid) FROM messages WHERE role = 'user' GROUP BY session_id
      )
    `).all();
    const firstUserMap = new Map(firstUsers.map(r => [r.session_id, r.content]));

    // Top tools per session (parse tool_calls JSON from assistant messages)
    const toolCallRows = db.prepare(`
      SELECT session_id, tool_calls FROM messages
      WHERE role = 'assistant' AND tool_calls IS NOT NULL AND tool_calls != ''
    `).all();
    const toolMap = new Map();
    const spawnMap = new Map();
    for (const row of toolCallRows) {
      let calls;
      try { calls = JSON.parse(row.tool_calls); } catch { continue; }
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        const name = tc?.function?.name || tc?.name;
        if (!name) continue;
        if (!toolMap.has(row.session_id)) toolMap.set(row.session_id, new Map());
        const sessionTools = toolMap.get(row.session_id);
        sessionTools.set(name, (sessionTools.get(name) || 0) + 1);
        if (name === 'delegate_task') {
          spawnMap.set(row.session_id, (spawnMap.get(row.session_id) || 0) + 1);
        }
      }
    }
    // Convert tool maps to sorted arrays
    for (const [sid, tools] of toolMap) {
      const arr = [...tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      toolMap.set(sid, arr);
    }

    const result = sessions.map((s) => {
      const st = statsMap.get(s.id) || {};
      const firstContent = firstUserMap.get(s.id);
      const lastActivity = st.last_ts ? unixToIso(st.last_ts) : unixToIso(s.ended_at);

      return {
        id: s.id,
        timestamp: unixToIso(s.started_at),
        lastActivity,
        messageCount: s.message_count || 0,
        userCount: st.user_count || 0,
        assistantCount: st.assistant_count || 0,
        toolCallCount: s.tool_call_count || 0,
        toolResultCount: st.tool_result_count || 0,
        topTools: toolMap.get(s.id) || [],
        spawnCount: spawnMap.get(s.id) || 0,
        firstUserMessage: firstContent ? firstContent.trim().slice(0, 120) : null,
        model: s.model || null,
        source: s.source || null,
        title: s.title || null,
        inputTokens: s.input_tokens || 0,
        outputTokens: s.output_tokens || 0,
        estimatedCost: s.estimated_cost_usd || null,
        parentSessionId: s.parent_session_id || null,
        status: s.ended_at ? 'archived' : 'active',
        file: 'state.db'
      };
    });

    // Sort by last activity (latest message time) descending
    result.sort((a, b) => {
      const aTime = a.lastActivity ? Date.parse(a.lastActivity) : 0;
      const bTime = b.lastActivity ? Date.parse(b.lastActivity) : 0;
      return bTime - aTime;
    });

    return result;
  } finally {
    db.close();
  }
}

function getHermesSession(dir, sessionId) {
  const db = openHermesDb(dir);
  if (!db) return null;
  try {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;

    const rows = db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId);

    const messages = [];
    for (const row of rows) {
      const msg = normalizeHermesMessage(row);
      if (msg) messages.push(msg);
    }

    const session = {
      id: s.id,
      source: s.source,
      model: s.model,
      title: s.title,
      cwd: null,
      timestamp: unixToIso(s.started_at),
      inputTokens: s.input_tokens || 0,
      outputTokens: s.output_tokens || 0,
      cacheReadTokens: s.cache_read_tokens || 0,
      cacheWriteTokens: s.cache_write_tokens || 0,
      reasoningTokens: s.reasoning_tokens || 0,
      estimatedCost: s.estimated_cost_usd || null,
      actualCost: s.actual_cost_usd || null,
      parentSessionId: s.parent_session_id || null
    };

    return { session, messages };
  } finally {
    db.close();
  }
}

function normalizeHermesMessage(row) {
  const role = row.role;
  const content = row.content || '';
  let toolCalls = null;
  if (row.tool_calls) {
    try { toolCalls = JSON.parse(row.tool_calls); } catch { toolCalls = null; }
  }

  if (role === 'user') {
    return {
      id: String(row.id),
      timestamp: unixToIso(row.timestamp),
      role: 'user',
      content: [{ type: 'text', text: content }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false,
      reasoning: null
    };
  }

  if (role === 'assistant') {
    const unifiedContent = [];
    if (content) {
      unifiedContent.push({ type: 'text', text: content });
    }
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        unifiedContent.push({
          type: 'toolCall',
          id: tc.id || null,
          name: tc.function?.name || tc.name || 'unknown',
          arguments: (() => {
            const raw = tc.function?.arguments || tc.arguments || '{}';
            if (typeof raw === 'string') {
              try { return JSON.parse(raw); } catch { return { _raw: raw }; }
            }
            return raw;
          })()
        });
      }
    }
    return {
      id: String(row.id),
      timestamp: unixToIso(row.timestamp),
      role: 'assistant',
      content: unifiedContent,
      usage: row.token_count ? { total_tokens: row.token_count } : null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false,
      reasoning: row.reasoning || null
    };
  }

  if (role === 'tool') {
    return {
      id: String(row.id),
      timestamp: unixToIso(row.timestamp),
      role: 'toolResult',
      content: [{ type: 'text', text: content }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: row.tool_call_id || null,
      toolName: row.tool_name || null,
      details: null,
      isError: false,
      reasoning: null
    };
  }

  // system or other roles
  if (content) {
    return {
      id: String(row.id),
      timestamp: unixToIso(row.timestamp),
      role: role || 'system',
      content: [{ type: 'text', text: content }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false,
      reasoning: null
    };
  }

  return null;
}

function searchHermesSessions(dir, query, maxResults) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    // Use FTS5 if available, otherwise fall back to LIKE
    let rows;
    try {
      rows = db.prepare(`
        SELECT m.session_id, m.role, m.content, m.timestamp
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH ?
        LIMIT ?
      `).all(query, maxResults * 3);
    } catch {
      const likeQ = `%${query}%`;
      rows = db.prepare(`
        SELECT session_id, role, content, timestamp
        FROM messages
        WHERE content LIKE ?
        LIMIT ?
      `).all(likeQ, maxResults * 3);
    }

    // Group by session
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
      const matches = bySession.get(row.session_id);
      if (matches.length < 3) {
        const text = row.content || '';
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 60);
        const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
        matches.push({ role: row.role, snippet, timestamp: unixToIso(row.timestamp) });
      }
    }

    const results = [];
    for (const [sessionId, matches] of bySession) {
      if (results.length >= maxResults) break;
      results.push({ sessionId, file: 'state.db', platform: 'hermes', matches });
    }
    return results;
  } finally {
    db.close();
  }
}

app.get('/api/hermes/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, HERMES_DIR);
    const sessions = listHermesSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/hermes/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, HERMES_DIR);
    const payload = getHermesSession(dir, sessionId);
    if (!payload) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Claude Code platform ---

async function listClaudeCodeProjects(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function findClaudeCodeSessionFile(baseDir, sessionId) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const projects = await listClaudeCodeProjects(dir);
  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(dirPath, f.name);
      }
    }
    // Check subagents subdirectory
    const subDir = path.join(dirPath, 'subagents');
    const subFiles = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
    for (const f of subFiles) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(subDir, f.name);
      }
    }
  }
  return null;
}

function parseClaudeCodeSessionIdFromFilename(fileName) {
  return fileName.replace(/\.jsonl$/, '');
}

// Returns the real human prompt text from a Claude Code user record, or null if
// the record is noise (tool results, slash commands, injected reminders, etc.)
function extractClaudeCodeUserPromptText(rec) {
  if (rec.isMeta === true) return null;
  const content = rec.message?.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlocks = content.filter(b => b.type === 'text' && (b.text || '').trim());
    const hasToolResult = content.some(b => b.type === 'tool_result');
    if (hasToolResult && textBlocks.length === 0) return null;
    text = textBlocks.map(b => b.text).join('\n');
  }
  if (!text) return null;
  if (text.includes('<command-name>') || text.includes('<command-message>') || text.includes('<local-command-stdout>')) return null;
  if (text.includes('<task-notification>')) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('Caveat:')) return null;
  if (trimmed === '[Request interrupted by user]' || trimmed === '[Request interrupted by user for tool use]') return null;
  // System reminders are appended to real prompts — strip them rather than drop the message
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return text || null;
}

async function parseClaudeCodeSessionMetadata(filePath, fileName) {
  // Check mtime cache first
  try {
    const stat = await fsp.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = sessionMetaCache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return cached.data;
    }
  } catch {
    // If stat fails, fall through to parse
  }

  const data = await _parseClaudeCodeSessionMetadataRaw(filePath, fileName);

  // Update cache
  try {
    const stat = await fsp.stat(filePath);
    sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
  } catch {
    // Non-critical — just skip caching
  }

  return data;
}

async function _parseClaudeCodeSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = null;
  let sessionTimestamp = null;
  let sessionCwd = null;
  let sessionSlug = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const toolNames = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      const t = rec.type;

      if (t === 'user') {
        messageCount++;
        userCount++;
        const content = rec.message?.content;
        // Extract first real user prompt text (filters tool results / injected noise)
        if (!firstUserMessage) {
          const t = extractClaudeCodeUserPromptText(rec);
          if (t) firstUserMessage = t.slice(0, 120);
        }
        // Check if this user message contains tool_result blocks
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') toolResultCount++;
          }
        }
        if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
        if (!sessionCwd && rec.cwd) sessionCwd = rec.cwd;
        if (!sessionSlug && rec.slug) sessionSlug = rec.slug;
      } else if (t === 'assistant') {
        messageCount++;
        assistantCount++;
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
              const name = block.name || 'unknown';
              toolNames[name] = (toolNames[name] || 0) + 1;
            }
          }
        }
      } else if (t === 'system' && rec.subtype === 'turn_duration') {
        // Skip system turn_duration records for message counting
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;
      if (!sessionTimestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        sessionTimestamp = rec.timestamp;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    id: sessionId || parseClaudeCodeSessionIdFromFilename(fileName),
    timestamp: sessionTimestamp,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    cwd: sessionCwd,
    slug: sessionSlug,
    file: fileName
  };
}

async function listClaudeCodeSessions(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const sessions = [];
  const projects = await listClaudeCodeProjects(dir);

  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      sessions.push(parseClaudeCodeSessionMetadata(path.join(dirPath, f.name), f.name));
    }
  }

  const resolved = await Promise.all(sessions);
  resolved.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return resolved;
}

function normalizeClaudeCodeRecord(rec) {
  const t = rec.type;

  if (t === 'user') {
    const msg = rec.message || {};
    const content = msg.content;

    if (typeof content === 'string') {
      // Plain user text message
      return {
        id: rec.uuid || null,
        timestamp: rec.timestamp || null,
        role: 'user',
        content: [{ type: 'text', text: content }],
        usage: null,
        model: null,
        provider: null,
        toolCallId: null,
        toolName: null,
        details: null,
        isError: false
      };
    }

    if (Array.isArray(content)) {
      // Check if this is purely tool_result blocks
      const hasToolResult = content.some(b => b.type === 'tool_result');
      const hasText = content.some(b => b.type === 'text');

      if (hasToolResult && !hasText) {
        // This is a tool result message — return as toolResult
        const textParts = content
          .filter(b => b.type === 'tool_result')
          .map(b => {
            const inner = b.content;
            if (typeof inner === 'string') return inner;
            if (Array.isArray(inner)) return inner.filter(ib => ib.type === 'text').map(ib => ib.text || '').join('\n');
            return JSON.stringify(inner);
          });
        const toolResultBlock = content.find(b => b.type === 'tool_result');
        const isError = toolResultBlock?.is_error || false;
        return {
          id: rec.uuid || null,
          timestamp: rec.timestamp || null,
          role: 'toolResult',
          content: [{ type: 'text', text: textParts.join('\n\n') }],
          usage: null,
          model: null,
          provider: null,
          toolCallId: toolResultBlock?.tool_use_id || null,
          toolName: null,
          details: rec.toolUseResult && typeof rec.toolUseResult === 'object'
            ? { stdout: rec.toolUseResult.stdout ? String(rec.toolUseResult.stdout).slice(0, 200) : null, stderr: rec.toolUseResult.stderr ? String(rec.toolUseResult.stderr).slice(0, 200) : null }
            : (typeof rec.toolUseResult === 'string' ? { error: rec.toolUseResult } : null),
          isError
        };
      }

      // Mixed content or text-only array — extract text
      const textParts = content
        .filter(b => b.type === 'text')
        .map(b => b.text || '');
      return {
        id: rec.uuid || null,
        timestamp: rec.timestamp || null,
        role: 'user',
        content: [{ type: 'text', text: textParts.join('\n\n') }],
        usage: null,
        model: null,
        provider: null,
        toolCallId: null,
        toolName: null,
        details: null,
        isError: false
      };
    }

    // Fallback: no content
    return {
      id: rec.uuid || null,
      timestamp: rec.timestamp || null,
      role: 'user',
      content: [],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    };
  }

  if (t === 'assistant') {
    const msg = rec.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    const textParts = content.filter(b => b.type === 'text').map(b => b.text || '');
    const toolUseBlocks = content.filter(b => b.type === 'tool_use');

    // Build content array matching our unified format
    const unifiedContent = textParts.map(text => ({ type: 'text', text }));
    // Add toolUse blocks as 'toolCall' type (matching OpenClaw format)
    for (const block of toolUseBlocks) {
      unifiedContent.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input || {}
      });
    }

    return {
      id: rec.uuid || null,
      timestamp: rec.timestamp || null,
      role: 'assistant',
      content: unifiedContent,
      usage: msg.usage || null,
      model: msg.model || null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false
    };
  }

  return null;
}

async function parseClaudeCodeSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }

      const t = rec.type;

      if (!session && rec.sessionId) {
        session = {
          id: rec.sessionId,
          cwd: rec.cwd || null,
          timestamp: null,
          version: rec.version || null
        };
      }

      // Update session cwd if we find it on a later record
      if (session && !session.cwd && rec.cwd) {
        session.cwd = rec.cwd;
      }

      if (!session?.timestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        session.timestamp = rec.timestamp;
      }

      if (t === 'user' || t === 'assistant') {
        const msg = normalizeClaudeCodeRecord(rec);
        if (msg) messages.push(msg);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { session, messages };
}

app.get('/api/claude-code/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const sessions = await listClaudeCodeSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/claude-code/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const filePath = await findClaudeCodeSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseClaudeCodeSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Prompt Library: curated prompts stored as markdown files with frontmatter ---
// Storage: LIBRARY_DIR/<name>.md — frontmatter between `---` lines with keys
// description, tags (comma-separated), source, createdAt; body = prompt content.
// Install targets copy the prompt as a native slash command file.

const LIBRARY_DIR = process.env.AGENTXRAY_LIBRARY_DIR || path.join(HOME, '.agentxray', 'library');
const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INSTALL_TARGETS = {
  claude: path.join(HOME, '.claude', 'commands'),
  codex: path.join(HOME, '.codex', 'prompts'),
  omp: path.join(HOME, '.omp', 'agent', 'commands'),
};

function sanitizeLibraryName(name) {
  return typeof name === 'string' && LIBRARY_NAME_RE.test(name) ? name : null;
}

function libraryFilePath(name) {
  return path.join(LIBRARY_DIR, `${name}.md`);
}

function installedFilePath(target, name) {
  return path.join(INSTALL_TARGETS[target], `${name}.md`);
}

function normalizeLibraryTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

// Parse the `---` frontmatter block. Files without frontmatter are tolerated:
// the whole file becomes the content.
function parseLibraryFile(raw) {
  const meta = { description: '', tags: [], source: 'manual', createdAt: null };
  if (!raw.startsWith('---\n')) return { meta, content: raw };
  const close = raw.indexOf('\n---', 4);
  if (close === -1) return { meta, content: raw };
  const header = raw.slice(4, close);
  const afterClose = raw.indexOf('\n', close + 1);
  const content = (afterClose === -1 ? '' : raw.slice(afterClose + 1)).replace(/^\n+/, '');
  for (const line of header.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === 'description') meta.description = value;
    else if (key === 'source') meta.source = value || 'manual';
    else if (key === 'createdAt') meta.createdAt = value || null;
    else if (key === 'tags') meta.tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return { meta, content };
}

function serializeLibraryFile(meta, content) {
  const lines = [
    '---',
    `description: ${meta.description || ''}`,
    `tags: ${(meta.tags || []).join(', ')}`,
    `source: ${meta.source || 'manual'}`,
    `createdAt: ${meta.createdAt || ''}`,
    '---',
    '',
  ];
  return `${lines.join('\n')}${content.replace(/\n*$/, '\n')}`;
}

// Installed slash-command file: frontmatter with description only + prompt body
function serializeInstalledFile(description, content) {
  return `---\ndescription: ${description || ''}\n---\n\n${content.replace(/\n*$/, '\n')}`;
}

// Installed detection: file exists at the target path
async function detectInstalled(name) {
  const installed = {};
  await Promise.all(Object.keys(INSTALL_TARGETS).map(async (target) => {
    installed[target] = await fsp.access(installedFilePath(target, name)).then(() => true, () => false);
  }));
  return installed;
}

async function readLibraryPrompt(name) {
  const raw = await fsp.readFile(libraryFilePath(name), 'utf8');
  const { meta, content } = parseLibraryFile(raw);
  return {
    name,
    description: meta.description,
    tags: meta.tags,
    source: meta.source,
    createdAt: meta.createdAt,
    content,
    installed: await detectInstalled(name),
  };
}

// Write the prompt copy into the given install targets (mkdir -p on demand)
async function installLibraryPrompt(prompt, targets) {
  for (const target of targets) {
    await fsp.mkdir(INSTALL_TARGETS[target], { recursive: true });
    await fsp.writeFile(installedFilePath(target, prompt.name), serializeInstalledFile(prompt.description, prompt.content), 'utf8');
  }
}

// Remove installed copies from the given targets, ignoring missing files
async function uninstallLibraryPrompt(name, targets) {
  for (const target of targets) {
    await fsp.unlink(installedFilePath(target, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function parseInstallTargets(body) {
  const targets = body && Array.isArray(body.targets) ? body.targets : null;
  if (!targets || targets.length === 0) return null;
  if (!targets.every((target) => Object.prototype.hasOwnProperty.call(INSTALL_TARGETS, target))) return null;
  return [...new Set(targets)];
}

app.get('/api/library', async (req, res) => {
  try {
    let entries;
    try {
      entries = await fsp.readdir(LIBRARY_DIR);
    } catch (error) {
      if (error.code === 'ENOENT') return res.json({ prompts: [] });
      throw error;
    }
    const names = entries
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -3))
      .filter((name) => LIBRARY_NAME_RE.test(name));
    const prompts = await Promise.all(names.map((name) => readLibraryPrompt(name)));
    prompts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ prompts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library', async (req, res) => {
  try {
    const body = req.body || {};
    const name = sanitizeLibraryName(body.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
    }
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    const meta = {
      description: typeof body.description === 'string' ? body.description : '',
      tags: normalizeLibraryTags(body.tags),
      source: typeof body.source === 'string' && body.source ? body.source : 'manual',
      createdAt: new Date().toISOString(),
    };
    await fsp.mkdir(LIBRARY_DIR, { recursive: true });
    try {
      await fsp.writeFile(libraryFilePath(name), serializeLibraryFile(meta, content), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') return res.status(409).json({ error: `Prompt "${name}" already exists` });
      throw error;
    }
    res.status(201).json({ prompt: await readLibraryPrompt(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/library/:name', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const body = req.body || {};
    let raw;
    try {
      raw = await fsp.readFile(libraryFilePath(name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    const { meta, content } = parseLibraryFile(raw);

    let newName = name;
    if (body.newName !== undefined && body.newName !== name) {
      newName = sanitizeLibraryName(body.newName);
      if (!newName) {
        return res.status(400).json({ error: 'Invalid newName: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
      }
      const exists = await fsp.access(libraryFilePath(newName)).then(() => true, () => false);
      if (exists) return res.status(409).json({ error: `Prompt "${newName}" already exists` });
    }

    if (body.description !== undefined) meta.description = typeof body.description === 'string' ? body.description : '';
    if (body.tags !== undefined) meta.tags = normalizeLibraryTags(body.tags);
    const nextContent = body.content !== undefined ? String(body.content) : content;
    if (!nextContent.trim()) {
      return res.status(400).json({ error: 'content must not be empty' });
    }

    await fsp.writeFile(libraryFilePath(newName), serializeLibraryFile(meta, nextContent), 'utf8');
    if (newName !== name) {
      await fsp.unlink(libraryFilePath(name)).catch(() => {});
    }

    // Refresh installed copies; a rename also renames them
    for (const target of Object.keys(INSTALL_TARGETS)) {
      const wasInstalled = await fsp.access(installedFilePath(target, name)).then(() => true, () => false);
      if (!wasInstalled) continue;
      if (newName !== name) await uninstallLibraryPrompt(name, [target]);
      await installLibraryPrompt({ name: newName, description: meta.description, content: nextContent }, [target]);
    }

    res.json({ prompt: await readLibraryPrompt(newName) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/library/:name', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    try {
      await fsp.unlink(libraryFilePath(name));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    await uninstallLibraryPrompt(name, Object.keys(INSTALL_TARGETS));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library/:name/install', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const targets = parseInstallTargets(req.body);
    if (!targets) {
      return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
    }
    let prompt;
    try {
      prompt = await readLibraryPrompt(name);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    await installLibraryPrompt(prompt, targets);
    res.json({ installed: await detectInstalled(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library/:name/uninstall', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const targets = parseInstallTargets(req.body);
    if (!targets) {
      return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
    }
    await uninstallLibraryPrompt(name, targets);
    res.json({ installed: await detectInstalled(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========= Real-time SSE tail endpoint =========
// GET /api/watch?platform=openclaw&agent=NAME&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=codex&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=claude-code&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=hermes&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=omp&sessionId=ID[&dir=PATH]
// Streams Server-Sent Events:
//   event: connected     data: {"messageCount": N}
//   event: newMessages   data: {"messages": [...normalized], "session": {...}}
//   event: error         data: {"error": "..."}

app.get('/api/watch', async (req, res) => {
  const platform  = req.query.platform || 'openclaw';
  const agentName = sanitizeAgentName(req.query.agent || '');
  const sessionId = sanitizeSessionId(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  // Resolve the JSONL file path
  let filePath;
  try {
    if (platform === 'openclaw') {
      if (!agentName) return res.status(400).json({ error: 'agent required for openclaw' });
      const dir = resolveDir(req.query.dir, DATA_DIR);
      filePath = await resolveSessionFile(dir, agentName, sessionId);
    } else if (platform === 'codex') {
      const dir = resolveDir(req.query.dir, CODEX_DIR);
      filePath = await findCodexSessionFile(dir, sessionId);
    } else if (platform === 'claude-code') {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      filePath = await findClaudeCodeSessionFile(dir, sessionId);
    } else if (platform === 'omp') {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      filePath = await findOmpSessionFile(dir, sessionId);
    } else if (platform === 'hermes') {
      // Hermes uses SQLite, not file-based SSE — handle separately below
    } else {
      return res.status(400).json({ error: 'Unknown platform' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!filePath && platform !== 'hermes') return res.status(404).json({ error: 'Session not found' });

  // Hermes: WAL file watch-based SSE
  if (platform === 'hermes') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sendHermes(eventName, data) {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const hermesDir = resolveDir(req.query.dir, HERMES_DIR);
    const dbPath = getHermesDbPath(hermesDir);
    const walPath = dbPath + '-wal';

    // Keep one persistent read-only connection
    let db = null;
    let lastTimestamp = 0;
    try {
      if (fs.existsSync(dbPath)) {
        db = new Database(dbPath, { readonly: true });
        db.pragma('journal_mode = WAL');
        const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId);
        sendHermes('connected', { messageCount: row ? row.cnt : 0 });
        const lastMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?').get(sessionId);
        lastTimestamp = lastMsg?.ts || 0;
      } else {
        sendHermes('connected', { messageCount: 0 });
      }
    } catch (e) {
      sendHermes('error', { error: e.message });
    }

    const newMsgStmt = db ? db.prepare('SELECT * FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC') : null;

    function checkNewMessages() {
      if (!db || !newMsgStmt) return;
      try {
        const newRows = newMsgStmt.all(sessionId, lastTimestamp);
        if (newRows.length > 0) {
          lastTimestamp = newRows[newRows.length - 1].timestamp;
          const newMsgs = newRows.map(normalizeHermesMessage).filter(Boolean);
          if (newMsgs.length > 0) {
            sendHermes('newMessages', { messages: newMsgs });
          }
        }
      } catch (e) {
        sendHermes('error', { error: e.message });
      }
    }

    // Watch WAL file for changes (Hermes writes trigger WAL updates)
    let closed = false;
    let debounceTimer = null;
    let watcher = null;
    try {
      watcher = fs.watch(walPath, (eventType) => {
        if (eventType === 'change') {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(checkNewMessages, 50);
        }
      });
    } catch {
      // WAL file may not exist yet — watch dbPath as fallback
      try {
        watcher = fs.watch(dbPath, (eventType) => {
          if (eventType === 'change') {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(checkNewMessages, 50);
          }
        });
      } catch {}
    }

    const pingTimer = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearTimeout(debounceTimer);
      clearInterval(pingTimer);
      if (watcher) try { watcher.close(); } catch {}
      if (db) { try { db.close(); } catch {} db = null; }
    });
    return;
  }

  // Helper: read new lines from a byte offset, return {lines, newOffset}
  async function readNewLines(byteOffset) {
    const stat = await fsp.stat(filePath);
    if (stat.size <= byteOffset) return { lines: [], newOffset: byteOffset };
    const buf = Buffer.alloc(stat.size - byteOffset);
    const fd = await fsp.open(filePath, 'r');
    try {
      await fd.read(buf, 0, buf.length, byteOffset);
    } finally {
      await fd.close();
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());
    return { lines, newOffset: stat.size };
  }

  // Helper: normalize lines according to platform
  function parseLines(lines) {
    const messages = [];
    let sessionMeta = null;
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (platform === 'openclaw') {
        if (rec.type === 'session') {
          sessionMeta = { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp };
        } else if (rec.type === 'message') {
          messages.push(normalizeMessage(rec));
        }
      } else if (platform === 'codex') {
        const normalized = normalizeCodexRecord(rec);
        if (normalized) messages.push(normalized);
      } else if (platform === 'claude-code') {
        const normalized = normalizeClaudeCodeRecord(rec);
        if (normalized) messages.push(normalized);
      } else if (platform === 'omp') {
        if (rec.type === 'session') {
          sessionMeta = { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp };
        } else {
          const normalized = normalizeOmpRecord(rec);
          if (normalized && normalized.length) messages.push(...normalized);
        }
      }
    }
    return { messages, sessionMeta };
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Do initial full parse to know current message count + byte offset
  let byteOffset = 0;
  let initialMessageCount = 0;
  try {
    const stat = await fsp.stat(filePath);
    byteOffset = stat.size;
    // Count existing messages without sending them (client already has them)
    const { lines } = await readNewLines(0).then(async () => {
      const all = await fsp.readFile(filePath, 'utf8');
      const ls = all.split('\n').filter(l => l.trim());
      return { lines: ls };
    });
    const { messages: existingMsgs } = parseLines(lines);
    initialMessageCount = existingMsgs.length;
  } catch (e) {
    send('error', { error: e.message });
    return res.end();
  }

  send('connected', { messageCount: initialMessageCount });

  // Watch for file changes
  let watcher;
  let debounceTimer = null;
  let closed = false;

  const onFileChange = async () => {
    if (closed) return;
    try {
      const { lines, newOffset } = await readNewLines(byteOffset);
      if (lines.length === 0) return;
      byteOffset = newOffset;
      const { messages, sessionMeta } = parseLines(lines);
      if (messages.length > 0) {
        const payload = { messages };
        if (sessionMeta) payload.session = sessionMeta;
        send('newMessages', payload);
      }
      // Invalidate metadata cache so next session list refresh picks up changes
      sessionMetaCache.delete(filePath);
    } catch (e) {
      send('error', { error: e.message });
    }
  };

  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce: batch rapid writes (e.g. multiple lines written close together)
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onFileChange, 80);
      }
    });
  } catch (e) {
    send('error', { error: `Cannot watch file: ${e.message}` });
    return res.end();
  }

  // Keepalive ping every 15s to prevent proxy timeouts
  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher) watcher.close();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AgentXRay listening on http://${HOST}:${PORT}`);
  console.log(`  OpenClaw:    ${DATA_DIR}`);
  console.log(`  Codex:       ${CODEX_DIR}`);
  console.log(`  Claude Code: ${CLAUDE_CODE_DIR}`);
  console.log(`  Hermes:      ${path.join(HERMES_DIR, 'state.db')}`);
});
