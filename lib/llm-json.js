function parseLlmJson(raw) {
  const text = String(raw || '').trim();
  const candidates = [text];
  // Anchored fence: whole reply wrapped in one ```json ... ``` block
  // (fences INSIDE the JSON strings would truncate a non-greedy match)
  const anchored = text.match(/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/);
  if (anchored) candidates.push(anchored[1]);
  // First fenced block (legacy behavior)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  // Outermost braces/brackets span
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      /* try next strategy */
    }
  }
  // Last resort: repair unescaped double quotes inside string values
  // (LLMs often quote 中文 with literal " — a " inside a string is treated
  // as content unless the next non-space char is structural).
  for (const candidate of candidates.slice().reverse()) {
    try {
      return JSON.parse(repairLlmJsonQuotes(candidate.trim()));
    } catch {
      /* try next */
    }
  }
  return null;
}

function repairLlmJsonQuotes(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] || '');
      i++;
      continue;
    }
    if (ch === '"') {
      // Real terminator only when followed by a structural char
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      const next = text[j];
      if (
        next === undefined ||
        next === ',' ||
        next === '}' ||
        next === ']' ||
        next === ':' ||
        next === '\n' ||
        next === '\r'
      ) {
        inString = false;
        out += ch;
      } else {
        out += '\\"'; // content quote — escape it
      }
      continue;
    }
    out += ch;
  }
  return out;
}

module.exports = { parseLlmJson, repairLlmJsonQuotes };
