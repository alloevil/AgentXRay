import { useState } from 'react';
import type { summarizeSessionHealth } from './diagnostics';
import { messageAnchorId } from './lib';

const LABELS = { success: '成功', failure: '失败', running: '记录为执行中', cancelled: '取消 / 停止', unknown: '未知', 'no-result': '未记录结果' };

export function SessionHealth({ health, onJump }: {
  health: ReturnType<typeof summarizeSessionHealth>;
  onJump: (id: string) => void;
}) {
  const [visible, setVisible] = useState(5);
  return (
    <div className="mt-3 space-y-3" data-testid="session-health">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded border border-border bg-background/40 p-2">
          <p className="font-medium">失败后完成证据</p>
          <p className="mt-1 text-xl font-semibold">{health.pendingRecords}<span className="ml-1 text-xs font-normal">条缺少同参成功记录</span></p>
          <p className="mt-1 text-[11px] text-muted-foreground">{health.pendingEvents} 个事件 · {health.recoveredRecords} 条已有同参成功记录</p>
        </div>
        <div className="rounded border border-border bg-background/40 p-2">
          <p className="font-medium">重复失败操作</p>
          <p className="mt-1 text-xl font-semibold">{health.repeatedEvents}<span className="ml-1 text-xs font-normal">个未闭合事件</span></p>
          <p className="mt-1 text-[11px] text-muted-foreground">包含 {health.repeatedRecords} 条失败记录；不推断因果或浪费时间。</p>
        </div>
        <div className="rounded border border-border bg-background/40 p-2">
          <p className="font-medium">后续相关结果</p>
          <p className="mt-1 text-xl font-semibold">{health.candidateResults}<span className="ml-1 text-xs font-normal">条去重候选</span></p>
          <p className="mt-1 text-[11px] text-muted-foreground">关联 {health.candidateEvents} 个事件，候选成功也不等于恢复。</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{Object.entries(health.candidateStates).map(([state, count]) => `${LABELS[state as keyof typeof LABELS]} ${count}`).join(' · ')}</p>
        </div>
      </div>
      <details className="rounded border border-border p-2" data-testid="completion-evidence">
        <summary className="cursor-pointer font-medium">调用结果缺口 · {health.gaps.length} 条（仅日志状态）</summary>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          {health.callCount} 条调用，{health.toolResultCount} 条结果记录。按调用 ID 关联最后一个已记录结果，不检测实时进程，不代表会话已结束。
          未知可能来自日志字段不完整，不等于失败；取消 / 停止不算缺少完成证据。
          {health.orphanResults} 条孤立 / 先于调用的结果；{health.unassignedResults} 条结果无法唯一归属；{health.ambiguousCalls} 条调用标识缺失或重复。
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]" aria-label="调用最后记录状态">
          {Object.entries(health.callStates).map(([state, count]) => <span key={state} className="rounded border border-border px-2 py-1">{LABELS[state as keyof typeof LABELS]} {count}</span>)}
        </div>
        {!health.gaps.length ? <p className="mt-2 text-muted-foreground">未发现本规则的调用结果缺口，不代表任务通过。</p> : (
          <ol className="mt-3 max-h-72 space-y-2 overflow-y-auto" aria-label="调用结果缺口证据">
            {health.gaps.slice(0, visible).map((gap, index) => {
              const messageAnchor = messageAnchorId(gap.message);
              const anchor = gap.message.role === 'toolResult' ? messageAnchor && `diagnostic-result-${messageAnchor}` : gap.toolCallId || messageAnchor;
              return (
                <li key={`${gap.index}-${index}`} className="min-w-0 rounded border border-border p-2">
                  <p className="break-all font-medium">{gap.toolName} · {LABELS[gap.state]}</p>
                  <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{gap.evidence}</pre>
                  {anchor ? <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => onJump(anchor)}>查看调用或结果证据</button> : <p className="mt-2 text-muted-foreground">日志缺少定位标识</p>}
                </li>
              );
            })}
          </ol>
        )}
        {visible < health.gaps.length ? <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => setVisible(visible + 5)}>再显示 {Math.min(5, health.gaps.length - visible)} 条结果缺口</button> : null}
      </details>
    </div>
  );
}
