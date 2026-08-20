const state = {
  platform: 'openclaw', // 'openclaw' | 'codex' | 'claude-code' | 'hermes' | 'omp' | 'dsh'
  agents: [],
  sessions: [],
  filteredSessions: [],
  selectedAgent: '',
  selectedSessionId: '',
  includeArchived: false,
  autoRefresh: true,
  autoScroll: false,
  sessionData: null,
  refreshTimer: null,
  sseSource: null, // active EventSource for real-time tail
  spawnMap: [],
  navStack: [],
  msgFilter: null, // null | 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'error' | 'spawn'
  visibleUnitCount: 60, // incremental rendering: show newest N units initially
  settings: { openclawDir: '', codexDir: '', claudeCodeDir: '', hermesDir: '', ompDir: '', dshDir: '' },
};

const MSG_BATCH_SIZE = 60; // how many units to add per "load more" click

const platformBar = document.getElementById('platformBar');
const sessionSearch = document.getElementById('sessionSearch');
const searchResults = document.getElementById('searchResults');
const includeArchived = document.getElementById('includeArchived');
const autoRefresh = document.getElementById('autoRefresh');
const autoScroll = document.getElementById('autoScroll');
const sessionList = document.getElementById('sessionList');
const summary = document.getElementById('summary');
const messages = document.getElementById('messages');
const loading = document.getElementById('loading');
const errorBanner = document.getElementById('errorBanner');

// --- Settings ---
const SETTINGS_KEY = 'agent-xray-settings';
let hasStoredPlatform = false;
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingOpenclaw = document.getElementById('settingOpenclaw');
const settingCodex = document.getElementById('settingCodex');
const settingClaudeCode = document.getElementById('settingClaudeCode');
const settingHermes = document.getElementById('settingHermes');
const settingOmp = document.getElementById('settingOmp');
const settingDsh = document.getElementById('settingDsh');
const settingsSave = document.getElementById('settingsSave');
const settingsReset = document.getElementById('settingsReset');

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.settings.openclawDir = parsed.openclawDir || '';
      state.settings.codexDir = parsed.codexDir || '';
      state.settings.claudeCodeDir = parsed.claudeCodeDir || '';
      state.settings.hermesDir = parsed.hermesDir || '';
      state.settings.ompDir = parsed.ompDir || '';
      state.settings.dshDir = parsed.dshDir || '';
      if (['openclaw', 'codex', 'claude-code', 'hermes', 'omp', 'dsh'].includes(parsed.platform)) {
        state.platform = parsed.platform;
        hasStoredPlatform = true;
      }
    }
  } catch {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...state.settings, platform: state.platform }));
}

function dirParam() {
  let dir = '';
  if (state.platform === 'openclaw') dir = state.settings.openclawDir;
  else if (state.platform === 'codex') dir = state.settings.codexDir;
  else if (state.platform === 'claude-code') dir = state.settings.claudeCodeDir;
  else if (state.platform === 'hermes') dir = state.settings.hermesDir;
  else if (state.platform === 'omp') dir = state.settings.ompDir;
  else if (state.platform === 'dsh') dir = state.settings.dshDir;
  return dir ? '?dir=' + encodeURIComponent(dir) : '';
}

function openSettings() {
  settingOpenclaw.value = state.settings.openclawDir;
  settingCodex.value = state.settings.codexDir;
  settingClaudeCode.value = state.settings.claudeCodeDir;
  settingHermes.value = state.settings.hermesDir;
  settingOmp.value = state.settings.ompDir;
  if (settingDsh) settingDsh.value = state.settings.dshDir;
  settingsOverlay.hidden = false;
  loadBackupStatus();
}

function closeSettings() {
  settingsOverlay.hidden = true;
}

settingsBtn.addEventListener('click', openSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

settingsSave.addEventListener('click', async () => {
  state.settings.openclawDir = settingOpenclaw.value.trim();
  state.settings.codexDir = settingCodex.value.trim();
  state.settings.claudeCodeDir = settingClaudeCode.value.trim();
  state.settings.hermesDir = settingHermes.value.trim();
  state.settings.ompDir = settingOmp.value.trim();
  if (settingDsh) state.settings.dshDir = settingDsh.value.trim();
  saveSettings();
  closeSettings();
  await refreshAll(false);
});

settingsReset.addEventListener('click', () => {
  state.settings.openclawDir = '';
  state.settings.codexDir = '';
  state.settings.claudeCodeDir = '';
  state.settings.hermesDir = '';
  state.settings.ompDir = '';
  state.settings.dshDir = '';
  saveSettings();
  settingOpenclaw.value = '';
  settingCodex.value = '';
  settingClaudeCode.value = '';
  settingHermes.value = '';
  settingOmp.value = '';
  if (settingDsh) settingDsh.value = '';
});

// --- Backup ---
const backupNowBtn = document.getElementById('backupNowBtn');
const backupResultLine = document.getElementById('backupResultLine');
const backupStatusLine = document.getElementById('backupStatusLine');
const backupError = document.getElementById('backupError');

async function loadBackupStatus() {
  try {
    const status = await fetchJson('/api/backup/status');
    backupStatusLine.textContent = `归档目录 ${status.archiveDir} · 文件数 ${status.files} · 占用 ${formatBytes(status.bytes)} · 上次备份 ${status.lastBackup ? formatDate(status.lastBackup) : '从未'}`;
    backupError.hidden = true;
  } catch (error) {
    backupStatusLine.textContent = '';
    backupError.textContent = '备份状态获取失败: ' + error.message;
    backupError.hidden = false;
  }
}

backupNowBtn.addEventListener('click', async () => {
  backupNowBtn.disabled = true;
  backupNowBtn.textContent = '备份中…';
  backupResultLine.textContent = '';
  try {
    const result = await libraryRequest('/api/backup', 'POST');
    backupResultLine.textContent = `完成：新增 ${result.copied}，跳过 ${result.skipped}`;
    backupError.hidden = true;
    await loadBackupStatus();
  } catch (error) {
    backupError.textContent = '备份失败: ' + error.message;
    backupError.hidden = false;
  } finally {
    backupNowBtn.disabled = false;
    backupNowBtn.textContent = '立即备份';
  }
});

loadSettings();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

function isDisplayableMessage(msg) {
  if (!msg || msg.role === 'developer') return false;
  if (msg.role === 'assistant') {
    const hasText = (msg.content || []).some((c) => c.type === 'text' && (c.text || '').trim());
    const hasTools = (msg.content || []).some((c) => c.type === 'toolCall');
    return hasText || hasTools;
  }
  if (msg.role === 'reasoning') {
    return (msg.content || []).some((c) => c.type === 'text' && (c.text || '').trim());
  }
  return true;
}

function getMessageTypeLabel(message) {
  if (message.role === 'assistant') return 'assistant response';
  if (message.role === 'user') return 'user message';
  if (message.role === 'reasoning') return 'reasoning';
  if (message.role === 'toolCall') return `tool: ${message.toolName || 'unknown'}`;
  if (message.role === 'toolResult') return `tool result: ${message.toolName || 'unknown'}`;
  return message.role || 'message';
}

function buildTimingAnalysis(messagesData) {
  const visibleMessages = (messagesData || []).filter(isDisplayableMessage);
  const timingByMessage = new Map();
  let previousTimed = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  // Per-message delta (for badges)
  visibleMessages.forEach((message) => {
    const timestampMs = parseTimestampMs(message.timestamp);
    const meta = { timestampMs, deltaMs: null, toolDurationMs: null };
    if (timestampMs !== null) {
      if (firstTimestamp === null) firstTimestamp = timestampMs;
      lastTimestamp = timestampMs;
      if (previousTimed !== null) {
        meta.deltaMs = Math.max(0, timestampMs - previousTimed.timestampMs);
      }
      previousTimed = { timestampMs };
    }
    timingByMessage.set(message, meta);
  });

  // ── Tool call durations: pair toolCall ↔ toolResult by toolCallId ──
  // Also works for OpenClaw-style where toolCalls are inline in assistant content
  const toolCallTsById = new Map(); // toolCallId → {timestampMs, message}
  let totalToolDurationMs = 0;
  let toolPairCount = 0;

  for (const msg of visibleMessages) {
    const ts = parseTimestampMs(msg.timestamp);
    if (ts === null) continue;

    if (msg.role === 'toolCall') {
      // Codex-style: separate toolCall record
      if (msg.toolCallId) toolCallTsById.set(msg.toolCallId, { ts, msg });
    } else if (msg.role === 'assistant') {
      // OpenClaw-style: toolCalls embedded in assistant content
      for (const c of msg.content || []) {
        if (c.type === 'toolCall' && c.id) {
          toolCallTsById.set(c.id, { ts, msg });
        }
      }
    } else if (msg.role === 'toolResult') {
      const id = msg.toolCallId;
      if (id && toolCallTsById.has(id)) {
        const { ts: callTs } = toolCallTsById.get(id);
        const duration = Math.max(0, ts - callTs);
        const meta = timingByMessage.get(msg);
        if (meta) meta.toolDurationMs = duration;
        totalToolDurationMs += duration;
        toolPairCount++;
        toolCallTsById.delete(id);
      }
    }
  }

  // Slowest turn: from user message to end of agent work (next user or end)
  let slowestTurn = null;
  let turnStart = null;
  let turnFirstAgentId = null;
  let turnToolCount = 0;

  for (let i = 0; i < visibleMessages.length; i++) {
    const msg = visibleMessages[i];
    const ts = parseTimestampMs(msg.timestamp);
    if (msg.role === 'user' && ts !== null) {
      // Close previous turn if exists
      if (turnStart !== null) {
        finalizeTurn(i - 1);
      }
      turnStart = ts;
      turnFirstAgentId = null;
      turnToolCount = 0;
    } else if (turnStart !== null && ts !== null) {
      if (!turnFirstAgentId) turnFirstAgentId = msg.id || msg.toolCallId || null;
      if (msg.role === 'toolCall' || msg.role === 'toolResult') turnToolCount++;
    }
  }
  // Close last turn
  if (turnStart !== null) {
    finalizeTurn(visibleMessages.length - 1);
  }

  function finalizeTurn(endIdx) {
    const endMsg = visibleMessages[endIdx];
    const endTs = parseTimestampMs(endMsg?.timestamp);
    if (endTs === null || endMsg.role === 'user') {
      // Look backwards for last non-user message
      for (let j = endIdx; j >= 0; j--) {
        const m = visibleMessages[j];
        if (m.role !== 'user') {
          const t = parseTimestampMs(m.timestamp);
          if (t !== null) {
            checkTurn(t, m);
            return;
          }
        }
      }
      return;
    }
    checkTurn(endTs, endMsg);
  }

  function checkTurn(endTs, lastAgentMsg) {
    const duration = Math.max(0, endTs - turnStart);
    if (duration > 0 && (!slowestTurn || duration > slowestTurn.deltaMs)) {
      const parts = [];
      parts.push('assistant');
      if (turnToolCount > 0) parts.push(`${turnToolCount} tool calls`);
      slowestTurn = {
        deltaMs: duration,
        label: parts.join(' + '),
        messageId: turnFirstAgentId || lastAgentMsg.id || lastAgentMsg.toolCallId || null,
      };
    }
  }

  return {
    visibleMessages,
    timingByMessage,
    totalDurationMs:
      firstTimestamp !== null && lastTimestamp !== null ? Math.max(0, lastTimestamp - firstTimestamp) : null,
    slowestStep: slowestTurn,
    totalToolDurationMs: toolPairCount > 0 ? totalToolDurationMs : null,
    toolPairCount,
  };
}

function getDeltaBadge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 5000) return '';
  let cls = '';
  if (deltaMs >= 120000) cls = ' danger';
  else if (deltaMs >= 30000) cls = ' warn';
  return `<span class="delta-badge${cls}">+${escapeHtml(formatDurationCompact(deltaMs))}</span>`;
}

// Badge for tool call duration (shown on toolResult) — show all durations ≥ 200ms
function getToolDurationBadge(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 200) return '';
  let cls = '';
  if (durationMs >= 60000) cls = ' danger';
  else if (durationMs >= 10000) cls = ' warn';
  return `<span class="delta-badge${cls}" title="Tool execution time">⏱ ${escapeHtml(formatDurationCompact(durationMs))}</span>`;
}

function renderMessageHead(roleHtml, metaHtml, timestamp, deltaMs, toolDurationMs) {
  const deltaBadge = getDeltaBadge(deltaMs);
  const toolBadge = getToolDurationBadge(toolDurationMs);
  const timestampHtml = timestamp ? `<span>${escapeHtml(formatDate(timestamp))}</span>` : '';
  const rightSide = [timestampHtml, toolBadge, deltaBadge].filter(Boolean).join('');
  return `
        <div class="message-head">
          <div class="message-head-main">${roleHtml}${metaHtml || ''}</div>
          <div class="message-head-meta">${rightSide}</div>
        </div>
      `;
}

function truncateId(value) {
  if (!value) return 'unknown';
  return value.length > 14 ? value.slice(0, 14) + '…' : value;
}

function showError(message) {
  errorBanner.hidden = false;
  errorBanner.textContent = message;
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error((await response.json().catch(() => null))?.error || response.statusText);
  }
  return response.json();
}

// --- Platform bar collapse: probe every platform's session count once per page load ---
const PLATFORM_LABELS = {
  openclaw: 'OpenClaw',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes',
  omp: 'OMP',
  dsh: 'DeepSeek Harness',
};
function platformScopeChip() {
  return `<span class="scope-chip">📍 当前平台：${PLATFORM_LABELS[state.platform] || state.platform}</span>`;
}
const platformSessionCounts = {}; // platform id → count (0 = known empty; missing = unknown/probing)
let platformBarExpanded = false;
let platformProbeStarted = false;
function probePlatformSessionCounts() {
  if (platformProbeStarted) return;
  platformProbeStarted = true;
  const dirQ = (dir) => (dir ? '?dir=' + encodeURIComponent(dir) : '');
  const probes = [
    ['openclaw', '/api/agents' + dirQ(state.settings.openclawDir)],
    ['codex', '/api/codex/sessions' + dirQ(state.settings.codexDir)],
    ['claude-code', '/api/claude-code/sessions' + dirQ(state.settings.claudeCodeDir)],
    ['hermes', '/api/hermes/sessions' + dirQ(state.settings.hermesDir)],
    ['omp', '/api/omp/sessions' + dirQ(state.settings.ompDir)],
    ['dsh', '/api/dsh/sessions' + dirQ(state.settings.dshDir)],
  ];
  Promise.all(
    probes.map(
      ([id, url]) =>
        fetchJson(url)
          .then((list) => {
            platformSessionCounts[id] = Array.isArray(list) ? list.length : 0;
          })
          .catch(() => {
            platformSessionCounts[id] = 0;
          }) // unreachable = treat as empty
    )
  ).then(() => renderAgents());
}

function renderAgents() {
  // Update subtitle
  const subtitle = document.getElementById('sidebarSubtitle');
  const platformLabels = {
    openclaw: 'OpenClaw sessions',
    codex: 'Codex sessions',
    'claude-code': 'Claude Code sessions',
    hermes: 'Hermes sessions',
    omp: 'OMP sessions',
    dsh: 'DeepSeek Harness sessions',
  };
  subtitle.textContent = platformLabels[state.platform] || '';

  // Platform tabs
  const platforms = [
    { id: 'openclaw', label: 'OpenClaw' },
    { id: 'codex', label: 'Codex' },
    { id: 'claude-code', label: 'Claude Code' },
    { id: 'hermes', label: 'Hermes' },
    { id: 'omp', label: 'OMP' },
    { id: 'dsh', label: 'DeepSeek Harness' },
  ];
  const isCollapsedTab = (p) => p.id !== state.platform && !platformBarExpanded && platformSessionCounts[p.id] === 0;
  const shownPlatforms = platforms.filter((p) => !isCollapsedTab(p));
  const collapsedPlatforms = platforms.filter((p) => isCollapsedTab(p));
  const tips = {
    openclaw: 'OpenClaw 会话（~/.openclaw/agents）',
    codex: 'Codex 会话（~/.codex/sessions）',
    'claude-code': 'Claude Code 会话（~/.claude/projects）',
    hermes: 'Hermes 会话（~/.hermes）',
    omp: 'oh-my-pi 会话（~/.omp/agent/sessions）',
    dsh: 'DeepSeek Harness 会话（~/.dsh/sessions）',
  };
  platformBar.innerHTML =
    shownPlatforms
      .map((p) => {
        const activeClass = p.id === state.platform ? 'active' : '';
        return `<button class="platform-tab ${activeClass}" data-platform="${p.id}" title="${tips[p.id] || ''}">${p.label}</button>`;
      })
      .join('') +
    (collapsedPlatforms.length
      ? `<button class="platform-tab more-tab" id="platformMoreTab" title="暂无会话的平台：${collapsedPlatforms.map((p) => p.label).join('、')} — 点击展开">+${collapsedPlatforms.length}</button>`
      : '');

  document.getElementById('platformMoreTab')?.addEventListener('click', () => {
    platformBarExpanded = true;
    renderAgents();
  });

  platformBar.querySelectorAll('.platform-tab[data-platform]').forEach((tab) => {
    tab.addEventListener('click', async () => {
      const platform = tab.getAttribute('data-platform');
      if (platform === state.platform) return;
      state.platform = platform;
      saveSettings();
      state.selectedAgent = '';
      state.selectedSessionId = '';
      state.sessions = [];
      state.filteredSessions = [];
      state.sessionData = null;
      state.navStack = [];
      renderBreadcrumb();
      renderAgents();
      await refreshAll(false);
      if (currentView === 'insights') await loadInsights();
      else if (currentView === 'prompts') await loadPrompts();
    });
  });

  // Agent sub-navigation in sidebar (OpenClaw only)
  const agentNav = document.getElementById('agentNav');
  const archivedToggle = document.getElementById('archivedToggle');
  if (state.platform === 'openclaw') {
    archivedToggle.hidden = false;
    agentNav.hidden = false;
    const label =
      '<div class="agent-nav-label" title="OpenClaw 按 agent 分目录存储会话（~/.openclaw/agents/<名字>/sessions），先选 agent 再浏览其会话">OpenClaw Agent ⓘ</div>';
    agentNav.innerHTML = state.agents.length
      ? `${label}<select class="agent-select" id="agentSelect" title="选择要浏览哪个 OpenClaw agent 的会话">
              ${state.agents
                .map(
                  (agent) =>
                    `<option value="${escapeHtml(agent)}"${agent === state.selectedAgent ? ' selected' : ''}>${escapeHtml(agent)}</option>`
                )
                .join('')}
            </select>`
      : `${label}<div class="agent-nav-empty">未检测到 OpenClaw agent（~/.openclaw/agents 不存在或为空）</div>`;
    document.getElementById('agentSelect')?.addEventListener('change', async (e) => {
      const agent = e.target.value;
      if (agent === state.selectedAgent) return;
      state.selectedAgent = agent;
      state.selectedSessionId = '';
      state.navStack = [];
      renderBreadcrumb();
      await refreshAll(false);
      if (currentView === 'insights') await loadInsights();
      else if (currentView === 'prompts') await loadPrompts();
    });
  } else {
    archivedToggle.hidden = true;
    agentNav.hidden = true;
    agentNav.innerHTML = '';
  }

  probePlatformSessionCounts();
}

// --- Insights View ---
const viewToggleBar = document.getElementById('viewToggleBar');
const mainContent = document.getElementById('mainContent');
const insightsPanel = document.getElementById('insightsPanel');
const promptsPanel = document.getElementById('promptsPanel');
const libraryPanel = document.getElementById('libraryPanel');
let currentView = 'sessions';
let insightsData = null;
let insightsScope = null; // 'global' | 'session' — auto-picked on first entry into 分析, then sticky
let promptsData = null;
let promptsSearch = '';
let promptsHideTrivial = (() => {
  try {
    return localStorage.getItem('axr-hide-trivial') !== '0';
  } catch {
    return true;
  }
})();
let promptAnalysis = null;
let promptAnalysisLoading = false;
let promptAnalysisStartedAt = 0;
let hiddenPrompts = [];
let promptSelectMode = false;
const promptSelection = new Set(); // "gi:si:pi" keys, cleared on every re-render
let toolsAudit = null; // last /api/tools/audit payload (platform=all)
let toolsAuditChecked = false; // cached=1 probe completed (204 counts as checked)
let toolsAuditLoading = false;
let toolsAuditError = null;
let toolsAuditShowAll = false;
const clusterSavedPatterns = new Set(); // 「入库」-saved cluster patterns (session-local)
let libraryData = null;
let librarySearch = '';
let libraryUsage = null;
let librarySort = localStorage.getItem('axr-lib-sort') || 'recent';

viewToggleBar.querySelectorAll('.view-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.getAttribute('data-view');
    if (view === currentView) return;
    currentView = view;
    viewToggleBar.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    mainContent.hidden = view !== 'sessions';
    insightsPanel.hidden = view !== 'insights';
    promptsPanel.hidden = view !== 'prompts';
    libraryPanel.hidden = view !== 'library';

    if (view === 'insights') loadInsights();
    else if (view === 'prompts') loadPrompts();
    else if (view === 'library') loadLibrary();
  });
});

async function loadInsights() {
  const hasSession = !!(state.sessionData && state.sessionData.messages && state.sessionData.messages.length > 0);
  // Auto-pick only on first entry; afterwards the user's explicit choice sticks —
  // selecting a session while in 分析 view never implicitly morphs the scope.
  if (insightsScope === null) insightsScope = hasSession ? 'session' : 'global';

  if (insightsScope === 'session' && hasSession) {
    renderSessionInsights(state.sessionData);
    return;
  }

  insightsPanel.innerHTML = '<div class="insights-loading">Loading insights…</div>';
  const params = new URLSearchParams({ platform: state.platform });
  if (state.platform === 'openclaw' && state.selectedAgent) {
    params.set('agent', state.selectedAgent);
  }
  const dirVal = dirParam();
  if (dirVal) params.set('dir', dirVal);

  try {
    const data = await fetchJson('/api/insights?' + params.toString());
    insightsData = data;
    renderInsights(data);
  } catch (e) {
    insightsPanel.innerHTML =
      insightsScopeSegHtml('global') +
      `<div class="insights-empty">Failed to load insights: ${escapeHtml(e.message)}</div>`;
    bindInsightsScopeSeg();
  }
}

function insightsScopeSegHtml(active) {
  const hasSession = !!(state.sessionData && state.sessionData.messages && state.sessionData.messages.length > 0);
  const sessTitle = hasSession ? '仅分析当前选中的会话' : '需先选中会话';
  return `<div class="insights-scope-seg" id="insightsScopeSeg">
        <button class="seg-btn${active === 'global' ? ' active' : ''}" data-scope="global" title="聚合当前平台所有会话的统计">全局分析</button>
        <button class="seg-btn${active === 'session' ? ' active' : ''}" data-scope="session"${hasSession ? '' : ' disabled'} title="${sessTitle}">本会话分析</button>
      </div>`;
}

function bindInsightsScopeSeg() {
  const seg = document.getElementById('insightsScopeSeg');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.scope;
      if (btn.disabled || scope === insightsScope) return;
      insightsScope = scope;
      loadInsights();
    });
  });
}

function renderSessionInsights(sessionData) {
  const msgs = sessionData.messages;
  const session = sessionData.session || {};

  // --- Compute stats from messages ---
  let userCount = 0,
    assistantCount = 0,
    toolCallCount = 0,
    toolResultCount = 0,
    errorCount = 0;
  const toolStats = {}; // name → { calls, errors, totalDurationMs }
  const errors = []; // { toolName, snippet, timestamp }
  const toolCallsList = []; // { index, name, args, timestamp }
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheRead = 0;

  // Retry detection: track error→success chains per tool per turn
  let turnToolErrors = {};
  const retries = []; // { toolName, errorIndex, successIndex, errorSnippet, attempts }
  // Build a callId → toolName map (for Claude Code format where toolResult has no name)
  const callIdToName = {};

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role === 'user') {
      turnToolErrors = {};
      userCount++;
    }
    if (msg.role === 'assistant') {
      assistantCount++;
      if (msg.usage) {
        totalInputTokens += msg.usage.input || msg.usage.input_tokens || 0;
        totalOutputTokens += msg.usage.output || msg.usage.output_tokens || 0;
        totalCacheRead += msg.usage.cacheRead || msg.usage.cache_read || 0;
      }
    }
    if (msg.role === 'toolResult') {
      toolResultCount++;
      const name = msg.toolName || callIdToName[msg.toolCallId] || '?';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      if (msg.isError) {
        errorCount++;
        // (snippet helper defined below keeps JSON-body errors readable)
        toolStats[name].errors++;
        const snippet = firstInformativeLine(getTextContent(msg.content));
        errors.push({ toolName: name, snippet, timestamp: msg.timestamp, index: i });
        if (!turnToolErrors[name]) turnToolErrors[name] = { errorIndex: i, snippet, attempts: 0 };
        turnToolErrors[name].attempts++;
      } else if (turnToolErrors[name]) {
        // Success after errors = retry resolved
        if (turnToolErrors[name].attempts >= 2) {
          retries.push({
            toolName: name,
            errorIndex: turnToolErrors[name].errorIndex,
            successIndex: i,
            errorSnippet: turnToolErrors[name].snippet,
            attempts: turnToolErrors[name].attempts,
          });
        }
        turnToolErrors[name] = null;
      }
      if (msg.details && typeof msg.details.durationMs === 'number') {
        toolStats[name].totalDurationMs += msg.details.durationMs;
      }
    }
    // Standalone toolCall records (Codex/OMP style: separate role instead of content part)
    if (msg.role === 'toolCall') {
      toolCallCount++;
      const name = msg.toolName || 'unknown';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
      toolCallsList.push({ index: i, name, args: msg.details, timestamp: msg.timestamp, callId: msg.toolCallId });
      if (msg.toolCallId) callIdToName[msg.toolCallId] = name;
    }
    for (const c of msg.content || []) {
      if (c.type === 'toolCall') {
        toolCallCount++;
        const name = c.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        toolCallsList.push({ index: i, name, args: c.arguments, timestamp: msg.timestamp, callId: c.id });
        if (c.id) callIdToName[c.id] = name;
      }
      // Claude Code format: tool_use blocks inside assistant messages
      if (c.type === 'tool_use') {
        toolCallCount++;
        const name = c.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        toolCallsList.push({ index: i, name, args: c.input, timestamp: msg.timestamp, callId: c.id });
        if (c.id) callIdToName[c.id] = name;
      }
    }
  }

  // --- Build HTML ---
  const errorRate = toolResultCount > 0 ? ((errorCount / toolResultCount) * 100).toFixed(1) : '0.0';
  const tokenTotal = totalInputTokens + totalOutputTokens;
  const tokenFmt =
    tokenTotal >= 1_000_000
      ? (tokenTotal / 1_000_000).toFixed(1) + 'M'
      : tokenTotal >= 1_000
        ? (tokenTotal / 1_000).toFixed(1) + 'K'
        : tokenTotal.toString();

  // Overview cards
  const cardsHtml = `
        <div class="insight-cards">
          <div class="insight-card">
            <div class="value">${toolCallCount}</div>
            <div class="label">Tool Calls</div>
          </div>
          <div class="insight-card${errorCount > 0 ? ' error-card' : ''}">
            <div class="value">${errorRate}%</div>
            <div class="label">Error Rate</div>
          </div>
          <div class="insight-card">
            <div class="value">${retries.length}</div>
            <div class="label">Retries</div>
          </div>
          <div class="insight-card token-card">
            <div class="value">${tokenFmt}</div>
            <div class="label">Tokens</div>
          </div>
        </div>
      `;

  // Tool stats table
  const toolStatsArray = Object.entries(toolStats)
    .map(([name, st]) => ({ name, ...st, errorRate: st.calls > 0 ? st.errors / st.calls : 0 }))
    .sort((a, b) => b.calls - a.calls);
  const maxCalls = toolStatsArray.length > 0 ? toolStatsArray[0].calls : 1;

  const toolTableHtml =
    toolStatsArray.length > 0
      ? `
        <table class="tool-stats-table">
          <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Avg ms</th><th class="bar-cell"></th></tr></thead>
          <tbody>
            ${toolStatsArray
              .map((t) => {
                const barW = Math.max(2, Math.round((t.calls / maxCalls) * 100));
                const avgMs = t.totalDurationMs > 0 && t.calls > 0 ? Math.round(t.totalDurationMs / t.calls) : null;
                return `<tr>
                <td>${escapeHtml(t.name)}</td>
                <td>${t.calls}</td>
                <td style="color:${t.errors > 0 ? '#f85149' : 'inherit'}">${t.errors || '—'}</td>
                <td>${avgMs !== null ? formatDurationCompact(avgMs) : '—'}</td>
                <td class="bar-cell">
                  <div class="tool-stats-bar"><div class="fill" style="width:${barW}%"></div></div>
                </td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `
      : '<div style="color:var(--muted);font-size:13px">No tool calls in this session</div>';

  // Errors list
  const errorsHtml =
    errors.length > 0
      ? errors
          .map(
            (e) => `
        <div class="error-cluster-item" data-msg-index="${e.index}">
          <div class="error-cluster-header">
            <span class="error-cluster-pattern">${escapeHtml(e.snippet)}</span>
            <span class="error-cluster-count">${escapeHtml(e.toolName)}</span>
          </div>
        </div>
      `
          )
          .join('')
      : '<div style="color:var(--muted);font-size:13px">No errors</div>';

  // Retries list
  const retriesHtml =
    retries.length > 0
      ? retries
          .map(
            (r) => `
        <div class="error-cluster-item" data-retry-error="${r.errorIndex}" data-retry-success="${r.successIndex}">
          <div class="error-cluster-header">
            <span class="error-cluster-pattern">${escapeHtml(r.errorSnippet)}</span>
            <span class="error-cluster-count" style="color:#d29922">🔄 x${r.attempts} → OK</span>
          </div>
          <div class="error-cluster-example" style="margin-top:4px">
            <span style="color:var(--muted)">${escapeHtml(r.toolName)}</span>
          </div>
        </div>
      `
          )
          .join('')
      : '<div style="color:var(--muted);font-size:13px">No retries</div>';

  // Token breakdown
  const tokenBreakdown =
    totalInputTokens + totalOutputTokens + totalCacheRead > 0
      ? `
        <div class="insight-section">
          <h3>Token Breakdown</h3>
          <div class="token-grid">
            <span class="badge">Input: ${formatNumber(totalInputTokens)}</span>
            <span class="badge">Output: ${formatNumber(totalOutputTokens)}</span>
            ${totalCacheRead > 0 ? `<span class="badge">Cache Read: ${formatNumber(totalCacheRead)}</span>` : ''}
          </div>
        </div>
      `
      : '';

  // Tool call timeline (compact) — color per tool name
  const toolColorPalette = [
    { bg: 'rgba(88,166,255,0.15)', color: '#58a6ff' }, // blue
    { bg: 'rgba(63,185,80,0.15)', color: '#3fb950' }, // green
    { bg: 'rgba(210,153,34,0.15)', color: '#d29922' }, // yellow
    { bg: 'rgba(188,143,243,0.15)', color: '#bc8ff3' }, // purple
    { bg: 'rgba(219,109,40,0.15)', color: '#db6d28' }, // orange
    { bg: 'rgba(121,192,255,0.15)', color: '#79c0ff' }, // light blue
    { bg: 'rgba(255,123,114,0.15)', color: '#ff7b72' }, // salmon
    { bg: 'rgba(165,214,255,0.15)', color: '#a5d6ff' }, // sky
  ];
  const toolColorMap = {}; // toolName → color index
  let colorIdx = 0;
  for (const tc of toolCallsList) {
    if (!(tc.name in toolColorMap)) {
      toolColorMap[tc.name] = colorIdx % toolColorPalette.length;
      colorIdx++;
    }
  }

  const timelineHtml =
    toolCallsList.length > 0
      ? `
        <div class="insight-section" style="grid-column:1/-1">
          <h3>Tool Call Sequence</h3>
          <div class="tool-sequence">
            ${toolCallsList
              .map((tc, idx) => {
                const ci = toolColorMap[tc.name];
                const pal = toolColorPalette[ci];
                const hasErrorAfter = errors.some((e) => e.toolName === tc.name && e.timestamp === tc.timestamp);
                return `<span class="tool-seq-item${hasErrorAfter ? ' tool-seq-error' : ''}" style="background:${pal.bg};color:${pal.color}" title="${escapeHtml(tc.name)}">${escapeHtml(tc.name)}</span>`;
              })
              .join('<span class="tool-seq-arrow">→</span>')}
          </div>
          <div class="tool-seq-legend">
            ${Object.entries(toolColorMap)
              .map(([name, ci]) => {
                const pal = toolColorPalette[ci];
                return `<span class="tool-seq-legend-item"><span class="tool-seq-legend-swatch" style="background:${pal.color}"></span>${escapeHtml(name)}</span>`;
              })
              .join('')}
          </div>
        </div>
      `
      : '';

  const sid = session.id || state.selectedSessionId || '?';

  insightsPanel.innerHTML = `
        ${insightsScopeSegHtml('session')}
        <h2>本会话分析 <span class="scope-chip">📍 仅当前会话</span></h2>
        <div class="insight-session-meta">
          <span class="badge">${escapeHtml(sid.slice(0, 20))}</span>
          ${session.cwd ? `<span class="badge">${escapeHtml(session.cwd)}</span>` : ''}
          <span class="badge">👤 ${userCount} &nbsp; 🤖 ${assistantCount}</span>
        </div>
        ${cardsHtml}
        <div class="insight-sections">
          <div class="insight-section">
            <h3>Tool Statistics</h3>
            ${toolTableHtml}
          </div>
          <div class="insight-section">
            <h3>Errors (${errors.length})</h3>
            <div class="error-cluster-list">${errorsHtml}</div>
          </div>
          <div class="insight-section">
            <h3>Retries (${retries.length})</h3>
            <div class="error-cluster-list">${retriesHtml}</div>
          </div>
          ${tokenBreakdown}
        </div>
        ${timelineHtml}
      `;

  bindInsightsScopeSeg();

  // Bind: click error → scroll to that message
  insightsPanel.querySelectorAll('[data-msg-index]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-msg-index'), 10);
      switchToSessionsAndScroll(idx);
    });
  });

  // Bind: click retry → scroll to the error message
  insightsPanel.querySelectorAll('[data-retry-error]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-retry-error'), 10);
      switchToSessionsAndScroll(idx);
    });
  });

  function switchToSessionsAndScroll(msgIdx) {
    currentView = 'sessions';
    viewToggleBar.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.remove('active'));
    viewToggleBar.querySelector('[data-view="sessions"]').classList.add('active');
    mainContent.hidden = false;
    insightsPanel.hidden = true;
    promptsPanel.hidden = true;
    libraryPanel.hidden = true;
    if (msgs[msgIdx] && msgs[msgIdx].id) scrollToMessage(msgs[msgIdx].id);
  }
}

function renderInsights(data) {
  if (!data || data.totalSessions === 0) {
    insightsPanel.innerHTML =
      insightsScopeSegHtml('global') +
      '<div class="insights-empty">No session data available for the current selection.</div>';
    bindInsightsScopeSeg();
    return;
  }

  const errPct = (data.errorRate * 100).toFixed(1);
  const tokenTotal = data.tokenUsage.input + data.tokenUsage.output;
  const tokenFmt =
    tokenTotal >= 1_000_000
      ? (tokenTotal / 1_000_000).toFixed(1) + 'M'
      : tokenTotal >= 1_000
        ? (tokenTotal / 1_000).toFixed(1) + 'K'
        : tokenTotal.toString();

  // Overview cards
  const cardsHtml = `
        <div class="insight-cards">
          <div class="insight-card">
            <div class="value">${data.totalSessions}</div>
            <div class="label">Sessions</div>
          </div>
          <div class="insight-card">
            <div class="value">${data.totalToolCalls}</div>
            <div class="label">Tool Calls</div>
          </div>
          <div class="insight-card error-card">
            <div class="value">${errPct}%</div>
            <div class="label">Error Rate</div>
          </div>
          <div class="insight-card token-card">
            <div class="value">${tokenFmt}</div>
            <div class="label">Tokens (in+out)</div>
          </div>
          ${
            data.totalCost > 0
              ? `
          <div class="insight-card cost-card">
            <div class="value">💰 ${formatCost(data.totalCost)}</div>
            <div class="label">Cost</div>
          </div>`
              : ''
          }
        </div>
      `;

  // Tool stats table
  const maxCalls = data.toolStats.length > 0 ? data.toolStats[0].calls : 1;
  const toolTableHtml =
    data.toolStats.length > 0
      ? `
        <table class="tool-stats-table">
          <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Err%</th><th class="bar-cell"></th></tr></thead>
          <tbody>
            ${data.toolStats
              .slice(0, 15)
              .map((t) => {
                const barW = Math.max(2, Math.round((t.calls / maxCalls) * 100));
                const errPctStr = t.errors > 0 ? (t.errorRate * 100).toFixed(1) + '%' : '—';
                const errBarW = t.errors > 0 ? Math.max(2, Math.round((t.errors / t.calls) * 100)) : 0;
                return `<tr>
                <td>${escapeHtml(t.name)}</td>
                <td>${t.calls}</td>
                <td style="color:${t.errors > 0 ? '#f85149' : 'inherit'}">${t.errors || '—'}</td>
                <td style="color:${t.errors > 0 ? '#f85149' : 'inherit'}">${errPctStr}</td>
                <td class="bar-cell">
                  <div class="tool-stats-bar"><div class="fill" style="width:${barW}%"></div></div>
                  ${errBarW > 0 ? `<div class="tool-stats-bar" style="margin-top:2px"><div class="fill error" style="width:${errBarW}%"></div></div>` : ''}
                </td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `
      : '<div style="color:var(--muted);font-size:13px">No tool data</div>';

  // Error clusters
  const errClustersHtml =
    data.errorClusters.length > 0
      ? data.errorClusters
          .map((c) => {
            const examplesHtml = c.examples
              .map(
                (e) => `
          <div class="error-cluster-example">
            <span class="session-link" data-session-id="${escapeHtml(e.sessionId)}" data-msg-id="${escapeHtml(e.messageId || '')}">${escapeHtml(e.sessionId.slice(0, 12))}…</span>
            <span>${escapeHtml(e.toolName)}</span>
          </div>
        `
              )
              .join('');
            return `
          <div class="error-cluster-item" data-cluster>
            <div class="error-cluster-header">
              <span class="error-cluster-pattern" title="${escapeHtml(c.pattern)}">${escapeHtml(c.pattern)}</span>
              <span class="error-cluster-count">x${c.count}</span>
            </div>
            <div class="error-cluster-examples" hidden>${examplesHtml}</div>
          </div>
        `;
          })
          .join('')
      : '<div style="color:var(--muted);font-size:13px">No errors found</div>';

  // Trend chart
  let trendHtml = '';
  if (data.trend.length > 0) {
    const maxVal = Math.max(...data.trend.map((d) => Math.max(d.sessions, d.errors, d.toolCalls)), 1);
    const barsHtml = data.trend
      .map((d) => {
        const sH = Math.max(1, Math.round((d.sessions / maxVal) * 90));
        const eH = Math.max(1, Math.round((d.errors / maxVal) * 90));
        const tH = Math.max(1, Math.round((d.toolCalls / maxVal) * 90));
        const label = d.date.slice(5); // MM-DD
        return `
            <div class="trend-bar-group" title="${escapeHtml(d.date)}: ${d.sessions} sessions, ${d.errors} errors, ${d.toolCalls} tool calls${d.cost > 0 ? `, ${formatCost(d.cost)}` : ''}">
              <div class="trend-bar sessions-bar" style="height:${sH}px"></div>
              <div class="trend-bar errors-bar" style="height:${eH}px"></div>
              <div class="trend-bar toolcalls-bar" style="height:${tH}px"></div>
              ${d.cost > 0 ? `<span class="trend-bar-cost">${formatCost(d.cost)}</span>` : ''}
              <span class="trend-bar-label">${escapeHtml(label)}</span>
            </div>
          `;
      })
      .join('');

    trendHtml = `
          <div class="trend-section">
            <h3>Daily Trend</h3>
            <div class="trend-chart">${barsHtml}</div>
            <div class="trend-legend">
              <span class="leg-sessions">Sessions</span>
              <span class="leg-errors">Errors</span>
              <span class="leg-toolcalls">Tool Calls</span>
            </div>
          </div>
        `;
  }

  insightsPanel.innerHTML = `
        ${insightsScopeSegHtml('global')}
        <h2>全局分析${state.platform === 'openclaw' && state.selectedAgent ? ' — ' + escapeHtml(state.selectedAgent) : ''} ${platformScopeChip()}</h2>
        ${cardsHtml}
        <div class="insight-sections">
          <div class="insight-section">
            <h3>Tool Statistics</h3>
            ${toolTableHtml}
          </div>
          <div class="insight-section">
            <h3>Error Clusters</h3>
            <div class="error-cluster-list">${errClustersHtml}</div>
          </div>
        </div>
        ${trendHtml}
        <div class="insight-section" id="toolsAuditSection"></div>
      `;
  bindInsightsScopeSeg();

  // Bind error cluster expand/collapse
  insightsPanel.querySelectorAll('[data-cluster]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-link')) return;
      const examples = el.querySelector('.error-cluster-examples');
      if (examples) examples.hidden = !examples.hidden;
    });
  });

  // Bind session links in error examples
  insightsPanel.querySelectorAll('.session-link').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = link.getAttribute('data-session-id');
      if (!sid) return;
      // Switch back to sessions view, find and select this session
      currentView = 'sessions';
      viewToggleBar.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.remove('active'));
      viewToggleBar.querySelector('[data-view="sessions"]').classList.add('active');
      mainContent.hidden = false;
      insightsPanel.hidden = true;
      // Search for the session by ID
      sessionSearch.value = sid;
      filterSessions();
      renderSessions();
      // Try to select it
      const match = state.filteredSessions.find((s) => s.id === sid || s.id.startsWith(sid));
      if (match) {
        state.selectedSessionId = match.id;
        renderSessions();
        scrollSessionIntoView(match.id);
        await loadSession();
        // Land directly on the failing message (also leaves Trace view / clears filters)
        const msgId = link.getAttribute('data-msg-id');
        if (msgId) scrollToMessage(msgId);
      }
    });
  });

  initToolsAudit();
}

// --- 工具体检 (Tools Audit, aggregate across all platforms) ---
function toolsAuditParams() {
  const params = new URLSearchParams({ platform: 'all' });
  if (state.settings.openclawDir) params.set('dirOpenclaw', state.settings.openclawDir);
  if (state.settings.codexDir) params.set('dirCodex', state.settings.codexDir);
  if (state.settings.claudeCodeDir) params.set('dirClaude', state.settings.claudeCodeDir);
  if (state.settings.ompDir) params.set('dirOmp', state.settings.ompDir);
  if (state.settings.dshDir) params.set('dirDsh', state.settings.dshDir);
  return params;
}

function initToolsAudit() {
  if (toolsAuditChecked || toolsAuditLoading) {
    renderToolsAudit();
    return;
  }
  loadToolsAudit(false);
}

async function loadToolsAudit(refresh) {
  if (toolsAuditLoading) return;
  toolsAuditLoading = true;
  toolsAuditError = null;
  renderToolsAudit();
  try {
    const params = toolsAuditParams();
    params.set(refresh ? 'refresh' : 'cached', '1');
    const resp = await fetch('/api/tools/audit?' + params.toString());
    if (resp.status === 204) {
      toolsAudit = null; // no persisted audit yet — offer 运行体检
    } else if (!resp.ok) {
      throw new Error((await resp.json().catch(() => null))?.error || resp.statusText);
    } else {
      toolsAudit = await resp.json();
    }
  } catch (error) {
    toolsAuditError = error.message;
  } finally {
    toolsAuditChecked = true;
    toolsAuditLoading = false;
    renderToolsAudit();
  }
}

function fmtAuditMs(ms) {
  if (ms == null) return '—';
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms) + 'ms';
}

function fmtAuditDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function renderToolsAudit() {
  const section = document.getElementById('toolsAuditSection');
  if (!section) return;

  const btnHtml = `<button class="export-btn" id="toolsAuditRunBtn" ${toolsAuditLoading ? 'disabled' : ''} title="扫描全部平台会话，统计每个工具的调用/错误率/耗时">${toolsAuditLoading ? '体检中…' : toolsAudit ? '重新体检' : '运行体检'}</button>`;
  const metaHtml =
    toolsAudit && toolsAudit.generatedAt
      ? ` <span style="text-transform:none;letter-spacing:0;color:var(--muted)">— ${(toolsAudit.tools || []).length} 个工具 / ${escapeHtml(new Date(toolsAudit.generatedAt).toLocaleString())}</span>`
      : '';

  let bodyHtml;
  if (toolsAuditLoading && !toolsAudit) {
    bodyHtml = '<div class="insights-loading">体检中…扫描全部平台会话统计工具调用</div>';
  } else if (toolsAuditError) {
    bodyHtml = `<div class="analysis-error">体检失败: ${escapeHtml(toolsAuditError)}</div>`;
  } else if (!toolsAudit) {
    bodyHtml =
      '<div style="color:var(--muted);font-size:13px">暂无体检结果 — 点击「运行体检」扫描全部平台的工具使用情况（调用量、错误率、平均耗时、闲置配置）。</div>';
  } else {
    const tools = toolsAudit.tools || [];
    const shown = toolsAuditShowAll ? tools : tools.slice(0, 30);
    const maxCalls = tools.length ? Math.max(tools[0].calls, 1) : 1;
    const rowsHtml = shown
      .map((t) => {
        const barW = Math.max(2, Math.round((t.calls / maxCalls) * 100));
        const errPctStr = t.errors > 0 ? (t.errorRate * 100).toFixed(1) + '%' : '—';
        return `<tr>
            <td>${escapeHtml(t.name)}</td>
            <td style="color:var(--muted)">${escapeHtml((t.platforms || []).join(', '))}</td>
            <td>${t.calls}</td>
            <td style="color:${t.errors > 0 ? '#f85149' : 'inherit'}">${errPctStr}</td>
            <td>${fmtAuditMs(t.avgMs)}</td>
            <td style="color:var(--muted)">${fmtAuditDate(t.lastUsed)}</td>
            <td class="bar-cell"><div class="tool-stats-bar"><div class="fill" style="width:${barW}%"></div></div></td>
          </tr>`;
      })
      .join('');
    const moreHtml =
      tools.length > shown.length
        ? `<button class="export-btn" id="toolsAuditMoreBtn" style="margin-top:8px">展开全部 ${tools.length} 个工具</button>`
        : '';
    const unused = toolsAudit.configuredUnused || [];
    const unusedHtml = unused.length
      ? `
          <div class="tools-audit-unused">
            <div style="margin-bottom:6px">配置了但从未使用（${unused.length}）：</div>
            ${unused.map((u) => `<code title="${escapeHtml(u.source || '')}">${escapeHtml(u.name)}</code>`).join('')}
            <div class="tools-audit-hint">这些配置每轮都会占用上下文 — 建议考虑移除以节省每轮 token。</div>
          </div>`
      : '';
    bodyHtml = `
          ${
            tools.length
              ? `
          <table class="tool-stats-table">
            <thead><tr><th>工具</th><th>平台</th><th>调用</th><th>错误率</th><th>平均耗时</th><th>最近使用</th><th class="bar-cell"></th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>${moreHtml}`
              : '<div style="color:var(--muted);font-size:13px">没有工具调用数据</div>'
          }
          ${unusedHtml}
        `;
  }

  section.innerHTML = `
        <div class="tools-audit-head"><h3 style="margin:0">🔧 工具体检 <span class="scope-chip">🌐 全平台</span>${metaHtml}</h3>${btnHtml}</div>
        ${bodyHtml}
      `;

  const runBtn = document.getElementById('toolsAuditRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => loadToolsAudit(true));
  const moreBtn = document.getElementById('toolsAuditMoreBtn');
  if (moreBtn)
    moreBtn.addEventListener('click', () => {
      toolsAuditShowAll = true;
      renderToolsAudit();
    });
}

// --- Prompts View ---
function promptsQueryParams() {
  const params = new URLSearchParams({ platform: state.platform });
  if (state.platform === 'openclaw' && state.selectedAgent) {
    params.set('agent', state.selectedAgent);
  }
  let rawDir = '';
  if (state.platform === 'openclaw') rawDir = state.settings.openclawDir;
  else if (state.platform === 'codex') rawDir = state.settings.codexDir;
  else if (state.platform === 'claude-code') rawDir = state.settings.claudeCodeDir;
  else if (state.platform === 'hermes') rawDir = state.settings.hermesDir;
  else if (state.platform === 'omp') rawDir = state.settings.ompDir;
  else if (state.platform === 'dsh') rawDir = state.settings.dshDir;
  if (rawDir) params.set('dir', rawDir);
  return params;
}

async function loadPrompts() {
  promptsPanel.innerHTML = '<div class="insights-loading">Loading prompts…</div>';
  if (promptAnalysis && promptAnalysis.platform !== state.platform) promptAnalysis = null;

  const hiddenFetch = fetchJson('/api/prompts/hidden')
    .then((d) => (d && d.hidden) || [])
    .catch(() => hiddenPrompts);
  if (!promptAnalysis) restoreCachedAnalysis();

  try {
    const data = await fetchJson('/api/prompts?' + promptsQueryParams().toString());
    hiddenPrompts = await hiddenFetch;
    promptsData = data;
    renderPrompts();
  } catch (error) {
    promptsPanel.innerHTML = `<div class="insights-empty">Failed to load prompts: ${escapeHtml(error.message)}</div>`;
  }
}

// Batch-hide helper: dedupes texts and chunks POSTs at 500 per request (backend limit)
async function hidePromptTexts(texts) {
  const unique = [...new Set(texts)];
  for (let i = 0; i < unique.length; i += 500) {
    const resp = await fetch('/api/prompts/hidden', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: unique.slice(i, i + 500) }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);
  }
}

// Unified toast: top-right, auto-dismiss (3s), stacks; kind = 'info' | 'error'
function showToast(message, kind = 'info') {
  let holder = document.getElementById('toastHolder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toastHolder';
    document.body.appendChild(holder);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' toast-error' : '');
  el.textContent = message;
  holder.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Restore the last persisted clustering analysis (never computes; 204 = none)
async function restoreCachedAnalysis() {
  try {
    const params = promptsQueryParams();
    params.set('cached', '1');
    const resp = await fetch('/api/prompts/analyze?' + params.toString());
    if (resp.status !== 200) return;
    const data = await resp.json();
    if (!data || data.platform !== state.platform || promptAnalysis || promptAnalysisLoading) return;
    promptAnalysis = data;
    if (currentView === 'prompts' && promptsData) renderPrompts();
  } catch {}
}

async function loadPromptAnalysis(refresh) {
  if (promptAnalysisLoading) return;
  promptAnalysisLoading = true;
  promptAnalysisStartedAt = Date.now();
  const elapsedTicker = setInterval(() => {
    const el = document.getElementById('analysisElapsed');
    if (el) el.textContent = Math.floor((Date.now() - promptAnalysisStartedAt) / 1000) + 's';
  }, 1000);
  renderPrompts();
  try {
    const params = promptsQueryParams();
    if (refresh) params.set('refresh', '1');
    promptAnalysis = await fetchJson('/api/prompts/analyze?' + params.toString());
  } catch (error) {
    promptAnalysis = { platform: state.platform, clusters: [], overall: [], llmError: error.message };
  } finally {
    clearInterval(elapsedTicker);
    promptAnalysisLoading = false;
    renderPrompts();
    if (typeof showToast === 'function') showToast('画像分析完成');
  }
}

function renderAnalysisHtml() {
  if (promptAnalysisLoading) {
    const elapsedSec = promptAnalysisStartedAt ? Math.floor((Date.now() - promptAnalysisStartedAt) / 1000) : 0;
    return `<div class="insight-section analysis-section"><h3>📊 Prompt 画像</h3><div class="analysis-loading">Claude 分析中… 已耗时 <span id="analysisElapsed">${elapsedSec}s</span> · 约 1-2 分钟(聚类 → 归因 → 主题标注 → LLM 建议)<br><span style="color:var(--muted);font-size:0.78rem">结果会自动保存，可离开此页稍后回来看</span></div></div>`;
  }
  if (!promptAnalysis || promptAnalysis.platform !== state.platform) return '';

  const a = promptAnalysis;
  const overallHtml = (a.overall || []).length
    ? `<ul class="analysis-overall">${a.overall.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
    : '';
  const errorHtml = a.llmError
    ? `<div class="analysis-error">LLM 分析失败: ${escapeHtml(a.llmError)} — 以下为聚类与归因结果</div>`
    : '';
  const rawHtml = a.rawText
    ? `<div class="prompt-text" style="margin-bottom:12px">${renderMarkdown(a.rawText)}</div>`
    : '';

  // Topic → color: topics[] order first, then any extras seen in weeklyTrend
  const palette = [
    '#58a6ff',
    '#3fb950',
    '#d29922',
    '#f778ba',
    '#a371f7',
    '#79c0ff',
    '#56d364',
    '#e3b341',
    '#ff7b72',
    '#8b949e',
  ];
  const topicOrder = (a.topics || []).map((t) => t.topic);
  for (const w of a.weeklyTrend || []) {
    for (const t of Object.keys(w.topics || {})) if (!topicOrder.includes(t)) topicOrder.push(t);
  }
  const topicColor = (t) => palette[Math.max(0, topicOrder.indexOf(t)) % palette.length];

  // 主题构成 — horizontal bars, skipped when the LLM stage produced no topics
  let topicsHtml = '';
  if ((a.topics || []).length) {
    const maxPrompts = Math.max(...a.topics.map((t) => t.prompts), 1);
    topicsHtml = `
          <div class="portrait-subhead">主题构成</div>
          <div class="portrait-topics">
            ${a.topics
              .map(
                (t) => `
            <div class="portrait-topic-row">
              <span class="name" title="${escapeHtml(t.topic)}">${escapeHtml(t.topic)}</span>
              <div class="bar"><div class="fill" style="width:${Math.max(2, Math.round((t.prompts / maxPrompts) * 100))}%;background:${topicColor(t.topic)}"></div></div>
              <span class="num">${t.prompts} prompts / ${t.clusters} 簇</span>
            </div>`
              )
              .join('')}
          </div>`;
  }

  // 周趋势 — last 8 weeks, stacked by topic
  let weeklyHtml = '';
  const weeks = (a.weeklyTrend || []).slice(-8);
  if (weeks.length) {
    const maxTotal = Math.max(...weeks.map((w) => w.total), 1);
    const usedTopics = new Set();
    const colsHtml = weeks
      .map((w) => {
        const h = Math.max(2, Math.round((w.total / maxTotal) * 64));
        const entries = Object.entries(w.topics || {})
          .filter(([, n]) => n > 0)
          .sort((x, y) => y[1] - x[1]);
        const segs = entries
          .map(([t, n]) => {
            usedTopics.add(t);
            return `<div class="seg" style="height:${Math.max(1, Math.round((n / w.total) * h))}px;background:${topicColor(t)}"></div>`;
          })
          .join('');
        const tip = `${w.week} 起的一周: ${w.total} prompts${entries.length ? ' · ' + entries.map(([t, n]) => `${t} ${n}`).join(' · ') : ''}`;
        return `
            <div class="portrait-week-group" title="${escapeHtml(tip)}">
              <div class="portrait-week-col">${segs || `<div class="seg" style="height:${h}px;background:${palette[palette.length - 1]}"></div>`}</div>
              <span class="portrait-week-label">${escapeHtml(w.week.slice(5))}</span>
            </div>`;
      })
      .join('');
    weeklyHtml = `
          <div class="portrait-subhead">周趋势（近 ${weeks.length} 周）</div>
          <div class="portrait-week-chart">${colsHtml}</div>
          ${usedTopics.size ? `<div class="portrait-legend">${[...usedTopics].map((t) => `<span><span class="dot" style="background:${topicColor(t)}"></span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}`;
  }

  const displayClusters = (a.clusters || []).filter((c) => c.count > 1).slice(0, 20);

  // 差生榜 — errorRate above the library mean, or avgMessages notably high
  let flopHtml = '';
  const attributed = displayClusters.filter((c) => c.attribution);
  if (attributed.length >= 2) {
    const meanErr = attributed.reduce((s, c) => s + c.attribution.errorRate, 0) / attributed.length;
    const meanMsgs = attributed.reduce((s, c) => s + c.attribution.avgMessages, 0) / attributed.length;
    const flops = attributed
      .filter((c) => c.attribution.errorRate > meanErr || c.attribution.avgMessages > meanMsgs * 1.5)
      .sort((x, y) => y.attribution.errorRate - x.attribution.errorRate)
      .slice(0, 5);
    if (flops.length) {
      flopHtml = `
            <div class="portrait-subhead">差生榜（错误率高于库均值 ${meanErr.toFixed(1)}% 或平均轮数明显偏高）</div>
            <div class="portrait-flop">
              ${flops
                .map(
                  (c) => `
              <div class="portrait-flop-item">
                <span class="pat" title="${escapeHtml(c.pattern)}">${escapeHtml(c.pattern)}</span>
                <span class="cluster-metric${c.attribution.errorRate > meanErr ? ' warn' : ''}">err ${c.attribution.errorRate}%</span>
                <span class="cluster-metric">avg ${c.attribution.avgMessages} msgs</span>
                <span class="cluster-metric">×${c.count}</span>
                ${(c.errorSamples || [])
                  .slice(0, 3)
                  .map(
                    (sm) =>
                      `<div class="portrait-flop-sample">${escapeHtml(String(sm).replace(/\s+/g, ' ').slice(0, 200))}</div>`
                  )
                  .join('')}
              </div>`
                )
                .join('')}
            </div>`;
    }
  }

  const clustersHtml = displayClusters
    .map((c, ci) => {
      const attr = c.attribution;
      const saved = clusterSavedPatterns.has(c.pattern);
      const metrics = [
        c.topic ? `<span class="cluster-topic">${escapeHtml(c.topic)}</span>` : '',
        `<span class="cluster-metric">×${c.count}</span>`,
        attr ? `<span class="cluster-metric">avg ${attr.avgMessages} msgs</span>` : '',
        attr ? `<span class="cluster-metric">avg ${attr.avgToolCalls} tools</span>` : '',
        attr ? `<span class="cluster-metric${attr.errorRate > 10 ? ' warn' : ''}">err ${attr.errorRate}%</span>` : '',
        `<button class="cluster-save-btn" data-ci="${ci}" ${saved ? 'disabled' : ''} title="以本簇为模板存入 Prompt Library（自动取公共前缀 + $ARGUMENTS）">${saved ? '✓ 已入库' : '📥 入库'}</button>`,
      ]
        .filter(Boolean)
        .join('');
      const s = c.suggestion;
      const body = s
        ? `
          <div class="assessment">${escapeHtml(s.assessment || '')}</div>
          ${(s.issues || []).length ? `<ul class="issues">${s.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
          ${
            s.rewrite
              ? `
          <div class="rewrite-block">
            <div class="label">建议改写</div>
            <div class="prompt-text">${renderMarkdown(s.rewrite)}</div>
            <button class="prompt-copy-btn cluster-rewrite-copy" data-ci="${ci}" style="opacity:1">Copy</button>
            ${s.rationale ? `<div class="rationale">${escapeHtml(s.rationale)}</div>` : ''}
          </div>`
              : ''
          }
        `
        : '<div style="color:var(--muted);font-size:0.8rem">此模板未参与 LLM 分析(仅 top 8 高频簇)</div>';
      return `
        <div class="cluster-row">
          <div class="cluster-head">
            <span class="caret">▶</span>
            <span class="cluster-pattern" title="${escapeHtml(c.pattern)}">${escapeHtml(c.pattern)}</span>
            <span class="cluster-metrics">${metrics}</span>
          </div>
          <div class="cluster-body" hidden>${body}</div>
        </div>`;
    })
    .join('');

  return `
        <div class="insight-section analysis-section">
          <h3>📊 Prompt 画像 <span style="text-transform:none;letter-spacing:0;color:var(--muted)">— ${a.totalClusters} 个模板簇 / ${escapeHtml(new Date(a.generatedAt).toLocaleString())}${a.persisted ? ' · 已保存的上次结果 · 点击重新分析可更新' : ''}</span></h3>
          ${errorHtml}${rawHtml}${overallHtml}
          ${topicsHtml}${weeklyHtml}${flopHtml}
          ${topicsHtml || weeklyHtml || flopHtml ? '<div class="portrait-subhead">模板簇</div>' : ''}
          ${clustersHtml || '<div style="color:var(--muted)">没有出现 2 次以上的模板</div>'}
        </div>
      `;
}

function promptsMatchesSearch(session, q) {
  if (!q) return true;
  if (session.id.toLowerCase().includes(q)) return true;
  if ((session.slug || '').toLowerCase().includes(q)) return true;
  if ((session.title || '').toLowerCase().includes(q)) return true;
  return session.prompts.some((p) => p.text.toLowerCase().includes(q));
}

function renderPrompts() {
  if (!promptsData || !promptsData.groups.length) {
    promptsPanel.innerHTML = '<div class="insights-empty">No prompts found.</div>';
    return;
  }

  promptSelection.clear();
  const q = promptsSearch.trim().toLowerCase();
  let groups = promptsData.groups
    .map((g) => ({
      ...g,
      sessions: g.sessions.filter((s) => promptsMatchesSearch(s, q) || g.directory.toLowerCase().includes(q)),
    }))
    .filter((g) => g.sessions.length > 0);

  // Trivial-prompt filter (< 12 chars whitespace-collapsed); auto-disabled while searching
  const trivialActive = !q && promptsHideTrivial;
  let hiddenTrivial = 0;
  if (trivialActive) {
    groups = groups
      .map((g) => ({
        ...g,
        sessions: g.sessions
          .map((s) => {
            const kept = s.prompts.filter((p) => p.text.replace(/\s+/g, ' ').trim().length >= 12);
            hiddenTrivial += s.prompts.length - kept.length;
            return kept.length === s.prompts.length ? s : { ...s, prompts: kept, promptCount: kept.length };
          })
          .filter((s) => s.prompts.length > 0),
      }))
      .filter((g) => g.sessions.length > 0);
  }

  const shownSessions = groups.reduce((n, g) => n + g.sessions.length, 0);
  const shownPrompts = groups.reduce((n, g) => n + g.sessions.reduce((m, s) => m + s.promptCount, 0), 0);

  const groupsHtml = groups
    .map(
      (g, gi) => `
        <div class="insight-section">
          <h3>${promptSelectMode ? `<input type="checkbox" class="group-select-cb" data-gi="${gi}" title="选择本组（目录）全部 prompt">` : ''}${escapeHtml(g.directory)} <span style="text-transform:none;letter-spacing:0;">— ${g.sessions.length} sessions / ${g.sessions.reduce((m, s) => m + s.promptCount, 0)} prompts</span></h3>
          ${g.sessions
            .map((s, si) => {
              const dateStr = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
              const expanded = !!q;
              return `
            <div class="prompt-session" data-gi="${gi}" data-si="${si}">
              <div class="prompt-session-header">
                ${promptSelectMode ? `<input type="checkbox" class="session-select-cb" data-gi="${gi}" data-si="${si}" title="选择本 session 全部 prompt">` : ''}
                <span class="caret">${expanded ? '▼' : '▶'}</span>
                <span class="meta">${escapeHtml(dateStr)}</span>
                <span class="session-open-link" data-session-id="${escapeHtml(s.id)}" title="Open session">${escapeHtml(s.id.slice(0, 12))}…</span>
                <span class="prompt-preview" title="${escapeHtml(s.prompts[0].text.slice(0, 500))}">${escapeHtml(s.prompts[0].text.replace(/\s+/g, ' ').slice(0, 160))}</span>
                ${s.slug ? `<span class="meta">${escapeHtml(s.slug)}</span>` : ''}
                ${s.title ? `<span class="meta">${escapeHtml(s.title)}</span>` : ''}
                <span class="prompt-count-chip">${s.promptCount} prompt${s.promptCount > 1 ? 's' : ''}</span>
                ${promptSelectMode ? '' : `<button class="session-hide-btn" data-gi="${gi}" data-si="${si}" title="隐藏本 session 全部 prompt">🗑</button>`}
              </div>
              <div class="prompt-list" ${expanded ? '' : 'hidden'}>
                ${s.prompts
                  .map(
                    (p, pi) => `
                  <div class="prompt-item${promptSelectMode ? ' selectable' : ''}" data-key="${gi}:${si}:${pi}">
                    ${promptSelectMode ? `<input type="checkbox" class="prompt-select-cb" data-key="${gi}:${si}:${pi}">` : ''}
                    ${p.timestamp ? `<div class="prompt-time">${escapeHtml(new Date(p.timestamp).toLocaleString())}</div>` : ''}
                    <div class="prompt-text${p.text.length > 500 ? ' clamped' : ''}">${renderMarkdown(p.text)}</div>
                    ${p.text.length > 500 ? '<span class="show-more">Show more</span>' : ''}
                    <button class="prompt-hide-btn" data-gi="${gi}" data-si="${si}" data-pi="${pi}" title="隐藏此 prompt（同文重复项一并隐藏，可恢复）">🗑</button>
                    <button class="prompt-optimize-btn" data-gi="${gi}" data-si="${si}" data-pi="${pi}" title="用 Claude 改写这条 prompt">优化</button>
                    <button class="prompt-copy-btn" data-gi="${gi}" data-si="${si}" data-pi="${pi}" title="Copy prompt">Copy</button>
                    <button class="prompt-star-btn" data-gi="${gi}" data-si="${si}" data-pi="${pi}" title="收藏到资产库">⭐ 收藏</button>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>`;
            })
            .join('')}
        </div>
      `
    )
    .join('');

  promptsPanel.innerHTML = `
        <div class="prompts-toolbar">
          <input type="search" id="promptsSearchInput" placeholder="Filter prompts / directories / sessions" value="${escapeHtml(promptsSearch)}">
          <button class="export-btn" id="promptsAnalyzeBtn" ${promptAnalysisLoading ? 'disabled' : ''} title="把相似 prompt 聚成模板簇，统计每类平均轮数/错误率，并由 Claude 给出改写建议（约 1-2 分钟）">${promptAnalysisLoading ? '分析中…' : promptAnalysis && promptAnalysis.platform === state.platform ? '重新分析' : '🧮 聚类分析'}</button>
          <label class="toggle" title="隐藏折叠后不足 12 字符的琐碎 prompt（搜索时自动停用）"><span>隐藏琐碎 prompt</span><input id="promptsHideTrivial" type="checkbox" ${promptsHideTrivial ? 'checked' : ''}></label>
          ${hiddenPrompts.length ? `<button class="hidden-manage-link" id="promptsHiddenManageBtn">已隐藏 ${hiddenPrompts.length} · 管理</button>` : ''}
          <button class="export-btn${promptSelectMode ? ' mode-active' : ''}" id="promptsSelectModeBtn" title="批量选择 prompt 后一键隐藏（可恢复）">☑ 批量选择</button>
          <button class="export-btn" id="promptsExportBtn">导出 JSON</button>
        </div>
        <div class="prompts-summary">${platformScopeChip()} 从会话历史自动提取的真人 prompt（已过滤工具输出与系统注入），按目录分组 — 每条可 ⭐ 收藏入库、「优化」用 Claude 改写 · ${promptsData.totalPrompts} prompts / ${promptsData.totalSessions} sessions / ${promptsData.groups.length} directories${q ? ` — showing ${shownPrompts} prompts / ${shownSessions} sessions` : ''}${trivialActive && hiddenTrivial ? ` <span class="scope-chip">已滤琐碎 ${hiddenTrivial}</span>` : ''}${hiddenPrompts.length ? ` <span class="scope-chip">已隐藏 ${hiddenPrompts.length}</span>` : ''}</div>
        ${renderAnalysisHtml()}
        ${groupsHtml || '<div class="insights-empty">No matches.</div>'}
        ${
          promptSelectMode
            ? `
        <div class="prompt-select-bar" id="promptSelectBar">
          <span>已选 <span id="promptSelCount">0</span> 条</span>
          <button class="export-btn danger" id="promptSelHideBtn" disabled>🗑 隐藏选中</button>
          <button class="export-btn" id="promptSelCancelBtn">取消</button>
        </div>`
            : ''
        }
      `;

  // Search input (debounced re-render, keep focus)
  const searchInput = document.getElementById('promptsSearchInput');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      promptsSearch = searchInput.value;
      renderPrompts();
      const el = document.getElementById('promptsSearchInput');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 250);
  });

  // Export full (unfiltered) data as JSON download
  document.getElementById('promptsExportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(promptsData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `prompts-${state.platform}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Trivial-prompt filter toggle
  document.getElementById('promptsHideTrivial').addEventListener('change', (e) => {
    promptsHideTrivial = e.target.checked;
    try {
      localStorage.setItem('axr-hide-trivial', promptsHideTrivial ? '1' : '0');
    } catch {}
    renderPrompts();
  });

  // Hidden-prompts management modal opener
  const hiddenManageBtn = document.getElementById('promptsHiddenManageBtn');
  if (hiddenManageBtn) hiddenManageBtn.addEventListener('click', openHiddenPromptsModal);

  // Collapse/expand sessions
  promptsPanel.querySelectorAll('.prompt-session-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.session-open-link, .session-select-cb, .session-hide-btn')) return;
      const list = header.parentElement.querySelector('.prompt-list');
      list.hidden = !list.hidden;
      header.querySelector('.caret').textContent = list.hidden ? '▶' : '▼';
    });
  });

  // --- Batch selection mode ---
  document.getElementById('promptsSelectModeBtn').addEventListener('click', () => {
    promptSelectMode = !promptSelectMode;
    promptSelection.clear();
    renderPrompts();
  });

  if (promptSelectMode) {
    const selCountEl = document.getElementById('promptSelCount');
    const selHideBtn = document.getElementById('promptSelHideBtn');
    const syncSelectBar = () => {
      selCountEl.textContent = promptSelection.size;
      selHideBtn.disabled = promptSelection.size === 0;
    };
    const syncSessionCb = (sessionEl) => {
      const cbs = [...sessionEl.querySelectorAll('.prompt-select-cb')];
      const checked = cbs.filter((cb) => cb.checked).length;
      const scb = sessionEl.querySelector('.session-select-cb');
      if (!scb) return;
      scb.checked = checked > 0 && checked === cbs.length;
      scb.indeterminate = checked > 0 && checked < cbs.length;
    };
    const syncGroupCb = (groupEl) => {
      if (!groupEl) return;
      const cbs = [...groupEl.querySelectorAll('.prompt-select-cb')];
      const checked = cbs.filter((cb) => cb.checked).length;
      const gcb = groupEl.querySelector('.group-select-cb');
      if (!gcb) return;
      gcb.checked = checked > 0 && checked === cbs.length;
      gcb.indeterminate = checked > 0 && checked < cbs.length;
    };
    const setItem = (cb, on) => {
      cb.checked = on;
      if (on) promptSelection.add(cb.dataset.key);
      else promptSelection.delete(cb.dataset.key);
    };

    promptsPanel.querySelectorAll('.prompt-select-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        setItem(cb, cb.checked);
        syncSessionCb(cb.closest('.prompt-session'));
        syncGroupCb(cb.closest('.insight-section'));
        syncSelectBar();
      });
    });

    promptsPanel.querySelectorAll('.session-select-cb').forEach((scb) => {
      scb.addEventListener('click', (e) => e.stopPropagation());
      scb.addEventListener('change', () => {
        const sessionEl = scb.closest('.prompt-session');
        sessionEl.querySelectorAll('.prompt-select-cb').forEach((cb) => setItem(cb, scb.checked));
        scb.indeterminate = false;
        syncGroupCb(scb.closest('.insight-section'));
        syncSelectBar();
      });
    });

    // Group (directory) checkbox: toggle every prompt in the whole group
    promptsPanel.querySelectorAll('.group-select-cb').forEach((gcb) => {
      gcb.addEventListener('click', (e) => e.stopPropagation());
      gcb.addEventListener('change', () => {
        const groupEl = gcb.closest('.insight-section');
        groupEl.querySelectorAll('.prompt-select-cb').forEach((cb) => setItem(cb, gcb.checked));
        groupEl.querySelectorAll('.prompt-session').forEach(syncSessionCb);
        gcb.indeterminate = false;
        syncSelectBar();
      });
    });

    // Clicking a prompt row toggles its checkbox (inner buttons/links keep working)
    promptsPanel.querySelectorAll('.prompt-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button, input, a, .show-more')) return;
        const cb = item.querySelector('.prompt-select-cb');
        if (!cb) return;
        setItem(cb, !cb.checked);
        syncSessionCb(item.closest('.prompt-session'));
        syncGroupCb(item.closest('.insight-section'));
      });
    });

    document.getElementById('promptSelCancelBtn').addEventListener('click', () => {
      promptSelectMode = false;
      promptSelection.clear();
      renderPrompts();
    });

    selHideBtn.addEventListener('click', async () => {
      if (!promptSelection.size || selHideBtn.textContent !== '🗑 隐藏选中') return;
      const texts = [];
      for (const key of promptSelection) {
        const [kgi, ksi, kpi] = key.split(':').map(Number);
        const p = groups[kgi] && groups[kgi].sessions[ksi] && groups[kgi].sessions[ksi].prompts[kpi];
        if (p) texts.push(p.text);
      }
      const n = texts.length;
      selHideBtn.disabled = true;
      selHideBtn.textContent = '隐藏中…';
      try {
        await hidePromptTexts(texts);
        promptSelectMode = false;
        promptSelection.clear();
        await loadPrompts();
        showToast(`已隐藏 ${n} 条`);
      } catch (error) {
        selHideBtn.disabled = false;
        selHideBtn.textContent = '🗑 隐藏选中';
        showToast('隐藏失败: ' + error.message, 'error');
      }
    });
  }

  // Session-level quick hide (outside selection mode; reversible via 管理 modal)
  promptsPanel.querySelectorAll('.session-hide-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const g = groups[Number(btn.dataset.gi)];
      const s = g && g.sessions[Number(btn.dataset.si)];
      if (!s) return;
      btn.disabled = true;
      const n = s.prompts.length;
      try {
        await hidePromptTexts(s.prompts.map((p) => p.text));
        await loadPrompts();
        showToast(`已隐藏 ${n} 条`);
      } catch (error) {
        btn.disabled = false;
        showToast('隐藏失败: ' + error.message, 'error');
      }
    });
  });

  // Show more toggles
  promptsPanel.querySelectorAll('.show-more').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textEl = btn.previousElementSibling;
      const clamped = textEl.classList.toggle('clamped');
      btn.textContent = clamped ? 'Show more' : 'Show less';
    });
  });

  // Copy buttons
  promptsPanel.querySelectorAll('.prompt-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = groups[Number(btn.dataset.gi)];
      const s = g && g.sessions[Number(btn.dataset.si)];
      const p = s && s.prompts[Number(btn.dataset.pi)];
      if (!p) return;
      navigator.clipboard.writeText(p.text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      });
    });
  });

  // Analyze button
  document.getElementById('promptsAnalyzeBtn').addEventListener('click', () => {
    const isRefresh = promptAnalysis && promptAnalysis.platform === state.platform;
    loadPromptAnalysis(isRefresh);
  });

  // Cluster expand/collapse
  promptsPanel.querySelectorAll('.cluster-head').forEach((head) => {
    head.addEventListener('click', () => {
      const body = head.parentElement.querySelector('.cluster-body');
      body.hidden = !body.hidden;
      head.querySelector('.caret').textContent = body.hidden ? '▶' : '▼';
    });
  });

  // Cluster rewrite copy
  const analysisClusters = ((promptAnalysis && promptAnalysis.clusters) || []).filter((c) => c.count > 1).slice(0, 20);
  promptsPanel.querySelectorAll('.cluster-rewrite-copy').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = analysisClusters[Number(btn.dataset.ci)];
      if (!c || !c.suggestion) return;
      navigator.clipboard.writeText(c.suggestion.rewrite).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      });
    });
  });

  // Cluster 入库: prefill = longest common prefix of examples (≥30 chars → prefix + $ARGUMENTS), else first example
  promptsPanel.querySelectorAll('.cluster-save-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = analysisClusters[Number(btn.dataset.ci)];
      if (!c || clusterSavedPatterns.has(c.pattern)) return;
      const content = clusterPrefillContent(c);
      if (!content) return;
      openLibraryForm(
        {
          content,
          source: 'history',
          onSaved: () => {
            clusterSavedPatterns.add(c.pattern);
            btn.textContent = '✓ 已入库';
            btn.disabled = true;
          },
        },
        false
      );
    });
  });

  // Per-prompt optimize (rewrite via claude CLI)
  promptsPanel.querySelectorAll('.prompt-optimize-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const g = groups[Number(btn.dataset.gi)];
      const s = g && g.sessions[Number(btn.dataset.si)];
      const p = s && s.prompts[Number(btn.dataset.pi)];
      if (!p || btn.disabled) return;
      const item = btn.closest('.prompt-item');
      const existing = item.querySelector('.rewrite-block');
      if (existing) {
        existing.remove();
        return;
      }
      btn.disabled = true;
      btn.textContent = '优化中…';
      try {
        const resp = await fetch('/api/prompts/rewrite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: p.text }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || resp.statusText);
        const block = document.createElement('div');
        block.className = 'rewrite-block';
        block.innerHTML = `
              <div class="label">建议改写</div>
              <div class="prompt-text"></div>
              <button class="prompt-copy-btn" style="opacity:1">Copy</button>
              ${data.rationale ? '<div class="rationale"></div>' : ''}
            `;
        block.querySelector('.prompt-text').innerHTML = renderMarkdown(data.rewrite);
        if (data.rationale) block.querySelector('.rationale').textContent = data.rationale;
        block.querySelector('.prompt-copy-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(data.rewrite).then(() => {
            e.target.textContent = 'Copied!';
            setTimeout(() => {
              e.target.textContent = 'Copy';
            }, 1200);
          });
        });
        item.appendChild(block);
      } catch (error) {
        const err = document.createElement('div');
        err.className = 'analysis-error';
        err.textContent = '改写失败: ' + error.message;
        item.appendChild(err);
        setTimeout(() => err.remove(), 5000);
      } finally {
        btn.disabled = false;
        btn.textContent = '优化';
      }
    });
  });

  // Hide prompt (non-destructive; hides all identical occurrences, reversible)
  promptsPanel.querySelectorAll('.prompt-hide-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const g = groups[Number(btn.dataset.gi)];
      const s = g && g.sessions[Number(btn.dataset.si)];
      const p = s && s.prompts[Number(btn.dataset.pi)];
      if (!p || btn.disabled) return;
      btn.disabled = true;
      try {
        const resp = await fetch('/api/prompts/hidden', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: p.text }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || resp.statusText);
        await loadPrompts();
        showToast('已隐藏');
      } catch (error) {
        btn.disabled = false;
        const item = btn.closest('.prompt-item');
        const err = document.createElement('div');
        err.className = 'analysis-error';
        err.textContent = '隐藏失败: ' + error.message;
        item.appendChild(err);
        setTimeout(() => err.remove(), 5000);
      }
    });
  });

  // Star to library — open create form prefilled with this prompt
  promptsPanel.querySelectorAll('.prompt-star-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = groups[Number(btn.dataset.gi)];
      const s = g && g.sessions[Number(btn.dataset.si)];
      const p = s && s.prompts[Number(btn.dataset.pi)];
      if (!p) return;
      openLibraryForm({ name: suggestLibraryName(p.text), content: p.text, source: state.platform }, false);
    });
  });

  // Open session links — jump back to Sessions view
  promptsPanel.querySelectorAll('.session-open-link').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = link.getAttribute('data-session-id');
      if (!sid) return;
      currentView = 'sessions';
      viewToggleBar.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.remove('active'));
      viewToggleBar.querySelector('[data-view="sessions"]').classList.add('active');
      mainContent.hidden = false;
      insightsPanel.hidden = true;
      promptsPanel.hidden = true;
      libraryPanel.hidden = true;
      sessionSearch.value = sid;
      filterSessions();
      renderSessions();
      const match = state.filteredSessions.find((s) => s.id === sid || s.id.startsWith(sid));
      if (match) {
        state.selectedSessionId = match.id;
        renderSessions();
        scrollSessionIntoView(match.id);
        await loadSession();
      }
    });
  });
}

// --- Prompt Library View ---
async function libraryRequest(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || response.statusText);
  return data;
}

async function loadLibrary() {
  libraryPanel.innerHTML = '<div class="insights-loading">Loading library…</div>';
  const usagePromise = fetchJson('/api/library/usage').catch(() => null); // tolerate failure → no badges
  try {
    libraryData = await fetchJson('/api/library');
  } catch (error) {
    libraryPanel.innerHTML = `<div class="insights-empty">Failed to load library: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const usageData = await usagePromise;
  libraryUsage = (usageData && usageData.usage) || null;
  renderLibrary();
}

function libraryUsageOf(name) {
  return (libraryUsage && libraryUsage[name]) || {};
}

function libraryMatchesSearch(p, q) {
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if ((p.description || '').toLowerCase().includes(q)) return true;
  if ((p.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
  return (p.content || '').toLowerCase().includes(q);
}

function libraryActionError(message) {
  if (typeof showToast === 'function') {
    showToast(message, 'error');
    return;
  }
  const err = document.createElement('div');
  err.className = 'analysis-error';
  err.textContent = message;
  libraryPanel.prepend(err);
  setTimeout(() => err.remove(), 5000);
}

function renderLibrary() {
  const all = (libraryData && libraryData.prompts) || [];
  const q = librarySearch.trim().toLowerCase();
  const prompts = all.filter((p) => libraryMatchesSearch(p, q));
  if (librarySort === 'uses') {
    prompts.sort((a, b) => (libraryUsageOf(b.name).uses || 0) - (libraryUsageOf(a.name).uses || 0));
  } else {
    prompts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  const targetLabels = { claude: 'Claude', codex: 'Codex', omp: 'OMP' };
  const cardsHtml = prompts
    .map((p, pi) => {
      const installBtns = ['claude', 'codex', 'omp']
        .map((t) => {
          const installed = !!(p.installed && p.installed[t]);
          return `<button class="library-install-btn${installed ? ' installed' : ''}" data-pi="${pi}" data-target="${t}" title="${installed ? '点击卸载' : '安装为 /' + escapeHtml(p.name)}">${targetLabels[t]}</button>`;
        })
        .join('');
      const tagsHtml = (p.tags || []).map((t) => `<span class="library-tag">${escapeHtml(t)}</span>`).join('');
      const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleString() : '—';
      const content = p.content || '';
      const u = libraryUsageOf(p.name);
      let usageHtml = '';
      if (u.uses > 0) {
        const parts = [`📈 用过 ${u.uses} 次`];
        if (u.avgMessages != null) parts.push(`平均 ${Number(u.avgMessages.toFixed(1))} 条消息/轮`);
        if (u.errorRate != null) parts.push(`错误率 ${Math.round(u.errorRate * 100)}%`);
        if (u.lastUsed) parts.push(`最近 ${new Date(u.lastUsed).toLocaleDateString()}`);
        usageHtml = `<div class="library-usage">${parts.join(' · ')}</div>`;
      }
      return `
        <div class="insight-section library-card">
          <div class="library-card-head">
            <span class="library-name">/${escapeHtml(p.name)}</span>
            <span class="library-source">${escapeHtml(p.source || 'manual')}</span>
            <span class="library-date">${escapeHtml(dateStr)}</span>
            <span class="library-installs">${installBtns}</span>
          </div>
          ${p.description ? `<div class="library-desc">${escapeHtml(p.description)}</div>` : ''}
          ${tagsHtml ? `<div class="library-tags">${tagsHtml}</div>` : ''}
          ${usageHtml}
          <div class="prompt-text${content.length > 500 ? ' clamped' : ''}">${renderMarkdown(content)}</div>
          ${content.length > 500 ? '<span class="show-more">Show more</span>' : ''}
          <div class="library-card-actions">
            <button class="export-btn library-copy-btn" data-pi="${pi}">Copy</button>
            <button class="export-btn library-edit-btn" data-pi="${pi}">编辑</button>
            <button class="export-btn library-delete-btn" data-pi="${pi}">删除</button>
            <button class="export-btn library-history-btn" data-pi="${pi}">🕒 历史</button>
          </div>
        </div>`;
    })
    .join('');

  libraryPanel.innerHTML = `
        <div class="prompts-toolbar">
          <input type="search" id="librarySearchInput" placeholder="Filter by name / tags / description / content" value="${escapeHtml(librarySearch)}">
          <select class="library-sort-select" id="librarySortSelect" title="排序">
            <option value="recent"${librarySort === 'uses' ? '' : ' selected'}>最新</option>
            <option value="uses"${librarySort === 'uses' ? ' selected' : ''}>使用次数</option>
          </select>
          <button class="export-btn" id="libraryFabricBtn">导入 Fabric Patterns</button>
          <button class="export-btn" id="libraryNewBtn">新建 Prompt</button>
        </div>
        <div class="prompts-summary"><span class="scope-chip">🌐 全平台</span> Prompt 资产库（~/.agentxray/library）— 点亮 Claude / Codex / OMP 开关即安装为该工具的 slash command，工具内 <code>/名字</code> 调用 · ${all.length} prompt${all.length === 1 ? '' : 's'}${q ? ` — showing ${prompts.length}` : ''}</div>
        ${cardsHtml || `<div class="insights-empty">${all.length ? 'No matches.' : '资产库为空。在 Prompts 视图点 ⭐ 收藏，或点击「新建 Prompt」。'}</div>`}
      `;

  // Search input (debounced re-render, keep focus)
  const searchInput = document.getElementById('librarySearchInput');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      librarySearch = searchInput.value;
      renderLibrary();
      const el = document.getElementById('librarySearchInput');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 250);
  });

  document.getElementById('libraryNewBtn').addEventListener('click', () => openLibraryForm(null, false));

  document.getElementById('libraryFabricBtn').addEventListener('click', openFabricModal);

  document.getElementById('librarySortSelect').addEventListener('change', (e) => {
    librarySort = e.target.value;
    localStorage.setItem('axr-lib-sort', librarySort);
    renderLibrary();
  });

  // Show more toggles
  libraryPanel.querySelectorAll('.show-more').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textEl = btn.previousElementSibling;
      const clamped = textEl.classList.toggle('clamped');
      btn.textContent = clamped ? 'Show more' : 'Show less';
    });
  });

  // Copy buttons
  libraryPanel.querySelectorAll('.library-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = prompts[Number(btn.dataset.pi)];
      if (!p) return;
      navigator.clipboard.writeText(p.content).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      });
    });
  });

  // Edit buttons
  libraryPanel.querySelectorAll('.library-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = prompts[Number(btn.dataset.pi)];
      if (p) openLibraryForm(p, true);
    });
  });

  // History buttons
  libraryPanel.querySelectorAll('.library-history-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = prompts[Number(btn.dataset.pi)];
      if (p) openLibraryHistory(p.name);
    });
  });

  // Delete buttons
  libraryPanel.querySelectorAll('.library-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = prompts[Number(btn.dataset.pi)];
      if (!p || !confirm(`删除 "${p.name}"？已安装的 slash command 副本也会一并移除。`)) return;
      try {
        await libraryRequest('/api/library/' + encodeURIComponent(p.name), 'DELETE');
        await loadLibrary();
      } catch (error) {
        libraryActionError('删除失败: ' + error.message);
      }
    });
  });

  // Install / uninstall toggles
  libraryPanel.querySelectorAll('.library-install-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = prompts[Number(btn.dataset.pi)];
      const target = btn.dataset.target;
      if (!p || btn.disabled) return;
      const action = p.installed && p.installed[target] ? 'uninstall' : 'install';
      btn.disabled = true;
      try {
        await libraryRequest(`/api/library/${encodeURIComponent(p.name)}/${action}`, 'POST', { targets: [target] });
        await loadLibrary();
      } catch (error) {
        btn.disabled = false;
        libraryActionError((action === 'install' ? '安装失败: ' : '卸载失败: ') + error.message);
      }
    });
  });
}

// --- Library create/edit form ---
const libraryFormOverlay = document.getElementById('libraryFormOverlay');
const libraryFormName = document.getElementById('libraryFormName');
const libraryFormDescription = document.getElementById('libraryFormDescription');
const libraryFormTags = document.getElementById('libraryFormTags');
const libraryFormContent = document.getElementById('libraryFormContent');
const libraryFormError = document.getElementById('libraryFormError');
let libraryFormEditingName = null;
let libraryFormSource = 'manual';
let libraryFormOnSaved = null; // fired once after a successful (non-edit) save
let libraryNameSuggestSeq = 0;

function suggestLibraryName(text) {
  let name = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  name = name.split('-').slice(0, 6).join('-').slice(0, 64).replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : 'prompt-' + Date.now();
}

// Ask the local claude CLI (via backend) for a slash-command name; fills the
// input only if the user hasn't typed anything by the time it resolves.
function requestSuggestedName(text, fallback) {
  const seq = ++libraryNameSuggestSeq;
  libraryFormName.value = '';
  libraryFormName.placeholder = '生成中…';
  fetch('/api/library/suggest-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((data) => {
      if (seq !== libraryNameSuggestSeq || libraryFormOverlay.hidden) return;
      libraryFormName.placeholder = 'my-prompt';
      if (libraryFormName.value.trim()) return; // user already typed a name
      const name = data && data.name;
      libraryFormName.value = name && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : fallback;
    });
}

function openLibraryForm(prefill, isEdit) {
  libraryNameSuggestSeq++; // invalidate any in-flight suggestion
  libraryFormEditingName = isEdit && prefill ? prefill.name : null;
  libraryFormSource = (prefill && prefill.source) || 'manual';
  const sourceChip = document.getElementById('libraryFormSourceChip');
  if (sourceChip) sourceChip.hidden = libraryFormSource !== 'history';
  libraryFormOnSaved = (!isEdit && prefill && prefill.onSaved) || null;
  document.getElementById('libraryFormTitleText').textContent = isEdit ? '编辑 Prompt' : '新建 Prompt';
  libraryFormName.placeholder = 'my-prompt';
  const prefillName = (prefill && prefill.name) || '';
  libraryFormName.value = prefillName;
  libraryFormDescription.value = (prefill && prefill.description) || '';
  libraryFormTags.value = ((prefill && prefill.tags) || []).join(', ');
  libraryFormContent.value = (prefill && prefill.content) || '';
  libraryFormError.hidden = true;
  libraryFormError.textContent = '';
  libraryFormOverlay.hidden = false;
  libraryFormName.focus();
  // ⭐ prefill whose heuristic name is the timestamp fallback (or empty): try smart naming
  if (!isEdit && prefill && prefill.content && (!prefillName || /^prompt-\d+$/.test(prefillName))) {
    requestSuggestedName(prefill.content, prefillName);
  }
}

function closeLibraryForm() {
  libraryFormOverlay.hidden = true;
}

function showLibraryFormError(message) {
  libraryFormError.textContent = message;
  libraryFormError.hidden = false;
}

libraryFormOverlay.addEventListener('click', (e) => {
  if (e.target === libraryFormOverlay) closeLibraryForm();
});

document.getElementById('libraryFormCancel').addEventListener('click', closeLibraryForm);

document.getElementById('libraryFormSave').addEventListener('click', async () => {
  const name = libraryFormName.value.trim();
  const description = libraryFormDescription.value.trim();
  const tags = libraryFormTags.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const content = libraryFormContent.value;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    showLibraryFormError('名称无效：需以小写字母或数字开头，只含小写字母、数字、连字符，最长 64 字符');
    return;
  }
  if (!content.trim()) {
    showLibraryFormError('内容不能为空');
    return;
  }
  try {
    if (libraryFormEditingName) {
      const body = { description, tags, content };
      if (name !== libraryFormEditingName) body.newName = name;
      await libraryRequest('/api/library/' + encodeURIComponent(libraryFormEditingName), 'PUT', body);
    } else {
      await libraryRequest('/api/library', 'POST', { name, description, tags, content, source: libraryFormSource });
    }
    closeLibraryForm();
    if (typeof showToast === 'function') showToast(libraryFormEditingName ? '已保存修改' : '已保存到资产库');
    if (libraryFormOnSaved) {
      try {
        libraryFormOnSaved();
      } catch {}
      libraryFormOnSaved = null;
    }
    libraryData = null;
    if (currentView === 'library') await loadLibrary();
  } catch (error) {
    showLibraryFormError(error.message);
  }
});

// --- Fabric patterns import modal ---
const fabricOverlay = document.getElementById('fabricOverlay');
const fabricFilterInput = document.getElementById('fabricFilterInput');
const fabricList = document.getElementById('fabricList');
const fabricCount = document.getElementById('fabricCount');
const fabricError = document.getElementById('fabricError');
const fabricResultLine = document.getElementById('fabricResultLine');
const fabricImportBtn = document.getElementById('fabricImportBtn');
let fabricPatterns = [];
let fabricSelected = new Set();
let fabricImporting = false;

function showFabricError(message) {
  fabricError.textContent = message;
  fabricError.hidden = false;
}

function updateFabricFooter() {
  const total = fabricPatterns.length;
  const imported = fabricPatterns.filter((p) => p.imported).length;
  fabricCount.textContent = total ? `已选 ${fabricSelected.size} / 共 ${total}（已导入 ${imported}）` : '';
  fabricImportBtn.textContent = fabricImporting ? '导入中…' : `导入 ${fabricSelected.size} 个`;
  fabricImportBtn.disabled = fabricImporting || fabricSelected.size === 0;
}

function fabricVisiblePatterns() {
  const q = fabricFilterInput.value.trim().toLowerCase();
  return q ? fabricPatterns.filter((p) => p.name.toLowerCase().includes(q)) : fabricPatterns;
}

function renderFabricList() {
  const visible = fabricVisiblePatterns();
  if (!visible.length) {
    fabricList.innerHTML = `<div class="insights-empty">${fabricPatterns.length ? 'No matches.' : '没有可导入的 pattern。'}</div>`;
    updateFabricFooter();
    return;
  }
  fabricList.innerHTML = visible
    .map(
      (p) => `
        <label class="fabric-item${p.imported ? ' imported' : ''}">
          <input type="checkbox" data-name="${escapeHtml(p.name)}"${p.imported ? ' disabled' : ''}${fabricSelected.has(p.name) ? ' checked' : ''}>
          <span>${escapeHtml(p.name)}</span>
          ${p.imported ? '<span class="fabric-imported-mark">✓ 已导入</span>' : ''}
        </label>`
    )
    .join('');
  fabricList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) fabricSelected.add(box.dataset.name);
      else fabricSelected.delete(box.dataset.name);
      updateFabricFooter();
    });
  });
  updateFabricFooter();
}

function openFabricModal() {
  fabricSelected = new Set();
  fabricImporting = false;
  fabricPatterns = [];
  fabricFilterInput.value = '';
  fabricError.hidden = true;
  fabricError.textContent = '';
  fabricResultLine.textContent = '';
  fabricList.innerHTML = '<div class="insights-loading">加载 Fabric pattern 列表…</div>';
  fabricOverlay.hidden = false;
  updateFabricFooter();
  fetchJson('/api/library/fabric-patterns')
    .then((data) => {
      if (fabricOverlay.hidden) return;
      fabricPatterns = (data && data.patterns) || [];
      renderFabricList();
    })
    .catch((error) => {
      if (fabricOverlay.hidden) return;
      fabricList.innerHTML = '';
      showFabricError('获取 Fabric patterns 失败: ' + error.message);
    });
}

function closeFabricModal() {
  fabricOverlay.hidden = true;
}

fabricOverlay.addEventListener('click', (e) => {
  if (e.target === fabricOverlay) closeFabricModal();
});

document.getElementById('fabricCancel').addEventListener('click', closeFabricModal);

fabricFilterInput.addEventListener('input', () => renderFabricList());

document.getElementById('fabricSelectAll').addEventListener('click', () => {
  fabricVisiblePatterns().forEach((p) => {
    if (!p.imported) fabricSelected.add(p.name);
  });
  renderFabricList();
});

document.getElementById('fabricSelectNone').addEventListener('click', () => {
  fabricSelected.clear();
  renderFabricList();
});

fabricImportBtn.addEventListener('click', async () => {
  const names = [...fabricSelected];
  if (!names.length || fabricImporting) return;
  if (names.length > 300) {
    showFabricError('一次最多导入 300 个 pattern');
    return;
  }
  fabricImporting = true;
  fabricError.hidden = true;
  fabricResultLine.textContent = '';
  updateFabricFooter();
  try {
    const result = await libraryRequest('/api/library/import-fabric', 'POST', { names });
    const imported = new Set(result.imported || []);
    const skipped = result.skipped || [];
    const failed = result.failed || [];
    fabricResultLine.textContent = `成功 ${imported.size} · 跳过 ${skipped.length} · 失败 ${failed.length}${failed.length ? '：' + failed.join(', ') : ''}`;
    if (typeof showToast === 'function' && imported.size) showToast(`已导入 ${imported.size} 个 Fabric pattern`);
    fabricPatterns.forEach((p) => {
      if (imported.has(p.name) || skipped.includes(p.name)) p.imported = true;
    });
    fabricSelected.clear();
    fabricImporting = false;
    renderFabricList();
    libraryData = null;
    if (currentView === 'library') await loadLibrary();
  } catch (error) {
    fabricImporting = false;
    updateFabricFooter();
    showFabricError('导入失败: ' + error.message);
  }
});

// --- Library version history modal ---
const libraryHistoryOverlay = document.getElementById('libraryHistoryOverlay');
const libraryHistoryTitle = document.getElementById('libraryHistoryTitle');
const libraryHistoryList = document.getElementById('libraryHistoryList');
const libraryHistoryDetail = document.getElementById('libraryHistoryDetail');
const libraryHistoryError = document.getElementById('libraryHistoryError');
let libraryHistoryName = null;

function showLibraryHistoryError(message) {
  libraryHistoryError.textContent = message;
  libraryHistoryError.hidden = false;
}

async function openLibraryHistory(name) {
  libraryHistoryName = name;
  libraryHistoryTitle.textContent = `🕒 /${name} 历史`;
  libraryHistoryDetail.hidden = true;
  libraryHistoryDetail.innerHTML = '';
  libraryHistoryError.hidden = true;
  libraryHistoryError.textContent = '';
  libraryHistoryList.innerHTML = '<div class="insights-loading">加载历史…</div>';
  libraryHistoryOverlay.hidden = false;
  let commits = [];
  try {
    const data = await fetchJson(`/api/library/${encodeURIComponent(name)}/history`);
    commits = (data && data.commits) || [];
  } catch (error) {
    libraryHistoryList.innerHTML = '';
    showLibraryHistoryError('获取历史失败: ' + error.message);
    return;
  }
  if (libraryHistoryOverlay.hidden || libraryHistoryName !== name) return;
  if (!commits.length) {
    libraryHistoryList.innerHTML = '<div class="insights-empty">暂无历史</div>';
    return;
  }
  libraryHistoryList.innerHTML = commits
    .map(
      (c) => `
        <button class="history-commit" data-hash="${escapeHtml(c.hash)}">
          <span class="history-date">${escapeHtml(c.date ? new Date(c.date).toLocaleString() : '—')}</span>
          <span class="history-msg">${escapeHtml(c.message || '')}</span>
        </button>`
    )
    .join('');
  libraryHistoryList.querySelectorAll('.history-commit').forEach((btn) => {
    btn.addEventListener('click', () => {
      libraryHistoryList.querySelectorAll('.history-commit.active').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      showLibraryHistoryVersion(btn.dataset.hash);
    });
  });
}

async function showLibraryHistoryVersion(hash) {
  const name = libraryHistoryName;
  libraryHistoryError.hidden = true;
  libraryHistoryDetail.hidden = false;
  libraryHistoryDetail.innerHTML = '<div class="insights-loading">加载版本内容…</div>';
  let data;
  try {
    data = await fetchJson(`/api/library/${encodeURIComponent(name)}/history/${encodeURIComponent(hash)}`);
  } catch (error) {
    libraryHistoryDetail.innerHTML = '';
    showLibraryHistoryError('获取版本内容失败: ' + error.message);
    return;
  }
  if (libraryHistoryOverlay.hidden || libraryHistoryName !== name) return;
  const content = (data && data.content) || '';
  libraryHistoryDetail.innerHTML = `
        <div class="prompt-text clamped">${renderMarkdown(content)}</div>
        ${content.length > 500 ? '<span class="show-more">Show more</span>' : ''}
        <div class="settings-actions" style="margin-top:12px">
          <button class="btn-save" id="libraryHistoryRestore">恢复此版本</button>
        </div>`;
  const showMore = libraryHistoryDetail.querySelector('.show-more');
  if (showMore)
    showMore.addEventListener('click', () => {
      const textEl = showMore.previousElementSibling;
      const clamped = textEl.classList.toggle('clamped');
      showMore.textContent = clamped ? 'Show more' : 'Show less';
    });
  document.getElementById('libraryHistoryRestore').addEventListener('click', async () => {
    const restoreBtn = document.getElementById('libraryHistoryRestore');
    restoreBtn.disabled = true;
    try {
      await libraryRequest('/api/library/' + encodeURIComponent(name), 'PUT', { content });
      closeLibraryHistory();
      if (typeof showToast === 'function') showToast('已恢复此版本');
      libraryData = null;
      if (currentView === 'library') await loadLibrary();
    } catch (error) {
      restoreBtn.disabled = false;
      showLibraryHistoryError('恢复失败: ' + error.message);
    }
  });
}

function closeLibraryHistory() {
  libraryHistoryOverlay.hidden = true;
}

libraryHistoryOverlay.addEventListener('click', (e) => {
  if (e.target === libraryHistoryOverlay) closeLibraryHistory();
});

document.getElementById('libraryHistoryClose').addEventListener('click', closeLibraryHistory);

// --- Hidden prompts management modal ---
const hiddenPromptsOverlay = document.getElementById('hiddenPromptsOverlay');
const hiddenPromptsListEl = document.getElementById('hiddenPromptsList');
const hiddenPromptsErrorEl = document.getElementById('hiddenPromptsError');
const hiddenPromptsRestoreAllBtn = document.getElementById('hiddenPromptsRestoreAll');

function openHiddenPromptsModal() {
  hiddenPromptsErrorEl.hidden = true;
  hiddenPromptsOverlay.hidden = false;
  renderHiddenPromptsList();
}

function closeHiddenPromptsModal() {
  hiddenPromptsOverlay.hidden = true;
}

function renderHiddenPromptsList() {
  hiddenPromptsRestoreAllBtn.disabled = !hiddenPrompts.length;
  if (!hiddenPrompts.length) {
    hiddenPromptsListEl.innerHTML = '<div class="insights-empty">没有已隐藏的 prompt</div>';
    return;
  }
  hiddenPromptsListEl.innerHTML = hiddenPrompts
    .map(
      (h) => `
        <div class="hidden-prompt-row">
          <span class="history-date">${escapeHtml(h.hiddenAt ? new Date(h.hiddenAt).toLocaleDateString() : '—')}</span>
          <span class="preview" title="${escapeHtml(h.preview || '')}">${escapeHtml(h.preview || '')}</span>
          <button class="hidden-restore-btn" data-hash="${escapeHtml(h.hash)}">恢复</button>
        </div>`
    )
    .join('');
  hiddenPromptsListEl.querySelectorAll('.hidden-restore-btn').forEach((btn) => {
    btn.addEventListener('click', () => restoreHiddenPrompts([btn.dataset.hash], btn));
  });
}

async function restoreHiddenPrompts(hashes, btn) {
  if (!hashes.length || (btn && btn.disabled)) return;
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '恢复中…';
  }
  hiddenPromptsErrorEl.hidden = true;
  try {
    for (const hash of hashes) {
      const resp = await fetch('/api/prompts/hidden/' + encodeURIComponent(hash), { method: 'DELETE' });
      if (!resp.ok) throw new Error((await resp.json().catch(() => null))?.error || resp.statusText);
    }
    hiddenPrompts = hiddenPrompts.filter((h) => !hashes.includes(h.hash));
    if (currentView === 'prompts') loadPrompts();
  } catch (error) {
    hiddenPromptsErrorEl.textContent = '恢复失败: ' + error.message;
    hiddenPromptsErrorEl.hidden = false;
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = orig;
    }
    renderHiddenPromptsList();
  }
}

hiddenPromptsRestoreAllBtn.addEventListener('click', () =>
  restoreHiddenPrompts(
    hiddenPrompts.map((h) => h.hash),
    hiddenPromptsRestoreAllBtn
  )
);

document.getElementById('hiddenPromptsClose').addEventListener('click', closeHiddenPromptsModal);

hiddenPromptsOverlay.addEventListener('click', (e) => {
  if (e.target === hiddenPromptsOverlay) closeHiddenPromptsModal();
});

function filterSessions() {
  const term = sessionSearch.value.trim().toLowerCase();
  state.filteredSessions = state.sessions.filter((session) => {
    if (!term) return true;
    return (
      session.id.toLowerCase().includes(term) ||
      session.file.toLowerCase().includes(term) ||
      (session.firstUserMessage || '').toLowerCase().includes(term)
    );
  });
}

function sessionCardHtml(session) {
  const activeClass = session.id === state.selectedSessionId ? 'active' : '';
  const chips = [];
  if (session.userCount) chips.push(`<span class="stat-chip user">👤 ${session.userCount}</span>`);
  if (session.assistantCount) chips.push(`<span class="stat-chip">🤖 ${session.assistantCount}</span>`);
  if (session.toolCallCount) chips.push(`<span class="stat-chip tool">🔧 ${session.toolCallCount}</span>`);
  if (session.spawnCount)
    chips.push(
      `<span class="stat-chip spawn spawn-tree-link" data-scroll-spawn-tree>\u{1F333} ${session.spawnCount} spawn</span>`
    );
  if (session.model)
    chips.push(`<span class="stat-chip model">🧠 ${escapeHtml(session.model.split('/').pop())}</span>`);
  if (session.source) {
    const srcIcons = {
      cli: '⌨️',
      telegram: '✈️',
      discord: '🎮',
      weixin: '💬',
      wechat: '💬',
      slack: '💼',
      web: '🌐',
      feishu: '🐦',
      whatsapp: '📱',
    };
    const srcIcon = srcIcons[session.source.toLowerCase()] || '📡';
    chips.push(`<span class="stat-chip source">${srcIcon} ${escapeHtml(session.source)}</span>`);
  }
  // Duration from first to last message
  const startMs = parseTimestampMs(session.timestamp);
  const endMs = parseTimestampMs(session.lastActivity);
  if (startMs && endMs && endMs > startMs) {
    const dur = endMs - startMs;
    if (dur >= 5000) chips.push(`<span class="stat-chip duration">⏱ ${formatDurationCompact(dur)}</span>`);
  }
  return `
        <div class="session-item ${activeClass}" data-session-id="${escapeHtml(session.id)}" tabindex="0">
          <div class="top">
            <span>${escapeHtml(formatDate(session.timestamp))}</span>
            ${session.status ? `<span class="badge ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>` : ''}
          </div>
          <div class="stats">${chips.join('')}</div>
          <div class="id">${session.title ? escapeHtml(session.title) : escapeHtml(session.id)}</div>
          ${session.firstUserMessage ? `<div class="session-preview">${escapeHtml(session.firstUserMessage.length > 80 ? session.firstUserMessage.slice(0, 80) + '…' : session.firstUserMessage)}</div>` : ''}
        </div>
      `;
}

// --- Sidebar virtualization: windowed rendering keeps the DOM bounded on big lists ---
const VIRT_THRESHOLD = 200; // below this many sessions, render everything
const VIRT_OVERSCAN = 10; // extra cards above/below the visible range
let virtItemHeight = 96; // estimated card height incl. 8px flex gap
let virtMeasured = false; // estimate refined once, from the first rendered batch
let virtRange = { start: -1, end: -1 }; // start < 0 → list not virtualized

function renderSessions() {
  filterSessions();
  virtRange = { start: -1, end: -1 };
  if (!state.filteredSessions.length) {
    sessionList.innerHTML = '<div class="subtle">No sessions match this filter.</div>';
    return;
  }
  if (state.filteredSessions.length <= VIRT_THRESHOLD) {
    sessionList.innerHTML = state.filteredSessions.map(sessionCardHtml).join('');
    return;
  }
  renderSessionWindow();
}

function virtWindow(viewTop, viewH, total) {
  let start = Math.max(0, Math.floor(viewTop / virtItemHeight) - VIRT_OVERSCAN);
  let end = Math.min(total, Math.ceil((viewTop + viewH) / virtItemHeight) + VIRT_OVERSCAN);
  // At the bottom edge of the rendered content, pin the window to the true end of the list
  if (end < total && viewTop + viewH >= sessionList.scrollHeight - 2) {
    end = total;
    start = Math.max(0, end - Math.ceil(viewH / virtItemHeight) - 2 * VIRT_OVERSCAN);
  }
  if (start >= end) start = Math.max(0, end - 1);
  return { start, end };
}

// Render only the cards near the viewport; spacer divs stand in for the hidden ones
function renderSessionWindow() {
  const total = state.filteredSessions.length;
  const viewH = sessionList.clientHeight || 600;
  const { start, end } = virtWindow(sessionList.scrollTop, viewH, total);
  virtRange = { start, end };
  const spacer = (h) => `<div style="flex:none;height:${Math.max(0, h).toFixed(1)}px"></div>`;
  sessionList.innerHTML =
    spacer(start * virtItemHeight) +
    state.filteredSessions.slice(start, end).map(sessionCardHtml).join('') +
    spacer((total - end) * virtItemHeight);
  // Measure the average card height from the first rendered batch, then keep it fixed
  // so spacer heights stay consistent between renders (per-window averages oscillate).
  if (!virtMeasured) {
    const cards = sessionList.querySelectorAll('.session-item');
    if (cards.length) {
      let sum = 0;
      cards.forEach((c) => {
        sum += c.offsetHeight;
      });
      const avg = sum / cards.length + 8; // + .session-list flex gap
      if (avg > 20) {
        // ignore hidden-list measurements (offsetHeight 0)
        virtItemHeight = avg;
        virtMeasured = true;
        renderSessionWindow(); // re-lay spacers once with the real estimate
      }
    }
  }
}

let virtScrollScheduled = false;
sessionList.addEventListener('scroll', () => {
  if (virtRange.start < 0 || virtScrollScheduled) return;
  virtScrollScheduled = true;
  requestAnimationFrame(() => {
    virtScrollScheduled = false;
    if (virtRange.start < 0) return;
    const total = state.filteredSessions.length;
    const { start, end } = virtWindow(sessionList.scrollTop, sessionList.clientHeight || 600, total);
    if (start !== virtRange.start || end !== virtRange.end) renderSessionWindow();
  });
});

// Ensure the selected card is visible; when virtualized it may not even be in the DOM
function scrollSessionIntoView(id) {
  if (!id) return;
  const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const el = sessionList.querySelector(`.session-item[data-session-id="${esc}"]`);
  if (el) {
    el.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (virtRange.start < 0) return;
  const idx = state.filteredSessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  sessionList.scrollTop = Math.max(0, idx * virtItemHeight - sessionList.clientHeight / 2);
  renderSessionWindow();
}

function summarizeTokens(messagesData) {
  return messagesData.reduce((acc, message) => {
    const usage = message.usage || {};
    Object.entries(usage).forEach(([key, value]) => {
      if (typeof value === 'number') {
        acc[key] = (acc[key] || 0) + value;
      }
    });
    return acc;
  }, {});
}

function renderMarkdownInline(s) {
  // s is already HTML-escaped. Apply inline markdown.
  // Links [text](url) — url may contain &amp; from escaping, which is valid in href
  s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderMarkdownBlock(segment) {
  const lines = segment.split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }

  const flushPara = () => {
    const text = para.join('\n').replace(/^\n+|\n+$/g, '');
    if (text.trim()) out.push(`<p>${renderMarkdownInline(text).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.join('')}</${list.type}>`);
    list = null;
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${renderMarkdownInline(h[2])}</h${h[1].length}>`);
    } else if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(`<li>${renderMarkdownInline(ul[1])}</li>`);
    } else if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(`<li>${renderMarkdownInline(ol[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const segments = escaped.split(/```/);
  const html = segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.split('\n');
        const maybeLang = lines[0].trim();
        const code = lines.slice(1).join('\n') || lines.join('\n');
        return `<pre><code data-lang="${escapeHtml(maybeLang)}">${code}</code></pre>`;
      }
      return renderMarkdownBlock(segment);
    })
    .join('');
  return `<div class="markdown">${html}</div>`;
}

function createCollapse(toolId, headerHtml, bodyHtml, extraClass) {
  return `
        <div class="tool-link ${extraClass || ''} session-anchor" data-link-id="${escapeHtml(toolId || '')}">
          <button type="button" data-toggle="${escapeHtml(toolId || '')}">
            <span class="tool-title">${headerHtml}</span>
            <span class="tool-meta">toggle</span>
          </button>
          <div id="panel-${escapeHtml(toolId || '')}" class="collapsible">
            <div class="tool-content">${bodyHtml}</div>
          </div>
        </div>
      `;
}

function renderToolCall(item) {
  const body = `<pre>${escapeHtml(JSON.stringify(item.arguments || {}, null, 2))}</pre>`;

  // Detect spawn calls and add navigation button
  let spawnNav = '';
  const args = item.arguments || {};
  const isSpawn = item.name === 'sessions_spawn' && args.agentId;
  const isDelegateSpawn = item.name === 'delegate_task';
  const isExecSpawn =
    item.name === 'exec' &&
    typeof args.command === 'string' &&
    (args.command.toLowerCase().includes('codex ') || args.command.toLowerCase().includes('claude '));

  if (isSpawn) {
    const childAgent = escapeHtml(args.agentId);
    const taskPreview = escapeHtml((args.task || '').slice(0, 80));
    spawnNav = `
          <button class="spawn-link-btn" data-spawn-agent="${childAgent}" data-spawn-from="${escapeHtml(item.id || '')}">
            🔗 查看子 Agent 日志 → <strong>${childAgent}</strong>
            ${taskPreview ? `<span class="tool-meta">${taskPreview}…</span>` : ''}
          </button>
        `;
  } else if (isExecSpawn) {
    const cmd = args.command.toLowerCase();
    const childAgent = cmd.includes('codex') ? 'Codex' : 'Claude Code';
    // Exec-spawned agents run inline — their output is in the toolResult of this session
    // So we scroll to the corresponding toolResult instead of navigating away
    spawnNav = `
          <button class="spawn-link-btn" data-scroll-to-result="${escapeHtml(item.id || '')}">
            📋 查看 ${escapeHtml(childAgent)} 执行输出 ↓
          </button>
        `;
  } else if (isDelegateSpawn) {
    const taskPreview = escapeHtml((args.task || args.prompt || '').toString().slice(0, 80));
    spawnNav = `
          <button class="spawn-link-btn" data-scroll-to-result="${escapeHtml(item.id || '')}">
            🔗 Sub-agent delegated${taskPreview ? ` — ${taskPreview}…` : ''}
          </button>
        `;
  }

  const header = `<span>🔧 ${escapeHtml(item.name || 'tool')}</span>${isSpawn || isExecSpawn || isDelegateSpawn ? '<span class="spawn-badge">SPAWN</span>' : ''}<span class="tool-meta">${escapeHtml(truncateId(item.id || ''))}</span>`;

  return createCollapse(item.id, header, body, '') + spawnNav;
}

function renderToolResult(message) {
  const text = getTextContent(message.content);
  const lines = text.split('\n');
  const truncated = lines.length > 500;
  const preview = truncated ? lines.slice(0, 500).join('\n') : text;
  const details = [];
  if (message.details?.status) details.push(`status=${message.details.status}`);
  if (typeof message.details?.durationMs === 'number') details.push(`duration=${message.details.durationMs}ms`);
  if (typeof message.details?.exitCode === 'number') details.push(`exit=${message.details.exitCode}`);
  const body = `
        <div class="tool-result-body">
          ${message.details ? `<div class="tool-meta">${escapeHtml(details.join(' · ') || JSON.stringify(message.details))}</div>` : ''}
          <pre class="mono" data-full="${truncated ? '1' : '0'}">${escapeHtml(preview)}</pre>
          ${truncated ? `<button class="expand-toggle" type="button" data-expand-output="${escapeHtml(message.id)}">Show all</button><pre id="full-output-${escapeHtml(message.id)}" hidden>${escapeHtml(text)}</pre>` : ''}
        </div>
      `;
  return createCollapse(
    message.toolCallId || message.id,
    `<span>${message.isError ? '❌' : '✅'} ${escapeHtml(message.toolName || 'tool result')}</span><span class="tool-meta">${escapeHtml(details.join(' · '))}</span>`,
    body,
    message.isError ? 'result-error' : 'result-ok'
  );
}

function getGraphNode(message) {
  if (message.role === 'user') {
    return { cls: 'user', tip: `User · ${formatDate(message.timestamp)}` };
  }
  if (message.role === 'reasoning') {
    return { cls: 'assistant', tip: `Reasoning · ${formatDate(message.timestamp)}` };
  }
  if (message.role === 'toolCall') {
    return { cls: 'assistant has-tools', tip: `🔧 ${message.toolName || 'tool'} · ${formatDate(message.timestamp)}` };
  }
  if (message.role === 'assistant') {
    const tools = (message.content || []).filter((c) => c.type === 'toolCall');
    const hasSpawn = tools.some((c) => {
      if (c.name === 'sessions_spawn') return true;
      if (c.name === 'exec' && typeof (c.arguments || {}).command === 'string') {
        const cmd = c.arguments.command.toLowerCase();
        return cmd.includes('codex ') || cmd.includes('claude ');
      }
      return false;
    });
    if (hasSpawn) {
      return {
        cls: 'assistant has-tools',
        tip: `Assistant · ${tools.length} tools (spawn) · ${formatDate(message.timestamp)}`,
        tools,
        hasSpawn: true,
      };
    }
    if (tools.length) {
      return {
        cls: 'assistant has-tools',
        tip: `Assistant · ${tools.length} tools · ${formatDate(message.timestamp)}`,
        tools,
      };
    }
    return { cls: 'assistant', tip: `Assistant · ${formatDate(message.timestamp)}` };
  }
  if (message.role === 'toolResult') {
    const errCls = message.isError ? ' error' : '';
    return {
      cls: `tool-result${errCls}`,
      tip: `${message.isError ? '❌' : '✅'} ${message.toolName || 'tool'} · ${formatDate(message.timestamp)}`,
    };
  }
  return { cls: 'assistant', tip: formatDate(message.timestamp) };
}

function renderGraphLane(message) {
  const gn = getGraphNode(message);
  return `
        <div class="graph-lane">
          <div class="trunk"></div>
          <div class="node ${gn.cls}" data-tip="${escapeHtml(gn.tip)}" data-msg-id="${escapeHtml(message.id || '')}"></div>
        </div>
      `;
}

function renderMessage(message, timingMeta) {
  const deltaMs = timingMeta?.deltaMs ?? null;
  const toolDurationMs = timingMeta?.toolDurationMs ?? null;
  const text = getTextContent(message.content);
  if (message.role === 'user') {
    const longText = text.length > 1400;
    const preview = longText ? text.slice(0, 1400) + '\n\n[truncated]' : text;
    return `
          <article class="message user session-anchor" id="message-${escapeHtml(message.id)}">
            <div class="bubble">
              ${renderMessageHead('<span class="message-role">User</span>', '', message.timestamp, deltaMs)}
              ${renderMarkdown(preview)}
            </div>
          </article>
        `;
  }

  if (message.role === 'reasoning') {
    if (!text.trim()) return '';
    return `
          <article class="message assistant session-anchor" id="message-${escapeHtml(message.id || '')}">
            <div class="card" style="border-color: rgba(139,148,158,0.2); opacity:0.75">
              ${renderMessageHead('<span class="message-role" style="color:var(--muted)">Reasoning</span>', '', message.timestamp, deltaMs)}
              ${renderMarkdown(text)}
            </div>
          </article>
        `;
  }

  if (message.role === 'toolCall') {
    const args = message.details || {};
    const body = `<pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
    const header = `<span>🔧 ${escapeHtml(message.toolName || 'tool')}</span><span class="tool-meta">${escapeHtml(truncateId(message.toolCallId || ''))}</span>`;
    return `
          <article class="message toolResult ok session-anchor" id="message-${escapeHtml(message.id || message.toolCallId || '')}">
            <div class="card">
              ${renderMessageHead('<span class="message-role">Tool Call</span>', `<span class="tool-meta">${escapeHtml(message.toolName || 'tool')}</span>`, message.timestamp, deltaMs)}
              ${createCollapse(message.toolCallId, header, body, '')}
            </div>
          </article>
        `;
  }

  if (message.role === 'assistant') {
    const toolCalls = (message.content || [])
      .filter((item) => item.type === 'toolCall')
      .map(renderToolCall)
      .join('');
    const tokenBadge = message.usage?.totalTokens
      ? `<span class="badge">${escapeHtml(formatNumber(message.usage.totalTokens))} tokens</span>`
      : '';
    const modelBadge = `<span class="tool-meta">${escapeHtml(message.model || 'unknown model')}</span>`;
    const reasoningHtml = message.reasoning
      ? `<details class="reasoning-block"><summary>💭 Reasoning</summary><div class="reasoning-content">${renderMarkdown(message.reasoning)}</div></details>`
      : '';
    return `
          <article class="message assistant session-anchor" id="message-${escapeHtml(message.id)}">
            <div class="card">
              ${renderMessageHead('<span class="message-role">Assistant</span>', `${modelBadge}${tokenBadge}`, message.timestamp, deltaMs)}
              ${reasoningHtml}
              ${text ? renderMarkdown(text) : ''}
              ${toolCalls}
            </div>
          </article>
        `;
  }

  const resultClass = message.isError ? 'error' : 'ok';
  return `
        <article class="message toolResult ${resultClass} session-anchor" id="tool-result-${escapeHtml(message.toolCallId || message.id)}">
          <div class="card">
            ${renderMessageHead(`<span class="message-role">${message.isError ? 'Tool Error' : 'Tool Result'}</span>`, `<span class="tool-meta">${escapeHtml(message.toolName || 'tool result')}</span>`, message.timestamp, deltaMs, toolDurationMs)}
            ${renderToolResult(message)}
          </div>
        </article>
      `;
}

function renderTimeSplit(timing) {
  if (timing.totalDurationMs === null) return '';
  const total = timing.totalDurationMs;
  const toolMs = timing.totalToolDurationMs || 0;
  const modelMs = Math.max(0, total - toolMs);
  const toolPct = total > 0 ? Math.round((toolMs / total) * 100) : 0;
  const modelPct = total > 0 ? Math.round((modelMs / total) * 100) : 0;
  const hasSplit = timing.totalToolDurationMs !== null && total > 0;
  let html = `<span title="Wall-clock time from first to last message">⏱ Total: ${escapeHtml(formatDurationCompact(total))}</span>`;
  if (hasSplit) {
    html +=
      `<span title="Estimated breakdown: tool execution time vs model inference time (model = total − tool exec)">` +
      `🔧 Tool exec: ${escapeHtml(formatDurationCompact(toolMs))} (${toolPct}%)` +
      ` · 🤖 Model: ${escapeHtml(formatDurationCompact(modelMs))} (${modelPct}%)` +
      `</span>`;
  }
  return html;
}

// Summary details collapsed by default so 消息/Trace get the vertical space
let summaryCollapsed = (() => {
  try {
    return localStorage.getItem('axr-summary-collapsed') !== '0';
  } catch {
    return true;
  }
})();

function renderSummary() {
  if (!state.sessionData) {
    summary.innerHTML = `
          <div class="summary-top">
            <div>
              <h2>从左侧选择一个会话</h2>
              <div class="summary-meta"><span>顶部先选平台，左侧列表点击任意会话即可回放。</span></div>
            </div>
          </div>
        `;
    return;
  }

  const msgs = state.sessionData.messages;
  const timing = buildTimingAnalysis(msgs);
  const tokenSummary = summarizeTokens(msgs);
  const sessionCost = msgs.reduce((sum, m) => sum + (m.usage?.cost?.total || 0), 0);

  // Compute stats from loaded messages
  let userCount = 0,
    assistantCount = 0,
    toolCallCount = 0,
    toolResultCount = 0,
    errorCount = 0,
    spawnCount = 0;
  const toolNames = {};
  // Retry stats: per turn, track toolName -> error count; if same name succeeds after error = retry
  let totalRetryTools = 0; // number of distinct tools that were retried (across all turns)
  let totalRetryAttempts = 0; // total extra attempts due to retries
  let turnToolErrors = {}; // toolName -> errorCount within current turn
  for (const msg of msgs) {
    if (msg.role === 'user') {
      // New turn — tally retries from previous turn
      turnToolErrors = {};
    }
    if (msg.role === 'user') userCount++;
    if (msg.role === 'assistant') assistantCount++;
    if (msg.role === 'toolResult') {
      toolResultCount++;
      const name = msg.toolName || msg.name || '?';
      if (msg.isError) {
        errorCount++;
        turnToolErrors[name] = (turnToolErrors[name] || 0) + 1;
      } else if (turnToolErrors[name] > 0) {
        // Success after error(s) for same tool in same turn = retry
        totalRetryTools++;
        totalRetryAttempts += turnToolErrors[name];
        turnToolErrors[name] = 0; // reset so we don't double-count
      }
    }
    // Codex-style: toolCall is a separate role
    if (msg.role === 'toolCall') {
      toolCallCount++;
      const name = msg.toolName || 'unknown';
      toolNames[name] = (toolNames[name] || 0) + 1;
    }
    for (const c of msg.content || []) {
      if (c.type === 'toolCall') {
        toolCallCount++;
        const name = c.name || 'unknown';
        toolNames[name] = (toolNames[name] || 0) + 1;
        if (name === 'sessions_spawn') spawnCount++;
        if (name === 'delegate_task') spawnCount++;
        if (name === 'exec' && typeof (c.arguments || {}).command === 'string') {
          const cmd = c.arguments.command.toLowerCase();
          if (cmd.includes('codex ') || cmd.includes('claude ')) spawnCount++;
        }
      }
    }
  }

  const topTools = Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `<span class="badge">${escapeHtml(name)}: ${count}</span>`)
    .join('');

  const tokenBadges =
    (Object.keys(tokenSummary).length
      ? Object.entries(tokenSummary)
          .map(([key, value]) => `<span class="badge">${escapeHtml(key)}: ${escapeHtml(formatNumber(value))}</span>`)
          .join('')
      : '<span class="badge">No token data</span>') +
    (sessionCost > 0
      ? `<span class="badge" title="按消息 usage.cost.total 合计">💰 ${escapeHtml(formatCost(sessionCost))}</span>`
      : '');

  summary.innerHTML = `
        <div class="summary-top">
          <div>
            <h2>${escapeHtml(state.sessionData.session?.id || state.selectedSessionId)}</h2>
            <div class="summary-meta">
              <span>${escapeHtml(formatDate(state.sessionData.session?.timestamp))}</span>
              <span>${escapeHtml(state.sessionData.session?.cwd || 'Unknown cwd')}</span>
              ${(() => {
                const sm = state.sessions.find((s) => s.id === state.selectedSessionId);
                return sm?.model ? `<span class="badge">🧠 ${escapeHtml(sm.model)}</span>` : '';
              })()}
              ${renderTimeSplit(timing)}
              ${timing.slowestStep ? `<span class="slowest-step-link" title="Click to jump — total agent work time for this turn (user msg → last agent response)" data-target-id="${escapeHtml(timing.slowestStep.messageId || '')}">🐌 Slowest turn: +${escapeHtml(formatDurationCompact(timing.slowestStep.deltaMs))} (${escapeHtml(timing.slowestStep.label)})</span>` : ''}
              <span style="color:var(--muted)">耗时分析看 Trace 视图</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:flex-start">
            <button class="export-btn" id="summaryToggleBtn" title="折叠/展开会话统计详情">${summaryCollapsed ? '▸ 详情' : '▾ 收起'}</button>
            ${['codex', 'claude-code', 'omp'].includes(state.platform) ? '<button class="export-btn" id="resumeCmdBtn" title="复制在终端恢复此会话的命令">📋 复制恢复命令</button>' : ''}
            <div class="export-dropdown" id="exportDropdown">
              <button class="export-btn" id="exportBtn">📥 导出</button>
              <div class="export-menu" id="exportMenu">
                <button data-export="markdown">📝 Markdown (.md)</button>
                <button data-export="html">🌐 HTML (.html)</button>
                <button data-export="json">📦 JSON (.json)</button>
                <button data-export="clipboard">📋 复制到剪贴板</button>
                ${['codex', 'claude-code', 'omp'].includes(state.platform) ? '<button data-export="otlp">🔭 OTLP JSON</button>' : ''}
              </div>
            </div>
          </div>
        </div>
        <div class="summary-body" id="summaryBody" ${summaryCollapsed ? 'hidden' : ''}>
        <div class="summary-sections">
          <div class="summary-section">
            <div class="summary-section-title">Messages</div>
            <div class="token-grid">
              <span class="badge filter-badge${state.msgFilter === 'user' ? ' active' : ''}" data-filter="user" title="Click to show only user messages">👤 User: ${userCount}</span>
              <span class="badge filter-badge${state.msgFilter === 'assistant' ? ' active' : ''}" data-filter="assistant" title="Click to show only assistant messages">🤖 Assistant: ${assistantCount}</span>
              <span class="badge filter-badge${state.msgFilter === null ? ' active' : ''}" data-filter="all" title="Click to show all messages">💬 Total: ${msgs.length}</span>
            </div>
          </div>
          <div class="summary-section">
            <div class="summary-section-title">Tools</div>
            <div class="token-grid">
              <span class="badge filter-badge${state.msgFilter === 'toolCall' ? ' active' : ''}" data-filter="toolCall" title="Click to show only tool calls">🔧 Tool Calls: ${toolCallCount}</span>
              <span class="badge filter-badge${state.msgFilter === 'toolResult' ? ' active' : ''}" data-filter="toolResult" title="Click to show only tool results">📋 Tool Results: ${toolResultCount}</span>
              ${errorCount ? `<span class="badge filter-badge${state.msgFilter === 'error' ? ' active' : ''}" data-filter="error" title="Click to show only error tool results" style="color:#ff7b72">❌ Errors: ${errorCount}</span>` : ''}
              ${totalRetryTools > 0 ? `<span class="badge retry-jump-btn" id="retryJumpBtn" title="Click to jump to first retry · ${totalRetryTools} tool${totalRetryTools > 1 ? 's' : ''} retried (${totalRetryAttempts} extra attempt${totalRetryAttempts > 1 ? 's' : ''})" style="color:#a5d6ff;cursor:pointer">🔄 Retried: ${totalRetryTools} tool${totalRetryTools > 1 ? 's' : ''} · ${totalRetryAttempts} extra attempt${totalRetryAttempts > 1 ? 's' : ''}</span>` : ''}
              ${spawnCount ? `<span class="badge filter-badge${state.msgFilter === 'spawn' ? ' active' : ''}" data-filter="spawn" title="Click to show only spawn calls" style="color:#f0883e">🔗 Spawns: ${spawnCount}</span>` : ''}
            </div>
          </div>
          ${
            topTools
              ? `<div class="summary-section">
            <div class="summary-section-title">Top Tools</div>
            <div class="token-grid">${topTools}</div>
          </div>`
              : ''
          }
          <div class="summary-section">
            <div class="summary-section-title">Tokens</div>
            <div class="token-grid">${tokenBadges}</div>
          </div>
        </div>
        ${
          state.platform === 'openclaw'
            ? `
        <div class="spawn-tree-section">
          <h3>\u{1F333} Spawn Tree</h3>
          <div id="spawnTreeInSummary"></div>
        </div>`
            : ''
        }
        ${
          hasChildAgents()
            ? `
        <div class="spawn-tree-section" id="agentChildrenSection" hidden>
          <h3>\u{1F333} 子 Agent <span style="text-transform:none;letter-spacing:0;color:var(--muted);font-size:0.75rem">— 本会话派生的后台 agent，点击查看其完整执行记录</span></h3>
          <div id="agentChildrenList"></div>
        </div>`
            : ''
        }
        </div><!-- /summary-body -->
      `;
  if (hasChildAgents()) loadChildAgents();
  // Collapse/expand summary details (persisted)
  const summaryToggleBtn = document.getElementById('summaryToggleBtn');
  if (summaryToggleBtn)
    summaryToggleBtn.addEventListener('click', () => {
      summaryCollapsed = !summaryCollapsed;
      try {
        localStorage.setItem('axr-summary-collapsed', summaryCollapsed ? '1' : '0');
      } catch {}
      document.getElementById('summaryBody').hidden = summaryCollapsed;
      summaryToggleBtn.textContent = summaryCollapsed ? '▸ 详情' : '▾ 收起';
    });

  // Bind filter badge clicks
  summary.querySelectorAll('.filter-badge').forEach((badge) => {
    badge.addEventListener('click', () => {
      const f = badge.getAttribute('data-filter');
      state.msgFilter = f === 'all' ? null : f;
      renderSummary();
      renderMessages();
    });
  });

  // Bind slowest step jump
  summary.querySelectorAll('.slowest-step-link').forEach((link) => {
    link.addEventListener('click', () => {
      scrollToMessage(link.getAttribute('data-target-id'));
    });
  });

  // Retry jump: click → expand all + scroll to first retry annotation
  const retryJumpBtn = document.getElementById('retryJumpBtn');
  if (retryJumpBtn) {
    retryJumpBtn.addEventListener('click', () => {
      // Expand all messages first
      state.visibleUnitCount = Infinity;
      renderMessages();
      // Find first retry-error annotation and scroll to its parent msg-row
      const firstRetry = document.querySelector('.retry-annotation.retry-error, .retry-annotation.retry-error-final');
      if (firstRetry) {
        const row = firstRetry.closest('.msg-row') || firstRetry;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Also expand the parent turn-group-body if collapsed
        const body = row.closest('.turn-group-body');
        if (body && !body.classList.contains('open')) {
          body.classList.add('open');
          const tid = body.id.replace('body-', '');
          const chevron = document.getElementById('chevron-' + tid);
          if (chevron) chevron.classList.add('open');
        }
        // Flash highlight
        firstRetry.style.outline = '2px solid #a5d6ff';
        setTimeout(() => {
          firstRetry.style.outline = '';
        }, 2000);
      }
    });
  }

  // Export dropdown
  const exportBtn = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');
  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    // Close menu when clicking outside
    document.addEventListener('click', () => exportMenu.classList.remove('open'));
    exportMenu.querySelectorAll('button[data-export]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.remove('open');
        const fmt = btn.dataset.export;
        if (fmt === 'markdown') exportAsMarkdown();
        else if (fmt === 'html') exportAsHtml();
        else if (fmt === 'json') exportAsJson();
        else if (fmt === 'clipboard') exportToClipboard();
        else if (fmt === 'otlp') exportAsOtlp();
      });
    });
  }

  // Resume command copy
  const resumeCmdBtn = document.getElementById('resumeCmdBtn');
  if (resumeCmdBtn) {
    resumeCmdBtn.addEventListener('click', async () => {
      const id = state.selectedSessionId;
      let cmd = '';
      if (state.platform === 'codex') cmd = `codex resume ${id} --yolo`;
      else if (state.platform === 'claude-code') cmd = `claude --dangerously-skip-permissions --resume ${id}`;
      else if (state.platform === 'omp') cmd = `omp --auto-approve --resume=${id}`;
      const cwd = state.sessionData.session?.cwd;
      if (cwd) cmd = `cd ${cwd} && ${cmd}`;
      try {
        await navigator.clipboard.writeText(cmd);
        resumeCmdBtn.textContent = '已复制';
        setTimeout(() => {
          resumeCmdBtn.textContent = '📋 复制恢复命令';
        }, 1500);
      } catch (error) {
        showError('复制失败: ' + error.message);
      }
    });
  }
}

// ========= Export Functions =========

function sessionToMarkdown() {
  if (!state.sessionData) return '';
  const session = state.sessionData.session || {};
  const msgs = state.sessionData.messages || [];
  const lines = [];

  lines.push(`# Session: ${session.id || state.selectedSessionId}`);
  lines.push('');
  if (session.timestamp) lines.push(`**Date:** ${formatDate(session.timestamp)}`);
  if (session.cwd) lines.push(`**Working Directory:** ${session.cwd}`);
  lines.push(`**Platform:** ${state.platform || 'unknown'}`);
  lines.push(`**Messages:** ${msgs.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of msgs) {
    const ts = msg.timestamp ? formatDate(msg.timestamp) : '';
    const text = getTextContent(msg.content);

    if (msg.role === 'user') {
      lines.push(`## 👤 User ${ts ? `(${ts})` : ''}`);
      lines.push('');
      lines.push(text);
      lines.push('');
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg.content || []).filter((c) => c.type === 'toolCall');
      if (msg.reasoning) {
        lines.push(`### 💭 Reasoning ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(msg.reasoning);
        lines.push('');
      }
      if (text.trim()) {
        lines.push(`## 🤖 Assistant ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(text);
        lines.push('');
      }
      for (const tc of toolCalls) {
        lines.push(`### 🔧 Tool Call: ${tc.name || 'unknown'}`);
        lines.push('');
        const args = tc.arguments || tc.input || {};
        lines.push('```json');
        lines.push(JSON.stringify(args, null, 2));
        lines.push('```');
        lines.push('');
      }
    } else if (msg.role === 'toolResult') {
      const name = msg.toolName || msg.name || '';
      const isErr = msg.isError;
      lines.push(`### ${isErr ? '❌' : '📋'} Tool Result${name ? ': ' + name : ''} ${ts ? `(${ts})` : ''}`);
      lines.push('');
      const output = text || (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2));
      // Truncate very long tool outputs
      const maxLen = 2000;
      if (output.length > maxLen) {
        lines.push('```');
        lines.push(output.slice(0, maxLen) + `\n\n... (truncated, ${output.length} chars total)`);
        lines.push('```');
      } else {
        lines.push('```');
        lines.push(output);
        lines.push('```');
      }
      lines.push('');
    } else if (msg.role === 'toolCall') {
      // Codex-style separate toolCall
      const name = msg.toolName || msg.name || 'unknown';
      lines.push(`### 🔧 Tool Call: ${name} ${ts ? `(${ts})` : ''}`);
      lines.push('');
      const args = msg.details || msg.arguments || {};
      lines.push('```json');
      lines.push(JSON.stringify(args, null, 2));
      lines.push('```');
      lines.push('');
    } else if (msg.role === 'reasoning') {
      if (text.trim()) {
        lines.push(`### 💭 Reasoning ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(text);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function getExportFilename(ext) {
  const id = state.sessionData?.session?.id || state.selectedSessionId || 'session';
  // Sanitize: keep alphanumeric, dash, underscore
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return `agentxray-${safe}.${ext}`;
}

function exportAsMarkdown() {
  const md = sessionToMarkdown();
  downloadFile(md, getExportFilename('md'), 'text/markdown;charset=utf-8');
}

function exportAsJson() {
  if (!state.sessionData) return;
  const json = JSON.stringify(state.sessionData, null, 2);
  downloadFile(json, getExportFilename('json'), 'application/json;charset=utf-8');
}

// Server-rendered standalone HTML export (inline CSS, secrets scrubbed best-effort).
function exportAsHtml() {
  if (!state.selectedSessionId) return;
  const params = new URLSearchParams({ format: 'html' });
  if (state.platform === 'openclaw') params.set('agent', state.selectedAgent);
  const dir = dirParam();
  if (dir) params.set('dir', decodeURIComponent(dir.slice('?dir='.length)));
  const a = document.createElement('a');
  a.href = `/api/${encodeURIComponent(state.platform)}/sessions/${encodeURIComponent(state.selectedSessionId)}/export?${params}`;
  a.download = '';
  a.click();
}

async function exportAsOtlp() {
  if (!state.selectedSessionId) return;
  try {
    const data = await fetchJson(
      `/api/otlp/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.selectedSessionId)}` + dirParam()
    );
    downloadFile(
      JSON.stringify(data, null, 2),
      `${state.selectedSessionId}-otlp.json`,
      'application/json;charset=utf-8'
    );
  } catch (error) {
    showError('OTLP 导出失败: ' + error.message);
  }
}

async function exportToClipboard() {
  const md = sessionToMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    // Brief visual feedback on the export button
    const btn = document.getElementById('exportBtn');
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    }
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// Scroll to a message by ID, expanding pagination if needed
function scrollToMessage(msgId) {
  if (!msgId) return;
  // The target lives in the messages list — leave Trace view if active
  if (sessionView !== 'messages') {
    sessionView = 'messages';
    applySessionView();
  }
  const findEl = () =>
    document.getElementById('message-' + CSS.escape(msgId)) ||
    document.getElementById('tool-result-' + CSS.escape(msgId)) ||
    document.getElementById('row-' + CSS.escape(msgId)) ||
    document.querySelector(`[id*="${CSS.escape(msgId)}"]`);
  let el = findEl();
  if (!el) {
    // Message not in DOM — expand all units and re-render
    state.visibleUnitCount = Infinity;
    renderMessages();
    el = findEl();
  }
  if (!el && state.msgFilter) {
    // Still missing: an active role filter is hiding it — clear and retry
    state.msgFilter = null;
    renderSummary();
    renderMessages();
    el = findEl();
  }
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash-highlight');
    void el.offsetWidth;
    el.classList.add('flash-highlight');
  }
}

// Analyze retry chains within a turn.
// Returns: { retryCount, retryMap: Map<stepMsg, {status, attempt, totalAttempts, toolName}> }
// status: 'error-retried' | 'error-final' | 'success-recovered' | 'success-first'
function buildRetryChains(unit) {
  // Collect toolResults keyed by toolName in order
  // A retry = same toolName appears multiple times in steps
  const byName = {}; // toolName -> [{msg, isError, idx}]

  unit.steps.forEach((step, idx) => {
    if (step.role !== 'toolResult') return;
    const name = step.toolName || step.name || '?';
    if (!byName[name]) byName[name] = [];
    byName[name].push({ msg: step, isError: step.isError, idx });
  });

  const retryMap = new Map();
  let retryCount = 0;

  for (const [toolName, attempts] of Object.entries(byName)) {
    if (attempts.length < 2) {
      // Only one attempt, no retry
      const a = attempts[0];
      retryMap.set(a.msg, {
        status: a.isError ? 'error-final' : 'success-first',
        attempt: 1,
        totalAttempts: 1,
        toolName,
      });
      continue;
    }

    // Multiple attempts for same tool
    const hasAnyError = attempts.some((a) => a.isError);
    if (hasAnyError) retryCount++;

    attempts.forEach((a, i) => {
      const isLast = i === attempts.length - 1;
      let status;
      if (a.isError) {
        status = 'error-retried'; // error, and there's a next attempt
      } else if (!isLast) {
        status = 'success-first'; // success but more calls follow (parallel calls, not retry)
      } else {
        // Last attempt and success: check if any prior was error
        status = hasAnyError ? 'success-recovered' : 'success-first';
      }
      retryMap.set(a.msg, {
        status,
        attempt: i + 1,
        totalAttempts: attempts.length,
        toolName,
      });
    });
  }

  return { retryCount, retryMap };
}

function renderRetryAnnotation(retryInfo) {
  const { status, attempt, totalAttempts, toolName } = retryInfo;
  if (status === 'error-retried') {
    return `<div class="retry-annotation retry-error">❌ Attempt ${attempt}/${totalAttempts} failed — agent will retry</div>`;
  } else if (status === 'error-final') {
    return `<div class="retry-annotation retry-error-final">❌ All ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''} failed</div>`;
  } else if (status === 'success-recovered') {
    return `<div class="retry-annotation retry-recovered">✅ Attempt ${attempt}/${totalAttempts} — recovered after ${attempt - 1} error${attempt - 1 > 1 ? 's' : ''}</div>`;
  }
  return '';
}

function renderMessages() {
  if (!state.sessionData) {
    messages.innerHTML = '<div class="empty">Session messages will appear here.</div>';
    return;
  }
  const isCodex = state.platform === 'codex' || state.platform === 'omp';
  const timing = buildTimingAnalysis(state.sessionData.messages);
  const filtered = timing.visibleMessages.filter((msg) => {
    // Apply stat filter
    const f = state.msgFilter;
    if (f === 'user') return msg.role === 'user';
    if (f === 'assistant') return msg.role === 'assistant';
    if (f === 'toolCall') {
      if (msg.role === 'toolCall') return true;
      return (msg.content || []).some((c) => c.type === 'toolCall');
    }
    if (f === 'toolResult') return msg.role === 'toolResult';
    if (f === 'error') return msg.role === 'toolResult' && msg.isError;
    if (f === 'spawn') {
      if (msg.role === 'toolCall' && msg.toolName === 'sessions_spawn') return true;
      return (msg.content || []).some((c) => {
        if (c.type !== 'toolCall') return false;
        if (c.name === 'sessions_spawn') return true;
        if (c.name === 'exec' && typeof (c.arguments || {}).command === 'string') {
          const cmd = c.arguments.command.toLowerCase();
          return cmd.includes('codex ') || cmd.includes('claude ');
        }
        return false;
      });
    }
    return true;
  });

  // Group messages into display units:
  // - user messages: standalone
  // - assistant with text only: standalone
  // - assistant with tools + subsequent toolResults: collapsible group
  // - For Codex: toolCall is a separate role, so assistant -> toolCall* -> toolResult*
  const units = [];
  let i = 0;
  while (i < filtered.length) {
    const msg = filtered[i];

    if (msg.role === 'user') {
      units.push({ type: 'single', msg });
      i++;
      continue;
    }

    if (msg.role === 'reasoning') {
      units.push({ type: 'single', msg });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      // OpenClaw-style: toolCalls are inside assistant content
      const tools = (msg.content || []).filter((c) => c.type === 'toolCall');

      if (tools.length === 0 && !isCodex) {
        // Pure text assistant message (OpenClaw)
        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      // For Codex: assistant text message, then collect subsequent toolCall/toolResult roles
      if (isCodex && tools.length === 0) {
        // Collect trailing toolCall and toolResult records that follow this assistant
        const codexTools = [];
        const codexResults = [];
        let peek = i + 1;
        while (peek < filtered.length) {
          const next = filtered[peek];
          if (next.role === 'toolCall') {
            codexTools.push(next);
            codexResults.push(next); // include in steps
            peek++;
          } else if (next.role === 'toolResult') {
            codexResults.push(next);
            peek++;
          } else if (next.role === 'reasoning') {
            // reasoning between assistant and tools, skip
            peek++;
          } else {
            break;
          }
        }

        if (codexTools.length > 0) {
          // Render assistant text above, tool calls grouped below
          const group = { type: 'turn', assistant: msg, tools: codexTools, steps: codexResults };
          i = peek;
          units.push(group);
          continue;
        }

        // Pure text assistant, no tools
        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      // OpenClaw-style: assistant with embedded toolCalls
      if (tools.length === 0) {
        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      const group = { type: 'turn', assistant: msg, tools, steps: [] };
      i++;

      while (i < filtered.length) {
        const next = filtered[i];
        if (next.role === 'toolResult') {
          group.steps.push(next);
          i++;
        } else if (next.role === 'assistant') {
          const nextTools = (next.content || []).filter((c) => c.type === 'toolCall');
          const nextText = (next.content || []).filter((c) => c.type === 'text' && (c.text || '').trim());
          if (nextTools.length > 0) {
            group.steps.push(next);
            group.tools.push(...nextTools);
            i++;
          } else if (nextText.length === 0) {
            i++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      units.push(group);
      continue;
    }

    // Orphan toolResult / toolCall (no preceding assistant)
    units.push({ type: 'single', msg });
    i++;
  }

  // Render units (paginated: newest first, with "load more" button for older)
  units.reverse(); // newest on top
  const totalUnits = units.length;
  const endIdx = Math.min(totalUnits, state.visibleUnitCount);
  const hasMore = endIdx < totalUnits;
  let html = '';
  let turnIdx = 0;
  for (let ui = 0; ui < endIdx; ui++) {
    const unit = units[ui];
    if (unit.type === 'single') {
      html += `
            <div class="msg-row" id="row-${escapeHtml(unit.msg.id || '')}">
              ${renderGraphLane(unit.msg)}
              <div class="msg-content">${renderMessage(unit.msg, timing.timingByMessage.get(unit.msg))}</div>
            </div>`;
    } else {
      // Turn group
      const tid = 'turn-' + turnIdx++;
      const toolCount = unit.tools.length;
      const stepCount = unit.steps.length;
      const errCount = unit.steps.filter((s) => s.role === 'toolResult' && s.isError).length;
      const spawnCount = unit.tools.filter((t) => {
        if (t.name === 'sessions_spawn') return true;
        if (t.name === 'delegate_task') return true;
        if (t.name === 'exec' && typeof (t.arguments || {}).command === 'string') {
          const cmd = t.arguments.command.toLowerCase();
          return cmd.includes('codex ') || cmd.includes('claude ');
        }
        return false;
      }).length;

      // Unique tool names for chips
      const toolNameCounts = {};
      unit.tools.forEach((t) => {
        const n = t.name || '?';
        toolNameCounts[n] = (toolNameCounts[n] || 0) + 1;
      });
      const chips = Object.entries(toolNameCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, count]) => `<span class="turn-chip">${escapeHtml(name)}${count > 1 ? ' ×' + count : ''}</span>`)
        .join('');
      const errChip = errCount
        ? `<span class="turn-chip err">❌ ${errCount} error${errCount > 1 ? 's' : ''}</span>`
        : '';
      const spawnChip = spawnCount ? `<span class="turn-chip spawn">🔗 ${spawnCount} spawn</span>` : '';

      // Retry chain analysis
      const { retryCount, retryMap } = buildRetryChains(unit);
      const retryChip =
        retryCount > 0
          ? `<span class="turn-chip retry" title="${retryCount} tool${retryCount > 1 ? 's were' : ' was'} retried after errors">🔄 ${retryCount} retr${retryCount > 1 ? 'ies' : 'y'}</span>`
          : '';

      // Tool batch duration: first toolCall start → last toolResult finish
      let turnToolDurationChip = '';
      {
        // First toolCall timestamp
        let firstCallTs = null;
        if (isCodex) {
          // Codex: unit.tools are separate toolCall records
          for (const t of unit.tools) {
            const ts = parseTimestampMs(t.timestamp);
            if (ts !== null && (firstCallTs === null || ts < firstCallTs)) firstCallTs = ts;
          }
        } else {
          // OpenClaw: toolCalls are embedded in assistant content — use assistant message ts
          firstCallTs = parseTimestampMs(unit.assistant.timestamp);
        }
        // Last toolResult timestamp
        let lastResultTs = null;
        for (const step of unit.steps) {
          if (step.role === 'toolResult') {
            const ts = parseTimestampMs(step.timestamp);
            if (ts !== null && (lastResultTs === null || ts > lastResultTs)) lastResultTs = ts;
          }
        }
        if (firstCallTs !== null && lastResultTs !== null && lastResultTs > firstCallTs) {
          const dur = lastResultTs - firstCallTs;
          let cls = '';
          if (dur >= 60000) cls = ' danger';
          else if (dur >= 10000) cls = ' warn';
          turnToolDurationChip = `<span class="turn-chip${cls}" title="Total tool execution time for this turn">⏱ ${escapeHtml(formatDurationCompact(dur))}</span>`;
        }
      }

      // Render the assistant text (if any) outside the fold
      const assistantText = getTextContent(unit.assistant.content);
      const assistantTextHtml = assistantText
        ? renderMessage(unit.assistant, timing.timingByMessage.get(unit.assistant))
        : '';

      // The graph node for the assistant
      const assistantRow = `
            <div class="msg-row" id="row-${escapeHtml(unit.assistant.id || '')}">
              ${renderGraphLane(unit.assistant)}
              <div class="msg-content">
                ${assistantTextHtml}
                <div class="turn-group">
                  <div class="turn-group-header" data-turn="${tid}">
                    <span class="turn-chevron" id="chevron-${tid}">▶</span>
                    <div class="turn-summary">
                      <strong>🔧 ${toolCount} tool call${toolCount > 1 ? 's' : ''}</strong>
                      <span>· ${stepCount} result${stepCount > 1 ? 's' : ''}</span>
                    </div>
                    <div class="turn-group-chips">${turnToolDurationChip}${chips}${retryChip}${errChip}${spawnChip}</div>
                  </div>
                  <div class="turn-group-body" id="body-${tid}">`;

      html += assistantRow;

      // Render each step inside the fold
      for (const step of unit.steps) {
        const retryInfo = retryMap.get(step);
        const retryAnnotation = retryInfo && retryInfo.totalAttempts > 1 ? renderRetryAnnotation(retryInfo) : '';
        html += `
                    <div class="msg-row" id="row-${escapeHtml(step.id || '')}">
                      ${renderGraphLane(step)}
                      <div class="msg-content">${retryAnnotation}${renderMessage(step, timing.timingByMessage.get(step))}</div>
                    </div>`;
      }

      html += `
                  </div>
                </div>
              </div>
            </div>`;
    }
  }

  if (hasMore) {
    const remaining = totalUnits - endIdx;
    html += `<div class="load-more-bar" id="loadMoreBar">
          <button class="load-more-btn" id="loadMoreBtn">▼ Load ${Math.min(remaining, MSG_BATCH_SIZE)} earlier messages (${remaining} hidden)</button>
        </div>`;
  }
  messages.innerHTML = html;
  bindMessageInteractions();
  if (state.autoScroll) {
    messages.scrollTop = 0;
  }
}

function bindMessageInteractions() {
  const tooltip = document.getElementById('graphTooltip');

  // "Load more" button for paginated rendering
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      state.visibleUnitCount += MSG_BATCH_SIZE;
      renderMessages();
      // Scroll down to where the new messages start
      const loadMoreBar = document.getElementById('loadMoreBar');
      if (loadMoreBar) loadMoreBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Graph node hover tooltips
  messages.querySelectorAll('.graph-lane .node').forEach((node) => {
    node.addEventListener('mouseenter', (e) => {
      const tip = node.getAttribute('data-tip');
      if (!tip) return;
      tooltip.textContent = tip;
      tooltip.style.display = 'block';
      tooltip.style.left = e.clientX + 12 + 'px';
      tooltip.style.top = e.clientY - 10 + 'px';
    });
    node.addEventListener('mousemove', (e) => {
      tooltip.style.left = e.clientX + 12 + 'px';
      tooltip.style.top = e.clientY - 10 + 'px';
    });
    node.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
    // Click to scroll to the message
    node.addEventListener('click', () => {
      const msgId = node.getAttribute('data-msg-id');
      if (!msgId) return;
      const row = document.getElementById(`row-${CSS.escape(msgId)}`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.outline = '2px solid #58a6ff';
        setTimeout(() => {
          row.style.outline = '';
        }, 1500);
      }
    });
  });
  // Turn group fold/unfold
  messages.querySelectorAll('.turn-group-header').forEach((header) => {
    header.addEventListener('click', () => {
      const tid = header.getAttribute('data-turn');
      const body = document.getElementById(`body-${tid}`);
      const chevron = document.getElementById(`chevron-${tid}`);
      if (!body) return;
      body.classList.toggle('open');
      if (chevron) chevron.classList.toggle('open');
    });
  });

  messages.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-toggle');
      const panel = document.getElementById(`panel-${CSS.escape(id)}`);
      if (!panel) return;
      panel.classList.toggle('open');
    });
  });

  messages.querySelectorAll('[data-link-id]').forEach((node) => {
    node.addEventListener('dblclick', () => {
      const id = node.getAttribute('data-link-id');
      const match =
        document.getElementById(`tool-result-${CSS.escape(id)}`) ||
        document.querySelector(`[data-link-id="${CSS.escape(id)}"]`);
      if (match && match !== node) {
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  messages.querySelectorAll('[data-expand-output]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-expand-output');
      const visiblePre = button.previousElementSibling;
      const hiddenPre = document.getElementById(`full-output-${CSS.escape(id)}`);
      if (!visiblePre || !hiddenPre) return;
      const expanded = hiddenPre.hidden;
      hiddenPre.hidden = !hiddenPre.hidden;
      visiblePre.hidden = expanded;
      button.textContent = expanded ? 'Show preview' : 'Show all';
    });
  });

  // Spawn navigation buttons
  messages.querySelectorAll('[data-spawn-agent]').forEach((button) => {
    button.addEventListener('click', async () => {
      const childAgent = button.getAttribute('data-spawn-agent');
      await navigateToChildAgent(childAgent);
    });
  });

  // Exec spawn: scroll to the toolResult in the same session
  messages.querySelectorAll('[data-scroll-to-result]').forEach((button) => {
    button.addEventListener('click', () => {
      const toolCallId = button.getAttribute('data-scroll-to-result');
      let resultEl = document.getElementById(`tool-result-${CSS.escape(toolCallId)}`);
      if (!resultEl) {
        // Message not in DOM — expand all units and re-render
        state.visibleUnitCount = Infinity;
        renderMessages();
        resultEl = document.getElementById(`tool-result-${CSS.escape(toolCallId)}`);
      }
      if (resultEl) {
        resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Auto-expand the collapsed panel
        const panel = resultEl.querySelector('.collapsible');
        if (panel && !panel.classList.contains('open')) {
          panel.classList.add('open');
        }
        // Brief highlight
        resultEl.style.outline = '2px solid #58a6ff';
        setTimeout(() => {
          resultEl.style.outline = '';
        }, 2000);
      }
    });
  });
}

async function navigateToChildAgent(childAgent) {
  // Push current location to nav stack
  state.navStack.push({
    agent: state.selectedAgent,
    sessionId: state.selectedSessionId,
  });

  // Find the child agent in agent list
  if (!state.agents.includes(childAgent)) {
    showError(`Agent "${childAgent}" not found. It may not have any sessions.`);
    state.navStack.pop();
    return;
  }

  state.selectedAgent = childAgent;
  renderAgents();
  state.selectedSessionId = '';
  await loadSessions(false);
  if (state.sessions.length > 0) {
    state.selectedSessionId = state.sessions[0].id;
  }
  renderSessions();
  await loadSession();
  renderBreadcrumb();
}

async function navigateToBreadcrumb(index) {
  const target = state.navStack[index];
  if (!target) return;

  // Trim the nav stack to this point
  state.navStack = state.navStack.slice(0, index);

  state.selectedAgent = target.agent;
  renderAgents();
  state.selectedSessionId = target.sessionId;
  await loadSessions(true);
  renderSessions();
  await loadSession();
  renderBreadcrumb();
}

const breadcrumbEl = document.getElementById('breadcrumb');

function renderBreadcrumb() {
  if (state.navStack.length === 0) {
    breadcrumbEl.hidden = true;
    return;
  }

  breadcrumbEl.hidden = false;
  let html = '';

  state.navStack.forEach((item, index) => {
    html += `<span class="breadcrumb-item" data-bc-index="${index}">${escapeHtml(item.agent)}</span>`;
    html += '<span class="breadcrumb-sep">→</span>';
  });

  html += `<span class="breadcrumb-item current">${escapeHtml(state.selectedAgent)}</span>`;

  breadcrumbEl.innerHTML = html;

  // Bind breadcrumb clicks
  breadcrumbEl.querySelectorAll('[data-bc-index]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-bc-index'), 10);
      navigateToBreadcrumb(idx);
    });
  });
}

async function loadAgents() {
  const dp = dirParam();
  try {
    if (state.platform === 'openclaw') {
      state.agents = await fetchJson('/api/agents' + dp);
      if (!state.selectedAgent && state.agents.length) {
        state.selectedAgent = state.agents[0];
      }
    } else {
      state.agents = [];
      state.selectedAgent = '';
    }
  } finally {
    // Always render the platform bar, even if the agents fetch fails
    // (e.g. default OpenClaw dir missing) — otherwise no platform can be selected.
    renderAgents();
  }
}

async function loadSessions(preserveSelection) {
  const dp = dirParam();
  const dirAmp = dp ? dp.replace('?', '&') : '';
  if (state.platform === 'openclaw') {
    if (!state.selectedAgent) return;
    state.sessions = await fetchJson(
      `/api/agents/${encodeURIComponent(state.selectedAgent)}/sessions?include_archived=${state.includeArchived}${dirAmp}`
    );
  } else if (state.platform === 'codex') {
    state.sessions = await fetchJson('/api/codex/sessions' + dp);
  } else if (state.platform === 'claude-code') {
    state.sessions = await fetchJson('/api/claude-code/sessions' + dp);
  } else if (state.platform === 'hermes') {
    state.sessions = await fetchJson('/api/hermes/sessions' + dp);
  } else if (state.platform === 'omp') {
    state.sessions = await fetchJson('/api/omp/sessions' + dp);
  } else if (state.platform === 'dsh') {
    state.sessions = await fetchJson('/api/dsh/sessions' + dp);
  }
  if (state.platform !== 'openclaw' && Array.isArray(state.sessions))
    platformSessionCounts[state.platform] = state.sessions.length;
  if (!preserveSelection || !state.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = state.sessions[0]?.id || '';
  }
  renderSessions();
}

async function loadSession() {
  if (!state.selectedSessionId) {
    state.sessionData = null;
    closeSse();
    renderSummary();
    renderMessages();
    sessionViewToggle.hidden = true;
    tracePanel.hidden = true;
    if (currentView === 'insights') loadInsights();
    return;
  }
  loading.hidden = false;
  let payload;
  const dp = dirParam();
  if (state.platform === 'openclaw') {
    payload = await fetchJson(
      `/api/agents/${encodeURIComponent(state.selectedAgent)}/sessions/${encodeURIComponent(state.selectedSessionId)}` +
        dp
    );
  } else if (state.platform === 'codex') {
    payload = await fetchJson(`/api/codex/sessions/${encodeURIComponent(state.selectedSessionId)}` + dp);
  } else if (state.platform === 'claude-code') {
    payload = await fetchJson(`/api/claude-code/sessions/${encodeURIComponent(state.selectedSessionId)}` + dp);
  } else if (state.platform === 'hermes') {
    payload = await fetchJson(`/api/hermes/sessions/${encodeURIComponent(state.selectedSessionId)}` + dp);
  } else if (state.platform === 'omp') {
    payload = await fetchJson(`/api/omp/sessions/${encodeURIComponent(state.selectedSessionId)}` + dp);
  } else if (state.platform === 'dsh') {
    payload = await fetchJson(`/api/dsh/sessions/${encodeURIComponent(state.selectedSessionId)}` + dp);
  }
  state.sessionData = payload;
  // Show all messages if <= 200, otherwise first 60 with load-more
  state.visibleUnitCount = (payload?.messages?.length || 0) <= 200 ? Infinity : MSG_BATCH_SIZE;
  renderSummary();
  renderMessages();
  loadSpawnTree(state.selectedSessionId);
  loading.hidden = true;
  // Start SSE real-time tail for this session
  startSse();
  // Refresh insights if currently viewing
  if (currentView === 'insights') loadInsights();
  // Trace view: enable toggle, refresh if active
  childAgentViewing = null; // back to the parent session
  sessionViewToggle.hidden = false;
  if (sessionView === 'trace') renderTrace();
}

// --- Trace waterfall view (Langfuse-style per-turn spans) ---
let sessionView = 'messages';
const tracePanel = document.getElementById('tracePanel');
const sessionViewToggle = document.getElementById('sessionViewToggle');
let traceSpans = []; // flat span list of the current trace render, for sidebar lookup

sessionViewToggle.querySelectorAll('.sv-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.sv === sessionView) return;
    sessionView = btn.dataset.sv;
    applySessionView();
  });
});

function applySessionView() {
  sessionViewToggle
    .querySelectorAll('.sv-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.sv === sessionView));
  document.getElementById('messages').style.display = sessionView === 'messages' ? '' : 'none';
  tracePanel.hidden = sessionView !== 'trace';
  if (sessionView === 'trace') renderTrace();
}

// Platforms whose sessions can spawn child agents, and the API base for each
function hasChildAgents() {
  return state.platform === 'omp' || state.platform === 'claude-code';
}
function childrenEndpoint() {
  const base = state.platform === 'claude-code' ? '/api/claude-code' : '/api/omp';
  return `${base}/sessions/${encodeURIComponent(state.selectedSessionId)}/children`;
}
// Chip/span label: claude-code children carry meta (description/agentType); omp children only a name
function childAgentLabel(c) {
  return (state.platform === 'claude-code' ? c.description || c.agentType : '') || c.name;
}
// Cache of the current session's subagent list (shared with loadChildAgents)
let childrenCache = { sid: null, platform: null, data: [] };
let childAgentViewing = null; // non-null while a child transcript is loaded
async function getSessionChildren() {
  if (!hasChildAgents() || !state.selectedSessionId) return [];
  if (childrenCache.sid === state.selectedSessionId && childrenCache.platform === state.platform)
    return childrenCache.data;
  try {
    const data = await fetchJson(childrenEndpoint() + dirParam());
    childrenCache = { sid: state.selectedSessionId, platform: state.platform, data };
    return data;
  } catch {
    return [];
  }
}

async function renderTrace() {
  const msgs = state.sessionData?.messages || [];
  const children = childAgentViewing ? [] : await getSessionChildren();
  const agentSpans = children.map((c) => ({
    name: c.name,
    label: childAgentLabel(c),
    start: parseTimestampMs(c.timestamp),
    end: parseTimestampMs(c.lastActivity),
  }));
  const turns = buildTraceTurns(msgs, agentSpans);
  if (!turns.length) {
    tracePanel.innerHTML =
      '<div class="insights-empty">此会话没有可视化的时间数据（消息缺少时间戳或没有模型/工具活动）。</div>';
    return;
  }
  traceSpans = [];
  const html = turns
    .map((tn) => {
      const dur = Math.max(tn.end - tn.start, 1);
      const rows = tn.spans
        .map((s) => {
          const left = ((s.start - tn.start) / dur) * 100;
          const width = Math.max(((s.end - s.start) / dur) * 100, 0.4);
          const durText = formatDurationCompact(s.end - s.start);
          const cls = s.kind === 'chat' ? 'chat' : s.kind;
          const showDur = width < 78; // avoid overflowing the track for near-full bars
          const icon = s.kind === 'chat' ? '🤖' : s.kind === 'agent' ? '🌳' : '🔧';
          const action =
            s.kind === 'agent'
              ? `data-agent-name="${escapeHtml(s.agentName)}" title="子 Agent ${escapeHtml(s.label)} — ${escapeHtml(durText)}，点击查看其执行记录"`
              : `data-span-idx="${traceSpans.push(s) - 1}" title="${escapeHtml(s.label)} — ${escapeHtml(durText)}，点击查看详情"`;
          return `
            <div class="trace-row">
              <div class="tr-label" title="${escapeHtml(s.label)}">${icon} ${escapeHtml(s.label)}</div>
              <div class="tr-track">
                <div class="tr-bar ${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" ${action}>${showDur ? `<span class="tr-dur">${escapeHtml(durText)}</span>` : ''}</div>
              </div>
            </div>`;
        })
        .join('');
      return `
          <div class="trace-turn">
            <div class="trace-turn-head">
              <span class="tt-time">${escapeHtml(new Date(tn.start).toLocaleTimeString())}</span>
              <span class="tt-text" title="${escapeHtml(tn.text)}">👤 ${escapeHtml(tn.text)}</span>
              <span class="tt-dur">${escapeHtml(formatDurationCompact(tn.end - tn.start))}</span>
            </div>
            <div class="trace-rows">${rows}</div>
          </div>`;
    })
    .join('');
  tracePanel.innerHTML = `
        <div class="trace-legend">
          <span><span class="lg" style="background:#58a6ff"></span>模型推理</span>
          <span><span class="lg" style="background:#3fb950"></span>工具执行</span>
          <span><span class="lg" style="background:#f85149"></span>工具报错</span>
          <span><span class="lg" style="background:#d2a8ff"></span>子 Agent</span>
          <span style="margin-left:auto">每轮独立时间轴 · 点击色条查看详情</span>
        </div>${html}`;

  tracePanel.querySelectorAll('.tr-bar[data-span-idx]').forEach((bar) => {
    bar.addEventListener('click', () => {
      const span = traceSpans[Number(bar.dataset.spanIdx)];
      if (span) openSpanSidebar(span);
    });
  });
  tracePanel.querySelectorAll('.tr-bar[data-agent-name]').forEach((bar) => {
    bar.addEventListener('click', () => viewChildAgent(bar.dataset.agentName));
  });
}

// --- Trace span detail sidebar ---
let spanSidebar = null;
function ensureSpanSidebar() {
  if (spanSidebar) return spanSidebar;
  spanSidebar = document.createElement('aside');
  spanSidebar.className = 'span-sidebar';
  spanSidebar.hidden = true;
  document.body.appendChild(spanSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !spanSidebar.hidden) closeSpanSidebar();
  });
  return spanSidebar;
}

function closeSpanSidebar() {
  if (spanSidebar) spanSidebar.hidden = true;
}

// Text of a Claude-style tool_result content part (string / part array / plain text)
function toolResultPartText(part) {
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) {
    return part.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n');
  }
  return part.text || '';
}

// Locate the arguments + paired result for a tool span by toolCallId
function findSpanToolData(toolCallId, msgs) {
  let args = null;
  let hasArgs = false;
  let result = null;
  if (!toolCallId) return { args, hasArgs, result };
  for (const m of msgs) {
    if (m.role === 'toolCall' && m.toolCallId === toolCallId && m.details != null) {
      args = m.details;
      hasArgs = true;
    }
    if (m.role === 'toolResult' && m.toolCallId === toolCallId) {
      result = { text: getTextContent(m.content || []) };
    }
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id === toolCallId) {
        args = c.arguments ?? c.input ?? null;
        hasArgs = args != null;
      }
      if (c.type === 'tool_result' && c.tool_use_id === toolCallId) {
        result = { text: toolResultPartText(c) };
      }
    }
  }
  return { args, hasArgs, result };
}

function openSpanSidebar(span) {
  const el = ensureSpanSidebar();
  const msgs = state.sessionData?.messages || [];
  const durText = formatDurationCompact(span.end - span.start);
  const isTool = span.kind === 'tool' || span.kind === 'tool-error';
  const icon = isTool ? '🔧' : '🤖';
  const clamp = (html, len) => `
        <div class="prompt-text${len > 600 ? ' clamped' : ''}">${html}</div>
        ${len > 600 ? '<span class="show-more">Show more</span>' : ''}`;

  let bodyHtml = '';
  if (isTool) {
    const { args, hasArgs, result } = findSpanToolData(span.toolCallId, msgs);
    const argsJson = hasArgs ? JSON.stringify(args, null, 2) : '';
    const resultText = result ? (result.text || '').trim() : '';
    bodyHtml = `
          ${span.kind === 'tool-error' ? '<div class="ss-error">❌ 工具执行报错</div>' : ''}
          <div class="ss-section-title">Arguments</div>
          ${argsJson ? clamp(`<pre class="mono ss-pre">${escapeHtml(argsJson)}</pre>`, argsJson.length) : '<div class="ss-empty">无参数数据</div>'}
          <div class="ss-section-title">Result</div>
          ${
            result
              ? clamp(`<pre class="mono ss-pre">${escapeHtml(resultText || '(空输出)')}</pre>`, resultText.length)
              : '<div class="ss-empty">未找到配对的工具结果</div>'
          }`;
  } else {
    const msg = msgs.find((m) => m.id === span.msgId);
    const text = msg ? getTextContent(msg.content || []) : '';
    const usageBadges = Object.entries(msg?.usage || {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `<span class="badge">${escapeHtml(k)}: ${escapeHtml(formatNumber(v))}</span>`)
      .join('');
    bodyHtml = `
          ${msg?.model ? `<div class="ss-section-title">Model</div><span class="badge">🧠 ${escapeHtml(msg.model)}</span>` : ''}
          ${usageBadges ? `<div class="ss-section-title">Tokens</div><div class="token-grid">${usageBadges}</div>` : ''}
          <div class="ss-section-title">回复内容</div>
          ${text ? clamp(renderMarkdown(text), text.length) : '<div class="ss-empty">无文本内容</div>'}`;
  }

  el.innerHTML = `
        <div class="span-sidebar-head">
          <span class="ss-icon">${icon}</span>
          <span class="ss-title" title="${escapeHtml(span.label)}">${escapeHtml(span.label)}</span>
          <span class="ss-head-meta">${escapeHtml(durText)} · ${escapeHtml(new Date(span.start).toLocaleTimeString())}</span>
          <button class="ss-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="span-sidebar-body">${bodyHtml}</div>
        <div class="span-sidebar-foot">${span.msgId ? '<button class="export-btn ss-jump-btn">↪ 跳到消息</button>' : ''}<div style="color:var(--muted);font-size:0.75rem;margin-top:${span.msgId ? '8' : '0'}px">提示：复制恢复命令可在终端接管此会话</div></div>`;
  el.hidden = false;

  el.querySelector('.ss-close').addEventListener('click', closeSpanSidebar);
  el.querySelectorAll('.show-more').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textEl = btn.previousElementSibling;
      const clamped = textEl.classList.toggle('clamped');
      btn.textContent = clamped ? 'Show more' : 'Show less';
    });
  });
  const jumpBtn = el.querySelector('.ss-jump-btn');
  if (jumpBtn)
    jumpBtn.addEventListener('click', () => {
      closeSpanSidebar();
      sessionView = 'messages';
      applySessionView();
      scrollToMessage(span.msgId);
    });
}

function restartRefreshLoop() {
  window.clearInterval(state.refreshTimer);
  // If SSE is active, we don't need the polling loop for the session itself
  // but still poll the session list for new sessions appearing
  if (!state.autoRefresh) return;
  state.refreshTimer = window.setInterval(async () => {
    try {
      await loadSessions(true);
      // Only poll full session reload if SSE is NOT active
      if (!state.sseSource && state.selectedSessionId) {
        await loadSession();
      }
    } catch (error) {
      showError(error.message);
    }
  }, 5000);
}

// ========= SSE real-time tail =========

function closeSse() {
  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }
}

function buildWatchUrl() {
  if (!state.selectedSessionId) return null;
  const dp = dirParam();
  const params = new URLSearchParams();
  params.set('platform', state.platform || 'openclaw');
  params.set('sessionId', state.selectedSessionId);
  if (state.selectedAgent) params.set('agent', state.selectedAgent);
  // Extract dir from dirParam (format: ?dir=X or '')
  if (dp) {
    const m = dp.match(/[?&]dir=([^&]*)/);
    if (m) params.set('dir', decodeURIComponent(m[1]));
  }
  return `/api/watch?${params.toString()}`;
}

function startSse() {
  closeSse();
  if (!state.autoRefresh || !state.selectedSessionId) return;
  const url = buildWatchUrl();
  if (!url) return;

  const es = new EventSource(url);
  state.sseSource = es;

  es.addEventListener('connected', (e) => {
    // SSE connected — server confirmed the file exists and we're watching
    const data = JSON.parse(e.data || '{}');
    const indicator = document.getElementById('sseIndicator');
    if (indicator) {
      indicator.textContent = '🟢 Live';
      indicator.title = `Real-time tail active (${data.messageCount} messages loaded)`;
    }
  });

  es.addEventListener('newMessages', (e) => {
    if (!state.sessionData) return;
    const { messages: newMsgs, session } = JSON.parse(e.data || '{}');
    if (!Array.isArray(newMsgs) || newMsgs.length === 0) return;

    // Append new messages to session data
    state.sessionData.messages.push(...newMsgs);
    if (session) Object.assign(state.sessionData.session || {}, session);

    // Expand visibleUnitCount to show new messages
    state.visibleUnitCount += newMsgs.length + 5;

    // Re-render
    renderSummary();
    renderMessages();

    // Auto-scroll to top if enabled (newest-first)
    if (state.autoScroll) {
      const messages = document.getElementById('messages');
      if (messages) messages.scrollTop = 0;
    }

    // Invalidate session list to refresh sidebar counters
    loadSessions(true).catch(() => {});
  });

  es.addEventListener('error', (e) => {
    const indicator = document.getElementById('sseIndicator');
    if (indicator) {
      indicator.textContent = '🔴 Live';
      indicator.title = 'Real-time connection lost, will retry';
    }
  });

  es.onerror = () => {
    // EventSource auto-reconnects on error — no manual action needed
  };
}

async function refreshAll(preserveSelection) {
  clearError();
  try {
    await loadAgents();
    await loadSessions(preserveSelection);
    await loadSession();
  } catch (error) {
    showError(error.message);
  } finally {
    loading.hidden = true;
  }
}

sessionList.addEventListener('click', async (event) => {
  // Check if clicked on spawn tree link
  const spawnLink = event.target.closest('[data-scroll-spawn-tree]');
  if (spawnLink) {
    const item = spawnLink.closest('.session-item');
    if (item) {
      state.selectedSessionId = item.dataset.sessionId;
      renderSessions();
      await refreshAll(true);
      if (currentView === 'insights') await loadInsights();
      // Scroll to spawn tree section
      const el = document.getElementById('spawnTreeInSummary');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const item = event.target.closest('.session-item');
  if (!item) return;
  state.selectedSessionId = item.dataset.sessionId;
  renderSessions();
  await refreshAll(true);
  if (currentView === 'insights') await loadInsights();
});

sessionSearch.addEventListener('input', () => {
  if (!sessionSearch.value.trim()) closeSearchResults();
  renderSessions();
});

sessionSearch.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = sessionSearch.value.trim();
    if (!q) return;
    await performFullTextSearch(q);
  }
});

function closeSearchResults() {
  searchResults.hidden = true;
  searchResults.innerHTML = '';
  sessionList.style.display = '';
}

// Shared by the sidebar full-text search and the ⌘K dialog
const SEARCH_PLAT_BADGE = {
  openclaw: ['OpenClaw', '#3fb950'],
  codex: ['Codex', '#58a6ff'],
  'claude-code': ['Claude', '#d2a8ff'],
  hermes: ['Hermes', '#f78166'],
  omp: ['OMP', '#ffd33d'],
  dsh: ['DeepSeek', '#4d6bfe'],
};

// Global search across every platform; per-platform dir overrides
function globalSearchParams(q) {
  const params = new URLSearchParams({ q, platform: 'all' });
  if (state.settings.openclawDir) params.set('dirOpenclaw', state.settings.openclawDir);
  if (state.settings.codexDir) params.set('dirCodex', state.settings.codexDir);
  if (state.settings.claudeCodeDir) params.set('dirClaude', state.settings.claudeCodeDir);
  if (state.settings.hermesDir) params.set('dirHermes', state.settings.hermesDir);
  if (state.settings.ompDir) params.set('dirOmp', state.settings.ompDir);
  if (state.settings.dshDir) params.set('dirDsh', state.settings.dshDir);
  return params;
}

function searchHitItemsHtml(results, q) {
  let html = '';
  for (const r of results) {
    const isHistory = !!r.history;
    const shortId = isHistory
      ? (r.project || '').replace(/^\/Users\/[^/]+/, '~')
      : r.sessionId.length > 20
        ? r.sessionId.slice(0, 8) + '\u2026'
        : r.sessionId;
    const [platLabel, platColor] = SEARCH_PLAT_BADGE[r.platform] || [r.platform, 'var(--muted)'];
    for (const m of r.matches) {
      // Highlight the query in snippet
      const escaped = escapeHtml(m.snippet);
      const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      const highlighted = escaped.replace(re, '<mark>$1</mark>');
      const badge = isHistory
        ? '<span class="sr-role" style="color:#d29922">已清理 · 仅输入记录</span>'
        : `<span class="sr-role">${escapeHtml(m.role)}</span>`;
      html += `
            <div class="search-result-item${isHistory ? ' sr-history' : ''}" data-session-id="${escapeHtml(r.sessionId || '')}" data-platform="${escapeHtml(r.platform || '')}" data-agent="${escapeHtml(r.agent || '')}" data-file="${escapeHtml(r.file)}"${isHistory ? ' style="cursor:default;opacity:0.75"' : ''}>
              <div class="sr-session"><span class="sr-role" style="color:${platColor};border:1px solid ${platColor}33;border-radius:4px;padding:0 4px">${escapeHtml(platLabel)}</span> ${escapeHtml(shortId)} ${badge}${m.timestamp ? ` <span class="sr-role">${escapeHtml(new Date(m.timestamp).toLocaleDateString())}</span>` : ''}</div>
              <div class="sr-match">${highlighted}</div>
            </div>`;
    }
  }
  return html;
}

// Open a search hit: switch platform (and OpenClaw agent) when the hit lives elsewhere
async function openSearchHit(sid, plat, agent) {
  if (plat && plat !== state.platform) {
    state.platform = plat;
    state.selectedAgent = agent || '';
    state.selectedSessionId = '';
    state.sessions = [];
    state.filteredSessions = [];
    state.sessionData = null;
    state.navStack = [];
    renderBreadcrumb();
    renderAgents();
    await refreshAll(false);
  } else if (agent && agent !== state.selectedAgent) {
    state.selectedAgent = agent;
    await refreshAll(false);
  }
  const found = state.sessions.find((s) => s.id === sid);
  if (found) {
    state.selectedSessionId = found.id;
    renderSessions();
    scrollSessionIntoView(found.id);
    await loadSession();
  }
}

async function performFullTextSearch(q) {
  searchResults.hidden = false;
  searchResults.innerHTML = '<div class="search-spinner">🔍 Searching…</div>';
  sessionList.style.display = 'none';

  try {
    const res = await fetch(`/api/search?${globalSearchParams(q)}`);
    const results = await res.json();

    if (!results.length) {
      searchResults.innerHTML = `
            <div class="search-header">
              <span>No results for "${escapeHtml(q)}"</span>
              <button class="search-close" onclick="closeSearchResults(); sessionSearch.value=''">✕ Close</button>
            </div>`;
      return;
    }

    searchResults.innerHTML = `
          <div class="search-header">
            <span>🔍 全平台搜索 "${escapeHtml(q)}" — ${results.length} 个会话命中</span>
            <button class="search-close" onclick="closeSearchResults(); sessionSearch.value=''">✕ Close</button>
          </div>${searchHitItemsHtml(results, q)}`;

    searchResults.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const sid = el.dataset.sessionId;
        if (!sid) return; // history-only hit: original session was cleaned up
        const plat = el.dataset.platform;
        const agent = el.dataset.agent;
        closeSearchResults();
        sessionSearch.value = '';
        await openSearchHit(sid, plat, agent);
      });
    });
  } catch (err) {
    searchResults.innerHTML = `<div class="search-header"><span>Search error: ${escapeHtml(err.message)}</span>
          <button class="search-close" onclick="closeSearchResults()">✕ Close</button></div>`;
  }
}
// Make closeSearchResults available from inline onclick
window.closeSearchResults = closeSearchResults;

// --- ⌘K global search dialog ---
const cmdkOverlay = document.getElementById('cmdkOverlay');
const cmdkInput = document.getElementById('cmdkInput');
const cmdkResults = document.getElementById('cmdkResults');
let cmdkTimer = null;
let cmdkSeq = 0;
let cmdkSelected = -1;

function openCmdk() {
  cmdkOverlay.hidden = false;
  cmdkInput.focus();
  cmdkInput.select();
}

function closeCmdk() {
  cmdkOverlay.hidden = true;
}

function cmdkItems() {
  return Array.from(cmdkResults.querySelectorAll('.search-result-item'));
}

function cmdkUpdateSelection(items) {
  items.forEach((el, i) => el.classList.toggle('cmdk-selected', i === cmdkSelected));
  const sel = items[cmdkSelected];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function cmdkOpenItem(el) {
  const sid = el.dataset.sessionId;
  if (!sid) return; // history-only hit: original session was cleaned up
  const plat = el.dataset.platform;
  const agent = el.dataset.agent;
  closeCmdk();
  await openSearchHit(sid, plat, agent);
}

async function cmdkSearch(q) {
  const seq = ++cmdkSeq;
  cmdkSelected = -1;
  if (!q) {
    cmdkResults.innerHTML = '';
    return;
  }
  cmdkResults.innerHTML = '<div class="search-spinner">🔍 Searching…</div>';
  try {
    const res = await fetch(`/api/search?${globalSearchParams(q)}`);
    const results = await res.json();
    if (seq !== cmdkSeq) return; // stale response
    if (!Array.isArray(results) || !results.length) {
      cmdkResults.innerHTML = `<div class="search-header"><span>No results for "${escapeHtml(q)}"</span></div>`;
      return;
    }
    cmdkResults.innerHTML = `
          <div class="search-header"><span>🔍 全平台搜索 "${escapeHtml(q)}" — ${results.length} 个会话命中</span></div>
          ${searchHitItemsHtml(results, q)}`;
    cmdkResults.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => cmdkOpenItem(el));
    });
  } catch (err) {
    if (seq !== cmdkSeq) return;
    cmdkResults.innerHTML = `<div class="search-header"><span>Search error: ${escapeHtml(err.message)}</span></div>`;
  }
}

cmdkInput.addEventListener('input', () => {
  clearTimeout(cmdkTimer);
  cmdkTimer = setTimeout(() => cmdkSearch(cmdkInput.value.trim()), 300);
});

cmdkInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = cmdkItems();
    if (!items.length) return;
    cmdkSelected = e.key === 'ArrowDown' ? Math.min(cmdkSelected + 1, items.length - 1) : Math.max(cmdkSelected - 1, 0);
    cmdkUpdateSelection(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const items = cmdkItems();
    const sel = items[cmdkSelected];
    if (sel) cmdkOpenItem(sel);
  }
});

cmdkOverlay.addEventListener('click', (e) => {
  if (e.target === cmdkOverlay) closeCmdk();
});

document.getElementById('cmdkHint').addEventListener('click', openCmdk);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (cmdkOverlay.hidden) openCmdk();
    else closeCmdk();
  } else if (e.key === 'Escape' && !cmdkOverlay.hidden) {
    closeCmdk();
  }
});

includeArchived.addEventListener('change', async () => {
  state.includeArchived = includeArchived.checked;
  await loadSessions(false);
  await loadSession();
});

autoRefresh.addEventListener('change', () => {
  state.autoRefresh = autoRefresh.checked;
  if (!state.autoRefresh) {
    closeSse();
    const indicator = document.getElementById('sseIndicator');
    if (indicator) indicator.textContent = '';
  } else {
    startSse();
  }
  restartRefreshLoop();
});

autoScroll.addEventListener('change', () => {
  state.autoScroll = autoScroll.checked;
});

document.addEventListener('keydown', async (event) => {
  if (event.target.matches('input, textarea, select')) return;
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const list = state.filteredSessions.length ? state.filteredSessions : state.sessions;
  if (!list.length) return;
  const index = list.findIndex((item) => item.id === state.selectedSessionId);
  const nextIndex = event.key === 'ArrowDown' ? Math.min(index + 1, list.length - 1) : Math.max(index - 1, 0);
  const next = list[nextIndex];
  if (!next || next.id === state.selectedSessionId) return;
  state.selectedSessionId = next.id;
  renderSessions();
  scrollSessionIntoView(next.id);
  await loadSession();
});

async function initialLoad() {
  await refreshAll(false);
  // First run without a stored platform: switch to the first platform that has sessions
  if (!hasStoredPlatform && state.platform === 'openclaw' && state.agents.length === 0) {
    const candidates = [
      ['omp', '/api/omp/sessions', state.settings.ompDir],
      ['claude-code', '/api/claude-code/sessions', state.settings.claudeCodeDir],
      ['codex', '/api/codex/sessions', state.settings.codexDir],
      ['hermes', '/api/hermes/sessions', state.settings.hermesDir],
      ['dsh', '/api/dsh/sessions', state.settings.dshDir],
    ];
    for (const [platform, endpoint, dir] of candidates) {
      let sessions = [];
      try {
        sessions = await fetchJson(endpoint + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
      } catch {
        continue;
      }
      if (Array.isArray(sessions) && sessions.length) {
        state.platform = platform;
        state.selectedAgent = '';
        state.selectedSessionId = '';
        state.sessions = [];
        state.filteredSessions = [];
        state.sessionData = null;
        renderAgents();
        await refreshAll(false);
        break;
      }
    }
  }
  restartRefreshLoop();
}
initialLoad();

// --- Stale-page detection: prompt a reload when the server was updated ---
(() => {
  let bootId = null;
  let notified = false;
  const check = async () => {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return; // old server without the endpoint
      const data = await res.json();
      if (bootId === null) {
        bootId = data.bootId;
        return;
      }
      if (data.bootId !== bootId && !notified) {
        notified = true;
        const bar = document.createElement('div');
        bar.style.cssText =
          'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:300;background:#1f6feb;color:#fff;padding:8px 18px;border-radius:0 0 8px 8px;font-size:0.85rem;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.4)';
        bar.textContent = '🔄 AgentXRay 已更新 — 点击刷新加载新版本';
        bar.addEventListener('click', () => location.reload());
        document.body.appendChild(bar);
      }
    } catch {
      /* server briefly down during restart — keep polling */
    }
  };
  check();
  setInterval(check, 15_000);
  window.addEventListener('focus', check);
})();

// ========== Subagents (omp / claude-code spawned children) ==========
async function loadChildAgents() {
  const section = document.getElementById('agentChildrenSection');
  const list = document.getElementById('agentChildrenList');
  if (!section || !list || !state.selectedSessionId) return;
  try {
    const children = await fetchJson(childrenEndpoint() + dirParam());
    childrenCache = { sid: state.selectedSessionId, platform: state.platform, data: children };
    if (!children.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    list.innerHTML = children
      .map((c) => {
        const label = childAgentLabel(c);
        const tip = [c.title || label, c.agentType].filter(Boolean).join(' · ');
        return `
          <span class="stat-chip child-agent-chip" data-name="${escapeHtml(c.name)}" style="cursor:pointer;margin:2px 6px 2px 0" title="${escapeHtml(tip)} — ${c.messageCount} 条消息，${c.toolCallCount} 次工具调用">
            🤖 ${escapeHtml(label)} <span style="color:var(--muted)">· ${c.messageCount} msg · 🔧 ${c.toolCallCount}</span>
          </span>`;
      })
      .join('');
    list.querySelectorAll('.child-agent-chip').forEach((chip) => {
      chip.addEventListener('click', () => viewChildAgent(chip.dataset.name));
    });
  } catch {
    section.hidden = true;
  }
}

async function viewChildAgent(name) {
  try {
    const payload = await fetchJson(`${childrenEndpoint()}/${encodeURIComponent(name)}` + dirParam());
    state.sessionData = payload;
    childAgentViewing = name; // child trace must not embed sibling agent spans
    state.visibleUnitCount = (payload?.messages?.length || 0) <= 200 ? Infinity : MSG_BATCH_SIZE;
    sessionView = 'messages';
    applySessionView();
    renderMessages();
    const meta = (childrenCache.data || []).find((c) => c.name === name);
    const label = meta ? childAgentLabel(meta) : name;
    const banner = document.createElement('div');
    banner.className = 'prompts-summary';
    banner.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px';
    banner.innerHTML = `\u{1F333} 正在查看子 Agent <b>${escapeHtml(label)}</b> 的执行记录 — <a href="#" style="color:#58a6ff">返回主会话</a>`;
    banner.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      loadSession();
    });
    document.getElementById('messages').prepend(banner);
  } catch (error) {
    showError(error.message);
  }
}

// ========== Spawn Tree (per-session) ==========
async function loadSpawnTree(sessionId) {
  const container = document.getElementById('spawnTreeInSummary');
  if (!container) return;
  if (!sessionId) {
    container.innerHTML = '';
    return;
  }
  // Spawn-tree data comes from OpenClaw agent logs only; other platforms have no spawn map
  if (state.platform !== 'openclaw') {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '<div class="tree-stats">Loading spawn tree...</div>';

  const dir = state.settings.openclawDir || '';
  const url = dir
    ? `/api/spawn-tree/${encodeURIComponent(sessionId)}?dir=${encodeURIComponent(dir)}`
    : `/api/spawn-tree/${encodeURIComponent(sessionId)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    const { node, parent } = data;
    if (!node && !parent) {
      container.innerHTML = '<div class="tree-empty">No spawn relationships for this session.</div>';
      return;
    }

    let html = '';

    // Show parent if this session was spawned by another
    if (parent) {
      html += '<div class="spawn-tree-ancestor">';
      html += '<div class="tree-section-label">⬆ Spawned by</div>';
      html += renderTreeNode(parent, 0, true);
      html += '</div>';
    }

    // Show this session and its children
    if (node) {
      html += renderTreeNode(node, 0, true);
    }

    container.innerHTML = html;

    // Click handlers for cards
    container.querySelectorAll('.tree-card').forEach((card) => {
      card.addEventListener('click', () => {
        const sid = card.dataset.sessionId;
        if (sid === state.selectedSessionId) return;
        const found = state.sessions.find((s) => s.id === sid);
        if (found) {
          state.selectedSessionId = found.id;
          state.sessionId = found.id;
          state.sessionFile = found.file;
          renderSessions();
          scrollSessionIntoView(found.id);
          loadSession();
        }
      });
    });

    // Toggle children
    container.querySelectorAll('.tree-children-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = document.getElementById(btn.dataset.target);
        if (target) {
          target.classList.toggle('collapsed');
          btn.textContent = target.classList.contains('collapsed')
            ? btn.textContent.replace('\u25B8', '\u25BE')
            : btn.textContent.replace('\u25BE', '\u25B8');
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="tree-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTreeNode(node, depth, isRoot) {
  const isRootNode = depth === 0;
  const dotClass = isRootNode ? 'root-dot' : 'child-dot';
  const cardClass = isRootNode ? 'root' : 'child';
  const time = node.timestamp ? formatDate(node.timestamp) : '';
  const task = escapeHtml(truncate(node.task || '(no task)', 80));
  const childCount = node.children ? node.children.length : 0;
  const toggleId = 'tree-children-' + node.id.replace(/[^a-zA-Z0-9_-]/g, '_');

  let html = '<div class="tree-node">';
  html += `<div class="tree-card ${cardClass}" data-session-id="${escapeHtml(node.id)}">`;
  html += '<div class="tree-card-header">';
  html += `<span class="tree-card-agent"><span class="dot ${dotClass}"></span>${escapeHtml(node.agent)}</span>`;
  if (time) html += `<span class="tree-card-time">${time}</span>`;
  html += '</div>';
  html += `<div class="tree-card-task" title="${task}">${task}</div>`;
  html += '<div class="tree-card-meta">';
  html += '<span class="tree-card-link">\u{1F517} Open</span>';
  if (node.label) html += `<span>label: ${escapeHtml(node.label)}</span>`;
  html += '</div></div>';

  if (childCount > 0) {
    const collapsed = depth >= 2 && childCount > 2;
    html += `<div class="tree-children-toggle" data-target="${toggleId}">${collapsed ? '\u25B8' : '\u25BE'} ${childCount} child${childCount > 1 ? 'ren' : ''}</div>`;
    html += `<div class="tree-children${collapsed ? ' collapsed' : ''}" id="${toggleId}">`;
    for (const child of node.children) {
      html += renderTreeNode(child, depth + 1, false);
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}
