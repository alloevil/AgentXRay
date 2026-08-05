// Single-message renderers (user/assistant/reasoning/toolCall/toolResult) —
// ported from legacy renderMessage/renderToolCall/renderToolResult/renderGraphLane.
// Collapses are native <details> so DOM-driven jumps (legacy parity) can expand them.

import { createContext, useContext } from 'react';
import type { MessageContentPart, SessionMessage } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { formatDurationCompact, getTextContent } from '@/lib/pure';
import { cn } from '@/lib/utils';
import type { TimingMeta } from './lib';
import { formatDate, formatNumber, messageAnchorId, truncateId } from './lib';
/** scrollToMessage from SessionsView: expands pagination + clears filter + flashes. */
export const MessageActionsContext = createContext<{ scrollToMessage: (id: string) => void }>({
  scrollToMessage: () => {},
});

function DurationBadge({ ms, warnAt, dangerAt, prefix, title }: { ms: number | null; warnAt: number; dangerAt: number; prefix: string; title?: string }) {
  if (!Number.isFinite(ms as number)) return null;
  const v = ms as number;
  return (
    <span
      title={title}
      className={cn(
        'rounded border px-1 py-px text-[10px]',
        v >= dangerAt
          ? 'border-destructive/50 text-destructive'
          : v >= warnAt
            ? 'border-yellow-600/50 text-yellow-500'
            : 'border-border text-muted-foreground'
      )}
    >
      {prefix}
      {formatDurationCompact(v)}
    </span>
  );
}

function MessageHead({
  role,
  meta,
  timestamp,
  timing,
  withToolDuration,
}: {
  role: React.ReactNode;
  meta?: React.ReactNode;
  timestamp: string | null;
  timing: TimingMeta | undefined;
  withToolDuration?: boolean;
}) {
  const deltaMs = timing?.deltaMs ?? null;
  const toolMs = timing?.toolDurationMs ?? null;
  return (
    <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
      <div className="flex items-center gap-2">
        {role}
        {meta}
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {timestamp ? <span>{formatDate(timestamp)}</span> : null}
        {/* tool duration ≥200ms on toolResults; delta ≥5s on everything (legacy badges) */}
        {withToolDuration && toolMs !== null && toolMs >= 200 ? (
          <DurationBadge ms={toolMs} warnAt={10000} dangerAt={60000} prefix="⏱ " title="Tool execution time" />
        ) : null}
        {deltaMs !== null && deltaMs >= 5000 ? (
          <DurationBadge ms={deltaMs} warnAt={30000} dangerAt={120000} prefix="+" />
        ) : null}
      </div>
    </div>
  );
}

function Collapse({
  anchorId,
  header,
  error,
  children,
}: {
  anchorId: string;
  header: React.ReactNode;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      data-link-id={anchorId}
      className={cn(
        'group my-1 rounded-md border',
        error ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-secondary/40'
      )}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-1.5 truncate">{header}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground transition-transform group-open:rotate-90">▶</span>
      </summary>
      <div className="border-t border-border/60 px-2 py-1.5">{children}</div>
    </details>
  );
}

const PRE_CLASS = 'overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px]';

/** Embedded toolCall content part (OpenClaw/omp assistant messages). */
export function ToolCallPart({ part }: { part: MessageContentPart }) {
  const { scrollToMessage } = useContext(MessageActionsContext);
  const args = (part.arguments ?? {}) as Record<string, unknown>;
  const command = typeof args.command === 'string' ? args.command.toLowerCase() : '';
  const isSpawn = part.name === 'sessions_spawn' && !!args.agentId;
  const isDelegate = part.name === 'delegate_task';
  const isExecSpawn = part.name === 'exec' && (command.includes('codex ') || command.includes('claude '));
  const taskPreview = typeof (args.task ?? args.prompt) === 'string' ? String(args.task ?? args.prompt).slice(0, 80) : '';

  return (
    <>
      <Collapse
        anchorId={part.id || ''}
        header={
          <>
            <span>🔧 {part.name || 'tool'}</span>
            {isSpawn || isDelegate || isExecSpawn ? (
              <span className="rounded bg-[#f0883e]/20 px-1 py-px text-[9px] font-semibold text-[#f0883e]">SPAWN</span>
            ) : null}
            <span className="text-muted-foreground">{truncateId(part.id || '')}</span>
          </>
        }
      >
        <pre className={PRE_CLASS}>{JSON.stringify(args, null, 2)}</pre>
      </Collapse>
      {(isExecSpawn || isDelegate) && part.id ? (
        <button
          type="button"
          onClick={() => scrollToMessage(part.id || '')}
          className="mb-1 block rounded border border-[#f0883e]/40 px-2 py-1 text-left text-[11px] text-[#f0883e] hover:bg-[#f0883e]/10"
        >
          {isExecSpawn
            ? `📋 查看 ${command.includes('codex') ? 'Codex' : 'Claude Code'} 执行输出 ↓`
            : `🔗 Sub-agent delegated${taskPreview ? ` — ${taskPreview}…` : ''}`}
        </button>
      ) : null}
      {isSpawn ? (
        <div className="mb-1 rounded border border-[#f0883e]/40 px-2 py-1 text-[11px] text-[#f0883e]">
          🔗 子 Agent: <strong>{String(args.agentId)}</strong>
          {taskPreview ? <span className="ml-1 text-muted-foreground">{taskPreview}…</span> : null}
        </div>
      ) : null}
    </>
  );
}

function ToolResultBlock({ message }: { message: SessionMessage }) {
  const text = getTextContent(message.content);
  const lines = text.split('\n');
  const truncated = lines.length > 500;
  const details: string[] = [];
  if (message.details?.status) details.push(`status=${message.details.status}`);
  if (typeof message.details?.durationMs === 'number') details.push(`duration=${message.details.durationMs}ms`);
  if (typeof message.details?.exitCode === 'number') details.push(`exit=${message.details.exitCode}`);
  return (
    <Collapse
      anchorId={message.toolCallId || message.id}
      error={message.isError}
      header={
        <>
          <span>
            {message.isError ? '❌' : '✅'} {message.toolName || 'tool result'}
          </span>
          <span className="text-muted-foreground">{details.join(' · ')}</span>
        </>
      }
    >
      {message.details ? (
        <div className="mb-1 text-[10px] text-muted-foreground">
          {details.join(' · ') || JSON.stringify(message.details)}
        </div>
      ) : null}
      {truncated ? (
        <details className="group/full">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <pre className={cn(PRE_CLASS, 'group-open/full:hidden')}>{lines.slice(0, 500).join('\n')}</pre>
            <span className="text-[11px] text-primary underline underline-offset-2">
              <span className="group-open/full:hidden">Show all ({lines.length} lines)</span>
              <span className="hidden group-open/full:inline">Show preview</span>
            </span>
          </summary>
          <pre className={PRE_CLASS}>{text}</pre>
        </details>
      ) : (
        <pre className={PRE_CLASS}>{text}</pre>
      )}
    </Collapse>
  );
}

/** Timeline dot + trunk to the left of each row (legacy graph lane). */
export function GraphLane({ message }: { message: SessionMessage }) {
  const tip =
    message.role === 'toolResult'
      ? `${message.isError ? '❌' : '✅'} ${message.toolName || 'tool'} · ${formatDate(message.timestamp)}`
      : message.role === 'toolCall'
        ? `🔧 ${message.toolName || 'tool'} · ${formatDate(message.timestamp)}`
        : `${message.role} · ${formatDate(message.timestamp)}`;
  const cls =
    message.role === 'toolResult'
      ? message.isError
        ? 'bg-destructive'
        : 'bg-muted-foreground'
      : message.role === 'user'
        ? 'bg-[hsl(var(--user))]'
        : 'bg-[hsl(var(--assistant))]';
  return (
    <div className="relative flex w-4 shrink-0 justify-center">
      <div className="absolute inset-y-0 w-px bg-border" />
      <span title={tip} className={cn('relative mt-3 h-2.5 w-2.5 rounded-full', cls)} />
    </div>
  );
}

export function MessageBubble({ message, timing }: { message: SessionMessage; timing: TimingMeta | undefined }) {
  const text = getTextContent(message.content);
  const anchor = messageAnchorId(message) || '';

  if (message.role === 'user') {
    const preview = text.length > 1400 ? text.slice(0, 1400) + '\n\n[truncated]' : text;
    return (
      <article
        id={`message-${anchor}`}
        className="rounded-lg border border-[hsl(var(--user))]/40 bg-[hsl(var(--user))]/10 p-2.5"
      >
        <MessageHead
          role={<span className="font-semibold text-primary">User</span>}
          timestamp={message.timestamp}
          timing={timing}
        />
        <Markdown text={preview} />
      </article>
    );
  }

  if (message.role === 'reasoning') {
    if (!text.trim()) return null;
    return (
      <article
        id={`message-${anchor}`}
        className="rounded-lg border border-border/60 bg-card/50 p-2.5 opacity-75"
      >
        <MessageHead
          role={<span className="font-semibold text-muted-foreground">Reasoning</span>}
          timestamp={message.timestamp}
          timing={timing}
        />
        <Markdown text={text} />
      </article>
    );
  }

  if (message.role === 'toolCall') {
    return (
      <article
        id={`message-${anchor}`}
        className="rounded-lg border border-border bg-card p-2.5"
      >
        <MessageHead
          role={<span className="font-semibold">Tool Call</span>}
          meta={<span className="text-muted-foreground">{message.toolName || 'tool'}</span>}
          timestamp={message.timestamp}
          timing={timing}
        />
        <Collapse
          anchorId={message.toolCallId || ''}
          header={
            <>
              <span>🔧 {message.toolName || 'tool'}</span>
              <span className="text-muted-foreground">{truncateId(message.toolCallId || '')}</span>
            </>
          }
        >
          <pre className={PRE_CLASS}>{JSON.stringify(message.details || {}, null, 2)}</pre>
        </Collapse>
      </article>
    );
  }

  if (message.role === 'assistant') {
    const toolCalls = (message.content || []).filter((c) => c.type === 'toolCall');
    return (
      <article id={`message-${anchor}`} className="rounded-lg border border-[hsl(var(--assistant))]/40 bg-card p-2.5">
        <MessageHead
          role={<span className="font-semibold text-[hsl(var(--assistant))]">Assistant</span>}
          meta={
            <>
              <span className="text-muted-foreground">{message.model || 'unknown model'}</span>
              {message.usage?.totalTokens ? (
                <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                  {formatNumber(message.usage.totalTokens)} tokens
                </span>
              ) : null}
            </>
          }
          timestamp={message.timestamp}
          timing={timing}
        />
        {message.reasoning ? (
          <details className="mb-1 rounded border border-border/60 bg-secondary/30 px-2 py-1 text-xs">
            <summary className="cursor-pointer text-muted-foreground">💭 Reasoning</summary>
            <Markdown text={message.reasoning} />
          </details>
        ) : null}
        {text ? <Markdown text={text} /> : null}
        {toolCalls.map((part, i) => (
          <ToolCallPart key={part.id || i} part={part} />
        ))}
      </article>
    );
  }

  // toolResult (and anything else that reaches here)
  return (
    <article
      id={`tool-result-${message.toolCallId || anchor}`}
      className={cn(
        'rounded-lg border p-2.5',
        message.isError ? 'border-destructive/60 bg-destructive/10' : 'border-border bg-card'
      )}
    >
      <MessageHead
        role={
          <span className={cn('font-semibold', message.isError && 'text-destructive')}>
            {message.isError ? 'Tool Error' : 'Tool Result'}
          </span>
        }
        meta={<span className="text-muted-foreground">{message.toolName || 'tool result'}</span>}
        timestamp={message.timestamp}
        timing={timing}
        withToolDuration
      />
      <ToolResultBlock message={message} />
    </article>
  );
}
