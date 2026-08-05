// Shared markdown renderer — verbatim port of public/js/app.js
// renderMarkdown / renderMarkdownBlock / renderMarkdownInline / escapeHtml.
// Escape-then-transform semantics preserved: the whole input is HTML-escaped
// first, so the generated markup only ever contains tags we emit ourselves.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownInline(s: string): string {
  // s is already HTML-escaped. Apply inline markdown.
  // Links [text](url) — url may contain &amp; from escaping, which is valid in href
  s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function renderMarkdownBlock(segment: string): string {
  const lines = segment.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    const text = para.join('\n').replace(/^\n+|\n+$/g, '');
    if (text.trim()) out.push(`<p>${renderMarkdownInline(text).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.join('')}</${list.type}>`);
    list = null;
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${renderMarkdownInline(h[2])}</h${h[1].length}>`);
    } else if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(`<li>${renderMarkdownInline(ul[1])}</li>`);
    } else if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(`<li>${renderMarkdownInline(ol[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

/** Inner HTML of the legacy `<div class="markdown">` wrapper. */
export function renderMarkdownHtml(text: string): string {
  const escaped = escapeHtml(text);
  const segments = escaped.split(/```/);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.split('\n');
        const maybeLang = lines[0].trim();
        const code = lines.slice(1).join('\n') || lines.join('\n');
        return `<pre><code data-lang="${escapeHtml(maybeLang)}">${code}</code></pre>`;
      }
      return renderMarkdownBlock(segment);
    })
    .join('');
}

const MARKDOWN_STYLES =
  'break-words text-sm leading-relaxed ' +
  '[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold ' +
  '[&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold ' +
  '[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold ' +
  '[&_h4]:mt-2 [&_h4]:text-sm [&_h4]:font-semibold ' +
  '[&_h5]:mt-2 [&_h5]:text-sm [&_h5]:font-semibold ' +
  '[&_h6]:mt-2 [&_h6]:text-sm [&_h6]:font-semibold ' +
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 ' +
  '[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2.5 ' +
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] ' +
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_strong]:font-semibold';

/** Legacy-parity markdown block (`renderMarkdown` in app.js), Tailwind-scoped styles. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  return <div className={cn('markdown', MARKDOWN_STYLES, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
