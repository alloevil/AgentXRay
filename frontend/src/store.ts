import { create } from 'zustand';
import type { DirSettings } from '@/api/client';
import type { Platform } from '@/api/types';
import { PLATFORMS } from '@/api/types';
import { DEMO } from '@/demo/flag';

// Settings persist to the SAME localStorage key/shape as the legacy app
// (public/js/app.js SETTINGS_KEY) so both UIs share settings:
//   { openclawDir, codexDir, claudeCodeDir, hermesDir, ompDir, platform }
export const SETTINGS_KEY = 'agent-xray-settings';

// Legacy per-view flags, reused as-is ('1'/'0' strings, default true when absent).
export const SUMMARY_COLLAPSED_KEY = 'axr-summary-collapsed';
export const HIDE_TRIVIAL_KEY = 'axr-hide-trivial';
export const LIB_SORT_KEY = 'axr-lib-sort';

export function loadStoredFlag(key: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw !== '0';
  } catch {
    return fallback;
  }
}

export function saveStoredFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode etc. — non-fatal */
  }
}

export const EMPTY_SETTINGS: DirSettings = {
  openclawDir: '',
  codexDir: '',
  claudeCodeDir: '',
  hermesDir: '',
  ompDir: '',
  dshDir: '',
};

export function dirForPlatform(settings: DirSettings, platform: Platform): string {
  switch (platform) {
    case 'openclaw':
      return settings.openclawDir;
    case 'codex':
      return settings.codexDir;
    case 'claude-code':
      return settings.claudeCodeDir;
    case 'hermes':
      return settings.hermesDir;
    case 'omp':
      return settings.ompDir;
    case 'dsh':
      return settings.dshDir;
  }
}

function loadPersisted(): { settings: DirSettings; platform: Platform; hasStoredPlatform: boolean } {
  // Demo build ships claude-code/codex fixtures only — land on a populated tab.
  const defaultPlatform: Platform = DEMO ? 'claude-code' : 'openclaw';
  const result: { settings: DirSettings; platform: Platform; hasStoredPlatform: boolean } = {
    settings: { ...EMPTY_SETTINGS },
    platform: defaultPlatform,
    hasStoredPlatform: false,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      result.settings.openclawDir = typeof parsed.openclawDir === 'string' ? parsed.openclawDir : '';
      result.settings.codexDir = typeof parsed.codexDir === 'string' ? parsed.codexDir : '';
      result.settings.claudeCodeDir = typeof parsed.claudeCodeDir === 'string' ? parsed.claudeCodeDir : '';
      result.settings.hermesDir = typeof parsed.hermesDir === 'string' ? parsed.hermesDir : '';
      result.settings.ompDir = typeof parsed.ompDir === 'string' ? parsed.ompDir : '';
      result.settings.dshDir = typeof parsed.dshDir === 'string' ? parsed.dshDir : '';
      if (PLATFORMS.includes(parsed.platform as Platform)) {
        result.platform = parsed.platform as Platform;
        result.hasStoredPlatform = true;
      }
    }
  } catch {
    /* corrupted storage — fall back to defaults */
  }
  return result;
}

function persist(settings: DirSettings, platform: Platform): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, platform }));
  } catch {
    /* non-fatal */
  }
}

export type MainView = 'sessions' | 'insights' | 'prompts' | 'library';
export type InsightsScope = 'global' | 'session';
export type SessionView = 'messages' | 'trace';

/** Prefill payload for the library create/edit form (LibraryFormDialog, views/library/). */
export interface LibraryFormPrefill {
  name?: string;
  description?: string;
  tags?: string[];
  content?: string;
  source?: string;
  /** Fired once after a successful non-edit save (legacy libraryFormOnSaved). */
  onSaved?: () => void;
}

export interface LibraryFormState {
  open: boolean;
  /** Original name when editing an existing prompt; null = create. */
  editingName: string | null;
  prefill: LibraryFormPrefill | null;
  /** Bumped on every open — invalidates in-flight suggest-name responses (legacy seq). */
  openSeq: number;
}

interface AppState {
  platform: Platform;
  /** true when the persisted settings carried an explicit platform (skip auto-pick on boot) */
  hasStoredPlatform: boolean;
  selectedAgent: string; // openclaw only
  selectedSessionId: string;
  includeArchived: boolean;
  settings: DirSettings;
  view: MainView;
  /** null = not entered 分析 yet; auto-picked on first entry, then sticky */
  insightsScope: InsightsScope | null;
  sessionView: SessionView;
  /** Child-agent transcript being viewed (omp/claude-code spawned subagent name), null = parent session. */
  viewingChildAgent: string | null;
  /** Library create/edit form dialog — opened cross-view via openLibraryForm (⭐收藏 / 入库). */
  libraryForm: LibraryFormState;
  /** One-shot cross-view jump target: SessionsView consumes it (expand pagination, clear filter, flash). */
  pendingScrollMsgId: string | null;
  /** Sidebar toggles (sessions view): 5s list polling + SSE tail / scroll-to-top on new messages. */
  autoRefresh: boolean;
  autoScroll: boolean;

  setPlatform: (platform: Platform) => void;
  setSelectedAgent: (agent: string) => void;
  setSelectedSessionId: (id: string) => void;
  setIncludeArchived: (value: boolean) => void;
  saveSettings: (settings: DirSettings) => void;
  setView: (view: MainView) => void;
  setInsightsScope: (scope: InsightsScope) => void;
  setSessionView: (view: SessionView) => void;
  setViewingChildAgent: (name: string | null) => void;
  openLibraryForm: (prefill?: LibraryFormPrefill | null, isEdit?: boolean) => void;
  closeLibraryForm: () => void;
  /** Cross-view jump-to-message: lands on 会话 view, messages sub-view; SessionsView scrolls + clears. */
  requestScrollToMessage: (id: string) => void;
  clearPendingScrollMsgId: () => void;
  setAutoRefresh: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
}

const initial = loadPersisted();

export const useAppStore = create<AppState>((set, get) => ({
  platform: initial.platform,
  hasStoredPlatform: initial.hasStoredPlatform,
  selectedAgent: '',
  selectedSessionId: '',
  includeArchived: false,
  settings: initial.settings,
  view: 'sessions',
  insightsScope: null,
  sessionView: 'messages',
  viewingChildAgent: null,
  libraryForm: { open: false, editingName: null, prefill: null, openSeq: 0 },
  pendingScrollMsgId: null,
  autoRefresh: true,
  autoScroll: false,

  setPlatform: (platform) => {
    if (platform === get().platform) return;
    persist(get().settings, platform);
    // Mirrors legacy platform switch: clear agent/session selection.
    set({
      platform,
      hasStoredPlatform: true,
      selectedAgent: '',
      selectedSessionId: '',
      sessionView: 'messages',
      viewingChildAgent: null,
    });
  },
  setSelectedAgent: (agent) => set({ selectedAgent: agent, selectedSessionId: '', viewingChildAgent: null }),
  setSelectedSessionId: (id) => set({ selectedSessionId: id, viewingChildAgent: null }),
  setIncludeArchived: (value) => set({ includeArchived: value }),
  saveSettings: (settings) => {
    persist(settings, get().platform);
    set({ settings });
  },
  setView: (view) => set({ view }),
  setInsightsScope: (scope) => set({ insightsScope: scope }),
  setSessionView: (view) => set({ sessionView: view }),
  // Opening a child transcript lands on messages (legacy viewChildAgent forces sessionView='messages')
  setViewingChildAgent: (name) =>
    set(name ? { viewingChildAgent: name, sessionView: 'messages' } : { viewingChildAgent: null }),
  openLibraryForm: (prefill = null, isEdit = false) =>
    set((s) => ({
      libraryForm: {
        open: true,
        editingName: isEdit && prefill?.name ? prefill.name : null,
        prefill,
        openSeq: s.libraryForm.openSeq + 1,
      },
    })),
  closeLibraryForm: () => set((s) => ({ libraryForm: { ...s.libraryForm, open: false } })),
  requestScrollToMessage: (id) =>
    set({ view: 'sessions', sessionView: 'messages', pendingScrollMsgId: id }),
  clearPendingScrollMsgId: () => set({ pendingScrollMsgId: null }),
  setAutoRefresh: (value) => set({ autoRefresh: value }),
  setAutoScroll: (value) => set({ autoScroll: value }),
}));
