import type { SessionMessage } from '../../api/types';

type Outcome = 'failure' | 'success' | 'unknown';

interface RecordedCall {
  name: string;
  args: unknown;
  key: string | null;
  index: number;
  userTurn: number;
  onlyIKey: string | null;
  fileKey: string | null;
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
  relatedOperations: RelatedOperation[];
}

export interface RelatedOperation {
  message: SessionMessage;
  index: number;
  callIndex: number;
  userTurn: number;
  toolName: string;
  argumentsText: string;
  relation: 'only-i' | 'same-file';
  state: 'success' | 'failure' | 'running' | 'cancelled' | 'unknown';
  evidence: string;
}

interface RecordedResult {
  message: SessionMessage;
  index: number;
  call: RecordedCall;
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

function argumentObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function onlyIKey(name: string, args: unknown): string | null {
  const object = argumentObject(args);
  if (!object) return null;
  const entries = Object.entries(object).filter(([key]) => key !== 'i');
  return entries.length ? JSON.stringify([name, ordered(Object.fromEntries(entries))]) : null;
}

function fileKey(name: string, args: unknown): string | null {
  if (!['edit', 'Edit', 'write', 'Write', 'MultiEdit'].includes(name)) return null;
  const object = argumentObject(args);
  if (!object) return null;
  const paths = ['path', 'file_path'].filter((key) => key in object).map((key) => object[key]);
  if (!paths.length || paths.some((value) => typeof value !== 'string' || !value || value !== paths[0])) return null;
  const filename = paths[0] as string;
  const directories = ['cwd', 'workdir', 'working_directory'].filter((key) => key in object).map((key) => [key, object[key]]);
  if (directories.some(([, value]) => typeof value !== 'string' || !value)) return null;
  if (new Set(directories.map(([, value]) => value)).size > 1) return null;
  const absolute = (value: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
  if (!absolute(filename) && (!directories.length || !absolute(directories[0][1] as string))) return null;
  return JSON.stringify([filename, directories]);
}

function relatedState(message: SessionMessage, call: RecordedCall): RelatedOperation['state'] {
  if (message.ompOutcome) return message.ompOutcome.state;
  const code = exitCode(message, call);
  if (message.isError === true || (code !== null && code !== 0)) return 'failure';
  if (['running', 'pending', 'in_progress'].includes(String(message.details?.status))) return 'running';
  if (['cancelled', 'canceled'].includes(String(message.details?.status))) return 'cancelled';
  if (message.details?.status != null && !['ok', 'success', 'complete', 'completed'].includes(String(message.details.status))) return 'unknown';
  return outcome(message, call);
}

function relatedEvidence(message: SessionMessage, call: RecordedCall, state: RelatedOperation['state']): string {
  const code = exitCode(message, call);
  const sources = message.ompOutcome?.evidence || [
    ...(message.isError ? ['日志标记 isError=true'] : []),
    ...(code !== null ? [`退出码 ${code}`] : []),
    ...(state === 'running' ? [`details.status=${message.details?.status}`] : []),
    ...(state === 'cancelled' ? [`details.status=${message.details?.status}`] : []),
    ...(code === null && state === 'success' ? ['isError=false；工具结果未报错（不等于任务通过）'] : []),
    ...(state === 'unknown' ? ['缺少明确完成状态'] : []),
  ];
  return [...sources, resultText(message)].join('\n').slice(0, 500);
}

export function diagnoseSession(messages: SessionMessage[]) {
  const calls = new Map<string, RecordedCall>();
  const unresolved = new Map<string, FailureDiagnostic[]>();
  const failures: FailureDiagnostic[] = [];
  const recovered = new Set<FailureDiagnostic>();
  const eventKeys = new Map<FailureDiagnostic, { key: string; userTurn: number }>();
  const generations = new Map<string, number>();
  const failureCalls = new Map<FailureDiagnostic, RecordedCall>();
  const resultsByI = new Map<string, RecordedResult[]>();
  const resultsByFile = new Map<string, RecordedResult[]>();
  let userTurn = 0;

  function recordCall(id: string | null | undefined, name: string | null | undefined, value: unknown, index: number) {
    if (!id) return;
    const args = parseArguments(value);
    const key = name && args !== null && args !== undefined ? JSON.stringify([name, ordered(args)]) : null;
    calls.set(id, { name: name || '未知工具', args, key, index, userTurn,
      onlyIKey: name ? onlyIKey(name, args) : null, fileKey: name ? fileKey(name, args) : null });
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
    if (call?.key) {
      const recorded = { message, index, call };
      for (const [key, bucket] of [[call.onlyIKey, resultsByI], [call.fileKey, resultsByFile]] as const) {
        if (!key) continue;
        const list = bucket.get(key) || [];
        list.push(recorded);
        bucket.set(key, list);
      }
    }
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
      if (call?.key) failureCalls.set(failure, call);
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
        relatedOperations: [],
      });
    }
  }
  const events = [...grouped.values()];
  for (const event of events) {
    event.spanMs = eventSpan(event.failures);
    const latest = event.failures[event.failures.length - 1];
    const original = failureCalls.get(latest);
    if (!original) continue;
    const candidates = new Map<number, RelatedOperation>();
    const buckets = [
      ['only-i', original.onlyIKey ? resultsByI.get(original.onlyIKey) : undefined],
      ['same-file', original.fileKey ? resultsByFile.get(original.fileKey) : undefined],
    ] as const;
    for (const [relation, results] of buckets) {
      for (const { message, index, call: subsequent } of results || []) {
        if (subsequent.index <= latest.index || subsequent.key === original.key || candidates.has(index)) continue;
        if (relation === 'same-file' && subsequent.userTurn !== original.userTurn) continue;
        const state = relatedState(message, subsequent);
        candidates.set(index, { message, index, callIndex: subsequent.index, userTurn: subsequent.userTurn,
          toolName: subsequent.name, argumentsText: JSON.stringify(subsequent.args), relation, state,
          evidence: relatedEvidence(message, subsequent, state) });
      }
    }
    event.relatedOperations = [...candidates.values()].sort((left, right) => left.index - right.index);
  }
  events.sort((left, right) => right.failures.length - left.failures.length || left.failures[0].index - right.failures[0].index);

  return {
    failures: pendingFailures,
    failureCount: failures.length,
    recoveredCount: recovered.size,
    events,
  };
}

export interface CompletionGap {
  message: SessionMessage;
  index: number;
  toolCallId: string | null;
  toolName: string;
  state: 'running' | 'unknown' | 'no-result';
  reason: 'ambiguous-id' | 'last-result' | 'no-result';
  evidence: string;
}

interface CallEvidence {
  id: string | null;
  message: SessionMessage;
  call: RecordedCall;
  result?: { message: SessionMessage; index: number };
}

function collectCallEvidence(messages: SessionMessage[]) {
  const calls: CallEvidence[] = [];
  const byId = new Map<string, typeof calls>();
  let userTurn = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') userTurn++;
    function record(id: string | null | undefined, name: string | null | undefined, value: unknown) {
      const entry = { id: id || null, message, call: { name: name || '未知工具', args: parseArguments(value),
        key: null, onlyIKey: null, fileKey: null, index, userTurn } };
      calls.push(entry);
      if (id) { const list = byId.get(id) || []; list.push(entry); byId.set(id, list); }
    }
    if (message.role === 'toolCall') record(message.toolCallId || message.id, message.toolName, message.details);
    if (message.role === 'assistant') for (const part of message.content || []) {
      if (part.type === 'toolCall') record(part.id, part.name, part.arguments ?? part.input);
    }
  });
  let orphanResults = 0;
  let unassignedResults = 0;
  let toolResultCount = 0;
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult') return;
    toolResultCount++;
    const matches = message.toolCallId ? byId.get(message.toolCallId) : undefined;
    if (!matches?.length || matches.every((entry) => entry.call.index >= index)) { orphanResults++; return; }
    if (matches.length !== 1) { unassignedResults++; return; }
    matches[0].result = { message, index };
  });
  return { calls, byId, orphanResults, unassignedResults, toolResultCount };
}

export function summarizeSessionHealth(messages: SessionMessage[], report = diagnoseSession(messages)) {
  const { calls, byId, orphanResults, unassignedResults, toolResultCount } = collectCallEvidence(messages);
  const callStates = { success: 0, failure: 0, running: 0, cancelled: 0, unknown: 0, 'no-result': 0 };
  const gaps: CompletionGap[] = [];
  let ambiguousCalls = 0;
  for (const entry of calls) {
    const ambiguous = !entry.id || (byId.get(entry.id)?.length ?? 0) !== 1;
    const state = ambiguous ? 'unknown' : entry.result ? relatedState(entry.result.message, entry.call) : 'no-result';
    callStates[state]++;
    if (ambiguous) ambiguousCalls++;
    if (state !== 'running' && state !== 'unknown' && state !== 'no-result') continue;
    const result = !ambiguous ? entry.result : undefined;
    gaps.push({ message: result?.message || entry.message, index: result?.index ?? entry.call.index,
      toolCallId: entry.id, toolName: entry.call.name, state,
      reason: ambiguous ? 'ambiguous-id' : result ? 'last-result' : 'no-result',
      evidence: ambiguous ? '调用标识缺失或重复，无法唯一关联结果。' : result
        ? relatedEvidence(result.message, entry.call, state === 'no-result' ? 'unknown' : state)
        : '截至当前已加载日志，没有记录到此调用的结果；不代表任务失败或进程仍在运行。',
    });
  }
  const candidates = new Map<number, RelatedOperation>();
  for (const event of report.events) for (const operation of event.relatedOperations) candidates.set(operation.index, operation);
  const candidateStates = { success: 0, failure: 0, running: 0, cancelled: 0, unknown: 0 };
  for (const operation of candidates.values()) candidateStates[operation.state]++;
  const repeated = report.events.filter((event) => event.failures.length > 1);
  return {
    callCount: calls.length, toolResultCount, callStates, orphanResults, unassignedResults, ambiguousCalls, gaps,
    failureRecords: report.failureCount, pendingRecords: report.failures.length, pendingEvents: report.events.length,
    recoveredRecords: report.recoveredCount, repeatedEvents: repeated.length,
    repeatedRecords: repeated.reduce((total, event) => total + event.failures.length, 0),
    candidateEvents: report.events.filter((event) => event.relatedOperations.length > 0).length,
    candidateResults: candidates.size, candidateStates,
  };
}

export interface ProcessPoll {
  callMessage: SessionMessage;
  callIndex: number;
  toolCallId: string | null;
  resultMessage: SessionMessage | null;
  resultIndex: number | null;
  state: 'success' | 'failure' | 'running' | 'unknown' | 'no-result';
  exitCode: number | null;
  hasInput: boolean;
}

export interface CodexProcessEvidence {
  processId: number;
  launchMessage: SessionMessage;
  launchIndex: number;
  launchCallId: string | null;
  launchResult: SessionMessage;
  launchResultIndex: number;
  polls: ProcessPoll[];
  state: 'success' | 'failure' | 'running' | 'unknown';
  exitCode: number | null;
  finalMessage: SessionMessage | null;
  finalIndex: number | null;
  inputObserved: boolean;
  issues: string[];
}

function codexTool(name: string): string {
  return name.startsWith('functions.') ? name.slice('functions.'.length) : name;
}

function codexEnvelope(message: SessionMessage): { processId: number | null; exitCode: number | null } | null {
  if (message.ompOutcome || message.isError) return null;
  const text = resultText(message);
  if (!/^(?:Chunk ID: [^\n]+\n)?Wall time: [\d.]+ seconds\n/.test(text)) return null;
  const boundary = text.search(/^(?:Final output|Output):\s*$/m);
  if (boundary < 0) return null;
  const status = text.slice(0, boundary).split('\n').filter((line) => /^(?:Process (?:running|exited)|Exit code:)/.test(line));
  if (status.length !== 1) return null;
  const running = status[0].match(/^Process running with session ID (0|[1-9]\d*)$/);
  const terminal = status[0].match(/^(?:Process exited with code |Exit code: )(-?\d+)$/);
  if (running && Number.isSafeInteger(Number(running[1]))) {
    if (message.details?.exitCode != null || message.details?.exit_code != null) return null;
    return { processId: Number(running[1]), exitCode: null };
  }
  if (terminal && Number.isSafeInteger(Number(terminal[1]))) {
    const code = Number(terminal[1]);
    const recordedCode = message.details?.exitCode ?? message.details?.exit_code;
    if (recordedCode != null && recordedCode !== code) return null;
    return { processId: null, exitCode: code };
  }
  return null;
}

export function analyzeCodexProcesses(messages: SessionMessage[]) {
  const { calls, byId } = collectCallEvidence(messages);
  const resultSets = new Map<string, { message: SessionMessage; index: number }[]>();
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult' || !message.toolCallId) return;
    const rows = resultSets.get(message.toolCallId) || [];
    rows.push({ message, index }); resultSets.set(message.toolCallId, rows);
  });
  const processes: CodexProcessEvidence[] = [];
  const byProcess = new Map<number, CodexProcessEvidence[]>();
  const unique = (entry: CallEvidence) => !!entry.id && byId.get(entry.id)?.length === 1;
  for (const entry of calls) {
    if (codexTool(entry.call.name) !== 'exec_command') continue;
    const results = entry.id ? resultSets.get(entry.id) || [] : [];
    const start = results.find((row) => row.index > entry.call.index && codexEnvelope(row.message)?.processId != null);
    if (!start) continue;
    const processId = codexEnvelope(start.message)!.processId!;
    const issues = !unique(entry) || results.length !== 1 ? ['ambiguous-launch'] : [];
    const process: CodexProcessEvidence = { processId, launchMessage: entry.message, launchIndex: entry.call.index,
      launchCallId: entry.id, launchResult: start.message, launchResultIndex: start.index, polls: [],
      state: 'running', exitCode: null, finalMessage: null, finalIndex: null, inputObserved: false, issues };
    processes.push(process);
    const group = byProcess.get(processId) || []; group.push(process); byProcess.set(processId, group);
  }
  for (const group of byProcess.values()) if (group.length > 1) for (const process of group) process.issues.push('reused-process-id');
  let pollCalls = 0;
  let linkedPolls = 0;
  let ambiguousCalls = 0;
  for (const entry of calls) {
    if (codexTool(entry.call.name) !== 'write_stdin') continue;
    pollCalls++;
    const args = argumentObject(entry.call.args);
    const id = args?.session_id;
    const group = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? byProcess.get(id) : undefined;
    if (!unique(entry)) {
      ambiguousCalls++;
      if (group?.length === 1) group[0].issues.push('ambiguous-poll');
      continue;
    }
    if (group?.length !== 1 || group[0].issues.includes('ambiguous-launch') || entry.call.index <= group[0].launchResultIndex) continue;
    const process = group[0];
    const rows = resultSets.get(entry.id!) || [];
    const result = rows.length === 1 && rows[0].index > entry.call.index ? rows[0] : undefined;
    const parsed = result ? codexEnvelope(result.message) : null;
    const hasInput = args?.chars != null && args.chars !== '';
    const poll: ProcessPoll = { callMessage: entry.message, callIndex: entry.call.index, toolCallId: entry.id,
      resultMessage: result?.message ?? null, resultIndex: result?.index ?? null, hasInput,
      state: !rows.length ? 'no-result' : !parsed ? 'unknown' : parsed.exitCode !== null ? parsed.exitCode === 0 ? 'success' : 'failure' : 'running',
      exitCode: parsed?.exitCode ?? null };
    const previous = process.polls[process.polls.length - 1];
    if (previous && (previous.resultIndex === null || previous.resultIndex >= entry.call.index)) process.issues.push('overlapping-polls');
    if (process.finalMessage) process.issues.push('poll-after-terminal');
    if (!result || !parsed) process.issues.push('unconfirmed-poll-result');
    if (parsed?.processId != null && parsed.processId !== process.processId) process.issues.push('mismatched-process-id');
    process.polls.push(poll); linkedPolls++;
    process.inputObserved ||= hasInput;
    if (parsed?.exitCode != null) {
      process.finalMessage = result!.message;
      process.finalIndex = result!.index;
      process.exitCode = parsed.exitCode;
      process.state = parsed.exitCode === 0 ? 'success' : 'failure';
    }
  }
  for (const process of processes) {
    process.issues = [...new Set(process.issues)];
    if (process.issues.length) {
      process.state = 'unknown'; process.exitCode = null; process.finalMessage = null; process.finalIndex = null;
    }
  }
  return { processes, pollCalls, linkedPolls, unlinkedPolls: pollCalls - linkedPolls, ambiguousCalls };
}

export interface ExecutionEvidence {
  callMessage: SessionMessage;
  callIndex: number;
  toolCallId: string | null;
  toolName: string;
  resultMessage: SessionMessage | null;
  resultIndex: number | null;
  state: RelatedOperation['state'] | 'no-result';
  evidence: string;
  directory: string | null;
  directoryConflict: boolean;
  target?: string;
  command?: string;
  basis?: 'runner-command' | 'script-name';
  commandMode?: 'direct' | 'directory-prefix' | 'compound-fragment';
  fragments?: string[];
  processEvidence?: CodexProcessEvidence;
}

export interface ChronologyCheck {
  operation: ExecutionEvidence;
  scope: 'same-recorded-directory' | 'unknown';
}

export interface ModificationChronology {
  operation: ExecutionEvidence;
  priorSuccess: ChronologyCheck | null;
  laterChecks: ChronologyCheck[];
  latestLater: ChronologyCheck | null;
  latestOrderAmbiguous: boolean;
  overlappingChecks: ChronologyCheck[];
  excludedScopeChecks: number;
}

interface CommandToken { value: string; quoted: boolean }
interface CommandSegment { tokens: CommandToken[]; separator: string }

function literalSegments(command: string): CommandSegment[] | null {
  if (/[`$\\(){}\0]|<<|\|\||\r/.test(command) || command.length > 20000) return null;
  const segments: CommandSegment[] = [];
  let tokens: CommandToken[] = [];
  let value = '';
  let quoted = false;
  let quote = '';
  const token = () => { if (value || quoted) tokens.push({ value, quoted }); value = ''; quoted = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; quoted = true; continue; }
    if (char === '#') return null;
    if (char === ' ' || char === '\t') { token(); continue; }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      token();
      let separator = char;
      if (char === '&') { if (command[index + 1] !== '&') return null; separator = '&&'; index++; }
      if (tokens.length) segments.push({ tokens, separator });
      else if (separator !== '\n') return null;
      tokens = [];
      continue;
    }
    if (char === '>' || char === '<') {
      token();
      let redirect = char;
      if (command[index + 1] === '>') { redirect += '>'; index++; }
      if (command[index + 1] === '&' && /[0-9]/.test(command[index + 2] || '')) {
        redirect += `&${command[index + 2]}`; index += 2;
      }
      tokens.push({ value: redirect, quoted: false });
      continue;
    }
    value += char;
  }
  if (quote) return null;
  token();
  if (tokens.length) segments.push({ tokens, separator: '' });
  else if (segments.length && ['&&', '|'].includes(segments[segments.length - 1].separator)) return null;
  if (segments.some((segment) => ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'until', '!'].includes(segment.tokens[0]?.value))) return null;
  return segments;
}

function checkTokens(tokens: string[]): 'runner-command' | 'script-name' | null {
  if (tokens.some((token) => /^(?:--(?:help|version|watch(?:All)?|collect-only|collectonly|co|list-tests|listTests|list|dry-run|prefix|cwd|directory)|-[hVwCc])(?:=|$)/i.test(token))) return null;
  const runner = tokens[0] === 'pytest' || (['python', 'python3'].includes(tokens[0]) && tokens[1] === '-m' && tokens[2] === 'pytest') ||
    (tokens[0] === 'node' && tokens[1] === '--test');
  if (runner) return 'runner-command';
  const manager = tokens[0];
  if (!['npm', 'pnpm', 'yarn'].includes(manager)) return null;
  const scriptPosition = tokens[1] === 'run' ? 2 : 1;
  if (!['test', 'build', 'lint', 'typecheck'].includes(tokens[scriptPosition])) return null;
  if (manager === 'npm' && scriptPosition === 1 && tokens[1] !== 'test') return null;
  return 'script-name';
}

function verificationCommand(call: RecordedCall): {
  command: string; basis: 'runner-command' | 'script-name'; commandMode: 'direct' | 'directory-prefix' | 'compound-fragment';
  fragments: string[]; explicitDirectory: string | null; usesInitialDirectory: boolean;
} | null {
  if (!['bash', 'Bash', 'shell', 'exec', 'exec_command', 'run_shell_command', 'execute_command', 'terminal'].includes(codexTool(call.name))) return null;
  const args = argumentObject(call.args);
  if (!args) return null;
  const values = ['command', 'cmd'].filter((key) => key in args).map((key) => args[key]);
  if (!values.length || values.some((value) => typeof value !== 'string' || value !== values[0])) return null;
  const command = values[0] as string;
  const segments = literalSegments(command);
  if (!segments?.length) return null;
  const recognized = segments.flatMap((segment, index) => {
    if (segment.tokens[0]?.quoted) return [];
    const tokens = segment.tokens.map((item) => item.value);
    const basis = checkTokens(tokens);
    return basis ? [{ index, basis, fragment: tokens.join(' ') }] : [];
  });
  if (!recognized.length) return null;
  const simple = (segment: CommandSegment) => segment.tokens.every((item) => !/[<>]/.test(item.value));
  const cd = segments[0];
  const direct = segments.length === 1 && simple(segments[0]);
  const hasDirectoryPrefix = cd.separator === '&&' && cd.tokens.length === 2 &&
    cd.tokens[0].value === 'cd' && !cd.tokens[0].quoted && /^\//.test(cd.tokens[1].value) &&
    recognized.length === 1 && recognized[0].index === 1;
  const directoryPrefix = hasDirectoryPrefix && segments.length === 2 && simple(segments[1]);
  return { command, basis: recognized[0].basis, fragments: recognized.map((entry) => entry.fragment),
    commandMode: direct ? 'direct' : directoryPrefix ? 'directory-prefix' : 'compound-fragment',
    explicitDirectory: hasDirectoryPrefix ? cd.tokens[1].value : null,
    usesInitialDirectory: recognized.length === 1 && recognized[0].index === 0 };
}

function executionEvidence(entry: CallEvidence, ambiguous: boolean): ExecutionEvidence {
  const args = argumentObject(entry.call.args);
  const directories = args ? ['cwd', 'workdir', 'working_directory'].filter((key) => key in args).map((key) => args[key]) : [];
  const directoryConflict = directories.some((value) => typeof value !== 'string' || !value) || new Set(directories).size > 1;
  const directory = !directoryConflict && typeof directories[0] === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(directories[0]) ? directories[0] : null;
  const result = ambiguous ? undefined : entry.result;
  const state = ambiguous ? 'unknown' : result ? relatedState(result.message, entry.call) : 'no-result';
  return {
    callMessage: entry.message, callIndex: entry.call.index, toolCallId: entry.id, toolName: entry.call.name,
    resultMessage: result?.message ?? null, resultIndex: result?.index ?? null, state, directory, directoryConflict,
    evidence: ambiguous ? '调用标识缺失或重复，无法唯一关联结果。' : result
      ? relatedEvidence(result.message, entry.call, state === 'no-result' ? 'unknown' : state)
      : '未记录到此调用的结果；不推断实际进程状态。',
  };
}

export function analyzeVerificationChronology(messages: SessionMessage[]) {
  const { calls, byId } = collectCallEvidence(messages);
  const processByLaunch = new Map(analyzeCodexProcesses(messages).processes.map((process) => [process.launchCallId, process]));
  const modificationResults: ExecutionEvidence[] = [];
  const checks: ExecutionEvidence[] = [];
  let unclassifiedShellCalls = 0;
  let unclassifiedModificationCalls = 0;
  for (const entry of calls) {
    const args = argumentObject(entry.call.args);
    const ambiguous = !entry.id || (byId.get(entry.id)?.length ?? 0) !== 1;
    if (['edit', 'Edit', 'write', 'Write', 'MultiEdit'].includes(entry.call.name)) {
      const paths = args ? ['path', 'file_path'].filter((key) => key in args).map((key) => args[key]) : [];
      if (!paths.length || paths.some((value) => typeof value !== 'string' || !value.trim() || value.includes('\0') || value !== paths[0])) {
        unclassifiedModificationCalls++;
      } else {
        modificationResults.push({ ...executionEvidence(entry, ambiguous), target: paths[0] as string });
      }
    } else if (['apply_patch', 'apply_diff', 'NotebookEdit'].includes(entry.call.name)) {
      unclassifiedModificationCalls++;
    }
    const recognized = verificationCommand(entry.call);
    if (recognized) {
      const evidence = executionEvidence(entry, ambiguous);
      const process = processByLaunch.get(entry.id);
      if (process && process.launchIndex === entry.call.index) {
        evidence.processEvidence = process;
        evidence.state = process.inputObserved ? 'unknown' : process.state;
        evidence.resultMessage = process.finalMessage;
        evidence.resultIndex = process.finalIndex;
        evidence.evidence = `通过 exec_command 包装头进程标识 ${process.processId} 与 write_stdin.session_id 关联。${process.inputObserved ? '过程中发送过输入，不能视为未干预的检查结果。' : ''}\n` +
          (process.finalMessage ? `最终进程退出码 ${process.exitCode}\n${resultText(process.finalMessage).slice(0, 400)}` : `未得到唯一可信的最终退出结果；${process.issues.join(', ') || '最后记录为执行中'}。`);
      }
      const { explicitDirectory, usesInitialDirectory, ...command } = recognized;
      if (recognized.commandMode === 'compound-fragment') {
        checks.push({ ...evidence, ...command, state: evidence.state === 'no-result' ? 'no-result' : 'unknown',
          directory: explicitDirectory ?? (usesInitialDirectory ? evidence.directory : null),
          directoryConflict: explicitDirectory ? false : evidence.directoryConflict,
          evidence: `命令文本包含检查片段；无法确认片段是否执行或通过，不能使用整个命令的退出码判定。\n${evidence.evidence}` });
      } else if (recognized.commandMode === 'directory-prefix') {
        checks.push({ ...evidence, ...command, directory: explicitDirectory, directoryConflict: false,
          state: evidence.state === 'failure' ? 'unknown' : evidence.state,
          evidence: `记录的目录前缀：cd 后通过 && 连接检查。${evidence.state === 'failure' ? '整体失败可能发生在 cd，检查状态未知。' : ''}\n${evidence.evidence}` });
      } else checks.push({ ...evidence, ...command });
    }
    else if (isExecution(entry.call, entry.message)) unclassifiedShellCalls++;
  }
  const modifications: ModificationChronology[] = [];
  for (const operation of modificationResults) {
    if (operation.state !== 'success' || operation.resultIndex === null) continue;
    const prior: ChronologyCheck[] = [], laterChecks: ChronologyCheck[] = [], overlappingChecks: ChronologyCheck[] = [];
    let excludedScopeChecks = 0;
    for (const check of checks) {
      if (operation.directoryConflict || check.directoryConflict || (operation.directory && check.directory && operation.directory !== check.directory)) {
        excludedScopeChecks++;
        continue;
      }
      const relation: ChronologyCheck = { operation: check,
        scope: operation.directory && check.directory ? 'same-recorded-directory' : 'unknown' };
      if (check.callIndex > operation.resultIndex) laterChecks.push(relation);
      else if (check.resultIndex !== null && check.resultIndex < operation.callIndex) {
        if (check.state === 'success') prior.push(relation);
      } else if (check.resultIndex === null || check.resultIndex >= operation.callIndex) overlappingChecks.push(relation);
    }
    prior.sort((left, right) => (left.operation.resultIndex ?? -1) - (right.operation.resultIndex ?? -1));
    const latest = laterChecks[laterChecks.length - 1];
    const latestOrderAmbiguous = !!latest && laterChecks.filter((entry) => entry.operation.callIndex === latest.operation.callIndex).length > 1;
    modifications.push({ operation, priorSuccess: prior[prior.length - 1] ?? null, laterChecks,
      latestLater: latestOrderAmbiguous ? null : latest ?? null, latestOrderAmbiguous, overlappingChecks, excludedScopeChecks });
  }
  return {
    modificationCalls: modificationResults.length, successfulModifications: modifications.length,
    unconfirmedModifications: modificationResults.length - modifications.length,
    unclassifiedModificationCalls, unclassifiedShellCalls, checks, modifications,
    withLaterCheck: modifications.filter((row) => row.laterChecks.length).length,
    withoutLaterCheck: modifications.filter((row) => !row.laterChecks.length).length,
    changedAfterLastPassedCheck: modifications.filter((row) => row.priorSuccess && !row.laterChecks.length).length,
  };
}
