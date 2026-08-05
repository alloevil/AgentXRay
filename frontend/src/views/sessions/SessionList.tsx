// Sidebar session list: cards, >200-item virtualization, ↑↓ keyboard nav,
// auto-select-first — ported from legacy renderSessions/sessionCardHtml.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import type { SessionSummary } from '@/api/types';
import { formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { filterSessionList, formatDate } from './lib';
import { useSessionsList } from './queries';

const VIRT_THRESHOLD = 200; // below this many sessions, render everything
const VIRT_OVERSCAN = 10; // extra cards above/below the visible range
const VIRT_ESTIMATE = 96; // estimated card height incl. gap

const SOURCE_ICONS: Record<string, string> = {
  cli: '⌨️',
  telegram: '✈️',
  discord: '🎮',
  weixin: '💬',
  wechat: '💬',
  slack: '💼',
  web: '🌐',
  feishu: '🐦',
  whatsapp: '📱',
};

function chipTexts(session: SessionSummary): string[] {
  const chips: string[] = [];
  if (session.userCount) chips.push(`👤 ${session.userCount}`);
  if (session.assistantCount) chips.push(`🤖 ${session.assistantCount}`);
  if (session.toolCallCount) chips.push(`🔧 ${session.toolCallCount}`);
  if (session.spawnCount) chips.push(`🌳 ${session.spawnCount} spawn`);
  if (session.model) chips.push(`🧠 ${session.model.split('/').pop()}`);
  if (session.source) chips.push(`${SOURCE_ICONS[session.source.toLowerCase()] || '📡'} ${session.source}`);
  const startMs = parseTimestampMs(session.timestamp);
  const endMs = parseTimestampMs(session.lastActivity);
  if (startMs && endMs && endMs - startMs >= 5000) chips.push(`⏱ ${formatDurationCompact(endMs - startMs)}`);
  return chips;
}

function SessionCard({ session, active, onClick }: { session: SessionSummary; active: boolean; onClick: () => void }) {
  const preview = session.firstUserMessage
    ? session.firstUserMessage.length > 80
      ? session.firstUserMessage.slice(0, 80) + '…'
      : session.firstUserMessage
    : '';
  return (
    <div
      tabIndex={0}
      data-session-id={session.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      className={cn(
        'cursor-pointer rounded-md border px-2.5 py-2 text-xs transition-colors',
        active
          ? 'border-primary/70 bg-primary/10'
          : 'border-border bg-card/60 hover:border-primary/40 hover:bg-card'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{formatDate(session.timestamp)}</span>
        {session.status ? (
          <span className="rounded border border-border px-1 py-px text-[10px] uppercase">{session.status}</span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {chipTexts(session).map((chip) => (
          <span key={chip} className="rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground">
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-1 truncate font-medium text-foreground">{session.title || session.id}</div>
      {preview ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{preview}</div> : null}
    </div>
  );
}

export function SessionList({ filterTerm }: { filterTerm: string }) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const { data, isLoading, error } = useSessionsList();
  const sessions = data ?? [];
  const filtered = filterSessionList(sessions, filterTerm);
  const virtualized = filtered.length > VIRT_THRESHOLD;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRT_ESTIMATE,
    overscan: VIRT_OVERSCAN,
    enabled: virtualized,
    // Defers measurement flushes out of React's commit phase (flushSync warning)
    useAnimationFrameWithResizeObserver: true,
  });

  // Auto-select first session when nothing valid is selected (legacy loadSessions)
  useEffect(() => {
    if (!data) return;
    if (!data.some((s) => s.id === useAppStore.getState().selectedSessionId)) {
      setSelectedSessionId(data[0]?.id || '');
    }
  }, [data, setSelectedSessionId]);

  // ↑↓ keyboard navigation over the filtered list (legacy document keydown)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('[role="dialog"]')) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const state = useAppStore.getState();
      if (state.view !== 'sessions' || !filtered.length) return;
      const index = filtered.findIndex((item) => item.id === state.selectedSessionId);
      const nextIndex =
        event.key === 'ArrowDown' ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0);
      const next = filtered[nextIndex];
      if (!next || next.id === state.selectedSessionId) return;
      event.preventDefault();
      setSelectedSessionId(next.id);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [filtered, setSelectedSessionId]);

  // Keep the selected card visible (legacy scrollSessionIntoView) — also covers
  // ⌘K jumps landing on a card far outside the rendered window.
  useEffect(() => {
    if (!selectedSessionId) return;
    const idx = filtered.findIndex((s) => s.id === selectedSessionId);
    if (idx === -1) return;
    if (virtualized) {
      // rAF: scrollToIndex flushes synchronously — illegal inside the commit phase
      const raf = requestAnimationFrame(() => virtualizer.scrollToIndex(idx, { align: 'auto' }));
      return () => cancelAnimationFrame(raf);
    } else {
      parentRef.current
        ?.querySelector(`[data-session-id="${CSS.escape(selectedSessionId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, virtualized]);

  if (isLoading) {
    return <div className="p-2 text-xs text-muted-foreground">Loading sessions…</div>;
  }
  if (error) {
    return <div className="p-2 text-xs text-destructive">{(error as Error).message}</div>;
  }
  if (!filtered.length) {
    return <div className="p-2 text-xs text-muted-foreground">No sessions match this filter.</div>;
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="session-list">
      {virtualized ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const session = filtered[row.index];
            return (
              <div
                key={session.id}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 top-0 w-full pb-2"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <SessionCard
                  session={session}
                  active={session.id === selectedSessionId}
                  onClick={() => setSelectedSessionId(session.id)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              active={session.id === selectedSessionId}
              onClick={() => setSelectedSessionId(session.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
