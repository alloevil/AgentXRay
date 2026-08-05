// One extracted prompt row: timestamp, markdown body (>500 chars clamped with
// Show more), and the ⭐收藏 / 优化 / Copy / 🗑隐藏 actions — legacy prompt-item.

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { rewritePrompt } from '@/api/client';
import type { PromptEntry, RewriteResult } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { TriCheckbox } from './TriCheckbox';
import { errorMessage } from './promptsLib';

/** Copy-to-clipboard button with the legacy 1.2s "Copied!" flash. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-6 px-2 text-xs', className)}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

interface PromptItemRowProps {
  prompt: PromptEntry;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: (on: boolean) => void;
  onHide: () => void;
  hidePending: boolean;
  onStar: () => void;
}

export function PromptItemRow({
  prompt,
  selectMode,
  selected,
  onToggleSelected,
  onHide,
  hidePending,
  onStar,
}: PromptItemRowProps) {
  const long = prompt.text.length > 500;
  const [clamped, setClamped] = useState(true);
  const [rewrite, setRewrite] = useState<RewriteResult | null>(null);
  const [rewriteError, setRewriteError] = useState('');
  const errorTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(errorTimer.current), []);

  const rewriteMutation = useMutation({
    mutationFn: rewritePrompt,
    onSuccess: (data) => setRewrite(data),
    onError: (error) => {
      setRewriteError('改写失败: ' + errorMessage(error));
      errorTimer.current = window.setTimeout(() => setRewriteError(''), 5000);
    },
  });

  return (
    <div
      className={cn(
        'group relative rounded-md border border-border bg-background/40 p-3',
        selectMode && 'cursor-pointer',
        selected && 'border-primary/60 bg-primary/10'
      )}
      onClick={(e) => {
        // Row click toggles the checkbox; inner buttons/links keep working.
        if (!selectMode) return;
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        onToggleSelected(!selected);
      }}
    >
      <div className="flex items-start gap-2">
        {selectMode && (
          <TriCheckbox checked={selected} onCheckedChange={onToggleSelected} className="mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          {prompt.timestamp && (
            <div className="mb-1 text-[11px] text-muted-foreground">
              {new Date(prompt.timestamp).toLocaleString()}
            </div>
          )}
          <div className={cn('text-sm', long && clamped && 'max-h-48 overflow-hidden')}>
            <Markdown text={prompt.text} />
          </div>
          {long && (
            <button
              className="mt-1 text-xs text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setClamped(!clamped);
              }}
            >
              {clamped ? 'Show more' : 'Show less'}
            </button>
          )}
        </div>
      </div>

      {!selectMode && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title="收藏到资产库"
            onClick={onStar}
          >
            ⭐ 收藏
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title="用 Claude 改写这条 prompt"
            disabled={rewriteMutation.isPending}
            onClick={() => {
              if (rewrite) {
                setRewrite(null); // legacy: second click removes the block
                return;
              }
              rewriteMutation.mutate(prompt.text);
            }}
          >
            {rewriteMutation.isPending ? '优化中…' : '优化'}
          </Button>
          <CopyButton text={prompt.text} />
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title="隐藏此 prompt（同文重复项一并隐藏，可恢复）"
            disabled={hidePending}
            onClick={onHide}
          >
            🗑
          </Button>
        </div>
      )}

      {rewrite && (
        <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 p-2">
          <div className="mb-1 text-xs font-semibold text-primary">建议改写</div>
          <div className="text-sm">
            <Markdown text={rewrite.rewrite} />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <CopyButton text={rewrite.rewrite} />
          </div>
          {rewrite.rationale && (
            <div className="mt-1 text-xs text-muted-foreground">{rewrite.rationale}</div>
          )}
        </div>
      )}
      {rewriteError && <div className="mt-2 text-xs text-destructive">{rewriteError}</div>}
    </div>
  );
}
