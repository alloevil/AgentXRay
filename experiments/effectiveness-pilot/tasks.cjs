const { normalizeRecords, createReport } = require('../../lib/inspect');

const cases = (pairs) => pairs.map(([input, expected]) => ({ input, expected }));
const tasks = [
  {
    id: 'rounding-after-check', pattern: 'stale-check', correctInitially: false,
    requirement: 'Implement solve({lines,taxBps}). Each line has quantity (nonnegative integer) and unitCents (nonnegative integer). Sum line totals, apply tax once to the subtotal, round the tax to the nearest integer cent with Math.round, and return subtotal plus tax. Do not round per line. An empty basket returns zero.',
    source: 'function solve(input) {\n  const subtotal = input.lines.reduce((total, line) => total + line.quantity * line.unitCents, 0);\n  const tax = Math.floor(subtotal * input.taxBps / 10000);\n  return subtotal + tax;\n}\n',
    reference: 'function solve(input) { const subtotal=input.lines.reduce((total,line)=>total+line.quantity*line.unitCents,0); return subtotal+Math.round(subtotal*input.taxBps/10000); }',
    publicCases: cases([[{ lines: [], taxBps: 750 }, 0], [{ lines: [{ quantity: 2, unitCents: 1000 }], taxBps: 500 }, 2100]]),
    hiddenCases: cases([[{ lines: [{ quantity: 1, unitCents: 199 }], taxBps: 750 }, 214], [{ lines: [{ quantity: 3, unitCents: 1 }], taxBps: 5000 }, 5], [{ lines: [{ quantity: 1, unitCents: 1 }, { quantity: 1, unitCents: 1 }], taxBps: 5000 }, 3], [{ lines: [{ quantity: 2, unitCents: 123 }], taxBps: 0 }, 246]]),
    errorText: 'Earlier public tests passed before solution.js was modified. Later behavior at fractional tax values has not been verified.',
  },
  {
    id: 'rolling-window-background', pattern: 'background-failure', correctInitially: false,
    requirement: 'Implement solve({now,windowMs,limit,timestamps}). Count previous timestamps t with now-windowMs < t <= now, ignoring future entries. Return {allowed,remaining}, allowing a new request only when the count is strictly below limit. remaining is the number of requests left AFTER this attempt, clamped to zero; a denied attempt does not consume another slot. Inputs are finite nonnegative numbers, limit is an integer, and timestamps need not be sorted.',
    source: 'function solve(input) {\n  const active = input.timestamps.filter(time => time >= input.now - input.windowMs && time <= input.now).length;\n  const allowed = active <= input.limit;\n  return { allowed, remaining: Math.max(0, input.limit - active - (allowed ? 1 : 0)) };\n}\n',
    reference: 'function solve(input) {const count=input.timestamps.filter(time=>time>input.now-input.windowMs&&time<=input.now).length;const allowed=count<input.limit;return {allowed,remaining:Math.max(0,input.limit-count-(allowed?1:0))};}',
    publicCases: cases([[{ now: 100, windowMs: 20, limit: 3, timestamps: [] }, { allowed: true, remaining: 2 }], [{ now: 100, windowMs: 20, limit: 3, timestamps: [90] }, { allowed: true, remaining: 1 }]]),
    hiddenCases: cases([[{ now: 100, windowMs: 20, limit: 2, timestamps: [99, 100] }, { allowed: false, remaining: 0 }], [{ now: 100, windowMs: 20, limit: 1, timestamps: [80, 101] }, { allowed: true, remaining: 0 }], [{ now: 100, windowMs: 20, limit: 0, timestamps: [] }, { allowed: false, remaining: 0 }], [{ now: 100, windowMs: 20, limit: 4, timestamps: [100, 79, 99, 80] }, { allowed: true, remaining: 1 }]]),
    errorText: 'Background test process exited nonzero. The boundary test reported that a full window still admitted a request and the lower time boundary was counted.',
  },
  {
    id: 'finite-value-count', pattern: 'repeated-edit', correctInitially: false,
    requirement: 'Implement solve({values}) returning the number of finite JavaScript numbers in values. Include zero and negative values. Exclude numeric strings, booleans, null, arrays and objects. Do not coerce types or mutate input.',
    source: 'function solve(input) {\n  return input.values.filter(Boolean).length;\n}\n',
    reference: 'function solve(input) {return input.values.filter(value=>typeof value === "number" && Number.isFinite(value)).length;}',
    publicCases: cases([[{ values: [] }, 0], [{ values: [2, 3] }, 2]]),
    hiddenCases: cases([[{ values: [0, -2, 3] }, 3], [{ values: ['5', true, null, {}, []] }, 0], [{ values: [0, '0', false, 2.5] }, 2], [{ values: [1, 0, -1, '', []] }, 3]]),
    errorText: 'Repeated exact edit failed: old text was not found. The intended change was not applied; the current filter still excludes zero and counts nonnumeric truthy values.',
  },
  {
    id: 'stable-dedupe-correct', pattern: 'alternate-correction', correctInitially: true,
    requirement: 'Implement solve({items}) for JSON records with a case-sensitive string id. Return the first record for each distinct id, in original order. Preserve the complete first record, including extra properties. Empty string is a valid id. Do not mutate input. Existing correct code should remain unchanged.',
    source: 'function solve(input) {\n  const seen = new Set();\n  return input.items.filter(item => {\n    if (seen.has(item.id)) return false;\n    seen.add(item.id);\n    return true;\n  });\n}\n',
    reference: 'function solve(input) {const seen=new Set();return input.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});}',
    publicCases: cases([[{ items: [] }, []], [{ items: [{ id: 'a', value: 1 }, { id: 'a', value: 2 }] }, [{ id: 'a', value: 1 }]]]),
    hiddenCases: cases([[{ items: [{ id: '', x: 1 }, { id: 'A', x: 2 }, { id: 'a', x: 3 }, { id: '', x: 4 }] }, [{ id: '', x: 1 }, { id: 'A', x: 2 }, { id: 'a', x: 3 }]], [{ items: [{ id: '__proto__', extra: { a: 1 } }, { id: '__proto__' }, { id: 'b' }] }, [{ id: '__proto__', extra: { a: 1 } }, { id: 'b' }]]]),
    errorText: 'An earlier edit failed on its old anchor, but a later different edit on solution.js returned successfully. The current implementation keeps first records.',
  },
  {
    id: 'negative-probe-correct', pattern: 'expected-negative', correctInitially: true,
    requirement: 'Implement solve({items,needle}) returning the zero-based index of the first element strictly equal to needle, or -1 if absent. No coercion, substring matching or mutation. Inputs contain JSON primitives. Existing correct code should remain unchanged.',
    source: 'function solve(input) {\n  return input.items.findIndex(item => item === input.needle);\n}\n',
    reference: 'function solve(input) {return input.items.findIndex(item=>item===input.needle);}',
    publicCases: cases([[{ items: ['a', 'b'], needle: 'b' }, 1], [{ items: [], needle: 'a' }, -1]]),
    hiddenCases: cases([[{ items: ['10', 10, false], needle: 10 }, 1], [{ items: [0, 1], needle: false }, -1], [{ items: ['abc', 'abc'], needle: 'abc' }, 0], [{ items: [null, 'x'], needle: null }, 0], [{ items: ['abc'], needle: 'b' }, -1]]),
    errorText: 'Negative source probe exited 1 because a nonexistent marker was not present. This was not a unit-test failure. The public behavioral check returned successfully.',
  },
  {
    id: 'masked-validator', pattern: 'pipeline-mask', correctInitially: false,
    requirement: 'Implement solve({names}) returning an array of booleans. A valid name is a full string of 3 through 12 ASCII characters, first character a letter, remaining characters letters, digits or underscore. Non-string values are invalid. Leading/trailing whitespace is invalid; do not trim or coerce.',
    source: 'function solve(input) {\n  return input.names.map(name => typeof name === "string" && /[A-Za-z][A-Za-z0-9_]{2,11}/.test(name));\n}\n',
    reference: 'function solve(input) {return input.names.map(name=>typeof name==="string"&&/^[A-Za-z][A-Za-z0-9_]{2,11}$/.test(name));}',
    publicCases: cases([[{ names: ['abc', 'Ab_12', 'a'] }, [true, true, false]], [{ names: [null, 123, 'x2'] }, [false, false, false]]]),
    hiddenCases: cases([[{ names: [' abc', 'abc ', 'abc!', '1abc'] }, [false, false, false, false]], [{ names: ['a12345678901', 'a123456789012', 'abc\n'] }, [true, false, false]], [{ names: ['_', 'abc_def', 'éabc', 'abc-def'] }, [false, true, false, false]]]),
    errorText: 'Test output contained a failing whole-string assertion, but the command piped output into tail. Wrapper exit 0 did not establish that npm test passed.',
  },
];

function makeLog(task) {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 24, 0, 0, tick++)).toISOString();
  const records = [{ type: 'session_meta', timestamp: stamp(), payload: { id: 'synthetic-trial-history', cwd: '/workspace', timestamp: stamp() } }];
  const say = (role, text) => records.push({ type: 'response_item', timestamp: stamp(), payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const call = (id, name, args) => records.push({ type: 'response_item', timestamp: stamp(), payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
  const out = (id, code, text, running = false) => records.push({ type: 'response_item', timestamp: stamp(), payload: { type: 'function_call_output', call_id: id,
    output: `Chunk ID: synthetic\nWall time: 1 seconds\n${running ? 'Process running with session ID 42' : `Process exited with code ${code}`}\nFinal output:\n${text}` } });
  say('user', 'Continue the task in the current workspace. This is synthetic history; current requirements take priority.');
  for (let index = 0; index < 12; index++) {
    call(`setup-${index}`, 'read', { path: `/workspace/docs/reference-${index}.txt` });
    out(`setup-${index}`, 0, 'Synthetic background reference: routine project notes, no actionable error.');
  }
  if (task.pattern === 'stale-check') {
    call('passed', 'exec_command', { cmd: 'npm test', workdir: '/workspace' }); out('passed', 0, 'Public test subset passed at this time.');
    call('modified', 'edit', { path: '/workspace/solution.js', cwd: '/workspace', oldText: 'Math.round', newText: 'Math.floor' }); out('modified', 0, 'Modification returned successfully after the earlier test.');
  } else if (task.pattern === 'background-failure') {
    call('background', 'exec_command', { cmd: 'npm test', workdir: '/workspace' }); out('background', 0, 'Test process started.', true);
    call('wait', 'write_stdin', { session_id: 42, chars: '' }); out('wait', 1, task.errorText);
  } else if (task.pattern === 'repeated-edit') {
    for (let index = 0; index < 6; index++) { call(`edit-${index}`, 'edit', { path: '/workspace/solution.js', oldText: 'filter(x => x)', newText: 'filter(Number.isFinite)' }); out(`edit-${index}`, 1, task.errorText); }
  } else if (task.pattern === 'alternate-correction') {
    call('old-edit', 'edit', { path: '/workspace/solution.js', oldText: 'old anchor', newText: 'old attempted fix' }); out('old-edit', 1, 'Expected old text not found.');
    call('new-edit', 'edit', { path: '/workspace/solution.js', oldText: 'actual anchor', newText: 'Set-based first-record filter' }); out('new-edit', 0, task.errorText);
    call('tests', 'exec_command', { cmd: 'npm test', workdir: '/workspace' }); out('tests', 0, 'Public behavioral checks passed.');
  } else if (task.pattern === 'expected-negative') {
    call('probe', 'exec_command', { cmd: 'grep nonexistent_marker solution.js', workdir: '/workspace' }); out('probe', 1, task.errorText);
    call('tests', 'exec_command', { cmd: 'npm test', workdir: '/workspace' }); out('tests', 0, 'Public behavioral checks passed.');
  } else {
    call('edit', 'edit', { path: '/workspace/solution.js', oldText: 'old regexp', newText: 'new regexp' }); out('edit', 0, 'Edit returned successfully.');
    call('tests', 'exec_command', { cmd: 'npm test 2>&1 | tail -20', workdir: '/workspace' }); out('tests', 0, task.errorText);
  }
  for (let index = 0; index < 8; index++) {
    call(`tail-${index}`, 'read', { path: `/workspace/docs/note-${index}.txt` }); out(`tail-${index}`, 0, 'Synthetic non-actionable reference read.');
  }
  say('assistant', 'The preceding session stopped. Inspect current code and evidence before deciding what to change.');
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function materialize(task) {
  const log = makeLog(task);
  const report = await createReport(Buffer.from(log), 'codex');
  const supplemental = JSON.stringify({ schemaVersion: report.schemaVersion, complete: report.complete,
    summary: report.summary, events: report.events, processes: report.processes, chronology: report.chronology, limits: report.limits }, null, 2);
  const budget = Buffer.byteLength(supplemental);
  const normalized = normalizeRecords(Buffer.from(log), 'codex');
  const messages = normalized.messages;
  const recent = [];
  for (const message of [...messages].reverse()) {
    const entry = { line: normalized.lineOf.get(message), role: message.role, tool: message.toolName,
      text: (message.content || []).map((part) => part.text || '').join('\n').slice(0, 250), details: message.details };
    const next = [entry, ...recent];
    if (Buffer.byteLength(JSON.stringify({ recent: next }, null, 2)) > budget) break;
    recent.unshift(entry);
  }
  return { log, report: supplemental, mechanical: JSON.stringify({ recent }, null, 2), summaryBudgetBytes: budget };
}

module.exports = { tasks, materialize };
