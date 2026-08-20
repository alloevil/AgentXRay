const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { OMP_DIR } = require('../config');
const { withMetadataCache, makeMessage, sortSessionsByTimestampDesc, topToolsOf } = require('./shared');

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
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.startsWith('<')) return null;
  return text;
}

const parseOmpSessionMetadata = withMetadataCache(_parseOmpSessionMetadataRaw);

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
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;

      if (rec.type === 'session' && !sessionMeta) {
        sessionMeta = {
          id: rec.id || ompSessionIdFromFile(fileName),
          timestamp: rec.timestamp || null,
          cwd: rec.cwd || null,
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

  const topTools = topToolsOf(toolNames);

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
    file: fileName,
  };
}

async function listOmpSessions(baseDir) {
  const dir = baseDir || OMP_DIR;
  const sessions = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

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
  return sortSessionsByTimestampDesc(resolved);
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
    return [
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'user',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
      }),
    ];
  }

  if (msg.role === 'assistant') {
    const messages = [];
    const thinkingText = content
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking || '')
      .join('\n\n')
      .trim();
    if (thinkingText) {
      messages.push(
        makeMessage({
          timestamp: rec.timestamp || null,
          role: 'reasoning',
          content: [{ type: 'text', text: thinkingText }],
        })
      );
    }
    messages.push(
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'assistant',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        usage: msg.usage || null,
        model: msg.model || null,
        provider: msg.provider || null,
      })
    );
    for (const c of content) {
      if (c.type !== 'toolCall') continue;
      messages.push(
        makeMessage({
          id: c.id || null,
          timestamp: rec.timestamp || null,
          role: 'toolCall',
          toolCallId: c.id || null,
          toolName: c.name || null,
          details: c.arguments || null,
        })
      );
    }
    return messages;
  }

  if (msg.role === 'toolResult') {
    return [
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'toolResult',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        toolCallId: msg.toolCallId || null,
        toolName: msg.toolName || null,
        details: msg.details || null,
        isError: Boolean(msg.isError),
      }),
    ];
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
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (rec.type === 'session') {
        session = {
          id: rec.id || null,
          cwd: rec.cwd || null,
          timestamp: rec.timestamp || null,
          version: rec.version || null,
          model: null,
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

// OMP subagents: a session that spawns children keeps them as
// <slug>/<timestamp>_<sessionId>/<AgentName>.jsonl next to its own file.
async function findOmpSpawnDir(baseDir, sessionId) {
  const filePath = await findOmpSessionFile(baseDir, sessionId);
  if (!filePath) return null;
  const spawnDir = filePath.replace(/\.jsonl$/, '');
  try {
    const st = await fsp.stat(spawnDir);
    return st.isDirectory() ? spawnDir : null;
  } catch {
    return null;
  }
}

module.exports = {
  ompSessionIdFromFile,
  findOmpSessionFile,
  extractOmpUserPromptText,
  parseOmpSessionMetadata,
  listOmpSessions,
  normalizeOmpRecord,
  parseOmpSessionFile,
  findOmpSpawnDir,
};
