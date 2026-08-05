const crypto = require('crypto');

function normalizePromptText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashPromptText(normalized) {
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

// Extract first non-empty text line from content array
function extractErrorSnippet(content) {
  const texts = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === 'text' && c.text) texts.push(c.text);
      else if (typeof c === 'string') texts.push(c);
    }
  } else if (typeof content === 'string') {
    texts.push(content);
  }
  const joined = texts.join('\n');
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip purely structural lines ({ } [ ] ``` etc.) so JSON-body errors
    // don't reduce to a single symbol in the clusters view
    if (/^[{}[\]()`"',;:.\-=|\\/*+\s]+$/.test(line)) continue;
    return line.slice(0, 200);
  }
  return joined.trim().replace(/\s+/g, ' ').slice(0, 200);
}

// Normalize error pattern: take first line, lowercase, strip variable parts
function normalizeErrorPattern(snippet) {
  if (!snippet) return '(empty)';
  const line = snippet.split('\n')[0].trim().toLowerCase();
  // Strip file paths
  const stripped = line.replace(/\/[^\s]+/g, '/…');
  // Strip hex ids
  return stripped.replace(/[0-9a-f]{8,}/g, '…').slice(0, 120);
}

module.exports = { normalizePromptText, hashPromptText, extractErrorSnippet, normalizeErrorPattern };
