import { useMemo, useState } from 'react';
import type { SessionMessage } from '@/api/types';
import { diagnoseSession, summarizeSessionHealth, analyzeVerificationChronology, type FailureDiagnostic, type FailureEvent } from './diagnostics';
import { formatDate, messageAnchorId } from './lib';
import { DiagnosticReview, useEventReviews } from './DiagnosticReview';
import { ReviewTransferPanel } from './ReviewTransferPanel';
import { RelatedOperations } from './RelatedOperations';
import { SessionHealth } from './SessionHealth';
import { VerificationChronology } from './VerificationChronology';
import { REVIEW_LABELS, reviewState, type EventReview, type ReviewState, type ReviewStatus } from './diagnostic-reviews';

const REASONS = {
  'no-success': '未记录到后续同工具、同参数的成功重试。其他命令成功或助手声明完成不算恢复证据。',
  'missing-call': '无法确认：缺少对应调用或参数，不能判断后续结果是否验证了这次失败。',
  'unconfirmed-retry': '无法确认：有后续同参数调用，但未记录到明确成功结果，可能仍在执行或日志不完整。',
};

const PAGE_SIZE = 5;
const REVIEW_FILTERS = { unreviewed: '待复核', ...REVIEW_LABELS, all: '全部' };
const BUTTON_CLASS = 'rounded border border-border px-2 py-1 hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

function spanLabel(milliseconds: number | null): string {
  if (milliseconds === null) return '时间跨度未知';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return '首末记录间隔不足 1 秒';
  if (seconds < 60) return `首末记录间隔 ${seconds} 秒`;
  return `首末记录间隔 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function EvidenceButton({ failure, label, onJump }: {
  failure: FailureDiagnostic;
  label: string;
  onJump: (id: string) => void;
}) {
  const anchor = messageAnchorId(failure.message);
  return anchor ? (
    <button type="button" className={BUTTON_CLASS} onClick={() => onJump(`diagnostic-result-${anchor}`)}>
      {label}
    </button>
  ) : <span className="text-muted-foreground">日志缺少定位标识</span>;
}

function EventCard({ event, onJump, review, ready, onReview, manual }: {
  event: FailureEvent;
  onJump: (id: string) => void;
  review: EventReview | undefined;
  ready: boolean;
  onReview: (status: ReviewStatus | null, note?: string) => void;
  manual: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = event.failures[0];
  const latest = event.failures[event.failures.length - 1];
  const repeated = event.failures.length > 1;
  return (
    <li className="min-w-0 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" data-testid="diagnostic-event">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="break-all text-amber-500">{event.toolName}</strong>
        <span className="rounded bg-amber-500/10 px-2 py-1 font-medium text-amber-500">
          {event.failures.length} 条失败记录
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {event.userTurn ? `第 ${event.userTurn} 个用户轮次` : '首个用户消息之前'}
        {repeated ? ` · ${spanLabel(event.spanMs)}` : ''}
      </p>
      {event.argumentsText ? (
        <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
          {event.argumentsText.slice(0, 240)}{event.argumentsText.length > 240 ? '…' : ''}
        </p>
      ) : null}
      <p className="mt-2 leading-5">{REASONS[latest.reason]}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        记录线索：{repeated ? '重复操作' : latest.reason === 'missing-call' ? '信息缺失' : '验证缺口'}
        {manual ? ` · ${reviewState(review) === 'unreviewed' ? '待复核' : `人工：${REVIEW_LABELS[reviewState(review) as ReviewStatus]}`}` : ''}
      </p>
      <p className="mt-2 text-[11px] font-medium">{repeated ? '最近一次失败证据' : '失败证据'}</p>
      <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{latest.evidence}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <EvidenceButton failure={first} label={repeated ? '首条证据' : '查看失败证据'} onJump={onJump} />
        {repeated ? <EvidenceButton failure={latest} label="末条证据" onJump={onJump} /> : null}
        {repeated ? (
          <button type="button" className={BUTTON_CLASS} aria-expanded={expanded} aria-controls={`${event.id}-evidence`}
            onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起证据' : `全部 ${event.failures.length} 条证据`}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ol id={`${event.id}-evidence`} aria-label={`${event.toolName} 事件全部证据`}
          className="mt-3 max-h-64 space-y-2 overflow-y-auto border-t border-border pt-2">
          {event.failures.map((failure, index) => (
            <li key={failure.index} className="min-w-0 rounded border border-border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">#{index + 1} · {formatDate(failure.message.timestamp)}</span>
                <EvidenceButton failure={failure} label={`定位第 ${index + 1} 条`} onJump={onJump} />
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">{failure.evidence}</pre>
            </li>
          ))}
        </ol>
      ) : null}
      {event.relatedOperations.length ? <RelatedOperations operations={event.relatedOperations} onJump={onJump} /> : null}
      {manual ? <DiagnosticReview key={review?.identity.fingerprint ?? 'loading'} entry={review} ready={ready}
        onUpdate={onReview} /> : null}
    </li>
  );
}

export function SessionDiagnostics({ messages, onScrollToMessage, reviewScope }: {
  messages: SessionMessage[];
  reviewScope: string;
  onScrollToMessage: (id: string) => void;
}) {
  const report = useMemo(() => diagnoseSession(messages), [messages]);
  const health = useMemo(() => summarizeSessionHealth(messages, report), [messages, report]);
  const chronology = useMemo(() => analyzeVerificationChronology(messages), [messages]);
  const [manual, setManual] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<ReviewState | 'all'>('unreviewed');
  const [notice, setNotice] = useState<{ events: FailureEvent[]; text: string } | null>(null);
  const reviews = useEventReviews(reviewScope, report.events, manual);
  const matching = report.events.filter((event) => !manual || filter === 'all' || reviewState(reviews.entries[event.id]) === filter);
  const hiddenCount = Math.max(0, matching.length - visibleCount);
  const unreadableCount = Object.values(reviews.entries).filter((entry) => entry.error).length;
  return (
    <section aria-label="自动会话体检" className="mb-3 min-w-0 rounded-lg border border-border bg-card/60 p-3 text-xs"
      data-testid="session-diagnostics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">自动会话体检 · {report.events.length} 个失败后验证事件</h3>
        <span className="text-muted-foreground">{report.failureCount} 条失败记录 · 无需人工标注或模型调用</span>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        自动整理已加载日志中的事实，优先展示重复操作并保留证据。不评价任务成败，不把缺少结果等同于正在运行。
      </p>
      <SessionHealth health={health} onJump={onScrollToMessage} />
      <VerificationChronology chronology={chronology} onJump={onScrollToMessage} />
      <details className="mt-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">如何分组与判定</summary>
        <p className="mt-1 leading-5">
          同一调用所在用户轮次、同工具、完整同参数的待复查记录归为一个事件；同参成功结果切断分组，缺少参数不合并。
          错误内容可能不同，也可能包含并行调用；分组不代表相同根因或串行重试。时间跨度不是执行耗时或浪费时间。
          恢复仍只匹配失败之后发起的同参成功调用，不限定用户轮次。命令执行须有明确零退出码，OMP 也采用原生完成字段；
          执行中、取消和未知状态不算成功，其他工具须有未报错结果。不推断等价命令、隐式工作目录或后台任务关联。
          后续候选只按“仅 i 不同”或“同轮次同文件的编辑/写入”关联；相对路径缺少明确绝对工作目录不匹配，
          无结果或在最后一次失败之前发起的调用不列入。候选不关闭事件，新增或变化的候选证据会使旧人工复核过期。
        </p>
      </details>
      <button type="button" aria-pressed={manual} className={`${BUTTON_CLASS} mt-3 min-h-9`}
        onClick={() => { setManual(!manual); setFilter('all'); setVisibleCount(PAGE_SIZE); setNotice(null); }}>
        {manual ? '返回自动体检' : '人工笔记与迁移（可选）'}
      </button>
      {manual ? <>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        人工复核仅存当前浏览器，未加密、不上传。换端口、浏览器或清除站点数据后可能不可见；证据变化会重新待复核。
      </p>
      {!reviews.loaded ? <p role="status" className="mt-2 text-muted-foreground">正在核对本机复核与当前证据…</p> : null}
      {reviews.error ? <p role="alert" className="mt-2 text-amber-500">{reviews.error}</p> : null}
      {unreadableCount ? (
        <p role="alert" className="mt-2 text-amber-500">
          {unreadableCount} 个事件的本地复核无法读取，已保持待复核。请切换“待复核”查看，自动结果未改变。
        </p>
      ) : null}
      {notice?.events === report.events ? <p role="status" className="mt-2 text-muted-foreground">{notice.text}</p> : null}
      <ReviewTransferPanel entries={reviews.entries} ready={reviews.loaded && !reviews.error} onImported={reviews.refresh} />
      </> : null}
      {report.events.length ? (
        <>
          {manual ? <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="复核队列筛选">
            {Object.entries(REVIEW_FILTERS).map(([value, label]) => {
              const count = value === 'all' ? report.events.length : report.events.filter((event) => reviewState(reviews.entries[event.id]) === value).length;
              return (
                <button key={value} type="button" aria-pressed={filter === value}
                  className={`${BUTTON_CLASS} ${filter === value ? 'border-primary text-primary' : 'text-muted-foreground'}`}
                  onClick={() => { setFilter(value as ReviewState | 'all'); setVisibleCount(PAGE_SIZE); setNotice(null); }}>
                  {label} {count}
                </button>
              );
            })}
          </div> : null}
          <ol className="mt-3 max-h-[32rem] space-y-3 overflow-y-auto" aria-label="待复查失败事件">
            {matching.slice(0, visibleCount).map((event) => (
              <EventCard key={event.id} event={event} manual={manual} onJump={onScrollToMessage} review={reviews.entries[event.id]}
                ready={reviews.loaded && !reviews.error && !!reviews.entries[event.id]}
                onReview={(status, note) => {
                  reviews.update(event.id, status, note);
                  setNotice({ events: report.events, text: status === null ? '已撤销本机标记，自动结果未改变。' : '已保存人工复核（仅此浏览器），自动结果未改变。' });
                }} />
            ))}
          </ol>
          {!matching.length ? <p className="mt-3 text-muted-foreground">此复核队列为空；自动诊断事件仍可在“全部”中查看，不代表任务通过。</p> : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{manual ? '当前复核队列' : '自动事件'}已展示 {Math.min(visibleCount, matching.length)} / {matching.length} 个事件 · 共 {report.failureCount} 条失败记录</span>
            {hiddenCount ? (
              <button type="button" className={BUTTON_CLASS} onClick={() => setVisibleCount(visibleCount + PAGE_SIZE)}>
                再显示 {Math.min(PAGE_SIZE, hiddenCount)} 个事件（剩余 {hiddenCount}）
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-2 text-muted-foreground">
          {report.failureCount ? '已记录失败均有后续同参数成功记录；不代表问题已解决。' : '未发现本规则可识别的失败线索；不代表没有问题。'}
        </p>
      )}
    </section>
  );
}
