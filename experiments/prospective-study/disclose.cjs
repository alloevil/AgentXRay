const fs = require('node:fs');
const path = require('node:path');
const { createReport } = require('../../lib/inspect');
const { verifyCapture, readRegular, safeRelative, directoryFiles, writeFile, hash, json, fail } = require('./capture.cjs');
const { decode, makeRedactor, scan, discover } = require('./redact.cjs');
const { isolatedCheck } = require('./isolate.cjs');
const { contexts } = require('./prepare.cjs');

function pipelineHashes() {
  return Object.fromEntries(['capture.cjs', 'redact.cjs', 'scan.toml', 'disclose.cjs', 'isolate.cjs', 'prepare.cjs',
    '../../lib/inspect.js', '../../lib/generated/diagnostics.cjs', '../../lib/platforms/omp.js'].map((name) => [name, hash(fs.readFileSync(path.join(__dirname, name)))]));
}

function witness(result) {
  if (result.infrastructureFailure || result.timedOut) fail('ACCEPTANCE_INFRASTRUCTURE_FAILURE');
  let value;
  try { value = JSON.parse(result.stdout); } catch { fail('CASE_LEVEL_WITNESS_REQUIRED'); }
  if (value.schemaVersion !== 1 || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 256) fail('CASE_LEVEL_WITNESS_REQUIRED');
  const seen = new Set();
  for (const entry of value.cases) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id) || typeof entry.passed !== 'boolean' || seen.has(entry.id)) fail('INVALID_CASE_WITNESS');
    seen.add(entry.id);
  }
  const cases = value.cases.map(({ id, passed }) => ({ id, passed }));
  if (cases.every((entry) => entry.passed) !== result.passed) fail('WITNESS_EXIT_MISMATCH');
  return cases;
}

async function evidence(history) {
  const report = await createReport(Buffer.from(history), 'omp');
  if (!report.complete) fail('INCOMPLETE_EVIDENCE');
  const { source, ...rest } = report;
  return rest;
}

function referenceWorkspace(workspace, oracle, files, destination) {
  fs.cpSync(workspace, destination, { recursive: true });
  for (const entry of files) {
    const value = readRegular(oracle, entry.from);
    const file = path.join(destination, safeRelative(entry.to));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value.bytes, { mode: value.mode });
  }
}

function validateScope(manifest, scope) {
  if (!scope || !Array.isArray(scope.files) || !scope.files.length || scope.files.length > 512 ||
    typeof scope.rationale !== 'string' || !scope.rationale.trim()) fail('TASK_FILE_ALLOWLIST_REQUIRED');
  const names = [...new Set(scope.files)].sort();
  for (const name of names) {
    safeRelative(name);
    if (!manifest.files.some((entry) => entry.path === name && !entry.deleted)) fail('SCOPE_FILE_NOT_CAPTURED');
  }
  if (manifest.oracle.writable.some((name) => !names.includes(name))) fail('WRITABLE_FILE_OUTSIDE_SCOPE');
  return names;
}

async function disclose(captureDirectory, scope) {
  captureDirectory = path.resolve(captureDirectory);
  const manifest = verifyCapture(captureDirectory);
  const frozenPipeline = pipelineHashes();
  if (!manifest.oracle?.referenceFiles?.length || !manifest.oracle.expectedInitial) fail('FROZEN_REFERENCE_AND_EXPECTATION_REQUIRED');
  const files = validateScope(manifest, scope);
  const directory = path.join(captureDirectory, 'disclosure');
  fs.mkdirSync(directory, { mode: 0o700 });
  const privateDirectory = path.join(directory, 'private');
  const payload = path.join(directory, 'payload');
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  fs.mkdirSync(payload, { mode: 0o700 });
  const started = performance.now();
  try {
    const docs = [
      { key: 'task.txt', kind: 'text', text: decode(readRegular(captureDirectory, 'prompt.txt').bytes) },
      { key: 'history.jsonl', kind: 'jsonl', text: decode(readRegular(captureDirectory, 'history.jsonl').bytes) },
      { key: 'contract', kind: 'json', text: json({ publicCommand: manifest.oracle.publicCommand, hiddenCommand: manifest.oracle.hiddenCommand,
        writable: manifest.oracle.writable, referenceFiles: manifest.oracle.referenceFiles }) },
    ];
    for (const file of files) docs.push({ key: `workspace/${file}`, kind: file.endsWith('.json') ? 'json' : 'text',
      text: decode(readRegular(path.join(captureDirectory, 'workspace'), file).bytes) });
    for (const file of manifest.oracle.oracleFiles) docs.push({ key: `oracle/${file.path}`, kind: file.path.endsWith('.json') ? 'json' : 'text',
      text: decode(readRegular(path.join(captureDirectory, 'oracle'), file.path).bytes) });
    const namesDocument = { key: 'names', kind: 'json', text: json(docs.map((entry) => entry.key)) };
    const redactor = makeRedactor([...docs, namesDocument], scope.privateTerms || []);
    writeFile(privateDirectory, 'replacement-map.json', json(redactor.mapping));
    writeFile(privateDirectory, 'scope.json', json(scope));
    const names = new Set();
    for (const entry of docs.filter((entry) => entry.key !== 'contract')) {
      const separator = entry.key.indexOf('/');
      const name = separator < 0 ? entry.key : `${entry.key.slice(0, separator + 1)}${redactor.transform(entry.key.slice(separator + 1))}`;
      safeRelative(name);
      if (names.has(name)) fail('DISCLOSURE_PATH_COLLISION');
      names.add(name);
      const root = entry.key.startsWith('oracle/') ? privateDirectory : payload;
      const originalFile = entry.key.startsWith('workspace/') ? manifest.files.find((file) => `workspace/${file.path}` === entry.key) : null;
      const oracleFile = entry.key.startsWith('oracle/') ? manifest.oracle.oracleFiles.find((file) => `oracle/${file.path}` === entry.key) : null;
      writeFile(root, name, redactor.transform(entry.text, entry.kind), originalFile?.mode || oracleFile?.mode || 0o600);
    }
    const contract = JSON.parse(redactor.transform(docs.find((entry) => entry.key === 'contract').text, 'json'));
    const originalHistory = docs.find((entry) => entry.key === 'history.jsonl').text;
    const sanitizedHistory = decode(readRegular(payload, 'history.jsonl').bytes);
    const originalEvidence = await evidence(originalHistory);
    const sanitizedEvidence = await evidence(sanitizedHistory);
    if (json(originalEvidence) !== json(sanitizedEvidence)) fail('DIAGNOSTIC_RELATIONS_CHANGED');
    const originalWork = path.join(captureDirectory, 'workspace');
    const originalOracle = path.join(captureDirectory, 'oracle');
    const sanitizedWork = path.join(payload, 'workspace');
    const sanitizedOracle = path.join(privateDirectory, 'oracle');
    const outcomes = {};
    for (const [label, workspace, oracle, commands] of [
      ['original', originalWork, originalOracle, manifest.oracle], ['sanitized', sanitizedWork, sanitizedOracle, contract],
    ]) {
      const publicResult = isolatedCheck({ image: manifest.oracle.image, workspace, command: commands.publicCommand });
      if (!publicResult.passed || publicResult.infrastructureFailure) fail('PUBLIC_PREFLIGHT_FAILED');
      const initial = isolatedCheck({ image: manifest.oracle.image, workspace, oracle, command: commands.hiddenCommand });
      const initialCases = witness(initial);
      if (initial.passed !== (manifest.oracle.expectedInitial === 'pass')) fail('INITIAL_EXPECTATION_CHANGED');
      const reference = path.join(privateDirectory, `${label}-reference`);
      referenceWorkspace(workspace, oracle, commands.referenceFiles, reference);
      const referencePublic = isolatedCheck({ image: manifest.oracle.image, workspace: reference, command: commands.publicCommand });
      if (!referencePublic.passed || referencePublic.infrastructureFailure) fail('REFERENCE_PUBLIC_FAILED');
      const referenceResult = isolatedCheck({ image: manifest.oracle.image, workspace: reference, oracle, command: commands.hiddenCommand });
      const referenceCases = witness(referenceResult);
      if (!referenceResult.passed || json(referenceCases.map((entry) => entry.id)) !== json(initialCases.map((entry) => entry.id))) fail('REFERENCE_ACCEPTANCE_FAILED');
      outcomes[label] = { initial: initialCases, reference: referenceCases };
      writeFile(privateDirectory, `${label}-checks.json`, json({ publicResult, initial, referencePublic, referenceResult }));
    }
    if (json(outcomes.original) !== json(outcomes.sanitized)) fail('CASE_OUTCOMES_CHANGED');
    const supplements = await contexts(Buffer.from(sanitizedHistory));
    writeFile(payload, 'supplements/mechanical.json', supplements.values.mechanical);
    writeFile(payload, 'supplements/xray.json', supplements.values.xray);
    const inventory = directoryFiles(payload).map((name) => {
      const value = readRegular(payload, name);
      return { path: name, hash: hash(value.bytes), mode: value.mode };
    });
    const texts = [...inventory.flatMap((entry) => [entry.path, decode(readRegular(payload, entry.path).bytes)]), json({ writable: contract.writable, publicCommand: contract.publicCommand })];
    for (const entry of redactor.mapping) if (texts.some((text) => text.includes(entry.original))) fail('KNOWN_LITERAL_REMAINS');
    const finalScan = scan(texts);
    if (finalScan.findings.length) fail('FINAL_SCAN_NOT_CLEAN');
    if (finalScan.version !== redactor.scanner.version || finalScan.configHash !== redactor.scanner.configHash) fail('SCANNER_CHANGED_DURING_REDACTION');
    verifyCapture(captureDirectory);
    if (json(frozenPipeline) !== json(pipelineHashes())) fail('DISCLOSURE_PIPELINE_CHANGED');
    const oracleInventory = directoryFiles(sanitizedOracle).map((name) => {
      const value = readRegular(sanitizedOracle, name);
      return { path: name, hash: hash(value.bytes), mode: value.mode };
    });
    const gate = { schemaVersion: 2, approvedMethod: 'consistent-substitution-with-scanning', status: 'eligible-under-bounded-policy-not-guaranteed-anonymous',
      origin: manifest.origin, inventory, writable: contract.writable, publicCommand: contract.publicCommand,
      image: manifest.oracle.image, hiddenCommand: contract.hiddenCommand, oracleInventory,
      captureHash: hash(fs.readFileSync(path.join(captureDirectory, 'manifest.json'))), pipelineHashes: frozenPipeline,
      mapHash: hash(readRegular(privateDirectory, 'replacement-map.json').bytes), scopeHash: hash(readRegular(privateDirectory, 'scope.json').bytes),
      replacements: redactor.replacements, scanner: { ...redactor.scanner, finalFindings: 0 },
      evidenceHash: hash(json(sanitizedEvidence)), caseOutcomes: outcomes, preprocessing: supplements.preprocessing,
      localPreflightMs: performance.now() - started, createdAt: new Date().toISOString(), localInferenceAllowed: false,
      limits: ['Pattern detection does not recognize all PII, proprietary facts or obfuscated secrets.',
        'Finite frozen acceptance is not full semantic equivalence.', 'Hashes detect drift, not malicious host-owner forgery.',
        'Future tool outputs need the same gate; raw snapshot paths are never remote tool inputs.'] };
    writeFile(privateDirectory, 'gate.json', json(gate));
    writeFile(privateDirectory, 'gate.sha256', hash(json(gate)));
    return { directory, replacements: redactor.replacements, cases: outcomes.original.initial.length, finalFindings: 0, payloadGatePassed: true };
  } catch (error) {
    writeFile(privateDirectory, 'failure.json', json({ reason: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'DISCLOSURE_FAILED' }));
    throw error;
  }
}

function openForArm(directory, arm) {
  if (!['raw', 'mechanical', 'xray'].includes(arm)) fail('UNKNOWN_ARM');
  const privateDirectory = path.join(directory, 'private');
  const rawGate = readRegular(privateDirectory, 'gate.json').bytes;
  if (hash(rawGate) !== readRegular(privateDirectory, 'gate.sha256').bytes.toString()) fail('DISCLOSURE_GATE_CHANGED');
  const gate = JSON.parse(rawGate);
  if (gate.schemaVersion !== 2 || json(gate.pipelineHashes) !== json(pipelineHashes())) fail('DISCLOSURE_PIPELINE_CHANGED');
  const captureDirectory = path.dirname(directory);
  verifyCapture(captureDirectory);
  if (gate.captureHash !== hash(fs.readFileSync(path.join(captureDirectory, 'manifest.json')))) fail('ORIGINAL_CAPTURE_CHANGED');
  const oracle = path.join(privateDirectory, 'oracle');
  if (json(directoryFiles(oracle)) !== json(gate.oracleInventory.map((entry) => entry.path))) fail('SANITIZED_ORACLE_CHANGED');
  for (const entry of gate.oracleInventory) {
    const value = readRegular(oracle, entry.path);
    if (hash(value.bytes) !== entry.hash || value.mode !== entry.mode) fail('SANITIZED_ORACLE_CHANGED');
  }
  const payload = path.join(directory, 'payload');
  if (json(directoryFiles(payload)) !== json(gate.inventory.map((entry) => entry.path))) fail('OUTWARD_FILE_SET_CHANGED');
  const contents = Object.create(null);
  for (const entry of gate.inventory) {
    const value = readRegular(payload, entry.path);
    if (hash(value.bytes) !== entry.hash || value.mode !== entry.mode) fail('OUTWARD_BYTES_CHANGED');
    contents[entry.path] = decode(value.bytes);
  }
  const mapBytes = readRegular(privateDirectory, 'replacement-map.json').bytes;
  if (hash(mapBytes) !== gate.mapHash || hash(readRegular(privateDirectory, 'scope.json').bytes) !== gate.scopeHash) fail('PRIVATE_DISCLOSURE_RECORD_CHANGED');
  const mapping = JSON.parse(mapBytes);
  const texts = [...Object.entries(contents).flat(), json({ writable: gate.writable, publicCommand: gate.publicCommand })];
  for (const entry of mapping) if (texts.some((text) => text.includes(entry.original))) fail('KNOWN_LITERAL_REMAINS');
  const residual = new Set();
  texts.forEach((text) => discover(text, (value) => { if (!/^AXR_REDACTED_[0-9]{6}$/.test(value)) residual.add(value); }));
  const scanned = scan(texts);
  if (scanned.version !== gate.scanner.version || scanned.configHash !== gate.scanner.configHash) fail('SCANNER_VERSION_CHANGED');
  if (residual.size || scanned.findings.length) fail('OUTWARD_SCAN_NOT_CLEAN');
  return { task: contents['task.txt'], history: contents['history.jsonl'],
    workspace: Object.fromEntries(Object.entries(contents).filter(([name]) => name.startsWith('workspace/')).map(([name, value]) => [name.slice(10), value])),
    supplement: arm === 'raw' ? null : contents[`supplements/${arm}.json`],
    modes: Object.fromEntries(gate.inventory.filter((entry) => entry.path.startsWith('workspace/')).map((entry) => [entry.path.slice(10), entry.mode])),
    writable: gate.writable, publicCommand: gate.publicCommand, image: gate.image };
}

function guardToolResponse(directory, text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) fail('TOOL_RESPONSE_LIMIT');
  openForArm(directory, 'raw');
  const mapping = JSON.parse(readRegular(path.join(directory, 'private'), 'replacement-map.json').bytes);
  if (mapping.some((entry) => text.includes(entry.original))) fail('TOOL_RESPONSE_CONTAINS_ORIGINAL');
  const found = new Set();
  discover(text, (value) => { if (!/^AXR_REDACTED_[0-9]{6}$/.test(value)) found.add(value); });
  if (found.size || scan([text]).findings.length) fail('TOOL_RESPONSE_NOT_CLEAN');
  return text;
}

module.exports = { disclose, openForArm, guardToolResponse, witness };
