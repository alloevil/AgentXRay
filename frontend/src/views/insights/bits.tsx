// Small presentational pieces shared by the two insights variants.

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Legacy token compact format: 1.2M / 3.4K / 999 */
export function fmtTokens(total: number): string {
  return total >= 1_000_000
    ? (total / 1_000_000).toFixed(1) + 'M'
    : total >= 1_000
      ? (total / 1_000).toFixed(1) + 'K'
      : total.toString();
}

export function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

/** 📍/🌐 scope chip (legacy .scope-chip) */
export function ScopeChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 align-middle text-xs font-normal tracking-normal text-muted-foreground">
      {children}
    </span>
  );
}

/** Overview stat card (legacy .insight-card) */
export function StatCard({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'error' | 'token' | 'cost';
}) {
  return (
    <div className="min-w-[120px] flex-1 rounded-lg border border-border bg-card px-4 py-3">
      <div
        className={cn(
          'text-2xl font-semibold',
          tone === 'error' && 'text-destructive',
          tone === 'token' && 'text-[#d29922]',
          tone === 'cost' && 'text-[#3fb950]'
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

/** Horizontal usage bar (legacy .tool-stats-bar) */
export function UsageBar({ pct, error }: { pct: number; error?: boolean }) {
  return (
    <div className="h-1.5 w-full min-w-[80px] overflow-hidden rounded bg-secondary">
      <div
        className={cn('h-full rounded', error ? 'bg-destructive' : 'bg-primary')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Section card wrapper (legacy .insight-section) */
export function InsightSection({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-card p-4', className)}>
      {title != null && (
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

/**
 * 全局分析 / 本会话分析 segmented control. `active` reflects what is actually
 * rendered; the sticky user choice lives in the store and never morphs
 * implicitly (legacy insightsScopeSegHtml + bindInsightsScopeSeg).
 */
export function InsightsScopeSeg({
  active,
  hasSession,
  onChange,
}: {
  active: 'global' | 'session';
  hasSession: boolean;
  onChange: (scope: 'global' | 'session') => void;
}) {
  const segBtn = (scope: 'global' | 'session', label: string, title: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!disabled && scope !== active) onChange(scope);
      }}
      className={cn(
        'rounded-md px-3 py-1 text-sm transition-colors',
        active === scope
          ? 'bg-primary/20 text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground'
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-panel-alt p-1">
      {segBtn('global', '全局分析', '聚合当前平台所有会话的统计')}
      {segBtn('session', '本会话分析', hasSession ? '仅分析当前选中的会话' : '需先选中会话', !hasSession)}
    </div>
  );
}
