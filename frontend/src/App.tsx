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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden">
        {DEMO ? (
          <div className="border-b border-[#e3b341]/40 bg-[#e3b341]/15 px-3 py-1.5 text-center text-xs text-[#e3b341]">
            🧪 Demo mode — synthetic sample data (not real user sessions).{' '}
            <a
              href="https://github.com/alloevil/AgentXRay"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Run AgentXRay locally
            </a>{' '}
            to inspect your own agent logs.
          </div>
        ) : null}
        <PlatformBar />
        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
          <Sidebar />
          <main className="flex min-h-0 flex-col overflow-hidden">
            <Tabs
              value={view}
              onValueChange={(v) => setView(v as MainView)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-b border-border px-4 pt-3">
                <TabsList className="bg-transparent p-0">
                  {TABS.map((tab) => (
                    <TabsTrigger
                      key={tab.view}
                      value={tab.view}
                      title={tab.title}
                      className="rounded-b-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="sessions" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                <SessionsView />
              </TabsContent>
              <TabsContent value="insights" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                <InsightsView />
              </TabsContent>
              <TabsContent value="prompts" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                <PromptsView />
              </TabsContent>
              <TabsContent value="library" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                <LibraryView />
              </TabsContent>
            </Tabs>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
