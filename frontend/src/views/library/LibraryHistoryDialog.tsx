// Library version history dialog: commit list → old content preview → 恢复此版本.
// Legacy reference: public/js/app.js library history modal (~2546-2646).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { getLibraryHistory, getLibraryHistoryEntry, updateLibraryPrompt } from '@/api/client';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export function LibraryHistoryDialog({ name, onClose }: { name: string | null; onClose: () => void }) {
  if (name === null) return null;
  return <HistoryInner key={name} name={name} onClose={onClose} />;
}

function HistoryInner({ name, onClose }: { name: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [hash, setHash] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  const historyQuery = useQuery({
    queryKey: ['library', 'history', name],
    queryFn: () => getLibraryHistory(name),
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const commits = historyQuery.data?.commits || [];

  const entryQuery = useQuery({
    queryKey: ['library', 'history', name, hash],
    queryFn: () => getLibraryHistoryEntry(name, hash!),
    enabled: hash !== null,
  });
  const content = entryQuery.data?.content || '';

  const restore = useMutation({
    mutationFn: () => updateLibraryPrompt(name, { content }),
    onSuccess: () => {
      onClose();
      toast.success('已恢复此版本');
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (err: Error) => setError('恢复失败: ' + err.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>🕒 /{name} 历史</DialogTitle>
        </DialogHeader>
        <div className="max-h-48 overflow-y-auto rounded-md border border-border p-1">
          {historyQuery.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">加载历史…</div>
          ) : historyQuery.isError ? (
            <div className="p-3 text-sm text-destructive">
              获取历史失败: {(historyQuery.error as Error).message}
            </div>
          ) : !commits.length ? (
            <div className="p-3 text-sm text-muted-foreground">暂无历史</div>
          ) : (
            commits.map((c) => (
              <button
                key={c.hash}
                type="button"
                onClick={() => {
                  setHash(c.hash);
                  setExpanded(false);
                }}
                className={cn(
                  'flex w-full items-baseline gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/50',
                  hash === c.hash && 'bg-muted'
                )}
              >
                <span className="shrink-0 text-xs text-muted-foreground">
                  {c.date ? new Date(c.date).toLocaleString() : '—'}
                </span>
                <span className="truncate">{c.message || ''}</span>
              </button>
            ))
          )}
        </div>
        {hash !== null && (
          <div className="rounded-md border border-border p-3">
            {entryQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">加载版本内容…</div>
            ) : entryQuery.isError ? (
              <div className="text-sm text-destructive">
                获取版本内容失败: {(entryQuery.error as Error).message}
              </div>
            ) : (
              <>
                <div className={cn(!expanded && 'max-h-40 overflow-hidden')}>
                  <Markdown text={content} />
                </div>
                {content.length > 500 && (
                  <button
                    type="button"
                    className="mt-1 text-xs text-primary hover:underline"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? 'Show less' : 'Show more'}
                  </button>
                )}
                <div className="mt-3">
                  <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate()}>
                    恢复此版本
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
