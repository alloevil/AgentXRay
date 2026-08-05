// 全局分析 — aggregate insights for the current platform (/api/insights).
// Legacy: public/js/app.js renderInsights() (cards / tool stats / error
// clusters / daily trend) + the 工具体检 subsection.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getInsights } from '@/api/client';
import type { ErrorCluster, ErrorClusterExample, Insights } from '@/api/types';
import { PLATFORM_LABELS } from '@/api/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCost } from '@/lib/pure';
import { dirForPlatform, useAppStore } from '@/store';
import { InsightSection, ScopeChip, StatCard, UsageBar, fmtTokens } from './bits';
import { ToolsAuditSection } from './ToolsAuditSection';

/** One error cluster row — click header toggles examples; example links jump to the failing message. */
function ClusterItem({
  cluster,
  onOpenExample,
}: {
  cluster: ErrorCluster;
  onOpenExample: (example: ErrorClusterExample) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="cursor-pointer rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-all text-[13px]" title={cluster.pattern}>
          {cluster.pattern}
        </span>
        <span className="shrink-0 text-xs font-semibold text-destructive">x{cluster.count}</span>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-col gap-1 border-t border-destructive/20 pt-2">
          {cluster.examples.map((e, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenExample(e);
                }}
              >
                {e.sessionId.slice(0, 12)}…
              </button>
              <span className="text-muted-foreground">{e.toolName}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GlobalInsights() {
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const setView = useAppStore((s) => s.setView);
  const requestScrollToMessage = useAppStore((s) => s.requestScrollToMessage);

  const agent = platform === 'openclaw' && selectedAgent ? selectedAgent : undefined;
  const query = useQuery({
    queryKey: ['insights', platform, agent ?? ''],
    queryFn: () =>
      getInsights({ platform, agent, dir: dirForPlatform(settings, platform) || undefined }),
  });

  // Error-example session link: land on the failing message in the sessions view.
  // Examples belong to the platform this insights payload was fetched for
  // (/api/insights is platform-scoped); switch back if the store moved on.
  const openExample = (e: ErrorClusterExample) => {
    if (useAppStore.getState().platform !== platform) setPlatform(platform);
    setSelectedSessionId(e.sessionId);
    if (e.messageId) requestScrollToMessage(e.messageId);
    else setView('sessions');
  };

  if (query.isPending) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading insights…</div>;
  }
  if (query.isError) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Failed to load insights: {query.error.message}
      </div>
    );
  }
  const data: Insights = query.data;
  if (!data || data.totalSessions === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No session data available for the current selection.
      </div>
    );
  }

  const errPct = (data.errorRate * 100).toFixed(1);
  const tokenTotal = (data.tokenUsage.input || 0) + (data.tokenUsage.output || 0);
  const maxCalls = data.toolStats.length > 0 ? data.toolStats[0].calls : 1;
  const maxTrend = data.trend.length
    ? Math.max(...data.trend.map((d) => Math.max(d.sessions, d.errors, d.toolCalls)), 1)
    : 1;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        全局分析{agent ? ` — ${agent}` : ''}{' '}
        <ScopeChip>📍 当前平台：{PLATFORM_LABELS[platform] || platform}</ScopeChip>
      </h2>

      <div className="flex flex-wrap gap-3">
        <StatCard value={data.totalSessions} label="Sessions" />
        <StatCard value={data.totalToolCalls} label="Tool Calls" />
        <StatCard value={`${errPct}%`} label="Error Rate" tone="error" />
        <StatCard value={fmtTokens(tokenTotal)} label="Tokens (in+out)" tone="token" />
        {data.totalCost > 0 && (
          <StatCard value={`💰 ${formatCost(data.totalCost)}`} label="Cost" tone="cost" />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InsightSection title="Tool Statistics">
          {data.toolStats.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>Err%</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.toolStats.slice(0, 15).map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{t.calls}</TableCell>
                    <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>
                      {t.errors || '—'}
                    </TableCell>
                    <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>
                      {t.errors > 0 ? (t.errorRate * 100).toFixed(1) + '%' : '—'}
                    </TableCell>
                    <TableCell>
                      <UsageBar pct={Math.max(2, Math.round((t.calls / maxCalls) * 100))} />
                      {t.errors > 0 && (
                        <div className="mt-0.5">
                          <UsageBar pct={Math.max(2, Math.round((t.errors / t.calls) * 100))} error />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-[13px] text-muted-foreground">No tool data</div>
          )}
        </InsightSection>

        <InsightSection title="Error Clusters">
          {data.errorClusters.length > 0 ? (
            <div className="flex flex-col gap-2">
              {data.errorClusters.map((c, i) => (
                <ClusterItem key={i} cluster={c} onOpenExample={openExample} />
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">No errors found</div>
          )}
        </InsightSection>
      </div>

      {data.trend.length > 0 && (
        <InsightSection title="Daily Trend">
          <div className="flex items-end gap-2 overflow-x-auto pb-1">
            {data.trend.map((d) => (
              <div
                key={d.date}
                className="flex flex-col items-center gap-1"
                title={`${d.date}: ${d.sessions} sessions, ${d.errors} errors, ${d.toolCalls} tool calls${d.cost > 0 ? `, ${formatCost(d.cost)}` : ''}`}
              >
                <div className="flex h-[96px] items-end gap-0.5">
                  <div
                    className="w-2.5 rounded-t bg-primary"
                    style={{ height: `${Math.max(1, Math.round((d.sessions / maxTrend) * 90))}px` }}
                  />
                  <div
                    className="w-2.5 rounded-t bg-destructive"
                    style={{ height: `${Math.max(1, Math.round((d.errors / maxTrend) * 90))}px` }}
                  />
                  <div
                    className="w-2.5 rounded-t bg-[#3fb950]"
                    style={{ height: `${Math.max(1, Math.round((d.toolCalls / maxTrend) * 90))}px` }}
                  />
                </div>
                {d.cost > 0 && (
                  <span className="text-[10px] text-[#3fb950]">{formatCost(d.cost)}</span>
                )}
                <span className="text-[10px] text-muted-foreground">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-primary" /> Sessions
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-destructive" /> Errors
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-[#3fb950]" /> Tool Calls
            </span>
          </div>
        </InsightSection>
      )}

      <ToolsAuditSection />
    </div>
  );
}
