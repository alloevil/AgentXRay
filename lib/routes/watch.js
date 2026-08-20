const fs = require('fs');
const { HERMES_DIR, sessionMetaCache, resolveDir, sanitizeAgentName, sanitizeSessionId } = require('../config');
const { PLATFORMS } = require('../platforms');
const { getHermesDbPath, openHermesDbForWatch, normalizeHermesMessage } = require('../platforms/hermes');
const { readNewLines, parseWatchLines } = require('../watch');

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
//
// Offset-advance and line-normalization logic live in lib/watch.js; this
// module keeps only the SSE plumbing (headers, fs.watch, timers, cleanup).

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// Hermes: WAL file watch-based SSE against the SQLite db
function watchHermes(req, res, sessionId) {
  const send = sseInit(res);

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
      send('connected', { messageCount: row ? row.cnt : 0 });
      const lastMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?').get(sessionId);
      lastTimestamp = lastMsg?.ts || 0;
    } else {
      send('connected', { messageCount: 0 });
    }
  } catch (e) {
    send('error', { error: e.message });
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
          send('newMessages', { messages: newMsgs });
        }
      }
    } catch (e) {
      send('error', { error: e.message });
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
}

// File-based platforms: byte-offset tail via fs.watch
async function watchFile(req, res, platform, filePath) {
  const send = sseInit(res);

  // Do initial full parse to know current message count + byte offset
  let byteOffset = 0;
  let initialMessageCount = 0;
  try {
    // readNewLines(…, 0) is platform-aware (dsh zstd frames vs plain JSONL)
    // and reports the offset actually consumed — a torn trailing zstd frame
    // stays pending for the first change event.
    const { lines, newOffset } = await readNewLines(filePath, 0);
    byteOffset = newOffset;
    // Count existing messages without sending them (client already has them)
    const { messages: existingMsgs } = parseWatchLines(platform, lines);
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
      const { lines, newOffset } = await readNewLines(filePath, byteOffset);
      if (lines.length === 0) return;
      byteOffset = newOffset;
      const { messages, sessionMeta } = parseWatchLines(platform, lines);
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
}

module.exports = function mountWatchRoutes(app) {
  app.get('/api/watch', async (req, res) => {
    const platformId = req.query.platform || 'openclaw';
    const platform = PLATFORMS[platformId];
    if (!platform) return res.status(400).json({ error: 'Unknown platform' });
    const agentName = sanitizeAgentName(req.query.agent || '');
    const sessionId = sanitizeSessionId(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (platform.needsAgent && !agentName) return res.status(400).json({ error: `agent required for ${platformId}` });

    if (platformId === 'hermes') return watchHermes(req, res, sessionId);

    let filePath = null;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      filePath = await platform.find(dir, sessionId, { agent: agentName });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!filePath) return res.status(404).json({ error: 'Session not found' });

    return watchFile(req, res, platform, filePath);
  });
};
