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
  const [key, fingerprint] = await Promise.all([
    digest(identity),
    digest([1, identity, event.failures.map((failure) => ({
      index: failure.index, reason: failure.reason, message: failure.message,
    }))]),
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
