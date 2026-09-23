function ompOutcome(message) {
  const details = message.details || {};
  const tool = message.toolName;
  const cells = tool === 'eval' && Array.isArray(details.cells) ? details.cells : [];
  const warnings = [];
  const observations = (events, prefix) => {
    if (!Array.isArray(events)) return;
    events.forEach((event, index) => {
      if (event?.error) warnings.push(`${prefix}[${index}].error`);
    });
  };
  if (tool === 'eval') {
    observations(details.statusEvents, 'details.statusEvents');
    cells.forEach((cell, index) => observations(cell?.statusEvents, `details.cells[${index}].statusEvents`));
  }
  const outcome = (state, ...evidence) => ({ state, evidence, warnings });
  const text = Array.isArray(message.content)
    ? message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text || '')
        .join('\n')
        .trim()
    : '';
  if (tool === 'read' && message.isError === true && text === '[Superseded by a newer read of this file]') {
    return outcome('unknown', 'content: OMP superseded-read placeholder');
  }
  if (
    tool === 'ask' &&
    message.isError === true &&
    ['Ask tool was cancelled by the user', 'Ask input was cancelled'].includes(text)
  ) {
    return outcome('cancelled', 'content: OMP ask cancellation');
  }
  const failures = [];
  if (message.isError === true) failures.push('isError=true');
  if (details.isError === true) failures.push('details.isError=true');
  for (const key of ['exitCode', 'exit_code']) {
    if (Number.isInteger(details[key]) && details[key] !== 0) failures.push(`details.${key}=${details[key]}`);
  }
  if (tool === 'bash' && details.timedOut === true) failures.push('details.timedOut=true');
  if (tool === 'web_search' && typeof details.error === 'string' && details.error.trim()) {
    failures.push('details.error (non-empty)');
  }
  cells.forEach((cell, index) => {
    if (Number.isInteger(cell?.exitCode) && cell.exitCode !== 0) {
      failures.push(`details.cells[${index}].exitCode=${cell.exitCode}`);
    }
    if (cell?.status === 'error') failures.push(`details.cells[${index}].status=error`);
  });
  const asyncState = details.async?.state;
  if (asyncState === 'cancelled' && failures.every((entry) => entry === 'isError=true')) {
    return outcome('cancelled', 'details.async.state=cancelled');
  }
  if (asyncState === 'failed') failures.push('details.async.state=failed');
  if (failures.length) return outcome('failure', ...failures);
  if (tool === 'hub') {
    if (details.op === 'stop' && message.isError === false && details.daemon) {
      return outcome('cancelled', 'details.op=stop', 'details.daemon (stop result, not task success)');
    }
    return outcome('unknown', 'toolName=hub (management result, not task completion)');
  }
  if (details.async != null) {
    if (asyncState === 'running' || asyncState === 'pending') {
      return outcome('running', `details.async.state=${asyncState}`);
    }
    if (asyncState !== 'completed') return outcome('unknown', 'details.async (unrecognized state)');
  }
  if (['running', 'pending', 'in_progress'].includes(details.status)) {
    return outcome('running', `details.status=${details.status}`);
  }
  const pendingCell = cells.findIndex((cell) => ['running', 'pending'].includes(cell?.status));
  if (pendingCell >= 0) return outcome('running', `details.cells[${pendingCell}].status=${cells[pendingCell].status}`);
  if (asyncState === 'completed' && message.isError === false) {
    return outcome('success', 'details.async.state=completed', 'isError=false');
  }
  if (tool === 'eval') {
    if (
      cells.length &&
      cells.every((cell) => cell?.status === 'complete' && cell.exitCode === 0) &&
      message.isError === false
    ) {
      return outcome('success', 'details.cells[*].status=complete', 'details.cells[*].exitCode=0', 'isError=false');
    }
    return outcome('unknown', 'details.cells (missing or incomplete execution evidence)');
  }
  const zeroKey = ['exitCode', 'exit_code'].find((key) => details[key] === 0);
  if (zeroKey) return outcome('success', `details.${zeroKey}=0`);
  if (tool === 'bash') {
    if (message.isError === false && Number.isFinite(details.wallTimeMs) && details.wallTimeMs >= 0) {
      return outcome('success', 'details.wallTimeMs (OMP synchronous completion)', 'isError=false');
    }
    return outcome('unknown', 'details (missing bash completion evidence)');
  }
  if (
    /(?:^|[./_])(shell|exec|exec_command|run_shell_command|execute_command|terminal|write_stdin)$/i.test(tool || '')
  ) {
    return outcome('unknown', 'toolName (unsupported execution contract)');
  }
  if (message.isError === false && Array.isArray(message.content)) {
    return outcome('success', 'isError=false', 'content (tool result, not task acceptance)');
  }
  return outcome('unknown', 'message (missing completion evidence)');
}

module.exports = { ompOutcome };
