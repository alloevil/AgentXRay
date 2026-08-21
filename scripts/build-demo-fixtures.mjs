#!/usr/bin/env node

// Regenerates frontend/src/demo/fixtures.json by running the REAL backend over
// the hand-written sample logs in frontend/demo/sample-logs/. Because the
// fixtures are captured from actual API responses, the demo router's shapes
// can never drift from the server's.
//
// Run after editing sample logs:  node scripts/build-demo-fixtures.mjs

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAMPLE_LOGS = path.join(ROOT, 'frontend', 'demo', 'sample-logs');
const OUT_FILE = path.join(ROOT, 'frontend', 'src', 'demo', 'fixtures.json');
const PORT = 3877;
const BASE = `http://127.0.0.1:${PORT}`;

// Platforms with sample logs: sample-logs/<key> → the platform's data dir.
const PLATFORM_DIRS = {
  'claude-code': ['claude', '.claude/projects'],
  codex: ['codex', '.codex/sessions'],
  omp: ['omp', '.omp/agent/sessions'],
};

// Demo prompt library: written into the temp home and captured via /api/library,
// so entries go through the real frontmatter serializer/parser round-trip.
const LIBRARY_ENTRIES = [
  {
    name: 'review-pr',
    description: '代码评审:按风险分级列出问题并给出修复建议',
    tags: 'review,quality',
    content:
      'Review the following change set. For each issue found, classify it as blocker / major / minor, explain the risk in one sentence, and propose a concrete fix. End with a merge verdict.\n\n$ARGUMENTS',
  },
  {
    name: 'bugfix-tdd',
    description: '缺陷修复:先写失败测试再修,红绿验证',
    tags: 'debugging,tests',
    content:
      'Fix this bug using test-first flow: 1) write a failing test that reproduces it, 2) make the minimal fix, 3) show the test passing, 4) list any related code paths that share the same defect.\n\nBug report:\n$ARGUMENTS',
  },
  {
    name: 'explain-arch',
    description: '架构讲解:模块职责、数据流和权衡,配 mermaid 图',
    tags: 'docs,onboarding',
    content:
      'Explain the architecture of $ARGUMENTS for a new team member: main modules and their responsibilities, how data flows between them, key design trade-offs, and a mermaid diagram of the component graph.',
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(pathname) {
  const res = await fetch(BASE + pathname);
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'axr-fixtures-'));
  const env = { ...process.env, HOME: home, PORT: String(PORT), HOST: '127.0.0.1' };
  for (const [platform, [srcDir, dataDir]] of Object.entries(PLATFORM_DIRS)) {
    cpSync(path.join(SAMPLE_LOGS, srcDir), path.join(home, dataDir), { recursive: true });
    void platform;
  }
  env.OPENCLAW_DIR = path.join(home, '.openclaw', 'agents');
  env.CODEX_DIR = path.join(home, '.codex', 'sessions');
  env.CLAUDE_CODE_DIR = path.join(home, '.claude', 'projects');
  env.HERMES_DIR = path.join(home, '.hermes');
  env.OMP_DIR = path.join(home, '.omp', 'agent', 'sessions');
  env.DSH_DIR = path.join(home, '.dsh', 'sessions');
  env.GEMINI_DIR = path.join(home, '.gemini', 'tmp');
  env.AGENTXRAY_LIBRARY_DIR = path.join(home, '.agentxray', 'library');
  env.AGENTXRAY_ARCHIVE_DIR = path.join(home, '.agentxray', 'archive');

  // Seed the demo prompt library (real file format: frontmatter + body)
  mkdirSync(env.AGENTXRAY_LIBRARY_DIR, { recursive: true });
  for (const e of LIBRARY_ENTRIES) {
    writeFileSync(
      path.join(env.AGENTXRAY_LIBRARY_DIR, `${e.name}.md`),
      `---\ndescription: ${e.description}\ntags: ${e.tags}\nsource: demo\ncreatedAt: 2026-08-15T00:00:00.000Z\n---\n\n${e.content}\n`
    );
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await getJson('/api/version');
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('server never became ready');
        await sleep(100);
      }
    }

    const fixtures = {
      sessions: {},
      details: {},
      children: {},
      childDetails: {},
      insights: {},
      prompts: {},
      library: { prompts: [] },
      spawnMap: [],
    };

    for (const platform of Object.keys(PLATFORM_DIRS)) {
      const sessions = await getJson(`/api/${platform}/sessions`);
      fixtures.sessions[platform] = sessions;
      for (const s of sessions) {
        fixtures.details[`${platform}/${s.id}`] = await getJson(
          `/api/${platform}/sessions/${encodeURIComponent(s.id)}`
        );
        if (platform === 'omp' || platform === 'claude-code') {
          const children = await getJson(`/api/${platform}/sessions/${encodeURIComponent(s.id)}/children`);
          if (children.length) {
            fixtures.children[`${platform}/${s.id}`] = children;
            for (const c of children) {
              fixtures.childDetails[`${platform}/${s.id}/${c.name}`] = await getJson(
                `/api/${platform}/sessions/${encodeURIComponent(s.id)}/children/${encodeURIComponent(c.name)}`
              );
            }
          }
        }
      }
      fixtures.insights[platform] = await getJson(`/api/insights?platform=${platform}`);
      fixtures.prompts[platform] = await getJson(`/api/prompts?platform=${platform}`);
    }

    // Library entries pass through the real parser; installed flags are all
    // false in the temp home, which is what the read-only demo should show.
    fixtures.library = await getJson('/api/library');

    writeFileSync(OUT_FILE, `${JSON.stringify(fixtures, null, 1)}\n`);
    console.log(
      `wrote ${path.relative(ROOT, OUT_FILE)}: ` +
        `${Object.values(fixtures.sessions).flat().length} sessions, ` +
        `${Object.keys(fixtures.childDetails).length} child transcripts, ` +
        `${fixtures.library.prompts.length} library prompts`
    );
  } finally {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
