const { loadLlmConfig, saveLlmConfig, llmBackend } = require('../llm');

// LLM backend settings (#14): an OpenAI-compatible endpoint persisted
// server-side in ~/.agentxray/llm.json, taking priority over the claude CLI.
// GET never leaks the API key — only whether one is set.
module.exports = function mountLlmRoutes(app) {
  app.get('/api/settings/llm', async (_req, res) => {
    try {
      const config = await loadLlmConfig();
      res.json({
        baseUrl: config.baseUrl,
        model: config.model,
        hasApiKey: Boolean(config.apiKey),
        backend: await llmBackend(),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings/llm', async (req, res) => {
    try {
      const body = req.body || {};
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
        return res.status(400).json({ error: 'baseUrl must start with http:// or https://' });
      }
      if (baseUrl && !model) {
        return res.status(400).json({ error: 'model is required when baseUrl is set' });
      }
      const current = await loadLlmConfig();
      // apiKey semantics: absent = keep the stored key, '' = clear it, else replace.
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : current.apiKey;
      const saved = await saveLlmConfig({ baseUrl, apiKey: baseUrl ? apiKey : '', model });
      res.json({
        baseUrl: saved.baseUrl,
        model: saved.model,
        hasApiKey: Boolean(saved.apiKey),
        backend: await llmBackend(),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
