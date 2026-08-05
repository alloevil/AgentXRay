// Real-time tail: EventSource on /api/watch appending into the shared
// ['session', platform, id] query cache (legacy startSse/closeSse).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { watchUrl } from '@/api/client';
import type { SessionDetail, SessionMessage, SessionMeta } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';

export type SseStatus = 'off' | 'connecting' | 'live' | 'error';

/**
 * Watches the selected parent session while auto-refresh is on (suppressed when
 * a child transcript is being viewed). New messages are appended to the query
 * cache; `onNewMessages(count)` lets the caller expand pagination / auto-scroll.
 */
export function useSessionSse(onNewMessages: (count: number) => void): SseStatus {
  const platform = useAppStore((s) => s.platform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SseStatus>('off');
  const onNewRef = useRef(onNewMessages);
  onNewRef.current = onNewMessages;

  const dir = dirForPlatform(settings, platform);
  const enabled = autoRefresh && !!sessionId && !viewingChildAgent;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(
      watchUrl({ platform, sessionId, agent: agent || undefined, dir: dir || undefined })
    );
    es.addEventListener('connected', () => setStatus('live'));
    es.addEventListener('newMessages', (e) => {
      const payload = JSON.parse((e as MessageEvent).data || '{}') as {
        messages?: SessionMessage[];
        session?: Partial<SessionMeta>;
      };
      const newMsgs = payload.messages;
      if (!Array.isArray(newMsgs) || newMsgs.length === 0) return;
      queryClient.setQueryData<SessionDetail>(['session', platform, sessionId], (old) =>
        old
          ? { session: { ...old.session, ...(payload.session || {}) }, messages: [...old.messages, ...newMsgs] }
          : old
      );
      onNewRef.current(newMsgs.length);
      // Refresh sidebar counters (legacy loadSessions(true) on newMessages)
      queryClient.invalidateQueries({ queryKey: ['sessions', platform] });
    });
    // EventSource auto-reconnects on error — just reflect the state (🔴 Live)
    es.addEventListener('error', () => setStatus('error'));
    return () => {
      es.close();
      setStatus('off');
    };
  }, [enabled, platform, sessionId, agent, dir, queryClient]);

  return status;
}
