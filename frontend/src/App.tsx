import { ArrowLeft, Copy, PanelLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PlatformBar } from '@/components/PlatformBar';
import { Sidebar } from '@/components/Sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useVersionPoller } from '@/hooks/useVersionPoller';
import { DEMO } from '@/demo/flag';
import { useAppStore } from '@/store';
import type { MainView } from '@/store';
import { InsightsView } from '@/views/insights/InsightsView';
import { LibraryView } from '@/views/library/LibraryView';
import { PromptsView } from '@/views/prompts/PromptsView';
import { SessionsView } from '@/views/sessions/SessionsView';
import { cn } from '@/lib/utils';

const TABS: { view: MainView; label: string; title: string }[] = [
  { view: 'sessions', label: '会话', title: '浏览与回放会话：消息、工具调用、耗时与 token' },
  { view: 'insights', label: '分析', title: '聚合统计：工具调用、错误聚类、token 消耗、按日趋势' },
  { view: 'prompts', label: 'Prompts', title: '自动提取历史里所有真人 prompt：搜索、收藏、聚类分析与改写' },
  { view: 'library', label: '资产库', title: 'Prompt 资产库：标签管理，一键安装为各工具的 slash command' },
];

export default function App() {
  useVersionPoller();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const navigationPanel = useRef<HTMLDivElement>(null);
  const returnToContent = useCallback(() => {
    setNavigationOpen(false);
    if (window.matchMedia('(max-width: 767px)').matches) {
      requestAnimationFrame(() => navigationToggle.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (navigationOpen && window.matchMedia('(max-width: 767px)').matches) {
      navigationPanel.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }
  }, [navigationOpen]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const onResize = () => {
      setNavigationOpen(false);
      if (!media.matches && navigationPanel.current?.contains(document.activeElement)) {
        requestAnimationFrame(() => navigationToggle.current?.focus());
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !media.matches && navigationOpen &&
        !(event.target as HTMLElement).closest('[role="dialog"]')) {
        event.preventDefault();
        returnToContent();
      }
    };
    media.addEventListener('change', onResize);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      media.removeEventListener('change', onResize);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navigationOpen, returnToContent]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden">
        {DEMO ? (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-[#e3b341]/40 bg-[#e3b341]/15 px-3 py-1.5 text-center text-xs text-[#e3b341]">
            <span>🧪 Demo mode — synthetic sample data (not real user sessions). Inspect your own agent logs:</span>
            <button
              type="button"
              title="Copy install command"
              onClick={() => {
                navigator.clipboard?.writeText('npx @alloevil/agent-xray').then(
                  () => toast.success('Copied: npx @alloevil/agent-xray'),
                  () => toast.error('Copy failed')
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-[#e3b341]/50 bg-black/20 px-1.5 py-0.5 font-mono text-[11px] hover:border-[#e3b341] hover:text-foreground"
            >
              npx @alloevil/agent-xray
              <Copy className="h-3 w-3" />
            </button>
            <a
              href="https://github.com/alloevil/AgentXRay"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        ) : null}
        <PlatformBar />
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1 md:hidden">
          <span className="text-sm font-semibold">AgentXRay</span>
          <button ref={navigationToggle} type="button" aria-expanded={navigationOpen} aria-controls="session-navigation"
            className="inline-flex min-h-11 items-center gap-2 rounded px-2 text-sm text-primary focus-visible:outline"
            onClick={() => navigationOpen ? returnToContent() : setNavigationOpen(true)}>
            {navigationOpen ? <ArrowLeft className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
            {navigationOpen ? '返回内容' : '会话列表'}
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[280px_minmax(0,1fr)]">
          <div id="session-navigation" ref={navigationPanel}
            className={cn('min-h-0 min-w-0 flex-col md:flex', navigationOpen ? 'flex' : 'hidden')}>
            <Sidebar onNavigate={returnToContent} />
          </div>
          <main className={cn('min-h-0 min-w-0 flex-col overflow-hidden md:flex', navigationOpen ? 'hidden' : 'flex')}>
            <Tabs
              value={view}
              onValueChange={(v) => setView(v as MainView)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="shrink-0 overflow-x-auto border-b border-border px-2 pt-1 md:px-4 md:pt-3">
                <TabsList className="h-11 bg-transparent p-0 md:h-9">
                  {TABS.map((tab) => (
                    <TabsTrigger
                      key={tab.view}
                      value={tab.view}
                      title={tab.title}
                      className="min-h-11 rounded-b-none border-b-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-transparent md:min-h-0 md:px-4"
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="sessions" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <SessionsView />
              </TabsContent>
              <TabsContent value="insights" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <InsightsView />
              </TabsContent>
              <TabsContent value="prompts" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <PromptsView />
              </TabsContent>
              <TabsContent value="library" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <LibraryView />
              </TabsContent>
            </Tabs>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
