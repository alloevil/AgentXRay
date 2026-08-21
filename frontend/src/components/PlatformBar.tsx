import { useEffect, useState } from 'react';
import type { Platform } from '@/api/types';
import { PLATFORM_LABELS, PLATFORMS } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { usePlatformProbe } from '@/hooks/usePlatformProbe';
import { pickAutoPlatform } from '@/lib/pure';
import { useAppStore } from '@/store';
import { cn } from '@/lib/utils';

const PLATFORM_TIPS: Record<Platform, string> = {
  openclaw: 'OpenClaw 会话（~/.openclaw/agents）',
  codex: 'Codex 会话（~/.codex/sessions）',
  'claude-code': 'Claude Code 会话（~/.claude/projects）',
  hermes: 'Hermes 会话（~/.hermes）',
  omp: 'oh-my-pi 会话（~/.omp/agent/sessions）',
  dsh: 'DeepSeek Harness 会话（~/.dsh/sessions）',
  gemini: 'Gemini CLI 会话（~/.gemini/tmp）',
};

export function PlatformBar() {
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const [expanded, setExpanded] = useState(false);
  const { data: counts } = usePlatformProbe();

  // First-launch auto-pick (#13): no platform persisted yet → land on the
  // first platform that actually has sessions. SessionList then auto-selects
  // the most recent session. The demo build already defaults to a populated
  // tab, and setPlatform persists the choice so this runs at most once.
  useEffect(() => {
    if (DEMO || !counts || useAppStore.getState().hasStoredPlatform) return;
    const target = pickAutoPlatform(counts, PLATFORMS);
    if (target) setPlatform(target);
  }, [counts, setPlatform]);

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
