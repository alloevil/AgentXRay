import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { capture, hash } = require('./capture.cjs');
export function registerCapture(pi, repository, output) {
  let active;
  pi.on('before_agent_start', async (event, context) => {
    active = undefined;
    let scoped = false;
    try {
      if (fs.realpathSync(context.cwd) !== repository) return;
      scoped = true;
      const configFile = path.join(output, 'config.json');
      if (!fs.existsSync(configFile)) return;
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.enabled !== true) return;
      if (event.images?.length) throw Object.assign(new Error('IMAGES_NOT_CAPTURED'), { code: 'IMAGES_NOT_CAPTURED' });
      const contract = config.contracts?.[hash(event.prompt)];
      const history = `${context.sessionManager.getBranch().map((entry) => JSON.stringify(entry)).join('\n')}\n`;
      const result = capture({ repo: repository, output, prompt: event.prompt, history,
        sessionId: context.sessionManager.getSessionId(), contract,
        origin: config.infrastructureProbe === true ? 'infrastructure-check' : 'omp-before-agent-start' });
      active = result.manifest.id;
    } catch (error) {
      if (scoped && !error.receipted) {
        try {
          fs.appendFileSync(path.join(output, 'intake.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), state: 'excluded', reason: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'HOOK_CAPTURE_FAILED' })}\n`, { mode: 0o600 });
        } catch {}
      }
      try {
        if (context.hasUI) context.ui.notify('AgentXRay snapshot unavailable; normal work continues. See local intake receipts.', 'warning');
      } catch {}
    }
  });
  pi.on('agent_end', async () => {
    if (!active) return;
    try {
      fs.appendFileSync(path.join(output, 'observations.jsonl'), `${JSON.stringify({ id: active, at: new Date().toISOString(), observation: 'original-agent-ended-not-task-acceptance' })}\n`, { mode: 0o600 });
    } catch {}
    active = undefined;
  });
}

export default function (pi) {
  const repository = fs.realpathSync(path.resolve(import.meta.dirname, '../..'));
  registerCapture(pi, repository, path.join(repository, 'output/prospective-study'));
}
