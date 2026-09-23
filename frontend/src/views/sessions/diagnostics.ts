import type { SessionMessage } from '../../api/types';

type Outcome = 'failure' | 'success' | 'unknown';

interface RecordedCall {
  name: string;
  args: unknown;
  key: string | null;
  index: number;
  userTurn: number;
}

export interface FailureDiagnostic {
  message: SessionMessage;
  index: number;
  toolName: string;
  argumentsText: string | null;
  evidence: string;
  reason: 'no-success' | 'missing-call' | 'unconfirmed-retry';
}

export interface FailureEvent {
  id: string;
  toolName: string;
  argumentsText: string | null;
  userTurn: number;
  failures: FailureDiagnostic[];
  spanMs: number | null;
}

function eventSpan(failures: FailureDiagnostic[]): number | null {
  const times = failures.map((failure) => failure.message.timestamp ? Date.parse(failure.message.timestamp) : NaN);
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]))) return null;
  return times[times.length - 1] - times[0];
}

function resultText(message: SessionMessage): string {
  return (message.content || []).map((part) => part.text || '').join('\n');
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, ordered(item)])
    );
  }
  return value;
}

function isExecution(call: RecordedCall | undefined, message: SessionMessage): boolean {
  const name = call?.name || message.toolName || '';
  if (/(?:^|[./_])(bash|shell|exec|exec_command|run_shell_command|execute_command|terminal|write_stdin)$/i.test(name)) {
    return true;
  }
  const args = call?.args;
  return !!args && typeof args === 'object' && ('command' in args || 'cmd' in args);
}

function exitCode(message: SessionMessage, call: RecordedCall | undefined): number | null {
  const code = message.details?.exitCode ?? message.details?.exit_code;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (!isExecution(call, message)) return null;
  const text = resultText(message);
  if (!/^(?:Chunk ID:|Wall time:)/.test(text)) return null;
  const outputStart = text.search(/^(?:Final output|Output):\s*$/m);
  if (outputStart < 0) return null;
  const match = text.slice(0, outputStart).match(/^(?:Process exited with code |Exit code: )(-?\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function outcome(result: SessionMessage, call: RecordedCall | undefined): Outcome {
  if (result.ompOutcome) {
    const state = result.ompOutcome.state;
    return state === 'success' || state === 'failure' ? state : 'unknown';
  }
  const code = exitCode(result, call);
  if (result.isError === true || (code !== null && code !== 0)) return 'failure';
  if (code === 0) return 'success';
  if (['running', 'pending', 'in_progress'].includes(String(result.details?.status))) return 'unknown';
  if (isExecution(call, result)) return 'unknown';
  return result.isError === false && result.content !== null ? 'success' : 'unknown';
}

export function diagnoseSession(messages: SessionMessage[]) {
  const calls = new Map<string, RecordedCall>();
  const unresolved = new Map<string, FailureDiagnostic[]>();
  const failures: FailureDiagnostic[] = [];
  const recovered = new Set<FailureDiagnostic>();
  const eventKeys = new Map<FailureDiagnostic, { key: string; userTurn: number }>();
  const generations = new Map<string, number>();
  let userTurn = 0;

  function recordCall(id: string | null | undefined, name: string | null | undefined, value: unknown, index: number) {
    if (!id) return;
    const args = parseArguments(value);
    const key = name && args !== null && args !== undefined ? JSON.stringify([name, ordered(args)]) : null;
    calls.set(id, { name: name || '未知工具', args, key, index, userTurn });
    if (key) {
      for (const failure of unresolved.get(key) || []) {
        if (index > failure.index) failure.reason = 'unconfirmed-retry';
      }
    }
  }

  messages.forEach((message, index) => {
    if (message.role === 'user') userTurn++;
    if (message.role === 'toolCall') {
      recordCall(message.toolCallId || message.id, message.toolName, message.details, index);
    }
    if (message.role === 'assistant') {
      for (const part of message.content || []) {
        if (part.type === 'toolCall') recordCall(part.id, part.name, part.arguments ?? part.input, index);
      }
    }
    if (message.role !== 'toolResult') return;
    const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
    const result = outcome(message, call);
    if (result === 'failure') {
      const code = exitCode(message, call);
      const failure: FailureDiagnostic = {
        message,
        index,
        toolName: call?.name || message.toolName || '未知工具',
        argumentsText: call?.key ? JSON.stringify(call.args) : null,
        evidence: [
          ...(message.ompOutcome?.evidence || []),
          message.isError ? '日志标记 isError=true' : null,
          code !== null ? `退出码 ${code}` : null,
          resultText(message),
        ].filter((text) => text !== null).join('\n').slice(0, 500),
        reason: call?.key ? 'no-success' : 'missing-call',
      };
      failures.push(failure);
      eventKeys.set(failure, {
        key: call?.key ? JSON.stringify([call.userTurn, call.key, generations.get(call.key) || 0]) : `orphan-${index}`,
        userTurn: call?.userTurn ?? userTurn,
      });
      if (call?.key) {
        const pending = unresolved.get(call.key) || [];
        pending.push(failure);
        unresolved.set(call.key, pending);
      }
    } else if (result === 'success' && call?.key) {
      generations.set(call.key, (generations.get(call.key) || 0) + 1);
      const pending = unresolved.get(call.key) || [];
      for (const failure of pending) {
        if (call.index > failure.index) recovered.add(failure);
      }
      unresolved.set(call.key, pending.filter((failure) => !recovered.has(failure)));
    }
  });

  const pendingFailures = failures.filter((failure) => !recovered.has(failure));
  const grouped = new Map<string, FailureEvent>();
  for (const failure of pendingFailures) {
    const group = eventKeys.get(failure)!;
    const existing = grouped.get(group.key);
    if (existing) {
      existing.failures.push(failure);
    } else {
      grouped.set(group.key, {
        id: `failure-event-${failure.index}`,
        toolName: failure.toolName,
        argumentsText: failure.argumentsText,
        userTurn: group.userTurn,
        failures: [failure],
        spanMs: null,
      });
    }
  }
  const events = [...grouped.values()];
  for (const event of events) event.spanMs = eventSpan(event.failures);
  events.sort((left, right) => right.failures.length - left.failures.length || left.failures[0].index - right.failures[0].index);

  return {
    failures: pendingFailures,
    failureCount: failures.length,
    recoveredCount: recovered.size,
    events,
  };
}
