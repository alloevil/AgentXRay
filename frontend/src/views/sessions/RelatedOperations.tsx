import { useState } from 'react';
import type { RelatedOperation } from './diagnostics';
import { formatDate, messageAnchorId } from './lib';

const STATES = {
  success: '成功（工具结果）', failure: '失败', running: '执行中', cancelled: '取消 / 停止', unknown: '未知',
};
const COLORS = {
  success: 'text-emerald-400', failure: 'text-destructive', running: 'text-amber-500',
  cancelled: 'text-muted-foreground', unknown: 'text-muted-foreground',
};

export function RelatedOperations({ operations, onJump }: {
  operations: RelatedOperation[];
  onJump: (id: string) => void;
}) {
  const [visible, setVisible] = useState(5);
  return (
    <details className="mt-3 rounded border border-primary/30 bg-primary/5 p-2" data-testid="related-operations">
      <summary className="cursor-pointer font-medium text-primary">后续相关操作 · {operations.length} 条候选（非恢复结论）</summary>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        这些调用在本事件最后一次失败之后发起；仅按记录参数关联，未执行新的验证。成功只描述该工具结果，不证明原问题已修复。
      </p>
      <ol className="mt-2 max-h-80 space-y-2 overflow-y-auto" aria-label="后续相关操作候选">
        {operations.slice(0, visible).map((operation) => {
          const anchor = messageAnchorId(operation.message);
          return (
            <li key={operation.index} className="min-w-0 rounded border border-border bg-card p-2" data-testid="related-operation">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-all">{operation.toolName}</strong>
                <span className={COLORS[operation.state]}>{STATES[operation.state]}</span>
              </div>
              <p className="mt-1 text-[11px]">
                {operation.relation === 'only-i'
                  ? '关联依据：同工具，只有顶层 i 参数不同，其余参数完全一致。'
                  : '关联依据：同一调用轮次、相同记录文件路径及显式目录信息；修改参数不同，不代表同一修复。'}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {operation.userTurn ? `第 ${operation.userTurn} 个用户轮次` : '首个用户消息之前'} · {formatDate(operation.message.timestamp)}
                {' · '}调用消息 #{operation.callIndex + 1} → 结果消息 #{operation.index + 1}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {operation.argumentsText.slice(0, 240)}{operation.argumentsText.length > 240 ? '…' : ''}
              </p>
              <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{operation.evidence}</pre>
              {anchor ? (
                <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1 hover:border-primary focus-visible:outline"
                  onClick={() => onJump(`diagnostic-result-${anchor}`)}>查看候选原始结果</button>
              ) : <p className="mt-2 text-muted-foreground">日志缺少定位标识</p>}
            </li>
          );
        })}
      </ol>
      {visible < operations.length ? (
        <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1 hover:border-primary"
          onClick={() => setVisible(visible + 5)}>再显示 {Math.min(5, operations.length - visible)} 条候选（剩余 {operations.length - visible}）</button>
      ) : null}
    </details>
  );
}
