const { sanitizeAgentName } = require('../config');
const { searchSessions } = require('../search');

// Full-text search across sessions (business logic in lib/search.js)
module.exports = function mountSearchRoutes(app) {
  app.get('/api/search', async (req, res) => {
    try {
      const agent = sanitizeAgentName(req.query.agent || '') || '';
      res.json(await searchSessions(req.query, agent));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
