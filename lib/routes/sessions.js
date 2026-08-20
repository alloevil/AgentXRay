const fsp = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  OMP_DIR,
  CLAUDE_CODE_DIR,
  resolveDir,
  sanitizeAgentName,
  sanitizeSessionId,
  readAgents,
} = require('../config');
const { PLATFORMS } = require('../platforms');
const { parseOmpSessionMetadata, parseOmpSessionFile, findOmpSpawnDir } = require('../platforms/omp');
const {
  parseClaudeCodeSessionMetadata,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
} = require('../platforms/claude');
const {
  listSessionsForAgent,
  resolveSessionFile,
  parseSessionFile,
  buildSpawnMap,
  buildSpawnTree,
} = require('../platforms/openclaw');

// Session browsing: agents, per-agent (openclaw) sessions, spawn tracking,
// the generic registry-driven platform routes, and subagent children.
module.exports = function mountSessionRoutes(app) {
  app.get('/api/agents', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const agents = await readAgents(dir);
      res.json(agents);
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

  // --- Generic platform session routes (registry-driven) ---
  // GET /api/:platform/sessions            → session list (newest first)
  // GET /api/:platform/sessions/:sessionId → normalized { session, messages }
  // openclaw is served by /api/agents/:name/sessions (per-agent listing) and
  // falls through here; platform-specific children routes are registered below.

  app.get('/api/:platform/sessions', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || !platform.list) return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      res.json(await platform.list(dir));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || platform.needsAgent) return next();
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await platform.getSession(dir, sessionId);
      if (!payload) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // --- OMP subagents ---

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

  // --- Claude Code subagents ---

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
};
