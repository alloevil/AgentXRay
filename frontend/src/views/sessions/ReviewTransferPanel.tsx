import { useRef, useState } from 'react';
import {
  createReviewTransfer, importReviewTransfer, previewReviewTransfer, parseReviewTransfer,
  REVIEW_LABELS, REVIEW_TRANSFER_MAX_BYTES,
  type EventReview, type ReviewTransfer, type TransferDecision, type TransferPreview,
} from './diagnostic-reviews';

const DECISIONS: Record<TransferDecision, string> = {
  import: '可导入', unmatched: '非当前事件，跳过', stale: '证据已变化，跳过',
  duplicate: '已存在相同记录，跳过', conflict: '本地已有记录，保留本地',
};
const BUTTON = 'min-h-9 rounded border border-border px-2 py-1 hover:border-primary disabled:opacity-50';
interface TransferSnapshot {
  entries: Record<string, EventReview>;
  bundle: ReviewTransfer;
  rows: TransferPreview[];
  mode: 'export' | 'import';
}

export function ReviewTransferPanel({ entries, ready, onImported }: {
  entries: Record<string, EventReview>;
  ready: boolean;
  onImported: () => void;
}) {
  const [preview, setPreview] = useState<TransferSnapshot | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [reading, setReading] = useState(false);
  const readSequence = useRef(0);
  const identities = Object.values(entries).map((entry) => entry.identity);
  const current = ready && preview?.entries === entries;
  const json = preview ? `${JSON.stringify(preview.bundle, null, 2)}\n` : '';
  const importCount = preview?.rows.filter((row) => row.decision === 'import').length ?? 0;

  function clearPreview() {
    readSequence.current++;
    setReading(false);
    setPreview(null);
    setConfirmed(false);
    setError('');
    setResult('');
  }

  function prepareExport() {
    clearPreview();
    try {
      if (!ready) throw new Error('请等待当前证据核对完成。');
      const bundle = createReviewTransfer(window.localStorage, identities);
      setPreview({ entries, bundle, rows: [], mode: 'export' });
    } catch (failure) {
      setError(`未导出：${failure instanceof Error ? failure.message : '本地复核无法读取。'}`);
    }
  }

  async function readFile(file: File | undefined) {
    clearPreview();
    if (!file) return;
    const sequence = readSequence.current;
    setReading(true);
    try {
      if (!ready) throw new Error('请等待当前证据核对完成。');
      if (file.size > REVIEW_TRANSFER_MAX_BYTES) throw new Error('迁移文件不能超过 1 MiB。');
      const text = await file.text();
      if (sequence !== readSequence.current) return;
      const bundle = parseReviewTransfer(text);
      const rows = previewReviewTransfer(window.localStorage, bundle, identities);
      setPreview({ entries, bundle, rows, mode: 'import' });
    } catch (failure) {
      if (sequence === readSequence.current) setError(`未导入：${failure instanceof Error ? failure.message : '文件或本地存储无法读取。'}`);
    } finally {
      if (sequence === readSequence.current) setReading(false);
    }
  }

  function download() {
    if (!current || !confirmed || !preview || !preview.bundle.records.length) return;
    setError('');
    try {
      const latest = createReviewTransfer(window.localStorage, identities, preview.bundle.exportedAt);
      if (JSON.stringify(latest) !== JSON.stringify(preview.bundle)) throw new Error('本地复核已变化，请重新预览。');
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'agentxray-reviews.json';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setResult(`已发起下载 ${preview.bundle.records.length} 条复核。请妥善保管明文文件。`);
    } catch (failure) {
      setError(`未导出：${failure instanceof Error ? failure.message : '下载失败。'}`);
    }
  }

  function applyImport() {
    if (!current || !confirmed || !preview || !importCount) return;
    setError('');
    try {
      const report = importReviewTransfer(window.localStorage, preview.bundle, identities);
      setResult(`导入 ${report.imported} 条，跳过 ${report.skipped} 条，失败 ${report.failed} 条。${report.failed ? '已成功写入的记录保留；可重新预览重试，未进行整批回滚。' : '自动诊断结果未改变。'}`);
      setPreview(null);
      setConfirmed(false);
      onImported();
    } catch (failure) {
      setError(`未导入：${failure instanceof Error ? failure.message : '本地存储无法读取。'}`);
    }
  }

  return (
    <details className="mt-3 rounded border border-border p-2" data-testid="review-transfer">
      <summary className="cursor-pointer font-medium">迁移当前会话复核 / Export & import</summary>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        仅迁移当前事件的有效复核；不自动包含日志、参数或路径。手写依据可能包含秘密，文件未加密，也不是可信签名。
        导入必须匹配当前会话和完整证据；所有已有本地标记保留。最多 500 条 / 1 MiB，不是整库备份。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} disabled={!ready} onClick={prepareExport}>预览导出</button>
        <label className="min-w-0 max-w-full text-[11px]">
          选择复核 JSON 文件
          <input type="file" accept=".json,application/json" aria-label="选择复核 JSON 文件"
            className="mt-1 block w-full min-w-0 max-w-full" disabled={!ready}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void readFile(file); }} />
        </label>
      </div>
      {reading ? <p role="status" className="mt-2">正在读取本地文件，尚未写入复核…</p> : null}
      {preview ? (
        <div className="mt-3 space-y-2">
          <p className="font-medium">{preview.mode === 'export' ? '导出预览' : '导入预览'}：{preview.bundle.records.length} 条复核{preview.mode === 'import' ? `，${importCount} 条可导入` : ''}</p>
          {!current ? <p role="alert" className="text-amber-500">当前证据或复核已变化，请重新选择文件或预览；本次确认已禁用。</p> : null}
          {preview.mode === 'import' ? (
            <ol aria-label="逐条导入决定" className="max-h-64 space-y-2 overflow-y-auto">
              {preview.rows.map((row, index) => (
                <li key={row.storageKey} className="min-w-0 rounded border border-border p-2">
                  <p>#{index + 1} · {DECISIONS[row.decision]} · 人工：{REVIEW_LABELS[row.record.status]}</p>
                  <p className="text-[11px] text-muted-foreground">{row.record.reviewedAt}</p>
                  <p className="mt-1 whitespace-pre-wrap break-all">{row.record.note}</p>
                  <details className="mt-1 text-[10px] text-muted-foreground"><summary className="cursor-pointer">哈希标识与证据指纹</summary>
                    <p className="break-all">{row.storageKey}</p><p className="break-all">{row.record.fingerprint}</p>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <pre aria-label="将下载的完整 JSON" className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 text-[10px]">{json}</pre>
          )}
          <label className="flex items-start gap-2 text-[11px] leading-5">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我已检查明文依据；理解这不是自动成功证据，且不会覆盖已有记录。
          </label>
          <div className="flex flex-wrap gap-2">
            {preview.mode === 'export' ? (
              <button type="button" className={BUTTON} disabled={!current || !confirmed || !preview.bundle.records.length} onClick={download}>下载复核 JSON</button>
            ) : (
              <button type="button" className={BUTTON} disabled={!current || !confirmed || !importCount} onClick={applyImport}>确认导入匹配记录</button>
            )}
            <button type="button" className={BUTTON} onClick={clearPreview}>取消迁移预览</button>
          </div>
          {!preview.bundle.records.length ? <p className="text-muted-foreground">没有可迁移的有效复核。未复核、过期、已恢复或未加载事件不会导出。</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 whitespace-pre-wrap break-all text-destructive">{error}</p> : null}
      {result ? <p role="status" className="mt-2">{result}</p> : null}
    </details>
  );
}
