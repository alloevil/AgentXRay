const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { extractErrorSnippet, normalizeErrorPattern } = require('./text-utils');
const { HERMES_DIR, resolveDir } = require('./config');
const { readDshSessionLines } = require('./platforms/dsh');
const { stringifyToolResult: stringifyGeminiToolResult } = require('./platforms/gemini');
const { openHermesDb } = require('./platforms/hermes');
const { collectSessionFiles } = require('./platforms');

// ========= Insights: aggregate analytics across sessions =========
const insightsCache = new Map(); // key → { expires: number, data: object }
const INSIGHTS_TTL_MS = 60_000;

function getInsightsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

// Stream a session log line by line. dsh zstd logs can't be streamed as UTF-8:
// they're decompressed via the dsh adapter and yielded from memory.
async function* iterateSessionLines(filePath) {
  if (filePath.endsWith('.zstd')) {
    for (const line of await readDshSessionLines(filePath)) yield line;
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

// Scan a single JSONL file for insights data
// Supports both standard format (type:'message' with toolCall/toolResult roles)
// and Claude Code format (type:'assistant'/'user' with tool_use/tool_result content blocks)
async function scanFileForInsights(filePath, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let sessionDate = null;
  const toolStats = {}; // name → { calls, errors, totalDurationMs }
  const errorExamples = []; // { toolName, snippet, pattern }
  const dshToolNames = new Map(); // callId → name (dsh tool/call → tool/result pairing)

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

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
        if (msg.usage.cost && typeof msg.usage.cost.total === 'number') totalCost += msg.usage.cost.total;
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
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: rec.id || rec.uuid || null,
            timestamp: rec.timestamp || null,
          });
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
              errorText = c.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join(' ');
            }
            const snippet = extractErrorSnippet(errorText);
            const pattern = normalizeErrorPattern(snippet);
            errorExamples.push({
              toolName: name,
              snippet,
              pattern,
              sessionId,
              messageId: rec.uuid || rec.id || null,
              timestamp: rec.timestamp || null,
            });
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
          const snippet = extractErrorSnippet(outputText);
          const pattern = normalizeErrorPattern(snippet);
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: rec.id || (rec.payload && rec.payload.id) || null,
            timestamp: rec.timestamp || null,
          });
        }
        if (output && typeof output === 'object' && output.metadata && output.metadata.duration_seconds) {
          toolStats[name].totalDurationMs += Math.round(output.metadata.duration_seconds * 1000);
        }
      }
    }

    // --- Gemini CLI format: type === 'gemini' assistant records with inline toolCalls ---
    // (user records already count as messages via the type === 'user' branch above;
    // their content is a top-level string/Part[], so the claude tool_result loop is a no-op)
    if (rec.type === 'gemini') {
      messageCount++;
      if (!sessionDate && rec.timestamp) sessionDate = rec.timestamp.slice(0, 10);
      if (rec.tokens) {
        totalInputTokens += rec.tokens.input || 0;
        totalOutputTokens += rec.tokens.output || 0;
        totalCacheRead += rec.tokens.cached || 0;
      }
      for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
        toolCallCount++;
        const name = call.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        const hasResult = call.result !== undefined && call.result !== null;
        if (hasResult || call.status === 'error' || call.status === 'cancelled') toolResultCount++;
        if (call.status === 'error' || call.status === 'cancelled') {
          errorCount++;
          toolStats[name].errors++;
          const snippet = extractErrorSnippet(
            hasResult ? stringifyGeminiToolResult(call.result) : `Tool call ${call.status}`
          );
          const pattern = normalizeErrorPattern(snippet);
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: call.id || rec.id || null,
            timestamp: call.timestamp || rec.timestamp || null,
          });
        }
      }
    }

    // --- dsh format: slash-typed session events (user/message, assistant/message, tool/call, tool/result) ---
    if (rec.type === 'user/message' || rec.type === 'assistant/message') {
      messageCount++;
      if (!sessionDate && typeof rec.time === 'number') {
        sessionDate = new Date(rec.time).toISOString().slice(0, 10);
      }
      const usage = (rec.data || {}).usage;
      if (usage) {
        totalInputTokens += usage.inputTokens || 0;
        totalOutputTokens += usage.outputTokens || 0;
        totalCacheRead += usage.cacheReadTokens || 0;
      }
    }
    if (rec.type === 'tool/call') {
      toolCallCount++;
      const data = rec.data || {};
      const name = data.name || 'unknown';
      if (data.callId) dshToolNames.set(data.callId, name);
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
    }
    if (rec.type === 'tool/result') {
      toolResultCount++;
      const data = rec.data || {};
      const message = data.message || {};
      const callId = (message.source && message.source.callId) || null;
      const name = (callId && dshToolNames.get(callId)) || 'tool';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      const blocks = Array.isArray(message.content) ? message.content : [];
      const isErr = Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        let errorText = data.error ? `${data.error.name || 'error'}` : '';
        for (const b of blocks) {
          if (b.type === 'tool-result') {
            for (const inner of Array.isArray(b.content) ? b.content : []) {
              if (inner.type === 'text' && inner.text) errorText = errorText || inner.text;
            }
          }
        }
        const snippet = extractErrorSnippet(errorText);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          messageId: message.id || null,
          timestamp: typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null,
        });
      }
    }
  }

  return {
    messageCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCost,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

// Scan a single Hermes session for insights (from SQLite)
function scanHermesSessionForInsights(db, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  const totalOutputTokens = 0;
  let sessionDate = null;
  const toolStats = {};
  const errorExamples = [];

  const rows = db
    .prepare(`
    SELECT role, content, tool_calls, tool_name, token_count, timestamp
    FROM messages WHERE session_id = ?
    ORDER BY rowid
  `)
    .all(sessionId);

  for (const row of rows) {
    messageCount++;
    totalInputTokens += row.token_count || 0;

    if (!sessionDate && row.timestamp) {
      sessionDate = new Date(row.timestamp * 1000).toISOString().slice(0, 10);
    }

    // Parse tool calls from assistant messages
    if (row.role === 'assistant' && row.tool_calls) {
      let calls;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
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
      const isErr =
        content.includes('"isError":true') ||
        content.includes('"isError": true') ||
        (content.toLowerCase().includes('error') && content.includes('exit code') && !content.includes('exit code 0'));
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        const snippet = content.trim().split('\n')[0].trim().slice(0, 200);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          timestamp: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null,
        });
      }
    }
  }

  return {
    messageCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead: 0,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

async function computeInsights(platform, agentName, dirOverride) {
  // Hermes uses SQLite
  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    const db = openHermesDb(dir);
    if (!db) return null;
    try {
      const sessions = db.prepare('SELECT id FROM sessions').all();
      const totalSessions = sessions.length;
      let totalMessages = 0,
        totalToolCalls = 0,
        totalToolResultCount = 0,
        totalErrors = 0;
      let totalInput = 0,
        totalOutput = 0;
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

      return buildInsightsResponse(
        totalSessions,
        totalMessages,
        totalToolCalls,
        totalToolResultCount,
        totalErrors,
        totalInput,
        totalOutput,
        0,
        0,
        toolStats,
        allErrors,
        dailyTrend
      );
    } finally {
      db.close();
    }
  }

  // JSONL-based platforms: openclaw, codex, claude-code, omp, dsh, gemini
  const files = await collectSessionFiles(platform, agentName, dirOverride);
  if (files.length === 0) return null;

  const totalSessions = files.length;
  let totalMessages = 0,
    totalToolCalls = 0,
    totalToolResultCount = 0,
    totalErrors = 0;
  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCost = 0;
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
    totalCost += data.totalCost || 0;

    for (const [name, st] of Object.entries(data.toolStats)) {
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls += st.calls;
      toolStats[name].errors += st.errors;
      toolStats[name].totalDurationMs += st.totalDurationMs;
    }
    allErrors.push(...data.errorExamples);

    if (data.sessionDate) {
      if (!dailyTrend[data.sessionDate])
        dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0, cost: 0 };
      dailyTrend[data.sessionDate].sessions++;
      dailyTrend[data.sessionDate].errors += data.errorCount;
      dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
      dailyTrend[data.sessionDate].cost += data.totalCost || 0;
    }
  }

  return buildInsightsResponse(
    totalSessions,
    totalMessages,
    totalToolCalls,
    totalToolResultCount,
    totalErrors,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCost,
    toolStats,
    allErrors,
    dailyTrend
  );
}

function buildInsightsResponse(
  totalSessions,
  totalMessages,
  totalToolCalls,
  totalToolResultCount,
  totalErrors,
  totalInput,
  totalOutput,
  totalCacheRead,
  totalCost,
  toolStats,
  allErrors,
  dailyTrend
) {
  const errorRate = totalToolResultCount > 0 ? totalErrors / totalToolResultCount : 0;

  // Tool stats array
  const toolStatsArray = Object.entries(toolStats)
    .map(([name, st]) => ({
      name,
      calls: st.calls,
      errors: st.errors,
      errorRate: st.calls > 0 ? st.errors / st.calls : 0,
      avgDurationMs: st.calls > 0 ? Math.round(st.totalDurationMs / st.calls) : null,
    }))
    .sort((a, b) => b.calls - a.calls);

  // Error clusters: group by normalized pattern
  const clusters = {};
  for (const err of allErrors) {
    const key = err.pattern;
    if (!clusters[key]) clusters[key] = { pattern: err.snippet, count: 0, examples: [] };
    clusters[key].count++;
    if (clusters[key].examples.length < 5) {
      clusters[key].examples.push({
        sessionId: err.sessionId,
        toolName: err.toolName,
        snippet: err.snippet,
        messageId: err.messageId || null,
        timestamp: err.timestamp,
      });
    }
  }
  const errorClusters = Object.values(clusters)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Daily trend sorted by date
  const trend = Object.entries(dailyTrend)
    .map(([date, d]) => ({
      date,
      sessions: d.sessions,
      errors: d.errors,
      toolCalls: d.toolCalls,
      cost: Math.round((d.cost || 0) * 10000) / 10000,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSessions,
    totalMessages,
    totalToolCalls,
    errorRate: Math.round(errorRate * 10000) / 10000,
    totalCost: Math.round(totalCost * 10000) / 10000,
    tokenUsage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead },
    toolStats: toolStatsArray,
    errorClusters,
    trend,
  };
}

module.exports = {
  insightsCache,
  INSIGHTS_TTL_MS,
  getInsightsCacheKey,
  iterateSessionLines,
  scanFileForInsights,
  scanHermesSessionForInsights,
  computeInsights,
  buildInsightsResponse,
};
