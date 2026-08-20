const fsp = require('fs/promises');
const path = require('path');
const { HOME, ANALYSIS_DIR } = require('./config');
const { collectSessionFiles, iterateSessionLines } = require('./insights');

// --- Tool Audit: per-tool usage/health across platforms ---
// Streams every session file once, collecting toolCall records/content-parts
// (name, callId, timestamp) and toolResult records (callId, timestamp, isError).
// callId pairing yields durations and attributes results to the real tool name
// (claude tool_result / codex outputs don't carry one). configuredUnused
// surfaces claude MCP servers (~/.claude.json mcpServers keys) never matched
// by any used tool name containing mcp__<server>.

const TOOL_AUDIT_PLATFORMS = ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini'];
const TOOL_AUDIT_TTL_MS = 5 * 60 * 1000;
const TOOLS_AUDIT_FILE = path.join(ANALYSIS_DIR, 'tools-audit.json');
const toolAuditCache = new Map(); // key → { expires, data }

function toolAuditEntry(tools, name, platform) {
  let t = tools.get(name);
  if (!t) {
    t = { platforms: new Set(), calls: 0, errors: 0, totalMs: 0, msCount: 0, lastUsedMs: 0, sessions: 0 };
    tools.set(name, t);
  }
  t.platforms.add(platform);
  return t;
}

// Scan one raw session JSONL file, folding per-tool aggregates into `tools`.
// Handles the same record shapes as scanFileForInsights: standard
// (type:'message' with toolCall parts / toolResult role), Claude Code
// (tool_use / tool_result content blocks) and Codex (response_item payloads).
async function scanFileForToolAudit(filePath, tools, platform) {
  const pending = new Map(); // callId → { name, tsMs }
  const seen = new Set(); // tool names used in this file

  const onCall = (name, callId, ts) => {
    const t = toolAuditEntry(tools, name, platform);
    t.calls++;
    seen.add(name);
    const tsMs = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(tsMs) && tsMs > t.lastUsedMs) t.lastUsedMs = tsMs;
    if (callId) pending.set(callId, { name, tsMs: Number.isFinite(tsMs) ? tsMs : null });
  };

  const onResult = (callId, ts, isError, name, durationMs) => {
    const call = callId ? pending.get(callId) : undefined;
    if (call) pending.delete(callId);
    const toolName = (call && call.name) || name;
    if (!toolName) return; // unpaired result without a name: nothing to attribute
    const t = toolAuditEntry(tools, toolName, platform);
    seen.add(toolName);
    if (isError) t.errors++;
    let ms = typeof durationMs === 'number' && durationMs >= 0 ? durationMs : null;
    if (ms === null && call && call.tsMs !== null && ts) {
      const endMs = Date.parse(ts);
      if (Number.isFinite(endMs) && endMs >= call.tsMs) ms = endMs - call.tsMs;
    }
    if (ms !== null) {
      t.totalMs += ms;
      t.msCount++;
    }
  };

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    // --- Standard format (openclaw/omp): type === 'message' ---
    if (rec.type === 'message') {
      const msg = rec.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content) {
        if (c.type === 'toolCall') onCall(c.name || 'unknown', c.id || null, rec.timestamp || null);
      }
      if (msg.role === 'toolResult') {
        const details = msg.details || {};
        const durationMs =
          typeof details.durationMs === 'number'
            ? details.durationMs
            : typeof details.wallTimeMs === 'number'
              ? Math.round(details.wallTimeMs)
              : null;
        onResult(msg.toolCallId || null, rec.timestamp || null, Boolean(msg.isError), msg.toolName || null, durationMs);
      }
    }

    // --- Claude Code format: tool_use / tool_result content blocks ---
    if (rec.type === 'assistant') {
      const content = Array.isArray((rec.message || {}).content) ? rec.message.content : [];
      for (const c of content) {
        if (c.type === 'tool_use') onCall(c.name || 'unknown', c.id || null, rec.timestamp || null);
      }
    }
    if (rec.type === 'user') {
      const content = Array.isArray((rec.message || {}).content) ? rec.message.content : [];
      for (const c of content) {
        if (c.type === 'tool_result')
          onResult(c.tool_use_id || null, rec.timestamp || null, Boolean(c.is_error), null, null);
      }
    }

    // --- Codex format: type === 'response_item' payloads ---
    if (rec.type === 'response_item') {
      const payload = rec.payload || {};
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        onCall(payload.name || 'unknown', payload.call_id || null, rec.timestamp || null);
      }
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const output = payload.output;
        let isErr = false;
        let durationMs = null;
        if (typeof output === 'string') {
          isErr = output.includes('Process exited with code') && !output.includes('exited with code 0');
        } else if (output && typeof output === 'object') {
          if (output.metadata && output.metadata.exit_code !== undefined) isErr = output.metadata.exit_code !== 0;
          if (output.metadata && output.metadata.duration_seconds)
            durationMs = Math.round(output.metadata.duration_seconds * 1000);
        }
        onResult(payload.call_id || null, rec.timestamp || null, isErr, null, durationMs);
      }
    }

    // --- dsh format: tool/call + tool/result session events (time = epoch ms) ---
    if (rec.type === 'tool/call') {
      const data = rec.data || {};
      const ts = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
      onCall(data.name || 'unknown', data.callId || null, ts);
    }
    if (rec.type === 'tool/result') {
      const data = rec.data || {};
      const message = data.message || {};
      const blocks = Array.isArray(message.content) ? message.content : [];
      const callId = (message.source && message.source.callId) || null;
      const isErr = Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
      const ts = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
      onResult(callId, ts, isErr, null, null);
    }
    // --- Gemini CLI format: type === 'gemini' records with inline toolCalls (result on the call) ---
    if (rec.type === 'gemini') {
      for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
        const ts = call.timestamp || rec.timestamp || null;
        onCall(call.name || 'unknown', call.id || null, ts);
        const hasResult = call.result !== undefined && call.result !== null;
        if (hasResult || call.status === 'error' || call.status === 'cancelled') {
          // The result is stored inline on the call record — no separate
          // completion timestamp exists, so durations stay unknown.
          onResult(
            call.id || null,
            null,
            call.status === 'error' || call.status === 'cancelled',
            call.name || null,
            null
          );
        }
      }
    }
  }

  for (const name of seen) tools.get(name).sessions++;
}

// Claude MCP server names from ~/.claude.json: top-level mcpServers keys plus
// per-project mcpServers keys. A missing or corrupt file yields an empty list.
async function readClaudeMcpServers() {
  let cfg;
  try {
    cfg = JSON.parse(await fsp.readFile(path.join(HOME, '.claude.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!cfg || typeof cfg !== 'object') return [];
  const names = new Set();
  if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
    for (const name of Object.keys(cfg.mcpServers)) names.add(name);
  }
  if (cfg.projects && typeof cfg.projects === 'object') {
    for (const proj of Object.values(cfg.projects)) {
      if (proj && proj.mcpServers && typeof proj.mcpServers === 'object') {
        for (const name of Object.keys(proj.mcpServers)) names.add(name);
      }
    }
  }
  return [...names];
}

async function computeToolAudit(platform, dirs) {
  const platforms = platform === 'all' ? TOOL_AUDIT_PLATFORMS : [platform];
  const tools = new Map(); // name → { platforms, calls, errors, totalMs, msCount, lastUsedMs, sessions }

  for (const p of platforms) {
    const files = await collectSessionFiles(p, '', dirs[p] || '');
    for (const f of files) {
      await scanFileForToolAudit(f.path, tools, p).catch(() => {});
    }
  }

  const usedNames = [...tools.keys()].map((n) => n.toLowerCase());
  const configuredUnused = [];
  for (const server of await readClaudeMcpServers()) {
    const marker = `mcp__${server.toLowerCase()}`;
    if (!usedNames.some((n) => n.includes(marker))) configuredUnused.push({ name: server, source: 'claude-mcp' });
  }

  return {
    generatedAt: new Date().toISOString(),
    tools: [...tools.entries()]
      .map(([name, t]) => ({
        name,
        platforms: [...t.platforms],
        calls: t.calls,
        errors: t.errors,
        errorRate: t.calls > 0 ? Math.round((t.errors / t.calls) * 10000) / 10000 : 0,
        avgMs: t.msCount > 0 ? Math.round(t.totalMs / t.msCount) : null,
        lastUsed: t.lastUsedMs ? new Date(t.lastUsedMs).toISOString() : null,
        sessions: t.sessions,
      }))
      .sort((a, b) => b.calls - a.calls),
    configuredUnused,
  };
}

async function loadPersistedToolAudit() {
  try {
    return JSON.parse(await fsp.readFile(TOOLS_AUDIT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename so a crash never truncates the store.
async function savePersistedToolAudit(result) {
  await fsp.mkdir(ANALYSIS_DIR, { recursive: true });
  const tmpPath = `${TOOLS_AUDIT_FILE}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, TOOLS_AUDIT_FILE);
}

module.exports = {
  TOOL_AUDIT_PLATFORMS,
  TOOL_AUDIT_TTL_MS,
  toolAuditCache,
  computeToolAudit,
  loadPersistedToolAudit,
  savePersistedToolAudit,
};
