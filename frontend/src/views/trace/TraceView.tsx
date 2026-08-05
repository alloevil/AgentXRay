// Trace waterfall view (Langfuse-style per-turn spans), ported from
// public/js/app.js renderTrace: one card per user turn, bars scaled to the
// turn's own timeline — blue model / green tool / red tool-error / purple
// spawned sub-agent (overlap = parallelism). Clicking a bar opens the span
// sidebar; clicking a purple bar loads that child agent's transcript.

import { useEffect, useMemo, useState } from 'react';
import { buildTraceTurns, formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import type { TraceSpan, TraceTurn } from '@/lib/pure';
import { useAppStore } from '@/store';
import { SpanSidebar } from './SpanSidebar';
import { childAgentLabel, useActiveSessionDetail, useChildrenQuery } from './childAgents';

const BAR_COLORS: Record<TraceSpan['kind'], string> = {
  chat: '#58a6ff',
  tool: '#3fb950',
  'tool-error': '#f85149',
  agent: '#d2a8ff',
};

const LEGEND: { color: string; label: string }[] = [
  { color: '#58a6ff', label: '模型推理' },
  { color: '#3fb950', label: '工具执行' },
  { color: '#f85149', label: '工具报错' },
  { color: '#d2a8ff', label: '子 Agent' },
];

function spanIcon(kind: TraceSpan['kind']): string {
  return kind === 'chat' ? '🤖' : kind === 'agent' ? '🌳' : '🔧';
}

function TurnCard({
  turn,
  onSpanClick,
  onAgentClick,
}: {
  turn: TraceTurn;
  onSpanClick: (span: TraceSpan) => void;
  onAgentClick: (name: string) => void;
}) {
  const dur = Math.max(turn.end - turn.start, 1);
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-baseline gap-2.5 border-b border-border bg-[hsl(var(--panel-alt))] px-3 py-1.5 text-sm">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {new Date(turn.start).toLocaleTimeString()}
        </span>
        <span className="min-w-0 flex-1 truncate" title={turn.text}>
          👤 {turn.text}
        </span>
        <span className="shrink-0 font-mono text-xs text-[#58a6ff]">
          {formatDurationCompact(turn.end - turn.start)}
        </span>
      </div>
      <div className="px-3 pb-2.5 pt-1.5">
        {turn.spans.map((s, i) => {
          const left = ((s.start - turn.start) / dur) * 100;
          const width = Math.max(((s.end - s.start) / dur) * 100, 0.4);
          const durText = formatDurationCompact(s.end - s.start);
          const showDur = width < 78; // avoid overflowing the track for near-full bars
          const isAgent = s.kind === 'agent';
          const title = isAgent
            ? `子 Agent ${s.label} — ${durText}，点击查看其执行记录`
            : `${s.label} — ${durText}，点击查看详情`;
          return (
            <div key={i} className="mb-1 grid grid-cols-[170px_1fr] items-center gap-2.5">
              <div
                className="truncate text-right font-mono text-xs text-muted-foreground"
                title={s.label}
              >
                {spanIcon(s.kind)} {s.label}
              </div>
              <div className="relative h-3.5">
                <div
                  className="absolute top-0 h-3.5 cursor-pointer rounded-sm opacity-90 hover:opacity-100 hover:outline hover:outline-1 hover:outline-foreground"
                  style={{
                    left: `${left.toFixed(2)}%`,
                    width: `${width.toFixed(2)}%`,
                    background: BAR_COLORS[s.kind],
                  }}
                  title={title}
                  onClick={() => {
                    if (isAgent) {
                      if (s.agentName) onAgentClick(s.agentName);
                    } else {
                      onSpanClick(s);
                    }
                  }}
                >
                  {showDur && (
                    <span className="absolute -top-px left-[calc(100%+6px)] whitespace-nowrap font-mono text-[0.68rem] leading-[14px] text-muted-foreground">
                      {durText}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TraceView() {
  const platform = useAppStore((s) => s.platform);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const setViewingChildAgent = useAppStore((s) => s.setViewingChildAgent);
  const detail = useActiveSessionDetail();
  const childrenQuery = useChildrenQuery();
  const msgs = detail.data?.messages;
  const children = childrenQuery.data;
  const [activeSpan, setActiveSpan] = useState<TraceSpan | null>(null);

  // Transcript swap (session/child change) invalidates the open span
  useEffect(() => setActiveSpan(null), [msgs]);

  const turns = useMemo(() => {
    // Child trace must not embed sibling agent spans (legacy childAgentViewing guard)
    const agentSpans = viewingChildAgent
      ? []
      : (children ?? []).map((c) => ({
          name: c.name,
          label: childAgentLabel(c, platform),
          start: parseTimestampMs(c.timestamp),
          end: parseTimestampMs(c.lastActivity),
        }));
    return buildTraceTurns(msgs ?? [], agentSpans);
  }, [msgs, children, viewingChildAgent, platform]);

  if (detail.isLoading || (!viewingChildAgent && childrenQuery.isLoading)) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!turns.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        此会话没有可视化的时间数据（消息缺少时间戳或没有模型/工具活动）。
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
        {LEGEND.map((l) => (
          <span key={l.label}>
            <span
              className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle"
              style={{ background: l.color }}
            />
            {l.label}
          </span>
        ))}
        <span className="ml-auto">每轮独立时间轴 · 点击色条查看详情</span>
      </div>
      {turns.map((turn, i) => (
        <TurnCard
          key={`${turn.start}-${i}`}
          turn={turn}
          onSpanClick={setActiveSpan}
          onAgentClick={setViewingChildAgent}
        />
      ))}
      {activeSpan && (
        <SpanSidebar span={activeSpan} msgs={msgs ?? []} onClose={() => setActiveSpan(null)} />
      )}
    </div>
  );
}
