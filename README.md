# Agent Logs Viewer

Web dashboard for viewing AI agent session logs. Supports **OpenClaw**, **Codex**, and **Claude Code** — all in one interface.

## Features

- **Multi-platform** — Unified view across OpenClaw, Codex, and Claude Code sessions
- **Session browser** — Browse agents, filter/search sessions, view message history
- **Tool call inspection** — Expandable tool calls with arguments and results
- **Spawn tracking** — Detect and navigate parent/child agent relationships
- **Message timeline** — Visual graph showing conversation flow with role indicators
- **Auto-refresh** — Live-updating session list and messages
- **Settings panel** — Configure platform directories from the UI, persisted in localStorage
- **Keyboard navigation** — Arrow keys to move between sessions

## Quick Start

```bash
git clone https://github.com/yourname/agent-logs-viewer.git
cd agent-logs-viewer
npm install
npm start
```

Open http://localhost:3800

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
- **Frontend:** Single-file HTML/CSS/JS (no build step, no framework)
- **Data:** Reads JSONL session files directly from disk

## License

MIT
