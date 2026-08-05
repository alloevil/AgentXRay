// 画像 portrait sub-sections: 主题构成 bars, 周趋势 stacked columns, 差生榜.
// Split from PromptsAnalysis.tsx (300-line contract); logic = legacy renderAnalysisHtml.

import type { PromptAnalysis, PromptCluster } from '@/api/types';
import { cn } from '@/lib/utils';

export const PALETTE = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f778ba',
  '#a371f7',
  '#79c0ff',
  '#56d364',
  '#e3b341',
  '#ff7b72',
  '#8b949e',
];

/** Topic → color: topics[] order first, then any extras seen in weeklyTrend. */
export function buildTopicColor(a: PromptAnalysis): (topic: string) => string {
  const order = (a.topics || []).map((t) => t.topic);
  for (const w of a.weeklyTrend || []) {
    for (const t of Object.keys(w.topics || {})) if (!order.includes(t)) order.push(t);
  }
  return (t) => PALETTE[Math.max(0, order.indexOf(t)) % PALETTE.length];
}

export function Subhead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

export function Metric({ warn, children }: { warn?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground',
        warn && 'border-[#d29922] text-[#d29922]'
      )}
    >
      {children}
    </span>
  );
}

interface PromptsPortraitProps {
  analysis: PromptAnalysis;
  /** displayClusters (count > 1, top 20) — the 差生榜 basis */
  clusters: PromptCluster[];
  topicColor: (topic: string) => string;
}

/**
 * Renders 主题构成 / 周趋势 / 差生榜, plus the trailing 模板簇 subhead when any
 * of them rendered (legacy: subhead only separates portraits from clusters).
 */
export function PromptsPortrait({ analysis: a, clusters, topicColor }: PromptsPortraitProps) {
  const topics = a.topics || [];
  const maxTopicPrompts = Math.max(...topics.map((t) => t.prompts), 1);

  const weeks = (a.weeklyTrend || []).slice(-8);
  const maxWeekTotal = Math.max(...weeks.map((w) => w.total), 1);
  const usedTopics: string[] = [];
  for (const w of weeks) {
    for (const [t, n] of Object.entries(w.topics || {})) {
      if (n > 0 && !usedTopics.includes(t)) usedTopics.push(t);
    }
  }

  // 差生榜 — errorRate above the cluster-set mean, or avgMessages notably high.
  const attributed = clusters.filter((c) => c.attribution);
  let flops: PromptCluster[] = [];
  let meanErr = 0;
  if (attributed.length >= 2) {
    meanErr = attributed.reduce((s, c) => s + (c.attribution!.errorRate ?? 0), 0) / attributed.length;
    const meanMsgs =
      attributed.reduce((s, c) => s + (c.attribution!.avgMessages ?? 0), 0) / attributed.length;
    flops = attributed
      .filter(
        (c) =>
          (c.attribution!.errorRate ?? 0) > meanErr ||
          (c.attribution!.avgMessages ?? 0) > meanMsgs * 1.5
      )
      .sort((x, y) => (y.attribution!.errorRate ?? 0) - (x.attribution!.errorRate ?? 0))
      .slice(0, 5);
  }

  const hasAny = topics.length > 0 || weeks.length > 0 || flops.length > 0;

  return (
    <>
      {topics.length > 0 && (
        <>
          <Subhead>主题构成</Subhead>
          <div className="space-y-1">
            {topics.map((t) => (
              <div key={t.topic} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate" title={t.topic}>
                  {t.topic}
                </span>
                <div className="h-3 flex-1 overflow-hidden rounded bg-secondary">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${Math.max(2, Math.round((t.prompts / maxTopicPrompts) * 100))}%`,
                      background: topicColor(t.topic),
                    }}
                  />
                </div>
                <span className="w-36 shrink-0 text-right text-muted-foreground">
                  {t.prompts} prompts / {t.clusters} 簇
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {weeks.length > 0 && (
        <>
          <Subhead>周趋势（近 {weeks.length} 周）</Subhead>
          <div className="flex items-end gap-3">
            {weeks.map((w) => {
              const h = Math.max(2, Math.round((w.total / maxWeekTotal) * 64));
              const entries = Object.entries(w.topics || {})
                .filter(([, n]) => n > 0)
                .sort((x, y) => y[1] - x[1]);
              const tip = `${w.week} 起的一周: ${w.total} prompts${
                entries.length ? ' · ' + entries.map(([t, n]) => `${t} ${n}`).join(' · ') : ''
              }`;
              return (
                <div key={w.week} className="flex flex-col items-center gap-1" title={tip}>
                  <div className="flex w-6 flex-col-reverse overflow-hidden rounded-sm">
                    {entries.length ? (
                      entries.map(([t, n]) => (
                        <div
                          key={t}
                          style={{
                            height: Math.max(1, Math.round((n / w.total) * h)),
                            background: topicColor(t),
                          }}
                        />
                      ))
                    ) : (
                      <div style={{ height: h, background: PALETTE[PALETTE.length - 1] }} />
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{w.week.slice(5)}</span>
                </div>
              );
            })}
          </div>
          {usedTopics.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {usedTopics.map((t) => (
                <span key={t} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: topicColor(t) }}
                  />
                  {t}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {flops.length > 0 && (
        <>
          <Subhead>差生榜（错误率高于库均值 {meanErr.toFixed(1)}% 或平均轮数明显偏高）</Subhead>
          <div className="space-y-2">
            {flops.map((c) => (
              <div key={c.pattern} className="rounded border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={c.pattern}>
                    {c.pattern}
                  </span>
                  <Metric warn={(c.attribution!.errorRate ?? 0) > meanErr}>
                    err {c.attribution!.errorRate}%
                  </Metric>
                  <Metric>avg {c.attribution!.avgMessages} msgs</Metric>
                  <Metric>×{c.count}</Metric>
                </div>
                {(c.errorSamples || []).slice(0, 3).map((sm, i) => (
                  <div key={i} className="mt-1 truncate text-muted-foreground">
                    {String(sm).replace(/\s+/g, ' ').slice(0, 200)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {hasAny && <Subhead>模板簇</Subhead>}
    </>
  );
}
