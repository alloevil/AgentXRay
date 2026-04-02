# Agent Logs Viewer - Specification

## Overview
A web-based viewer for OpenClaw agent session logs. Single Node.js + Express server serving a dark-themed web UI.

## Data Source
- Agent session logs are at: `~/.openclaw/agents/*/sessions/*.jsonl`
- Each agent has a directory: `~/.openclaw/agents/{agentName}/sessions/`
- Active sessions are `.jsonl` files, archived ones have `.reset.*` or `.deleted.*` suffixes
- Each `.jsonl` file contains one JSON object per line

### JSONL Record Types

**session** (first line):
```json
{"type": "session", "version": 3, "id": "uuid", "timestamp": "ISO8601", "cwd": "/path"}
```

**message** (user/assistant/toolResult):
```json
{
  "type": "message",
  "id": "hex8",
  "parentId": "hex8|null",
  "timestamp": "ISO8601",
  "message": {
    "role": "user|assistant|toolResult",
    "content": [
      {"type": "text", "text": "..."},
      {"type": "toolCall", "id": "tool_id", "name": "toolName", "arguments": {...}}
    ],
    "usage": {"input": N, "output": N, "cacheRead": N, ...},
    "model": "model-name",
    "provider": "provider-name"
  }
}
```

For `role: "toolResult"`:
```json
{
  "message": {
    "role": "toolResult",
    "toolCallId": "tool_id",
    "toolName": "exec",
    "content": [{"type": "text", "text": "output"}],
    "details": {"status": "completed", "exitCode": 0, "durationMs": 99},
    "isError": false
  }
}
```

**custom** (model snapshots etc):
```json
{"type": "custom", "customType": "model-snapshot", "data": {...}}
```

**thinking_level_change**:
```json
{"type": "thinking_level_change", "thinkingLevel": "off"}
```

## Architecture
- **Backend**: Node.js + Express, port 3800
- **Frontend**: Single HTML page served by Express, no build tools, no external CDN
- Zero external dependencies beyond Node.js built-ins + express

## API Endpoints

### GET /api/agents
Returns list of agent names.
```json
["claude-code", "main", "mimo", "xiaot"]
```

### GET /api/agents/:name/sessions
Returns sessions for an agent. Include metadata: id, timestamp, message count, whether active or archived.
```json
[
  {"id": "uuid", "timestamp": "ISO8601", "messageCount": 42, "status": "active", "file": "filename.jsonl"},
  {"id": "uuid", "timestamp": "ISO8601", "messageCount": 10, "status": "archived", "file": "filename.jsonl.reset.2026-..."}
]
```
Sort by timestamp descending. Only return active sessions by default, with `?include_archived=true` to include archived.

### GET /api/agents/:name/sessions/:sessionId
Returns full parsed session log.
```json
{
  "session": {"id": "...", "cwd": "...", "timestamp": "..."},
  "messages": [
    {
      "id": "hex8",
      "timestamp": "ISO8601",
      "role": "user|assistant|toolResult",
      "content": [...],  // parsed content array
      "usage": {...},
      "model": "...",
      "toolCallId": "...",  // for toolResult
      "toolName": "...",    // for toolResult
      "details": {...},     // for toolResult
      "isError": false      // for toolResult
    }
  ]
}
```

## Frontend UI Design

### Layout
- **Left sidebar** (280px): Agent list + Session list
  - Top: Agent selector (dropdown or list)
  - Below: Session list for selected agent, showing timestamp + message count
- **Main area**: Message stream for selected session

### Message Rendering

#### User messages
- Blue-ish left-aligned bubble
- Show timestamp
- Render text content, truncate very long system prompts with expand toggle

#### Assistant messages
- Dark card, right-aligned or full-width
- Show model name + token usage badge
- Text content in markdown-like rendering (code blocks with syntax highlighting via <pre><code>)
- If contains toolCall items, render them inline

#### Tool Calls (within assistant messages)
- Collapsible card with tool icon 🔧
- Header: tool name + call ID (truncated)
- Body (collapsed by default): arguments as formatted JSON
- Visual connector line to matching toolResult

#### Tool Results
- Collapsible card with ✅/❌ icon based on isError
- Header: tool name + duration + exit code (if exec)
- Body (collapsed by default): output text in monospace
- Truncate output >500 lines with "Show all" toggle

### Styling
- Dark theme (#0d1117 background, like GitHub dark)
- Monospace for code/tool output (JetBrains Mono or system monospace)
- Color coding:
  - User: #1f6feb (blue)
  - Assistant: #238636 (green)  
  - Tool Call: #8b949e (gray)
  - Tool Result OK: #238636 (green border)
  - Tool Result Error: #f85149 (red border)
- Smooth animations for expand/collapse
- Auto-scroll to bottom option

### Features
- Session search/filter in sidebar
- Auto-refresh toggle (poll every 5s for active sessions)
- Token usage summary at top of session
- Keyboard navigation (up/down arrows for sessions)
- Click on toolCall scrolls to matching toolResult and vice versa

## File Structure
```
/home/w/projects/agent-logs-viewer/
├── server.js          # Express server + API
├── public/
│   └── index.html     # Full SPA (HTML + CSS + JS inline)
├── package.json
└── SPEC.md
```

## Constraints
- NO external CDN (国内环境)
- NO build tools (webpack, vite, etc.)
- NO React/Vue/Angular - vanilla JS only
- Express is the only npm dependency
- Must handle large JSONL files efficiently (stream parsing)
- Port 3800
