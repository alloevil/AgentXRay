const fsp = require('fs/promises');
const path = require('path');
const zlib = require('node:zlib');
const { DSH_DIR } = require('../config');
const { withMetadataCache, makeMessage, sortSessionsByTimestampDesc, topToolsOf } = require('./shared');

// --- DeepSeek Harness (dsh) platform adapter ---
// Sessions live at <root>/<projectKey>/<sessionId>/session.jsonl.zstd (default)
// or session.jsonl (compression:'none'), root defaulting to ~/.dsh/sessions.
// The log is a JSONL event stream: line 1 is a header record
// ({type:'session', version:0, id, createdAt, cwd, origin?, …}), every other
// line is a SessionEvent envelope ({type, seq, time, data, surfaceOp?}) or a
// packed chunk row (text-chunks / reasoning-chunks / tool-call-chunks).
//
// zstd caveat: the compressed artifact is a CONCATENATION of independent
// Zstandard frames (one for the header, one per durable append batch), and
// Node's zstdDecompressSync only reads the FIRST frame. We scan frame
// boundaries (RFC 8878 structure, no block decoding) and decompress each
// frame separately. A truncated trailing frame (crash residue) is tolerated
// and dropped.

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

const SESSION_FORMAT_VERSION = 0;
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

const HAS_NODE_ZSTD = typeof zlib.zstdDecompressSync === 'function';

function msToIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Scan frame boundaries of a concatenated-zstd buffer without decompressing
// block contents. Returns { frames: [{start, end}], tornStart } where
// tornStart marks the offset of a trailing incomplete/corrupt frame (null if
// the buffer ends exactly on a frame boundary).
function scanZstdFrames(buf) {
  const frames = [];
  const len = buf.length;
  let off = 0;
  while (off < len) {
    const start = off;
    if (len - off < 4) return { frames, tornStart: start };
    const magic = buf.readUInt32LE(off);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (len - off < 8) return { frames, tornStart: start };
      const size = buf.readUInt32LE(off + 4);
      if (off + 8 + size > len) return { frames, tornStart: start };
      off += 8 + size; // skippable frames carry no session data
      continue;
    }
    if (magic !== ZSTD_MAGIC) return { frames, tornStart: start };
    off += 4;
    if (off >= len) return { frames, tornStart: start };
    const descriptor = buf[off++];
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const didFlag = descriptor & 3;
    if (!singleSegment) off += 1; // Window_Descriptor
    off += [0, 1, 2, 4][didFlag]; // Dictionary_ID
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
    if (off > len) return { frames, tornStart: start };
    for (;;) {
      if (off + 3 > len) return { frames, tornStart: start };
      const header = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      off += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) return { frames, tornStart: start }; // reserved: corrupt
      off += blockType === 1 ? 1 : blockSize; // RLE blocks store 1 byte
      if (off > len) return { frames, tornStart: start };
      if (lastBlock) break;
    }
    if (checksumFlag) {
      off += 4;
      if (off > len) return { frames, tornStart: start };
    }
    frames.push({ start, end: off });
  }
  return { frames, tornStart: null };
}

// Multi-frame decompression: every complete frame decoded independently, then
// concatenated. A torn trailing frame is dropped.
function decompressDshLog(buffer) {
  if (!HAS_NODE_ZSTD) {
    throw new Error(
      'This dsh session log is zstd-compressed, but this Node.js build has no zstd support. ' +
        'Upgrade to Node.js >= 22.15 (node:zlib zstdDecompressSync) to view compressed dsh sessions.'
    );
  }
  const { frames } = scanZstdFrames(buffer);
  const parts = frames.map((f) => zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString('utf8');
}

// Read a dsh session log (compressed or plain) as an array of non-empty lines.
async function readDshSessionLines(filePath) {
  if (filePath.endsWith('.zstd')) {
    const buffer = await fsp.readFile(filePath);
    return decompressDshLog(buffer)
      .split('\n')
      .filter((l) => l.trim());
  }
  const text = await fsp.readFile(filePath, 'utf8');
  return text.split('\n').filter((l) => l.trim());
}

function parseDshHeader(line) {
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    return null;
  }
  if (!header || header.type !== 'session') return null;
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `Unsupported dsh session format version ${header.version} (this AgentXRay build reads version ${SESSION_FORMAT_VERSION})`
    );
  }
  return header;
}

async function findDshSessionFile(baseDir, sessionId) {
  const dir = baseDir || DSH_DIR;
  const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const sessionDir = path.join(dir, p.name, sessionId);
    for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
      const candidate = path.join(sessionDir, name);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Real human prompt text from a user/message event's data, or null for
// non-user injections (hooks, spliced inbox items) and empty content.
function extractDshUserPromptText(data) {
  if (!data || (data.source && data.source.kind && data.source.kind !== 'user')) return null;
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.startsWith('<')) return null;
  return text;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenToolResultContent(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'tool-result') {
      for (const inner of Array.isArray(block.content) ? block.content : []) {
        if (inner.type === 'text') parts.push({ type: 'text', text: inner.text || '' });
      }
    }
  }
  return parts;
}

// Maps one dsh session event to an array of normalized messages (an
// assistant/message fans out into reasoning / text entries, codex-style;
// tool calls are emitted from the dedicated tool/call events), or null for
// trace/boundary records. `toolNamesByCallId` pairs tool/result rows with the
// real tool name.
function normalizeDshEvent(event, toolNamesByCallId) {
  const timestamp = msToIso(event.time);
  const data = event.data || {};

  if (event.type === 'user/message') {
    const content = Array.isArray(data.content) ? data.content : [];
    return [
      makeMessage({
        id: data.id || null,
        timestamp,
        role: 'user',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
      }),
    ];
  }

  if (event.type === 'assistant/message') {
    const message = data.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return null; // known-empty stream: derives to no message
    const source = message.source || {};
    const messages = [];
    const reasoningText = content
      .filter((c) => c.type === 'reasoning')
      .map((c) => c.text || '')
      .join('\n\n')
      .trim();
    if (reasoningText) {
      messages.push(
        makeMessage({
          timestamp,
          role: 'reasoning',
          content: [{ type: 'text', text: reasoningText }],
        })
      );
    }
    const usage = data.usage
      ? {
          input: data.usage.inputTokens || 0,
          output: data.usage.outputTokens || 0,
          cacheRead: data.usage.cacheReadTokens || 0,
          reasoning: data.usage.reasoningTokens || 0,
        }
      : null;
    messages.push(
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'assistant',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        usage,
        model: source.model || null,
        provider: source.provider || null,
      })
    );
    // tool-call blocks are intentionally skipped: the paired tool/call events
    // that follow carry the same callId/name/arguments and render as
    // standalone toolCall records (codex/omp style).
    return messages;
  }

  if (event.type === 'tool/call') {
    if (data.callId && data.name) toolNamesByCallId.set(data.callId, data.name);
    return [
      makeMessage({
        id: data.callId || null,
        timestamp,
        role: 'toolCall',
        toolCallId: data.callId || null,
        toolName: data.name || null,
        details: tryParseJson(data.arguments),
      }),
    ];
  }

  if (event.type === 'tool/result') {
    const message = data.message || {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const callId =
      (message.source && message.source.callId) ||
      (blocks.find((b) => b.type === 'tool-result') || {}).toolCallId ||
      null;
    const isError = Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
    return [
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'toolResult',
        content: flattenToolResultContent(blocks),
        toolCallId: callId,
        toolName: (callId && toolNamesByCallId.get(callId)) || null,
        details: data.error ? { error: data.error.name || 'error', code: data.error.code ?? null } : null,
        isError,
      }),
    ];
  }

  if (event.type === 'turn/end') {
    const kind = data.reason && data.reason.kind;
    if (kind && kind !== 'completed') {
      return [
        makeMessage({
          timestamp,
          role: 'error',
          content: [{ type: 'text', text: `Turn ${data.turn ?? '?'} ended without completing: ${kind}` }],
          toolName: `turn ${kind}`,
          isError: true,
        }),
      ];
    }
    return null;
  }

  // Chunks, boundaries, packed rows and log-only events derive to no message.
  return null;
}

// Parse event lines (header excluded) into the normalized message list,
// honoring compaction: a surface event with surfaceOp {op:'replace',start,end}
// masks the surface positions [start, end) — masked messages are dropped so
// compacted content never renders twice.
function normalizeDshEvents(lines) {
  const toolNamesByCallId = new Map();
  const items = []; // { surfaceIndex: number|null, messages, compacted? }
  let surfaceCount = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'session' || CHUNK_ROW_TYPES.has(event.type)) continue;

    let surfaceIndex = null;
    if (SURFACE_EVENT_TYPES.has(event.type)) {
      const op = event.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        for (const item of items) {
          if (item.surfaceIndex !== null && item.surfaceIndex >= op.start && item.surfaceIndex < op.end) {
            item.compacted = true;
          }
        }
        surfaceIndex = op.start;
        surfaceCount = op.start + 1;
      } else {
        surfaceIndex = surfaceCount++;
      }
    }

    const messages = normalizeDshEvent(event, toolNamesByCallId);
    if (messages && messages.length) items.push({ surfaceIndex, messages });
  }

  const out = [];
  for (const item of items) {
    if (!item.compacted) out.push(...item.messages);
  }
  return out;
}

const parseDshSessionMetadata = withMetadataCache(_parseDshSessionMetadataRaw);

async function _parseDshSessionMetadataRaw(filePath, fileName, sessionDirName) {
  let header = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimeMs = null;
  let firstUserMessage = null;
  let parseError = null;
  const toolNames = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

  let lines = [];
  try {
    lines = await readDshSessionLines(filePath);
  } catch (error) {
    parseError = error.message;
  }

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session' && !header) {
      try {
        header = parseDshHeader(line);
      } catch (error) {
        parseError = error.message;
      }
      continue;
    }
    if (typeof rec.time === 'number' && (lastTimeMs === null || rec.time > lastTimeMs)) lastTimeMs = rec.time;

    const data = rec.data || {};
    if (rec.type === 'user/message') {
      messageCount++;
      userCount++;
      if (!firstUserMessage) {
        const text = extractDshUserPromptText(data);
        if (text) firstUserMessage = text.slice(0, 120);
      }
    } else if (rec.type === 'assistant/message') {
      messageCount++;
      assistantCount++;
      if (data.usage) {
        tokens.input += data.usage.inputTokens || 0;
        tokens.output += data.usage.outputTokens || 0;
        tokens.cacheRead += data.usage.cacheReadTokens || 0;
        tokens.reasoning += data.usage.reasoningTokens || 0;
      }
    } else if (rec.type === 'tool/call') {
      toolCallCount++;
      const name = data.name || 'unknown';
      toolNames[name] = (toolNames[name] || 0) + 1;
    } else if (rec.type === 'tool/result') {
      toolResultCount++;
    }
  }

  const topTools = topToolsOf(toolNames);

  return {
    id: header?.id || sessionDirName,
    timestamp: msToIso(header?.createdAt) || null,
    lastActivity: msToIso(lastTimeMs),
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    title: firstUserMessage || null,
    cwd: header?.cwd || null,
    origin: header?.origin || null,
    tokens,
    file: fileName,
    ...(parseError ? { error: parseError } : {}),
  };
}

async function listDshSessions(baseDir) {
  const dir = baseDir || DSH_DIR;
  const sessions = [];
  let projects;
  try {
    projects = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projDir = path.join(dir, p.name);
    const sessionDirs = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
    for (const s of sessionDirs) {
      if (!s.isDirectory()) continue;
      const sessionDir = path.join(projDir, s.name);
      const files = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      const logFile = files.find((f) => f.isFile() && (f.name === 'session.jsonl.zstd' || f.name === 'session.jsonl'));
      if (!logFile) continue;
      sessions.push(
        parseDshSessionMetadata(path.join(sessionDir, logFile.name), logFile.name, s.name).catch(() => null)
      );
    }
  }

  const resolved = (await Promise.all(sessions)).filter(Boolean);
  return sortSessionsByTimestampDesc(resolved);
}

async function parseDshSessionFile(filePath) {
  const lines = await readDshSessionLines(filePath);
  let session = null;
  if (lines.length > 0) {
    const header = parseDshHeader(lines[0]);
    if (header) {
      session = {
        id: header.id || null,
        cwd: header.cwd || null,
        timestamp: msToIso(header.createdAt),
        version: header.version,
        origin: header.origin || null,
        model: null,
      };
    }
  }
  const messages = normalizeDshEvents(lines.slice(session ? 1 : 0));
  if (session) {
    const modeled = messages.find((m) => m.role === 'assistant' && m.model);
    if (modeled) session.model = modeled.model;
  }
  return { session, messages };
}

module.exports = {
  HAS_NODE_ZSTD,
  scanZstdFrames,
  decompressDshLog,
  readDshSessionLines,
  findDshSessionFile,
  extractDshUserPromptText,
  parseDshSessionMetadata,
  listDshSessions,
  normalizeDshEvents,
  parseDshSessionFile,
};
