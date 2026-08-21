// 会话 view: session detail (summary + messages/trace toggle), pagination,
// scroll-to-message (local + cross-view via pendingScrollMsgId), SSE tail.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformProbe } from '@/hooks/usePlatformProbe';
import { useAppStore } from '@/store';
import { ChildAgentBanner } from '@/views/trace/ChildAgentsSection';
import { useActiveSessionDetail } from '@/views/trace/childAgents';
import { TraceView } from '@/views/trace/TraceView';
import { cn } from '@/lib/utils';
import { buildTimingAnalysis } from './lib';
import type { MsgFilter } from './lib';
import { MessageActionsContext } from './MessageItem';
import { MessageList, MSG_BATCH_SIZE } from './MessageList';
import { useSessionDetail } from './queries';
import { SessionSummary } from './SessionSummary';
import { useSessionSse } from './useSessionSse';

// Every platform probed empty (#13): guide the user to where logs are
// expected instead of showing feature marketing over a blank list.
const PLATFORM_DEFAULT_PATHS: [string, string][] = [
  ['OpenClaw', '~/.openclaw/agents'],
  ['Codex', '~/.codex/sessions'],
  ['Claude Code', '~/.claude/projects'],
  ['Hermes', '~/.hermes'],
  ['OMP', '~/.omp/agent/sessions'],
  ['DeepSeek Harness', '~/.dsh/sessions'],
  ['Gemini CLI', '~/.gemini/tmp'],
];

function AllEmptyState() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 py-8" data-testid="all-empty-state">
      <h3 className="text-base font-semibold">没有找到任何会话日志</h3>
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <p>
          AgentXRay 直接读取各 CLI agent 落盘的会话日志，无需任何集成。当前在以下默认路径都没有发现日志
          —— 用过其中某个工具后刷新页面即可,或在 <b className="text-foreground">⚙ 设置</b>
          里指向自定义目录：
        </p>
        <table className="w-full text-left">
          <tbody>
            {PLATFORM_DEFAULT_PATHS.map(([name, dir]) => (
              <tr key={name} className="border-b border-border/50">
                <td className="py-1 pr-4 text-foreground">{name}</td>
                <td className="py-1">
                  <code className="rounded bg-secondary px-1">{dir}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          日志目录不在默认位置？打开左上角 <b className="text-foreground">⚙ 设置</b>
          为每个平台单独指定目录，保存后立即生效。
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 py-8">
      <h3 className="text-base font-semibold">从左侧选择一个会话 — AgentXRay 能做什么</h3>
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <p>
          <b className="text-foreground">会话</b> — 跨工具浏览与回放 AI agent
          会话：每条消息、每次工具调用的参数与结果、耗时拆分、token 成本。左侧搜索框
          <b className="text-foreground">直接输入</b>过滤列表，<b className="text-foreground">按回车</b>
          全文搜索会话内容（含已被 Claude 清理的历史输入）。
        </p>
        <p>
          <b className="text-foreground">分析</b> — 聚合分析：哪些工具用得最多、哪里报错、token
          花在哪、每天用量趋势。顶部可在「全局分析 / 本会话分析」之间切换（本会话分析需先选中会话）。
        </p>
        <p>
          <b className="text-foreground">Prompts</b> — 自动提取你在所有会话里输入过的真人
          prompt（滤掉工具输出和系统注入），按目录分组。每条可 <b className="text-foreground">⭐ 收藏</b>入库、
          <b className="text-foreground">优化</b>（Claude 改写）、<b className="text-foreground">🗑 隐藏</b>
          （可恢复）；「🧮 聚类分析」把相似 prompt 聚成模板并统计效果。
        </p>
        <p>
          <b className="text-foreground">资产库</b> — prompt 资产库：标签分类、编辑、搜索。每条有{' '}
          <b className="text-foreground">Claude / Codex / OMP</b> 三个开关，点亮即安装为该工具的 slash
          command——之后在工具里输 <code className="rounded bg-secondary px-1">/名字</code> 直接调用，
          <code className="rounded bg-secondary px-1">$ARGUMENTS</code> 传参。
        </p>
        <p>
          <b className="text-foreground">⚙ 设置</b> — 自定义各平台的日志目录（默认已指向本机标准路径）。
        </p>
      </div>
    </div>
  );
}

// Legacy scrollToMessage findEl: several anchor id shapes
function findAnchorEl(msgId: string): HTMLElement | null {
  return (
    document.getElementById(`message-${msgId}`) ||
    document.getElementById(`tool-result-${msgId}`) ||
    document.getElementById(`row-${msgId}`) ||
    (document.querySelector(`[id*="${CSS.escape(msgId)}"]`) as HTMLElement | null)
  );
}

function revealAndFlash(el: HTMLElement, color = '#58a6ff') {
  // Expand every ancestor fold plus the element's own collapse
  let d = el.closest('details');
  while (d) {
    d.open = true;
    d = d.parentElement?.closest('details') ?? null;
  }
  const inner = el.querySelector('details');
  if (inner) inner.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.outline = `2px solid ${color}`;
  el.style.outlineOffset = '2px';
  window.setTimeout(() => {
    el.style.outline = '';
    el.style.outlineOffset = '';
  }, 2000);
}

export function SessionsView() {
  const platform = useAppStore((s) => s.platform);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const sessionView = useAppStore((s) => s.sessionView);
  const setSessionView = useAppStore((s) => s.setSessionView);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const pendingScrollMsgId = useAppStore((s) => s.pendingScrollMsgId);
  const clearPendingScrollMsgId = useAppStore((s) => s.clearPendingScrollMsgId);

  const parentQuery = useSessionDetail(); // summary always shows the parent
  const activeQuery = useActiveSessionDetail(); // messages area: parent or child transcript
  const probe = usePlatformProbe(); // all-empty guided state (#13); cache shared with PlatformBar

  const [msgFilter, setMsgFilter] = useState<MsgFilter>(null);
  const [visibleUnitCount, setVisibleUnitCount] = useState<number>(MSG_BATCH_SIZE);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pendingAnchorRef = useRef<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const paginatedKeyRef = useRef('');

  const activeKey = `${platform}:${selectedSessionId}:${viewingChildAgent ?? ''}`;
  const activeDetail = activeQuery.data;
  const timing = buildTimingAnalysis(activeDetail?.messages);

  // New transcript loaded → legacy loadSession: all messages if ≤200, else first 60
  useEffect(() => {
    if (!activeDetail || paginatedKeyRef.current === activeKey) return;
    paginatedKeyRef.current = activeKey;
    setVisibleUnitCount(activeDetail.messages.length <= 200 ? Number.POSITIVE_INFINITY : MSG_BATCH_SIZE);
    setMsgFilter(null);
    messagesRef.current?.scrollTo({ top: 0 });
  }, [activeKey, activeDetail]);

  // scrollToMessage: expand pagination + clear filter, then reveal + flash after paint
  const scrollToMessage = useCallback((msgId: string) => {
    if (!msgId) return;
    if (useAppStore.getState().sessionView !== 'messages') useAppStore.getState().setSessionView('messages');
    setVisibleUnitCount(Number.POSITIVE_INFINITY);
    setMsgFilter(null);
    pendingAnchorRef.current = msgId;
    setScrollTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const msgId = pendingAnchorRef.current;
    if (!msgId) return;
    pendingAnchorRef.current = null;
    // double rAF: let <details> folds + full unit list commit first
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = findAnchorEl(msgId);
        if (el) revealAndFlash(el);
      })
    );
  }, [scrollTick]);

  // Cross-view jump: consume pendingScrollMsgId once the transcript is loaded
  useEffect(() => {
    if (!pendingScrollMsgId || !activeDetail) return;
    scrollToMessage(pendingScrollMsgId);
    clearPendingScrollMsgId();
  }, [pendingScrollMsgId, activeDetail, scrollToMessage, clearPendingScrollMsgId]);

  // Retry jump (legacy retryJumpBtn): expand all, scroll to first retry annotation
  const onRetryJump = useCallback(() => {
    setVisibleUnitCount(Number.POSITIVE_INFINITY);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const firstRetry = document.querySelector(
          '.retry-annotation.retry-error, .retry-annotation.retry-error-final'
        ) as HTMLElement | null;
        if (firstRetry) revealAndFlash(firstRetry, '#a5d6ff');
      })
    );
  }, []);

  // SSE real-time tail: append → expand pagination; auto-scroll to newest (top)
  const sseStatus = useSessionSse(
    useCallback((count: number) => {
      setVisibleUnitCount((c) => (Number.isFinite(c) ? c + count + 5 : c));
      if (useAppStore.getState().autoScroll) messagesRef.current?.scrollTo({ top: 0 });
    }, [])
  );

  if (!selectedSessionId) {
    const counts = probe.data;
    const allEmpty = !!counts && Object.values(counts).every((n) => n === 0);
    return allEmpty ? <AllEmptyState /> : <EmptyState />;
  }

  return (
    <MessageActionsContext.Provider value={{ scrollToMessage }}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        {parentQuery.data ? (
          <SessionSummary
            detail={parentQuery.data}
            timing={viewingChildAgent ? buildTimingAnalysis(parentQuery.data.messages) : timing}
            msgFilter={msgFilter}
            setMsgFilter={setMsgFilter}
            onScrollToMessage={scrollToMessage}
            onRetryJump={onRetryJump}
          />
        ) : parentQuery.isError ? (
          <div className="rounded-lg border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {(parentQuery.error as Error).message}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">
            Loading session…
          </div>
        )}

        <div className="flex items-center gap-2">
          {(['messages', 'trace'] as const).map((sv) => (
            <button
              key={sv}
              type="button"
              onClick={() => setSessionView(sv)}
              className={cn(
                'rounded-md border px-3 py-1 text-xs',
                sessionView === sv
                  ? 'border-primary/60 bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {sv === 'messages' ? '💬 消息' : '📊 Trace'}
            </button>
          ))}
          {sseStatus === 'live' ? (
            <span className="text-[11px] text-muted-foreground" title="Real-time tail active">
              🟢 Live
            </span>
          ) : sseStatus === 'error' ? (
            <span className="text-[11px] text-muted-foreground" title="Real-time connection lost, will retry">
              🔴 Live
            </span>
          ) : null}
        </div>

        {sessionView === 'trace' ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <TraceView />
          </div>
        ) : (
          <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="messages-scroll">
            <ChildAgentBanner />
            {activeDetail ? (
              <MessageList
                messages={activeDetail.messages}
                platform={platform}
                msgFilter={msgFilter}
                timing={timing}
                visibleUnitCount={visibleUnitCount}
                onLoadMore={() => setVisibleUnitCount((c) => c + MSG_BATCH_SIZE)}
              />
            ) : activeQuery.isError ? (
              <div className="py-8 text-center text-sm text-destructive">{(activeQuery.error as Error).message}</div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading messages…</div>
            )}
          </div>
        )}
      </div>
    </MessageActionsContext.Provider>
  );
}
