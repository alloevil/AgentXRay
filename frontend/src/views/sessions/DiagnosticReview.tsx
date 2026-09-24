import { useEffect, useId, useState } from 'react';
import type { FailureEvent } from './diagnostics';
import {
  clearReview, createReviewIdentity, readReview, REVIEW_LABELS, REVIEW_PREFIX, saveReview,
  type EventReview, type ReviewStatus,
} from './diagnostic-reviews';

interface ReviewSnapshot {
  events: FailureEvent[];
  scope: string;
  entries: Record<string, EventReview>;
  error: string;
}

export function useEventReviews(scope: string, events: FailureEvent[], enabled = true) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) { setSnapshot(null); return; }
    let generation = 0;
    let cancelled = false;
    async function load() {
      const current = ++generation;
      try {
        const identities = await Promise.all(events.map((event) => createReviewIdentity(scope, event)));
        if (cancelled || current !== generation) return;
        const entries: Record<string, EventReview> = {};
        events.forEach((event, index) => {
          const identity = identities[index];
          try {
            entries[event.id] = readReview(window.localStorage, identity);
          } catch {
            entries[event.id] = { identity, record: null, stale: false,
              error: '本地复核无法读取，当前保持待复核。可重新保存或清除此事件的损坏记录。' };
          }
        });
        setSnapshot({ scope, events, entries, error: '' });
      } catch {
        if (!cancelled && current === generation) {
          setSnapshot({ scope, events, entries: {}, error: '无法计算证据指纹；复核保存已停用，自动诊断仍可查看。请使用 localhost 或 HTTPS。' });
        }
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(REVIEW_PREFIX)) void load();
    };
    void load();
    window.addEventListener('storage', onStorage);
    return () => { cancelled = true; window.removeEventListener('storage', onStorage); };
  }, [scope, events, revision, enabled]);

  const loaded = enabled && snapshot?.scope === scope && snapshot.events === events;
  const entries = loaded ? snapshot.entries : {};
  const error = loaded ? snapshot.error : '';

  function update(eventId: string, status: ReviewStatus | null, note = '') {
    const entry = entries[eventId];
    if (!loaded || error || !entry) throw new Error('证据正在变化，请等待重新加载后复核。');
    let record = null;
    try {
      if (status === null) clearReview(window.localStorage, entry.identity);
      else record = saveReview(window.localStorage, entry.identity, status, note);
    } catch {
      throw new Error('未保存：本地存储不可用或已满，或依据不符合要求。原复核状态未改变。');
    }
    const updated: EventReview = { identity: entry.identity, record, stale: false };
    setSnapshot((previous) => previous?.events === events && previous.scope === scope ? {
      ...previous, entries: { ...previous.entries, [eventId]: updated },
    } : previous);
  }

  return { entries, loaded, error, update, refresh: () => setRevision((value) => value + 1) };
}

export function DiagnosticReview({ entry, ready, onUpdate }: {
  entry: EventReview | undefined;
  ready: boolean;
  onUpdate: (status: ReviewStatus | null, note?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ReviewStatus>(entry?.record?.status ?? 'follow-up');
  const [note, setNote] = useState(entry?.record?.note ?? '');
  const [error, setError] = useState('');
  const statusId = useId();
  const noteId = useId();
  const buttonClass = 'rounded border border-border px-2 py-1 hover:border-primary disabled:opacity-50';
  function commit(next: ReviewStatus | null) {
    setError('');
    try {
      onUpdate(next, note);
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '未保存：请检查本地存储。');
    }
  }
  return (
    <div className="mt-3 border-t border-border pt-2" data-testid="event-review">
      {entry?.error ? <p role="alert" className="mb-2 text-amber-500">{entry.error}</p> : null}
      {entry?.stale ? <p className="mb-2 font-medium text-amber-500">证据已变化，旧复核不再生效，请重新复核。</p> : null}
      {entry?.record ? (
        <div className="mb-2 text-[11px]">
          <p className="text-muted-foreground">
            {entry.stale ? '旧人工标记' : '人工标记'}：{REVIEW_LABELS[entry.record.status]} · {new Date(entry.record.reviewedAt).toLocaleString()}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-all">{entry.record.note}</p>
        </div>
      ) : null}
      {editing ? (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); commit(status); }}>
          <label htmlFor={statusId} className="block">复核结论（人工）</label>
          <select id={statusId} className="w-full rounded border border-border bg-background p-2"
            value={status} onChange={(event) => setStatus(event.target.value as ReviewStatus)}>
            {Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label htmlFor={noteId} className="block">依据或下一步（必填，最多 1000 字）</label>
          <textarea id={noteId} value={note} required maxLength={1000} rows={3}
            className="w-full resize-y rounded border border-border bg-background p-2"
            placeholder="例如：预期探测无匹配；或替代验证的命令、结果与时间。请勿填写密钥。"
            onChange={(event) => setNote(event.target.value)} />
          <p className="text-[11px] text-muted-foreground">仅当前浏览器保存，未加密；人工结论不改变日志与自动判定。</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass} disabled={!ready || !note.trim()}>保存本机复核</button>
            <button type="button" className={buttonClass} onClick={() => setEditing(false)}>取消编辑</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={!ready}
            onClick={() => { setStatus(entry?.record?.status ?? 'follow-up'); setNote(entry?.record?.note ?? ''); setEditing(true); }}>
            {entry?.record ? '重新复核' : '记录人工复核'}
          </button>
          {entry?.record || entry?.error ? (
            <button type="button" className={buttonClass} disabled={!ready} onClick={() => commit(null)}>撤销本机标记</button>
          ) : null}
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
    </div>
  );
}
