const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HOME } = require('./config');

// --- LLM backend abstraction (#14) ---
// Every LLM-backed feature (prompt rewrites, cluster suggestions, name
// suggestions) goes through runLlm(). Backend priority:
//   1. Explicit OpenAI-compatible endpoint from ~/.agentxray/llm.json
//      (baseUrl + model required, apiKey optional for local servers).
//   2. A `claude` CLI on PATH (the original behavior).
// With neither available, runLlm throws err.code = 'NO_LLM_BACKEND' whose
// message carries setup guidance — routes surface it instead of a grey button.

const LLM_CONFIG_FILE = path.join(HOME, '.agentxray', 'llm.json');
// Test seam: point at a nonexistent binary to simulate a machine without claude.
const CLAUDE_BIN = process.env.AGENTXRAY_CLAUDE_BIN || 'claude';

const EMPTY_CONFIG = { baseUrl: '', apiKey: '', model: '' };

async function loadLlmConfig() {
  try {
    const parsed = JSON.parse(await fsp.readFile(LLM_CONFIG_FILE, 'utf8'));
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

// Atomic write: tmp file + rename so a crash never truncates the store.
async function saveLlmConfig(config) {
  const next = {
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '',
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
  };
  await fsp.mkdir(path.dirname(LLM_CONFIG_FILE), { recursive: true });
  const tmpPath = `${LLM_CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, LLM_CONFIG_FILE);
  return next;
}

// Cheap PATH scan (no subprocess): is a claude CLI available?
function findClaudeCli() {
  if (path.isAbsolute(CLAUDE_BIN)) {
    try {
      fs.accessSync(CLAUDE_BIN, fs.constants.X_OK);
      return CLAUDE_BIN;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, CLAUDE_BIN);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function runClaudeCli(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN, ['-p'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runOpenAi(config, input, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: input }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM 端点返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) {
      throw new Error('LLM 端点响应缺少 choices[0].message.content');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Which backend would runLlm use right now? 'openai' | 'claude-cli' | null.
async function llmBackend() {
  const config = await loadLlmConfig();
  if (config.baseUrl && config.model) return 'openai';
  return findClaudeCli() ? 'claude-cli' : null;
}

async function runLlm(input, timeoutMs) {
  const config = await loadLlmConfig();
  if (config.baseUrl && config.model) return runOpenAi(config, input, timeoutMs);
  if (findClaudeCli()) return runClaudeCli(input, timeoutMs);
  const err = new Error(
    '未配置 LLM 后端：在 设置 → LLM 接口 填入 OpenAI 兼容端点的 Base URL 与模型名（API Key 视端点可选），或安装并登录 claude CLI（npm i -g @anthropic-ai/claude-code）。'
  );
  err.code = 'NO_LLM_BACKEND';
  throw err;
}

module.exports = {
  LLM_CONFIG_FILE,
  loadLlmConfig,
  saveLlmConfig,
  findClaudeCli,
  llmBackend,
  runLlm,
};
