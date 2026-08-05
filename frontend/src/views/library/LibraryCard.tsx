// Library card: name/source/date head, per-target install toggles, description,
// tags, usage badges, clamped content, Copy/编辑/删除/历史 actions.
// Legacy reference: public/js/app.js renderLibrary card template (~2133-2284).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { deleteLibraryPrompt, installLibraryPrompt, uninstallLibraryPrompt } from '@/api/client';
import type { InstallTarget, LibraryPrompt, LibraryUsageEntry } from '@/api/types';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TARGETS: { target: InstallTarget; label: string }[] = [
  { target: 'claude', label: 'Claude' },
  { target: 'codex', label: 'Codex' },
  { target: 'omp', label: 'OMP' },
];

export function LibraryCard({
  prompt,
  usage,
  onEdit,
  onHistory,
}: {
  prompt: LibraryPrompt;
  usage: LibraryUsageEntry | null;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const content = prompt.content || '';
  const long = content.length > 500;
  const dateStr = prompt.createdAt ? new Date(prompt.createdAt).toLocaleString() : '—';

  const toggleInstall = useMutation({
    mutationFn: ({ target, installed }: { target: InstallTarget; installed: boolean }) =>
      installed
        ? uninstallLibraryPrompt(prompt.name, [target])
        : installLibraryPrompt(prompt.name, [target]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['library'] }),
    onError: (err: Error, { installed }) =>
      toast.error((installed ? '卸载失败: ' : '安装失败: ') + err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteLibraryPrompt(prompt.name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['library'] }),
    onError: (err: Error) => toast.error('删除失败: ' + err.message),
  });

  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-primary">/{prompt.name}</span>
        <span className="rounded-full bg-muted px-2 py-px text-[0.7rem] text-muted-foreground">
          {prompt.source || 'manual'}
        </span>
        <span className="text-xs text-muted-foreground">{dateStr}</span>
        <span className="ml-auto flex gap-1">
          {TARGETS.map(({ target, label }) => {
            const installed = !!prompt.installed?.[target];
            return (
              <button
                key={target}
                type="button"
                disabled={toggleInstall.isPending}
                title={installed ? '点击卸载' : `安装为 /${prompt.name}`}
                onClick={() => toggleInstall.mutate({ target, installed })}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[0.7rem] transition-colors disabled:opacity-50',
                  installed
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50'
                )}
              >
                {label}
              </button>
            );
          })}
        </span>
      </div>
      {prompt.description && <div className="mt-2 text-sm text-muted-foreground">{prompt.description}</div>}
      {prompt.tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {prompt.tags.map((tag) => (
            <span key={tag} className="rounded bg-muted px-1.5 py-px text-[0.7rem] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}
      {usage && usage.uses > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          {[
            `📈 用过 ${usage.uses} 次`,
            usage.avgMessages != null ? `平均 ${Number(usage.avgMessages.toFixed(1))} 条消息/轮` : null,
            usage.errorRate != null ? `错误率 ${Math.round(usage.errorRate * 100)}%` : null,
            usage.lastUsed ? `最近 ${new Date(usage.lastUsed).toLocaleDateString()}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      <div className={cn('mt-2', long && !expanded && 'max-h-40 overflow-hidden')}>
        <Markdown text={content} />
      </div>
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          编辑
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`删除 "${prompt.name}"？已安装的 slash command 副本也会一并移除。`)) {
              remove.mutate();
            }
          }}
        >
          删除
        </Button>
        <Button variant="outline" size="sm" onClick={onHistory}>
          🕒 历史
        </Button>
      </div>
    </div>
  );
}
