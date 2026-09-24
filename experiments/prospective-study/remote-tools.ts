import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBench } = require('./remote-workspace.cjs');

export default function (pi) {
  const schema = pi.zod;
  const spec = JSON.parse(fs.readFileSync(process.env.AXR_REMOTE_SPEC!, 'utf8'));
  const bench = createBench(spec);
  pi.on('session_start', async () => {
    await pi.setActiveTools(['bench']);
    fs.appendFileSync(spec.receipt, `${JSON.stringify({ type: 'active-tools', tools: pi.getActiveTools() })}\n`, { mode: 0o600 });
  });
  pi.registerTool({
    name: 'bench', label: 'Isolated task workspace',
    description: 'List/read allowlisted files; read @history; write only declared writable files; run fixed public tests; finish done or blocked. No shell, network, oracle or other paths. Maximum 40 calls. Read offsets/limits are characters; maximum limit 16384.',
    parameters: schema.object({ action: schema.enum(['list', 'read', 'write', 'test', 'finish']), file: schema.string().optional(),
      content: schema.string().optional(), offset: schema.number().optional(), limit: schema.number().optional(),
      status: schema.enum(['done', 'blocked']).optional() }),
    async execute(_id, params, _onUpdate, context) { return bench.execute(params, context); },
  });
}
