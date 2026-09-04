// 🔧 工具体检 — cross-platform tool audit subsection of 全局分析.
// Legacy: public/js/app.js initToolsAudit/loadToolsAudit/renderToolsAudit.
// First mount probes the persisted audit (cached=1, 204 → null → offer 运行体检);
// 运行体检/重新体检 recomputes with refresh=1 and writes into the same cache entry.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { getToolsAudit } from '@/api/client';
import type { ToolsAudit } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAppStore } from '@/store';
import { InsightSection, ScopeChip, UsageBar } from './bits';

function fmtAuditMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms) + 'ms';
}

function fmtAuditDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export function ToolsAuditSection() {
  const settings = useAppStore((s) => s.settings);
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  // Cached probe — runs once (staleTime ∞ mirrors legacy toolsAuditChecked).
  const probe = useQuery({
    queryKey: ['tools-audit'],
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: () => getToolsAudit({ dirs: settings }),
  });

  const refresh = useMutation({
    mutationFn: () => getToolsAudit({ dirs: settings, refresh: true }),
    onSuccess: (data) => queryClient.setQueryData(['tools-audit'], data),
  });

  const audit: ToolsAudit | null | undefined = probe.data; // refresh writes into this cache entry
  const loading = probe.isLoading || refresh.isPending;
  // A successful 重新体检 clears an earlier probe error (legacy resets toolsAuditError per run).
  const error: Error | null = refresh.isError
    ? (refresh.error as Error)
    : refresh.isSuccess
      ? null
      : ((probe.error as Error | null) ?? null);

  const tools = audit?.tools || [];
  const shown = showAll ? tools : tools.slice(0, 30);
  const maxCalls = tools.length ? Math.max(tools[0].calls, 1) : 1;
  const unused = audit?.configuredUnused || [];

  let body: ReactElement;
  if (loading && !audit) {
    body = <div className="text-sm text-muted-foreground">体检中…扫描全部平台会话统计工具调用</div>;
  } else if (error && !refresh.isPending) {
    body = <div className="text-sm text-destructive">体检失败: {error.message}</div>;
  } else if (!audit) {
    body = (
      <div className="text-[13px] text-muted-foreground">
        暂无体检结果 — 点击「运行体检」扫描全部平台的工具使用情况（调用量、错误率、平均耗时、闲置配置）。
      </div>
    );
  } else {
    body = (
      <>
        {tools.length ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>工具</TableHead>
                  <TableHead>平台</TableHead>
                  <TableHead>调用</TableHead>
                  <TableHead>错误率</TableHead>
                  <TableHead>平均耗时</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {(t.platforms || []).join(', ')}
                    </TableCell>
                    <TableCell>{t.calls}</TableCell>
                    <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>
                      {t.errors > 0 ? (t.errorRate * 100).toFixed(1) + '%' : '—'}
                    </TableCell>
                    <TableCell>{fmtAuditMs(t.avgMs)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtAuditDate(t.lastUsed)}</TableCell>
                    <TableCell>
                      <UsageBar pct={Math.max(2, Math.round((t.calls / maxCalls) * 100))} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {tools.length > shown.length && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setShowAll(true)}>
                展开全部 {tools.length} 个工具
              </Button>
            )}
          </>
        ) : (
          <div className="text-[13px] text-muted-foreground">没有工具调用数据</div>
        )}
        {unused.length > 0 && (
          <div className="mt-4 rounded-md border border-[#d29922]/40 bg-[#d29922]/10 p-3 text-[13px]">
            <div className="mb-1.5">配置了但从未使用（{unused.length}）：</div>
            <div className="flex flex-wrap gap-1.5">
              {unused.map((u) => (
                <code
                  key={u.name}
                  title={u.source || ''}
                  className="rounded bg-secondary px-1.5 py-0.5 text-xs"
                >
                  {u.name}
                </code>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              这些配置每轮都会占用上下文 — 建议考虑移除以节省每轮 token。
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <InsightSection>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          🔧 工具体检 <ScopeChip>🌐 全平台</ScopeChip>
          {audit?.generatedAt && (
            <span className="ml-1 normal-case tracking-normal text-muted-foreground">
              — {tools.length} 个工具 / {new Date(audit.generatedAt).toLocaleString()}
            </span>
          )}
        </h3>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          title="扫描全部平台会话，统计每个工具的调用/错误率/耗时"
          onClick={() => refresh.mutate()}
        >
          {loading ? '体检中…' : audit ? '重新体检' : '运行体检'}
        </Button>
      </div>
      {body}
    </InsightSection>
  );
}
