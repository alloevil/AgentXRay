// Pure (no-DOM) markdown pipeline shared by the React UI (<Markdown/>) and,
// via the generated public/js/pure.js bundle, the frozen legacy UI.
// Escape-then-transform semantics: the whole input is HTML-escaped first, so
// the generated markup only ever contains tags we emit ourselves.

export function escapeHtml(value: unknown): string {
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

/** Inner HTML of the markdown container (no wrapper element). */
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

/** Legacy-shaped block: renderMarkdownHtml wrapped in `<div class="markdown">`. */
export function renderMarkdown(text: string): string {
  return `<div class="markdown">${renderMarkdownHtml(text)}</div>`;
}
