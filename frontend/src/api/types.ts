// API response types for the AgentXRay backend (server.js on :3800).
// Typed from real responses sampled via curl + the legacy UI's field usage
// (public/js/app.js). Open/evolving shapes carry index signatures.

export type Platform = 'openclaw' | 'codex' | 'claude-code' | 'hermes' | 'omp' | 'dsh' | 'gemini';

export const PLATFORMS: Platform[] = ['openclaw', 'codex', 'claude-code', 'hermes', 'omp', 'dsh', 'gemini'];

export const PLATFORM_LABELS: Record<Platform, string> = {
  openclaw: 'OpenClaw',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes',
  omp: 'OMP',
  dsh: 'DeepSeek Harness',
  gemini: 'Gemini CLI',
};

// ---------- Sessions ----------

export interface TopTool {
  name: string;
  count: number;
}

/** Item of GET /api/{codex,claude-code,hermes,omp}/sessions and /api/agents/:name/sessions */
export interface SessionSummary {
  id: string;
  timestamp: string;
  lastActivity: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  topTools: TopTool[];
  firstUserMessage: string;
  file: string;
  title?: string | null;
  cwd?: string | null;
  slug?: string | null;
  /** openclaw extras (legacy sessionCardHtml): status badge, spawn chip, source chip, model chip */
  status?: string | null;
  model?: string | null;
  source?: string | null;
  spawnCount?: number | null;
  [key: string]: unknown;
}

/** One entry of a normalized message's `content` array. */
export interface MessageContentPart {
  type: string; // 'text' | 'toolCall' | 'tool_use' | 'tool_result' | …
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** toolCall parts carry parsed arguments (legacy renderToolCall reads item.arguments) */
  arguments?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** number on some platforms; omp emits an object with per-bucket dollars + total */
  cost?: number | { total?: number; [key: string]: unknown } | null;
  totalTokens?: number;
  [key: string]: unknown;
}

/** Normalized message (all platforms are normalized server-side to this shape). */
export interface SessionMessage {
  id: string;
  timestamp: string | null;
  role: string; // 'user' | 'assistant' | 'reasoning' | 'toolCall' | 'toolResult' | 'developer' | …
  content: MessageContentPart[] | null;
  usage: MessageUsage | null;
  model: string | null;
  provider: string | null;
  toolCallId: string | null;
  toolName: string | null;
  details: Record<string, unknown> | null;
  isError: boolean;
  /** some platforms attach reasoning text directly on the assistant record */
  reasoning?: string | null;
  [key: string]: unknown;
}

export interface SessionMeta {
  id: string;
  cwd?: string | null;
  timestamp?: string | null;
  version?: number;
  model?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

/** GET /api/<platform>/sessions/:id (and children/:name) */
export interface SessionDetail {
  session: SessionMeta;
  messages: SessionMessage[];
}

/** Item of GET /api/{omp,claude-code}/sessions/:id/children */
export interface ChildAgentSummary {
  name: string;
  messageCount: number;
  toolCallCount: number;
  timestamp?: string | null;
  lastActivity?: string | null;
  file?: string | null;
  title?: string | null;
  agentType?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

// ---------- Spawn map / tree ----------

/** Item of GET /api/spawn-map (openclaw spawn relationships) */
export interface SpawnLink {
  parentAgent: string;
  parentSession: string;
  toolCallId?: string;
  toolName: string;
  childAgent: string;
  childLabel: string | null;
  task: string;
  timestamp?: string;
  isExecSpawn?: boolean;
  [key: string]: unknown;
}

export interface SpawnTreeNode {
  id: string;
  children?: SpawnTreeNode[];
  [key: string]: unknown;
}

/** GET /api/spawn-tree/:sessionId */
export interface SpawnTreeResult {
  node: SpawnTreeNode | null;
  parent: SpawnTreeNode | null;
  totalSessions?: number;
  totalSpawnCalls?: number;
  matchedLinks?: number;
  [key: string]: unknown;
}

// ---------- Insights ----------

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number | null;
}

export interface ErrorClusterExample {
  sessionId: string;
  toolName: string | null;
  snippet: string;
  messageId: string | null;
  timestamp: string | null;
}

export interface ErrorCluster {
  pattern: string;
  count: number;
  examples: ErrorClusterExample[];
}

export interface TrendPoint {
  date: string;
  sessions: number;
  errors: number;
  toolCalls: number;
  cost: number;
}

/** GET /api/insights */
export interface Insights {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  totalCost: number;
  errorRate: number;
  tokenUsage: { input?: number; output?: number; cacheRead?: number; [key: string]: number | undefined };
  toolStats: ToolStat[];
  errorClusters: ErrorCluster[];
  trend: TrendPoint[];
  [key: string]: unknown;
}

// ---------- Prompts ----------

export interface PromptEntry {
  text: string;
  timestamp: string | null;
}

export interface PromptSession {
  id: string;
  file: string;
  slug?: string | null;
  title?: string | null;
  timestamp: string;
  lastActivity: string;
  promptCount: number;
  prompts: PromptEntry[];
}

export interface PromptGroup {
  directory: string;
  promptCount: number;
  sessionCount: number;
  sessions: PromptSession[];
}

/** GET /api/prompts */
export interface PromptsData {
  platform: string;
  totalPrompts: number;
  totalSessions: number;
  groups: PromptGroup[];
}

export interface ClusterSuggestion {
  assessment?: string;
  issues?: string[];
  rationale?: string;
  rewrite?: string;
  [key: string]: unknown;
}

export interface PromptCluster {
  pattern: string;
  count: number;
  avgLength: number;
  topic?: string | null;
  directories: string[];
  sessionIds: string[];
  samples: string[];
  errorSamples?: string[];
  attribution?: {
    sampledSessions?: number;
    avgMessages?: number;
    avgToolCalls?: number;
    errorRate?: number;
    avgOutputTokens?: number;
    [key: string]: number | undefined;
  } | null;
  suggestion?: ClusterSuggestion | null;
  [key: string]: unknown;
}

export interface TopicStat {
  topic: string;
  clusters: number;
  prompts: number;
}

export interface WeeklyTrendPoint {
  week: string;
  total: number;
  topics: Record<string, number>;
}

/** GET /api/prompts/analyze */
export interface PromptAnalysis {
  platform: string;
  clusters: PromptCluster[];
  overall: string[];
  topics?: TopicStat[];
  weeklyTrend?: WeeklyTrendPoint[];
  totalClusters?: number;
  totalPrompts?: number;
  generatedAt?: string;
  persisted?: boolean;
  llmError?: string | null;
  [key: string]: unknown;
}

/** POST /api/prompts/rewrite */
export interface RewriteResult {
  rewrite: string;
  rationale: string | null;
  /** true when the CLI output could not be parsed as JSON and is passed through raw */
  raw?: boolean;
}

export interface HiddenPrompt {
  hash: string;
  preview: string;
  hiddenAt: string;
}

/** GET /api/prompts/hidden */
export interface HiddenPromptsData {
  hidden: HiddenPrompt[];
}

/** POST /api/prompts/hidden */
export interface HidePromptsResult {
  hash: string;
  hashes: string[];
  added: number;
  hidden: number;
}

// ---------- Tools audit ----------

export interface ToolAuditEntry {
  name: string;
  platforms: string[];
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number | null;
  lastUsed: string | null;
  sessions: number;
  [key: string]: unknown;
}

/** GET /api/tools/audit (204 → null: no persisted audit yet) */
export interface ToolsAudit {
  generatedAt: string;
  persisted: boolean;
  tools: ToolAuditEntry[];
  configuredUnused: { name: string; source?: string | null }[];
  [key: string]: unknown;
}

// ---------- Search ----------

export interface SearchMatch {
  role: string;
  snippet: string;
  timestamp: string | null;
}

/** Item of GET /api/search */
export interface SearchResult {
  sessionId: string;
  file: string;
  platform: string;
  matches: SearchMatch[];
  agent?: string;
  /** true → a Claude-cleaned history entry: display-only, not clickable */
  history?: boolean;
  project?: string;
  [key: string]: unknown;
}

// ---------- Library ----------

export type InstallTarget = 'claude' | 'codex' | 'omp';

export interface LibraryPrompt {
  name: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: string;
  source?: string;
  installed: Record<InstallTarget, boolean>;
  [key: string]: unknown;
}

/** GET /api/library */
export interface LibraryData {
  prompts: LibraryPrompt[];
}

export interface LibraryUsageEntry {
  uses: number;
  avgMessages: number | null;
  errorRate: number | null;
  lastUsed: string | null;
}

/** GET /api/library/usage */
export interface LibraryUsageData {
  usage: Record<string, LibraryUsageEntry>;
}

/** POST /api/library/suggest-name */
export interface SuggestNameResult {
  name: string | null;
}

export interface FabricPattern {
  name: string;
  imported: boolean;
}

/** GET /api/library/fabric-patterns */
export interface FabricPatternsData {
  patterns: FabricPattern[];
}

/** POST /api/library/import-fabric */
export interface ImportFabricResult {
  imported: string[];
  skipped: string[];
  failed: string[];
}

export interface LibraryCommit {
  hash: string;
  date: string;
  message: string;
}

/** GET /api/library/:name/history */
export interface LibraryHistoryData {
  commits: LibraryCommit[];
}

/** GET /api/library/:name/history/:hash */
export interface LibraryHistoryEntry {
  content: string;
  description?: string | null;
  tags?: string[];
}

// ---------- Backup / misc ----------

/** GET /api/backup/status */
export interface BackupStatus {
  archiveDir: string;
  files: number;
  bytes: number;
  lastBackup: string | null;
}

/** POST /api/backup */
export interface BackupResult {
  copied: number;
  skipped: number;
  [key: string]: unknown;
}

/** GET /api/version */
export interface VersionInfo {
  bootId: string;
}

/** GET /api/otlp/:platform/:sessionId — OTLP/JSON export */
export interface OtlpExport {
  resourceSpans: unknown[];
}
