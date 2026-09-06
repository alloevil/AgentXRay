const express = require('express');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CODEX_DIR, CLAUDE_CODE_DIR, HERMES_DIR, OMP_DIR, DSH_DIR, GEMINI_DIR } = require('./lib/config');
const mountInsightsRoutes = require('./lib/routes/insights');
const mountPromptRoutes = require('./lib/routes/prompts');
const mountSearchRoutes = require('./lib/routes/search');
const mountSessionRoutes = require('./lib/routes/sessions');
const mountExportRoutes = require('./lib/routes/export');
const mountLibraryRoutes = require('./lib/routes/library');
const mountBackupRoutes = require('./lib/routes/backup');
const mountWatchRoutes = require('./lib/routes/watch');
const mountLlmRoutes = require('./lib/routes/llm');

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

// CSRF protection: reject state-changing requests whose Origin/Referer does
// not match the server's own Host header (same-origin check, no extra deps).
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer || '';
  const host = req.headers.host || '';
  if (origin && !origin.startsWith(`http://${host}`) && !origin.startsWith(`https://${host}`)) {
    return res.status(403).json({ error: 'Forbidden: CSRF check failed' });
  }
  next();
});

// Disable all caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// Route modules (lib/routes/*): business logic lives in lib/, routes keep
// only parameter validation and response shaping. Order matters only where
// paths overlap: the export route (/api/:platform/sessions/:id/export) is
// more specific than the generic session detail route, so it mounts first.
mountInsightsRoutes(app);
mountPromptRoutes(app);
mountSearchRoutes(app);
mountExportRoutes(app);
mountSessionRoutes(app);
mountLibraryRoutes(app);
mountBackupRoutes(app);
mountWatchRoutes(app);
mountLlmRoutes(app);

// SPA fallback: unknown paths render the appropriate UI shell
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
