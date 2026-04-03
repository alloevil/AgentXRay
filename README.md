# AgentXRay

X-ray vision into your AI agent sessions. Supports **OpenClaw**, **Codex**, and **Claude Code** — all in one interface.

English | [中文](README.zh-CN.md)

![Main View](screenshots/main-view.png)

## Features

- **Multi-platform** — Unified view across OpenClaw, Codex, and Claude Code sessions
- **Session browser** — Browse agents, filter/search sessions, view message history
- **Tool call inspection** — Expandable tool calls with arguments and results
- **Spawn tracking** — Detect and navigate parent/child agent relationships
- **Message timeline** — Visual graph showing conversation flow with role indicators
- **Auto-refresh** — Live-updating session list and messages
- **Settings panel** — Configure platform directories from the UI, persisted in localStorage
- **Keyboard navigation** — Arrow keys to move between sessions

## Screenshots

### Session Browser

Browse agents and sessions in the sidebar. Each session card shows message counts by role (👤 User, 🤖 Assistant, 🔧 Tool) and spawn indicators. The main panel displays session metadata, token usage, and top tools at a glance.

![Main View](screenshots/main-view.png)

### Tool Call Inspection

Expand any tool call to see its arguments and result. Collapsed groups show tool type counts for quick scanning.

![Tool Calls](screenshots/tool-calls.png)

### Spawn Tracking

Sessions that spawn sub-agents are marked with a 🔗 badge. Click to navigate the parent/child relationship chain.

![Spawn Tracking](screenshots/spawn-tracking.png)

### Multi-Platform Support

Switch between OpenClaw, Codex, and Claude Code with one click. Each platform's sessions are parsed from their native log format.

![Codex View](screenshots/codex-view.png)

### Settings

Configure platform directories from the UI. Changes are saved to localStorage — no server restart needed.

![Settings](screenshots/settings-panel.png)

## Quick Start

```bash
git clone https://github.com/alloevil/agent-xray.git
cd agent-xray
npm install
npm start
```

Open http://localhost:3800

## Usage

### Basic Workflow

1. **Select a platform** — Click `OpenClaw`, `Codex`, or `Claude Code` in the top bar
2. **Pick an agent** — For OpenClaw, choose an agent from the dropdown (e.g. `xiaot`, `mimo`)
3. **Browse sessions** — Sessions are sorted by date, newest first. Each card shows:
   - Timestamp and status (`active` / `archived`)
   - Message counts: 👤 User, 🤖 Assistant, 🔧 Tool calls
   - 🔗 Spawn badge if the session spawned sub-agents
4. **View messages** — Click a session to load its full conversation
5. **Inspect tool calls** — Click any `🔧 tool_name` button to expand arguments/results
6. **Navigate spawns** — Click the 🔗 link to jump to the spawned child session

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

## Configuration

### Default directories

| Platform    | Default path                  |
|-------------|-------------------------------|
| OpenClaw    | `~/.openclaw/agents`          |
| Codex       | `~/.codex/sessions`           |
| Claude Code | `~/.claude/projects`          |

### Custom directories

**Via UI:** Click the gear icon in the sidebar to set custom paths per platform. Saved to localStorage, no restart needed.

**Via environment variables:**

```bash
OPENCLAW_DIR=/custom/path/openclaw \
CODEX_DIR=/custom/path/codex \
CLAUDE_CODE_DIR=/custom/path/claude \
npm start
```

**Via API:** Pass `?dir=/absolute/path` query parameter to any API endpoint.

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
| `GET /api/spawn-map` | Build agent spawn relationship map |

All list/detail endpoints accept an optional `?dir=` parameter to override the default directory.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Single-file HTML/CSS/JS (~70KB, no build step, no framework)
- **Data:** Reads JSONL session files directly from disk
- **Zero external CDN** — Everything is self-contained, works offline

## Supported Log Formats

| Platform | Format | Path Pattern |
|----------|--------|--------------|
| OpenClaw | JSONL | `~/.openclaw/agents/{agent}/sessions/{id}.jsonl` |
| Codex | JSONL | `~/.codex/sessions/{id}.jsonl` |
| Claude Code | JSONL | `~/.claude/projects/*/sessions/*/session.jsonl` |

Archived sessions (`.jsonl.reset.*`, `.jsonl.deleted.*`) are also supported when "Include archived" is enabled.

## License

MIT
