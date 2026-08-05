// ⌘K global search dialog — legacy cmdkOverlay parity: 300ms debounce,
// /api/search platform=all with dir overrides, platform color badges,
// history-only hits non-clickable, ↑↓/Enter nav, cross-platform jump landing
// on the matched message via requestScrollToMessage.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { searchSessions } from '@/api/client';
import type { Platform, SearchMatch, SearchResult, SessionMessage } from '@/api/types';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getTextContent, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { sessionDetailOptions, sessionsListOptions } from './queries';
import { isDisplayableMessage, messageAnchorId } from './lib';
const PLAT_BADGE: Record<string, [string, string]> = {
  openclaw: ['OpenClaw', '#3fb950'],
  codex: ['Codex', '#58a6ff'],
  'claude-code': ['Claude', '#d2a8ff'],
  hermes: ['Hermes', '#f78166'],
  omp: ['OMP', '#ffd33d'],
};

interface HitRow {
  result: SearchResult;
  match: SearchMatch;
  clickable: boolean;
}

function Highlighted({ text, q }: { text: string; q: string }) {
  const kw = q.trim().split(/\s+/)[0];
  if (!kw) return <>{text}</>;
  const parts = text.split(new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary/30 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// Land on a message: prefer the record with the hit's timestamp, else first
// displayable message containing the first keyword.
function locateTargetMessage(messages: SessionMessage[], q: string, match: SearchMatch | null): string | null {
  const visible = messages.filter(isDisplayableMessage);
  const hitTs = match ? parseTimestampMs(match.timestamp) : null;
  if (hitTs !== null) {
    const byTs = visible.find((m) => parseTimestampMs(m.timestamp) === hitTs);
    if (byTs) return messageAnchorId(byTs);
  }
  const kw = q.trim().toLowerCase().split(/\s+/)[0];
  if (kw) {
    const byText = visible.find((m) => getTextContent(m.content).toLowerCase().includes(kw));
    if (byText) return messageAnchorId(byText);
  }
  return null;
}

export function CmdkDialog({
  open,
  onOpenChange,
  seedQuery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seedQuery: string;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<HitRow[] | null>(null);
  const [hitCount, setHitCount] = useState(0);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(-1);
  const seqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const runSearch = async (q: string) => {
    const seq = ++seqRef.current;
    setSelected(-1);
    if (!q) {
      setRows(null);
      setHitCount(0);
      return;
    }
    setSearching(true);
    try {
      const settings = useAppStore.getState().settings;
      const results = await searchSessions(q, settings);
      if (seq !== seqRef.current) return; // stale response
      setHitCount(results.length);
      setRows(
        results.flatMap((result) =>
          result.matches.map((match) => ({ result, match, clickable: !result.history && !!result.sessionId }))
        )
      );
    } catch (err) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setHitCount(0);
      toast.error('搜索失败: ' + (err as Error).message);
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  };

  // Seed on open (sidebar Enter → immediate search); reset on close
  useEffect(() => {
    if (open) {
      setQuery(seedQuery);
      if (seedQuery) void runSearch(seedQuery);
    } else {
      window.clearTimeout(timerRef.current);
      seqRef.current++;
      setQuery('');
      setRows(null);
      setHitCount(0);
      setSelected(-1);
      setSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onInput = (value: string) => {
    setQuery(value);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void runSearch(value.trim()), 300);
  };

  const openHit = async (row: HitRow) => {
    if (!row.clickable) return; // history-only hit: original session was cleaned up
    onOpenChange(false);
    const store = useAppStore.getState();
    const plat = row.result.platform as Platform;
    const agent = row.result.agent || '';
    if (plat !== store.platform) store.setPlatform(plat);
    if (agent && agent !== useAppStore.getState().selectedAgent) store.setSelectedAgent(agent);
    store.setView('sessions');
    try {
      const scope = { platform: plat, agent, includeArchived: store.includeArchived, settings: store.settings };
      const list = await queryClient.fetchQuery(sessionsListOptions(scope));
      const found = list.find((s) => s.id === row.result.sessionId);
      if (!found) {
        toast.error('会话不在当前列表中（可能已归档或被清理）');
        return;
      }
      store.setSelectedSessionId(found.id);
      const detail = await queryClient.fetchQuery(
        sessionDetailOptions({ platform: plat, sessionId: found.id, agent, settings: store.settings })
      );
      const target = locateTargetMessage(detail.messages, query, row.match);
      if (target) store.requestScrollToMessage(target);
    } catch (err) {
      toast.error('打开会话失败: ' + (err as Error).message);
    }
  };

  const clickableIndexes = (rows ?? []).map((r, i) => (r.clickable ? i : -1)).filter((i) => i >= 0);
  const moveSelection = (dir: 1 | -1) => {
    if (!clickableIndexes.length) return;
    const pos = clickableIndexes.indexOf(selected);
    const nextPos = dir === 1 ? Math.min(pos + 1, clickableIndexes.length - 1) : Math.max(pos - 1, 0);
    const next = clickableIndexes[nextPos];
    setSelected(next);
    listRef.current?.querySelector(`[data-row-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">全局搜索</DialogTitle>
        <input
          autoFocus
          value={query}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              moveSelection(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = rows?.[selected];
              if (row) void openHit(row);
            }
          }}
          placeholder="搜索所有平台的会话内容… 空格分隔多关键词，全部命中才返回"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
          {searching && <div className="px-3 py-4 text-sm text-muted-foreground">🔍 Searching…</div>}
          {!searching && rows !== null && rows.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground">No results for "{query}"</div>
          )}
          {!searching && rows !== null && rows.length > 0 && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              🔍 全平台搜索 "{query}" — {hitCount} 个会话命中
            </div>
          )}
          {!searching &&
            rows?.map((row, i) => {
              const { result, match } = row;
              const [platLabel, platColor] = PLAT_BADGE[result.platform] || [result.platform, 'var(--muted)'];
              const shortId = result.history
                ? (result.project || '').replace(/^\/Users\/[^/]+/, '~')
                : result.sessionId.length > 20
                  ? result.sessionId.slice(0, 8) + '…'
                  : result.sessionId;
              return (
                <div
                  key={i}
                  data-row-index={i}
                  onClick={() => void openHit(row)}
                  onMouseEnter={() => row.clickable && setSelected(i)}
                  className={cn(
                    'rounded-md px-3 py-2',
                    row.clickable ? 'cursor-pointer' : 'cursor-default opacity-75',
                    selected === i && 'bg-accent'
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      className="rounded px-1"
                      style={{ color: platColor, border: `1px solid ${platColor}33` }}
                    >
                      {platLabel}
                    </span>
                    <span>{shortId}</span>
                    {result.history ? (
                      <span style={{ color: '#d29922' }}>已清理 · 仅输入记录</span>
                    ) : (
                      <span>{match.role}</span>
                    )}
                    {match.timestamp ? <span>{new Date(match.timestamp).toLocaleDateString()}</span> : null}
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/90">
                    <Highlighted text={match.snippet} q={query} />
                  </div>
                </div>
              );
            })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
