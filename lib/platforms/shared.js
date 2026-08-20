const fsp = require('fs/promises');
const { sessionMetaCache } = require('../config');

// --- Shared platform-adapter skeleton helpers ---
// Every adapter used to hand-roll these three pieces; they live here once.

// Wrap a raw metadata parser with the mtime cache: a file whose mtime hasn't
// changed since the last parse is served from sessionMetaCache.
function withMetadataCache(parseRaw) {
  return async function cachedMetadataParse(filePath, ...rest) {
    try {
      const stat = await fsp.stat(filePath);
      const cached = sessionMetaCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    } catch {
      // If stat fails, fall through to parse
    }

    const data = await parseRaw(filePath, ...rest);

    try {
      const stat = await fsp.stat(filePath);
      sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
    } catch {
      // Non-critical — just skip caching
    }

    return data;
  };
}

// The normalized message shape served by every session endpoint. This is the
// single definition site of the 11-field literal; adapters override only the
// fields their record actually carries.
function makeMessage(overrides) {
  return {
    id: null,
    timestamp: null,
    role: null,
    content: [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
    ...overrides,
  };
}

// In-place newest-first sort by session start timestamp (list* tail sort).
function sortSessionsByTimestampDesc(sessions) {
  sessions.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return sessions;
}

// Top-5 most used tools from a name → count histogram.
function topToolsOf(toolNames) {
  return Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

module.exports = {
  withMetadataCache,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
};
