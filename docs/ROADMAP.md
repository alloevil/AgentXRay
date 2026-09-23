# Roadmap

> Moved from issue #4 on 2026-09-04. Issues are for bug reports and feature requests; the roadmap lives here. To pick up an item, open an issue referencing it.

## Where we are

- **7 platforms** — OpenClaw, Codex, Claude Code, Hermes (SQLite), OMP, DeepSeek Harness and Gemini CLI, parsed from their native log formats
- **Session browser** with tool-call inspection, trace/waterfall view, spawn tracking and message timeline
- **Prompt tooling** — extraction (noise filtered), template clustering with outcome attribution, Claude-powered rewrites, and a prompt library that installs entries as native slash commands
- **Global search** across all platforms, insights dashboard, incremental session backup
- **React + Vite frontend** served by an Express backend; 233 tests on Node's built-in runner (`npm test`, 2026-09-23), CI on Node 22
- **Evidence-backed failure events and local review** with full-result invalidation, evidence navigation and narrow-screen session layout

## Current priorities

The product direction is **review the coding-agent sessions you already have, with evidence**. First prove that a useful review can be completed locally; then make it easy to try and share. Stars, downloads and screenshots alone do not establish usefulness. This order replaces the earlier feature-first ordering below.

| Priority | Outcome | Acceptance, not a promise |
| --- | --- | --- |
| P0 | Make the new workflow immediately testable | A demo-only entry opens a clearly synthetic case: 7 pending records in 2 events, all evidence accessible, local review does not rewrite automatic results. Preserve the existing default demo and samples. |
| P1 | Current-session review portability implemented | Preview-only import and explicit plaintext download; exact identity/evidence matching, no overwrites, bounded schema and partial-failure reporting. Validate with synthetic migration and publish after CI; whole-history backup and path remapping remain out of scope. |
| P2 | Validate daily usefulness with the maintainer's own sessions | Record reviewed/follow-up/expected/alternative-verification counts and timed review tasks using a fixed rubric. Keep measurements local, separate unknowns and stale labels, and publish only consented aggregate evidence. Do not infer precision or time saved from event compression. |
| P3 | Make releases reproducible for contributors | Keep clean-install tests, generated fixtures, documentation claims and release/package verification aligned. Add browser regression automation when it can run deterministically without personal logs. |

No launch dates or star-count targets are promised. Progress is gated on these observable outcomes. Physical-device/keyboard coverage and complex Trace/analytics layouts remain separate work, not implied by the session-screen checks.

## Existing backlog

- [x] **Publish to npm** so `npx agent-xray` works without cloning — automated from GitHub releases (v1.14.0+)
- [x] **Hosted live demo** on GitHub Pages with clearly-labeled synthetic session data, so people can try the UI before installing
- [x] **Gemini CLI adapter** (`~/.gemini/tmp`) — shipped (#5)
- [ ] **More platform adapters** — opencode and Aider are candidates, not a measured demand ranking. Require representative logs and parser acceptance tests before prioritizing them over the review workflow.
- [x] **Session export & sharing** — render a session (with tool calls) to a standalone Markdown/HTML file you can attach to a bug report or blog post (#6)
- [ ] **Cost & token analytics** — per-session and per-day token spend, broken down by model, building on the token counts we already parse for the summary panel
- [ ] **Watch mode ergonomics** — highlight the currently-active session and surface "agent is waiting for input" state in the sidebar

### Product

From a product review (2026-08-21) — funnel and retention fixes around the npm release:

- [x] Demo must showcase the differentiators (search, spawn navigation, prompt library), not the thinnest layer (#12)
- [x] First launch: auto-pick the first platform that actually has sessions (#13)
- [x] Prompt optimization: drop the hard dependency on a local claude CLI (#14)

### Tech debt

Structural cleanups surfaced by a code review — not features, but they lower the cost of every future one:

- [x] Extract a unified PLATFORMS registry to collapse seven copy-pasted adapter skeletons (#8)
- [x] Decide the legacy UI's fate and eliminate the markdown/pure double-write (#9)
- [x] Split server.js into route modules and lib/ business logic (#10)

## Non-goals (for now)

- Cloud sync or any server-side storage of session data — AgentXRay stays a local, read-only viewer of your own logs
- A plugin marketplace — adapters land in-tree until the format count justifies more

Issue references above are created alongside this roadmap; anything without a link is open for discussion.
