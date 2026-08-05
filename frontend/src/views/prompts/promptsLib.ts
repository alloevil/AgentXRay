// Prompts-view helpers ported from public/js/app.js — filtering/selection
// algorithms unchanged (renderPrompts + hidePromptTexts).

import { hidePrompts } from '@/api/client';
import type { PromptGroup, PromptSession, PromptsData } from '@/api/types';

/** app.js promptsMatchesSearch — id/slug/title/prompt-text substring match. */
export function promptsMatchesSearch(session: PromptSession, q: string): boolean {
  if (!q) return true;
  if (session.id.toLowerCase().includes(q)) return true;
  if ((session.slug || '').toLowerCase().includes(q)) return true;
  if ((session.title || '').toLowerCase().includes(q)) return true;
  return session.prompts.some((p) => p.text.toLowerCase().includes(q));
}

export interface FilteredPrompts {
  groups: PromptGroup[];
  /** trivial filter in effect (never while searching) */
  trivialActive: boolean;
  /** prompts dropped by the trivial filter */
  trivialHidden: number;
  shownSessions: number;
  shownPrompts: number;
}

/**
 * Search filter + trivial-prompt filter (< 12 chars whitespace-collapsed),
 * exactly as legacy renderPrompts computes its `groups` closure.
 * Trivial filter auto-disables while searching.
 */
export function filterPromptGroups(data: PromptsData, search: string, hideTrivial: boolean): FilteredPrompts {
  const q = search.trim().toLowerCase();
  let groups = data.groups
    .map((g) => ({
      ...g,
      sessions: g.sessions.filter((s) => promptsMatchesSearch(s, q) || g.directory.toLowerCase().includes(q)),
    }))
    .filter((g) => g.sessions.length > 0);

  const trivialActive = !q && hideTrivial;
  let trivialHidden = 0;
  if (trivialActive) {
    groups = groups
      .map((g) => ({
        ...g,
        sessions: g.sessions
          .map((s) => {
            const kept = s.prompts.filter((p) => p.text.replace(/\s+/g, ' ').trim().length >= 12);
            trivialHidden += s.prompts.length - kept.length;
            return kept.length === s.prompts.length ? s : { ...s, prompts: kept, promptCount: kept.length };
          })
          .filter((s) => s.prompts.length > 0),
      }))
      .filter((g) => g.sessions.length > 0);
  }

  const shownSessions = groups.reduce((n, g) => n + g.sessions.length, 0);
  const shownPrompts = groups.reduce((n, g) => n + g.sessions.reduce((m, s) => m + s.promptCount, 0), 0);
  return { groups, trivialActive, trivialHidden, shownSessions, shownPrompts };
}

// Selection keys — "gi:si:pi" against the *filtered* groups, like legacy.
export function promptKey(gi: number, si: number, pi: number): string {
  return `${gi}:${si}:${pi}`;
}

export function sessionKeys(gi: number, si: number, session: PromptSession): string[] {
  return session.prompts.map((_, pi) => promptKey(gi, si, pi));
}

export function groupKeys(gi: number, group: PromptGroup): string[] {
  return group.sessions.flatMap((s, si) => sessionKeys(gi, si, s));
}

/** Resolve selected keys back to prompt texts against the filtered groups. */
export function selectionTexts(selection: Set<string>, groups: PromptGroup[]): string[] {
  const texts: string[] = [];
  for (const key of selection) {
    const [gi, si, pi] = key.split(':').map(Number);
    const p = groups[gi]?.sessions[si]?.prompts[pi];
    if (p) texts.push(p.text);
  }
  return texts;
}

/** Batch-hide helper: dedupes texts and chunks POSTs at 500 per request (backend limit). */
export async function hidePromptTextsChunked(texts: string[]): Promise<void> {
  const unique = [...new Set(texts)];
  for (let i = 0; i < unique.length; i += 500) {
    await hidePrompts({ texts: unique.slice(i, i + 500) });
  }
}

/** Client-side JSON download, same as legacy 导出 JSON. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
