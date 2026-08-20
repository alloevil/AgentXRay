// Shared markdown block component. The escape-then-transform pipeline lives
// in @/lib/markdown (single definition site, also bundled into the legacy
// UI's public/js/pure.js by scripts/build-legacy-pure.mjs).

import { useMemo } from 'react';
import { renderMarkdownHtml } from '@/lib/markdown';
import { cn } from '@/lib/utils';

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

export { renderMarkdownHtml };

/** Markdown block with Tailwind-scoped styles. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdownHtml(text), [text]);
  return <div className={cn('markdown', MARKDOWN_STYLES, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
