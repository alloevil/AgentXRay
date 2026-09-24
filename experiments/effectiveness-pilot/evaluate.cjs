const vm = require('node:vm');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = [];
for (const entry of input.cases) {
  try {
    const source = `${input.source}\nJSON.stringify(solve(${JSON.stringify(entry.input)}));`;
    const actual = new vm.Script(source).runInNewContext(Object.create(null), { timeout: 250, contextCodeGeneration: { strings: false, wasm: false } });
    const parsed = JSON.parse(actual);
    results.push({ passed: isDeepStrictEqual(parsed, entry.expected), actual: parsed });
  } catch (error) { results.push({ passed: false, error: String(error.message).slice(0, 200) }); }
}
process.stdout.write(JSON.stringify({ passed: results.every((result) => result.passed), cases: results }));
