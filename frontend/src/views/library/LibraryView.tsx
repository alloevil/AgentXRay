// 资产库 view: cards + search + sort (axr-lib-sort) + usage badges + install
// toggles + Fabric import + CRUD form + version history.
// Legacy reference: public/js/app.js loadLibrary/renderLibrary (~2073-2284).

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getLibrary, getLibraryUsage } from '@/api/client';
import type { LibraryPrompt } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { LIB_SORT_KEY, useAppStore } from '@/store';
import { LibraryCard } from './LibraryCard';
import { LibraryFabricDialog } from './LibraryFabricDialog';
import { LibraryFormDialog } from './LibraryFormDialog';
import { LibraryHistoryDialog } from './LibraryHistoryDialog';

type LibrarySort = 'recent' | 'uses';

function loadStoredSort(): LibrarySort {
  try {
    return localStorage.getItem(LIB_SORT_KEY) === 'uses' ? 'uses' : 'recent';
  } catch {
    return 'recent';
  }
}

function matchesSearch(p: LibraryPrompt, q: string): boolean {
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if ((p.description || '').toLowerCase().includes(q)) return true;
  if ((p.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
  return (p.content || '').toLowerCase().includes(q);
}

export function LibraryView() {
  const openLibraryForm = useAppStore((s) => s.openLibraryForm);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<LibrarySort>(loadStoredSort);
  const [fabricOpen, setFabricOpen] = useState(false);
  const [historyName, setHistoryName] = useState<string | null>(null);

  const library = useQuery({ queryKey: ['library'], queryFn: getLibrary });
  // Usage badges are best-effort: tolerate failure → no badges (legacy .catch(() => null)).
  const usageQuery = useQuery({
    queryKey: ['library', 'usage'],
    queryFn: getLibraryUsage,
    retry: false,
  });
  const usage = usageQuery.data?.usage || null;

  if (library.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading library…</div>;
  }
  if (library.isError) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load library: {(library.error as Error).message}
      </div>
    );
  }

  const all = library.data?.prompts || [];
  const q = search.trim().toLowerCase();
  const prompts = all.filter((p) => matchesSearch(p, q));
  if (sort === 'uses') {
    prompts.sort((a, b) => (usage?.[b.name]?.uses || 0) - (usage?.[a.name]?.uses || 0));
  } else {
    prompts.sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }

  const changeSort = (value: LibrarySort) => {
    setSort(value);
    try {
      localStorage.setItem(LIB_SORT_KEY, value);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Filter by name / tags / description / content"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select value={sort} onValueChange={(v) => changeSort(v as LibrarySort)}>
          <SelectTrigger className="w-32" title="排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">最新</SelectItem>
            <SelectItem value="uses">使用次数</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setFabricOpen(true)}>
          导入 Fabric Patterns
        </Button>
        <Button variant="outline" size="sm" onClick={() => openLibraryForm(null, false)}>
          新建 Prompt
        </Button>
      </div>
      <div className="text-sm text-muted-foreground">
        <span className="mr-2 rounded-full bg-muted px-2 py-px text-xs">🌐 全平台</span>
        Prompt 资产库（~/.agentxray/library）— 点亮 Claude / Codex / OMP
        开关即安装为该工具的 slash command，工具内{' '}
        <code className="rounded bg-muted px-1 text-xs">/名字</code> 调用 · {all.length} prompt
        {all.length === 1 ? '' : 's'}
        {q ? ` — showing ${prompts.length}` : ''}
      </div>
      {prompts.length ? (
        <div className="space-y-3">
          {prompts.map((p) => (
            <LibraryCard
              key={p.name}
              prompt={p}
              usage={usage?.[p.name] || null}
              onEdit={() => openLibraryForm(p, true)}
              onHistory={() => setHistoryName(p.name)}
            />
          ))}
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {all.length ? 'No matches.' : '资产库为空。在 Prompts 视图点 ⭐ 收藏，或点击「新建 Prompt」。'}
        </div>
      )}
      <LibraryFormDialog />
      <LibraryFabricDialog open={fabricOpen} onClose={() => setFabricOpen(false)} />
      <LibraryHistoryDialog name={historyName} onClose={() => setHistoryName(null)} />
    </div>
  );
}
