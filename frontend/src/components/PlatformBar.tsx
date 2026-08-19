import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getAgents, getSessions } from '@/api/client';
import type { Platform } from '@/api/types';
import { PLATFORM_LABELS, PLATFORMS } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';
import { cn } from '@/lib/utils';

const PLATFORM_TIPS: Record<Platform, string> = {
  openclaw: 'OpenClaw 会话（~/.openclaw/agents）',
  codex: 'Codex 会话（~/.codex/sessions）',
  'claude-code': 'Claude Code 会话（~/.claude/projects）',
  hermes: 'Hermes 会话（~/.hermes）',
  omp: 'oh-my-pi 会话（~/.omp/agent/sessions）',
  dsh: 'DeepSeek Harness 会话（~/.dsh/sessions）',
};

// Probe every platform's session count once per page load (legacy
// probePlatformSessionCounts): 0 or unreachable = known empty → collapsible.
function usePlatformProbe() {
  const settings = useAppStore((s) => s.settings);
  return useQuery({
    queryKey: ['platform-probe', settings],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const entries = await Promise.all(
        PLATFORMS.map(async (p) => {
          try {
            const list =
              p === 'openclaw'
                ? await getAgents(settings.openclawDir || undefined)
                : await getSessions(p, { dir: dirForPlatform(settings, p) || undefined });
            return [p, Array.isArray(list) ? list.length : 0] as const;
          } catch {
            return [p, 0] as const; // unreachable = treat as empty
          }
        })
      );
      return Object.fromEntries(entries) as Record<Platform, number>;
    },
  });
}

export function PlatformBar() {
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const [expanded, setExpanded] = useState(false);
  const { data: counts } = usePlatformProbe();

  // While probing (counts undefined) every platform stays visible — same as legacy.
  const isCollapsed = (p: Platform) => p !== platform && !expanded && counts?.[p] === 0;
  const shown = PLATFORMS.filter((p) => !isCollapsed(p));
  const collapsed = PLATFORMS.filter((p) => isCollapsed(p));

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-panel-alt/95 px-3 py-2">
      {shown.map((p) => (
        <button
          key={p}
          type="button"
          title={PLATFORM_TIPS[p]}
          onClick={() => setPlatform(p)}
          className={cn(
            'rounded-md border px-3 py-1 text-sm transition-colors',
            p === platform
              ? 'border-primary/60 bg-primary/15 text-foreground'
              : 'border-border bg-transparent text-muted-foreground hover:border-primary/40 hover:text-foreground'
          )}
        >
          {PLATFORM_LABELS[p]}
        </button>
      ))}
      {collapsed.length > 0 && (
        <button
          type="button"
          title={`暂无会话的平台：${collapsed.map((p) => PLATFORM_LABELS[p]).join('、')} — 点击展开`}
          onClick={() => setExpanded(true)}
          className="rounded-md border border-dashed border-border px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          +{collapsed.length}
        </button>
      )}
    </div>
  );
}
