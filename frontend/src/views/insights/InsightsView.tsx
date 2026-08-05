// 分析 view — explicit 全局分析 / 本会话分析 segmented control (spec V3).
// Scope is auto-picked once on first entry, then sticky: selecting or losing a
// session never implicitly morphs the user's choice (legacy loadInsights).
// When the sticky choice is 'session' but no session is selected, the global
// variant renders and the seg reflects what is actually shown.

import { useEffect } from 'react';
import { useAppStore } from '@/store';
import { InsightsScopeSeg } from './bits';
import { GlobalInsights } from './GlobalInsights';
import { SessionInsights } from './SessionInsights';

export function InsightsView() {
  const insightsScope = useAppStore((s) => s.insightsScope);
  const setInsightsScope = useAppStore((s) => s.setInsightsScope);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const hasSession = !!selectedSessionId;

  // Auto-pick only on first entry into 分析 (null = never entered).
  useEffect(() => {
    if (insightsScope === null) setInsightsScope(hasSession ? 'session' : 'global');
  }, [insightsScope, hasSession, setInsightsScope]);

  const effective = insightsScope === 'session' && hasSession ? 'session' : 'global';

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <InsightsScopeSeg active={effective} hasSession={hasSession} onChange={setInsightsScope} />
      {effective === 'session' ? <SessionInsights /> : <GlobalInsights />}
    </div>
  );
}
