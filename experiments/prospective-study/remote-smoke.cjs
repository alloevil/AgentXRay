const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capture, json, fail } = require('./capture.cjs');
const { disclose } = require('./disclose.cjs');

async function createSmoke(directory, image) {
  directory = path.resolve(directory);
  if (fs.existsSync(directory)) fail('SMOKE_DESTINATION_EXISTS');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const repo = path.join(directory, 'repo');
  const oracle = path.join(directory, 'oracle');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(oracle, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'output/\n');
  fs.writeFileSync(path.join(repo, 'src/tax.cjs'), 'module.exports = (subtotal, basisPoints) => Math.floor(subtotal * basisPoints / 10000);\n');
  fs.writeFileSync(path.join(repo, 'src/cart.cjs'), 'const tax = require("./tax.cjs");\nmodule.exports = ({lines, taxBps}) => { const subtotal = lines.reduce((total, line) => total + line.quantity * line.unitCents, 0); return subtotal + tax(subtotal, taxBps); };\n');
  fs.writeFileSync(path.join(repo, 'public.cjs'), 'const assert=require("node:assert/strict"); const solve=require("./src/cart.cjs"); assert.equal(solve({lines:[{quantity:2,unitCents:1000}],taxBps:500}),2100); console.log("PUBLIC_PASS");\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Infrastructure Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic remote fixture']]) {
    const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    if (result.status !== 0) fail('SMOKE_GIT_SETUP_FAILED');
  }
  fs.writeFileSync(path.join(oracle, 'reference/tax.cjs'), 'module.exports = (subtotal, basisPoints) => Math.round(subtotal * basisPoints / 10000);\n');
  fs.writeFileSync(path.join(oracle, 'accept.cjs'), `let solve;try{solve=require('/work/src/cart.cjs');}catch{}
const check=(id,run)=>{let passed=false;try{passed=run()===true;}catch{}return {id,passed};};
const cases=[check('fraction',()=>solve({lines:[{quantity:1,unitCents:199}],taxBps:750})===214),check('half',()=>solve({lines:[{quantity:3,unitCents:1}],taxBps:5000})===5),check('aggregate',()=>solve({lines:[{quantity:1,unitCents:1},{quantity:1,unitCents:1}],taxBps:5000})===3),check('empty',()=>solve({lines:[],taxBps:750})===0)];
console.log(JSON.stringify({schemaVersion:1,cases}));process.exitCode=cases.every(entry=>entry.passed)?0:1;\n`);
  const rows = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Synthetic infrastructure history for smoke.user@example.invalid. Current task requirements take priority.' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'smoke-test', name: 'bash', arguments: { command: 'npm test', cwd: '/home/synthetic/project' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'smoke-test', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'A public test subset passed before the later modification.' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'smoke-edit', name: 'edit', arguments: { path: '/home/synthetic/project/src/tax.cjs', cwd: '/home/synthetic/project', oldText: 'Math.round', newText: 'Math.floor' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'smoke-edit', toolName: 'edit', isError: false, content: [{ type: 'text', text: 'Modification completed. No later check is recorded in this synthetic history.' }] } },
  ];
  const contract = { provenance: 'independent-task-specific', expectedInitial: 'fail', image,
    publicCommand: ['node', 'public.cjs'], hiddenCommand: ['node', '/oracle/accept.cjs'], writable: ['src/tax.cjs'],
    oracleDirectory: oracle, referenceFiles: [{ from: 'reference/tax.cjs', to: 'src/tax.cjs' }] };
  const result = capture({ repo, output: path.join(repo, 'output/prospective-study'), origin: 'synthetic-smoke', contract,
    prompt: 'Synthetic infrastructure task, not a real-world benchmark. Complete the existing cart implementation. Each line has a nonnegative integer quantity and unitCents. Sum line totals, apply taxBps once to the subtotal, round the resulting tax to the nearest integer with Math.round, then return subtotal plus tax. Do not round per line. An empty basket returns zero. Change only src/tax.cjs; retain the existing module API and do not modify tests.',
    history: rows.map(JSON.stringify).join('\n') + '\n' });
  const prepared = await disclose(result.directory, { files: ['src/cart.cjs', 'src/tax.cjs', 'public.cjs'], rationale: 'Synthetic multi-file tax-repair smoke; no private owner data.' });
  fs.writeFileSync(path.join(directory, 'receipt.json'), json({ kind: 'synthetic-infrastructure-only', disclosure: prepared.directory, capture: result.directory, realTasks: 0 }), { mode: 0o600 });
  return prepared.directory;
}

module.exports = { createSmoke };
if (require.main === module) createSmoke(process.argv[2], process.argv[3]).then((directory) => console.log(json({ disclosure: directory, kind: 'synthetic-infrastructure-only' })))
  .catch((error) => { console.error(/^[A-Z_]+$/.test(error.code || '') ? error.code : 'SMOKE_SETUP_FAILED'); process.exitCode = 1; });
