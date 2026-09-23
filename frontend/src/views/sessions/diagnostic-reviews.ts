import type { FailureEvent } from './diagnostics';

export const REVIEW_PREFIX = 'axr-diagnostic-review-v1:';
export const REVIEW_LABELS = {
  'follow-up': '需跟进',
  expected: '预期失败',
  'verified-elsewhere': '其他验证已通过',
};
export type ReviewStatus = keyof typeof REVIEW_LABELS;
export type ReviewState = 'unreviewed' | ReviewStatus;
export interface ReviewIdentity {
  storageKey: string;
  fingerprint: string;
}
export interface ReviewRecord {
  version: 1;
  fingerprint: string;
  status: ReviewStatus;
  note: string;
  reviewedAt: string;
}
export interface EventReview {
  identity: ReviewIdentity;
  record: ReviewRecord | null;
  stale: boolean;
  error?: string;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, ordered(item)]));
  }
  return value;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(value)));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createReviewIdentity(scope: string, event: FailureEvent): Promise<ReviewIdentity> {
  let args: unknown = event.argumentsText;
  if (event.argumentsText !== null) {
    try { args = JSON.parse(event.argumentsText); } catch { args = event.argumentsText; }
  }
  const first = event.failures[0];
  const identity = [scope, event.toolName, args, event.userTurn, first.index, first.message.id, first.message.toolCallId];
  const evidence: unknown[] = [1, identity, event.failures.map((failure) => ({
    index: failure.index, reason: failure.reason, message: failure.message,
  }))];
  if (event.relatedOperations?.length) {
    evidence.push(event.relatedOperations.map((operation) => ({
      index: operation.index, callIndex: operation.callIndex, userTurn: operation.userTurn,
      relation: operation.relation, state: operation.state, toolName: operation.toolName,
      argumentsText: operation.argumentsText, message: operation.message,
    })));
  }
  const [key, fingerprint] = await Promise.all([
    digest(identity),
    digest(evidence),
  ]);
  return { storageKey: `${REVIEW_PREFIX}${key}`, fingerprint };
}

function validateRecord(value: unknown): ReviewRecord {
  if (!value || typeof value !== 'object') throw new Error('复核记录格式无效');
  const record = value as Partial<ReviewRecord>;
  if (record.version !== 1 || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    !['follow-up', 'expected', 'verified-elsewhere'].includes(String(record.status)) ||
    typeof record.note !== 'string' || !record.note.trim() || record.note.length > 1000 ||
    typeof record.reviewedAt !== 'string' || !Number.isFinite(Date.parse(record.reviewedAt))) {
    throw new Error('复核记录格式无效：请选择状态并填写 1–1000 字依据');
  }
  return { version: 1, fingerprint: record.fingerprint, status: record.status as ReviewStatus,
    note: record.note.trim(), reviewedAt: record.reviewedAt };
}

export function readReview(storage: Pick<Storage, 'getItem'>, identity: ReviewIdentity): EventReview {
  const raw = storage.getItem(identity.storageKey);
  if (raw === null) return { identity, record: null, stale: false };
  const record = validateRecord(JSON.parse(raw));
  return { identity, record, stale: record.fingerprint !== identity.fingerprint };
}

export function saveReview(storage: Pick<Storage, 'setItem'>, identity: ReviewIdentity, status: ReviewStatus,
  note: string, reviewedAt = new Date().toISOString()): ReviewRecord {
  const record = validateRecord({ version: 1, fingerprint: identity.fingerprint, status, note, reviewedAt });
  storage.setItem(identity.storageKey, JSON.stringify(record));
  return record;
}

export function clearReview(storage: Pick<Storage, 'removeItem'>, identity: ReviewIdentity): void {
  storage.removeItem(identity.storageKey);
}

export function reviewState(review: EventReview | undefined): ReviewState {
  return review?.record && !review.stale && !review.error ? review.record.status : 'unreviewed';
}

export const REVIEW_TRANSFER_MAX_BYTES = 1024 * 1024;
export const REVIEW_TRANSFER_MAX_RECORDS = 500;
export interface ReviewTransfer {
  format: 'agentxray-review-transfer';
  version: 1;
  exportedAt: string;
  records: { storageKey: string; record: ReviewRecord }[];
}
export type TransferDecision = 'import' | 'unmatched' | 'stale' | 'duplicate' | 'conflict';
export interface TransferPreview {
  storageKey: string;
  record: ReviewRecord;
  decision: TransferDecision;
}
export interface TransferResult {
  imported: number;
  skipped: number;
  failed: number;
}

function exactFields(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || !fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error('迁移文件格式无效或包含未允许的字段。');
  }
  return value as Record<string, unknown>;
}

function transferDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function parseReviewTransfer(text: string): ReviewTransfer {
  if (new TextEncoder().encode(text).byteLength > REVIEW_TRANSFER_MAX_BYTES) throw new Error('迁移文件不能超过 1 MiB。');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('无法读取 JSON 迁移文件。'); }
  const bundle = exactFields(parsed, ['format', 'version', 'exportedAt', 'records']);
  if (bundle.format !== 'agentxray-review-transfer' || bundle.version !== 1 || !transferDate(bundle.exportedAt) ||
    !Array.isArray(bundle.records) || bundle.records.length > REVIEW_TRANSFER_MAX_RECORDS) {
    throw new Error('不支持的迁移格式、版本、日期，或记录超过 500 条。');
  }
  const keys = new Set<string>();
  const records = bundle.records.map((item) => {
    const entry = exactFields(item, ['storageKey', 'record']);
    if (typeof entry.storageKey !== 'string' || !/^axr-diagnostic-review-v1:[a-f0-9]{64}$/.test(entry.storageKey) || keys.has(entry.storageKey)) {
      throw new Error('复核标识无效或出现重复记录。');
    }
    keys.add(entry.storageKey);
    const raw = exactFields(entry.record, ['version', 'fingerprint', 'status', 'note', 'reviewedAt']);
    if (!transferDate(raw.reviewedAt)) throw new Error('复核时间格式无效。');
    const record = validateRecord(raw);
    return { storageKey: entry.storageKey, record };
  });
  return { format: 'agentxray-review-transfer', version: 1, exportedAt: bundle.exportedAt, records };
}

export function createReviewTransfer(storage: Pick<Storage, 'getItem'>, identities: ReviewIdentity[],
  exportedAt = new Date().toISOString()): ReviewTransfer {
  const records: ReviewTransfer['records'] = [];
  for (const identity of identities) {
    const review = readReview(storage, identity);
    if (review.record && !review.stale) records.push({ storageKey: identity.storageKey, record: review.record });
  }
  return parseReviewTransfer(`${JSON.stringify({ format: 'agentxray-review-transfer', version: 1, exportedAt, records }, null, 2)}\n`);
}

function transferDecision(storage: Pick<Storage, 'getItem'>, entry: ReviewTransfer['records'][number],
  identities: Map<string, string>): TransferDecision {
  const fingerprint = identities.get(entry.storageKey);
  if (!fingerprint) return 'unmatched';
  if (fingerprint !== entry.record.fingerprint) return 'stale';
  const raw = storage.getItem(entry.storageKey);
  if (raw === null) return 'import';
  try {
    const current = validateRecord(JSON.parse(raw));
    if (JSON.stringify(current) === JSON.stringify(entry.record)) return 'duplicate';
  } catch {}
  return 'conflict';
}

export function previewReviewTransfer(storage: Pick<Storage, 'getItem'>, transfer: ReviewTransfer,
  identities: ReviewIdentity[]): TransferPreview[] {
  const checked = parseReviewTransfer(JSON.stringify(transfer));
  const current = new Map(identities.map((identity) => [identity.storageKey, identity.fingerprint]));
  return checked.records.map((entry) => ({ ...entry, decision: transferDecision(storage, entry, current) }));
}

export function importReviewTransfer(storage: Pick<Storage, 'getItem' | 'setItem'>, transfer: ReviewTransfer,
  identities: ReviewIdentity[]): TransferResult {
  const preview = previewReviewTransfer(storage, transfer, identities);
  const current = new Map(identities.map((identity) => [identity.storageKey, identity.fingerprint]));
  const result = { imported: 0, skipped: 0, failed: 0 };
  for (const entry of preview) {
    try {
      if (transferDecision(storage, entry, current) !== 'import') {
        result.skipped++;
        continue;
      }
      storage.setItem(entry.storageKey, JSON.stringify(entry.record));
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
