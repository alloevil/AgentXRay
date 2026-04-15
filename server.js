const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3800;
const HOME = process.env.HOME || '/root';
const DATA_DIR = process.env.OPENCLAW_DIR || path.join(HOME, '.openclaw', 'agents');

// ========= Session Metadata Cache =========
// Key: absolute file path  →  { mtime: number, data: sessionMetadataObject }
const sessionMetaCache = new Map();
const CODEX_DIR = process.env.CODEX_DIR || path.join(HOME, '.codex', 'sessions');
const CLAUDE_CODE_DIR = process.env.CLAUDE_CODE_DIR || path.join(HOME, '.claude', 'projects');
const HERMES_DIR = process.env.HERMES_DIR || path.join(HOME, '.hermes');
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
            let texts = content.filter(c => c.type === 'text').map(c => c.text || '').join(' ').trim();
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
            texts = texts.trim();
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
    }

    const results = [];

    for (const sf of sessionFiles) {
      if (results.length >= maxResults) break;
      const matches = [];
      const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let sessionId = sf.file.split('.jsonl')[0];

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

  // Find root sessions: appear as parents but not as children
  const childSessionIds = new Set();
  for (const children of parentToChildren.values()) {
    for (const c of children) childSessionIds.add(c.sessionId);
  }

  const roots = [];
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

    // Top tools per session (one query, no per-session LIMIT — we limit in JS)
    const toolRows = db.prepare(`
      SELECT session_id, tool_name, COUNT(*) as cnt
      FROM messages
      WHERE tool_name IS NOT NULL AND tool_name != ''
      GROUP BY session_id, tool_name
      ORDER BY cnt DESC
    `).all();
    const toolMap = new Map();
    for (const row of toolRows) {
      if (!toolMap.has(row.session_id)) toolMap.set(row.session_id, []);
      const arr = toolMap.get(row.session_id);
      if (arr.length < 5) arr.push({ name: row.tool_name, count: row.cnt });
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
        firstUserMessage: firstContent ? firstContent.trim().slice(0, 120) : null,
        model: s.model || null,
        source: s.source || null,
        title: s.title || null,
        inputTokens: s.input_tokens || 0,
        outputTokens: s.output_tokens || 0,
        estimatedCost: s.estimated_cost_usd || null,
        parentSessionId: s.parent_session_id || null,
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
      actualCost: s.actual_cost_usd || null
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
        // Extract first user message text
        if (!firstUserMessage) {
          if (typeof content === 'string' && content.trim()) {
            firstUserMessage = content.trim().slice(0, 120);
          } else if (Array.isArray(content)) {
            const texts = content.filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
            if (texts) firstUserMessage = texts.slice(0, 120);
          }
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

// ========= Real-time SSE tail endpoint =========
// GET /api/watch?platform=openclaw&agent=NAME&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=codex&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=claude-code&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=hermes&sessionId=ID[&dir=PATH]
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

app.listen(PORT, () => {
  console.log(`AgentXRay listening on http://localhost:${PORT}`);
  console.log(`  OpenClaw:    ${DATA_DIR}`);
  console.log(`  Codex:       ${CODEX_DIR}`);
  console.log(`  Claude Code: ${CLAUDE_CODE_DIR}`);
  console.log(`  Hermes:      ${path.join(HERMES_DIR, 'state.db')}`);
});
