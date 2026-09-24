const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const path = require('node:path');
const rules = require('./generated/diagnostics.cjs');
const { normalizeOmpRecord } = require('./platforms/omp');
const { normalizeCodexRecord } = require('./platforms/codex');
const { normalizeClaudeCodeRecord } = require('./platforms/claude');

const MAX_BYTES = 64 * 1024 * 1024;
const PLATFORMS = ['omp', 'codex', 'claude-code'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
class InspectError extends Error {}
const normalizers = {
  omp: normalizeOmpRecord,
  codex: (record) => (record.type === 'response_item' ? normalizeCodexRecord(record) : null),
  'claude-code': normalizeClaudeCodeRecord,
};

function toolLabel(value) {
  return [
    'bash',
    'Bash',
    'shell',
    'exec',
    'exec_command',
    'write_stdin',
    'functions.exec_command',
    'functions.write_stdin',
    'edit',
    'Edit',
    'write',
    'Write',
    'MultiEdit',
    'Read',
    'read',
    'grep',
    'glob',
    'eval',
    'web_search',
    'hub',
    'ask',
    'apply_patch',
    'run_shell_command',
    'execute_command',
    'terminal',
  ].includes(value)
    ? value
    : 'other';
}

function rawToolEntries(record, platform) {
  const calls = [],
    results = [];
  if (platform === 'codex' && record.type === 'response_item') {
    const payload = record.payload || {};
    if (['function_call', 'custom_tool_call'].includes(payload.type)) calls.push(payload.call_id || null);
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const exitCode = payload.output?.metadata?.exit_code;
      results.push({ id: payload.call_id || null, error: Number.isInteger(exitCode) && exitCode !== 0 });
    }
  } else if (platform === 'omp' && record.type === 'message') {
    const message = record.message || {};
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === 'toolCall') calls.push(part.id || null);
    }
    if (message.role === 'toolResult')
      results.push({ id: message.toolCallId || null, error: message.isError === true });
  } else if (
    platform === 'claude-code' &&
    ['user', 'assistant'].includes(record.type) &&
    Array.isArray(record.message?.content)
  ) {
    for (const part of record.message.content) {
      if (part?.type === 'tool_use') calls.push(part.id || null);
      if (part?.type === 'tool_result') results.push({ id: part.tool_use_id || null, error: part.is_error === true });
    }
  }
  return { calls, results };
}

function sameIds(left, right) {
  return JSON.stringify(left.map(String).sort()) === JSON.stringify(right.map(String).sort());
}

function normalizeRecords(bytes, platform) {
  if (!PLATFORMS.includes(platform)) throw new InspectError('Unsupported platform; choose omp, codex or claude-code.');
  if (bytes.byteLength > MAX_BYTES) throw new InspectError('Input exceeds 64 MiB; select a smaller stable JSONL file.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InspectError('Input is not valid UTF-8.');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const messages = [],
    lineOf = new Map();
  const coverage = {
    physicalLines: lines.length,
    records: 0,
    normalizedMessages: 0,
    rawToolCalls: 0,
    normalizedToolCalls: 0,
    rawToolResults: 0,
    normalizedToolResults: 0,
    ignoredRecords: 0,
    issues: [],
  };
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new InspectError(`Invalid JSON at line ${index + 1}; no report generated.`);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new InspectError(`Expected a JSON object at line ${index + 1}.`);
    coverage.records++;
    let normalized, raw;
    try {
      raw = rawToolEntries(record, platform);
      const value = normalizers[platform](record);
      normalized = Array.isArray(value) ? value : value ? [value] : [];
    } catch {
      throw new InspectError(`Unsupported record shape at line ${index + 1}; no report generated.`);
    }
    const callIds = [],
      results = [];
    for (const message of normalized) {
      messages.push(message);
      lineOf.set(message, index + 1);
      if (message.role === 'toolCall') callIds.push(message.toolCallId || message.id || null);
      for (const part of message.content || []) if (part.type === 'toolCall') callIds.push(part.id || null);
      if (message.role === 'toolResult') results.push(message);
    }
    coverage.rawToolCalls += raw.calls.length;
    coverage.normalizedToolCalls += callIds.length;
    coverage.rawToolResults += raw.results.length;
    coverage.normalizedToolResults += results.length;
    if (!normalized.length) coverage.ignoredRecords++;
    if (!sameIds(raw.calls, callIds)) coverage.issues.push({ line: index + 1, kind: 'tool-call-coverage' });
    if (
      !sameIds(
        raw.results.map((entry) => entry.id),
        results.map((entry) => entry.toolCallId || null)
      )
    ) {
      coverage.issues.push({ line: index + 1, kind: 'tool-result-coverage' });
    }
    for (const entry of raw.results.filter((entry) => entry.error)) {
      if (!results.some((result) => result.toolCallId === entry.id && result.isError === true)) {
        coverage.issues.push({ line: index + 1, kind: 'error-marker-loss' });
      }
    }
  }
  coverage.normalizedMessages = messages.length;
  if (!messages.length) throw new InspectError('No supported messages found for the selected platform.');
  return { messages, lineOf, coverage };
}

async function readSnapshot(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new InspectError('Input must be one regular JSONL file.');
    if (before.size > MAX_BYTES) throw new InspectError('Input exceeds 64 MiB; select a smaller stable JSONL file.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new InspectError('Input changed during inspection; retry a stable file.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new InspectError('Input changed during inspection; retry a stable file.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof InspectError) throw error;
    throw new InspectError('Cannot read input file. Check that it exists and is readable.');
  } finally {
    if (handle) await handle.close();
  }
}

async function inspectFile(filename, platform) {
  if (!PLATFORMS.includes(platform)) throw new InspectError('Unsupported platform; choose omp, codex or claude-code.');
  const bytes = await readSnapshot(filename);
  return createReport(bytes, platform);
}

async function createReport(bytes, platform) {
  const { messages, lineOf, coverage } = normalizeRecords(bytes, platform);
  const messageIndex = new Map(messages.map((message, index) => [message, index + 1]));
  const ref = (message) => (message ? { line: lineOf.get(message), messageIndex: messageIndex.get(message) } : null);
  let diagnostics, health, processes, chronology;
  try {
    diagnostics = rules.diagnoseSession(messages);
    health = rules.summarizeSessionHealth(messages, diagnostics);
    processes = rules.analyzeCodexProcesses(messages);
    chronology = rules.analyzeVerificationChronology(messages);
  } catch {
    throw new InspectError('Cannot analyze this record structure; no report generated.');
  }
  const operation = (entry) => ({
    tool: toolLabel(entry.toolName),
    call: ref(entry.callMessage),
    result: ref(entry.resultMessage),
    state: entry.state,
    directoryKnown: entry.directory !== null,
    directoryConflict: entry.directoryConflict,
    basis: entry.basis || null,
    commandMode: entry.commandMode || null,
  });
  const check = (entry) => (entry ? { scope: entry.scope, operation: operation(entry.operation) } : null);
  const { gaps, ...summary } = health;
  const adapters =
    platform === 'omp' ? ['omp.js', 'omp-outcome.js'] : [platform === 'codex' ? 'codex.js' : 'claude.js'];
  const adapterSources = await Promise.all(
    [
      ...adapters.map((file) => path.join(__dirname, 'platforms', file)),
      path.join(__dirname, 'platforms/shared.js'),
    ].map((file) => fs.readFile(file))
  );
  return {
    schemaVersion: 1,
    complete: coverage.issues.length === 0,
    engine: {
      version: require('../package.json').version,
      rulesSha256: rules.rulesSha256,
      adapterSha256: hash(Buffer.concat(adapterSources)),
    },
    source: { platform, bytes: bytes.length, sha256: hash(bytes) },
    coverage,
    limits: [
      'This report describes recognized records, not a task-success verdict or live process status.',
      'Only one stable input file is inspected. No commands, models, network calls or background service are started.',
      'Unknown and unclassified operations remain unknown; check timing is not test coverage.',
      'Raw content, paths, commands, IDs and notes are omitted; hashes and aggregate facts are not guaranteed anonymous.',
      'Source references use one-based physical JSONL lines and normalized message positions. Keep the original file for evidence.',
    ],
    summary,
    events: diagnostics.events.map((event) => ({
      tool: toolLabel(event.toolName),
      userTurn: event.userTurn,
      spanMs: event.spanMs,
      reason: event.failures.at(-1).reason,
      failures: event.failures.map((failure) => ref(failure.message)),
      related: event.relatedOperations.map((entry) => ({
        relation: entry.relation,
        state: entry.state,
        tool: toolLabel(entry.toolName),
        call: ref(messages[entry.callIndex]),
        result: ref(entry.message),
      })),
    })),
    gaps: gaps.map((gap) => ({
      tool: toolLabel(gap.toolName),
      state: gap.state,
      reason: gap.reason,
      source: ref(gap.message),
    })),
    processes: {
      pollCalls: processes.pollCalls,
      linkedPolls: processes.linkedPolls,
      unlinkedPolls: processes.unlinkedPolls,
      ambiguousCalls: processes.ambiguousCalls,
      entries: processes.processes.map((entry) => ({
        launch: ref(entry.launchMessage),
        launchResult: ref(entry.launchResult),
        finalResult: ref(entry.finalMessage),
        state: entry.state,
        exitCode: entry.exitCode,
        inputObserved: entry.inputObserved,
        issues: entry.issues,
        polls: entry.polls.map((poll) => ({
          call: ref(poll.callMessage),
          result: ref(poll.resultMessage),
          state: poll.state,
          exitCode: poll.exitCode,
          hasInput: poll.hasInput,
        })),
      })),
    },
    chronology: {
      modificationCalls: chronology.modificationCalls,
      successfulModifications: chronology.successfulModifications,
      unconfirmedModifications: chronology.unconfirmedModifications,
      unclassifiedModificationCalls: chronology.unclassifiedModificationCalls,
      unclassifiedShellCalls: chronology.unclassifiedShellCalls,
      withLaterCheck: chronology.withLaterCheck,
      withoutLaterCheck: chronology.withoutLaterCheck,
      changedAfterLastPassedCheck: chronology.changedAfterLastPassedCheck,
      checks: chronology.checks.map(operation),
      modifications: chronology.modifications.map((row) => ({
        modification: operation(row.operation),
        priorSuccess: check(row.priorSuccess),
        latestLater: check(row.latestLater),
        latestOrderAmbiguous: row.latestOrderAmbiguous,
        laterChecks: row.laterChecks.map(check),
        overlappingChecks: row.overlappingChecks.map(check),
        excludedScopeChecks: row.excludedScopeChecks,
      })),
    },
  };
}

function renderText(report) {
  return `${[
    `AgentXRay offline evidence report (schema ${report.schemaVersion})`,
    `Platform: ${report.source.platform} | Source SHA-256: ${report.source.sha256}`,
    `Known adapter identity coverage: ${report.complete ? 'complete' : 'INCOMPLETE — inspect coverage issues in --json output'}`,
    `Tool calls: ${report.summary.callCount} | Tool results: ${report.summary.toolResultCount}`,
    `Failure records: ${report.summary.failureRecords} | Pending failure records: ${report.summary.pendingRecords}`,
    `Pending events: ${report.summary.pendingEvents} | Matching recovery records: ${report.summary.recoveredRecords}`,
    `Call-result gaps: ${report.gaps.length} | Related result candidates: ${report.summary.candidateResults}`,
    `Codex launches: ${report.processes.entries.length} | Linked polls: ${report.processes.linkedPolls}`,
    `Explicit modification successes: ${report.chronology.successfulModifications} | Recognized check calls: ${report.chronology.checks.length}`,
    'This is not a task-success verdict. Use --json for all source references and coverage limits.',
  ].join('\n')}\n`;
}

module.exports = { inspectFile, createReport, normalizeRecords, renderText, InspectError, PLATFORMS, MAX_BYTES };
