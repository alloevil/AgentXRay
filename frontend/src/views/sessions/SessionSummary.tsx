// Session overview: id/time/cwd/model header, time split + slowest turn,
// persisted collapse (axr-summary-collapsed), stat filter badges, retry jump,
// child-agent chips, resume-command copy, export menu — legacy renderSummary.

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionDetail } from '@/api/types';
import { formatCost, formatDurationCompact } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { dirForPlatform, loadStoredFlag, saveStoredFlag, SUMMARY_COLLAPSED_KEY, useAppStore } from '@/store';
import { ChildAgentsSection } from '@/views/trace/ChildAgentsSection';
import type { ExportFormat } from './exports';
import { runExport } from './exports';
import type { MsgFilter, TimingAnalysis } from './lib';
import { computeSessionStats, formatDate, formatNumber, resumeCommand, sessionCost, summarizeTokens } from './lib';
import { useSessionsList } from './queries';

function FilterBadge({
  active,
  onClick,
  title,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[11px]',
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  );
}

const ACTION_BTN =
  'rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground';

function ExportMenu({ detail }: { detail: SessionDetail }) {
  const platform = useAppStore((s) => s.platform);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const settings = useAppStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const onExport = async (format: ExportFormat) => {
    setOpen(false);
    const result = await runExport(
      format,
      detail,
      platform,
      selectedSessionId,
      dirForPlatform(settings, platform) || undefined
    );
    if (result === 'copied') {
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const entries: [ExportFormat, string][] = [
    ['markdown', '📝 Markdown (.md)'],
    ['json', '📦 JSON (.json)'],
    ['clipboard', '📋 复制到剪贴板'],
  ];
  if (['codex', 'claude-code', 'omp', 'dsh'].includes(platform)) entries.push(['otlp', '🔭 OTLP JSON']);

  return (
    <div className="relative">
      <button type="button" className={ACTION_BTN} onClick={() => setOpen((v) => !v)} data-testid="export-btn">
        {copied ? '✅ Copied!' : '📥 导出'}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-lg">
            {entries.map(([format, label]) => (
              <button
                key={format}
                type="button"
                data-export={format}
                onClick={() => void onExport(format)}
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ResumeButton({ cwd }: { cwd: string | null | undefined }) {
  const platform = useAppStore((s) => s.platform);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const [copied, setCopied] = useState(false);
  const cmd = resumeCommand(platform, selectedSessionId, cwd);
  if (!cmd) return null;
  return (
    <button
      type="button"
      className={ACTION_BTN}
      title={`复制在终端恢复此会话的命令：${cmd}`}
      data-testid="resume-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (error) {
          toast.error('复制失败: ' + (error as Error).message);
        }
      }}
    >
      {copied ? '已复制' : '📋 复制恢复命令'}
    </button>
  );
}

export function SessionSummary({
  detail,
  timing,
  msgFilter,
  setMsgFilter,
  onScrollToMessage,
  onRetryJump,
}: {
  detail: SessionDetail;
  timing: TimingAnalysis;
  msgFilter: MsgFilter;
  setMsgFilter: (f: MsgFilter) => void;
  onScrollToMessage: (id: string) => void;
  onRetryJump: () => void;
}) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const { data: sessions } = useSessionsList();
  const [collapsed, setCollapsed] = useState(() => loadStoredFlag(SUMMARY_COLLAPSED_KEY, true));

  const msgs = detail.messages;
  const stats = useMemo(() => computeSessionStats(msgs), [msgs]);
  const tokenSummary = useMemo(() => summarizeTokens(msgs), [msgs]);
  const cost = useMemo(() => sessionCost(msgs), [msgs]);
  const listModel = sessions?.find((s) => s.id === selectedSessionId)?.model;

  const total = timing.totalDurationMs;
  const toolMs = timing.totalToolDurationMs || 0;
  const modelMs = total !== null ? Math.max(0, total - toolMs) : 0;
  const topTools = Object.entries(stats.toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      saveStoredFlag(SUMMARY_COLLAPSED_KEY, !prev);
      return !prev;
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3" data-testid="session-summary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{detail.session?.id || selectedSessionId}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{formatDate(detail.session?.timestamp)}</span>
            <span>{detail.session?.cwd || 'Unknown cwd'}</span>
            {listModel ? <span className="rounded border border-border px-1">🧠 {listModel}</span> : null}
            {total !== null ? (
              <span title="Wall-clock time from first to last message">⏱ Total: {formatDurationCompact(total)}</span>
            ) : null}
            {total !== null && timing.totalToolDurationMs !== null && total > 0 ? (
              <span title="Estimated breakdown: tool execution time vs model inference time (model = total − tool exec)">
                🔧 Tool exec: {formatDurationCompact(toolMs)} ({Math.round((toolMs / total) * 100)}%) · 🤖 Model:{' '}
                {formatDurationCompact(modelMs)} ({Math.round((modelMs / total) * 100)}%)
              </span>
            ) : null}
            {timing.slowestStep ? (
              <button
                type="button"
                className="cursor-pointer text-[#e3b341] hover:underline"
                title="Click to jump — total agent work time for this turn (user msg → last agent response)"
                onClick={() => timing.slowestStep?.messageId && onScrollToMessage(timing.slowestStep.messageId)}
              >
                🐌 Slowest turn: +{formatDurationCompact(timing.slowestStep.deltaMs)} ({timing.slowestStep.label})
              </button>
            ) : null}
            <span>耗时分析看 Trace 视图</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <button
            type="button"
            className={ACTION_BTN}
            title="折叠/展开会话统计详情"
            onClick={toggleCollapsed}
            data-testid="summary-toggle"
          >
            {collapsed ? '▸ 详情' : '▾ 收起'}
          </button>
          <ResumeButton cwd={detail.session?.cwd} />
          <ExportMenu detail={detail} />
        </div>
      </div>

      {!collapsed ? (
        <div className="mt-3 space-y-3" data-testid="summary-body">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Messages
              </div>
              <div className="flex flex-wrap gap-1">
                <FilterBadge
                  active={msgFilter === 'user'}
                  onClick={() => setMsgFilter('user')}
                  title="Click to show only user messages"
                >
                  👤 User: {stats.userCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'assistant'}
                  onClick={() => setMsgFilter('assistant')}
                  title="Click to show only assistant messages"
                >
                  🤖 Assistant: {stats.assistantCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === null}
                  onClick={() => setMsgFilter(null)}
                  title="Click to show all messages"
                >
                  💬 Total: {msgs.length}
                </FilterBadge>
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tools</div>
              <div className="flex flex-wrap gap-1">
                <FilterBadge
                  active={msgFilter === 'toolCall'}
                  onClick={() => setMsgFilter('toolCall')}
                  title="Click to show only tool calls"
                >
                  🔧 Tool Calls: {stats.toolCallCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'toolResult'}
                  onClick={() => setMsgFilter('toolResult')}
                  title="Click to show only tool results"
                >
                  📋 Tool Results: {stats.toolResultCount}
                </FilterBadge>
                {stats.errorCount ? (
                  <FilterBadge
                    active={msgFilter === 'error'}
                    onClick={() => setMsgFilter('error')}
                    title="Click to show only error tool results"
                    className="text-[#ff7b72]"
                  >
                    ❌ Errors: {stats.errorCount}
                  </FilterBadge>
                ) : null}
                {stats.totalRetryTools > 0 ? (
                  <button
                    type="button"
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-[#a5d6ff]"
                    title={`Click to jump to first retry · ${stats.totalRetryTools} tool${stats.totalRetryTools > 1 ? 's' : ''} retried (${stats.totalRetryAttempts} extra attempt${stats.totalRetryAttempts > 1 ? 's' : ''})`}
                    onClick={onRetryJump}
                    data-testid="retry-jump"
                  >
                    🔄 Retried: {stats.totalRetryTools} tool{stats.totalRetryTools > 1 ? 's' : ''} ·{' '}
                    {stats.totalRetryAttempts} extra attempt{stats.totalRetryAttempts > 1 ? 's' : ''}
                  </button>
                ) : null}
                {stats.spawnCount ? (
                  <FilterBadge
                    active={msgFilter === 'spawn'}
                    onClick={() => setMsgFilter('spawn')}
                    title="Click to show only spawn calls"
                    className="text-[#f0883e]"
                  >
                    🔗 Spawns: {stats.spawnCount}
                  </FilterBadge>
                ) : null}
              </div>
            </div>
            {topTools.length ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Top Tools
                </div>
                <div className="flex flex-wrap gap-1">
                  {topTools.map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {name}: {count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tokens</div>
              <div className="flex flex-wrap gap-1">
                {Object.keys(tokenSummary).length ? (
                  Object.entries(tokenSummary).map(([key, value]) => (
                    <span
                      key={key}
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {key}: {formatNumber(value)}
                    </span>
                  ))
                ) : (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    No token data
                  </span>
                )}
                {cost > 0 ? (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    title="按消息 usage.cost.total 合计"
                  >
                    💰 {formatCost(cost)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <ChildAgentsSection />
        </div>
      ) : null}
    </div>
  );
}
