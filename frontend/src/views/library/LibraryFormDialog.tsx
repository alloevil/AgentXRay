// Library create/edit form dialog — cross-view contract component.
// Other views (Prompts ⭐收藏 / 画像入库) mount <LibraryFormDialog /> once at their
// view root and open it via useAppStore openLibraryForm(prefill, isEdit?).
// Legacy reference: public/js/app.js openLibraryForm / requestSuggestedName /
// libraryFormSave (lines ~2287-2406).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { createLibraryPrompt, suggestLibraryName, updateLibraryPrompt } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { LibraryFormPrefill } from '@/store';
import { useAppStore } from '@/store';

/** Valid slash-command name (legacy validation regex). */
export const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Client-side name heuristic (legacy suggestLibraryName, app.js:2299).
 * Renamed to avoid clashing with the api/client suggest-name fetcher.
 */
export function heuristicLibraryName(text: string): string {
  let name = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  name = name.split('-').slice(0, 6).join('-').slice(0, 64).replace(/-+$/, '');
  return LIBRARY_NAME_RE.test(name) ? name : 'prompt-' + Date.now();
}

export function LibraryFormDialog() {
  const form = useAppStore((s) => s.libraryForm);
  const closeLibraryForm = useAppStore((s) => s.closeLibraryForm);
  if (!form.open) return null;
  // Keyed remount per open: field state + suggest-name lifecycle reset naturally.
  return (
    <FormInner
      key={form.openSeq}
      editingName={form.editingName}
      prefill={form.prefill}
      onClose={closeLibraryForm}
    />
  );
}

function FormInner({
  editingName,
  prefill,
  onClose,
}: {
  editingName: string | null;
  prefill: LibraryFormPrefill | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = editingName !== null;
  const source = prefill?.source || 'manual';
  const prefillName = prefill?.name || '';
  // ⭐ prefill whose heuristic name is the timestamp fallback (or empty): try smart naming.
  const shouldSuggest =
    !isEdit && !!prefill?.content && (!prefillName || /^prompt-\d+$/.test(prefillName));

  const [name, setName] = useState(shouldSuggest ? '' : prefillName);
  const [description, setDescription] = useState(prefill?.description || '');
  const [tags, setTags] = useState((prefill?.tags || []).join(', '));
  const [content, setContent] = useState(prefill?.content || '');
  const [error, setError] = useState('');
  const [suggesting, setSuggesting] = useState(shouldSuggest);
  // Live name value for the async suggestion callback — never clobber typed input.
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!shouldSuggest) return;
    let cancelled = false;
    suggestLibraryName(prefill!.content!)
      .catch(() => ({ name: null }))
      .then((data) => {
        if (cancelled) return;
        setSuggesting(false);
        if (nameRef.current.trim()) return; // user already typed a name
        const suggested = data.name;
        setName(suggested && LIBRARY_NAME_RE.test(suggested) ? suggested : prefillName);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: () => {
      const trimmed = name.trim();
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (isEdit) {
        const body: { description: string; tags: string[]; content: string; newName?: string } = {
          description: description.trim(),
          tags: tagList,
          content,
        };
        if (trimmed !== editingName) body.newName = trimmed;
        return updateLibraryPrompt(editingName, body);
      }
      return createLibraryPrompt({
        name: trimmed,
        description: description.trim(),
        tags: tagList,
        content,
        source,
      });
    },
    onSuccess: () => {
      onClose();
      toast.success(isEdit ? '已保存修改' : '已保存到资产库');
      if (!isEdit) prefill?.onSaved?.();
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSave = () => {
    if (!LIBRARY_NAME_RE.test(name.trim())) {
      setError('名称无效：需以小写字母或数字开头，只含小写字母、数字、连字符，最长 64 字符');
      return;
    }
    if (!content.trim()) {
      setError('内容不能为空');
      return;
    }
    save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEdit ? '编辑 Prompt' : '新建 Prompt'}
            {source === 'history' && (
              <span className="rounded-full bg-muted px-2 py-px text-[0.7rem] font-normal text-muted-foreground">
                来自历史收藏
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Name（slash command 名，小写字母/数字/连字符）">
            <Input
              autoFocus
              value={name}
              placeholder={suggesting ? '生成中…' : 'my-prompt'}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField label="Description">
            <Input
              value={description}
              placeholder="What this prompt does"
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <FormField label="Tags（逗号分隔）">
            <Input value={tags} placeholder="refactor, review" onChange={(e) => setTags(e.target.value)} />
          </FormField>
          <FormField label="Content">
            <Textarea
              rows={10}
              value={content}
              placeholder="Prompt content…"
              onChange={(e) => setContent(e.target.value)}
              className="font-mono text-xs"
            />
          </FormField>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={save.isPending}>
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
