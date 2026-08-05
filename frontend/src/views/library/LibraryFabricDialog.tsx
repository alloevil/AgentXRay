// Fabric patterns import dialog: filter / 全选 / 清空 / imported ✓ disabled /
// 导入 N 个 / result line. Legacy reference: public/js/app.js fabric modal (~2408-2544).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { getFabricPatterns, importFabricPatterns } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function LibraryFabricDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  // Keyed remount per open: selection/result state and a fresh pattern fetch (legacy refetches).
  return <FabricInner onClose={onClose} />;
}

function FabricInner({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Locally-marked names (imported or skipped by a finished import) — merged over server flags.
  const [doneNames, setDoneNames] = useState<Set<string>>(new Set());
  const [resultLine, setResultLine] = useState('');
  const [error, setError] = useState('');

  const patternsQuery = useQuery({
    queryKey: ['library', 'fabric-patterns'],
    queryFn: getFabricPatterns,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const patterns = (patternsQuery.data?.patterns || []).map((p) =>
    doneNames.has(p.name) ? { ...p, imported: true } : p
  );
  const q = filter.trim().toLowerCase();
  const visible = q ? patterns.filter((p) => p.name.toLowerCase().includes(q)) : patterns;
  const importedCount = patterns.filter((p) => p.imported).length;

  const importMutation = useMutation({
    mutationFn: (names: string[]) => importFabricPatterns(names),
    onSuccess: (result) => {
      const imported = result.imported || [];
      const skipped = result.skipped || [];
      const failed = result.failed || [];
      setResultLine(
        `成功 ${imported.length} · 跳过 ${skipped.length} · 失败 ${failed.length}${failed.length ? '：' + failed.join(', ') : ''}`
      );
      if (imported.length) toast.success(`已导入 ${imported.length} 个 Fabric pattern`);
      setDoneNames((prev) => new Set([...prev, ...imported, ...skipped]));
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (err: Error) => setError('导入失败: ' + err.message),
  });

  const runImport = () => {
    const names = [...selected];
    if (!names.length || importMutation.isPending) return;
    if (names.length > 300) {
      setError('一次最多导入 300 个 pattern');
      return;
    }
    setError('');
    setResultLine('');
    importMutation.mutate(names);
  };

  const toggle = (name: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>导入 Fabric Patterns</DialogTitle>
        </DialogHeader>
        <Input
          type="search"
          placeholder="筛选 pattern 名称…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                for (const p of visible) if (!p.imported) next.add(p.name);
                return next;
              })
            }
          >
            全选
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
            清空
          </Button>
          <span className="text-xs text-muted-foreground">
            {patterns.length
              ? `已选 ${selected.size} / 共 ${patterns.length}（已导入 ${importedCount}）`
              : ''}
          </span>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-md border border-border p-1">
          {patternsQuery.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">加载 Fabric pattern 列表…</div>
          ) : patternsQuery.isError ? (
            <div className="p-3 text-sm text-destructive">
              获取 Fabric patterns 失败: {(patternsQuery.error as Error).message}
            </div>
          ) : !visible.length ? (
            <div className="p-3 text-sm text-muted-foreground">
              {patterns.length ? 'No matches.' : '没有可导入的 pattern。'}
            </div>
          ) : (
            visible.map((p) => (
              <label
                key={p.name}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50',
                  p.imported && 'cursor-default opacity-60'
                )}
              >
                <Checkbox
                  disabled={p.imported}
                  checked={selected.has(p.name)}
                  onCheckedChange={(checked) => toggle(p.name, checked === true)}
                />
                <span className="truncate">{p.name}</span>
                {p.imported && <span className="ml-auto shrink-0 text-xs text-primary">✓ 已导入</span>}
              </label>
            ))
          )}
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        {resultLine && <div className="text-xs text-muted-foreground">{resultLine}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button disabled={importMutation.isPending || selected.size === 0} onClick={runImport}>
            {importMutation.isPending ? '导入中…' : `导入 ${selected.size} 个`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
