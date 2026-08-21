import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getBackupStatus, getLlmSettings, runBackup, saveLlmSettings } from '@/api/client';
import type { DirSettings } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/pure';
import { EMPTY_SETTINGS, useAppStore } from '@/store';

const DIR_FIELDS: { key: keyof DirSettings; label: string; placeholder: string }[] = [
  { key: 'openclawDir', label: 'OpenClaw Directory', placeholder: '~/.openclaw/agents' },
  { key: 'codexDir', label: 'Codex Directory', placeholder: '~/.codex/sessions' },
  { key: 'claudeCodeDir', label: 'Claude Code Directory', placeholder: '~/.claude/projects' },
  { key: 'hermesDir', label: 'Hermes Directory', placeholder: '~/.hermes' },
  { key: 'ompDir', label: 'OMP Directory', placeholder: '~/.omp/agent/sessions' },
  { key: 'dshDir', label: 'DeepSeek Harness Directory', placeholder: '~/.dsh/sessions' },
  { key: 'geminiDir', label: 'Gemini CLI Directory', placeholder: '~/.gemini/tmp' },
];

function BackupSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['backup-status'], queryFn: getBackupStatus });
  const backup = useMutation({
    mutationFn: runBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backup-status'] }),
  });

  const statusLine = status.data
    ? `归档目录 ${status.data.archiveDir} · 文件数 ${status.data.files} · 占用 ${formatBytes(status.data.bytes)} · 上次备份 ${
        status.data.lastBackup ? new Date(status.data.lastBackup).toLocaleString() : '从未'
      }`
    : '';
  const error = backup.error
    ? `备份失败: ${(backup.error as Error).message}`
    : status.error
      ? `备份状态获取失败: ${(status.error as Error).message}`
      : null;

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">
        会话备份（codex / claude-code / omp 增量归档）
      </label>
      <div className="flex items-center gap-2.5">
        <Button
          variant="outline"
          size="sm"
          disabled={backup.isPending}
          onClick={() => backup.mutate()}
        >
          {backup.isPending ? '备份中…' : '立即备份'}
        </Button>
        {backup.data && (
          <span className="text-xs text-muted-foreground">
            完成：新增 {backup.data.copied}，跳过 {backup.data.skipped}
          </span>
        )}
      </div>
      {statusLine && <div className="text-xs text-muted-foreground">{statusLine}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

// LLM 后端配置 (#14): OpenAI 兼容端点,存服务端 ~/.agentxray/llm.json。
// 显式配置优先于本机 claude CLI;两者都没有时 prompt 优化按钮会给出指引。
function LlmSection() {
  const queryClient = useQueryClient();
  const llm = useQuery({ queryKey: ['llm-settings'], queryFn: getLlmSettings });
  const [draft, setDraft] = useState<{ baseUrl: string; model: string; apiKey: string } | null>(null);
  const current = draft ?? {
    baseUrl: llm.data?.baseUrl ?? '',
    model: llm.data?.model ?? '',
    apiKey: '',
  };

  const save = useMutation({
    mutationFn: () =>
      saveLlmSettings({
        baseUrl: current.baseUrl.trim(),
        model: current.model.trim(),
        // Untouched key field keeps the stored key (undefined = keep)
        apiKey: draft && draft.apiKey !== '' ? draft.apiKey : current.baseUrl.trim() ? undefined : '',
      }),
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
    },
  });

  const backendLabel =
    llm.data?.backend === 'openai'
      ? `OpenAI 兼容端点（${llm.data.model}）`
      : llm.data?.backend === 'claude-cli'
        ? '本机 claude CLI'
        : '未配置 — prompt 优化不可用';

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <label className="text-xs text-muted-foreground">
        LLM 接口（prompt 优化 / 聚类建议 / 命名建议）— 当前后端：{backendLabel}
      </label>
      <Input
        placeholder="Base URL，如 https://api.openai.com/v1 或 http://localhost:11434/v1"
        value={current.baseUrl}
        onChange={(e) => setDraft({ ...current, baseUrl: e.target.value })}
      />
      <div className="flex gap-1.5">
        <Input
          placeholder="模型名，如 gpt-4o-mini / qwen2.5"
          value={current.model}
          onChange={(e) => setDraft({ ...current, model: e.target.value })}
        />
        <Input
          type="password"
          placeholder={llm.data?.hasApiKey ? 'API Key（已保存，留空保持不变）' : 'API Key（本地端点可留空）'}
          value={current.apiKey}
          onChange={(e) => setDraft({ ...current, apiKey: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-2.5">
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '保存中…' : '保存 LLM 配置'}
        </Button>
        <span className="text-xs text-muted-foreground">
          留空 Base URL 并保存 = 回退到本机 claude CLI 探测
        </span>
      </div>
      {save.error && (
        <div className="text-xs text-danger">保存失败: {(save.error as Error).message}</div>
      )}
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DirSettings>(settings);

  // Re-seed the draft from the store every time the dialog opens (legacy openSettings()).
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(useAppStore.getState().settings);
    onOpenChange(next);
  };

  const save = () => {
    saveSettings({
      openclawDir: draft.openclawDir.trim(),
      codexDir: draft.codexDir.trim(),
      claudeCodeDir: draft.claudeCodeDir.trim(),
      hermesDir: draft.hermesDir.trim(),
      ompDir: draft.ompDir.trim(),
      dshDir: draft.dshDir.trim(),
      geminiDir: draft.geminiDir.trim(),
    });
    onOpenChange(false);
    // Legacy refreshAll(false): every dir-dependent query must refetch.
    queryClient.invalidateQueries();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {DIR_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`setting-${field.key}`}>
                {field.label}
              </label>
              <Input
                id={`setting-${field.key}`}
                value={draft[field.key]}
                placeholder={field.placeholder}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              />
            </div>
          ))}
          <LlmSection />
          <BackupSection />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setDraft({ ...EMPTY_SETTINGS })}>
            Reset to Defaults
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
