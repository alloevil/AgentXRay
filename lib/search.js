const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CLAUDE_CODE_DIR, HERMES_DIR, resolveDir } = require('./config');
const { collectSessionFiles } = require('./platforms');
const { readDshSessionLines } = require('./platforms/dsh');
const { foldGeminiRecords } = require('./platforms/gemini');
const { searchHermesSessions } = require('./platforms/hermes');

// ========= Full-text session search =========
// Multi-keyword AND search: whitespace-separated keywords must all appear
// somewhere in a session's text records; snippets come from the first keyword.
// Matching semantics are shared across every platform via SessionMatcher; only
// text extraction differs (raw JSONL stream, dsh event data, gemini fold).

const MAX_MATCHES_PER_SESSION = 3;

// A ±(40/60)-char window around the first keyword's first occurrence.
function extractSnippet(text, keyword) {
  const idx = text.toLowerCase().indexOf(keyword);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 60);
  return (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
}

// Accumulates keyword sightings + snippets for one session.
// A session satisfies the query when every keyword appeared somewhere in it
// and at least one snippet (first keyword) was captured.
function createSessionMatcher(keywords) {
  const matches = [];
  const seen = new Set();
  return {
    matches,
    // Stop scanning: snippet quota reached and every keyword seen
    get done() {
      return matches.length >= MAX_MATCHES_PER_SESSION && seen.size === keywords.length;
    },
    // Include this session in the results
    get satisfied() {
      return matches.length > 0 && seen.size === keywords.length;
    },
    consider(text, role, timestamp) {
      const textLower = text.toLowerCase();
      for (const kw of keywords) {
        if (textLower.includes(kw)) seen.add(kw);
      }
      if (matches.length < MAX_MATCHES_PER_SESSION && textLower.includes(keywords[0])) {
        matches.push({ role, snippet: extractSnippet(text, keywords[0]), timestamp });
      }
    },
  };
}

// Quick line-level pre-filter: skip lines that can't contain any keyword.
function lineMayMatch(line, keywords) {
  const lower = line.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// Generic JSONL platforms (openclaw, codex, claude-code, omp): stream the raw
// file; message text lives under rec.message?.content or rec.payload?.content.
async function searchJsonlFile(sf, keywords) {
  const matcher = createSessionMatcher(keywords);
  const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = sf.sessionId || sf.file.split('.jsonl')[0];

  try {
    for await (const line of rl) {
      if (matcher.done) break;
      if (!lineMayMatch(line, keywords)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract session id
      if (rec.type === 'session' && rec.id) sessionId = rec.id;
      if (rec.sessionId) sessionId = rec.sessionId;

      // Extract text content for matching
      const msg = rec.message || rec.payload || {};
      const role = msg.role || rec.type || '';
      const content = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : [];
      const text = content
        .filter((c) => c.type === 'text' || c.type === 'input_text')
        .map((c) => c.text || '')
        .join(' ');

      matcher.consider(text, role, rec.timestamp || null);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!matcher.satisfied) return null;
  return {
    sessionId,
    file: sf.file,
    platform: sf.platform,
    ...(sf.agent ? { agent: sf.agent } : {}),
    matches: matcher.matches,
  };
}

// dsh logs may be zstd-compressed and nest text under event.data — read them
// via the adapter's line reader instead of the raw stream.
async function searchDshFile(sf, keywords) {
  let lines;
  try {
    lines = await readDshSessionLines(sf.path);
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  let sessionId = sf.sessionId;
  for (const line of lines) {
    if (matcher.done) break;
    if (!lineMayMatch(line, keywords)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session' && rec.id) sessionId = rec.id;
    const data = rec.data || {};
    const msg = rec.type === 'user/message' ? data : data.message || {};
    const role = msg.role || rec.type || '';
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((c) => c.type === 'text' || c.type === 'reasoning')
      .map((c) => c.text || '')
      .join(' ');
    matcher.consider(text, role, typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null);
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'dsh', matches: matcher.matches };
}

// Gemini records keep text at the top level (content: string | Part[]) and
// fold history via $rewindTo/$set — reuse the adapter's fold, then match.
async function searchGeminiFile(sf, keywords) {
  let folded;
  try {
    const text = await fsp.readFile(sf.path, 'utf8');
    folded = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  const sessionId = folded.metadata.sessionId || sf.file.replace(/\.jsonl$/, '');
  for (const rec of folded.messages) {
    if (matcher.done) break;
    const parts = [];
    if (typeof rec.content === 'string') parts.push(rec.content);
    else if (Array.isArray(rec.content)) {
      for (const p of rec.content) if (p && typeof p.text === 'string') parts.push(p.text);
    }
    matcher.consider(parts.join(' '), rec.type === 'gemini' ? 'assistant' : rec.type || '', rec.timestamp || null);
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'gemini', matches: matcher.matches };
}

// Claude Code prompt history (~/.claude/history.jsonl): surfaces prompts whose
// sessions were removed by Claude's cleanupPeriodDays retention. Grouped by
// project; prompts whose snippet already appears in a live hit are skipped.
async function searchClaudeHistory(claudeDir, keywords, liveSnippets) {
  const historyPath = path.join(path.dirname(claudeDir), 'history.jsonl');
  const byProject = new Map(); // project → matches[]
  const results = [];
  try {
    const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const lower = line.toLowerCase();
        if (!keywords.every((kw) => lower.includes(kw))) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const text = typeof rec.display === 'string' ? rec.display : '';
        const textLower = text.toLowerCase();
        if (!keywords.every((kw) => textLower.includes(kw))) continue;
        const snippet = extractSnippet(text, keywords[0]);
        const project = rec.project || '?';
        if (liveSnippets.has(snippet)) continue; // prompt belongs to a still-live session
        if (!byProject.has(project)) byProject.set(project, []);
        const matches = byProject.get(project);
        if (matches.length < 5) matches.push({ role: 'user', snippet, timestamp: rec.timestamp || null });
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    for (const [project, matches] of byProject) {
      results.push({
        sessionId: null,
        file: 'history.jsonl',
        platform: 'claude-code',
        project,
        history: true,
        matches,
      });
    }
  } catch {
    /* no history file */
  }
  return results;
}

// Per-platform ?dir override params used in all-platform mode.
const DIR_PARAMS = {
  openclaw: 'dirOpenclaw',
  codex: 'dirCodex',
  'claude-code': 'dirClaude',
  omp: 'dirOmp',
  dsh: 'dirDsh',
  gemini: 'dirGemini',
};

// Search orchestrator. `query` is the raw req.query object: q, platform,
// limit and the dir overrides (dir in single-platform mode, dirXxx in `all`).
// `agent` is the sanitized openclaw agent filter.
async function searchSessions(query, agent) {
  const q = (query.q || '').trim().toLowerCase();
  if (!q) return [];
  const platform = query.platform || 'openclaw';
  const maxResults = Math.min(parseInt(query.limit) || 50, 100);
  const keywords = q.split(/\s+/).filter(Boolean);

  const all = platform === 'all';
  const dirParamFor = (key) => (all ? query[key] : query.dir) || '';

  if (platform === 'hermes' && !all) {
    const dir = resolveDir(query.dir, HERMES_DIR);
    return searchHermesSessions(dir, q, maxResults);
  }

  // Collect candidate files per platform via the registry, in a stable order:
  // openclaw, codex, claude-code, omp, dsh, gemini. The claude-code subagents
  // dir is excluded (children surface under their parent) and gemini ids
  // resolve from the folded metadata during matching.
  const wanted = Object.keys(DIR_PARAMS).filter((id) => platform === id || all);
  const collected = await Promise.all(
    wanted.map(async (id) => {
      const agentFor = id === 'openclaw' && !all ? agent : '';
      const files = await collectSessionFiles(id, agentFor, dirParamFor(DIR_PARAMS[id]), {
        subagents: false,
        resolveIds: false,
      }).catch(() => []);
      return files.map((f) => ({ ...f, platform: id }));
    })
  );
  const byPlatform = new Map(wanted.map((id, i) => [id, collected[i]]));

  const results = [];
  const searchers = [
    [
      [
        ...(byPlatform.get('openclaw') || []),
        ...(byPlatform.get('codex') || []),
        ...(byPlatform.get('claude-code') || []),
        ...(byPlatform.get('omp') || []),
      ],
      searchJsonlFile,
    ],
    [byPlatform.get('dsh') || [], searchDshFile],
    [byPlatform.get('gemini') || [], searchGeminiFile],
  ];
  for (const [files, searchOne] of searchers) {
    for (const sf of files) {
      if (results.length >= maxResults) break;
      const hit = await searchOne(sf, keywords);
      if (hit) results.push(hit);
    }
  }

  // Claude Code retention fallback: prompt history
  if (platform === 'claude-code' || all) {
    const dir = resolveDir(dirParamFor('dirClaude'), CLAUDE_CODE_DIR);
    const liveSnippets = new Set(results.flatMap((r) => r.matches.map((m) => m.snippet)));
    const historyHits = await searchClaudeHistory(dir, keywords, liveSnippets);
    for (const hit of historyHits) {
      if (results.length >= maxResults) break;
      results.push(hit);
    }
  }

  // Hermes stores sessions in SQLite; merge its hits in all-platform mode
  if (all) {
    try {
      const remaining = Math.max(0, maxResults - results.length);
      if (remaining > 0) {
        results.push(...searchHermesSessions(resolveDir(dirParamFor('dirHermes'), HERMES_DIR), q, remaining));
      }
    } catch {
      /* no hermes db */
    }
  }

  return results;
}

module.exports = {
  extractSnippet,
  createSessionMatcher,
  searchSessions,
};
