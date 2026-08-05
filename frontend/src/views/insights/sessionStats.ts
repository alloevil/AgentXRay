// Per-session insight statistics — ported verbatim from the stats loop of
// legacy public/js/app.js renderSessionInsights() (lines ~638-728). Pure, no DOM.

import type { SessionMessage } from '@/api/types';
import { firstInformativeLine, getTextContent } from '@/lib/pure';

export interface SessionToolStat {
  name: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  errorRate: number;
}

export interface SessionErrorItem {
  toolName: string;
  snippet: string;
  timestamp: string | null;
  index: number;
}

export interface SessionRetryItem {
  toolName: string;
  errorIndex: number;
  successIndex: number;
  errorSnippet: string;
  attempts: number;
}

export interface SessionToolCallItem {
  index: number;
  name: string;
  timestamp: string | null;
  callId: string | null | undefined;
}

export interface SessionInsightsStats {
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  errorCount: number;
  toolStats: SessionToolStat[]; // sorted by calls desc
  errors: SessionErrorItem[];
  retries: SessionRetryItem[];
  toolCalls: SessionToolCallItem[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function computeSessionInsights(msgs: SessionMessage[]): SessionInsightsStats {
  let userCount = 0,
    assistantCount = 0,
    toolCallCount = 0,
    toolResultCount = 0,
    errorCount = 0;
  const toolStats: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};
  const errors: SessionErrorItem[] = [];
  const toolCallsList: SessionToolCallItem[] = [];
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheRead = 0;

  // Retry detection: track error→success chains per tool per turn
  let turnToolErrors: Record<string, { errorIndex: number; snippet: string; attempts: number } | null> = {};
  const retries: SessionRetryItem[] = [];
  // callId → toolName map (Claude Code format: toolResult has no name)
  const callIdToName: Record<string, string> = {};

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role === 'user') {
      turnToolErrors = {};
      userCount++;
    }
    if (msg.role === 'assistant') {
      assistantCount++;
      if (msg.usage) {
        totalInputTokens += num(msg.usage.input) || num(msg.usage.input_tokens);
        totalOutputTokens += num(msg.usage.output) || num(msg.usage.output_tokens);
        totalCacheRead += num(msg.usage.cacheRead) || num(msg.usage.cache_read);
      }
    }
    if (msg.role === 'toolResult') {
      toolResultCount++;
      const name = msg.toolName || (msg.toolCallId ? callIdToName[msg.toolCallId] : undefined) || '?';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      const pending = turnToolErrors[name];
      if (msg.isError) {
        errorCount++;
        toolStats[name].errors++;
        const snippet = firstInformativeLine(getTextContent(msg.content));
        errors.push({ toolName: name, snippet, timestamp: msg.timestamp, index: i });
        if (!pending) turnToolErrors[name] = { errorIndex: i, snippet, attempts: 1 };
        else pending.attempts++;
      } else if (pending) {
        // Success after errors = retry resolved
        if (pending.attempts >= 2) {
          retries.push({
            toolName: name,
            errorIndex: pending.errorIndex,
            successIndex: i,
            errorSnippet: pending.snippet,
            attempts: pending.attempts,
          });
        }
        turnToolErrors[name] = null;
      }
      if (msg.details && typeof msg.details.durationMs === 'number') {
        toolStats[name].totalDurationMs += msg.details.durationMs;
      }
    }
    // Standalone toolCall records (Codex/OMP style: separate role instead of content part)
    if (msg.role === 'toolCall') {
      toolCallCount++;
      const name = msg.toolName || 'unknown';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
      toolCallsList.push({ index: i, name, timestamp: msg.timestamp, callId: msg.toolCallId });
      if (msg.toolCallId) callIdToName[msg.toolCallId] = name;
    }
    for (const c of msg.content || []) {
      // 'toolCall' = normalized content part; 'tool_use' = Claude Code assistant block
      if (c.type === 'toolCall' || c.type === 'tool_use') {
        toolCallCount++;
        const name = c.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        toolCallsList.push({ index: i, name, timestamp: msg.timestamp, callId: c.id });
        if (c.id) callIdToName[c.id] = name;
      }
    }
  }

  const toolStatsArray: SessionToolStat[] = Object.entries(toolStats)
    .map(([name, st]) => ({ name, ...st, errorRate: st.calls > 0 ? st.errors / st.calls : 0 }))
    .sort((a, b) => b.calls - a.calls);

  return {
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    toolStats: toolStatsArray,
    errors,
    retries,
    toolCalls: toolCallsList,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
  };
}
