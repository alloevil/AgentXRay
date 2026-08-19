const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { normalizePromptText, hashPromptText } = require('./text-utils');
const { parseLlmJson } = require('./llm-json');
const { HOME, ANALYSIS_DIR, HERMES_DIR, resolveDir } = require('./config');
const { collectSessionFiles, scanFileForInsights } = require('./insights');
const { stripOpenClawNoise } = require('./platforms/openclaw');
const { extractCodexUserPromptText } = require('./platforms/codex');
const { extractOmpUserPromptText } = require('./platforms/omp');
const { extractDshUserPromptText, readDshSessionLines } = require('./platforms/dsh');
const { extractClaudeCodeUserPromptText } = require('./platforms/claude');
const { openHermesDb, unixToIso } = require('./platforms/hermes');

// --- Prompts view: extract real human prompts per session, grouped by directory ---

const promptsCache = new Map();
const PROMPTS_TTL_MS = 60_000;

function getPromptsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

// Hidden prompts: non-destructive delete for the Prompts view.
// Storage: ~/.agentxray/hidden-prompts.json — array of { hash, preview, hiddenAt }.
// hash = first 16 hex chars of sha256 over the whitespace-normalized prompt text,
// so hiding one prompt hides every identical occurrence across sessions/platforms.
const HIDDEN_PROMPTS_FILE = path.join(HOME, '.agentxray', 'hidden-prompts.json');
const HIDDEN_HASH_RE = /^[0-9a-f]{16}$/;

async function loadHiddenPrompts() {
  try {
    const parsed = JSON.parse(await fsp.readFile(HIDDEN_PROMPTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Atomic write: tmp file + rename so a crash never truncates the store.
async function saveHiddenPrompts(entries) {
  await fsp.mkdir(path.dirname(HIDDEN_PROMPTS_FILE), { recursive: true });
  const tmpPath = `${HIDDEN_PROMPTS_FILE}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, HIDDEN_PROMPTS_FILE);
}

async function extractOpenClawPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!timestamp && record.type === 'session') timestamp = record.timestamp || null;
      if (record.type !== 'message') continue;
      if (record.timestamp) lastActivity = record.timestamp;
      const msg = record.message || {};
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = stripOpenClawNoise(
        content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ')
          .trim()
      );
      if (text) prompts.push({ text, timestamp: record.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { timestamp, lastActivity, prompts };
}

async function extractCodexPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      const payload = rec.payload || {};
      if (rec.type === 'session_meta') {
        if (!cwd && payload.cwd) cwd = payload.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if (rec.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
      if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
      const text = extractCodexUserPromptText(payload);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, prompts };
}

// dsh: header carries cwd/createdAt (epoch ms); prompts come from
// user/message events. Compressed logs are decompressed by the adapter.
async function extractDshPrompts(filePath) {
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  const lines = await readDshSessionLines(filePath);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!timestamp && typeof rec.createdAt === 'number') timestamp = new Date(rec.createdAt).toISOString();
      continue;
    }
    const timeIso = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
    if (timeIso) lastActivity = timeIso;
    if (rec.type !== 'user/message') continue;
    const text = extractDshUserPromptText(rec.data || {});
    if (text) prompts.push({ text, timestamp: timeIso });
  }
  return { cwd, timestamp, lastActivity, prompts };
}

async function extractOmpPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  let title = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (rec.type === 'session') {
        if (!cwd && rec.cwd) cwd = rec.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }
      if (rec.type !== 'message') continue;
      const msg = rec.message || {};
      if (msg.role !== 'user') continue;
      const text = extractOmpUserPromptText(msg);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, title, prompts };
}

async function extractClaudeCodePrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let slug = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (!timestamp && rec.timestamp && (rec.type === 'user' || rec.type === 'assistant')) timestamp = rec.timestamp;
      if (rec.type !== 'user') continue;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!slug && rec.slug) slug = rec.slug;
      const text = extractClaudeCodeUserPromptText(rec);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, slug, timestamp, lastActivity, prompts };
}

function extractHermesPromptGroups(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const rows = db
      .prepare(`
      SELECT m.session_id, m.content, m.timestamp, s.source, s.title, s.started_at, s.ended_at
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'user' AND m.content IS NOT NULL AND m.content != ''
      ORDER BY m.session_id, m.rowid
    `)
      .all();

    const sessionMap = new Map();
    for (const row of rows) {
      let sess = sessionMap.get(row.session_id);
      if (!sess) {
        sess = {
          id: row.session_id,
          file: 'state.db',
          timestamp: unixToIso(row.started_at),
          lastActivity: unixToIso(row.ended_at),
          slug: null,
          title: row.title || null,
          directory: row.source || '(no directory)',
          prompts: [],
        };
        sessionMap.set(row.session_id, sess);
      }
      sess.prompts.push({ text: row.content, timestamp: unixToIso(row.timestamp) });
    }

    const groupMap = new Map();
    for (const sess of sessionMap.values()) {
      const key = sess.directory;
      if (!groupMap.has(key)) groupMap.set(key, []);
      const { directory, ...rest } = sess;
      groupMap.get(key).push({ ...rest, promptCount: sess.prompts.length });
    }
    return Array.from(groupMap.entries()).map(([directory, sessions]) => ({ directory, sessions }));
  } finally {
    db.close();
  }
}

async function computePrompts(platform, agentName, dirOverride) {
  let groups;

  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    groups = extractHermesPromptGroups(dir);
  } else {
    const files = await collectSessionFiles(platform, agentName, dirOverride);
    const groupMap = new Map();
    const results = await Promise.all(
      files.map(async (f) => {
        const extractor =
          platform === 'codex'
            ? extractCodexPrompts
            : platform === 'claude-code'
              ? extractClaudeCodePrompts
              : platform === 'omp'
                ? extractOmpPrompts
                : platform === 'dsh'
                  ? extractDshPrompts
                  : extractOpenClawPrompts;
        const result = await extractor(f.path).catch(() => null);
        return result ? { file: f, result } : null;
      })
    );
    for (const item of results) {
      if (!item || item.result.prompts.length === 0) continue;
      const { file: f, result } = item;
      let key;
      if (platform === 'openclaw') {
        // File lives at {dir}/{agent}/sessions/x.jsonl
        key = `agent: ${path.basename(path.dirname(path.dirname(f.path)))}`;
      } else {
        key = result.cwd || '(no directory)';
      }
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push({
        id: f.sessionId,
        file: path.basename(f.path),
        timestamp: result.timestamp,
        lastActivity: result.lastActivity,
        slug: result.slug || null,
        title: result.title || null,
        promptCount: result.prompts.length,
        prompts: result.prompts,
      });
    }
    groups = Array.from(groupMap.entries()).map(([directory, sessions]) => ({ directory, sessions }));
  }

  // Exclude hidden prompts, then drop sessions/directories left empty.
  const hidden = await loadHiddenPrompts();
  if (hidden.length > 0) {
    const hiddenHashes = new Set(hidden.map((entry) => entry.hash));
    for (const g of groups) {
      for (const s of g.sessions) {
        s.prompts = s.prompts.filter((p) => !hiddenHashes.has(hashPromptText(normalizePromptText(p.text))));
        s.promptCount = s.prompts.length;
      }
      g.sessions = g.sessions.filter((s) => s.promptCount > 0);
    }
    groups = groups.filter((g) => g.sessions.length > 0);
  }

  let totalSessions = 0;
  let totalPrompts = 0;
  for (const g of groups) {
    g.sessions.sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));
    g.sessionCount = g.sessions.length;
    g.promptCount = g.sessions.reduce((sum, s) => sum + s.promptCount, 0);
    totalSessions += g.sessionCount;
    totalPrompts += g.promptCount;
  }
  groups.sort((a, b) => b.promptCount - a.promptCount);

  return { platform, totalSessions, totalPrompts, groups };
}

// --- Prompt analysis: clustering, attribution, claude CLI suggestions ---

const analyzeCache = new Map();
const analyzeInFlight = new Map();
const ANALYZE_TOP_K = 8;
const ATTRIBUTION_FILE_CAP = 150;

function promptFingerprint(text) {
  const firstLine = text.split('\n').find((l) => l.trim()) || '';
  let p = firstLine.trim().toLowerCase();
  p = p.replace(/\/[^\s]+/g, '/…');
  p = p.replace(/[0-9a-f]{8,}/g, '…');
  p = p.replace(/\d+/g, '#');
  return p.slice(0, 120) || '(empty)';
}

function clusterPrompts(promptsData) {
  const clusters = new Map();
  for (const g of promptsData.groups) {
    for (const s of g.sessions) {
      for (const p of s.prompts) {
        const pattern = promptFingerprint(p.text);
        let c = clusters.get(pattern);
        if (!c) {
          c = {
            pattern,
            count: 0,
            sessionIds: new Set(),
            directories: new Set(),
            totalLength: 0,
            shortest: null,
            longest: null,
            timestamps: [],
          };
          clusters.set(pattern, c);
        }
        c.count++;
        c.sessionIds.add(s.id);
        c.directories.add(g.directory);
        c.totalLength += p.text.length;
        if (p.timestamp) c.timestamps.push(p.timestamp);
        if (!c.shortest || p.text.length < c.shortest.length) c.shortest = p.text;
        if (!c.longest || p.text.length > c.longest.length) c.longest = p.text;
      }
    }
  }
  return Array.from(clusters.values())
    .map((c) => ({
      pattern: c.pattern,
      count: c.count,
      sessionIds: Array.from(c.sessionIds),
      directories: Array.from(c.directories),
      avgLength: Math.round(c.totalLength / c.count),
      timestamps: c.timestamps,
      topic: null,
      errorSamples: [],
      samples:
        c.shortest === c.longest ? [c.shortest.slice(0, 2000)] : [c.shortest.slice(0, 2000), c.longest.slice(0, 2000)],
    }))
    .sort((a, b) => b.count - a.count);
}

async function attributeClusters(clusters, platform, agentName, dirOverride) {
  const top = clusters.slice(0, ANALYZE_TOP_K);
  if (platform === 'hermes' || top.length === 0) return;

  const files = await collectSessionFiles(platform, agentName, dirOverride);
  const pathById = new Map(files.map((f) => [f.sessionId, f.path]));

  const neededIds = new Set();
  const perClusterCap = Math.max(10, Math.floor(ATTRIBUTION_FILE_CAP / top.length));
  for (const c of top) {
    let added = 0;
    for (const sid of c.sessionIds) {
      if (added >= perClusterCap || neededIds.size >= ATTRIBUTION_FILE_CAP) break;
      if (pathById.has(sid)) {
        neededIds.add(sid);
        added++;
      }
    }
  }

  const scans = new Map();
  await Promise.all(
    Array.from(neededIds).map(async (sid) => {
      const result = await scanFileForInsights(pathById.get(sid), sid).catch(() => null);
      if (result) scans.set(sid, result);
    })
  );

  for (const c of top) {
    let sessions = 0,
      messages = 0,
      toolCalls = 0,
      toolResults = 0,
      errors = 0,
      outputTokens = 0;
    const errorSamples = [];
    for (const sid of c.sessionIds) {
      const scan = scans.get(sid);
      if (!scan) continue;
      sessions++;
      messages += scan.messageCount || 0;
      toolCalls += scan.toolCallCount || 0;
      toolResults += scan.toolResultCount || 0;
      errors += scan.errorCount || 0;
      outputTokens += scan.totalOutputTokens || 0;
      if (errorSamples.length < 3 && Array.isArray(scan.errorExamples)) {
        for (const ex of scan.errorExamples) {
          if (errorSamples.length >= 3) break;
          const snippet = String(ex.snippet || '')
            .split('\n')[0]
            .trim()
            .slice(0, 160);
          if (snippet) errorSamples.push(snippet);
        }
      }
    }
    c.errorSamples = errorSamples;
    if (sessions > 0) {
      c.attribution = {
        sampledSessions: sessions,
        avgMessages: Math.round(messages / sessions),
        avgToolCalls: Math.round((toolCalls / sessions) * 10) / 10,
        errorRate: toolResults > 0 ? Math.round((errors / toolResults) * 1000) / 10 : 0,
        avgOutputTokens: Math.round(outputTokens / sessions),
      };
    }
  }
}

function runClaudeCli(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile('claude', ['-p'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runClaudeAnalysis(clusters) {
  const top = clusters.filter((c) => c.count > 1).slice(0, ANALYZE_TOP_K);
  if (top.length === 0) return { suggestions: [], overall: [] };

  const clusterDescriptions = top
    .map((c, i) => {
      const attr = c.attribution
        ? `归因(采样${c.attribution.sampledSessions}个session): 平均${c.attribution.avgMessages}条消息/${c.attribution.avgToolCalls}次工具调用, 工具错误率${c.attribution.errorRate}%, 平均输出${c.attribution.avgOutputTokens} tokens`
        : '无归因数据';
      const errs =
        c.errorSamples && c.errorSamples.length > 0
          ? `工具错误样例:\n${c.errorSamples.map((e) => `- ${e}`).join('\n')}`
          : '无工具错误样例';
      return `## 模板 ${i + 1}
指纹: ${c.pattern}
出现次数: ${c.count}
${attr}
${errs}
样例:
"""
${c.samples[0].slice(0, 1500)}
"""`;
    })
    .join('\n\n');

  const input = `你是 prompt 工程专家。以下是从 AI agent 会话日志中聚类出的高频 prompt 模板(按出现次数降序),附带每个模板对应 session 的效果归因数据。

请针对每个模板给出优化建议。评估维度: 意图明确性、上下文充分性、约束与输出格式定义、避免模型误解的措辞。归因数据中,高消息数/高工具调用/高错误率可能暗示 prompt 引导不足。改写建议必须结合该模板的工具错误样例(若有),在 rewrite/rationale 中针对性规避这些错误。同时为每个模板打一个主题标签 topic: 2-6 个汉字,如 编码调试/飞书办公/简历求职/UI打磨/爬虫采集。

${clusterDescriptions}

只输出一个 JSON 对象,不要任何其它文字或 markdown 围栏,结构:
{
  "suggestions": [
    { "index": 1, "topic": "2-6个汉字的主题标签", "assessment": "一句话诊断", "issues": ["问题1", "问题2"], "rewrite": "改写后的完整模板(变量部分用 {占位符} 表示)", "rationale": "改写理由" }
  ],
  "overall": ["跨模板的整体建议1", "建议2"]
}
suggestions 数组按模板顺序,每个模板一项。用中文回答。JSON 字符串值内部不要使用英文双引号("),引用词语请用中文引号「」。`;

  const raw = await runClaudeCli(input, 240_000);
  const parsed = parseLlmJson(raw);
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return { suggestions: [], overall: [], rawText: raw.trim().slice(0, 8000) };
  }
  return { suggestions: parsed.suggestions, overall: Array.isArray(parsed.overall) ? parsed.overall : [] };
}

// Persisted analysis results: ~/.agentxray/analysis/<key>.json where key is
// platform (+ '-agentName') sanitized to [a-z0-9-]. Survives server restarts.
function analysisFilePath(platform, agentName) {
  const key = `${platform}${agentName ? `-${agentName}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return path.join(ANALYSIS_DIR, `${key}.json`);
}

async function loadPersistedAnalysis(platform, agentName) {
  try {
    return JSON.parse(await fsp.readFile(analysisFilePath(platform, agentName), 'utf8'));
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename so a crash never truncates the store.
async function savePersistedAnalysis(platform, agentName, result) {
  await fsp.mkdir(ANALYSIS_DIR, { recursive: true });
  const filePath = analysisFilePath(platform, agentName);
  const tmpPath = `${filePath}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, filePath);
}

// Monday (UTC) of the ISO week containing the timestamp, as YYYY-MM-DD.
function isoWeekMonday(isoTs) {
  const t = Date.parse(isoTs || '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function computePromptAnalysis(platform, agentName, dirOverride, skipLlm) {
  const promptsData = await computePrompts(platform, agentName, dirOverride);
  const clusters = clusterPrompts(promptsData);
  await attributeClusters(clusters, platform, agentName, dirOverride);

  const result = {
    platform,
    generatedAt: new Date().toISOString(),
    totalPrompts: promptsData.totalPrompts,
    totalClusters: clusters.length,
    clusters: clusters.slice(0, 50),
    overall: [],
    topics: [],
    weeklyTrend: [],
    llmError: null,
  };

  if (!skipLlm) {
    try {
      const llm = await runClaudeAnalysis(clusters);
      if (llm.rawText) {
        result.rawText = llm.rawText;
      } else {
        const top = clusters.filter((c) => c.count > 1).slice(0, ANALYZE_TOP_K);
        for (const s of llm.suggestions) {
          const target = top[(s.index || 0) - 1];
          if (target) {
            target.suggestion = {
              assessment: s.assessment,
              issues: s.issues || [],
              rewrite: s.rewrite,
              rationale: s.rationale,
            };
            if (typeof s.topic === 'string' && s.topic.trim()) target.topic = s.topic.trim().slice(0, 12);
          }
        }
        result.overall = llm.overall;
      }
    } catch (error) {
      result.llmError = error.message;
    }
  }

  // Topic aggregation: clusters labeled by the LLM, everything else under
  // '其他' (only meaningful once at least one cluster got a label).
  const anyTopic = clusters.some((c) => c.topic);
  if (anyTopic) {
    const topicTotals = new Map();
    let otherClusters = 0,
      otherPrompts = 0;
    for (const c of clusters) {
      if (c.topic) {
        let t = topicTotals.get(c.topic);
        if (!t) {
          t = { topic: c.topic, clusters: 0, prompts: 0 };
          topicTotals.set(c.topic, t);
        }
        t.clusters++;
        t.prompts += c.count;
      } else {
        otherClusters++;
        otherPrompts += c.count;
      }
    }
    result.topics = Array.from(topicTotals.values()).sort((a, b) => b.prompts - a.prompts);
    if (otherClusters > 0) result.topics.push({ topic: '其他', clusters: otherClusters, prompts: otherPrompts });
  }

  // Weekly trend: bucket every cluster member prompt by ISO week (Monday).
  const weeks = new Map();
  for (const c of clusters) {
    const label = c.topic || (anyTopic ? '其他' : '未分类');
    for (const ts of c.timestamps || []) {
      const week = isoWeekMonday(ts);
      if (!week) continue;
      let w = weeks.get(week);
      if (!w) {
        w = { week, total: 0, topics: {} };
        weeks.set(week, w);
      }
      w.total++;
      w.topics[label] = (w.topics[label] || 0) + 1;
    }
  }
  result.weeklyTrend = Array.from(weeks.values()).sort((a, b) => a.week.localeCompare(b.week));
  for (const c of clusters) delete c.timestamps;

  await savePersistedAnalysis(platform, agentName, result).catch(() => {});
  return result;
}

module.exports = {
  promptsCache,
  PROMPTS_TTL_MS,
  getPromptsCacheKey,
  HIDDEN_HASH_RE,
  loadHiddenPrompts,
  saveHiddenPrompts,
  computePrompts,
  analyzeCache,
  analyzeInFlight,
  runClaudeCli,
  loadPersistedAnalysis,
  computePromptAnalysis,
};
