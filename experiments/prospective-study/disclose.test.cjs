const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capture, hash } = require('./capture.cjs');
const { decode, makeRedactor, scan } = require('./redact.cjs');
const { disclose, openForArm, guardToolResponse, witness } = require('./disclose.cjs');

const image = process.env.AXR_TEST_IMAGE;
const email = 'synthetic.person@private.invalid';

function fixture(context) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-disclosure-test-'));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repo');
  const oracleDirectory = path.join(temporary, 'oracle');
  fs.mkdirSync(repo); fs.mkdirSync(oracleDirectory); fs.mkdirSync(path.join(oracleDirectory, 'reference'));
  const source = `module.exports = {run: value => value - 1, contact: ${JSON.stringify(email)}};\n`;
  fs.writeFileSync(path.join(repo, '.gitignore'), 'output/\n');
  fs.writeFileSync(path.join(repo, 'index.cjs'), source);
  fs.writeFileSync(path.join(repo, 'public.cjs'), 'require("node:assert/strict").equal(typeof require("./index.cjs").run,"function");\n');
  fs.writeFileSync(path.join(repo, 'unrelated-private.txt'), 'This unrelated file must never enter the payload.');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Infrastructure Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic fixture']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  }
  fs.writeFileSync(path.join(oracleDirectory, 'reference/index.cjs'), source.replace('value - 1', 'value + 1'));
  fs.writeFileSync(path.join(oracleDirectory, 'accept.cjs'), `const solve=require('/work/index.cjs'); const cases=[{id:'positive',passed:solve.run(1)===2},{id:'negative',passed:solve.run(-1)===0},{id:'contact',passed:solve.contact===${JSON.stringify(email)}}]; console.log(JSON.stringify({schemaVersion:1,cases}));process.exitCode=cases.every(entry=>entry.passed)?0:1;\n`);
  const rows = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Synthetic request for ${email}, server 10.1.2.3.` }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'synthetic-call', name: 'bash', arguments: { command: 'npm test', cwd: '/home/synthetic/project' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'synthetic-call', toolName: 'bash', isError: true, content: [{ type: 'text', text: `Synthetic failure for ${email}` }] } },
  ];
  const contract = { provenance: 'independent-task-specific', expectedInitial: 'fail', image: image || `sha256:${'0'.repeat(64)}`,
    publicCommand: ['node', 'public.cjs'], hiddenCommand: ['node', '/oracle/accept.cjs'], writable: ['index.cjs'],
    oracleDirectory, referenceFiles: [{ from: 'reference/index.cjs', to: 'index.cjs' }] };
  const options = { repo, output: path.join(repo, 'output/prospective-study'), prompt: `Synthetic increment task for ${email}.`,
    history: rows.map(JSON.stringify).join('\n') + '\n', origin: 'synthetic-smoke', contract };
  return { repo, oracleDirectory, options, scope: { files: ['index.cjs', 'public.cjs'], rationale: 'Synthetic increment module and fixed public check.' } };
}

test('consistent replacements preserve JSON types, nested arguments, IDs and distinctions', () => {
  const entry = { id: 'call-1', count: 2, failed: false, arguments: JSON.stringify({ email, password: 'synthetic-secret-2026' }),
    nested: { email, other: 'different.person@private.invalid' } };
  const result = makeRedactor([{ kind: 'jsonl', text: JSON.stringify(entry) + '\n' }, { kind: 'text', text: `${email} synthetic-secret-2026` }]);
  const transformed = JSON.parse(result.transformed[0].text);
  assert.equal(transformed.id, entry.id); assert.equal(transformed.count, 2); assert.equal(transformed.failed, false);
  assert.equal(JSON.parse(transformed.arguments).email, transformed.nested.email);
  assert.notEqual(transformed.nested.email, transformed.nested.other);
  assert.ok(result.transformed[1].text.includes(transformed.nested.email));
  assert.ok(!JSON.stringify(result.transformed).includes(email));
});

test('credential scanner cannot be disabled by ambient config or allow comments', (context) => {
  const previous = process.env.GITLEAKS_CONFIG;
  process.env.GITLEAKS_CONFIG = '/nonexistent/input-controlled-config';
  context.after(() => { if (previous === undefined) delete process.env.GITLEAKS_CONFIG; else process.env.GITLEAKS_CONFIG = previous; });
  const fake = 'ghp_' + 'Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9Wx8';
  const result = makeRedactor([{ kind: 'text', text: `const credential = "${fake}"; // gitleaks:allow` }]);
  assert.ok(result.scanner.initialFindings >= 1);
  assert.equal(result.scanner.residualFindings, 0);
  assert.ok(!result.transformed[0].text.includes(fake));
});

test('missing scanner, unsupported media, binary and opaque encoding fail closed', (context) => {
  assert.throws(() => decode(Buffer.from([255])), /NON_UTF8_DISCLOSURE/);
  assert.throws(() => decode(Buffer.from('a\0b')), /BINARY_DISCLOSURE/);
  assert.throws(() => makeRedactor([{ kind: 'json', text: JSON.stringify({ type: 'image', data: 'opaque' }) }]), /UNSUPPORTED_MEDIA/);
  assert.throws(() => makeRedactor([{ kind: 'text', text: 'A'.repeat(300) }]), /UNSUPPORTED_ENCODED_CONTENT/);
  assert.throws(() => makeRedactor([{ kind: 'text', text: 'AXR_REDACTED_000001' }]), /RESERVED_PLACEHOLDER_PRESENT/);
  const previous = process.env.PATH;
  process.env.PATH = '/nonexistent';
  context.after(() => { process.env.PATH = previous; });
  assert.throws(() => scan(['not a secret']), /SCANNER_UNAVAILABLE/);
});

test('private paths, URLs, addresses and caller-identified terms are replaced', () => {
  const literals = ['/home/synthetic/private.txt', '10.1.2.3', '192.168.4.5', 'fd00::1234', 'service.corp', 'https://internal.invalid/private', 'PrivateCustomerName'];
  const result = makeRedactor([{ kind: 'text', text: literals.join(' ') }], ['PrivateCustomerName']);
  for (const literal of literals) assert.ok(!result.transformed[0].text.includes(literal));
  assert.ok(result.mapping.find((entry) => entry.original === literals[0]).replacement.startsWith('/'));
  assert.equal(result.replacements, literals.length);
});

test('aggregate success or unstructured output is not an acceptance witness', () => {
  assert.throws(() => witness({ passed: true, stdout: 'PASS' }), /CASE_LEVEL_WITNESS_REQUIRED/);
  assert.throws(() => witness({ passed: true, stdout: JSON.stringify({ schemaVersion: 1, cases: [{ id: 'one', passed: false }] }) }), /WITNESS_EXIT_MISMATCH/);
  assert.throws(() => witness({ passed: true, stdout: JSON.stringify({ schemaVersion: 1, cases: [{ id: 'one', passed: true }, { id: 'one', passed: true }] }) }), /INVALID_CASE_WITNESS/);
});

test('structured personal identifiers and common identity formats are removed without changing numeric types', () => {
  const personal = { full_name: 'Synthetic Person', phone: '13900001234', national_id: '110101199001010019' };
  const result = makeRedactor([{ kind: 'json', text: JSON.stringify(personal) }, { kind: 'text', text: '13900001234 110101199001010019 123-45-6789' }]);
  for (const value of Object.values(personal)) assert.ok(!JSON.stringify(result.transformed).includes(value));
  assert.ok(!result.transformed[1].text.includes('123-45-6789'));
  assert.throws(() => makeRedactor([{ kind: 'json', text: JSON.stringify({ phone: 13900001234 }) }]), /UNSUPPORTED_CREDENTIAL_TYPE/);
});

test('masking a command that changes diagnostic relationships rejects the sample', async (context) => {
  const value = fixture(context);
  const snapshot = capture(value.options);
  await assert.rejects(disclose(snapshot.directory, { ...value.scope, privateTerms: ['npm test'] }), /DIAGNOSTIC_RELATIONS_CHANGED/);
});

test('Docker: only a scoped sanitized payload leaves the gate; three arms share its bytes', { skip: !image }, async (context) => {
  const value = fixture(context);
  const snapshot = capture(value.options);
  const original = hash(fs.readFileSync(path.join(snapshot.directory, 'workspace/index.cjs')));
  const result = await disclose(snapshot.directory, value.scope);
  assert.equal(result.payloadGatePassed, true);
  assert.equal(result.cases, 3);
  const raw = openForArm(result.directory, 'raw');
  const mechanical = openForArm(result.directory, 'mechanical');
  const xray = openForArm(result.directory, 'xray');
  assert.deepEqual(raw.workspace, mechanical.workspace); assert.deepEqual(raw.workspace, xray.workspace);
  assert.equal(raw.history, xray.history); assert.equal(raw.history, mechanical.history);
  assert.equal(raw.supplement, null); assert.notEqual(mechanical.supplement, xray.supplement);
  assert.deepEqual(Object.keys(raw.workspace).sort(), ['index.cjs', 'public.cjs']);
  assert.ok(!JSON.stringify(xray).includes(email));
  assert.ok(!JSON.stringify(xray).includes('replacement-map'));
  assert.ok(!JSON.stringify(xray).includes('accept.cjs'));
  assert.ok(!JSON.stringify(xray).includes('reference/index.cjs'));
  assert.equal(hash(fs.readFileSync(path.join(snapshot.directory, 'workspace/index.cjs'))), original);
  const gate = JSON.parse(fs.readFileSync(path.join(result.directory, 'private/gate.json')));
  assert.deepEqual(gate.caseOutcomes.original.initial.map((entry) => entry.passed), [false, false, true]);
  assert.deepEqual(gate.caseOutcomes.sanitized.reference.map((entry) => entry.passed), [true, true, true]);
  assert.equal(guardToolResponse(result.directory, 'Public checks passed.'), 'Public checks passed.');
  assert.throws(() => guardToolResponse(result.directory, email), /TOOL_RESPONSE_CONTAINS_ORIGINAL/);
  assert.throws(() => guardToolResponse(result.directory, 'new.person@another.invalid'), /TOOL_RESPONSE_NOT_CLEAN/);
  fs.writeFileSync(path.join(result.directory, 'payload/extra.txt'), 'not in sealed inventory');
  assert.throws(() => openForArm(result.directory, 'raw'), /OUTWARD_FILE_SET_CHANGED/);
  fs.unlinkSync(path.join(result.directory, 'payload/extra.txt'));
  fs.appendFileSync(path.join(result.directory, 'payload/workspace/index.cjs'), '\n');
  assert.throws(() => openForArm(result.directory, 'raw'), /OUTWARD_BYTES_CHANGED/);
});

test('Docker: equal failure totals do not hide changed individual acceptance outcomes', { skip: !image }, async (context) => {
  const value = fixture(context);
  fs.writeFileSync(path.join(value.repo, 'index.cjs'), `const originalShape=${JSON.stringify(email)}.includes('@');module.exports={one:!originalShape,two:originalShape};\n`);
  fs.writeFileSync(path.join(value.repo, 'public.cjs'), 'require("node:assert/strict").equal(typeof require("./index.cjs").one,"boolean");\n');
  fs.writeFileSync(path.join(value.oracleDirectory, 'reference/index.cjs'), 'module.exports={one:true,two:true};\n');
  fs.writeFileSync(path.join(value.oracleDirectory, 'accept.cjs'), 'const solve=require("/work/index.cjs");const cases=[{id:"one",passed:solve.one},{id:"two",passed:solve.two}];console.log(JSON.stringify({schemaVersion:1,cases}));process.exitCode=cases.every(entry=>entry.passed)?0:1;\n');
  const snapshot = capture(value.options);
  await assert.rejects(disclose(snapshot.directory, value.scope), /CASE_OUTCOMES_CHANGED/);
  assert.ok(!fs.existsSync(path.join(snapshot.directory, 'disclosure/private/gate.json')));
});

test('Docker: independent reference must pass before a sample can be disclosed', { skip: !image }, async (context) => {
  const value = fixture(context);
  fs.writeFileSync(path.join(value.oracleDirectory, 'reference/index.cjs'), fs.readFileSync(path.join(value.repo, 'index.cjs')));
  const snapshot = capture(value.options);
  await assert.rejects(disclose(snapshot.directory, value.scope), /REFERENCE_ACCEPTANCE_FAILED/);
});
