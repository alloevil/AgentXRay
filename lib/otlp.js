const crypto = require('crypto');
const { CODEX_DIR, CLAUDE_CODE_DIR, OMP_DIR, DSH_DIR } = require('./config');
const { findCodexSessionFile, parseCodexSessionFile } = require('./platforms/codex');
const { findClaudeCodeSessionFile, parseClaudeCodeSessionFile } = require('./platforms/claude');
const { findOmpSessionFile, parseOmpSessionFile } = require('./platforms/omp');
const { findDshSessionFile, parseDshSessionFile } = require('./platforms/dsh');

// --- OTLP export: serialize a session's trace as OpenTelemetry OTLP/JSON ---
// One trace per session; per user-turn a root `invoke_agent` span with child
// `chat {model}` and `execute_tool {toolName}` spans. Turn/chat/tool timing
// mirrors the frontend buildTraceTurns semantics (reasoning does not advance
// the clock). All ids are deterministic sha256 digests of the session id.

const OTLP_PLATFORMS = {
  codex: { defaultDir: () => CODEX_DIR, find: findCodexSessionFile, parse: parseCodexSessionFile },
  'claude-code': {
    defaultDir: () => CLAUDE_CODE_DIR,
    find: findClaudeCodeSessionFile,
    parse: parseClaudeCodeSessionFile,
  },
  omp: { defaultDir: () => OMP_DIR, find: findOmpSessionFile, parse: parseOmpSessionFile },
  dsh: { defaultDir: () => DSH_DIR, find: findDshSessionFile, parse: parseDshSessionFile },
};

function otlpHexId(seed, bytes) {
  return crypto
    .createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, bytes * 2);
}

function otlpStrAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function otlpIntAttr(key, value) {
  return { key, value: { intValue: String(value) } };
}

function otlpNano(ms) {
  return String(ms) + '000000';
}

// Mirror of the frontend buildTraceTurns: chat spans from message-timestamp
// deltas, tool spans from toolCall→toolResult pairing (standalone records and
// content parts), turns keyed by user messages.
function buildOtlpTurns(messages) {
  const ts = (m) => {
    const t = Date.parse(m.timestamp || '');
    return Number.isFinite(t) ? t : null;
  };
  const calls = new Map(); // callId → { name, ts }
  const results = new Map(); // callId → { ts, isError }
  for (const m of messages) {
    const t = ts(m);
    if (m.role === 'toolCall' && m.toolCallId) calls.set(m.toolCallId, { name: m.toolName || '?', ts: t });
    if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, { ts: t, isError: !!m.isError });
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id) calls.set(c.id, { name: c.name || '?', ts: t });
      if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, { ts: t, isError: !!c.is_error });
    }
  }

  const turns = [];
  let turn = null;
  let prevTs = null;
  for (const m of messages) {
    const t = ts(m);
    if (!t) continue;
    if (m.role === 'user') {
      turn = { start: t, end: t, chat: [], tools: [] };
      turns.push(turn);
      prevTs = t;
      continue;
    }
    if (!turn) {
      turn = { start: t, end: t, chat: [], tools: [] };
      turns.push(turn);
      prevTs = t;
    }
    if (m.role === 'assistant' && prevTs && t > prevTs) {
      turn.chat.push({ model: m.model || 'model', start: prevTs, end: t, usage: m.usage || null });
    }
    // Reasoning shares the API call with its assistant message — don't advance the clock
    if (m.role !== 'reasoning') prevTs = t;
    turn.end = Math.max(turn.end, t);
  }

  // Attach tool spans to the turn they started in
  for (const [cid, c] of calls) {
    if (!c.ts) continue;
    const r = results.get(cid);
    const end = r && r.ts && r.ts > c.ts ? r.ts : c.ts + 50;
    let owner = null;
    for (const tn of turns) {
      if (tn.start <= c.ts) owner = tn;
      else break;
    }
    if (!owner) continue;
    owner.tools.push({ callId: cid, name: c.name, start: c.ts, end, isError: !!(r && r.isError) });
    owner.end = Math.max(owner.end, end);
  }

  return turns.filter((tn) => tn.chat.length > 0 || tn.tools.length > 0);
}

function buildOtlpPayload(messages, sessionId) {
  const traceId = otlpHexId(`agentxray:trace:${sessionId}`, 16);
  const turns = buildOtlpTurns(messages);
  const spans = [];

  turns.forEach((tn, ti) => {
    const rootId = otlpHexId(`${sessionId}:turn:${ti}`, 8);
    spans.push({
      traceId,
      spanId: rootId,
      name: 'invoke_agent',
      kind: 1,
      startTimeUnixNano: otlpNano(tn.start),
      endTimeUnixNano: otlpNano(tn.end),
      attributes: [otlpStrAttr('gen_ai.operation.name', 'invoke_agent')],
    });

    tn.chat.forEach((c, ci) => {
      const usage = c.usage || {};
      spans.push({
        traceId,
        spanId: otlpHexId(`${sessionId}:turn:${ti}:chat:${ci}`, 8),
        parentSpanId: rootId,
        name: `chat ${c.model}`,
        kind: 1,
        startTimeUnixNano: otlpNano(c.start),
        endTimeUnixNano: otlpNano(c.end),
        attributes: [
          otlpStrAttr('gen_ai.operation.name', 'chat'),
          otlpStrAttr('gen_ai.request.model', c.model),
          otlpIntAttr('gen_ai.usage.input_tokens', usage.input || usage.input_tokens || 0),
          otlpIntAttr('gen_ai.usage.output_tokens', usage.output || usage.output_tokens || 0),
        ],
      });
    });

    tn.tools.forEach((tl, tli) => {
      const span = {
        traceId,
        spanId: otlpHexId(`${sessionId}:turn:${ti}:tool:${tl.callId || tli}`, 8),
        parentSpanId: rootId,
        name: `execute_tool ${tl.name}`,
        kind: 1,
        startTimeUnixNano: otlpNano(tl.start),
        endTimeUnixNano: otlpNano(tl.end),
        attributes: [otlpStrAttr('gen_ai.operation.name', 'execute_tool'), otlpStrAttr('gen_ai.tool.name', tl.name)],
      };
      if (tl.isError) span.status = { code: 2 };
      spans.push(span);
    });
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [otlpStrAttr('service.name', 'agentxray'), otlpStrAttr('gen_ai.conversation.id', sessionId)],
        },
        scopeSpans: [
          {
            scope: { name: 'agentxray' },
            spans,
          },
        ],
      },
    ],
  };
}

module.exports = {
  OTLP_PLATFORMS,
  buildOtlpPayload,
};
