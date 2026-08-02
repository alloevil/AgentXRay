const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const {
  DATA_DIR, HERMES_DIR, sessionMetaCache,
  isArchivedFile, isSessionLogFile, ensureDirectory, readAgents,
} = require('../config');
const { openHermesDb, unixToIso } = require('./hermes');

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

module.exports = {
  stripOpenClawNoise,
  parseSessionMetadata,
  listSessionsForAgent,
  resolveSessionFile,
  normalizeMessage,
  parseSessionFile,
  buildSpawnMap,
  buildSpawnTree,
};
