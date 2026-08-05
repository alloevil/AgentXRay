// One directory group: h3 header (组级全选 checkbox in batch mode) + session
// rows (collapse/expand, id link, preview, count chip, hover 🗑) + prompt rows.
// Checkbox tri-state derives from the selection set — legacy syncSessionCb/syncGroupCb.

import { useEffect, useState } from 'react';

import type { PromptEntry, PromptGroup, PromptSession } from '@/api/types';
import { cn } from '@/lib/utils';

import { PromptItemRow } from './PromptItemRow';
import { TriCheckbox } from './TriCheckbox';
import { groupKeys, promptKey, sessionKeys } from './promptsLib';

function triState(keys: string[], selection: Set<string>): boolean | 'indeterminate' {
  let checked = 0;
  for (const key of keys) if (selection.has(key)) checked++;
  if (checked === 0) return false;
  return checked === keys.length ? true : 'indeterminate';
}

interface PromptGroupSectionProps {
  group: PromptGroup;
  gi: number;
  /** searching expands every session by default (legacy `expanded = !!q`) */
  searchActive: boolean;
  selectMode: boolean;
  selection: Set<string>;
  onToggleKeys: (keys: string[], on: boolean) => void;
  onHideSession: (session: PromptSession) => void;
  onHidePrompt: (prompt: PromptEntry) => void;
  hidePending: boolean;
  onStarPrompt: (prompt: PromptEntry) => void;
  onOpenSession: (sessionId: string) => void;
}

export function PromptGroupSection({
  group,
  gi,
  searchActive,
  selectMode,
  selection,
  onToggleKeys,
  onHideSession,
  onHidePrompt,
  hidePending,
  onStarPrompt,
  onOpenSession,
}: PromptGroupSectionProps) {
  // Expansion: per-session override on top of the search-driven default.
  const [openOverrides, setOpenOverrides] = useState<Record<number, boolean>>({});
  useEffect(() => setOpenOverrides({}), [searchActive, group]);

  const allGroupKeys = groupKeys(gi, group);
  const groupPromptCount = group.sessions.reduce((m, s) => m + s.promptCount, 0);

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {selectMode && (
          <TriCheckbox
            checked={triState(allGroupKeys, selection)}
            onCheckedChange={(on) => onToggleKeys(allGroupKeys, on)}
            title="选择本组（目录）全部 prompt"
          />
        )}
        <span className="break-all">{group.directory}</span>
        <span className="font-normal text-muted-foreground">
          — {group.sessions.length} sessions / {groupPromptCount} prompts
        </span>
      </h3>

      <div className="space-y-2">
        {group.sessions.map((s, si) => {
          const expanded = openOverrides[si] ?? searchActive;
          const skeys = sessionKeys(gi, si, s);
          const dateStr = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
          return (
            <div key={s.id} className="rounded-md border border-border/70">
              <div
                className="group/session flex cursor-pointer select-none flex-wrap items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent/40"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button, input, a, [data-session-link]')) return;
                  setOpenOverrides((prev) => ({ ...prev, [si]: !expanded }));
                }}
              >
                {selectMode && (
                  <TriCheckbox
                    checked={triState(skeys, selection)}
                    onCheckedChange={(on) => onToggleKeys(skeys, on)}
                    title="选择本 session 全部 prompt"
                  />
                )}
                <span className="text-muted-foreground">{expanded ? '▼' : '▶'}</span>
                <span className="text-muted-foreground">{dateStr}</span>
                <span
                  data-session-link
                  className="cursor-pointer font-mono text-primary hover:underline"
                  title="Open session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSession(s.id);
                  }}
                >
                  {s.id.slice(0, 12)}…
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-foreground/80"
                  title={s.prompts[0].text.slice(0, 500)}
                >
                  {s.prompts[0].text.replace(/\s+/g, ' ').slice(0, 160)}
                </span>
                {s.slug && <span className="text-muted-foreground">{s.slug}</span>}
                {s.title && <span className="text-muted-foreground">{s.title}</span>}
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  {s.promptCount} prompt{s.promptCount > 1 ? 's' : ''}
                </span>
                {!selectMode && (
                  <button
                    className={cn(
                      'rounded px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-destructive/20',
                      'group-hover/session:opacity-100'
                    )}
                    title="隐藏本 session 全部 prompt"
                    disabled={hidePending}
                    onClick={(e) => {
                      e.stopPropagation();
                      onHideSession(s);
                    }}
                  >
                    🗑
                  </button>
                )}
              </div>
              {expanded && (
                <div className="space-y-2 border-t border-border/70 p-2">
                  {s.prompts.map((p, pi) => {
                    const key = promptKey(gi, si, pi);
                    return (
                      <PromptItemRow
                        key={key}
                        prompt={p}
                        selectMode={selectMode}
                        selected={selection.has(key)}
                        onToggleSelected={(on) => onToggleKeys([key], on)}
                        onHide={() => onHidePrompt(p)}
                        hidePending={hidePending}
                        onStar={() => onStarPrompt(p)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
