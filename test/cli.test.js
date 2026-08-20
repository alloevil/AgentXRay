const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'agentxray.js');
const pkg = require(path.join(__dirname, '..', 'package.json'));

test('--version prints the package version and exits 0', () => {
  const out = execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkg.version);
});

test('-v is an alias for --version', () => {
  const out = execFileSync(process.execPath, [BIN, '-v'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkg.version);
});

test('--help documents the --version flag', () => {
  const out = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(out, /--version/);
});

test('unknown option exits non-zero', () => {
  assert.throws(() => execFileSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8', stdio: 'pipe' }));
});
