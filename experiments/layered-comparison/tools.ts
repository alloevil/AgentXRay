import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBench } = require('./bench.cjs');

export default function (pi) {
  const schema = pi.zod;
  const spec = JSON.parse(fs.readFileSync(process.env.AXR_LAYERED_SPEC!, 'utf8'));
  const bench = createBench(spec);
  pi.on('session_start', async () => {
    await pi.setActiveTools(['bench']);
    fs.appendFileSync(spec.receipt, `${JSON.stringify({ type: 'active-tools', tools: pi.getActiveTools() })}\n`, { mode: 0o600 });
  });
  pi.registerTool({
    name: 'bench', label: 'Fixed task workspace and evidence CLI',
    description: 'read solution.js/public-tests.json/session.jsonl; write only solution.js up to 12000 bytes; test fixed public cases; inspect with view full or summary; evidence with source sha256 and one-based physical line plus optional byte offset/maxBytes (4..16384, default 4096); finish done or blocked. Inspect/evidence run the real offline CLI on immutable synthetic session.jsonl. Evidence returns raw source, truncation and nextOffset. No shell, network or other paths. 12 calls total.',
    parameters: schema.object({ action: schema.enum(['read', 'write', 'test', 'inspect', 'evidence', 'finish']),
      file: schema.string().optional(), content: schema.string().optional(), view: schema.enum(['full', 'summary']).optional(),
      sha256: schema.string().optional(), line: schema.number().optional(), offset: schema.number().optional(), maxBytes: schema.number().optional(),
      status: schema.enum(['done', 'blocked']).optional() }),
    async execute(_id, params, _onUpdate, context) { return bench.execute(params, context); },
  });
}
