# Usage and reference

[Project overview](../README.md) · [中文参考](usage.zh-CN.md) · [Offline inspect](offline-inspect.md) · [Execution evidence](diagnostics.md)

Detailed feature catalog, screenshots, installation alternatives, configuration and HTTP API. For the shortest first run, start with the project overview.

## Features

- **Offline evidence CLI** — `agentxray inspect --platform codex session.jsonl --json` reads one explicitly selected log without a server or model. Versioned, minimized reports expose source lines and shared UI-rule hashes; opt-in pending-failure gates never claim task correctness. Supports Codex, OMP and Claude Code JSONL. [Automation contract](offline-inspect.md).

- **Automatic session health** — Opens with factual failure, repetition, follow-up and last-recorded call-state summaries. Missing/running/unknown results have evidence links; no human labels or model calls required. Manual notes and transfers are opt-in and never hide automatic facts. [Scope and offline checks](diagnostics.md#automatic-session-health).
- **Codex background-process evidence** — Connect explicit `exec_command` process IDs to later `write_stdin` results, with launch/poll/exit source links. Ambiguous IDs or polling sequences stay unknown; process completion never rewrites historical tool-call states or proves a task passed. [Association limits](diagnostics.md#codex-background-process-evidence).
- **Modification/check chronology** — Distinguish checks before an edit, checks overlapping it and later outcomes. A passed earlier check or a successful output pipeline is not post-change validation; ambiguous command fragments remain unknown. [Recognition and coverage limits](diagnostics.md#modification-and-verification-chronology).

- **Per-turn ledger** — In the session summary, from two user turns on: one row per user turn with wall-clock time, tokens (input + output + cache) and cost, bars scaled to the session maximum, tool-call counts inline (error counts in the row tooltip), click to jump. Answers "why did this take 40 minutes / cost $3" without reading the transcript.
- **Multi-platform** — Unified view across OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI sessions (dsh's multi-frame zstd session logs are decompressed transparently; Gemini CLI's `/rewind` checkpoints are folded so rewound history never renders twice)
- **Session browser** — Browse agents, filter/search sessions, view message history
- **Tool call inspection** — Expandable tool calls with arguments and results
- **Trace view** — Per-turn waterfall of where the time went: model inference (blue) vs tool execution (green, red on error); click any bar for its span detail in the sidebar, and a purple bar to load the spawned sub-agent's transcript
- **Prompt extraction** — See every real human prompt per session (tool results, slash commands and injected noise filtered out), grouped by working directory, with search / JSON export / copy
- **Prompt optimization** — Cluster prompts into templates, attribute session outcomes (turns, tool calls, error rate) per template, and get LLM-powered rewrite suggestions — through any OpenAI-compatible endpoint (Settings → LLM 接口) or, if none is configured, the local `claude` CLI
- **Prompt library** — Curate the prompts worth keeping into `~/.agentxray/library`, tag / edit / search them, then install any of them as a native slash command for Claude Code, Codex or OMP with one click — `$ARGUMENTS` is passed through, so `/name some args` works in the target CLI
- **Global search** — One search box across all seven platforms at once, multi-keyword AND matching, colored platform badges per hit — including prompts recovered from sessions that Claude Code's cleanup already deleted
- **Session insights** — Aggregate analytics dashboard with tool stats, error clustering and daily trends
- **Evidence-backed failure events (React UI)** — Groups unresolved failures by the same tool, complete arguments and call's user turn, with repeated operations first, first/last evidence jumps and every original result retained. Successful results split groups; missing arguments stay separate. Execution success requires an explicit zero exit code or OMP-native completion evidence. These are review groups, not root-cause diagnoses or proof of task failure. Local rules, no LLM. [Try the synthetic walkthrough and read the boundaries](diagnostics.md).
- **Follow-up evidence candidates** — See later calls differing only in `i`, or same-turn modifications of the same explicitly identified file. Each has a result status, matching rationale and evidence jump; candidates never automatically resolve the failure. [Matching boundaries](diagnostics.md#follow-up-evidence-candidates).
- **Local review queue** — Record follow-up, expected-failure or alternative-verification notes in your browser. Evidence changes invalidate the old review; manual labels never rewrite automatic outcomes. No account or review backend. [Review workflow and storage limits](diagnostics.md#local-review-workflow).
- **Review portability** — Preview and download current-session review notes, then import only exact evidence matches into empty local slots. Existing notes are never overwritten; stale/unmatched records are skipped. JSON files are unencrypted and contain your written notes, not automatically copied logs. [Transfer limits](diagnostics.md#transfer-reviews-between-browsers).
- **Narrow-screen session workflow** — Below 768px, switch between the session list and full-width content without losing the current review draft; platform tabs scroll horizontally, and evidence jumps keep navigation visible. Desktop retains the two-column layout. [Scope and tested viewports](diagnostics.md#narrow-screen-session-workflow).
- **Spawn tracking** — Detect and navigate parent/child agent relationships
- **OMP sub-agents** — Sub-agents spawned by an OMP session show up as chips in the summary; click one to read the child agent's full transcript
- **Message timeline** — Visual graph showing conversation flow with role indicators
- **Resume command** — One click copies the exact command to resume a session in its own CLI (`codex resume`, `claude --resume`, `omp --resume=`)
- **Collapsible summary** — Fold the session summary away when you want the full height for messages
- **Auto-refresh** — Live-updating session list and messages
- **Settings panel** — Configure platform directories from the UI, persisted in localStorage
- **Session backup** — Incremental archive of your Codex, Claude Code, OMP, DeepSeek Harness and Gemini CLI session logs into `~/.agentxray/archive` (Hermes and OpenClaw are not archived), one click in settings (also runs automatically, daily); unchanged files are skipped
- **Keyboard navigation** — Arrow keys to move between sessions

---

## Screenshots

### Session Browser

Browse agents and sessions in the sidebar. Each session card shows message counts by role (👤 User, 🤖 Assistant, 🔧 Tool) and spawn indicators. The main panel displays session metadata, token usage, and top tools at a glance.

![Main View](../screenshots/main-view.png)

### Tool Call Inspection

Expand any tool call to see its arguments and result. Collapsed groups show tool type counts for quick scanning.

![Tool Calls](../screenshots/tool-calls.png)

### Spawn Tracking

Sessions that spawn sub-agents are marked with a 🔗 badge. Click to navigate the parent/child relationship chain.

![Spawn Tracking](../screenshots/spawn-tracking.png)

### Multi-Platform Support

Switch between OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek Harness and Gemini CLI with one click. Each platform's sessions are parsed from their native log format.

![Codex View](../screenshots/codex-view.png)

### Settings

Configure platform directories from the UI. Changes are saved to localStorage — no server restart needed.

![Settings](../screenshots/settings-panel.png)

---

## Install

**Option 1 — npx from npm**

```bash
npx @alloevil/agent-xray            # default http://localhost:3800
npx @alloevil/agent-xray --port 3900 --host 127.0.0.1
```

A global install (`npm i -g @alloevil/agent-xray`) exposes the same launcher as `agentxray`.

**Option 2 — npx straight from GitHub** (works today, no clone)

```bash
npx github:alloevil/AgentXRay
```

The first run builds the web UI locally (takes a minute); later runs reuse the cached install.

**Option 3 — from source**

```bash
git clone https://github.com/alloevil/AgentXRay.git
cd AgentXRay
npm install               # also builds the web UI on first install
npm start
```

Open http://localhost:3800

---

## Usage

### Basic Workflow

1. **Select a platform** — Click `OpenClaw`, `Codex`, `Claude Code`, `Hermes`, `OMP`, `DeepSeek Harness`, or `Gemini CLI` in the top bar
2. **Pick an agent** — For OpenClaw, choose an agent from the dropdown (e.g. `xiaot`, `mimo`)
3. **Browse sessions** — Sessions are sorted by date, newest first. Each card shows:
   - Timestamp and status (`active` / `archived`)
   - Message counts: 👤 User, 🤖 Assistant, 🔧 Tool calls
   - 🔗 Spawn badge if the session spawned sub-agents
4. **View messages** — Click a session to load its full conversation
5. **Inspect tool calls** — Click any `🔧 tool_name` button to expand arguments/results
6. **Navigate spawns** — Click the 🔗 link to jump to the spawned child session

### Prompt View

Click the **Prompts** tab (next to Sessions / Insights) to see every real human prompt across all sessions, grouped by the session's working directory. Noise like tool results, slash-command echoes, system reminders and task notifications is filtered out.

- **Preview & expand** — Each session row shows a one-line preview of its first prompt; click to expand the full markdown-rendered prompt list
- **Search** — Filter prompts / directories / sessions live
- **Export JSON** — Download all extracted prompts for offline processing
- **分析优化 (Analyze)** — Cluster prompts into templates, attribute session outcomes (avg turns, tool calls, error rate) per template, and get rewrite suggestions from the configured LLM backend (Settings → LLM 接口) or, when no endpoint is set, the [`claude` CLI](https://claude.com/claude-code) on the server's PATH. With neither, clustering and attribution still work, and the analysis route reports the missing backend as `llmError`
- **优化 (Optimize)** — Hover any single prompt and click 优化 for an inline LLM-powered rewrite (configure the backend in Settings → LLM 接口, or have the `claude` CLI on PATH)

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between sessions |
| `Enter` | Select highlighted session |

### Filtering & Search

- **Search box** — Filter sessions by ID or content
- **Include archived** — Toggle to show/hide archived (`.reset.*` / `.deleted.*`) sessions
- **Auto-refresh** — Automatically poll for new sessions and messages
- **Auto-scroll** — Scroll to the latest message when new content arrives

---

## Configuration

### Default directories

| Platform    | Default path                  |
|-------------|-------------------------------|
| OpenClaw    | `~/.openclaw/agents`          |
| Codex       | `~/.codex/sessions`           |
| Claude Code | `~/.claude/projects`          |
| Hermes      | `~/.hermes`                   |
| OMP         | `~/.omp/agent/sessions`       |
| DeepSeek Harness | `~/.dsh/sessions` (honors `DSH_HOME`) |
| Gemini CLI  | `~/.gemini/tmp`               |

### Custom directories

**Via UI:** Click the gear icon in the sidebar to set custom paths per platform. Saved to localStorage, no restart needed.

**Via environment variables:**

```bash
OPENCLAW_DIR=/custom/path/openclaw \
CODEX_DIR=/custom/path/codex \
CLAUDE_CODE_DIR=/custom/path/claude \
HERMES_DIR=/custom/path/hermes \
OMP_DIR=/custom/path/omp \
DSH_DIR=/custom/path/dsh/sessions \
GEMINI_DIR=/custom/path/gemini/tmp \
npm start
```

**Via API:** Pass `?dir=/absolute/path` query parameter to any API endpoint.

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/agents` | List OpenClaw agents |
| `GET /api/agents/:name/sessions` | List sessions for an agent |
| `GET /api/agents/:name/sessions/:id` | Get session messages |
| `GET /api/codex/sessions` | List Codex sessions |
| `GET /api/codex/sessions/:id` | Get Codex session messages |
| `GET /api/claude-code/sessions` | List Claude Code sessions |
| `GET /api/claude-code/sessions/:id` | Get Claude Code session messages |
| `GET /api/hermes/sessions` | List Hermes sessions |
| `GET /api/hermes/sessions/:id` | Get Hermes session messages |
| `GET /api/omp/sessions` | List OMP (oh-my-pi) sessions |
| `GET /api/omp/sessions/:id` | Get OMP session messages |
| `GET /api/dsh/sessions` | List DeepSeek Harness sessions |
| `GET /api/dsh/sessions/:id` | Get DeepSeek Harness session messages |
| `GET /api/gemini/sessions` | List Gemini CLI sessions |
| `GET /api/gemini/sessions/:id` | Get Gemini CLI session messages |
| `GET /api/spawn-map` | Build agent spawn relationship map |
| `GET /api/insights` | Aggregate analytics (tool stats, error clusters, trends) |
| `GET /api/prompts` | Real human prompts per session, grouped by directory |
| `GET /api/prompts/analyze` | Template clustering + attribution + Claude suggestions (`?refresh=1` to recompute, `?skipLlm=1` for clustering only) |
| `POST /api/prompts/rewrite` | Rewrite a single prompt via the configured LLM backend (`{ "text": "..." }`; 503 with guidance when no backend is available) |
| `GET/PUT /api/settings/llm` | LLM backend config: OpenAI-compatible `baseUrl`/`model`/`apiKey`, persisted in `~/.agentxray/llm.json` (key never echoed back) |
| `GET /api/search` | Full-text search across sessions (`?platform=all` searches every platform at once, multi-keyword AND) |
| `GET /api/omp/sessions/:id/children` | List sub-agents spawned by an OMP session |
| `GET /api/omp/sessions/:id/children/:name` | Get a spawned sub-agent's messages |
| `GET /api/library` | List library prompts with their per-target install state |
| `POST /api/library` | Create a prompt (`{ "name": "...", "content": "...", "description": "...", "tags": [...] }`) |
| `PUT /api/library/:name` | Update / rename a prompt (`newName`, `content`, `description`, `tags`); installed copies are refreshed |
| `DELETE /api/library/:name` | Delete a prompt and any installed slash commands |
| `POST /api/library/:name/install` | Install as a slash command (`{ "targets": ["claude", "codex", "omp"] }`) |
| `POST /api/library/:name/uninstall` | Remove the installed slash commands (same body) |
| `POST /api/library/suggest-name` | Suggest a library name for a prompt via the configured LLM backend (`{ "text": "..." }`; `null` when no backend is available) |
| `POST /api/backup` | Run an incremental backup into `~/.agentxray/archive` |
| `GET /api/backup/status` | Archive stats: file count, total bytes, last backup time |

All list/detail endpoints accept an optional `?dir=` parameter to override the default directory.

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** React + Vite + TypeScript under `frontend/` (default UI, served from `frontend/dist`)
- **Legacy UI:** the original vanilla HTML/CSS/JS app under `public/`, served at `/legacy` — **frozen: security fixes only**. New features land in the React app exclusively; a feature change to the React renderer requires zero edits under `public/js/`. Shared logic (formatters, trace builder, markdown/escape pipeline) is authored once in `frontend/src/lib/pure.ts` and `frontend/src/lib/markdown.ts`, and `public/js/pure.js` is generated from them (`npm run build:legacy-pure`, also part of `build:ui`).
- **Data:** Reads JSONL session files directly from disk
- **Zero external CDN** — Everything is self-contained, works offline

---

## Supported Log Formats

| Platform | Format | Path Pattern |
|----------|--------|--------------|
| OpenClaw | JSONL | `~/.openclaw/agents/{agent}/sessions/{id}.jsonl` |
| Codex | JSONL | `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{uuid}.jsonl` (session id is the trailing UUID) |
| Claude Code | JSONL | `~/.claude/projects/{project-slug}/{sessionId}.jsonl` (plus `{sessionId}/subagents/agent-*.jsonl` for spawned children) |
| Hermes | SQLite | `~/.hermes/state.db` |
| OMP | JSONL | `~/.omp/agent/sessions/*/{timestamp}_{id}.jsonl` |
| DeepSeek Harness | JSONL / zstd-compressed JSONL | `~/.dsh/sessions/{project}/{id}/session.jsonl[.zstd]` |
| Gemini CLI | JSONL | `~/.gemini/tmp/{projectHash}/chats/session-*.jsonl` |

dsh's `.jsonl.zstd` logs are a concatenation of independent Zstandard frames (one per append batch); AgentXRay scans the frame boundaries and decompresses every frame, tolerating a torn trailing frame after a crash. Reading compressed dsh logs requires Node.js ≥ 22.15 (built-in zstd); plain `session.jsonl` logs work on any supported Node.

Archived sessions (`.jsonl.reset.*`, `.jsonl.deleted.*`) are shown for OpenClaw when "Include archived" is enabled; the other adapters list active `.jsonl` files only.

---

## Development

Tests live in `test/` and use Node's built-in test runner — no extra dependencies. Run `npm ci` once, then `npm test` (`node --test test/*.test.js`). The tests start their own server on a random port with `HOME` and every platform directory pointed at a throwaway copy of `test/fixtures/home`, so your real session logs are never read or modified. CI (`.github/workflows/test.yml`) runs on Node 22 for every push and pull request to `master`, in four steps: `npm ci` (whose `prepare` script builds the web UI and regenerates `public/js/pure.js`), a drift check (`git diff --exit-code public/js/pure.js lib/generated/diagnostics.cjs`), `npx biome check .`, and `npm test`.

**Adding a platform** takes two files: write one adapter in `lib/platforms/<name>.js` (list / find / parse / normalize for that log format — `lib/platforms/shared.js` provides the metadata cache, the normalized-message factory and the session sort), then register it in the `PLATFORMS` table in `lib/platforms/index.js`. The generic session routes, search, watch (SSE tail), insights, prompts, tool audit, OTLP and Markdown/HTML export all resolve platforms through that registry — no other file needs to change.

---

## FAQ

**Which agents and log formats does AgentXRay support?**
Seven platforms: OpenClaw, Codex, Claude Code, Hermes, OMP (oh-my-pi), DeepSeek Harness and Gemini CLI. Six of them store JSONL; Hermes stores SQLite at `~/.hermes/state.db`. DeepSeek Harness logs may be multi-frame zstd-compressed `.jsonl.zstd`, which AgentXRay decompresses frame by frame, tolerating a torn trailing frame left by a crash. The authoritative list is the `PLATFORMS` registry in `lib/platforms/index.js` — run `node -e 'console.log(Object.keys(require("./lib/platforms/index.js").PLATFORMS))'` to print it.

**Does AgentXRay send my session data anywhere?**
Core log inspection and offline `inspect` do not call a model or upload logs. Optional prompt rewriting and suggestions use the configured endpoint, or the `claude` CLI fallback, which may contact a remote provider. Fabric import downloads patterns from GitHub. Installing packages can access registries. Development-only remote experiments require explicit invocation and a gated sanitized payload; they are not part of a normal dashboard launch. Do not use rewrite/suggestion features if you require no model egress.

**Do I have to change my agent or add instrumentation?**
No. CLI coding agents already write complete session logs to disk, and AgentXRay just reads them. There is no SDK to add to your code and no wrapper command to run your agent under. A default install needs no configuration either, because the default directories listed under [Configuration](#configuration) are used unless you override them in the settings panel or through environment variables such as `CLAUDE_CODE_DIR`.

**How do I try it without installing anything?**
Open <https://alloevil.github.io/AgentXRay/>. That GitHub Pages deployment is the real React UI, built by `.github/workflows/pages.yml`, running against `frontend/src/demo/fixtures.json` — API fixtures generated from the synthetic sample logs committed under `frontend/demo/sample-logs` by `scripts/build-demo-fixtures.mjs`. It contains no real user sessions, so treat it as a UI tour rather than as data.

**How do I add support for a log format that is not listed?**
Two files: write an adapter at `lib/platforms/<name>.js` implementing list / find / parse / normalize for that format, then register it in the `PLATFORMS` table in `lib/platforms/index.js`. Every generic route resolves platforms through that registry, so no other file needs to change. See [Development](#development).
