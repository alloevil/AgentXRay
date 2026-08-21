// GENERATED FILE — do not edit.
// Source of truth: frontend/src/lib/pure.ts + frontend/src/lib/markdown.ts.
// Regenerate with `node scripts/build-legacy-pure.mjs` (also runs in build:ui).
// Browser: functions land on window.* (loaded before the legacy app script).
// Node: require('public/js/pure.js') returns the same functions.
var __axrPure = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // frontend/src/lib/legacy-pure.ts
  var legacy_pure_exports = {};
  __export(legacy_pure_exports, {
    buildTraceTurns: () => buildTraceTurns,
    clusterPrefillContent: () => clusterPrefillContent,
    escapeHtml: () => escapeHtml,
    firstInformativeLine: () => firstInformativeLine,
    formatBytes: () => formatBytes,
    formatCost: () => formatCost,
    formatDurationCompact: () => formatDurationCompact,
    getTextContent: () => getTextContent,
    parseTimestampMs: () => parseTimestampMs,
    pickAutoPlatform: () => pickAutoPlatform,
    renderMarkdown: () => renderMarkdown,
    renderMarkdownHtml: () => renderMarkdownHtml
  });

  // frontend/src/lib/pure.ts
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }
  function parseTimestampMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  function formatDurationCompact(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return "0s";
    const totalSeconds = durationMs / 1e3;
    if (totalSeconds < 10) {
      return `${Math.round(totalSeconds * 10) / 10}s`;
    }
    const roundedSeconds = Math.round(totalSeconds);
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor(roundedSeconds % 3600 / 60);
    const seconds = roundedSeconds % 60;
    if (hours > 0) {
      return `${hours}h${minutes ? `${minutes}m` : ""}${!minutes && seconds ? `${seconds}s` : ""}`;
    }
    if (minutes > 0) {
      return `${minutes}m${seconds ? `${seconds}s` : ""}`;
    }
    return `${seconds}s`;
  }
  function formatCost(dollars) {
    return "$" + (dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(4));
  }
  function pickAutoPlatform(counts, order) {
    if (!counts) return null;
    for (const p of order) {
      if ((counts[p] ?? 0) > 0) return p;
    }
    return null;
  }
  function firstInformativeLine(text) {
    const joined = String(text || "");
    for (const rawLine of joined.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^[{}[\]()`"',;:.\-=|\\/*+\s]+$/.test(line)) continue;
      return line.slice(0, 200);
    }
    return joined.trim().replace(/\s+/g, " ").slice(0, 200);
  }
  function getTextContent(content) {
    return (content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n\n");
  }
  function clusterPrefillContent(c) {
    const examples = (c.samples || c.examples || []).map((s) => String(s || "")).filter(Boolean);
    if (!examples.length) return c.pattern || "";
    let prefix = examples[0];
    for (const ex of examples.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < ex.length && prefix[i] === ex[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (examples.length > 1 && prefix.trim().length >= 30 && prefix.length < examples[0].length) {
      return prefix.replace(/\s+$/, "") + " $ARGUMENTS";
    }
    return examples[0];
  }
  function buildTraceTurns(msgs, agentSpans = []) {
    const ts = (m) => parseTimestampMs(m.timestamp);
    const calls = /* @__PURE__ */ new Map();
    const results = /* @__PURE__ */ new Map();
    for (const m of msgs) {
      const t = ts(m);
      if (m.role === "toolCall" && m.toolCallId)
        calls.set(m.toolCallId, { name: m.toolName || "?", ts: t, msgId: m.id });
      if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, { ts: t, isError: !!m.isError });
      for (const c of m.content || []) {
        if ((c.type === "toolCall" || c.type === "tool_use") && c.id)
          calls.set(c.id, { name: c.name || "?", ts: t, msgId: m.id });
        if (c.type === "tool_result" && c.tool_use_id) results.set(c.tool_use_id, { ts: t, isError: !!c.is_error });
      }
    }
    const turns = [];
    let turn = null;
    let prevTs = null;
    for (const m of msgs) {
      const t = ts(m);
      if (!t) continue;
      if (m.role === "user") {
        const text = getTextContent(m.content || []).replace(/\s+/g, " ").trim();
        turn = { start: t, end: t, text: text.slice(0, 140) || "(user)", spans: [] };
        turns.push(turn);
        prevTs = t;
        continue;
      }
      if (!turn) {
        turn = { start: t, end: t, text: "(session start)", spans: [] };
        turns.push(turn);
        prevTs = t;
      }
      if (m.role === "assistant" && prevTs && t > prevTs) {
        turn.spans.push({
          kind: "chat",
          label: (m.model || "model").split("/").pop(),
          start: prevTs,
          end: t,
          msgId: m.id
        });
      }
      if (m.role !== "reasoning") prevTs = t;
      turn.end = Math.max(turn.end, t);
    }
    for (const [cid, c] of calls) {
      if (!c.ts) continue;
      const r = results.get(cid);
      const end = r && r.ts && r.ts > c.ts ? r.ts : c.ts + 50;
      let owner = null;
      for (const tn of turns) {
        if (tn.start <= c.ts) owner = tn;
        else break;
      }
      if (!owner) continue;
      owner.spans.push({
        kind: r && r.isError ? "tool-error" : "tool",
        label: c.name,
        start: c.ts,
        end,
        msgId: c.msgId,
        toolCallId: cid
      });
      owner.end = Math.max(owner.end, end);
    }
    for (const a of agentSpans) {
      if (!a.start) continue;
      const end = a.end && a.end > a.start ? a.end : a.start + 50;
      let owner = null;
      for (const tn of turns) {
        if (tn.start <= a.start) owner = tn;
        else break;
      }
      if (!owner) continue;
      owner.spans.push({ kind: "agent", label: a.label || a.name, start: a.start, end, agentName: a.name });
      owner.end = Math.max(owner.end, end);
    }
    for (const tn of turns) tn.spans.sort((a, b) => a.start - b.start);
    return turns.filter((tn) => tn.spans.length > 0);
  }

  // frontend/src/lib/markdown.ts
  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function renderMarkdownInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }
  function renderMarkdownBlock(segment) {
    const lines = segment.split("\n");
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      const text = para.join("\n").replace(/^\n+|\n+$/g, "");
      if (text.trim()) out.push(`<p>${renderMarkdownInline(text).replace(/\n/g, "<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.join("")}</${list.type}>`);
      list = null;
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
      if (h) {
        flushPara();
        flushList();
        out.push(`<h${h[1].length}>${renderMarkdownInline(h[2])}</h${h[1].length}>`);
      } else if (ul) {
        flushPara();
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(`<li>${renderMarkdownInline(ul[1])}</li>`);
      } else if (ol) {
        flushPara();
        if (!list || list.type !== "ol") {
          flushList();
          list = { type: "ol", items: [] };
        }
        list.items.push(`<li>${renderMarkdownInline(ol[1])}</li>`);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }
  function renderMarkdownHtml(text) {
    const escaped = escapeHtml(text);
    const segments = escaped.split(/```/);
    return segments.map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.split("\n");
        const maybeLang = lines[0].trim();
        const code = lines.slice(1).join("\n") || lines.join("\n");
        return `<pre><code data-lang="${escapeHtml(maybeLang)}">${code}</code></pre>`;
      }
      return renderMarkdownBlock(segment);
    }).join("");
  }
  function renderMarkdown(text) {
    return `<div class="markdown">${renderMarkdownHtml(text)}</div>`;
  }
  return __toCommonJS(legacy_pure_exports);
})();

(function (root, api) {
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    for (var key in api) root[key] = api[key];
  }
})(typeof window !== 'undefined' ? window : globalThis, __axrPure);
