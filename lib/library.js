const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { HOME, LIBRARY_DIR, CODEX_DIR, CLAUDE_CODE_DIR, OMP_DIR } = require('./config');

// --- Prompt Library: curated prompts stored as markdown files with frontmatter ---
// Storage: LIBRARY_DIR/<name>.md — frontmatter between `---` lines with keys
// description, tags (comma-separated), source, createdAt; body = prompt content.
// Install targets copy the prompt as a native slash command file.

const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INSTALL_TARGETS = {
  claude: path.join(HOME, '.claude', 'commands'),
  codex: path.join(HOME, '.codex', 'prompts'),
  omp: path.join(HOME, '.omp', 'agent', 'commands'),
};

function sanitizeLibraryName(name) {
  return typeof name === 'string' && LIBRARY_NAME_RE.test(name) ? name : null;
}

function libraryFilePath(name) {
  return path.join(LIBRARY_DIR, `${name}.md`);
}

function installedFilePath(target, name) {
  return path.join(INSTALL_TARGETS[target], `${name}.md`);
}

function normalizeLibraryTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => String(tag).trim()).filter(Boolean);
}

// Parse the `---` frontmatter block. Files without frontmatter are tolerated:
// the whole file becomes the content.
function parseLibraryFile(raw) {
  const meta = { description: '', tags: [], source: 'manual', createdAt: null };
  if (!raw.startsWith('---\n')) return { meta, content: raw };
  const close = raw.indexOf('\n---', 4);
  if (close === -1) return { meta, content: raw };
  const header = raw.slice(4, close);
  const afterClose = raw.indexOf('\n', close + 1);
  const content = (afterClose === -1 ? '' : raw.slice(afterClose + 1)).replace(/^\n+/, '');
  for (const line of header.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === 'description') meta.description = value;
    else if (key === 'source') meta.source = value || 'manual';
    else if (key === 'createdAt') meta.createdAt = value || null;
    else if (key === 'tags')
      meta.tags = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
  }
  return { meta, content };
}

function serializeLibraryFile(meta, content) {
  const lines = [
    '---',
    `description: ${meta.description || ''}`,
    `tags: ${(meta.tags || []).join(', ')}`,
    `source: ${meta.source || 'manual'}`,
    `createdAt: ${meta.createdAt || ''}`,
    '---',
    '',
  ];
  return `${lines.join('\n')}${content.replace(/\n*$/, '\n')}`;
}

// Installed slash-command file: frontmatter with description only + prompt body
function serializeInstalledFile(description, content) {
  return `---\ndescription: ${description || ''}\n---\n\n${content.replace(/\n*$/, '\n')}`;
}

// Installed detection: file exists at the target path
async function detectInstalled(name) {
  const installed = {};
  await Promise.all(
    Object.keys(INSTALL_TARGETS).map(async (target) => {
      installed[target] = await fsp.access(installedFilePath(target, name)).then(
        () => true,
        () => false
      );
    })
  );
  return installed;
}

async function readLibraryPrompt(name) {
  const raw = await fsp.readFile(libraryFilePath(name), 'utf8');
  const { meta, content } = parseLibraryFile(raw);
  return {
    name,
    description: meta.description,
    tags: meta.tags,
    source: meta.source,
    createdAt: meta.createdAt,
    content,
    installed: await detectInstalled(name),
  };
}

// Write the prompt copy into the given install targets (mkdir -p on demand)
async function installLibraryPrompt(prompt, targets) {
  for (const target of targets) {
    await fsp.mkdir(INSTALL_TARGETS[target], { recursive: true });
    await fsp.writeFile(
      installedFilePath(target, prompt.name),
      serializeInstalledFile(prompt.description, prompt.content),
      'utf8'
    );
  }
}

// Remove installed copies from the given targets, ignoring missing files
async function uninstallLibraryPrompt(name, targets) {
  for (const target of targets) {
    await fsp.unlink(installedFilePath(target, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function parseInstallTargets(body) {
  const targets = body && Array.isArray(body.targets) ? body.targets : null;
  if (!targets || targets.length === 0) return null;
  if (!targets.every((target) => Object.hasOwn(INSTALL_TARGETS, target))) return null;
  return [...new Set(targets)];
}

// --- Library git versioning ---
// LIBRARY_DIR is kept as a local git repo so every mutation is recoverable.
// Git being missing or broken is tolerated silently: versioning turns off,
// the library keeps working, and history endpoints reply with empty lists.

let libraryGitReady = false;
let libraryGitQueue;

function gitLibrary(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: LIBRARY_DIR, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function ensureLibraryRepo() {
  try {
    await fsp.mkdir(LIBRARY_DIR, { recursive: true });
    const hasRepo = await fsp.access(path.join(LIBRARY_DIR, '.git')).then(
      () => true,
      () => false
    );
    if (!hasRepo) await gitLibrary(['init']);
    // Identity fallback so commits never fail on machines without git config
    await gitLibrary(['config', 'user.name']).catch(() => gitLibrary(['config', 'user.name', 'agentxray']));
    await gitLibrary(['config', 'user.email']).catch(() => gitLibrary(['config', 'user.email', 'agentxray@localhost']));
    if ((await gitLibrary(['status', '--porcelain'])).trim()) {
      await gitLibrary(['add', '-A']);
      await gitLibrary(['commit', '-m', 'snapshot: existing library']);
    }
    libraryGitReady = true;
  } catch (error) {
    console.warn(`Library git versioning disabled: ${error.message}`);
  }
}

// Startup side-effect, invoked from server.js: seed the commit queue with the
// repo bootstrap so commitLibrary always chains onto a settled promise.
function startLibraryGit() {
  libraryGitQueue = ensureLibraryRepo();
}

// Fire-and-forget commit after a mutating library op. Commits are serialized
// through a promise chain so concurrent requests never race the git index.
function commitLibrary(message) {
  libraryGitQueue = libraryGitQueue
    .then(async () => {
      if (!libraryGitReady) return;
      if (!(await gitLibrary(['status', '--porcelain'])).trim()) return;
      await gitLibrary(['add', '-A']);
      await gitLibrary(['commit', '-m', message]);
    })
    .catch((error) => {
      console.warn(`Library git commit failed: ${error.message}`);
    });
}

// --- Fabric patterns import (github.com/danielmiessler/fabric) ---

const FABRIC_PATTERNS_API = 'https://api.github.com/repos/danielmiessler/fabric/contents/data/patterns';
const FABRIC_RAW_BASE = 'https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns';
const FABRIC_CACHE_FILE = path.join(HOME, '.agentxray', 'cache', 'fabric-patterns.json');
const FABRIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function readFabricCache() {
  try {
    const cached = JSON.parse(await fsp.readFile(FABRIC_CACHE_FILE, 'utf8'));
    if (Array.isArray(cached.names)) return cached;
  } catch {}
  return null;
}

async function fetchFabricFile(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return response;
}

// One pattern's system.md. raw.githubusercontent.com is unreachable on some
// networks while api.github.com works, so a non-404 raw failure falls back to
// the contents API raw media type (rate-limited, hence not the primary path).
async function fetchFabricPattern(rawName) {
  const encoded = encodeURIComponent(rawName);
  try {
    return await (
      await fetchFabricFile(`${FABRIC_RAW_BASE}/${encoded}/system.md`, { 'User-Agent': 'agentxray' })
    ).text();
  } catch (error) {
    if (/responded 404/.test(String(error && error.message))) throw error;
    return (
      await fetchFabricFile(`${FABRIC_PATTERNS_API}/${encoded}/system.md`, {
        'User-Agent': 'agentxray',
        Accept: 'application/vnd.github.raw',
      })
    ).text();
  }
}

// Pattern directory names from the fabric repo, disk-cached for 24h. A stale
// cache is still served when GitHub is unreachable; with no cache the fetch
// error propagates (surfaced as 502 by the route).
async function listFabricPatternNames() {
  const cached = await readFabricCache();
  if (cached && Date.now() - cached.fetchedAt < FABRIC_CACHE_TTL_MS) return cached.names;
  let names;
  try {
    const response = await fetchFabricFile(FABRIC_PATTERNS_API, { 'User-Agent': 'agentxray' });
    const entries = await response.json();
    names = entries
      .filter((entry) => entry.type === 'dir')
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (cached) return cached.names;
    throw error;
  }
  await fsp.mkdir(path.dirname(FABRIC_CACHE_FILE), { recursive: true });
  await fsp.writeFile(FABRIC_CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), names }), 'utf8');
  return names;
}

// Fabric names use underscores (extract_wisdom); map to a valid library name.
function fabricLibraryName(name) {
  if (typeof name !== 'string') return null;
  if (LIBRARY_NAME_RE.test(name)) return name;
  const cleaned = name
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/^-+/, '')
    .slice(0, 64);
  return sanitizeLibraryName(cleaned);
}

// First non-empty line of the pattern, stripped of markdown decoration
function fabricDescription(content) {
  for (const line of content.split('\n')) {
    const text = line.replace(/^[#>*\s-]+/, '').trim();
    if (text) return text.slice(0, 140);
  }
  return '';
}

async function listLibraryNames() {
  try {
    const entries = await fsp.readdir(LIBRARY_DIR);
    return new Set(entries.filter((entry) => entry.endsWith('.md')).map((entry) => entry.slice(0, -3)));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

// --- Library usage stats: how often each library prompt is invoked as a slash
// command across codex/claude-code/omp sessions plus ~/.claude/history.jsonl.
// A hit is a user message starting with /<name> (word boundary) or containing
// the claude-style <command-name>/<name></command-name> marker. For in-session
// hits, the records until the next user message form a "turn": its size feeds
// avgMessages and a turn with any tool error feeds errorRate
// (turns-with-errors / turns). History hits only bump uses/lastUsed.
let libraryUsageCache = null; // { expires, data } — recomputed every 5 minutes
const LIBRARY_USAGE_CACHE_MS = 5 * 60 * 1000;

function getLibraryUsageCache() {
  return libraryUsageCache && libraryUsageCache.expires > Date.now() ? libraryUsageCache.data : null;
}

function setLibraryUsageCache(data) {
  libraryUsageCache = { expires: Date.now() + LIBRARY_USAGE_CACHE_MS, data };
}

// Which library prompt (if any) a piece of user text invokes
function libraryUsageHit(text, names) {
  const t = text.trimStart();
  if (t.startsWith('/')) {
    const token = (t.slice(1).match(/^[a-z0-9][a-z0-9-]*/) || [])[0];
    const after = token ? t[1 + token.length] : undefined;
    if (token && names.has(token) && (after === undefined || /\s/.test(after))) return token;
  }
  const m = text.match(/<command-name>\/([a-z0-9][a-z0-9-]*)<\/command-name>/);
  return m && names.has(m[1]) ? m[1] : null;
}

// Classify one session JSONL record for usage scanning. Reuses the /api/search
// extraction (message/payload envelope, text/input_text parts) and the insights
// error detection (toolResult isError, claude tool_result is_error blocks).
function classifyUsageRecord(rec) {
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
  const isToolResult =
    role === 'toolResult' ||
    content.some((c) => c.type === 'tool_result') ||
    msg.type === 'function_call_output' ||
    msg.type === 'custom_tool_call_output';
  return {
    // A genuine user prompt: user role with text and no tool_result payload
    isUserText: role === 'user' && !isToolResult && Boolean(text.trim()),
    // Message-like records advance the turn size; session/meta records don't
    isMessage:
      isToolResult ||
      role === 'user' ||
      role === 'assistant' ||
      role === 'toolCall' ||
      msg.type === 'function_call' ||
      msg.type === 'custom_tool_call' ||
      msg.type === 'local_shell_call',
    hasToolError: Boolean(msg.isError) || content.some((c) => c.type === 'tool_result' && c.is_error),
    text,
    timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : null,
  };
}

// Stream one session file, folding invocation hits and their turns into `stats`
async function scanFileForLibraryUsage(filePath, names, stats) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let turn = null; // { name, messages, hadError } — open invocation turn
  const closeTurn = () => {
    if (!turn) return;
    const s = stats.get(turn.name);
    s.turns++;
    s.turnMessages += turn.messages;
    if (turn.hadError) s.turnErrors++;
    turn = null;
  };
  try {
    for await (const line of rl) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const info = classifyUsageRecord(rec);
      if (info.isUserText) {
        closeTurn();
        const name = libraryUsageHit(info.text, names);
        if (name) {
          const s = stats.get(name);
          s.uses++;
          if (info.timestamp && (!s.lastUsed || info.timestamp > s.lastUsed)) s.lastUsed = info.timestamp;
          turn = { name, messages: 0, hadError: false };
        }
      } else if (turn && info.isMessage) {
        turn.messages++;
        if (info.hasToolError) turn.hadError = true;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
    closeTurn();
  }
}

async function computeLibraryUsage(names) {
  const nameSet = new Set(names);
  const stats = new Map(names.map((n) => [n, { uses: 0, turns: 0, turnMessages: 0, turnErrors: 0, lastUsed: null }]));

  // Session file collection mirrors /api/search: codex recursive rollout files,
  // claude-code and omp <slug>/*.jsonl dirs.
  const files = [];
  await Promise.all([
    (async () => {
      try {
        const entries = await fsp.readdir(CODEX_DIR, { recursive: true });
        for (const rel of entries) {
          if (typeof rel === 'string' && rel.endsWith('.jsonl')) files.push(path.join(CODEX_DIR, rel));
        }
      } catch {}
    })(),
    ...[CLAUDE_CODE_DIR, OMP_DIR].map((dir) =>
      (async () => {
        try {
          const slugs = await fsp.readdir(dir, { withFileTypes: true });
          for (const s of slugs) {
            if (!s.isDirectory()) continue;
            const slugDir = path.join(dir, s.name);
            const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
            for (const f of entries) {
              if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(slugDir, f.name));
            }
          }
        } catch {}
      })()
    ),
  ]);

  for (const filePath of files) {
    await scanFileForLibraryUsage(filePath, nameSet, stats).catch(() => {});
  }

  // Claude prompt history: uses + lastUsed only (no turn context available)
  try {
    const historyPath = path.join(path.dirname(CLAUDE_CODE_DIR), 'history.jsonl');
    const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const text = typeof rec.display === 'string' ? rec.display : '';
        const name = text ? libraryUsageHit(text, nameSet) : null;
        if (!name) continue;
        const s = stats.get(name);
        s.uses++;
        // History timestamps are epoch numbers (ms, sometimes s); normalize to ISO
        const ts =
          typeof rec.timestamp === 'number'
            ? new Date(rec.timestamp > 1e12 ? rec.timestamp : rec.timestamp * 1000).toISOString()
            : typeof rec.timestamp === 'string'
              ? rec.timestamp
              : null;
        if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    /* no history file */
  }

  const usage = {};
  for (const [name, s] of stats) {
    usage[name] = {
      uses: s.uses,
      avgMessages: s.turns > 0 ? Math.round((s.turnMessages / s.turns) * 10) / 10 : null,
      errorRate: s.turns > 0 ? Math.round((s.turnErrors / s.turns) * 1000) / 1000 : null,
      lastUsed: s.lastUsed,
    };
  }
  return usage;
}

module.exports = {
  LIBRARY_NAME_RE,
  INSTALL_TARGETS,
  sanitizeLibraryName,
  libraryFilePath,
  installedFilePath,
  normalizeLibraryTags,
  parseLibraryFile,
  serializeLibraryFile,
  detectInstalled,
  readLibraryPrompt,
  installLibraryPrompt,
  uninstallLibraryPrompt,
  parseInstallTargets,
  gitLibrary,
  startLibraryGit,
  commitLibrary,
  fetchFabricPattern,
  listFabricPatternNames,
  fabricLibraryName,
  fabricDescription,
  listLibraryNames,
  getLibraryUsageCache,
  setLibraryUsageCache,
  computeLibraryUsage,
};
