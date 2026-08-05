// Child-agent (omp / claude-code spawned subagent) data hooks, shared by
// TraceView, ChildAgentsSection and the sessions detail (via useActiveSessionDetail).
// Behavior ported from public/js/app.js (childrenEndpoint/childAgentLabel/getSessionChildren).

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getSessionChild, getSessionChildren, getSessionDetail } from '@/api/client';
import type { ChildAgentSummary, Platform, SessionDetail } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';

export type ChildPlatform = 'omp' | 'claude-code';

/** Platforms whose sessions can spawn child agents. */
export function hasChildAgents(platform: Platform): platform is ChildPlatform {
  return platform === 'omp' || platform === 'claude-code';
}

/** Chip/span label: claude-code children carry meta (description/agentType); omp children only a name. */
export function childAgentLabel(c: ChildAgentSummary, platform: Platform): string {
  return (platform === 'claude-code' ? c.description || c.agentType : '') || c.name;
}

/** Subagent list of the selected session. Legacy swallows fetch errors → empty list. */
export function useChildrenQuery(): UseQueryResult<ChildAgentSummary[]> {
  const platform = useAppStore((s) => s.platform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const settings = useAppStore((s) => s.settings);
  const dir = dirForPlatform(settings, platform) || undefined;
  return useQuery({
    queryKey: ['session-children', platform, sessionId],
    enabled: hasChildAgents(platform) && !!sessionId,
    queryFn: () =>
      getSessionChildren(platform as ChildPlatform, sessionId, dir).catch(
        () => [] as ChildAgentSummary[]
      ),
  });
}

/** The selected (parent) session detail — same key ViewSessions uses, cache is shared. */
export function useSessionDetailQuery(): UseQueryResult<SessionDetail> {
  const platform = useAppStore((s) => s.platform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const dir = dirForPlatform(settings, platform) || undefined;
  return useQuery({
    queryKey: ['session', platform, sessionId],
    enabled: !!sessionId && (platform !== 'openclaw' || !!agent),
    queryFn: () => getSessionDetail(platform, sessionId, { agent: agent || undefined, dir }),
  });
}

/** Transcript of the child agent being viewed (viewingChildAgent). */
export function useChildSessionQuery(): UseQueryResult<SessionDetail> {
  const platform = useAppStore((s) => s.platform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const child = useAppStore((s) => s.viewingChildAgent);
  const settings = useAppStore((s) => s.settings);
  const dir = dirForPlatform(settings, platform) || undefined;
  return useQuery({
    queryKey: ['session-child', platform, sessionId, child],
    enabled: hasChildAgents(platform) && !!sessionId && !!child,
    queryFn: () => getSessionChild(platform as ChildPlatform, sessionId, child as string, dir),
  });
}

/**
 * SessionDetail powering the messages/trace area: the child transcript while a
 * child agent is being viewed, otherwise the parent session (legacy swapped
 * state.sessionData in viewChildAgent).
 */
export function useActiveSessionDetail(): UseQueryResult<SessionDetail> {
  const child = useAppStore((s) => s.viewingChildAgent);
  const parentQuery = useSessionDetailQuery();
  const childQuery = useChildSessionQuery();
  return child ? childQuery : parentQuery;
}
