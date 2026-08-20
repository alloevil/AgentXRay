const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { normalizePromptText, hashPromptText } = require('./lib/text-utils');
const { parseLlmJson } = require('./lib/llm-json');
const {
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  LIBRARY_DIR,
  ARCHIVE_DIR,
  sessionMetaCache,
  resolveDir,
  isArchivedFile,
  sanitizeAgentName,
  sanitizeSessionId,
  readAgents,
} = require('./lib/config');
const {
  getHermesDbPath,
  openHermesDbForWatch,
  listHermesSessions,
  getHermesSession,
  normalizeHermesMessage,
  searchHermesSessions,
} = require('./lib/platforms/hermes');
const {
  codexSessionIdFromFile,
  findCodexSessionFile,
  listCodexSessions,
  normalizeCodexRecord,
  parseCodexSessionFile,
} = require('./lib/platforms/codex');
const {
  findDshSessionFile,
  listDshSessions,
  readDshSessionLines,
  decompressDshLog,
  scanZstdFrames,
  normalizeDshEvents,
  parseDshSessionFile,
} = require('./lib/platforms/dsh');
const {
  findGeminiSessionFile,
  listGeminiSessions,
  normalizeGeminiRecord,
  foldGeminiRecords,
  parseGeminiSessionFile,
} = require('./lib/platforms/gemini');
const {
  ompSessionIdFromFile,
  findOmpSessionFile,
  parseOmpSessionMetadata,
  listOmpSessions,
  normalizeOmpRecord,
  parseOmpSessionFile,
  findOmpSpawnDir,
} = require('./lib/platforms/omp');
const {
  findClaudeCodeSessionFile,
  parseClaudeCodeSessionMetadata,
  listClaudeCodeSessions,
  normalizeClaudeCodeRecord,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
} = require('./lib/platforms/claude');
const {
  listSessionsForAgent,
  resolveSessionFile,
  normalizeMessage,
  parseSessionFile,
  buildSpawnMap,
  buildSpawnTree,
} = require('./lib/platforms/openclaw');
const { insightsCache, INSIGHTS_TTL_MS, getInsightsCacheKey, computeInsights } = require('./lib/insights');
const {
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
} = require('./lib/prompts');
const {
  TOOL_AUDIT_PLATFORMS,
  TOOL_AUDIT_TTL_MS,
  toolAuditCache,
  computeToolAudit,
  loadPersistedToolAudit,
  savePersistedToolAudit,
} = require('./lib/tool-audit');
const { OTLP_PLATFORMS, buildOtlpPayload } = require('./lib/otlp');
const { EXPORT_PLATFORMS, renderSessionMarkdown, renderSessionHtml } = require('./lib/export');
const {
  LIBRARY_NAME_RE,
  INSTALL_TARGETS,
  sanitizeLibraryName,
  libraryFilePath,
  installedFilePath,
  normalizeLibraryTags,
  parseLibraryFile,
  serializeLibraryFile,
  detectInstalled,
  readLibraryPrompt,
  installLibraryPrompt,
  uninstallLibraryPrompt,
  parseInstallTargets,
  gitLibrary,
  startLibraryGit,
  commitLibrary,
  fetchFabricPattern,
  listFabricPatternNames,
  fabricLibraryName,
  fabricDescription,
  listLibraryNames,
  getLibraryUsageCache,
  setLibraryUsageCache,
  computeLibraryUsage,
} = require('./lib/library');
const { runFullBackup, AUTO_BACKUP_INTERVAL_MS, runAutoBackup } = require('./lib/backup');

const app = express();
const PORT = process.env.PORT || 3800;
// Bind to localhost by default: the dashboard exposes full AI session
// history (and ?dir= reads) with zero auth — opt into LAN via HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');
// Serve the built React UI when present; the legacy vanilla UI stays at /legacy.
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// Frontend staleness detection: the SPA polls this and prompts a reload
// when the serving process (and thus possibly the code) has changed.
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
app.get('/api/version', (req, res) => {
  res.json({ bootId: SERVER_BOOT_ID });
});

if (HAS_DIST) {
  app.use(express.static(DIST_DIR, { maxAge: 0, etag: false, lastModified: false }));
  app.use('/legacy', express.static(PUBLIC_DIR, { maxAge: 0, etag: false, lastModified: false }));
} else {
  app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: false, lastModified: false }));
}
app.use(express.json({ limit: '256kb' }));

// Disable all caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

app.get('/api/agents', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const agents = await readAgents(dir);
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Insights: aggregate analytics across sessions
app.get('/api/insights', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = sanitizeAgentName(req.query.agent || '') || '';
    const dir = req.query.dir || '';

    const cacheKey = getInsightsCacheKey(platform, agent, dir);
    const cached = insightsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.data);
    }

    const data = await computeInsights(platform, agent, dir);
    if (!data) {
      return res.json({
        totalSessions: 0,
        totalMessages: 0,
        totalToolCalls: 0,
        errorRate: 0,
        tokenUsage: { input: 0, output: 0, cacheRead: 0 },
        toolStats: [],
        errorClusters: [],
        trend: [],
      });
    }

    insightsCache.set(cacheKey, { data, expires: Date.now() + INSIGHTS_TTL_MS });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prompts: real human prompts per session, grouped by directory
app.get('/api/prompts', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = sanitizeAgentName(req.query.agent || '') || '';
    const dir = req.query.dir || '';

    const cacheKey = getPromptsCacheKey(platform, agent, dir);
    const cached = promptsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.data);
    }

    const data = await computePrompts(platform, agent, dir);
    if (!data) {
      return res.json({ platform, totalSessions: 0, totalPrompts: 0, groups: [] });
    }

    promptsCache.set(cacheKey, { data, expires: Date.now() + PROMPTS_TTL_MS });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prompt analysis: cluster + attribute + claude CLI suggestions
app.get('/api/prompts/analyze', async (req, res) => {
  try {
    const platform = req.query.platform || 'openclaw';
    const agent = sanitizeAgentName(req.query.agent || '') || '';
    const dir = req.query.dir || '';
    const refresh = req.query.refresh === '1';
    const skipLlm = req.query.skipLlm === '1';
    const cacheKey = getPromptsCacheKey(platform, agent, dir);

    // cached=1: return the persisted result if present, never compute
    if (req.query.cached === '1') {
      const persisted = await loadPersistedAnalysis(platform, agent);
      if (!persisted) return res.status(204).end();
      return res.json({ ...persisted, persisted: true });
    }

    if (!refresh) {
      if (analyzeCache.has(cacheKey)) {
        return res.json(analyzeCache.get(cacheKey));
      }
      // Fall back to the persisted result before recomputing
      const persisted = await loadPersistedAnalysis(platform, agent);
      if (persisted) return res.json({ ...persisted, persisted: true });
    }
    // Coalesce concurrent identical requests into one computation
    if (analyzeInFlight.has(cacheKey)) {
      const data = await analyzeInFlight.get(cacheKey);
      return res.json(data);
    }

    const promise = computePromptAnalysis(platform, agent, dir, skipLlm);
    analyzeInFlight.set(cacheKey, promise);
    try {
      const data = await promise;
      if (!skipLlm) analyzeCache.set(cacheKey, data);
      res.json(data);
    } finally {
      analyzeInFlight.delete(cacheKey);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tool audit: per-tool usage/health, optionally scoped to one platform.
// cached=1 → persisted result or 204; refresh=1 → recompute past the 5-min
// memory cache. Only platform=all runs are persisted to tools-audit.json.
app.get('/api/tools/audit', async (req, res) => {
  try {
    const platform = req.query.platform || 'all';
    if (platform !== 'all' && !TOOL_AUDIT_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `unknown platform: ${platform}` });
    }

    // Per-platform dir overrides, mirroring /api/search: `dir` applies to the
    // selected platform; in `all` mode use dirOpenclaw/dirCodex/dirClaude/dirOmp/dirDsh/dirGemini.
    const all = platform === 'all';
    const dirs = {
      openclaw: (all ? req.query.dirOpenclaw : req.query.dir) || '',
      codex: (all ? req.query.dirCodex : req.query.dir) || '',
      'claude-code': (all ? req.query.dirClaude : req.query.dir) || '',
      omp: (all ? req.query.dirOmp : req.query.dir) || '',
      dsh: (all ? req.query.dirDsh : req.query.dir) || '',
      gemini: (all ? req.query.dirGemini : req.query.dir) || '',
    };

    // cached=1: return the persisted result if present, never compute
    if (req.query.cached === '1') {
      const persisted = await loadPersistedToolAudit();
      if (!persisted) return res.status(204).end();
      return res.json({ ...persisted, persisted: true });
    }

    const cacheKey = `${platform}|${dirs['openclaw']}|${dirs['codex']}|${dirs['claude-code']}|${dirs['omp']}|${dirs['dsh']}|${dirs['gemini']}`;
    if (req.query.refresh !== '1') {
      const cached = toolAuditCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) return res.json(cached.data);
    }

    const data = await computeToolAudit(platform, dirs);
    toolAuditCache.set(cacheKey, { data, expires: Date.now() + TOOL_AUDIT_TTL_MS });
    if (all) await savePersistedToolAudit(data).catch(() => {});
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rewrite a single prompt via claude CLI
app.post('/api/prompts/rewrite', async (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').slice(0, 8000);
    if (!text.trim()) return res.status(400).json({ error: 'text is required' });

    const input = `你是 prompt 工程专家。请改写下面这条给 AI agent 的 prompt,使其意图更明确、上下文更充分、约束与期望输出更清晰,同时保留原始意图。

原始 prompt:
"""
${text}
"""

只输出一个 JSON 对象,不要任何其它文字或 markdown 围栏:
{ "rewrite": "改写后的完整 prompt", "rationale": "改动说明(中文,简短)" }`;

    const raw = await runClaudeCli(input, 120_000);
    const parsed = parseLlmJson(raw);
    if (!parsed || !parsed.rewrite) {
      return res.json({ rewrite: raw.trim().slice(0, 8000), rationale: null, raw: true });
    }
    res.json({ rewrite: parsed.rewrite, rationale: parsed.rationale || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hidden prompts: list, hide (by text), unhide (by hash)
app.get('/api/prompts/hidden', async (req, res) => {
  try {
    res.json({ hidden: await loadHiddenPrompts() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/prompts/hidden', async (req, res) => {
  try {
    // Accept a single {text} or a batch {texts: [...]} (up to 500)
    const body = req.body || {};
    const rawTexts = Array.isArray(body.texts) ? body.texts : body.text !== undefined ? [body.text] : [];
    if (rawTexts.length > 500) return res.status(400).json({ error: 'too many texts (max 500)' });
    const normalized = rawTexts.map((t) => normalizePromptText(t)).filter(Boolean);
    if (!normalized.length) return res.status(400).json({ error: 'text or texts is required' });
    const entries = await loadHiddenPrompts();
    const known = new Set(entries.map((entry) => entry.hash));
    const hashes = [];
    let added = 0;
    const hiddenAt = new Date().toISOString();
    for (const text of normalized) {
      const hash = hashPromptText(text);
      hashes.push(hash);
      if (!known.has(hash)) {
        known.add(hash);
        entries.push({ hash, preview: text.slice(0, 120), hiddenAt });
        added++;
      }
    }
    if (added > 0) {
      await saveHiddenPrompts(entries);
      promptsCache.clear();
      analyzeCache.clear();
    }
    res.json({ hash: hashes[0], hashes, added, hidden: entries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/prompts/hidden/:hash', async (req, res) => {
  try {
    const hash = req.params.hash;
    if (!HIDDEN_HASH_RE.test(hash)) return res.status(400).json({ error: 'invalid hash' });
    const entries = await loadHiddenPrompts();
    const next = entries.filter((entry) => entry.hash !== hash);
    if (next.length !== entries.length) {
      await saveHiddenPrompts(next);
      promptsCache.clear();
      analyzeCache.clear();
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Full-text search across sessions
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const platform = req.query.platform || 'openclaw';
    const agent = sanitizeAgentName(req.query.agent || '') || '';
    const maxResults = Math.min(parseInt(req.query.limit) || 50, 100);
    if (!q) return res.json([]);
    // Multi-keyword AND search: whitespace-separated keywords must all appear
    // somewhere in a session's text records; snippets come from the first keyword.
    const keywords = q.split(/\s+/).filter(Boolean);

    // Per-platform dir overrides: `dir` applies to the selected platform;
    // in `all` mode use dirOpenclaw/dirCodex/dirClaude/dirHermes/dirOmp.
    const all = platform === 'all';
    const dirFor = (key, fallback) => resolveDir(all ? req.query[key] : req.query.dir, fallback);

    if (platform === 'hermes' && !all) {
      const dir = resolveDir(req.query.dir, HERMES_DIR);
      return res.json(searchHermesSessions(dir, q, maxResults));
    }

    // Collect candidate files per platform in parallel, then merge in a
    // stable order: openclaw, codex, claude-code, omp, dsh, gemini.
    const openclawFiles = [];
    const codexFiles = [];
    const claudeFiles = [];
    const ompFiles = [];
    const dshFiles = [];
    const geminiFiles = [];

    await Promise.all([
      (async () => {
        if (platform !== 'openclaw' && !all) return;
        const dir = dirFor('dirOpenclaw', DATA_DIR);
        const agents = agent && !all ? [agent] : await readAgents(dir).catch(() => []);
        for (const a of agents) {
          const agentDir = path.join(dir, a, 'sessions');
          try {
            const entries = await fsp.readdir(agentDir);
            for (const f of entries) {
              if (f.endsWith('.jsonl') && !isArchivedFile(f)) {
                openclawFiles.push({ path: path.join(agentDir, f), file: f, agent: a, platform: 'openclaw' });
              }
            }
          } catch {
            /* no sessions */
          }
        }
      })(),
      (async () => {
        if (platform !== 'codex' && !all) return;
        const dir = dirFor('dirCodex', CODEX_DIR);
        try {
          // Codex sessions live at <dir>/YYYY/MM/DD/rollout-*.jsonl
          const entries = await fsp.readdir(dir, { recursive: true });
          for (const rel of entries) {
            if (typeof rel === 'string' && rel.endsWith('.jsonl')) {
              const file = path.basename(rel);
              // Session list ids are the trailing UUID, not the full rollout-* stem
              const uuid = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
              codexFiles.push({
                path: path.join(dir, rel),
                file,
                sessionId: uuid ? uuid[1] : codexSessionIdFromFile(file),
                platform: 'codex',
              });
            }
          }
        } catch {}
      })(),
      (async () => {
        if (platform !== 'claude-code' && !all) return;
        const dir = dirFor('dirClaude', CLAUDE_CODE_DIR);
        try {
          // Claude Code sessions live at <dir>/<project-slug>/*.jsonl
          const slugs = await fsp.readdir(dir, { withFileTypes: true });
          for (const s of slugs) {
            if (!s.isDirectory()) continue;
            const slugDir = path.join(dir, s.name);
            const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
            for (const f of entries) {
              if (f.isFile() && f.name.endsWith('.jsonl')) {
                claudeFiles.push({ path: path.join(slugDir, f.name), file: f.name, platform: 'claude-code' });
              }
            }
          }
        } catch {}
      })(),
      (async () => {
        if (platform !== 'omp' && !all) return;
        const dir = dirFor('dirOmp', OMP_DIR);
        try {
          const slugs = await fsp.readdir(dir, { withFileTypes: true });
          for (const s of slugs) {
            if (!s.isDirectory()) continue;
            const slugDir = path.join(dir, s.name);
            const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
            for (const f of entries) {
              if (f.isFile() && f.name.endsWith('.jsonl')) {
                ompFiles.push({
                  path: path.join(slugDir, f.name),
                  file: f.name,
                  sessionId: ompSessionIdFromFile(f.name),
                  platform: 'omp',
                });
              }
            }
          }
        } catch {}
      })(),
      (async () => {
        if (platform !== 'dsh' && !all) return;
        const dir = dirFor('dirDsh', DSH_DIR);
        try {
          // dsh sessions live at <dir>/<projectKey>/<sessionId>/session.jsonl[.zstd]
          const projects = await fsp.readdir(dir, { withFileTypes: true });
          for (const p of projects) {
            if (!p.isDirectory()) continue;
            const projDir = path.join(dir, p.name);
            const sessionDirs = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
            for (const s of sessionDirs) {
              if (!s.isDirectory()) continue;
              const sessionDir = path.join(projDir, s.name);
              const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
              const logFile = entries.find(
                (f) => f.isFile() && (f.name === 'session.jsonl.zstd' || f.name === 'session.jsonl')
              );
              if (logFile) {
                dshFiles.push({
                  path: path.join(sessionDir, logFile.name),
                  file: logFile.name,
                  sessionId: s.name,
                  platform: 'dsh',
                });
              }
            }
          }
        } catch {}
      })(),
      (async () => {
        if (platform !== 'gemini' && !all) return;
        const dir = dirFor('dirGemini', GEMINI_DIR);
        try {
          // gemini sessions live at <dir>/<projectHash>/chats/session-*.jsonl
          const projects = await fsp.readdir(dir, { withFileTypes: true });
          for (const p of projects) {
            if (!p.isDirectory()) continue;
            const chatsDir = path.join(dir, p.name, 'chats');
            const entries = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
            for (const f of entries) {
              if (f.isFile() && /^session-.*\.jsonl$/.test(f.name)) {
                geminiFiles.push({
                  path: path.join(chatsDir, f.name),
                  file: f.name,
                  platform: 'gemini',
                });
              }
            }
          }
        } catch {}
      })(),
    ]);

    const sessionFiles = [...openclawFiles, ...codexFiles, ...claudeFiles, ...ompFiles];

    const results = [];

    for (const sf of sessionFiles) {
      if (results.length >= maxResults) break;
      const matches = [];
      const seen = new Set(); // keywords found so far in this session
      const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let sessionId = sf.sessionId || sf.file.split('.jsonl')[0];

      try {
        for await (const line of rl) {
          if (matches.length >= 3 && seen.size === keywords.length) break; // max 3 matches per session
          const lower = line.toLowerCase();
          if (!keywords.some((kw) => lower.includes(kw))) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }

          // Extract session id
          if (rec.type === 'session' && rec.id) sessionId = rec.id;
          if (rec.payload?.id && !sessionId) sessionId = rec.payload.id;
          if (rec.sessionId) sessionId = rec.sessionId;

          // Extract text content for matching
          let text = '';
          let role = '';
          const msg = rec.message || rec.payload || {};
          role = msg.role || rec.type || '';
          const content = Array.isArray(msg.content)
            ? msg.content
            : typeof msg.content === 'string'
              ? [{ type: 'text', text: msg.content }]
              : [];
          text = content
            .filter((c) => c.type === 'text' || c.type === 'input_text')
            .map((c) => c.text || '')
            .join(' ');

          const textLower = text.toLowerCase();
          for (const kw of keywords) {
            if (textLower.includes(kw)) seen.add(kw);
          }
          if (matches.length < 3 && textLower.includes(keywords[0])) {
            // Extract snippet around the first keyword's match
            const idx = textLower.indexOf(keywords[0]);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + keywords[0].length + 60);
            const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
            matches.push({ role, snippet, timestamp: rec.timestamp || null });
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }

      if (matches.length > 0 && seen.size === keywords.length) {
        results.push({
          sessionId,
          file: sf.file,
          platform: sf.platform,
          ...(sf.agent ? { agent: sf.agent } : {}),
          matches,
        });
      }
    }

    // dsh logs may be zstd-compressed and nest text under event.data —
    // search them via the adapter's line reader instead of the raw stream.
    for (const sf of dshFiles) {
      if (results.length >= maxResults) break;
      let lines;
      try {
        lines = await readDshSessionLines(sf.path);
      } catch {
        continue;
      }
      const matches = [];
      const seen = new Set();
      let sessionId = sf.sessionId;
      for (const line of lines) {
        if (matches.length >= 3 && seen.size === keywords.length) break;
        const lower = line.toLowerCase();
        if (!keywords.some((kw) => lower.includes(kw))) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === 'session' && rec.id) sessionId = rec.id;
        const data = rec.data || {};
        const msg = rec.type === 'user/message' ? data : data.message || {};
        const role = msg.role || rec.type || '';
        const content = Array.isArray(msg.content) ? msg.content : [];
        const text = content
          .filter((c) => c.type === 'text' || c.type === 'reasoning')
          .map((c) => c.text || '')
          .join(' ');
        const textLower = text.toLowerCase();
        for (const kw of keywords) {
          if (textLower.includes(kw)) seen.add(kw);
        }
        if (matches.length < 3 && textLower.includes(keywords[0])) {
          const idx = textLower.indexOf(keywords[0]);
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + keywords[0].length + 60);
          const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
          matches.push({
            role,
            snippet,
            timestamp: typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null,
          });
        }
      }
      if (matches.length > 0 && seen.size === keywords.length) {
        results.push({ sessionId, file: sf.file, platform: 'dsh', matches });
      }
    }

    // Gemini records keep text at the top level (content: string | Part[]) and
    // fold history via $rewindTo/$set — reuse the adapter's fold, then match.
    for (const sf of geminiFiles) {
      if (results.length >= maxResults) break;
      let folded;
      try {
        const text = await fsp.readFile(sf.path, 'utf8');
        folded = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
      } catch {
        continue;
      }
      const matches = [];
      const seen = new Set();
      const sessionId = folded.metadata.sessionId || sf.file.replace(/\.jsonl$/, '');
      for (const rec of folded.messages) {
        if (matches.length >= 3 && seen.size === keywords.length) break;
        const parts = [];
        if (typeof rec.content === 'string') parts.push(rec.content);
        else if (Array.isArray(rec.content)) {
          for (const p of rec.content) if (p && typeof p.text === 'string') parts.push(p.text);
        }
        const text = parts.join(' ');
        const textLower = text.toLowerCase();
        for (const kw of keywords) {
          if (textLower.includes(kw)) seen.add(kw);
        }
        if (matches.length < 3 && textLower.includes(keywords[0])) {
          const idx = textLower.indexOf(keywords[0]);
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + keywords[0].length + 60);
          const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
          matches.push({
            role: rec.type === 'gemini' ? 'assistant' : rec.type || '',
            snippet,
            timestamp: rec.timestamp || null,
          });
        }
      }
      if (matches.length > 0 && seen.size === keywords.length) {
        results.push({ sessionId, file: sf.file, platform: 'gemini', matches });
      }
    }

    // Claude Code: also surface prompt history (~/.claude/history.jsonl) so sessions
    // removed by Claude's cleanupPeriodDays retention still leave a searchable trace.
    if (platform === 'claude-code' || all) {
      const dir = dirFor('dirClaude', CLAUDE_CODE_DIR);
      const historyPath = path.join(path.dirname(dir), 'history.jsonl');
      const liveSnippets = new Set(results.flatMap((r) => r.matches.map((m) => m.snippet)));
      const byProject = new Map(); // project → matches[]
      try {
        const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            const lower = line.toLowerCase();
            if (!keywords.every((kw) => lower.includes(kw))) continue;
            let rec;
            try {
              rec = JSON.parse(line);
            } catch {
              continue;
            }
            const text = typeof rec.display === 'string' ? rec.display : '';
            const textLower = text.toLowerCase();
            if (!keywords.every((kw) => textLower.includes(kw))) continue;
            const idx = textLower.indexOf(keywords[0]);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + keywords[0].length + 60);
            const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
            const project = rec.project || '?';
            if (liveSnippets.has(snippet)) continue; // prompt belongs to a still-live session
            if (!byProject.has(project)) byProject.set(project, []);
            const matches = byProject.get(project);
            if (matches.length < 5) matches.push({ role: 'user', snippet, timestamp: rec.timestamp || null });
          }
        } finally {
          rl.close();
          stream.destroy();
        }
        for (const [project, matches] of byProject) {
          if (results.length >= maxResults) break;
          results.push({
            sessionId: null,
            file: 'history.jsonl',
            platform: 'claude-code',
            project,
            history: true,
            matches,
          });
        }
      } catch {
        /* no history file */
      }
    }

    // Hermes stores sessions in SQLite; merge its hits in all-platform mode
    if (all) {
      try {
        const remaining = Math.max(0, maxResults - results.length);
        if (remaining > 0) {
          results.push(...searchHermesSessions(dirFor('dirHermes', HERMES_DIR), q, remaining));
        }
      } catch {
        /* no hermes db */
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:name/sessions', async (req, res) => {
  const agentName = sanitizeAgentName(req.params.name);
  if (!agentName) {
    return res.status(400).json({ error: 'Invalid agent name' });
  }

  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const sessions = await listSessionsForAgent(dir, agentName, req.query.include_archived === 'true');
    res.json(sessions);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:name/sessions/:sessionId', async (req, res) => {
  const agentName = sanitizeAgentName(req.params.name);
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!agentName || !sessionId) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const filePath = await resolveSessionFile(dir, agentName, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spawn-map', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const spawnLinks = await buildSpawnMap(dir);
    res.json(spawnLinks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spawn-tree', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const tree = await buildSpawnTree(dir);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spawn-tree/:sessionId', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DATA_DIR);
    const full = await buildSpawnTree(dir);
    const sid = req.params.sessionId;
    // Find tree rooted at this session, or find this session as a child
    function findNode(nodes, targetId) {
      for (const n of nodes) {
        if (n.id === targetId) return n;
        const found = findNode(n.children || [], targetId);
        if (found) return found;
      }
      return null;
    }
    // Find parent of this session
    function findParent(nodes, targetId, parent) {
      for (const n of nodes) {
        if (n.id === targetId) return parent;
        const found = findParent(n.children || [], targetId, n);
        if (found) return found;
      }
      return null;
    }
    const node = findNode(full.trees, sid);
    const parent = findParent(full.trees, sid, null);
    res.json({
      node: node || null,
      parent: parent || null,
      totalSessions: full.totalSessions,
      totalSpawnCalls: full.totalSpawnCalls,
      matchedLinks: full.matchedLinks,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Codex platform ---

app.get('/api/codex/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, CODEX_DIR);
    const sessions = await listCodexSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/codex/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, CODEX_DIR);
    const filePath = await findCodexSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseCodexSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- DeepSeek Harness (dsh) platform ---

app.get('/api/dsh/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, DSH_DIR);
    const sessions = await listDshSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dsh/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, DSH_DIR);
    const filePath = await findDshSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseDshSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Gemini CLI platform ---

app.get('/api/gemini/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, GEMINI_DIR);
    const sessions = await listGeminiSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gemini/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, GEMINI_DIR);
    const filePath = await findGeminiSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseGeminiSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- OMP platform ---

app.get('/api/omp/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const sessions = await listOmpSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/omp/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const filePath = await findOmpSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseOmpSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/omp/sessions/:sessionId/children', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const spawnDir = await findOmpSpawnDir(dir, sessionId);
    if (!spawnDir) return res.json([]);
    const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
    const children = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const meta = await parseOmpSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
      children.push({
        name: e.name.replace(/\.jsonl$/, ''),
        file: e.name,
        title: meta?.title || null,
        timestamp: meta?.timestamp || null,
        lastActivity: meta?.lastActivity || null,
        messageCount: meta?.messageCount || 0,
        toolCallCount: meta?.toolCallCount || 0,
      });
    }
    children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    res.json(children);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/omp/sessions/:sessionId/children/:name', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  const name = sanitizeAgentName(req.params.name);
  if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
  try {
    const dir = resolveDir(req.query.dir, OMP_DIR);
    const spawnDir = await findOmpSpawnDir(dir, sessionId);
    if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
    const payload = await parseOmpSessionFile(path.join(spawnDir, name + '.jsonl'));
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
    res.status(500).json({ error: error.message });
  }
});

// --- Hermes platform (SQLite) ---

app.get('/api/hermes/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, HERMES_DIR);
    const sessions = listHermesSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/hermes/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, HERMES_DIR);
    const payload = getHermesSession(dir, sessionId);
    if (!payload) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Claude Code platform ---

app.get('/api/claude-code/sessions', async (req, res) => {
  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const sessions = await listClaudeCodeSessions(dir);
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/claude-code/sessions/:sessionId', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const filePath = await findClaudeCodeSessionFile(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const payload = await parseClaudeCodeSessionFile(filePath);
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/claude-code/sessions/:sessionId/children', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const spawnDir = await findClaudeSpawnDir(dir, sessionId);
    if (!spawnDir) return res.json([]);
    const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
    const children = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
      const stem = e.name.replace(/\.jsonl$/, '');
      const meta = await parseClaudeCodeSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
      let agentMeta = null;
      try {
        agentMeta = JSON.parse(await fsp.readFile(path.join(spawnDir, stem + '.meta.json'), 'utf8'));
      } catch {
        /* absent or corrupt meta.json */
      }
      children.push({
        name: stem,
        file: e.name,
        title: meta?.title || null,
        timestamp: meta?.timestamp || null,
        lastActivity: meta?.lastActivity || null,
        messageCount: meta?.messageCount || 0,
        toolCallCount: meta?.toolCallCount || 0,
        agentType: agentMeta?.agentType || null,
        description: agentMeta?.description || null,
      });
    }
    children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    res.json(children);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/claude-code/sessions/:sessionId/children/:name', async (req, res) => {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  const name = sanitizeAgentName(req.params.name);
  if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
  try {
    const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
    const spawnDir = await findClaudeSpawnDir(dir, sessionId);
    if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
    const payload = await parseClaudeCodeSessionFile(path.join(spawnDir, name + '.jsonl'));
    res.json(payload);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/otlp/:platform/:sessionId', async (req, res) => {
  const platform = OTLP_PLATFORMS[req.params.platform];
  if (!platform) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const dir = resolveDir(req.query.dir, platform.defaultDir());
    const filePath = await platform.find(dir, sessionId);
    if (!filePath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const { messages } = await platform.parse(filePath);
    res.json(buildOtlpPayload(messages, sessionId));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Session export: shareable Markdown / self-contained HTML ---
// GET /api/:platform/sessions/:sessionId/export?format=md|html
//   [&agent=NAME]        openclaw only — which agent owns the session
//   [&dir=PATH]          same override as the detail routes
//   [&maxToolBytes=N]    cap each tool result (full by default)
// Responds with a Content-Disposition attachment; secrets are scrubbed
// best-effort (sk-… keys, Authorization headers, bearer/vendor tokens).
app.get('/api/:platform/sessions/:sessionId/export', async (req, res) => {
  const platformName = req.params.platform;
  const platform = EXPORT_PLATFORMS[platformName];
  if (!platform) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  const format = String(req.query.format || 'md').toLowerCase();
  if (format !== 'md' && format !== 'html') {
    return res.status(400).json({ error: 'Invalid format: expected md or html' });
  }
  const agent = req.query.agent ? sanitizeAgentName(req.query.agent) : null;
  if (platformName === 'openclaw' && !agent) {
    return res.status(400).json({ error: 'agent query parameter is required for openclaw exports' });
  }
  const maxToolBytes = req.query.maxToolBytes ? Math.max(0, parseInt(req.query.maxToolBytes, 10) || 0) : 0;

  try {
    const dir = resolveDir(req.query.dir, platform.defaultDir());
    const payload = await platform.load(dir, sessionId, { agent });
    if (!payload) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const opts = { maxToolBytes };
    const body =
      format === 'html'
        ? renderSessionHtml(platformName, payload, opts)
        : renderSessionMarkdown(platformName, payload, opts);
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    res.setHeader('Content-Type', format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agentxray-${safeId}.${format}"`);
    res.send(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Prompt Library: curated prompts stored as markdown files with frontmatter ---

startLibraryGit();

app.get('/api/library', async (req, res) => {
  try {
    let entries;
    try {
      entries = await fsp.readdir(LIBRARY_DIR);
    } catch (error) {
      if (error.code === 'ENOENT') return res.json({ prompts: [] });
      throw error;
    }
    const names = entries
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -3))
      .filter((name) => LIBRARY_NAME_RE.test(name));
    const prompts = await Promise.all(names.map((name) => readLibraryPrompt(name)));
    prompts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ prompts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library', async (req, res) => {
  try {
    const body = req.body || {};
    const name = sanitizeLibraryName(body.name);
    if (!name) {
      return res.status(400).json({ error: 'Invalid name: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
    }
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    const meta = {
      description: typeof body.description === 'string' ? body.description : '',
      tags: normalizeLibraryTags(body.tags),
      source: typeof body.source === 'string' && body.source ? body.source : 'manual',
      createdAt: new Date().toISOString(),
    };
    await fsp.mkdir(LIBRARY_DIR, { recursive: true });
    try {
      await fsp.writeFile(libraryFilePath(name), serializeLibraryFile(meta, content), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') return res.status(409).json({ error: `Prompt "${name}" already exists` });
      throw error;
    }
    commitLibrary(`create: ${name}`);
    res.status(201).json({ prompt: await readLibraryPrompt(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/library/usage', async (req, res) => {
  try {
    const cachedUsage = getLibraryUsageCache();
    if (cachedUsage) {
      return res.json(cachedUsage);
    }
    let entries = [];
    try {
      entries = await fsp.readdir(LIBRARY_DIR);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const names = entries
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -3))
      .filter((name) => LIBRARY_NAME_RE.test(name));
    const data = { usage: names.length ? await computeLibraryUsage(names) : {} };
    setLibraryUsageCache(data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/library/:name', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const body = req.body || {};
    let raw;
    try {
      raw = await fsp.readFile(libraryFilePath(name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    const { meta, content } = parseLibraryFile(raw);

    let newName = name;
    if (body.newName !== undefined && body.newName !== name) {
      newName = sanitizeLibraryName(body.newName);
      if (!newName) {
        return res.status(400).json({ error: 'Invalid newName: must match /^[a-z0-9][a-z0-9-]{0,63}$/' });
      }
      const exists = await fsp.access(libraryFilePath(newName)).then(
        () => true,
        () => false
      );
      if (exists) return res.status(409).json({ error: `Prompt "${newName}" already exists` });
    }

    if (body.description !== undefined) meta.description = typeof body.description === 'string' ? body.description : '';
    if (body.tags !== undefined) meta.tags = normalizeLibraryTags(body.tags);
    const nextContent = body.content !== undefined ? String(body.content) : content;
    if (!nextContent.trim()) {
      return res.status(400).json({ error: 'content must not be empty' });
    }

    await fsp.writeFile(libraryFilePath(newName), serializeLibraryFile(meta, nextContent), 'utf8');
    if (newName !== name) {
      await fsp.unlink(libraryFilePath(name)).catch(() => {});
    }

    // Refresh installed copies; a rename also renames them
    for (const target of Object.keys(INSTALL_TARGETS)) {
      const wasInstalled = await fsp.access(installedFilePath(target, name)).then(
        () => true,
        () => false
      );
      if (!wasInstalled) continue;
      if (newName !== name) await uninstallLibraryPrompt(name, [target]);
      await installLibraryPrompt({ name: newName, description: meta.description, content: nextContent }, [target]);
    }

    commitLibrary(newName !== name ? `rename: ${name} -> ${newName}` : `update: ${newName}`);

    res.json({ prompt: await readLibraryPrompt(newName) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/library/:name', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    try {
      await fsp.unlink(libraryFilePath(name));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    await uninstallLibraryPrompt(name, Object.keys(INSTALL_TARGETS));
    commitLibrary(`delete: ${name}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library/:name/install', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const targets = parseInstallTargets(req.body);
    if (!targets) {
      return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
    }
    let prompt;
    try {
      prompt = await readLibraryPrompt(name);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Prompt not found' });
      throw error;
    }
    await installLibraryPrompt(prompt, targets);
    res.json({ installed: await detectInstalled(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/library/:name/uninstall', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    const targets = parseInstallTargets(req.body);
    if (!targets) {
      return res.status(400).json({ error: 'targets must be a non-empty array of "claude" | "codex" | "omp"' });
    }
    await uninstallLibraryPrompt(name, targets);
    res.json({ installed: await detectInstalled(name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Suggest a kebab-case slash-command name for a prompt via the local claude CLI.
// Always replies { name } — name is null when the CLI is missing or its output
// can't be shaped into a valid library name. 400 only for a missing/empty text.
app.post('/api/library/suggest-name', async (req, res) => {
  const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const prompt = [
    'Suggest a short slash-command name for the prompt below.',
    'Reply with ONLY the name: 2-4 English words, kebab-case, ascii lowercase letters/digits/dashes.',
    'No explanation, no quotes, no punctuation other than dashes.',
    '',
    'Prompt:',
    text.slice(0, 500),
  ].join('\n');
  try {
    const raw = await runClaudeCli(prompt, 10_000);
    const name = raw
      .trim()
      .split('\n')
      .pop()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64)
      .replace(/^-+|-+$/g, '');
    res.json({ name: sanitizeLibraryName(name) });
  } catch {
    res.json({ name: null });
  }
});

// Available fabric pattern names, flagged with whether each is already in the
// library (checked against the sanitized name the import would use).
app.get('/api/library/fabric-patterns', async (req, res) => {
  try {
    let names;
    try {
      names = await listFabricPatternNames();
    } catch (error) {
      return res.status(502).json({ error: `Could not fetch fabric patterns: ${error.message}` });
    }
    const existing = await listLibraryNames();
    res.json({ patterns: names.map((name) => ({ name, imported: existing.has(fabricLibraryName(name)) })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import fabric patterns by name: downloads each pattern's system.md and
// creates a library entry. Result arrays echo the requested (raw) names.
app.post('/api/library/import-fabric', async (req, res) => {
  try {
    const names = Array.isArray((req.body || {}).names) ? req.body.names : null;
    if (!names || names.length < 1 || names.length > 300 || !names.every((name) => typeof name === 'string' && name)) {
      return res.status(400).json({ error: 'names must be an array of 1-300 pattern names' });
    }
    await fsp.mkdir(LIBRARY_DIR, { recursive: true });
    const existing = await listLibraryNames();
    const imported = [];
    const skipped = [];
    const failed = [];
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(
        names.slice(i, i + 8).map(async (rawName) => {
          const name = fabricLibraryName(rawName);
          if (!name) return failed.push(rawName);
          if (existing.has(name)) return skipped.push(rawName);
          try {
            const content = await fetchFabricPattern(rawName);
            if (!content.trim()) throw new Error('empty pattern');
            const meta = {
              description: fabricDescription(content),
              tags: ['fabric'],
              source: 'fabric',
              createdAt: new Date().toISOString(),
            };
            await fsp.writeFile(libraryFilePath(name), serializeLibraryFile(meta, content), {
              encoding: 'utf8',
              flag: 'wx',
            });
            existing.add(name);
            imported.push(rawName);
          } catch (error) {
            if (error.code === 'EEXIST') skipped.push(rawName);
            else failed.push(rawName);
          }
        })
      );
    }
    if (imported.length) {
      commitLibrary(
        `import: ${imported.length === 1 ? fabricLibraryName(imported[0]) : `${imported.length} fabric patterns`}`
      );
    }
    res.json({ imported, skipped, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Commit history for one prompt. No repo / never committed → { commits: [] }.
app.get('/api/library/:name/history', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  try {
    const log = await gitLibrary(['log', '--follow', '--format=%H%x09%cI%x09%s', '--', `${name}.md`]);
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...message] = line.split('\t');
        return { hash, date, message: message.join('\t') };
      });
    res.json({ commits });
  } catch {
    res.json({ commits: [] });
  }
});

// The prompt as of a given commit
app.get('/api/library/:name/history/:hash', async (req, res) => {
  const name = sanitizeLibraryName(req.params.name);
  if (!name) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  if (!/^[0-9a-f]{7,40}$/.test(req.params.hash)) {
    return res.status(400).json({ error: 'Invalid hash' });
  }
  try {
    const raw = await gitLibrary(['show', `${req.params.hash}:${name}.md`]);
    const { meta, content } = parseLibraryFile(raw);
    res.json({ content, description: meta.description, tags: meta.tags });
  } catch {
    res.status(404).json({ error: 'Revision not found' });
  }
});

// --- Backup ---
// Auto-backup: once shortly after startup, then daily. Failures are logged, never fatal.
setTimeout(runAutoBackup, 10_000).unref();
setInterval(runAutoBackup, AUTO_BACKUP_INTERVAL_MS).unref();

app.post('/api/backup', async (req, res) => {
  try {
    res.json(await runFullBackup());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backup/status', async (req, res) => {
  try {
    let files = 0;
    let bytes = 0;
    let newest = 0;
    try {
      const entries = await fsp.readdir(ARCHIVE_DIR, { recursive: true });
      for (const rel of entries) {
        if (typeof rel !== 'string') continue;
        const st = await fsp.stat(path.join(ARCHIVE_DIR, rel)).catch(() => null);
        if (!st || !st.isFile()) continue;
        files++;
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch {
      /* no archive yet */
    }
    res.json({ archiveDir: ARCHIVE_DIR, files, bytes, lastBackup: newest ? new Date(newest).toISOString() : null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========= Real-time SSE tail endpoint =========
// GET /api/watch?platform=openclaw&agent=NAME&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=codex&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=claude-code&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=hermes&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=omp&sessionId=ID[&dir=PATH]
// Streams Server-Sent Events:
//   event: connected     data: {"messageCount": N}
//   event: newMessages   data: {"messages": [...normalized], "session": {...}}
//   event: error         data: {"error": "..."}

app.get('/api/watch', async (req, res) => {
  const platform = req.query.platform || 'openclaw';
  const agentName = sanitizeAgentName(req.query.agent || '');
  const sessionId = sanitizeSessionId(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  // Resolve the JSONL file path
  let filePath;
  try {
    if (platform === 'openclaw') {
      if (!agentName) return res.status(400).json({ error: 'agent required for openclaw' });
      const dir = resolveDir(req.query.dir, DATA_DIR);
      filePath = await resolveSessionFile(dir, agentName, sessionId);
    } else if (platform === 'codex') {
      const dir = resolveDir(req.query.dir, CODEX_DIR);
      filePath = await findCodexSessionFile(dir, sessionId);
    } else if (platform === 'dsh') {
      const dir = resolveDir(req.query.dir, DSH_DIR);
      filePath = await findDshSessionFile(dir, sessionId);
    } else if (platform === 'gemini') {
      const dir = resolveDir(req.query.dir, GEMINI_DIR);
      filePath = await findGeminiSessionFile(dir, sessionId);
    } else if (platform === 'claude-code') {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      filePath = await findClaudeCodeSessionFile(dir, sessionId);
    } else if (platform === 'omp') {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      filePath = await findOmpSessionFile(dir, sessionId);
    } else if (platform === 'hermes') {
      // Hermes uses SQLite, not file-based SSE — handle separately below
    } else {
      return res.status(400).json({ error: 'Unknown platform' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!filePath && platform !== 'hermes') return res.status(404).json({ error: 'Session not found' });

  // Hermes: WAL file watch-based SSE
  if (platform === 'hermes') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sendHermes(eventName, data) {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const hermesDir = resolveDir(req.query.dir, HERMES_DIR);
    const dbPath = getHermesDbPath(hermesDir);
    const walPath = dbPath + '-wal';

    // Keep one persistent read-only connection
    let db = null;
    let lastTimestamp = 0;
    try {
      if (fs.existsSync(dbPath)) {
        db = openHermesDbForWatch(dbPath);
        const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId);
        sendHermes('connected', { messageCount: row ? row.cnt : 0 });
        const lastMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?').get(sessionId);
        lastTimestamp = lastMsg?.ts || 0;
      } else {
        sendHermes('connected', { messageCount: 0 });
      }
    } catch (e) {
      sendHermes('error', { error: e.message });
    }

    const newMsgStmt = db
      ? db.prepare('SELECT * FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC')
      : null;

    function checkNewMessages() {
      if (!db || !newMsgStmt) return;
      try {
        const newRows = newMsgStmt.all(sessionId, lastTimestamp);
        if (newRows.length > 0) {
          lastTimestamp = newRows[newRows.length - 1].timestamp;
          const newMsgs = newRows.map(normalizeHermesMessage).filter(Boolean);
          if (newMsgs.length > 0) {
            sendHermes('newMessages', { messages: newMsgs });
          }
        }
      } catch (e) {
        sendHermes('error', { error: e.message });
      }
    }

    // Watch WAL file for changes (Hermes writes trigger WAL updates)
    let closed = false;
    let debounceTimer = null;
    let watcher = null;
    try {
      watcher = fs.watch(walPath, (eventType) => {
        if (eventType === 'change') {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(checkNewMessages, 50);
        }
      });
    } catch {
      // WAL file may not exist yet — watch dbPath as fallback
      try {
        watcher = fs.watch(dbPath, (eventType) => {
          if (eventType === 'change') {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(checkNewMessages, 50);
          }
        });
      } catch {}
    }

    const pingTimer = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearTimeout(debounceTimer);
      clearInterval(pingTimer);
      if (watcher)
        try {
          watcher.close();
        } catch {}
      if (db) {
        try {
          db.close();
        } catch {}
        db = null;
      }
    });
    return;
  }

  // Helper: read new lines from a byte offset, return {lines, newOffset}.
  // dsh zstd logs append whole zstd frames: decompress every complete new
  // frame and leave a torn trailing frame for the next read.
  async function readNewLines(byteOffset) {
    const stat = await fsp.stat(filePath);
    if (stat.size <= byteOffset) return { lines: [], newOffset: byteOffset };
    const buf = Buffer.alloc(stat.size - byteOffset);
    const fd = await fsp.open(filePath, 'r');
    try {
      await fd.read(buf, 0, buf.length, byteOffset);
    } finally {
      await fd.close();
    }
    if (platform === 'dsh' && filePath.endsWith('.zstd')) {
      // Only advance past complete frames — a torn trailing frame is retried
      // on the next change event once its remaining bytes land.
      const { frames } = scanZstdFrames(buf);
      const consumed = frames.length ? frames[frames.length - 1].end : 0;
      const text = decompressDshLog(buf.subarray(0, consumed));
      const lines = text.split('\n').filter((l) => l.trim());
      return { lines, newOffset: byteOffset + consumed };
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    return { lines, newOffset: stat.size };
  }

  // Helper: normalize lines according to platform
  function parseLines(lines) {
    const messages = [];
    let sessionMeta = null;
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (platform === 'openclaw') {
        if (rec.type === 'session') {
          sessionMeta = { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp };
        } else if (rec.type === 'message') {
          messages.push(normalizeMessage(rec));
        }
      } else if (platform === 'codex') {
        const normalized = normalizeCodexRecord(rec);
        if (normalized) messages.push(normalized);
      } else if (platform === 'dsh') {
        if (rec.type === 'session') {
          sessionMeta = {
            id: rec.id,
            cwd: rec.cwd || null,
            timestamp: typeof rec.createdAt === 'number' ? new Date(rec.createdAt).toISOString() : null,
          };
        } else {
          const normalized = normalizeDshEvents([line]);
          if (normalized.length) messages.push(...normalized);
        }
      } else if (platform === 'gemini') {
        // Appended records carry an id; a re-appended id supersedes the
        // earlier one, which the client-side reload handles. Metadata lines
        // ({sessionId, …}) and $set/$rewindTo folds carry no new messages.
        if (typeof rec.id === 'string') {
          const normalized = normalizeGeminiRecord(rec);
          if (normalized.length) messages.push(...normalized);
        } else if (typeof rec.sessionId === 'string') {
          sessionMeta = { id: rec.sessionId, cwd: null, timestamp: rec.startTime || null };
        }
      } else if (platform === 'claude-code') {
        const normalized = normalizeClaudeCodeRecord(rec);
        if (normalized) messages.push(normalized);
      } else if (platform === 'omp') {
        if (rec.type === 'session') {
          sessionMeta = { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp };
        } else {
          const normalized = normalizeOmpRecord(rec);
          if (normalized && normalized.length) messages.push(...normalized);
        }
      }
    }
    return { messages, sessionMeta };
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Do initial full parse to know current message count + byte offset
  let byteOffset = 0;
  let initialMessageCount = 0;
  try {
    // readNewLines(0) is platform-aware (dsh zstd frames vs plain JSONL) and
    // reports the offset actually consumed — a torn trailing zstd frame stays
    // pending for the first change event.
    const { lines, newOffset } = await readNewLines(0);
    byteOffset = newOffset;
    // Count existing messages without sending them (client already has them)
    const { messages: existingMsgs } = parseLines(lines);
    initialMessageCount = existingMsgs.length;
  } catch (e) {
    send('error', { error: e.message });
    return res.end();
  }

  send('connected', { messageCount: initialMessageCount });

  // Watch for file changes
  let watcher;
  let debounceTimer = null;
  let closed = false;

  const onFileChange = async () => {
    if (closed) return;
    try {
      const { lines, newOffset } = await readNewLines(byteOffset);
      if (lines.length === 0) return;
      byteOffset = newOffset;
      const { messages, sessionMeta } = parseLines(lines);
      if (messages.length > 0) {
        const payload = { messages };
        if (sessionMeta) payload.session = sessionMeta;
        send('newMessages', payload);
      }
      // Invalidate metadata cache so next session list refresh picks up changes
      sessionMetaCache.delete(filePath);
    } catch (e) {
      send('error', { error: e.message });
    }
  };

  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce: batch rapid writes (e.g. multiple lines written close together)
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onFileChange, 80);
      }
    });
  } catch (e) {
    send('error', { error: `Cannot watch file: ${e.message}` });
    return res.end();
  }

  // Keepalive ping every 15s to prevent proxy timeouts
  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher) watcher.close();
  });
});

app.get('*', (req, res) => {
  if (HAS_DIST && req.path.startsWith('/legacy')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  res.sendFile(path.join(HAS_DIST ? DIST_DIR : PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AgentXRay listening on http://${HOST}:${PORT}`);
  console.log(`  OpenClaw:    ${DATA_DIR}`);
  console.log(`  Codex:       ${CODEX_DIR}`);
  console.log(`  Claude Code: ${CLAUDE_CODE_DIR}`);
  console.log(`  Hermes:      ${path.join(HERMES_DIR, 'state.db')}`);
  console.log(`  OMP:         ${OMP_DIR}`);
  console.log(`  DeepSeek Harness: ${DSH_DIR}`);
  console.log(`  Gemini CLI:  ${GEMINI_DIR}`);
});
