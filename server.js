const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3800;
const HOME = process.env.HOME || '/root';
const DATA_DIR = process.env.OPENCLAW_DIR || path.join(HOME, '.openclaw', 'agents');
const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex', 'sessions');
const CLAUDE_CODE_DIR = process.env.CLAUDE_CODE_DIR || path.join(HOME, '.claude', 'projects');
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

async function parseSessionMetadata(filePath, fileName) {
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
  const toolNames = {};

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

        if (role === 'user') userCount++;
        if (role === 'assistant') assistantCount++;
        if (role === 'toolResult') toolResultCount++;

        // Count tool calls and spawn calls within assistant messages
        const content = Array.isArray(msg.content) ? msg.content : [];
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

app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: false, lastModified: false }));

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

async function parseCodexSessionMetadata(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionMeta = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
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
          if (payload.role === 'user') userCount++;
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

async function parseClaudeCodeSessionMetadata(filePath, fileName) {
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
        // Check if this user message contains tool_result blocks
        const content = rec.message?.content;
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

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Agent Logs Viewer listening on http://localhost:${PORT}`);
  console.log(`  OpenClaw:    ${DATA_DIR}`);
  console.log(`  Codex:       ${CODEX_DIR}`);
  console.log(`  Claude Code: ${CLAUDE_CODE_DIR}`);
});
