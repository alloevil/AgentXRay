// 🗑 已隐藏的 Prompt manage dialog — restore single rows or 全部恢复.
// Legacy hiddenPromptsOverlay: date + preview + 恢复 per row, error line, close.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { unhidePrompt } from '@/api/client';
import type { HiddenPrompt } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

import { errorMessage } from './promptsLib';

interface PromptsHiddenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden: HiddenPrompt[];
}

export function PromptsHiddenDialog({ open, onOpenChange, hidden }: PromptsHiddenDialogProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [restoringAll, setRestoringAll] = useState(false);

  const restoreMutation = useMutation({
    // Sequential DELETEs, like legacy restoreHiddenPrompts.
    mutationFn: async (hashes: string[]) => {
      for (const hash of hashes) await unhidePrompt(hash);
    },
    onMutate: () => setError(''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['prompts-hidden'] });
    },
    onError: (err) => {
      setError('恢复失败: ' + errorMessage(err));
      // A mid-loop failure may still have restored earlier hashes — resync.
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['prompts-hidden'] });
    },
    onSettled: () => setRestoringAll(false),
  });

  const [restoringHash, setRestoringHash] = useState('');
  const pending = restoreMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>🗑 已隐藏的 Prompt</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh]">
          {hidden.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              没有已隐藏的 prompt
            </div>
          ) : (
            <div className="space-y-1 pr-3">
              {hidden.map((h) => (
                <div
                  key={h.hash}
                  className="flex items-center gap-2 rounded border border-border/70 px-2 py-1.5 text-xs"
                >
                  <span className="shrink-0 text-muted-foreground">
                    {h.hiddenAt ? new Date(h.hiddenAt).toLocaleDateString() : '—'}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={h.preview || ''}>
                    {h.preview || ''}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={pending}
                    onClick={() => {
                      setRestoringHash(h.hash);
                      restoreMutation.mutate([h.hash]);
                    }}
                  >
                    {pending && !restoringAll && restoringHash === h.hash ? '恢复中…' : '恢复'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button
            disabled={hidden.length === 0 || pending}
            onClick={() => {
              setRestoringAll(true);
              restoreMutation.mutate(hidden.map((h) => h.hash));
            }}
          >
            {pending && restoringAll ? '恢复中…' : '全部恢复'}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
