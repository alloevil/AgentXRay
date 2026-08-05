// 子 Agent section (session summary) + the "viewing child agent" banner.
// Ported from public/js/app.js loadChildAgents/viewChildAgent: chips list the
// omp/claude-code subagents spawned by the current session; clicking one loads
// its transcript (viewingChildAgent), the banner offers the way back.

import { useAppStore } from '@/store';
import { childAgentLabel, hasChildAgents, useChildrenQuery } from './childAgents';

/** Summary block: one chip per spawned subagent. Hidden when the platform has no children API or the list is empty. */
export function ChildAgentsSection() {
  const platform = useAppStore((s) => s.platform);
  const setViewingChildAgent = useAppStore((s) => s.setViewingChildAgent);
  const childrenQuery = useChildrenQuery();
  const children = childrenQuery.data ?? [];
  if (!hasChildAgents(platform) || !children.length) return null;

  return (
    <div className="mt-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide">
        🌳 子 Agent{' '}
        <span className="font-normal normal-case tracking-normal text-muted-foreground">
          — 本会话派生的后台 agent，点击查看其完整执行记录
        </span>
      </h3>
      <div>
        {children.map((c) => {
          const label = childAgentLabel(c, platform);
          const tip = [c.title || label, c.agentType].filter(Boolean).join(' · ');
          return (
            <span
              key={c.name}
              className="mb-0.5 mr-1.5 inline-block cursor-pointer rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs hover:bg-accent"
              title={`${tip} — ${c.messageCount} 条消息，${c.toolCallCount} 次工具调用`}
              onClick={() => setViewingChildAgent(c.name)}
            >
              🤖 {label}{' '}
              <span className="text-muted-foreground">
                · {c.messageCount} msg · 🔧 {c.toolCallCount}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Banner above the messages list while a child transcript is loaded. */
export function ChildAgentBanner() {
  const platform = useAppStore((s) => s.platform);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const setViewingChildAgent = useAppStore((s) => s.setViewingChildAgent);
  const childrenQuery = useChildrenQuery();
  if (!viewingChildAgent) return null;

  const meta = (childrenQuery.data ?? []).find((c) => c.name === viewingChildAgent);
  const label = meta ? childAgentLabel(meta, platform) : viewingChildAgent;
  return (
    <div className="mb-2 rounded-lg border border-border px-3 py-2 text-sm">
      🌳 正在查看子 Agent <b>{label}</b> 的执行记录 —{' '}
      <a
        href="#"
        className="text-[#58a6ff] hover:underline"
        onClick={(e) => {
          e.preventDefault();
          setViewingChildAgent(null);
        }}
      >
        返回主会话
      </a>
    </div>
  );
}
