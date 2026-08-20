const { DATA_DIR, CODEX_DIR, CLAUDE_CODE_DIR, HERMES_DIR, OMP_DIR, DSH_DIR, GEMINI_DIR } = require('./config');
const { findCodexSessionFile, parseCodexSessionFile } = require('./platforms/codex');
const { findClaudeCodeSessionFile, parseClaudeCodeSessionFile } = require('./platforms/claude');
const { findOmpSessionFile, parseOmpSessionFile } = require('./platforms/omp');
const { findDshSessionFile, parseDshSessionFile } = require('./platforms/dsh');
const { findGeminiSessionFile, parseGeminiSessionFile } = require('./platforms/gemini');
const { getHermesSession } = require('./platforms/hermes');
const { resolveSessionFile, parseSessionFile } = require('./platforms/openclaw');

// --- Session export: render a normalized session as shareable Markdown or a
// self-contained HTML file (inline CSS, no external requests). Tool calls and
// results render as collapsed <details> blocks so long transcripts stay
// skimmable. A best-effort redaction pass strips obvious secrets (sk-… keys,
// Authorization headers, bearer tokens) since exports are made to be shared.

// Every platform resolves to the same { session, messages } payload the
// session-detail routes serve. openclaw additionally needs the agent name.
const EXPORT_PLATFORMS = {
  openclaw: {
    defaultDir: () => DATA_DIR,
    load: async (dir, sessionId, { agent }) => {
      if (!agent) return null;
      const filePath = await resolveSessionFile(dir, agent, sessionId);
      return filePath ? parseSessionFile(filePath) : null;
    },
  },
  codex: {
    defaultDir: () => CODEX_DIR,
    load: async (dir, sessionId) => {
      const filePath = await findCodexSessionFile(dir, sessionId);
      return filePath ? parseCodexSessionFile(filePath) : null;
    },
  },
  'claude-code': {
    defaultDir: () => CLAUDE_CODE_DIR,
    load: async (dir, sessionId) => {
      const filePath = await findClaudeCodeSessionFile(dir, sessionId);
      return filePath ? parseClaudeCodeSessionFile(filePath) : null;
    },
  },
  omp: {
    defaultDir: () => OMP_DIR,
    load: async (dir, sessionId) => {
      const filePath = await findOmpSessionFile(dir, sessionId);
      return filePath ? parseOmpSessionFile(filePath) : null;
    },
  },
  dsh: {
    defaultDir: () => DSH_DIR,
    load: async (dir, sessionId) => {
      const filePath = await findDshSessionFile(dir, sessionId);
      return filePath ? parseDshSessionFile(filePath) : null;
    },
  },
  gemini: {
    defaultDir: () => GEMINI_DIR,
    load: async (dir, sessionId) => {
      const filePath = await findGeminiSessionFile(dir, sessionId);
      return filePath ? parseGeminiSessionFile(filePath) : null;
    },
  },
  hermes: {
    defaultDir: () => HERMES_DIR,
    load: (dir, sessionId) => getHermesSession(dir, sessionId),
  },
};

// Best-effort secret scrubbing. Bearer form first so `Authorization: Bearer
// <token>` loses the token, not just the word after the colon.
const REDACTIONS = [
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [
    /((?:authorization|proxy-authorization|x-api-key|api[-_]?key)["']?\s*[:=]\s*)("?)(?!\[REDACTED\]|bearer\b)[^\s"',}]+/gi,
    '$1$2[REDACTED]',
  ],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh_[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
];

function redactSecrets(text) {
  let out = String(text);
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n\n');
}

function stringifyArgs(args) {
  if (args === null || args === undefined) return '{}';
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return String(ts);
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

function sumTokens(messages) {
  const totals = {};
  for (const msg of messages) {
    for (const [key, value] of Object.entries(msg.usage || {})) {
      if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
    }
  }
  return totals;
}

function capText(text, maxBytes) {
  if (!maxBytes || text.length <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n… (truncated, ${text.length} chars total)`;
}

// Flatten one normalized message into renderable events shared by both formats:
// { kind: 'user'|'assistant'|'reasoning'|'error', timestamp, text }
// { kind: 'toolCall', timestamp, name, args }   (args: pretty-printed JSON string)
// { kind: 'toolResult', timestamp, name, text, isError }
function messageEvents(msg, maxToolBytes) {
  const events = [];
  const ts = msg.timestamp || null;
  if (msg.role === 'user') {
    events.push({ kind: 'user', timestamp: ts, text: textOf(msg.content) });
  } else if (msg.role === 'assistant') {
    if (msg.reasoning) events.push({ kind: 'reasoning', timestamp: ts, text: String(msg.reasoning) });
    const text = textOf(msg.content);
    if (text.trim()) events.push({ kind: 'assistant', timestamp: ts, text });
    for (const part of msg.content || []) {
      if (part && part.type === 'toolCall') {
        events.push({
          kind: 'toolCall',
          timestamp: ts,
          name: part.name || 'unknown',
          args: stringifyArgs(part.arguments || part.input),
        });
      }
    }
  } else if (msg.role === 'toolCall') {
    events.push({
      kind: 'toolCall',
      timestamp: ts,
      name: msg.toolName || 'unknown',
      args: stringifyArgs(msg.details),
    });
  } else if (msg.role === 'toolResult') {
    const raw = textOf(msg.content) || (typeof msg.content === 'string' ? msg.content : '');
    events.push({
      kind: 'toolResult',
      timestamp: ts,
      name: msg.toolName || null,
      text: capText(raw, maxToolBytes),
      isError: Boolean(msg.isError),
    });
  } else if (msg.role === 'reasoning') {
    const text = textOf(msg.content);
    if (text.trim()) events.push({ kind: 'reasoning', timestamp: ts, text });
  } else if (msg.role === 'error') {
    events.push({ kind: 'error', timestamp: ts, text: textOf(msg.content) });
  }
  return events;
}

function sessionEvents(messages, maxToolBytes) {
  const events = [];
  for (const msg of messages || []) events.push(...messageEvents(msg, maxToolBytes));
  return events;
}

function metadataRows(platform, payload) {
  const session = payload.session || {};
  const messages = payload.messages || [];
  const tokens = sumTokens(messages);
  const tokenSummary = Object.entries(tokens)
    .filter(([key, value]) => value > 0 && key !== 'cost')
    .map(([key, value]) => `${key} ${value.toLocaleString('en-US')}`)
    .join(' · ');
  const rows = [
    ['Platform', platform],
    ['Session', session.id || ''],
    ['Date', formatTimestamp(session.timestamp)],
    ['Working directory', session.cwd || ''],
    ['Model', session.model || ''],
    ['Messages', String(messages.length)],
    ['Tokens', tokenSummary],
  ];
  return rows.filter(([, value]) => value);
}

// Fence tool payloads with a fence longer than any backtick run they contain,
// so embedded ``` blocks can't break out.
function fenceFor(text) {
  const runs = String(text).match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '`'.repeat(longest + 1);
}

function renderSessionMarkdown(platform, payload, { maxToolBytes } = {}) {
  const session = payload.session || {};
  const lines = [];
  lines.push(`# AgentXRay session ${session.id || ''}`.trim());
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  for (const [key, value] of metadataRows(platform, payload)) {
    lines.push(`| ${key} | ${String(value).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push(
    '> Exported by [AgentXRay](https://github.com/alloevil/AgentXRay). Obvious secrets are redacted best-effort — review before sharing.'
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const ev of sessionEvents(payload.messages, maxToolBytes)) {
    const ts = ev.timestamp ? ` (${formatTimestamp(ev.timestamp)})` : '';
    if (ev.kind === 'user') {
      lines.push(`## 👤 User${ts}`, '', ev.text, '');
    } else if (ev.kind === 'assistant') {
      lines.push(`## 🤖 Assistant${ts}`, '', ev.text, '');
    } else if (ev.kind === 'reasoning') {
      lines.push('<details>', `<summary>💭 Reasoning${ts}</summary>`, '', ev.text, '', '</details>', '');
    } else if (ev.kind === 'toolCall') {
      const fence = fenceFor(ev.args);
      lines.push(
        '<details>',
        `<summary>🔧 Tool call: <code>${ev.name}</code>${ts}</summary>`,
        '',
        `${fence}json`,
        ev.args,
        fence,
        '',
        '</details>',
        ''
      );
    } else if (ev.kind === 'toolResult') {
      const icon = ev.isError ? '❌' : '📋';
      const label = ev.name ? `: <code>${ev.name}</code>` : '';
      const fence = fenceFor(ev.text);
      lines.push(
        '<details>',
        `<summary>${icon} Tool result${label}${ts}</summary>`,
        '',
        fence,
        ev.text,
        fence,
        '',
        '</details>',
        ''
      );
    } else if (ev.kind === 'error') {
      lines.push(`## ❌ Error${ts}`, '', ev.text, '');
    }
  }

  return redactSecrets(lines.join('\n'));
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const HTML_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 56rem; padding: 2rem 1.25rem 4rem; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; color: #1c1c1e; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111214; } .msg { border-color: #2c2d31; } table td { border-color: #2c2d31; } .meta { color: #9a9aa2; } pre { background: #1b1c20; } summary:hover { background: #1b1c20; } }
h1 { font-size: 1.3rem; margin: 0 0 1rem; }
table { border-collapse: collapse; font-size: 0.85rem; margin-bottom: 1.5rem; }
table td { border: 1px solid #d9d9de; padding: 0.3rem 0.7rem; }
table td:first-child { font-weight: 600; }
.note { font-size: 0.8rem; color: #8a8a92; margin-bottom: 1.5rem; }
.msg { border: 1px solid #e3e3e8; border-radius: 10px; padding: 0.8rem 1rem; margin-bottom: 0.8rem; }
.msg.user { border-left: 4px solid #4c8dff; }
.msg.assistant { border-left: 4px solid #34c759; }
.msg.error { border-left: 4px solid #ff453a; }
.role { font-weight: 700; font-size: 0.85rem; margin-bottom: 0.35rem; }
.meta { font-weight: 400; color: #8a8a92; font-size: 0.75rem; margin-left: 0.5rem; }
.body { white-space: pre-wrap; word-break: break-word; }
pre { background: #f4f4f6; border-radius: 8px; padding: 0.7rem 0.9rem; overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; margin: 0.5rem 0 0; }
details { margin-bottom: 0.6rem; }
summary { cursor: pointer; font-size: 0.85rem; padding: 0.35rem 0.5rem; border-radius: 6px; }
summary:hover { background: #f4f4f6; }
summary code { font-weight: 600; }
`.trim();

function renderSessionHtml(platform, payload, { maxToolBytes } = {}) {
  const session = payload.session || {};
  const parts = [];
  parts.push('<!doctype html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>AgentXRay session ${escapeHtml(session.id || '')}</title>`);
  parts.push(`<style>${HTML_CSS}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>AgentXRay session ${escapeHtml(session.id || '')}</h1>`);
  parts.push('<table><tbody>');
  for (const [key, value] of metadataRows(platform, payload)) {
    parts.push(`<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`);
  }
  parts.push('</tbody></table>');
  parts.push(
    '<p class="note">Exported by AgentXRay. Obvious secrets are redacted best-effort — review before sharing.</p>'
  );

  for (const ev of sessionEvents(payload.messages, maxToolBytes)) {
    const ts = ev.timestamp ? `<span class="meta">${escapeHtml(formatTimestamp(ev.timestamp))}</span>` : '';
    if (ev.kind === 'user' || ev.kind === 'assistant' || ev.kind === 'error') {
      const label = ev.kind === 'user' ? '👤 User' : ev.kind === 'assistant' ? '🤖 Assistant' : '❌ Error';
      parts.push(
        `<div class="msg ${ev.kind}"><div class="role">${label}${ts}</div><div class="body">${escapeHtml(ev.text)}</div></div>`
      );
    } else if (ev.kind === 'reasoning') {
      parts.push(`<details><summary>💭 Reasoning${ts}</summary><pre>${escapeHtml(ev.text)}</pre></details>`);
    } else if (ev.kind === 'toolCall') {
      parts.push(
        `<details><summary>🔧 Tool call: <code>${escapeHtml(ev.name)}</code>${ts}</summary><pre>${escapeHtml(ev.args)}</pre></details>`
      );
    } else if (ev.kind === 'toolResult') {
      const icon = ev.isError ? '❌' : '📋';
      const label = ev.name ? `: <code>${escapeHtml(ev.name)}</code>` : '';
      parts.push(
        `<details><summary>${icon} Tool result${label}${ts}</summary><pre>${escapeHtml(ev.text)}</pre></details>`
      );
    }
  }

  parts.push('</body></html>');
  return redactSecrets(parts.join('\n'));
}

module.exports = {
  EXPORT_PLATFORMS,
  redactSecrets,
  renderSessionMarkdown,
  renderSessionHtml,
};
