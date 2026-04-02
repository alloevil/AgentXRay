# Session Graph View Spec

## Goal
Add a git-graph-style visual timeline to the session detail view. It should appear as a narrow panel between the sidebar and the message detail area.

## Layout Change
Current: `grid-template-columns: 280px minmax(0, 1fr)`
New: `grid-template-columns: 280px 200px minmax(0, 1fr)`

The 200px middle column is the **graph panel**. It scrolls in sync with the messages panel.

## Graph Design

### Visual Style
- Dark background matching the app (`var(--bg)`)
- Vertical SVG timeline, one row per visible message
- Row height: 48px (compact), matching message cards with CSS scroll sync
- Left padding: 20px

### Node Types (circles on the timeline)
1. **User message** — solid blue circle (#58a6ff), radius 6
2. **Assistant message** (with text only) — solid green circle (#7ee787), radius 6
3. **Assistant message** (with tool calls) — green circle with small orange dot overlay
4. **Tool Result** — small orange circle (#d29922), radius 4, positioned on a branch line to the right
5. **Spawn** (sessions_spawn or exec codex/claude) — larger orange diamond (#f0883e), 10px, on a branch extending further right

### Lines
- **Main trunk**: vertical line connecting User and Assistant nodes, color #30363d, 2px wide
- **Tool branch**: when an assistant message has tool calls, draw a short branch line going right from the assistant node. Each tool call gets a small node on this branch. The corresponding tool result connects back to the trunk.
- **Spawn branch**: similar to tool branch but extends further right, uses orange/dashed line, with an arrow icon indicating "child agent"

### Interaction
- **Click a node** → scroll the messages panel to that message (smooth scroll)
- **Hover a node** → show tooltip with: role, tool name (if tool), timestamp
- **Active node** → highlighted with a glow ring matching the message currently in viewport
- **Click spawn diamond** → same behavior as the spawn-link-btn (navigate to child agent)

### Scroll Sync
The graph panel and messages panel should scroll together. Use a shared scroll container or sync scroll events between them.

## Implementation Notes
- Use inline SVG (not canvas) for accessibility and easy click handling
- Each message maps to a "row" in the SVG
- The SVG height = number of visible messages × row height
- Filter out empty assistant messages (same filter as renderMessages)
- Build the node list from the same filtered message array
- Tool calls are extracted from assistant message content arrays
- Tool results are matched via toolCallId

## File Changes
- Only modify `public/index.html` (CSS + JS + HTML)
- Do NOT modify `server.js`
- Keep all existing functionality working
- Do NOT use any external libraries or CDN

## CSS Variables to Use
```
--bg: #0d1117
--panel: #161b22
--border: #30363d
--text: #c9d1d9
--muted: #8b949e
--user: #1f6feb (user blue)
--assistant: #238636 (assistant green)
--danger: #f85149 (error red)
```

## Colors for Graph
- User node: #58a6ff
- Assistant node: #7ee787
- Tool node: #d29922
- Spawn node: #f0883e
- Trunk line: #30363d
- Tool branch line: rgba(210, 153, 34, 0.4)
- Spawn branch line: rgba(240, 136, 62, 0.5) dashed
- Active glow: matching node color at 0.3 opacity, radius 12

## Row Layout Detail
Each filtered message gets one row. For an assistant message with N tool calls followed by their N tool results:
```
Row 1: [Assistant node ●] ─── [Tool1 ○] [Tool2 ○]   (assistant msg)
Row 2: [Tool Result ○─────────┘ ]                     (toolResult for Tool1)  
Row 3: [Tool Result ○─────────────┘]                   (toolResult for Tool2)
```

Actually, simpler approach: keep it linear. Every message gets exactly one row on the main trunk. Tool calls show as small circles branching right from their parent assistant row. No separate rows for branches.

```
● User message
│
● Assistant (has tools) ──○ exec ──○ read ──◆ sessions_spawn
│
● Tool Result (exec)
│
● Tool Result (read)  
│
● Tool Result (sessions_spawn)
│
● Assistant (text only)
│
● User message
```

This is simpler and maps 1:1 with the message list scroll position.
