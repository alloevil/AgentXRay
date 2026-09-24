const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { fail, hash } = require('./capture.cjs');

const PREFIX = 'AXR_REDACTED_';
const CONFIG = path.join(__dirname, 'scan.toml');
const credentialKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|cookie|set-cookie|full[_-]?name|phone|mobile|telephone|ssn|national[_-]?id|id[_-]?card|bank[_-]?account|姓名|手机号|身份证号)$/i;

function decode(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('NON_UTF8_DISCLOSURE'); }
  if (text.includes('\0')) fail('BINARY_DISCLOSURE');
  return text;
}

function walk(value, transform, sensitive = () => {}, depth = 0) {
  if (depth > 40) fail('STRUCTURE_DEPTH_LIMIT');
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      let nested;
      try { nested = JSON.parse(value); } catch {}
      if (nested && typeof nested === 'object') return JSON.stringify(walk(nested, transform, sensitive, depth + 1));
    }
    return transform(value);
  }
  if (Array.isArray(value)) return value.map((entry) => walk(entry, transform, sensitive, depth + 1));
  if (value && typeof value === 'object') {
    if (['image', 'image_url', 'audio', 'input_audio'].includes(value.type)) fail('UNSUPPORTED_MEDIA');
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (credentialKey.test(key) && entry !== null && entry !== '') {
        if (typeof entry !== 'string') fail('UNSUPPORTED_CREDENTIAL_TYPE');
        sensitive(entry);
      }
      const renamed = transform(key);
      if (Object.hasOwn(result, renamed)) fail('KEY_COLLISION');
      result[renamed] = walk(entry, transform, sensitive, depth + 1);
    }
    return result;
  }
  return value;
}

function document(text, kind, transform, sensitive) {
  if (kind === 'jsonl') return text.split('\n').map((line) => line.trim() ? JSON.stringify(walk(JSON.parse(line), transform, sensitive)) : line).join('\n');
  if (kind === 'json') return JSON.stringify(walk(JSON.parse(text), transform, sensitive), null, 2) + '\n';
  return transform(text);
}

function privateIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return [0, 10, 127].includes(first) || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

function discover(text, add) {
  for (const match of text.matchAll(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g)) add(match[0]);
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) add(match[0]);
  for (const match of text.matchAll(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g)) add(match[0]);
  for (const match of text.matchAll(/(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g)) add(match[0]);
  for (const match of text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) add(match[0]);
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`\])}]+/gi)) add(match[0]);
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) if (privateIPv4(match[0])) add(match[0]);
  for (const match of text.matchAll(/(?:\b(?:fc|fd)[a-f0-9]{2}:[a-f0-9:]+|\bfe80:[a-f0-9:%]+|::1\b)/gi)) add(match[0]);
  for (const match of text.matchAll(/\b[A-Z0-9_-]+(?:\.[A-Z0-9_-]+)*\.(?:internal|local|lan|corp)\b/gi)) add(match[0]);
  for (const match of text.matchAll(/\/(?:home|Users|mnt|srv)\/[^\s"'<>`\])},;]+/g)) add(match[0]);
  for (const match of text.matchAll(/[A-Z]:\\+(?:Users|Documents and Settings)\\+[^\s"'<>`\])},;]+/gi)) add(match[0]);
  for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9+/_=.:-]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\b\s*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi)) add(match[1]);
  for (const match of text.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*=\s*([^\s"'`;]+)/gi)) add(match[1]);
}

function scan(texts) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-private-scan-'));
  fs.chmodSync(temporary, 0o700);
  const root = path.join(temporary, 'texts');
  fs.mkdirSync(root, { mode: 0o700 });
  const report = path.join(temporary, 'findings.json');
  const ignored = path.join(temporary, 'empty.ignore');
  fs.writeFileSync(ignored, '', { mode: 0o600 });
  fs.writeFileSync(report, '[]', { mode: 0o600 });
  try {
    texts.forEach((text, index) => fs.writeFileSync(path.join(root, `${index}.txt`), text, { mode: 0o600 }));
    const environment = { PATH: process.env.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary };
    const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8', timeout: 5000, env: environment });
    if (version.status !== 0) fail('SCANNER_UNAVAILABLE');
    const execution = spawnSync('gitleaks', ['dir', root, '--config', CONFIG, '--gitleaks-ignore-path', ignored,
      '--ignore-gitleaks-allow', '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '30',
      '--max-decode-depth', '5', '--report-format', 'json', '--report-path', report], {
      cwd: temporary, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024, env: environment,
    });
    if (execution.error || ![0, 1].includes(execution.status)) fail('SCANNER_FAILED');
    const findings = JSON.parse(fs.readFileSync(report, 'utf8'));
    if (!Array.isArray(findings) || (execution.status === 0) !== (findings.length === 0)) fail('SCANNER_RESULT_INVALID');
    return { findings, version: version.stdout.trim(), configHash: hash(fs.readFileSync(CONFIG)) };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function makeRedactor(documents, privateTerms = []) {
  if (!Array.isArray(privateTerms) || privateTerms.some((term) => typeof term !== 'string' || !term)) fail('INVALID_PRIVATE_TERMS');
  const leaves = [];
  const literals = new Set(privateTerms);
  const add = (value) => { if (value) literals.add(value); };
  for (const entry of documents) document(entry.text, entry.kind, (text) => { leaves.push(text); discover(text, add); return text; }, add);
  if (leaves.some((text) => text.includes(PREFIX))) fail('RESERVED_PLACEHOLDER_PRESENT');
  if (leaves.some((text) => /[A-Za-z0-9+/]{256,}={0,2}/.test(text))) fail('UNSUPPORTED_ENCODED_CONTENT');
  const before = scan(leaves);
  for (const finding of before.findings) {
    if (typeof finding.Secret !== 'string' || !finding.Secret || !leaves.some((text) => text.includes(finding.Secret))) fail('UNHANDLED_SECRET_ENCODING');
    add(finding.Secret);
  }
  if (literals.size > 4096 || [...literals].reduce((sum, value) => sum + value.length, 0) > 1024 * 1024) fail('REPLACEMENT_LIMIT');
  const mapping = [...literals].sort((left, right) => right.length - left.length || left.localeCompare(right)).map((original, index) => {
    const marker = `${PREFIX}${String(index + 1).padStart(6, '0')}`;
    const replacement = original.startsWith('/') ? `/${marker}` : /^[A-Z]:\\/i.test(original) ? `${original.slice(0, 3)}${marker}` : marker;
    return { original, replacement };
  });
  const table = new Map(mapping.map((entry) => [entry.original, entry.replacement]));
  const inverse = new Map(mapping.map((entry) => [entry.replacement, entry.original]));
  const pattern = mapping.length ? new RegExp(mapping.map((entry) => entry.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const inversePattern = mapping.length ? new RegExp(mapping.map((entry) => entry.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((left, right) => right.length - left.length).join('|'), 'g') : null;
  const replace = (text) => {
    const result = pattern ? text.replace(pattern, (match) => table.get(match)) : text;
    const restored = inversePattern ? result.replace(inversePattern, (match) => inverse.get(match)) : result;
    if (restored !== text) fail('NON_INJECTIVE_REPLACEMENT');
    return result;
  };
  const transform = (text, kind = 'text') => document(text, kind, replace);
  const transformed = documents.map((entry) => ({ ...entry, text: transform(entry.text, entry.kind) }));
  const outputs = [];
  for (const entry of transformed) document(entry.text, entry.kind, (text) => { outputs.push(text); return text; });
  const residual = new Set();
  outputs.forEach((text) => discover(text, (value) => { if (!/^AXR_REDACTED_[0-9]{6}$/.test(value)) residual.add(value); }));
  if (residual.size) fail('RECOGNIZED_DATA_REMAINS');
  const after = scan(outputs);
  if (after.version !== before.version || after.configHash !== before.configHash) fail('SCANNER_CHANGED_DURING_REDACTION');
  if (after.findings.length) fail('SECRET_SCAN_NOT_CLEAN');
  return { transform, mapping, transformed, scanner: { version: after.version, configHash: after.configHash,
    initialFindings: before.findings.length, residualFindings: after.findings.length }, replacements: mapping.length };
}

module.exports = { decode, document, makeRedactor, scan, discover };
