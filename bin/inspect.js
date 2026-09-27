const HELP = `Usage: agentxray inspect --platform <omp|codex|claude-code> <file.jsonl> [--json] [--summary] [--fail-on pending-failures]
       agentxray evidence --platform <omp|codex|claude-code> <file.jsonl> --sha256 <hash> --line <number> [--offset <bytes>] [--max-bytes <4..16384>] [--json]

Read one stable regular UTF-8 JSONL file (maximum 64 MiB), without starting a server.
inspect: full report by default; --summary requires --json and bounds references, not aggregate counts.
evidence: explicit RAW content, potentially sensitive; always JSON, hash-checked, default maximum 4096 content bytes.
References use one-based physical lines. Byte pagination preserves UTF-8; use nextOffset to continue.
Exit 0: complete report, NOT task success. Exit 1: input/runtime/coverage error.
Exit 2: pending failure records found, only when inspect --fail-on pending-failures is requested.
JSON failures: {schemaVersion:1,kind:"error",error:{code,message}} on stdout.
Incomplete coverage retains report data on stdout and reports COVERAGE_INCOMPLETE on stderr.
`;

function wantsJson(args, mode) {
  if (mode === 'evidence') return true;
  const terminator = args.indexOf('--');
  return args.slice(0, terminator < 0 ? args.length : terminator).includes('--json');
}

function errorDocument(code, message) {
  return { schemaVersion: 1, kind: 'error', error: { code, message } };
}

function emitError(json, mode, code, message, help = false) {
  if (json) process.stdout.write(`${JSON.stringify(errorDocument(code, message))}\n`);
  process.stderr.write(`agentxray ${mode}: ${message}\n${help && !json ? HELP : ''}`);
  process.exitCode = 1;
}

function integer(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Expected a nonnegative safe integer.');
  return Number(value);
}

async function main(args, mode = 'inspect') {
  let filename, platform, policy;
  let summary = false;
  const json = wantsJson(args, mode);
  const evidenceOptions = {};
  const seen = new Set();
  let positionalOnly = false;
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      process.stdout.write(HELP);
      return;
    }
    const allowed =
      mode === 'evidence'
        ? ['--platform', '--json', '--sha256', '--line', '--offset', '--max-bytes']
        : ['--platform', '--json', '--summary', '--fail-on'];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (!positionalOnly && arg === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && arg.startsWith('-')) {
        const [flag, ...inline] = arg.split('=');
        if (!allowed.includes(flag) || seen.has(flag)) throw new Error('Invalid or duplicate option.');
        seen.add(flag);
        if (['--json', '--summary'].includes(flag)) {
          if (inline.length) throw new Error('Boolean flags do not take a value.');
          if (flag === '--summary') summary = true;
          continue;
        }
        const value = inline.length ? inline.join('=') : args[++index];
        if (!value || value.startsWith('-')) throw new Error('Missing option value.');
        if (flag === '--platform') platform = value;
        else if (flag === '--fail-on') policy = value;
        else if (flag === '--sha256') evidenceOptions.sha256 = value;
        else
          evidenceOptions[{ '--line': 'line', '--offset': 'offset', '--max-bytes': 'maxBytes' }[flag]] = integer(value);
      } else {
        if (filename !== undefined) throw new Error('Provide exactly one input file.');
        filename = arg;
      }
    }
    if (!filename || !platform) throw new Error('Explicit --platform and one input file are required.');
    if (policy !== undefined && policy !== 'pending-failures')
      throw new Error('Supported --fail-on policy: pending-failures.');
    if (summary && !json) throw new Error('--summary requires --json.');
    if (mode === 'evidence' && (!evidenceOptions.sha256 || !evidenceOptions.line))
      throw new Error('Evidence requires --sha256 and --line.');
  } catch (error) {
    emitError(json, mode, 'INVALID_ARGUMENT', error.message, true);
    return;
  }
  let implementation, detail;
  try {
    implementation = require('../lib/inspect');
    if (summary || mode === 'evidence') detail = require('../lib/inspect-detail');
  } catch {
    emitError(json, mode, 'RULES_UNAVAILABLE', 'Bundled rules unavailable; rebuild or reinstall the package.');
    return;
  }
  const { inspectFile, renderText, InspectError } = implementation;
  try {
    const full =
      mode === 'evidence'
        ? await detail.readEvidence(filename, platform, evidenceOptions)
        : await inspectFile(filename, platform);
    const report = summary ? detail.createSummary(full) : full;
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
    process.exitCode = !full.complete ? 1 : policy && full.summary.pendingRecords ? 2 : 0;
    if (!full.complete) {
      const message = 'Adapter coverage is incomplete; use the full inspect report for coverage issues.';
      process.stderr.write(
        json ? `${JSON.stringify(errorDocument('COVERAGE_INCOMPLETE', message))}\n` : `agentxray ${mode}: ${message}\n`
      );
    }
  } catch (error) {
    emitError(
      json,
      mode,
      error instanceof InspectError ? error.code : 'INSPECTION_FAILED',
      error instanceof InspectError ? error.message : 'Inspection failed; no report generated.'
    );
  }
}

module.exports = { main };
