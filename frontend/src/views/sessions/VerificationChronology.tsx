import { useState } from 'react';
import type { analyzeVerificationChronology, ChronologyCheck, ExecutionEvidence } from './diagnostics';
import { messageAnchorId } from './lib';

const STATES = { success: '成功返回', failure: '失败', running: '记录为执行中', cancelled: '取消 / 停止', unknown: '状态未知', 'no-result': '未记录结果' };

function OperationEvidence({ operation, onJump }: { operation: ExecutionEvidence; onJump: (id: string) => void }) {
  const anchor = operation.resultMessage ? messageAnchorId(operation.resultMessage) : null;
  const callAnchor = operation.toolCallId || messageAnchorId(operation.callMessage);
  return (
    <div className="mt-1 min-w-0 text-[11px]">
      <p className="break-all font-mono">{operation.command || operation.target || operation.toolName}</p>
      <p className="mt-1 text-muted-foreground">
        {STATES[operation.state]} · 调用 #{operation.callIndex + 1}
        {operation.resultIndex !== null ? ` → 结果 #${operation.resultIndex + 1}` : ''}
        {operation.basis ? ` · ${operation.basis === 'runner-command' ? '直接测试运行器' : '约定脚本名，未读取脚本内容'}` : ''}
      </p>
      {operation.commandMode ? <p className="mt-1 text-muted-foreground">{operation.commandMode === 'compound-fragment'
        ? '复合命令中的检查片段；执行与通过状态未知' : operation.commandMode === 'directory-prefix' ? '显式 cd 目录前缀 + 检查命令' : '直接检查命令'}</p> : null}
      <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{operation.evidence}</pre>
      <div className="mt-1 flex flex-wrap gap-2">
        {callAnchor ? <button type="button" className="min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => onJump(callAnchor)}>查看调用记录</button> : null}
        {anchor ? <button type="button" className="min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => onJump(`diagnostic-result-${anchor}`)}>查看结果记录</button> : null}
      </div>
    </div>
  );
}

function CheckEvidence({ check, onJump }: { check: ChronologyCheck; onJump: (id: string) => void }) {
  return (
    <div>
      <p className="mt-1 text-[10px] text-muted-foreground">{check.scope === 'same-recorded-directory' ? '显式记录工作目录相同；仍不证明文件覆盖' : '目录关联未知；仅同会话记录顺序，不证明文件覆盖'}</p>
      <OperationEvidence operation={check.operation} onJump={onJump} />
    </div>
  );
}

export function VerificationChronology({ chronology, onJump }: {
  chronology: ReturnType<typeof analyzeVerificationChronology>;
  onJump: (id: string) => void;
}) {
  const [visible, setVisible] = useState(5);
  const [checksVisible, setChecksVisible] = useState(5);
  return (
    <details className="mt-3 rounded border border-primary/30 bg-primary/5 p-2" data-testid="verification-chronology">
      <summary className="cursor-pointer font-medium">修改—检查时序 · {chronology.successfulModifications} 次修改工具成功返回 · {chronology.withoutLaterCheck} 次其后未记录检查</summary>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {chronology.changedAfterLastPassedCheck} 次在已成功检查后又有修改、其后未记录可识别检查。这里只核对调用/结果顺序，不证明文件内容实际变化、测试覆盖或任务通过。
        并行/重叠检查不算修改后的检查，已知不同目录不关联，缺少目录只显示时序。跨会话验证及隐含文件修改不在范围内。
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        识别到 {chronology.modificationCalls} 次明确目标的修改调用、{chronology.checks.length} 次检查调用；
        {chronology.unconfirmedModifications} 次修改未有明确成功结果，{chronology.unclassifiedModificationCalls} 次修改工具参数/格式不支持，
        {chronology.unclassifiedShellCalls} 次执行调用未识别检查片段。复合命令的片段是否执行或通过保持未知；test/build/lint/typecheck 脚本名不是脚本语义验证。
      </p>
      {!chronology.modifications.length ? <p className="mt-2 text-muted-foreground">未记录到本规则可确认的修改工具成功结果，不代表没有修改。</p> : (
        <ol className="mt-3 max-h-[32rem] space-y-3 overflow-y-auto" aria-label="修改与检查时序证据">
          {chronology.modifications.slice(0, visible).map((row) => (
            <li key={row.operation.callIndex + ':' + row.operation.toolCallId} className="min-w-0 rounded border border-border bg-card p-2" data-testid="modification-chronology">
              <p className="font-medium">{row.latestOrderAmbiguous ? '修改之后有多次检查；最近调用位于同一消息，顺序不唯一' : row.latestLater ? `修改之后有检查调用 · 最近${STATES[row.latestLater.operation.state]}`
                : row.priorSuccess ? '检查成功后又有修改；其后未记录可识别检查' : '修改之后未记录可识别检查'}</p>
              <OperationEvidence operation={row.operation} onJump={onJump} />
              {row.priorSuccess ? <details className="mt-2 rounded border border-border p-2"><summary className="cursor-pointer">修改之前的最近成功检查</summary><CheckEvidence check={row.priorSuccess} onJump={onJump} /></details> : null}
              {row.latestLater ? <div className="mt-2 border-t border-border pt-2"><p className="font-medium">修改之后的最近检查（不是验收结论）</p><CheckEvidence check={row.latestLater} onJump={onJump} /></div> : null}
              {row.laterChecks.length > 1 ? <details className="mt-2"><summary className="cursor-pointer">全部 {row.laterChecks.length} 次后续检查（含失败和未知）</summary>
                <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto">{row.laterChecks.map((check, index) => <li key={index}><CheckEvidence check={check} onJump={onJump} /></li>)}</ol>
              </details> : null}
              {row.overlappingChecks.length ? <details className="mt-2"><summary className="cursor-pointer">{row.overlappingChecks.length} 次与修改重叠 / 已在运行的检查，不算后续验证</summary>
                <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto">{row.overlappingChecks.map((check, index) => <li key={index}><CheckEvidence check={check} onJump={onJump} /></li>)}</ol>
              </details> : null}
              {row.excludedScopeChecks ? <p className="mt-2 text-[10px] text-muted-foreground">{row.excludedScopeChecks} 次检查因目录不同或冲突未建立关系。</p> : null}
            </li>
          ))}
        </ol>
      )}
      {visible < chronology.modifications.length ? <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1" onClick={() => setVisible(visible + 5)}>再显示 {Math.min(5, chronology.modifications.length - visible)} 条修改记录</button> : null}
      <details className="mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer">全部可识别检查 · {chronology.checks.length} 次</summary>
        <ol className="mt-2 max-h-72 space-y-2 overflow-y-auto">{chronology.checks.slice(0, checksVisible).map((operation, index) => <li key={index}><OperationEvidence operation={operation} onJump={onJump} /></li>)}</ol>
        {checksVisible < chronology.checks.length ? <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1" onClick={() => setChecksVisible(checksVisible + 5)}>再显示 {Math.min(5, chronology.checks.length - checksVisible)} 次检查</button> : null}
      </details>
    </details>
  );
}
