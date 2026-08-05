// 本会话分析 — insights computed client-side from the selected session's
// messages. Legacy: public/js/app.js renderSessionInsights() (render half;
// the stats loop lives in ./sessionStats.ts). Error / retry items jump to the
// failing message via the shared requestScrollToMessage store action.

import { useQuery } from '@tanstack/react-query';
import { getSessionDetail } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDurationCompact } from '@/lib/pure';
import { dirForPlatform, useAppStore } from '@/store';
import { InsightSection, ScopeChip, StatCard, UsageBar, fmtTokens, formatNumber } from './bits';
import { computeSessionInsights } from './sessionStats';

// Tool sequence chip palette — legacy toolColorPalette order preserved.
const TOOL_PALETTE = [
  { bg: 'rgba(88,166,255,0.15)', color: '#58a6ff' }, // blue
  { bg: 'rgba(63,185,80,0.15)', color: '#3fb950' }, // green
  { bg: 'rgba(210,153,34,0.15)', color: '#d29922' }, // yellow
  { bg: 'rgba(188,143,243,0.15)', color: '#bc8ff3' }, // purple
  { bg: 'rgba(219,109,40,0.15)', color: '#db6d28' }, // orange
  { bg: 'rgba(121,192,255,0.15)', color: '#79c0ff' }, // light blue
  { bg: 'rgba(255,123,114,0.15)', color: '#ff7b72' }, // salmon
  { bg: 'rgba(165,214,255,0.15)', color: '#a5d6ff' }, // sky
];

export function SessionInsights() {
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const settings = useAppStore((s) => s.settings);
  const requestScrollToMessage = useAppStore((s) => s.requestScrollToMessage);

  // Shared cache with the sessions view — same key + queryFn opts (contract).
  const query = useQuery({
    queryKey: ['session', platform, selectedSessionId],
    enabled: !!selectedSessionId,
    queryFn: () =>
      getSessionDetail(platform, selectedSessionId, {
        agent: selectedAgent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
      }),
  });

  if (query.isPending) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading session…</div>;
  }
  if (query.isError) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Failed to load session: {query.error.message}
      </div>
    );
  }

  const msgs = query.data.messages;
  const session = query.data.session || {};
  const st = computeSessionInsights(msgs);

  const errorRate = st.toolResultCount > 0 ? ((st.errorCount / st.toolResultCount) * 100).toFixed(1) : '0.0';
  const maxCalls = st.toolStats.length > 0 ? st.toolStats[0].calls : 1;
  const sid = session.id || selectedSessionId || '?';

  // Jump to the message backing a stat item (error / retry).
  const jumpToIndex = (idx: number) => {
    const msg = msgs[idx];
    if (msg && msg.id) requestScrollToMessage(msg.id);
  };

  // toolName → palette index, in first-appearance order (legacy toolColorMap).
  const toolColorMap: Record<string, number> = {};
  let colorIdx = 0;
  for (const tc of st.toolCalls) {
    if (!(tc.name in toolColorMap)) {
      toolColorMap[tc.name] = colorIdx % TOOL_PALETTE.length;
      colorIdx++;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        本会话分析 <ScopeChip>📍 仅当前会话</ScopeChip>
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{sid.slice(0, 20)}</Badge>
        {session.cwd && <Badge variant="secondary">{session.cwd}</Badge>}
        <Badge variant="secondary">
          👤 {st.userCount} &nbsp; 🤖 {st.assistantCount}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-3">
        <StatCard value={st.toolCallCount} label="Tool Calls" />
        <StatCard value={`${errorRate}%`} label="Error Rate" tone={st.errorCount > 0 ? 'error' : undefined} />
        <StatCard value={st.retries.length} label="Retries" />
        <StatCard value={fmtTokens(st.totalInputTokens + st.totalOutputTokens)} label="Tokens" tone="token" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InsightSection title="Tool Statistics">
          {st.toolStats.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>Avg ms</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {st.toolStats.map((t) => {
                  const avgMs = t.totalDurationMs > 0 && t.calls > 0 ? Math.round(t.totalDurationMs / t.calls) : null;
                  return (
                    <TableRow key={t.name}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell>{t.calls}</TableCell>
                      <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>{t.errors || '—'}</TableCell>
                      <TableCell>{avgMs !== null ? formatDurationCompact(avgMs) : '—'}</TableCell>
                      <TableCell>
                        <UsageBar pct={Math.max(2, Math.round((t.calls / maxCalls) * 100))} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-[13px] text-muted-foreground">No tool calls in this session</div>
          )}
        </InsightSection>

        <InsightSection title={`Errors (${st.errors.length})`}>
          {st.errors.length > 0 ? (
            <div className="flex flex-col gap-2">
              {st.errors.map((e, i) => (
                <div
                  key={i}
                  className="cursor-pointer rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 hover:border-destructive/60"
                  title="点击跳到该消息"
                  onClick={() => jumpToIndex(e.index)}
                >
                  <div className="flex items-start justify-between gap-2 text-[13px]">
                    <span className="min-w-0 break-all">{e.snippet}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{e.toolName}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">No errors</div>
          )}
        </InsightSection>

        <InsightSection title={`Retries (${st.retries.length})`}>
          {st.retries.length > 0 ? (
            <div className="flex flex-col gap-2">
              {st.retries.map((r, i) => (
                <div
                  key={i}
                  className="cursor-pointer rounded-md border border-border bg-secondary/40 px-3 py-2 hover:border-primary/40"
                  title="点击跳到出错消息"
                  onClick={() => jumpToIndex(r.errorIndex)}
                >
                  <div className="flex items-start justify-between gap-2 text-[13px]">
                    <span className="min-w-0 break-all">{r.errorSnippet}</span>
                    <span className="shrink-0 text-xs text-[#d29922]">🔄 x{r.attempts} → OK</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{r.toolName}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">No retries</div>
          )}
        </InsightSection>

        {st.totalInputTokens + st.totalOutputTokens + st.totalCacheRead > 0 && (
          <InsightSection title="Token Breakdown">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">Input: {formatNumber(st.totalInputTokens)}</Badge>
              <Badge variant="secondary">Output: {formatNumber(st.totalOutputTokens)}</Badge>
              {st.totalCacheRead > 0 && (
                <Badge variant="secondary">Cache Read: {formatNumber(st.totalCacheRead)}</Badge>
              )}
            </div>
          </InsightSection>
        )}
      </div>

      {st.toolCalls.length > 0 && (
        <InsightSection title="Tool Call Sequence">
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {st.toolCalls.map((tc, idx) => {
              const pal = TOOL_PALETTE[toolColorMap[tc.name]];
              const hasErrorAfter = st.errors.some(
                (e) => e.toolName === tc.name && e.timestamp === tc.timestamp
              );
              return (
                <span key={idx} className="flex items-center gap-1">
                  {idx > 0 && <span className="text-muted-foreground">→</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 ${hasErrorAfter ? 'ring-1 ring-destructive' : ''}`}
                    style={{ background: pal.bg, color: pal.color }}
                    title={tc.name}
                  >
                    {tc.name}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {Object.entries(toolColorMap).map(([name, ci]) => (
              <span key={name} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: TOOL_PALETTE[ci].color }}
                />
                {name}
              </span>
            ))}
          </div>
        </InsightSection>
      )}
    </div>
  );
}
