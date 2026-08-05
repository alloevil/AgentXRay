// 📊 Prompt 画像 — legacy renderAnalysisHtml: loading block with elapsed ticker,
// header, overall/llmError/rawText, portrait sub-sections (PromptsPortrait.tsx),
// and template cluster rows (expand → suggestion/rewrite, 📥 入库 prefill).

import { useEffect, useState } from 'react';

import type { Platform, PromptAnalysis, PromptCluster } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';

import { CopyButton } from './PromptItemRow';
import { Metric, PromptsPortrait, buildTopicColor } from './PromptsPortrait';

interface PromptsAnalysisProps {
  analysis: PromptAnalysis | null;
  loading: boolean;
  startedAt: number | null;
  platform: Platform;
  savedPatterns: Set<string>;
  onSaveCluster: (cluster: PromptCluster) => void;
}

export function PromptsAnalysis({
  analysis,
  loading,
  startedAt,
  platform,
  savedPatterns,
  onSaveCluster,
}: PromptsAnalysisProps) {
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (!loading) return;
    const tick = () => setElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [loading, startedAt]);
  useEffect(() => setExpanded({}), [analysis]);

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-card p-3">
        <h3 className="mb-2 text-sm font-semibold">📊 Prompt 画像</h3>
        <div className="text-sm text-muted-foreground">
          Claude 分析中… 已耗时 <span className="text-foreground">{elapsed}s</span> · 约 1-2
          分钟(聚类 → 归因 → 主题标注 → LLM 建议)
          <br />
          <span className="text-xs">结果会自动保存，可离开此页稍后回来看</span>
        </div>
      </section>
    );
  }
  if (!analysis || analysis.platform !== platform) return null;

  const a = analysis;
  const topicColor = buildTopicColor(a);
  const displayClusters = (a.clusters || []).filter((c) => c.count > 1).slice(0, 20);

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 text-sm font-semibold">
        📊 Prompt 画像{' '}
        <span className="font-normal text-muted-foreground">
          — {a.totalClusters} 个模板簇 /{' '}
          {a.generatedAt ? new Date(a.generatedAt).toLocaleString() : '—'}
          {a.persisted ? ' · 已保存的上次结果 · 点击重新分析可更新' : ''}
        </span>
      </h3>

      {a.llmError && (
        <div className="mb-2 rounded border border-destructive/60 bg-destructive/10 p-2 text-xs text-destructive">
          LLM 分析失败: {a.llmError} — 以下为聚类与归因结果
        </div>
      )}
      {typeof a.rawText === 'string' && a.rawText && (
        <div className="mb-3 text-sm">
          <Markdown text={a.rawText} />
        </div>
      )}
      {(a.overall || []).length > 0 && (
        <ul className="mb-2 list-disc space-y-1 pl-5 text-sm">
          {a.overall.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      )}

      <PromptsPortrait analysis={a} clusters={displayClusters} topicColor={topicColor} />

      {displayClusters.length === 0 ? (
        <div className="text-sm text-muted-foreground">没有出现 2 次以上的模板</div>
      ) : (
        <div className="space-y-1">
          {displayClusters.map((c, ci) => {
            const attr = c.attribution;
            const saved = savedPatterns.has(c.pattern);
            const open = expanded[ci] ?? false;
            const s = c.suggestion;
            return (
              <div key={ci} className="rounded border border-border/70">
                <div
                  className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent/40"
                  onClick={() => setExpanded((prev) => ({ ...prev, [ci]: !open }))}
                >
                  <span className="text-muted-foreground">{open ? '▼' : '▶'}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.pattern}>
                    {c.pattern}
                  </span>
                  {c.topic && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px]"
                      style={{ background: `${topicColor(c.topic)}33`, color: topicColor(c.topic) }}
                    >
                      {c.topic}
                    </span>
                  )}
                  <Metric>×{c.count}</Metric>
                  {attr && <Metric>avg {attr.avgMessages} msgs</Metric>}
                  {attr && <Metric>avg {attr.avgToolCalls} tools</Metric>}
                  {attr && <Metric warn={(attr.errorRate ?? 0) > 10}>err {attr.errorRate}%</Metric>}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={saved}
                    title="以本簇为模板存入 Prompt Library（自动取公共前缀 + $ARGUMENTS）"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!saved) onSaveCluster(c);
                    }}
                  >
                    {saved ? '✓ 已入库' : '📥 入库'}
                  </Button>
                </div>
                {open && (
                  <div className="border-t border-border/70 p-2 text-sm">
                    {s ? (
                      <>
                        {s.assessment && <div className="text-foreground/90">{s.assessment}</div>}
                        {(s.issues || []).length > 0 && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                            {s.issues!.map((issue, i) => (
                              <li key={i}>{issue}</li>
                            ))}
                          </ul>
                        )}
                        {s.rewrite && (
                          <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 p-2">
                            <div className="mb-1 text-xs font-semibold text-primary">建议改写</div>
                            <Markdown text={s.rewrite} />
                            <div className="mt-1">
                              <CopyButton text={s.rewrite} />
                            </div>
                            {s.rationale && (
                              <div className="mt-1 text-xs text-muted-foreground">{s.rationale}</div>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        此模板未参与 LLM 分析(仅 top 8 高频簇)
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
