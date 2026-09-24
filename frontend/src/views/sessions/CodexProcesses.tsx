import { useState } from 'react';
import type { analyzeCodexProcesses, CodexProcessEvidence } from './diagnostics';
import type { SessionMessage } from '@/api/types';
import { messageAnchorId } from './lib';

const STATES = { success: '进程退出：成功', failure: '进程退出：失败', running: '最后记录为运行中', unknown: '完成状态未知', 'no-result': '未记录返回结果' };
const ISSUES: Record<string, string> = {
  'ambiguous-launch': '启动调用或其结果不唯一', 'reused-process-id': '进程标识在本会话中重复使用',
  'ambiguous-poll': '轮询调用标识不唯一', 'overlapping-polls': '轮询调用交叠，结果顺序不明确',
  'poll-after-terminal': '终止结果后仍有轮询', 'unconfirmed-poll-result': '轮询结果缺失或包装头不可信',
  'mismatched-process-id': '返回的进程标识与调用参数不符',
};

function ResultLink({ message, onJump }: { message: SessionMessage | null; onJump: (id: string) => void }) {
  const anchor = message && messageAnchorId(message);
  return anchor ? <button type="button" className="min-h-9 rounded border border-border px-2 py-1 hover:border-primary"
    onClick={() => onJump(`diagnostic-result-${anchor}`)}>查看进程结果证据</button> : <span className="text-muted-foreground">没有可定位结果</span>;
}

export function ProcessEvidence({ process, onJump }: { process: CodexProcessEvidence; onJump: (id: string) => void }) {
  return (
    <details className="mt-2 rounded border border-border p-2" data-testid="process-evidence">
      <summary className="cursor-pointer font-medium">进程 {process.processId} · {STATES[process.state]} · {process.polls.length} 次关联轮询</summary>
      <p className="mt-2 text-[11px] text-muted-foreground">
        exec_command 启动消息 #{process.launchIndex + 1} → 返回 #{process.launchResultIndex + 1}；
        通过包装头 Process running with session ID 与 write_stdin.session_id 精确匹配。
        {process.exitCode !== null ? ` 最终退出码 ${process.exitCode}。` : ''}
        {process.inputObserved ? ' 过程中发送过输入；不展示输入内容，也不视为未干预的验证。' : ''}
        仅当前日志的关联，不是实时进程监控或任务验收。
      </p>
      {process.issues.length ? <p className="mt-1 text-amber-500">{process.issues.map((issue) => ISSUES[issue] || issue).join('；')}。不采用这些结果确认进程完成。</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {process.launchCallId ? <button type="button" className="min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => onJump(process.launchCallId!)}>查看启动调用</button> : null}
        <ResultLink message={process.launchResult} onJump={onJump} />
      </div>
      <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto" aria-label="进程轮询证据">
        {process.polls.map((poll) => (
          <li key={poll.callIndex} className="rounded border border-border p-2 text-[11px]">
            <p>轮询调用 #{poll.callIndex + 1}{poll.resultIndex !== null ? ` → 结果 #${poll.resultIndex + 1}` : ''} · {STATES[poll.state]}</p>
            <p className="mt-1 text-muted-foreground">{poll.exitCode !== null ? `包装头退出码 ${poll.exitCode} · ` : ''}{poll.hasInput ? '调用发送了输入' : '没有发送输入'}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {poll.toolCallId ? <button type="button" className="min-h-9 rounded border border-border px-2 py-1 hover:border-primary" onClick={() => onJump(poll.toolCallId!)}>查看轮询调用</button> : null}
              <ResultLink message={poll.resultMessage} onJump={onJump} />
            </div>
          </li>
        ))}
      </ol>
      {process.finalMessage ? <div className="mt-2"><span className="mr-2 text-[11px]">唯一关联的最终结果</span><ResultLink message={process.finalMessage} onJump={onJump} /></div> : null}
    </details>
  );
}

export function CodexProcesses({ report, onJump }: { report: ReturnType<typeof analyzeCodexProcesses>; onJump: (id: string) => void }) {
  const [visible, setVisible] = useState(5);
  if (!report.processes.length && !report.pollCalls) return null;
  const terminal = report.processes.filter((process) => process.state === 'success' || process.state === 'failure').length;
  return (
    <details className="mt-3 rounded border border-primary/30 bg-primary/5 p-2" data-testid="codex-processes">
      <summary className="cursor-pointer font-medium">Codex 后台进程证据 · {report.processes.length} 次启动 · {terminal} 次明确退出</summary>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {report.linkedPolls} / {report.pollCalls} 次 write_stdin 关联到启动，{report.unlinkedPolls} 次未关联，{report.ambiguousCalls} 次调用标识不唯一。
        与“每条工具调用的最后结果”分开统计，不改写历史失败或自动恢复。同一进程 ID 重用、交叠轮询或冲突结果保持未知。
      </p>
      <div className="mt-2 max-h-[32rem] overflow-y-auto">
        {report.processes.slice(0, visible).map((process, index) => <ProcessEvidence key={`${process.launchIndex}-${index}`} process={process} onJump={onJump} />)}
      </div>
      {visible < report.processes.length ? <button type="button" className="mt-2 min-h-9 rounded border border-border px-2 py-1" onClick={() => setVisible(visible + 5)}>再显示 {Math.min(5, report.processes.length - visible)} 次启动</button> : null}
    </details>
  );
}
