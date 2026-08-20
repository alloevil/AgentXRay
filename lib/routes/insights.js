const { sanitizeAgentName } = require('../config');
const { insightsCache, INSIGHTS_TTL_MS, getInsightsCacheKey, computeInsights } = require('../insights');
const {
  TOOL_AUDIT_PLATFORMS,
  TOOL_AUDIT_TTL_MS,
  toolAuditCache,
  computeToolAudit,
  loadPersistedToolAudit,
  savePersistedToolAudit,
} = require('../tool-audit');

// Aggregate analytics: insights dashboard + tools audit
module.exports = function mountInsightsRoutes(app) {
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
};
