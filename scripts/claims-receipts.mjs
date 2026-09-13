#!/usr/bin/env node

// Receipts behind claims.json: the command that recomputes each number the
// README / hero caption / roadmap publishes. One subcommand per claim, each
// printing exactly one line; claims.json asserts that line and
// .github/workflows/claims.yml runs them all.
//
//   node scripts/claims-receipts.mjs <receipt-id>
//   node scripts/claims-receipts.mjs --list
//
// Every figure is derived here from committed artifacts — the platform
// registry, lib/config.js, package.json, the workflow, the synthetic demo
// sample log, the test fixtures — never typed in as a constant. The one receipt
// that needs the platform directories pointed somewhere safe (backup) re-runs
// this file in a child process with HOME aimed at a throwaway copy of
// test/fixtures/home, so no real session log is ever read or written.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, 'package.json'));
const SELF = fileURLToPath(import.meta.url);
const README = 'README.md';
const README_ZH = 'README.zh-CN.md';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const fromRepo = (rel) => require(path.join(ROOT, rel));
// The ledger column the UI renders uses the view's toLocaleString(); pin the
// locale so the receipt reads the same on a runner with no LANG set.
const formatNumber = (n) => n.toLocaleString('en-US');

const platforms = () => fromRepo('lib/platforms/index.js').PLATFORMS;

// Rows of the first markdown table under `heading`, header row dropped.
function tableRows(md, heading) {
  const start = md.indexOf(heading);
  const end = md.indexOf('\n---', start);
  return md
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
    .slice(1);
}

// Top-level keys of a YAML block (`jobs:`, `on:` …); a key is a 2-space-indented
// line, its 4-space-indented children are skipped.
function blockKeys(yaml, anchor) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(anchor);
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^ {4}/.test(line)) continue; // nested under the key above
    const match = line.match(/^ {2}([a-z][\w-]*):/);
    if (!match) break; // dedented back out of the block
    keys.push(match[1]);
  }
  return keys;
}

function toolCallNames(messages) {
  const names = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && (part.type === 'toolCall' || part.type === 'tool_use')) names.push(part.name || part.toolName);
    }
  }
  return names;
}

const clock = (timestamp) => new Date(timestamp).toISOString().slice(11, 19);

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const receipts = {
  // README: "supports OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek
  // Harness and Gemini CLI" / "normalizes all seven formats".
  'platform-registry': () => {
    const ids = Object.keys(platforms());
    return `${ids.length} platforms: ${ids.join(', ')}`;
  },

  // README FAQ: "Six of them store JSONL; Hermes stores SQLite".
  'platform-storage': () => {
    const all = platforms();
    const ids = Object.keys(all);
    const sqlite = ids.filter((id) => !all[id].parse);
    return `${ids.length - sqlite.length} JSONL-backed, ${sqlite.length} SQLite-only (${sqlite.join(', ')})`;
  },

  // The prose lists the platforms by hand; the registry is the authority.
  'readme-platform-list': () => {
    const labels = Object.values(platforms()).map((platform) => platform.label);
    const found = (rel) => labels.filter((label) => read(rel).includes(label)).length;
    const rows = tableRows(read(README), '## Supported Log Formats').length;
    const missing = labels.filter((label) => !read(README).includes(label));
    return `${found(README)}/${labels.length} labels in ${README} (${rows} format-table rows${missing.length ? `, missing ${missing.join(', ')}` : ''}) · ${found(README_ZH)}/${labels.length} in ${README_ZH}`;
  },

  // README "Default directories" table vs the dirs the code actually resolves.
  'default-dirs': () => {
    const home = fromRepo('lib/config.js').HOME;
    const all = platforms();
    const rows = Object.keys(all).map((id) => `~/${path.relative(home, all[id].defaultDir())}`);
    const missing = rows.filter((row) => !read(README).includes(row));
    if (missing.length) return `default dirs missing from ${README}: ${missing.join(', ')}`;
    return `${rows.length}/${rows.length} default dirs match ${README} (${rows.join(' ')})`;
  },

  // Hero figure caption: the numbers printed over the ledger strip in
  // assets/readme/hero.svg and in the README alt text.
  'hero-ledger': async () => {
    const pure = fromRepo('public/js/pure.js');
    const file = 'frontend/demo/sample-logs/claude/-demo-webapp/synthetic-feature-dark-mode.jsonl';
    const { session, messages } = await fromRepo('lib/platforms/claude.js').parseClaudeCodeSessionFile(
      path.join(ROOT, file)
    );
    const ledger = pure.buildTurnLedger(messages);
    const row = ledger.rows[0];
    const tokens = formatNumber(ledger.totals.tokens);
    const stamps = messages
      .map((message) => message.timestamp)
      .filter(Boolean)
      .sort();
    const svg = read('assets/readme/hero.svg');
    const agrees = svg.includes(pure.formatDurationCompact(row.durationMs)) && svg.includes(`${tokens} tok`);
    return [
      `${ledger.rows.length} turn`,
      pure.formatDurationCompact(row.durationMs),
      `${tokens} tok`,
      ledger.hasCost ? `cost ${pure.formatCost(ledger.totals.cost)}` : 'cost not reported',
      `${row.toolCalls} tool calls (${toolCallNames(messages).join(', ')})`,
      `${row.toolErrors} errors`,
      `${clock(stamps[0])}→${clock(stamps.at(-1))}`,
      session.cwd,
      `hero.svg ${agrees ? 'agrees' : 'DISAGREES'}`,
    ].join(' · ');
  },

  // README "Per-turn ledger": one row per user turn, wall-clock time, tokens =
  // input + output + cache read + cache write, cost only when reported.
  'ledger-fields': async () => {
    const pure = fromRepo('public/js/pure.js');
    const cases = [
      [
        'dsh',
        'lib/platforms/dsh.js',
        'parseDshSessionFile',
        'test/fixtures/home/.dsh/sessions/--fixtures-project-delta--/dsh-fixture-session-0001/session.jsonl',
      ],
      [
        'omp',
        'lib/platforms/omp.js',
        'parseOmpSessionFile',
        'test/fixtures/home/.omp/agent/sessions/-fixtures-project-gamma/2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl',
      ],
    ];
    const parts = [];
    for (const [name, module, fn, file] of cases) {
      const { messages } = await fromRepo(module)[fn](path.join(ROOT, file));
      const ledger = pure.buildTurnLedger(messages);
      const row = ledger.rows[0];
      const sum = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      parts.push(
        `${name}: ${ledger.rows.length} row, ${formatNumber(sum)} tok = ${row.inputTokens} in + ${row.outputTokens} out + ${row.cacheReadTokens} cache read + ${row.cacheWriteTokens} cache write` +
          `, ${ledger.hasCost ? `cost ${pure.formatCost(row.cost)} reported` : 'cost not reported'}, ${plural(row.toolCalls, 'tool call')}, ${plural(row.toolErrors, 'error')}`
      );
    }
    return parts.join(' · ');
  },

  // README Development: "CI (.github/workflows/test.yml) runs on Node 22 for
  // every push and pull request to master, in four steps".
  'ci-test-workflow': () => {
    const yaml = read('.github/workflows/test.yml');
    const jobs = blockKeys(yaml, 'jobs:');
    const triggers = blockKeys(yaml, 'on:');
    const runs = [...yaml.matchAll(/^\s*- run: (.*)$/gm)].map((match) => match[1].split(' #')[0].trim());
    const node = yaml.match(/node-version: '?([\d.x]+)'?/)[1];
    const branches = [...new Set([...yaml.matchAll(/branches: \[([^\]]*)\]/g)].map((match) => match[1]))];
    return `${jobs.length} job (${jobs.join(', ')}) on Node ${node} · ${runs.length} steps: ${runs.join(' | ')} · on ${triggers.join(', ')} of ${branches.join('/')}`;
  },

  // README Features: "Incremental archive of your Codex, Claude Code, OMP,
  // DeepSeek Harness and Gemini CLI session logs ... (Hermes and OpenClaw are
  // not archived)"; "unchanged files are skipped".
  'backup-platforms': () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agentxray-claims-'));
    try {
      const home = path.join(tmp, 'home');
      cpSync(path.join(ROOT, 'test', 'fixtures', 'home'), home, { recursive: true });
      const run = () =>
        JSON.parse(
          execFileSync(process.execPath, [SELF, '--backup-run'], {
            env: { ...process.env, HOME: home, AGENTXRAY_ARCHIVE_DIR: path.join(tmp, 'archive') },
            encoding: 'utf8',
          })
        );
      const first = run();
      const second = run();
      const archived = Object.keys(first.byPlatform);
      const excluded = Object.keys(platforms()).filter((id) => !archived.includes(id));
      return (
        `archive: ${archived.length} platforms (${archived.join(', ')}) · excluded: ${excluded.join(', ')}` +
        ` · first run ${first.copied} copied / ${first.skipped} skipped of ${first.total}` +
        ` · re-run ${second.copied} copied / ${second.skipped} skipped`
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },

  // README Install: "npx @alloevil/agent-xray".
  'install-command': () => {
    const { name, bin } = readJson('package.json');
    const listed = read(README).includes(`npx ${name}`);
    return `${name} · bins: ${Object.keys(bin).join(', ')} · ${README} npx line ${listed ? 'present' : 'MISSING'}`;
  },

  // README Install: "default http://localhost:3800".
  'default-port': () => {
    const server = read('server.js');
    const port = server.match(/const PORT = process\.env\.PORT \|\| (\d+)/)[1];
    const launcher = read('bin/agentxray.js');
    const flags = /--port/.test(launcher) && /--host/.test(launcher);
    const listed = read(README).includes(`http://localhost:${port}`);
    return `${port} · ${README} states http://localhost:${port}: ${listed ? 'yes' : 'NO'} · launcher --port/--host: ${flags ? 'yes' : 'no'}`;
  },

  // README badge "Node.js-22.13+" and "You cannot run Node.js ≥ 22.13".
  'node-engine-floor': () => {
    const floor = readJson('package.json').engines.node.replace(/^>=/, '');
    const badge = read(README).includes(`Node.js-${floor}+`);
    const prose = read(README).includes(`≥ 22.13`);
    return `>=${floor} · badge ${badge ? 'ok' : 'MISSING'} · README "≥ ${floor}": ${prose ? 'ok' : 'MISSING'}`;
  },

  // README Supported Log Formats: "Reading compressed dsh logs requires
  // Node.js ≥ 22.15 (built-in zstd)".
  'dsh-zstd-floor': () => {
    const dsh = read('lib/platforms/dsh.js');
    const floor = dsh.match(/Node\.js >= ?([\d.]+)/)[1];
    const gated = /HAS_NODE_ZSTD = typeof zlib\.zstdDecompressSync === 'function'/.test(dsh);
    const listed = read(README).includes(`≥ ${floor}`);
    return `${floor} · dsh.js message "Node.js >= ${floor}" + runtime zstd gate: ${gated ? 'yes' : 'no'} · ${README} "≥ ${floor}": ${listed ? 'ok' : 'MISSING'}`;
  },

  // README Development: "Tests live in test/ and use Node's built-in test
  // runner — no extra dependencies."
  'tests-node-only': () => {
    const dir = path.join(ROOT, 'test');
    const files = readdirSync(dir).filter((file) => file.endsWith('.js'));
    const specifiers = new Set();
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const match of source.matchAll(/require\('([^']+)'\)/g)) specifiers.add(match[1]);
    }
    const all = [...specifiers];
    const builtins = all.filter((specifier) => specifier.startsWith('node:'));
    const relative = all.filter((specifier) => specifier.startsWith('.'));
    const thirdParty = all.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'));
    return `${files.length} files in test/ · ${all.length} distinct requires: ${builtins.length} node builtins, ${relative.length} relative, ${thirdParty.length} third-party${thirdParty.length ? ` (${thirdParty.join(', ')})` : ''}`;
  },

  // Deliberate: the README names no version, so no published number can go
  // stale against npm (package.json is 1.17.2 while npm still serves 1.17.1).
  'readme-no-version': () => {
    const versions = read(README).match(/(?<![\d.])v?\d+\.\d+\.\d+(?![\d.])/g) || [];
    return `${plural(versions.length, 'version string')} in ${README}`;
  },
};

async function main() {
  const id = process.argv[2];
  if (id === '--list' || !id || !receipts[id]) {
    const known = Object.keys(receipts).sort();
    process.stderr.write(`usage: node scripts/claims-receipts.mjs <${known.join('|')}>\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${await receipts[id]()}\n`);
}

if (process.argv[2] === '--backup-run') {
  // Child mode for the backup receipt: HOME/AGENTXRAY_ARCHIVE_DIR are already
  // set by the parent, and lib/config.js reads them when it is first required.
  const { runFullBackup } = fromRepo('lib/backup.js');
  process.stdout.write(JSON.stringify(await runFullBackup()));
} else {
  await main();
}
