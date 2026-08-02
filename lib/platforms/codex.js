const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CODEX_DIR, sessionMetaCache } = require('../config');

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

module.exports = {
  codexSessionIdFromFile,
  findCodexSessionFile,
  extractCodexUserPromptText,
  parseCodexSessionMetadata,
  listCodexSessions,
  normalizeCodexRecord,
  parseCodexSessionFile,
};
