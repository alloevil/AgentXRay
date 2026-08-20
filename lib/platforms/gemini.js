const fsp = require('fs/promises');
const path = require('path');
const { GEMINI_DIR, sessionMetaCache } = require('../config');

// --- Gemini CLI platform adapter ---
// Sessions live at <root>/<projectHash>/chats/session-<YYYY-MM-DDTHH-mm>-<id8>.jsonl,
// root defaulting to ~/.gemini/tmp (GEMINI_DIR override). Subagent transcripts
// nest one level deeper (chats/<parentSessionId>/<id>.jsonl) and are skipped by
// the top-level listing.
//
// The log is JSONL (gemini-cli packages/core chatRecordingService): line 1 is a
// metadata record ({sessionId, projectHash, startTime, lastUpdated, kind?, …}),
// then one record per message ({id, timestamp, type, content, …}). Assistant
// records are type:'gemini' and carry toolCalls[] ({id, name, args, result?,
// status}), thoughts[] and tokens. Special records fold the stream:
//   {$rewindTo: <messageId>}  — /rewind: drop that message and everything after
//   {$set: {…}}               — metadata update; $set.messages replaces history
// Messages are keyed by id: a re-appended id overwrites the earlier record.
// Very old sessions are a single-line JSON object with a messages[] array —
// the metadata line then IS the whole record, which the same fold handles.

const SESSION_FILE_RE = /^session-.*\.jsonl$/;

function firstTextOfContent(content) {
  // Gemini content is a PartListUnion: string | Part[] | Part
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

async function findGeminiSessionFile(baseDir, sessionId) {
  const dir = baseDir || GEMINI_DIR;
  const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chatsDir = path.join(dir, p.name, 'chats');
    const files = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !SESSION_FILE_RE.test(f.name)) continue;
      const filePath = path.join(chatsDir, f.name);
      // Filenames embed only the first 8 id chars — match on the metadata line.
      if (f.name.includes(sessionId.slice(0, 8))) {
        const meta = await readGeminiMetadataLine(filePath);
        if (meta && meta.sessionId === sessionId) return filePath;
      }
    }
  }
  // Second pass: resumed sessions keep their original filename but the
  // metadata sessionId may have been rewritten — match any file's metadata.
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chatsDir = path.join(dir, p.name, 'chats');
    const files = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !SESSION_FILE_RE.test(f.name)) continue;
      const filePath = path.join(chatsDir, f.name);
      const { session } = await parseGeminiSessionFile(filePath).catch(() => ({ session: null }));
      if (session && session.id === sessionId) return filePath;
    }
  }
  return null;
}

async function readGeminiMetadataLine(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  try {
    const rec = JSON.parse(first);
    return rec && typeof rec.sessionId === 'string' ? rec : null;
  } catch {
    return null;
  }
}

// Fold the record stream into { metadata, messages[] } honoring $rewindTo,
// $set (metadata updates + full-history checkpoints) and id-keyed overwrite.
function foldGeminiRecords(lines) {
  let metadata = {};
  const messagesMap = new Map(); // id → record, insertion-ordered

  const addMessage = (rec) => {
    if (messagesMap.has(rec.id)) messagesMap.delete(rec.id); // move to the end
    messagesMap.set(rec.id, rec);
  };

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;

    if (typeof rec.$rewindTo === 'string') {
      // Drop the rewind target and everything after it
      let found = false;
      for (const id of [...messagesMap.keys()]) {
        if (id === rec.$rewindTo) found = true;
        if (found) messagesMap.delete(id);
      }
      if (!found) messagesMap.clear();
      continue;
    }

    if (rec.$set && typeof rec.$set === 'object') {
      if (Array.isArray(rec.$set.messages)) {
        // Checkpoint: replace the whole history
        messagesMap.clear();
        for (const msg of rec.$set.messages) {
          if (msg && typeof msg.id === 'string') addMessage(msg);
        }
      }
      metadata = { ...metadata, ...rec.$set };
      continue;
    }

    if (typeof rec.id === 'string') {
      addMessage(rec);
      continue;
    }

    if (typeof rec.sessionId === 'string') {
      // Metadata line — legacy single-line records also carry messages[]
      metadata = { ...metadata, ...rec };
      if (Array.isArray(rec.messages)) {
        for (const msg of rec.messages) {
          if (msg && typeof msg.id === 'string') addMessage(msg);
        }
      }
    }
  }

  return { metadata, messages: [...messagesMap.values()] };
}

function stringifyToolResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const text = result.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
    if (text) return text;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  if (typeof result === 'object' && typeof result.text === 'string') return result.text;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// Map one folded Gemini message record onto normalized messages. A 'gemini'
// record fans out codex-style: reasoning (thoughts) → text → per-tool-call
// toolCall + toolResult (Gemini stores the result inline on the call record).
function normalizeGeminiRecord(rec) {
  const out = [];
  const timestamp = rec.timestamp || null;

  if (rec.type === 'user') {
    out.push({
      id: rec.id || null,
      timestamp,
      role: 'user',
      content: [{ type: 'text', text: firstTextOfContent(rec.content) }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false,
    });
    return out;
  }

  if (rec.type === 'gemini') {
    const thoughts = Array.isArray(rec.thoughts) ? rec.thoughts : [];
    const reasoningText = thoughts
      .map((t) => [t.subject, t.description].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('\n\n');
    if (reasoningText) {
      out.push({
        id: rec.id ? `${rec.id}-reasoning` : null,
        timestamp,
        role: 'reasoning',
        content: [{ type: 'text', text: reasoningText }],
        usage: null,
        model: rec.model || null,
        provider: null,
        toolCallId: null,
        toolName: null,
        details: null,
        isError: false,
      });
    }

    const text = firstTextOfContent(rec.content);
    const tokens = rec.tokens || null;
    if (text.trim() || tokens) {
      out.push({
        id: rec.id || null,
        timestamp,
        role: 'assistant',
        content: text.trim() ? [{ type: 'text', text }] : [],
        usage: tokens
          ? {
              input: tokens.input || 0,
              output: tokens.output || 0,
              cacheRead: tokens.cached || 0,
              reasoning: tokens.thoughts || 0,
            }
          : null,
        model: rec.model || null,
        provider: null,
        toolCallId: null,
        toolName: null,
        details: null,
        isError: false,
      });
    }

    for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
      out.push({
        id: call.id || null,
        timestamp: call.timestamp || timestamp,
        role: 'toolCall',
        content: [],
        usage: null,
        model: null,
        provider: null,
        toolCallId: call.id || null,
        toolName: call.name || null,
        details: call.args || null,
        isError: false,
      });
      if (call.result !== undefined && call.result !== null) {
        out.push({
          id: call.id ? `${call.id}-result` : null,
          timestamp: call.timestamp || timestamp,
          role: 'toolResult',
          content: [{ type: 'text', text: stringifyToolResult(call.result) }],
          usage: null,
          model: null,
          provider: null,
          toolCallId: call.id || null,
          toolName: call.name || null,
          details: null,
          isError: call.status === 'error',
        });
      } else if (call.status === 'error' || call.status === 'cancelled') {
        out.push({
          id: call.id ? `${call.id}-result` : null,
          timestamp: call.timestamp || timestamp,
          role: 'toolResult',
          content: [{ type: 'text', text: `Tool call ${call.status}` }],
          usage: null,
          model: null,
          provider: null,
          toolCallId: call.id || null,
          toolName: call.name || null,
          details: null,
          isError: true,
        });
      }
    }
    return out;
  }

  if (rec.type === 'error') {
    out.push({
      id: rec.id || null,
      timestamp,
      role: 'error',
      content: [{ type: 'text', text: firstTextOfContent(rec.content) }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: true,
    });
    return out;
  }

  // info / warning records are CLI chrome, not conversation content
  return out;
}

// Real human prompt text from a user record, or null for slash-command noise
// and empty content.
function extractGeminiUserPromptText(rec) {
  if (!rec || rec.type !== 'user') return null;
  const text = firstTextOfContent(rec.content).trim();
  if (!text) return null;
  if (text.startsWith('/') || text.startsWith('@') || text.startsWith('<')) return null;
  return text;
}

async function parseGeminiSessionMetadata(filePath, fileName) {
  try {
    const stat = await fsp.stat(filePath);
    const cached = sessionMetaCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
  } catch {
    /* fall through to parse */
  }

  const data = await _parseGeminiSessionMetadataRaw(filePath, fileName);

  try {
    const stat = await fsp.stat(filePath);
    sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
  } catch {
    /* non-critical */
  }
  return data;
}

async function _parseGeminiSessionMetadataRaw(filePath, fileName) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const { metadata, messages } = foldGeminiRecords(lines);
  if (!metadata.sessionId) return null;

  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let firstUserMessage = null;
  const toolNames = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

  for (const rec of messages) {
    if (rec.type === 'user') {
      userCount++;
      if (!firstUserMessage) {
        const promptText = extractGeminiUserPromptText(rec);
        if (promptText) firstUserMessage = promptText.slice(0, 120);
      }
    } else if (rec.type === 'gemini') {
      assistantCount++;
      if (rec.tokens) {
        tokens.input += rec.tokens.input || 0;
        tokens.output += rec.tokens.output || 0;
        tokens.cacheRead += rec.tokens.cached || 0;
        tokens.reasoning += rec.tokens.thoughts || 0;
      }
      for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
        toolCallCount++;
        const name = call.name || 'unknown';
        toolNames[name] = (toolNames[name] || 0) + 1;
        if (call.result !== undefined && call.result !== null) toolResultCount++;
      }
    }
  }

  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    id: metadata.sessionId,
    timestamp: metadata.startTime || null,
    lastActivity: metadata.lastUpdated || null,
    messageCount: userCount + assistantCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    title: metadata.summary || firstUserMessage || null,
    cwd: Array.isArray(metadata.directories) && metadata.directories.length ? metadata.directories[0] : null,
    projectHash: metadata.projectHash || null,
    tokens,
    file: fileName,
  };
}

async function listGeminiSessions(baseDir) {
  const dir = baseDir || GEMINI_DIR;
  const sessions = [];
  let projects;
  try {
    projects = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chatsDir = path.join(dir, p.name, 'chats');
    const files = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      // Subagent transcripts nest in chats/<parentSessionId>/ — main sessions
      // are the session-*.jsonl files directly under chats/.
      if (!f.isFile() || !SESSION_FILE_RE.test(f.name)) continue;
      sessions.push(parseGeminiSessionMetadata(path.join(chatsDir, f.name), f.name).catch(() => null));
    }
  }

  const resolved = (await Promise.all(sessions)).filter(Boolean);
  resolved.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return resolved;
}

async function parseGeminiSessionFile(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const { metadata, messages: records } = foldGeminiRecords(lines);

  const session = metadata.sessionId
    ? {
        id: metadata.sessionId,
        cwd: Array.isArray(metadata.directories) && metadata.directories.length ? metadata.directories[0] : null,
        timestamp: metadata.startTime || null,
        projectHash: metadata.projectHash || null,
        summary: metadata.summary || null,
        kind: metadata.kind || null,
        model: null,
      }
    : null;

  const messages = [];
  for (const rec of records) messages.push(...normalizeGeminiRecord(rec));
  if (session) {
    const modeled = messages.find((m) => m.role === 'assistant' && m.model);
    if (modeled) session.model = modeled.model;
  }
  return { session, messages };
}

module.exports = {
  findGeminiSessionFile,
  readGeminiMetadataLine,
  stringifyToolResult,
  foldGeminiRecords,
  extractGeminiUserPromptText,
  normalizeGeminiRecord,
  parseGeminiSessionMetadata,
  listGeminiSessions,
  parseGeminiSessionFile,
};
