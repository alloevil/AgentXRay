const HELP = `Usage: agentxray inspect --platform <omp|codex|claude-code> <file.jsonl> [--json] [--fail-on pending-failures]

Read one stable regular UTF-8 JSONL file (maximum 64 MiB), without starting a server.
Reports omit raw logs, paths, commands and IDs; source references are one-based lines/positions.
Exit 0: complete report, NOT task success. Exit 1: input/runtime/coverage error.
Exit 2: pending failure records found, only when --fail-on pending-failures is requested.
`;

async function main(args) {
  let filename,
    platform,
    json = false,
    policy;
  const seen = new Set();
  let positionalOnly = false;
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      process.stdout.write(HELP);
      return;
    }
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (!positionalOnly && arg === '--') {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && arg.startsWith('-')) {
        const [flag, ...inline] = arg.split('=');
        if (!['--platform', '--json', '--fail-on'].includes(flag) || seen.has(flag))
          throw new Error('Invalid or duplicate option.');
        seen.add(flag);
        if (flag === '--json') {
          if (inline.length) throw new Error('--json does not take a value.');
          json = true;
          continue;
        }
        const value = inline.length ? inline.join('=') : args[++index];
        if (!value || value.startsWith('-')) throw new Error('Missing option value.');
        if (flag === '--platform') platform = value;
        else policy = value;
      } else {
        if (filename !== undefined) throw new Error('Provide exactly one input file.');
        filename = arg;
      }
    }
    if (!filename || !platform) throw new Error('Explicit --platform and one input file are required.');
    if (policy !== undefined && policy !== 'pending-failures')
      throw new Error('Supported --fail-on policy: pending-failures.');
  } catch (error) {
    process.stderr.write(`agentxray inspect: ${error.message}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  let implementation;
  try {
    implementation = require('../lib/inspect');
  } catch {
    process.stderr.write('agentxray inspect: bundled rules unavailable; rebuild or reinstall the package.\n');
    process.exitCode = 1;
    return;
  }
  const { inspectFile, renderText, InspectError } = implementation;
  try {
    const report = await inspectFile(filename, platform);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
    process.exitCode = !report.complete ? 1 : policy && report.summary.pendingRecords ? 2 : 0;
    if (!report.complete)
      process.stderr.write('agentxray inspect: adapter coverage is incomplete; see report.coverage.issues.\n');
  } catch (error) {
    process.stderr.write(
      `agentxray inspect: ${error instanceof InspectError ? error.message : 'Inspection failed; no report generated.'}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = { main };
