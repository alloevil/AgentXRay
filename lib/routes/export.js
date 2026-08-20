const { resolveDir, sanitizeAgentName, sanitizeSessionId } = require('../config');
const { OTLP_PLATFORMS, buildOtlpPayload } = require('../otlp');
const { EXPORT_PLATFORMS, renderSessionMarkdown, renderSessionHtml } = require('../export');

// Session export: OTLP trace JSON + shareable Markdown / self-contained HTML
module.exports = function mountExportRoutes(app) {
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
    if (platform.needsAgent && !agent) {
      return res.status(400).json({ error: `agent query parameter is required for ${platformName} exports` });
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
};
