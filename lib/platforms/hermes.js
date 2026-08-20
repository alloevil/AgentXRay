const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { HERMES_DIR } = require('../config');
const { makeMessage } = require('./shared');

function getHermesDbPath(dir) {
  const base = dir || HERMES_DIR;
  return path.join(base, 'state.db');
}

function openHermesDb(dir) {
  const dbPath = getHermesDbPath(dir);
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    return null;
  }
}

// Open the db for the SSE tail endpoint: no fileMustExist, errors propagate
// to the caller (the watch route reports them as SSE error events).
function openHermesDbForWatch(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function unixToIso(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

function listHermesSessions(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const sessions = db
      .prepare(`
      SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
             s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
             s.estimated_cost_usd, s.parent_session_id
      FROM sessions s
    `)
      .all();

    if (sessions.length === 0) return [];

    // One query: aggregate all per-session stats from messages
    const stats = db
      .prepare(`
      SELECT session_id,
             SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_count,
             SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistant_count,
             SUM(CASE WHEN role='tool' THEN 1 ELSE 0 END) as tool_result_count,
             MAX(timestamp) as last_ts
      FROM messages
      GROUP BY session_id
    `)
      .all();
    const statsMap = new Map(stats.map((r) => [r.session_id, r]));

    // First user message per session (one query)
    const firstUsers = db
      .prepare(`
      SELECT session_id, content FROM messages
      WHERE role = 'user' AND rowid IN (
        SELECT MIN(rowid) FROM messages WHERE role = 'user' GROUP BY session_id
      )
    `)
      .all();
    const firstUserMap = new Map(firstUsers.map((r) => [r.session_id, r.content]));

    // Top tools per session (parse tool_calls JSON from assistant messages)
    const toolCallRows = db
      .prepare(`
      SELECT session_id, tool_calls FROM messages
      WHERE role = 'assistant' AND tool_calls IS NOT NULL AND tool_calls != ''
    `)
      .all();
    const toolMap = new Map();
    const spawnMap = new Map();
    for (const row of toolCallRows) {
      let calls;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        const name = tc?.function?.name || tc?.name;
        if (!name) continue;
        if (!toolMap.has(row.session_id)) toolMap.set(row.session_id, new Map());
        const sessionTools = toolMap.get(row.session_id);
        sessionTools.set(name, (sessionTools.get(name) || 0) + 1);
        if (name === 'delegate_task') {
          spawnMap.set(row.session_id, (spawnMap.get(row.session_id) || 0) + 1);
        }
      }
    }
    // Convert tool maps to sorted arrays
    for (const [sid, tools] of toolMap) {
      const arr = [...tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      toolMap.set(sid, arr);
    }

    const result = sessions.map((s) => {
      const st = statsMap.get(s.id) || {};
      const firstContent = firstUserMap.get(s.id);
      const lastActivity = st.last_ts ? unixToIso(st.last_ts) : unixToIso(s.ended_at);

      return {
        id: s.id,
        timestamp: unixToIso(s.started_at),
        lastActivity,
        messageCount: s.message_count || 0,
        userCount: st.user_count || 0,
        assistantCount: st.assistant_count || 0,
        toolCallCount: s.tool_call_count || 0,
        toolResultCount: st.tool_result_count || 0,
        topTools: toolMap.get(s.id) || [],
        spawnCount: spawnMap.get(s.id) || 0,
        firstUserMessage: firstContent ? firstContent.trim().slice(0, 120) : null,
        model: s.model || null,
        source: s.source || null,
        title: s.title || null,
        inputTokens: s.input_tokens || 0,
        outputTokens: s.output_tokens || 0,
        estimatedCost: s.estimated_cost_usd || null,
        parentSessionId: s.parent_session_id || null,
        status: s.ended_at ? 'archived' : 'active',
        file: 'state.db',
      };
    });

    // Sort by last activity (latest message time) descending
    result.sort((a, b) => {
      const aTime = a.lastActivity ? Date.parse(a.lastActivity) : 0;
      const bTime = b.lastActivity ? Date.parse(b.lastActivity) : 0;
      return bTime - aTime;
    });

    return result;
  } finally {
    db.close();
  }
}

function getHermesSession(dir, sessionId) {
  const db = openHermesDb(dir);
  if (!db) return null;
  try {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;

    const rows = db
      .prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `)
      .all(sessionId);

    const messages = [];
    for (const row of rows) {
      const msg = normalizeHermesMessage(row);
      if (msg) messages.push(msg);
    }

    const session = {
      id: s.id,
      source: s.source,
      model: s.model,
      title: s.title,
      cwd: null,
      timestamp: unixToIso(s.started_at),
      inputTokens: s.input_tokens || 0,
      outputTokens: s.output_tokens || 0,
      cacheReadTokens: s.cache_read_tokens || 0,
      cacheWriteTokens: s.cache_write_tokens || 0,
      reasoningTokens: s.reasoning_tokens || 0,
      estimatedCost: s.estimated_cost_usd || null,
      actualCost: s.actual_cost_usd || null,
      parentSessionId: s.parent_session_id || null,
    };

    return { session, messages };
  } finally {
    db.close();
  }
}

function normalizeHermesMessage(row) {
  const role = row.role;
  const content = row.content || '';
  let toolCalls = null;
  if (row.tool_calls) {
    try {
      toolCalls = JSON.parse(row.tool_calls);
    } catch {
      toolCalls = null;
    }
  }
  // Hermes messages carry an extra `reasoning` field on top of the shared shape
  const base = { id: String(row.id), timestamp: unixToIso(row.timestamp), reasoning: null };

  if (role === 'user') {
    return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: content }] });
  }

  if (role === 'assistant') {
    const unifiedContent = [];
    if (content) {
      unifiedContent.push({ type: 'text', text: content });
    }
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        unifiedContent.push({
          type: 'toolCall',
          id: tc.id || null,
          name: tc.function?.name || tc.name || 'unknown',
          arguments: (() => {
            const raw = tc.function?.arguments || tc.arguments || '{}';
            if (typeof raw === 'string') {
              try {
                return JSON.parse(raw);
              } catch {
                return { _raw: raw };
              }
            }
            return raw;
          })(),
        });
      }
    }
    return makeMessage({
      ...base,
      role: 'assistant',
      content: unifiedContent,
      usage: row.token_count ? { total_tokens: row.token_count } : null,
      reasoning: row.reasoning || null,
    });
  }

  if (role === 'tool') {
    return makeMessage({
      ...base,
      role: 'toolResult',
      content: [{ type: 'text', text: content }],
      toolCallId: row.tool_call_id || null,
      toolName: row.tool_name || null,
    });
  }

  // system or other roles
  if (content) {
    return makeMessage({ ...base, role: role || 'system', content: [{ type: 'text', text: content }] });
  }

  return null;
}

function searchHermesSessions(dir, query, maxResults) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    // Use FTS5 if available, otherwise fall back to LIKE
    let rows;
    try {
      rows = db
        .prepare(`
        SELECT m.session_id, m.role, m.content, m.timestamp
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH ?
        LIMIT ?
      `)
        .all(query, maxResults * 3);
    } catch {
      const likeQ = `%${query}%`;
      rows = db
        .prepare(`
        SELECT session_id, role, content, timestamp
        FROM messages
        WHERE content LIKE ?
        LIMIT ?
      `)
        .all(likeQ, maxResults * 3);
    }

    // Group by session
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
      const matches = bySession.get(row.session_id);
      if (matches.length < 3) {
        const text = row.content || '';
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 60);
        const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
        matches.push({ role: row.role, snippet, timestamp: unixToIso(row.timestamp) });
      }
    }

    const results = [];
    for (const [sessionId, matches] of bySession) {
      if (results.length >= maxResults) break;
      results.push({ sessionId, file: 'state.db', platform: 'hermes', matches });
    }
    return results;
  } finally {
    db.close();
  }
}

module.exports = {
  getHermesDbPath,
  openHermesDb,
  openHermesDbForWatch,
  unixToIso,
  listHermesSessions,
  getHermesSession,
  normalizeHermesMessage,
  searchHermesSessions,
};
