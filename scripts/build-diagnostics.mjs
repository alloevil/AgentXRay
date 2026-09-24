import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { buildSync } = createRequire(path.join(root, 'frontend/package.json'))('esbuild');
const input = path.join(root, 'frontend/src/views/sessions/diagnostics.ts');
const output = path.join(root, 'lib/generated/diagnostics.cjs');
const result = buildSync({
  entryPoints: [input],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  charset: 'utf8',
  legalComments: 'none',
  minify: true,
});
const digest = createHash('sha256').update(readFileSync(input)).digest('hex');
const content = `${result.outputFiles[0].text}\nmodule.exports.rulesSha256 = ${JSON.stringify(digest)};\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== content) {
    console.error('Diagnostic bundle drift: run npm run build:diagnostics');
    process.exitCode = 1;
  } else console.log('PASS: CLI diagnostic bundle matches UI rule source');
} else {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, content);
  console.log('wrote lib/generated/diagnostics.cjs');
}
