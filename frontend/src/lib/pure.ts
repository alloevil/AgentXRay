// Pure (no-DOM) helpers, ported verbatim from public/js/pure.js — algorithms unchanged.
// The legacy file stays the single source of truth for node tests; keep both in sync.

import type { MessageContentPart, SessionMessage } from '@/api/types';

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function formatDurationCompact(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0s';
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 10) {
    return `${Math.round(totalSeconds * 10) / 10}s`;
  }
  const roundedSeconds = Math.round(totalSeconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes ? `${minutes}m` : ''}${!minutes && seconds ? `${seconds}s` : ''}`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds ? `${seconds}s` : ''}`;
  }
  return `${seconds}s`;
}

export function formatCost(dollars: number): string {
  return '$' + (dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(4));
}

// First line that carries information — skips structural-only lines
// ({ } [ ] ``` etc.) so JSON-body errors don't render as a lone symbol
export function firstInformativeLine(text: string | null | undefined): string {
  const joined = String(text || '');
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[{}[\]()`"',;:.\-=|\\/*+\s]+$/.test(line)) continue;
    return line.slice(0, 200);
  }
  return joined.trim().replace(/\s+/g, ' ').slice(0, 200);
}

export function getTextContent(content: MessageContentPart[] | null | undefined): string {
  return (content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n\n');
}

export interface ClusterLike {
  samples?: (string | null | undefined)[];
  examples?: (string | null | undefined)[];
  pattern?: string;
}

// 入库 prefill: longest common prefix of a cluster's example prompts when it is a
// meaningful template (≥30 chars), with the variable tail replaced by $ARGUMENTS;
// otherwise the first example verbatim.
export function clusterPrefillContent(c: ClusterLike): string {
  const examples = (c.samples || c.examples || []).map((s) => String(s || '')).filter(Boolean);
  if (!examples.length) return c.pattern || '';
  let prefix = examples[0];
  for (const ex of examples.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < ex.length && prefix[i] === ex[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (examples.length > 1 && prefix.trim().length >= 30 && prefix.length < examples[0].length) {
    return prefix.replace(/\s+$/, '') + ' $ARGUMENTS';
  }
  return examples[0];
}

export interface AgentSpan {
  name: string;
  label?: string | null;
  start: number | null | undefined;
  end?: number | null;
}

export interface TraceSpan {
  kind: 'chat' | 'tool' | 'tool-error' | 'agent';
  label: string;
  start: number;
  end: number;
  msgId?: string;
  toolCallId?: string;
  agentName?: string;
}

export interface TraceTurn {
  start: number;
  end: number;
  text: string;
  spans: TraceSpan[];
}

// Build spans from normalized messages: chat spans from message-timestamp deltas,
// tool spans from toolCall→toolResult pairing (both standalone records and content parts).
export function buildTraceTurns(msgs: SessionMessage[], agentSpans: AgentSpan[] = []): TraceTurn[] {
  const ts = (m: SessionMessage) => parseTimestampMs(m.timestamp);
  const calls = new Map<string, { name: string; ts: number | null; msgId: string }>(); // callId → { name, ts, msgId }
  const results = new Map<string, { ts: number | null; isError: boolean }>(); // callId → { ts, isError }
  for (const m of msgs) {
    const t = ts(m);
    if (m.role === 'toolCall' && m.toolCallId)
      calls.set(m.toolCallId, { name: m.toolName || '?', ts: t, msgId: m.id });
    if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, { ts: t, isError: !!m.isError });
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id)
        calls.set(c.id, { name: c.name || '?', ts: t, msgId: m.id });
      if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, { ts: t, isError: !!c.is_error });
    }
  }

  const turns: TraceTurn[] = [];
  let turn: TraceTurn | null = null;
  let prevTs: number | null = null;
  for (const m of msgs) {
    const t = ts(m);
    if (!t) continue;
    if (m.role === 'user') {
      const text = getTextContent(m.content || [])
        .replace(/\s+/g, ' ')
        .trim();
      turn = { start: t, end: t, text: text.slice(0, 140) || '(user)', spans: [] };
      turns.push(turn);
      prevTs = t;
      continue;
    }
    if (!turn) {
      turn = { start: t, end: t, text: '(session start)', spans: [] };
      turns.push(turn);
      prevTs = t;
    }
    if (m.role === 'assistant' && prevTs && t > prevTs) {
      turn.spans.push({
        kind: 'chat',
        label: (m.model || 'model').split('/').pop() as string,
        start: prevTs,
        end: t,
        msgId: m.id,
      });
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
    let owner: TraceTurn | null = null;
    for (const tn of turns) {
      if (tn.start <= c.ts) owner = tn;
      else break;
    }
    if (!owner) continue;
    owner.spans.push({
      kind: r && r.isError ? 'tool-error' : 'tool',
      label: c.name,
      start: c.ts,
      end,
      msgId: c.msgId,
      toolCallId: cid,
    });
    owner.end = Math.max(owner.end, end);
  }

  // Attach spawned-subagent spans (omp / claude-code) to the turn they started in
  for (const a of agentSpans) {
    if (!a.start) continue;
    const end = a.end && a.end > a.start ? a.end : a.start + 50;
    let owner: TraceTurn | null = null;
    for (const tn of turns) {
      if (tn.start <= a.start) owner = tn;
      else break;
    }
    if (!owner) continue;
    owner.spans.push({ kind: 'agent', label: a.label || a.name, start: a.start, end, agentName: a.name });
    owner.end = Math.max(owner.end, end);
  }

  for (const tn of turns) tn.spans.sort((a, b) => a.start - b.start);
  return turns.filter((tn) => tn.spans.length > 0);
}
