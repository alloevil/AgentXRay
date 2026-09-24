const fs = require('node:fs');
const path = require('node:path');
const { capture, verifyCapture, fail } = require('./capture.cjs');
const { prepare, submit, check } = require('./prepare.cjs');
const { disclose, openForArm } = require('./disclose.cjs');
const { runStudy } = require('./remote-run.cjs');

function status(output) {
  const journal = path.join(output, 'intake.jsonl');
  const rows = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const candidates = rows.filter((row) => row.id && row.origin === 'omp-before-agent-start' && row.state !== 'excluded');
  let eligible = 0;
  let evaluated = 0;
  let trialAttempts = 0;
  for (const candidate of candidates) {
    if (!/^[a-f0-9-]{36}$/.test(candidate.id)) continue;
    const disclosure = path.join(output, 'candidates', candidate.id, 'disclosure');
    if (fs.existsSync(path.join(disclosure, 'private/gate.json'))) {
      try { openForArm(disclosure, 'raw'); eligible++; } catch {}
    }
    const summaryFile = path.join(disclosure, 'private/remote-study/summary.json');
    if (fs.existsSync(summaryFile)) {
      const summary = JSON.parse(fs.readFileSync(summaryFile));
      if (summary.origin === 'omp-before-agent-start') {
        trialAttempts += summary.recorded;
        if (summary.complete) evaluated++;
      }
    }
  }
  return { realCaptured: candidates.length, realWithFrozenOracle: candidates.filter((row) => row.state === 'frozen-oracle-needs-preflight').length,
    realEligibleForModelEvaluation: eligible, realModelEvaluated: evaluated, realTrialAttempts: trialAttempts, excluded: rows.filter((row) => row.state === 'excluded').length,
    infrastructureCaptures: rows.filter((row) => row.origin && row.origin !== 'omp-before-agent-start').length,
    modelTransport: 'remote-omp-sanitized-payload-only', localInferenceAllowed: false, productivityEstablished: false };
}

async function main() {
  const [action, directory, id, phase] = process.argv.slice(2);
  if (!directory) fail('DIRECTORY_OR_SPEC_REQUIRED');
  if (action === 'capture') {
    const spec = JSON.parse(fs.readFileSync(directory));
    if (spec.origin === 'omp-before-agent-start') fail('REAL_INTAKE_REQUIRES_LIVE_HOOK');
    if (!spec.origin) fail('EXPLICIT_INFRASTRUCTURE_ORIGIN_REQUIRED');
    const result = capture(spec);
    console.log(JSON.stringify({ id: result.manifest.id, directory: result.directory, eligibility: result.manifest.eligibility }));
  } else if (action === 'verify') console.log(JSON.stringify({ id: verifyCapture(directory).id, verified: true }));
  else if (action === 'prepare') {
    const result = await prepare(directory);
    console.log(JSON.stringify({ trialsPrepared: result.plan.order.length, initialHiddenPassed: result.initial.passed, modelTrials: 0 }));
  } else if (action === 'submit') { submit(directory, id, phase); console.log(JSON.stringify({ submitted: true })); }
  else if (action === 'check') {
    const result = check(directory, id, phase);
    console.log(JSON.stringify({ passed: result.passed, code: result.code, infrastructureFailure: result.infrastructureFailure }));
    if (!result.passed) process.exitCode = 1;
  } else if (action === 'status') console.log(JSON.stringify(status(directory), null, 2));
  else if (action === 'disclose') console.log(JSON.stringify(await disclose(directory, JSON.parse(fs.readFileSync(id))), null, 2));
  else if (action === 'verify-disclosure') {
    const payload = openForArm(directory, id || 'raw');
    console.log(JSON.stringify({ verified: true, files: Object.keys(payload.workspace).length, arm: id || 'raw', networkRequests: 0 }));
  } else if (action === 'run') console.log(JSON.stringify(await runStudy(directory), null, 2));
  else fail('USE_CAPTURE_VERIFY_PREPARE_SUBMIT_CHECK_STATUS_DISCLOSE_VERIFY_DISCLOSURE');
}

module.exports = { status };
if (require.main === module) main().catch((error) => { console.error(/^[A-Z_]+$/.test(error.code || '') ? error.code : 'STUDY_COMMAND_FAILED'); process.exitCode = 1; });
