import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export default function (pi) {
  const z = pi.zod;
  const work = process.env.AXR_TRIAL_WORK!;
  const receipt = process.env.AXR_TRIAL_RECEIPT!;
  const evaluator = process.env.AXR_TRIAL_EVALUATOR!;
  let calls = 0;
  let finished = false;
  const append = (value) => fs.appendFileSync(receipt, `${JSON.stringify(value)}\n`);
  const names = ['solution.js', 'public-tests.json', 'session.jsonl'];
  pi.on('session_start', async () => {
    await pi.setActiveTools(['bench']);
    append({ type: 'active-tools', tools: pi.getActiveTools() });
  });
  pi.registerTool({
    name: 'bench', label: 'Isolated benchmark workspace',
    description: 'Read solution.js, public-tests.json or session.jsonl; write only solution.js; run fixed public tests; finish with status done or blocked. Maximum 12 calls total. No shell/network/other paths.',
    parameters: z.object({ action: z.enum(['read', 'write', 'test', 'finish']), file: z.string().optional(), content: z.string().optional(), status: z.enum(['done', 'blocked']).optional(), summary: z.string().optional() }),
    async execute(_id, params, _onUpdate, context) {
      calls++;
      if (finished || calls > 12) {
        append({ type: 'budget-stop', calls });
        context.abort();
        return { isError: true, content: [{ type: 'text', text: 'Tool budget exhausted or already finished.' }] };
      }
      const start = performance.now();
      let output;
      let ok = true;
      if (params.action === 'read') {
        if (!names.includes(params.file)) { ok = false; output = { error: 'File not available. Only allowlisted files can be read.' }; }
        else output = { file: params.file, content: fs.readFileSync(path.join(work, params.file), 'utf8') };
      } else if (params.action === 'write') {
        if (params.file !== 'solution.js' || typeof params.content !== 'string' || Buffer.byteLength(params.content) > 12000) { ok = false; output = { error: 'Only solution.js up to 12000 bytes may be written.' }; }
        else { fs.writeFileSync(path.join(work, 'solution.js'), params.content); output = { written: 'solution.js' }; }
      } else if (params.action === 'test') {
        const execution = spawnSync(process.execPath.includes('bun') ? process.env.AXR_NODE! : process.execPath,
          ['--permission', `--allow-fs-read=${evaluator}`, '--max-old-space-size=64', evaluator], {
            input: JSON.stringify({ source: fs.readFileSync(path.join(work, 'solution.js'), 'utf8'), cases: JSON.parse(fs.readFileSync(path.join(work, 'public-tests.json'), 'utf8')) }),
            encoding: 'utf8', timeout: 4000, maxBuffer: 100000, env: { PATH: process.env.PATH },
          });
        try { output = JSON.parse(execution.stdout); ok = output.passed; } catch { ok = false; output = { passed: false, error: 'Public test runner failed or timed out.' }; }
      } else {
        if (!params.status) { ok = false; output = { error: 'finish requires status done or blocked.' }; }
        else { finished = true; append({ type: 'finish', status: params.status, summary: params.summary || '' }); output = { recorded: params.status, instruction: 'Now return a concise final answer. Do not call more tools.' }; }
      }
      const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(work, 'solution.js'))).digest('hex');
      const semanticInput = [params.action, params.file || null, params.content ?? null, params.status ?? null, sourceHash];
      append({ type: 'tool', call: calls, action: params.action, file: params.file || null,
        inputHash: createHash('sha256').update(JSON.stringify(semanticInput)).digest('hex'), ok,
        sourceHash,
        elapsedMs: performance.now() - start });
      return { isError: !ok, content: [{ type: 'text', text: JSON.stringify(output) }] };
    },
  });
}
