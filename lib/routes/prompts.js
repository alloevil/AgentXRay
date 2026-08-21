const { normalizePromptText, hashPromptText } = require('../text-utils');
const { parseLlmJson } = require('../llm-json');
const { runLlm } = require('../llm');
const { sanitizeAgentName } = require('../config');
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
  loadPersistedAnalysis,
  computePromptAnalysis,
} = require('../prompts');

// Prompt tooling: extraction, analysis, rewrite, hidden-prompt store
module.exports = function mountPromptRoutes(app) {
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

  // Rewrite a single prompt via the configured LLM backend
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

      const raw = await runLlm(input, 120_000);
      const parsed = parseLlmJson(raw);
      if (!parsed || !parsed.rewrite) {
        return res.json({ rewrite: raw.trim().slice(0, 8000), rationale: null, raw: true });
      }
      res.json({ rewrite: parsed.rewrite, rationale: parsed.rationale || null });
    } catch (error) {
      if (error.code === 'NO_LLM_BACKEND') {
        return res.status(503).json({ error: error.message, code: 'NO_LLM_BACKEND' });
      }
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
};
