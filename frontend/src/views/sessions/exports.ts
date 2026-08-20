// Session export: markdown serializer + blob downloads + OTLP fetch — ported
// from legacy sessionToMarkdown/exportAs* (public/js/app.js).

import { toast } from 'sonner';
import { exportUrl, getOtlp } from '@/api/client';
import type { Platform, SessionDetail } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { getTextContent } from '@/lib/pure';
import { formatDate } from './lib';

export function sessionToMarkdown(detail: SessionDetail, platform: Platform, selectedSessionId: string): string {
  const session = detail.session || ({} as SessionDetail['session']);
  const msgs = detail.messages || [];
  const lines: string[] = [];

  lines.push(`# Session: ${session.id || selectedSessionId}`);
  lines.push('');
  if (session.timestamp) lines.push(`**Date:** ${formatDate(session.timestamp)}`);
  if (session.cwd) lines.push(`**Working Directory:** ${session.cwd}`);
  lines.push(`**Platform:** ${platform || 'unknown'}`);
  lines.push(`**Messages:** ${msgs.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of msgs) {
    const ts = msg.timestamp ? formatDate(msg.timestamp) : '';
    const text = getTextContent(msg.content);

    if (msg.role === 'user') {
      lines.push(`## 👤 User ${ts ? `(${ts})` : ''}`);
      lines.push('');
      lines.push(text);
      lines.push('');
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg.content || []).filter((c) => c.type === 'toolCall');
      if (msg.reasoning) {
        lines.push(`### 💭 Reasoning ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(msg.reasoning);
        lines.push('');
      }
      if (text.trim()) {
        lines.push(`## 🤖 Assistant ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(text);
        lines.push('');
      }
      for (const tc of toolCalls) {
        lines.push(`### 🔧 Tool Call: ${tc.name || 'unknown'}`);
        lines.push('');
        const args = tc.arguments || tc.input || {};
        lines.push('```json');
        lines.push(JSON.stringify(args, null, 2));
        lines.push('```');
        lines.push('');
      }
    } else if (msg.role === 'toolResult') {
      const name = msg.toolName || (msg.name as string | undefined) || '';
      lines.push(`### ${msg.isError ? '❌' : '📋'} Tool Result${name ? ': ' + name : ''} ${ts ? `(${ts})` : ''}`);
      lines.push('');
      const output = text || (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2));
      // Truncate very long tool outputs
      const maxLen = 2000;
      lines.push('```');
      lines.push(
        output.length > maxLen ? output.slice(0, maxLen) + `\n\n... (truncated, ${output.length} chars total)` : output
      );
      lines.push('```');
      lines.push('');
    } else if (msg.role === 'toolCall') {
      // Codex-style separate toolCall
      const name = msg.toolName || (msg.name as string | undefined) || 'unknown';
      lines.push(`### 🔧 Tool Call: ${name} ${ts ? `(${ts})` : ''}`);
      lines.push('');
      const args = msg.details || (msg.arguments as Record<string, unknown> | undefined) || {};
      lines.push('```json');
      lines.push(JSON.stringify(args, null, 2));
      lines.push('```');
      lines.push('');
    } else if (msg.role === 'reasoning') {
      if (text.trim()) {
        lines.push(`### 💭 Reasoning ${ts ? `(${ts})` : ''}`);
        lines.push('');
        lines.push(text);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Sanitize: keep alphanumeric, dash, underscore
export function exportFilename(detail: SessionDetail | undefined, selectedSessionId: string, ext: string): string {
  const id = detail?.session?.id || selectedSessionId || 'session';
  return `agentxray-${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}.${ext}`;
}

export type ExportFormat = 'markdown' | 'html' | 'json' | 'clipboard' | 'otlp';

export async function runExport(
  format: ExportFormat,
  detail: SessionDetail,
  platform: Platform,
  selectedSessionId: string,
  dir: string | undefined,
  agent?: string
): Promise<'copied' | void> {
  if (format === 'markdown' || format === 'html') {
    if (DEMO) {
      // No backend in demo mode — fall back to the client-side markdown serializer.
      downloadFile(
        sessionToMarkdown(detail, platform, selectedSessionId),
        exportFilename(detail, selectedSessionId, 'md'),
        'text/markdown;charset=utf-8'
      );
      return;
    }
    // Server-rendered export: shareable Markdown / self-contained HTML with
    // best-effort secret redaction. Content-Disposition drives the filename.
    const a = document.createElement('a');
    a.href = exportUrl(platform, selectedSessionId, format === 'html' ? 'html' : 'md', { agent, dir });
    a.download = '';
    a.click();
  } else if (format === 'json') {
    downloadFile(
      JSON.stringify(detail, null, 2),
      exportFilename(detail, selectedSessionId, 'json'),
      'application/json;charset=utf-8'
    );
  } else if (format === 'clipboard') {
    const md = sessionToMarkdown(detail, platform, selectedSessionId);
    await navigator.clipboard.writeText(md);
    return 'copied';
  } else if (format === 'otlp') {
    try {
      const data = await getOtlp(platform, selectedSessionId, dir);
      downloadFile(JSON.stringify(data, null, 2), `${selectedSessionId}-otlp.json`, 'application/json;charset=utf-8');
    } catch (error) {
      toast.error('OTLP 导出失败: ' + (error as Error).message);
    }
  }
}
