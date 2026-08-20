// Registry contract: every platform entry must expose the interface the
// generic routes (sessions/search/watch/insights/export/otlp) rely on.
// Guards against a new adapter being registered with a missing capability.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { PLATFORMS, collectSessionFiles } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { makeMessage } = require(path.join(__dirname, '..', 'lib', 'platforms', 'shared'));
const { EXPORT_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'export'));
const { OTLP_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'otlp'));
const { TOOL_AUDIT_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'tool-audit'));

const FILE_PLATFORMS = ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini'];

test('registry contains every platform with id, label and defaultDir', () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), [...FILE_PLATFORMS, 'hermes'].sort());
  for (const [key, p] of Object.entries(PLATFORMS)) {
    assert.equal(p.id, key);
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.defaultDir(), 'string');
    assert.equal(typeof p.getSession, 'function', `${key} missing getSession`);
  }
});

test('file-based platforms expose find/parse/collectFiles/watchParse', () => {
  for (const key of FILE_PLATFORMS) {
    const p = PLATFORMS[key];
    assert.equal(typeof p.find, 'function', `${key} missing find`);
    assert.equal(typeof p.parse, 'function', `${key} missing parse`);
    assert.equal(typeof p.collectFiles, 'function', `${key} missing collectFiles`);
    assert.equal(typeof p.watchParse, 'function', `${key} missing watchParse`);
  }
  // hermes is SQLite-backed: no session files to find/collect/tail
  assert.equal(PLATFORMS.hermes.find, null);
  assert.equal(PLATFORMS.hermes.collectFiles, null);
});

test('derived registries stay in sync with PLATFORMS', () => {
  // Export covers every platform; OTLP every file platform except openclaw
  assert.deepEqual(Object.keys(EXPORT_PLATFORMS).sort(), Object.keys(PLATFORMS).sort());
  assert.deepEqual(Object.keys(OTLP_PLATFORMS).sort(), FILE_PLATFORMS.filter((k) => !PLATFORMS[k].needsAgent).sort());
  assert.deepEqual([...TOOL_AUDIT_PLATFORMS].sort(), FILE_PLATFORMS.sort());
});

test('makeMessage carries the full normalized shape and applies overrides', () => {
  const base = makeMessage({});
  assert.deepEqual(Object.keys(base).sort(), [
    'content',
    'details',
    'id',
    'isError',
    'model',
    'provider',
    'role',
    'timestamp',
    'toolCallId',
    'toolName',
    'usage',
  ]);
  const m = makeMessage({ role: 'toolCall', toolCallId: 'c1', toolName: 'bash' });
  assert.equal(m.role, 'toolCall');
  assert.equal(m.toolCallId, 'c1');
  assert.equal(m.toolName, 'bash');
  assert.deepEqual(m.content, []);
  assert.equal(m.isError, false);
});

test('collectSessionFiles returns [] for unknown or file-less platforms', async () => {
  assert.deepEqual(await collectSessionFiles('nope', '', ''), []);
  assert.deepEqual(await collectSessionFiles('hermes', '', ''), []);
});
