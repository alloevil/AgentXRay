// Typed fetchers for every AgentXRay backend endpoint.
// Mirrors public/js/app.js fetch behavior: non-2xx → throw Error(body.error || statusText).

import type {
  BackupResult,
  BackupStatus,
  ChildAgentSummary,
  FabricPatternsData,
  HiddenPromptsData,
  HidePromptsResult,
  ImportFabricResult,
  Insights,
  InstallTarget,
  LibraryData,
  LibraryHistoryData,
  LibraryHistoryEntry,
  LibraryUsageData,
  OtlpExport,
  Platform,
  PromptAnalysis,
  PromptsData,
  RewriteResult,
  SearchResult,
  SessionDetail,
  SessionSummary,
  SpawnLink,
  SpawnTreeResult,
  SuggestNameResult,
  ToolsAudit,
  VersionInfo,
} from './types';
import { DEMO } from '@/demo/flag';
import { demoJson } from '@/demo/router';

/** Per-platform log-directory overrides (settings dialog). Empty string = default. */
export interface DirSettings {
  openclawDir: string;
  codexDir: string;
  claudeCodeDir: string;
  hermesDir: string;
  ompDir: string;
  dshDir: string;
}

type ParamValue = string | number | boolean | undefined | null;

function withParams(path: string, params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (DEMO) return demoJson<T>(url, init);
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

function requestJson<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------- Sessions ----------

export function getAgents(dir?: string): Promise<string[]> {
  return fetchJson(withParams('/api/agents', { dir }));
}

/** List sessions. openclaw requires `agent`; the other platforms ignore it. */
export function getSessions(
  platform: Platform,
  opts: { agent?: string; includeArchived?: boolean; dir?: string } = {}
): Promise<SessionSummary[]> {
  if (platform === 'openclaw') {
    return fetchJson(
      withParams(`/api/agents/${encodeURIComponent(opts.agent || '')}/sessions`, {
        include_archived: opts.includeArchived,
        dir: opts.dir,
      })
    );
  }
  return fetchJson(withParams(`/api/${platform}/sessions`, { dir: opts.dir }));
}

export function getSessionDetail(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionDetail> {
  const base =
    platform === 'openclaw'
      ? `/api/agents/${encodeURIComponent(opts.agent || '')}/sessions`
      : `/api/${platform}/sessions`;
  return fetchJson(withParams(`${base}/${encodeURIComponent(sessionId)}`, { dir: opts.dir }));
}

/** Spawned sub-agents of a session (omp / claude-code only). */
export function getSessionChildren(
  platform: 'omp' | 'claude-code',
  sessionId: string,
  dir?: string
): Promise<ChildAgentSummary[]> {
  return fetchJson(
    withParams(`/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children`, { dir })
  );
}

export function getSessionChild(
  platform: 'omp' | 'claude-code',
  sessionId: string,
  childName: string,
  dir?: string
): Promise<SessionDetail> {
  return fetchJson(
    withParams(
      `/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childName)}`,
      { dir }
    )
  );
}

// ---------- Spawn map / tree ----------

export function getSpawnMap(dir?: string): Promise<SpawnLink[]> {
  return fetchJson(withParams('/api/spawn-map', { dir }));
}

export function getSpawnTree(sessionId: string, dir?: string): Promise<SpawnTreeResult> {
  return fetchJson(withParams(`/api/spawn-tree/${encodeURIComponent(sessionId)}`, { dir }));
}

// ---------- Insights ----------

export function getInsights(opts: { platform: Platform; agent?: string; dir?: string }): Promise<Insights> {
  // Note: legacy app.js passes dirParam() ("?dir=…") as the dir value here — a bug.
  // We pass the raw directory.
  return fetchJson(
    withParams('/api/insights', { platform: opts.platform, agent: opts.agent, dir: opts.dir })
  );
}

// ---------- Prompts ----------

export function getPrompts(opts: { platform: Platform; agent?: string; dir?: string }): Promise<PromptsData> {
  return fetchJson(
    withParams('/api/prompts', { platform: opts.platform, agent: opts.agent, dir: opts.dir })
  );
}

/**
 * Template clustering + attribution + LLM suggestions.
 * `cached: true` probes the persisted analysis only — resolves null on 204/anything but 200.
 * `refresh: true` forces recompute; `skipLlm: true` clusters without Claude suggestions.
 */
export async function getPromptAnalysis(opts: {
  platform: Platform;
  agent?: string;
  dir?: string;
  cached?: boolean;
  refresh?: boolean;
  skipLlm?: boolean;
}): Promise<PromptAnalysis | null> {
  const url = withParams('/api/prompts/analyze', {
    platform: opts.platform,
    agent: opts.agent,
    dir: opts.dir,
    cached: opts.cached,
    refresh: opts.refresh,
    skipLlm: opts.skipLlm,
  });
  if (opts.cached) {
    if (DEMO) return null; // nothing persisted in demo mode
    const resp = await fetch(url);
    if (resp.status !== 200) return null;
    return (await resp.json()) as PromptAnalysis;
  }
  return fetchJson(url);
}

export function rewritePrompt(text: string): Promise<RewriteResult> {
  return requestJson('/api/prompts/rewrite', 'POST', { text });
}

export function getHiddenPrompts(): Promise<HiddenPromptsData> {
  return fetchJson('/api/prompts/hidden');
}

/** Hide one prompt ({text}) or a batch ({texts}, ≤500 per call). */
export function hidePrompts(body: { text: string } | { texts: string[] }): Promise<HidePromptsResult> {
  return requestJson('/api/prompts/hidden', 'POST', body);
}

export function unhidePrompt(hash: string): Promise<{ hidden: number }> {
  return requestJson(`/api/prompts/hidden/${encodeURIComponent(hash)}`, 'DELETE');
}

// ---------- Tools audit ----------

/** Cross-platform tool health check. Resolves null on 204 (cached probe, nothing persisted yet). */
export async function getToolsAudit(opts: {
  dirs?: Partial<DirSettings>;
  refresh?: boolean;
}): Promise<ToolsAudit | null> {
  const url = withParams('/api/tools/audit', {
    platform: 'all',
    dirOpenclaw: opts.dirs?.openclawDir,
    dirCodex: opts.dirs?.codexDir,
    dirClaude: opts.dirs?.claudeCodeDir,
    dirOmp: opts.dirs?.ompDir,
    dirDsh: opts.dirs?.dshDir,
    [opts.refresh ? 'refresh' : 'cached']: true,
  });
  if (DEMO) return null; // no persisted audit in demo mode
  const resp = await fetch(url);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || resp.statusText);
  }
  return (await resp.json()) as ToolsAudit;
}

// ---------- Search ----------

/** Full-text search across every platform (multi-keyword AND), with per-platform dir overrides. */
export function searchSessions(q: string, dirs?: Partial<DirSettings>): Promise<SearchResult[]> {
  return fetchJson(
    withParams('/api/search', {
      q,
      platform: 'all',
      dirOpenclaw: dirs?.openclawDir,
      dirCodex: dirs?.codexDir,
      dirClaude: dirs?.claudeCodeDir,
      dirHermes: dirs?.hermesDir,
      dirOmp: dirs?.ompDir,
      dirDsh: dirs?.dshDir,
    })
  );
}

// ---------- Library ----------

export function getLibrary(): Promise<LibraryData> {
  return fetchJson('/api/library');
}

export function getLibraryUsage(): Promise<LibraryUsageData> {
  return fetchJson('/api/library/usage');
}

export function createLibraryPrompt(body: {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  source?: string;
}): Promise<Record<string, unknown>> {
  return requestJson('/api/library', 'POST', body);
}

export function updateLibraryPrompt(
  name: string,
  body: { newName?: string; content?: string; description?: string; tags?: string[] }
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'PUT', body);
}

export function deleteLibraryPrompt(name: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'DELETE');
}

export function installLibraryPrompt(
  name: string,
  targets: InstallTarget[]
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/install`, 'POST', { targets });
}

export function uninstallLibraryPrompt(
  name: string,
  targets: InstallTarget[]
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/uninstall`, 'POST', { targets });
}

/** Claude-CLI name suggestion; `{ name: null }` when the CLI is unavailable. */
export function suggestLibraryName(text: string): Promise<SuggestNameResult> {
  return requestJson('/api/library/suggest-name', 'POST', { text });
}

export function getFabricPatterns(): Promise<FabricPatternsData> {
  return fetchJson('/api/library/fabric-patterns');
}

export function importFabricPatterns(names: string[]): Promise<ImportFabricResult> {
  return requestJson('/api/library/import-fabric', 'POST', { names });
}

export function getLibraryHistory(name: string): Promise<LibraryHistoryData> {
  return fetchJson(`/api/library/${encodeURIComponent(name)}/history`);
}

export function getLibraryHistoryEntry(name: string, hash: string): Promise<LibraryHistoryEntry> {
  return fetchJson(
    `/api/library/${encodeURIComponent(name)}/history/${encodeURIComponent(hash)}`
  );
}

// ---------- Backup / misc ----------

export function runBackup(): Promise<BackupResult> {
  return requestJson('/api/backup', 'POST');
}

export function getBackupStatus(): Promise<BackupStatus> {
  return fetchJson('/api/backup/status');
}

export function getOtlp(platform: Platform, sessionId: string, dir?: string): Promise<OtlpExport> {
  return fetchJson(
    withParams(
      `/api/otlp/${encodeURIComponent(platform)}/${encodeURIComponent(sessionId)}`,
      { dir }
    )
  );
}

export function getVersion(): Promise<VersionInfo> {
  return fetchJson('/api/version');
}

/** URL for the server-side session export (Markdown / standalone HTML download). */
export function exportUrl(
  platform: Platform,
  sessionId: string,
  format: 'md' | 'html',
  opts: { agent?: string; dir?: string } = {}
): string {
  return withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/export`, {
    format,
    agent: opts.agent,
    dir: opts.dir,
  });
}

/** URL for the real-time tail EventSource (GET /api/watch, SSE — consumed via new EventSource()). */
export function watchUrl(opts: {
  platform: Platform;
  sessionId: string;
  agent?: string;
  dir?: string;
}): string {
  return withParams('/api/watch', {
    platform: opts.platform,
    sessionId: opts.sessionId,
    agent: opts.agent,
    dir: opts.dir,
  });
}
