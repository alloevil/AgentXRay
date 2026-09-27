# Offline evidence for agents and automation

AgentXRay's UI is useful for people, but a coding agent, local script or CI step should not need to launch a web server to inspect recorded execution evidence. `inspect` uses the same diagnostic source as the React view and produces a versioned report with original line references.

It reads exactly one file you specify. It does not discover your sessions, connect to model APIs, execute logged commands, create an archive, read review notes or start the dashboard.

For a question-led investigation rather than an automatic task score, see
[single-session forensics](session-forensics.md): a real-log background-process
case study, source-line verification and the actual retrieval costs/limitations.

## Layered CLI: summary first, evidence on demand

Version **1.24.0** adds `inspect --summary --json`, an explicit `evidence`
command and structured JSON failures. The full successful `inspect --json`
report and default text report retain their schema and behavior; the reported
package version advances. Examples below use a source checkout; replace
`node bin/agentxray.js` with installed `agentxray` to use the same arguments.

```sh
node bin/agentxray.js inspect --platform omp /path/to/session.jsonl --summary --json
```

The summary has `schemaVersion: 1`, `kind: "summary"`, source/engine hashes, the
same `complete` flag and health counts as the full report, coverage issue count,
process-state totals and modification/check counts. It does not contain raw
prompts, commands, outputs or private paths. Each of the `references.failures`,
`gaps`, `processes`, `chronology` and `coverage` categories has:

```json
{
  "total": 50,
  "shown": 5,
  "truncated": true,
  "items": [
    {"line":4,"messageIndex":4},
    {"line":6,"messageIndex":7},
    {"line":8,"messageIndex":10},
    {"line":10,"messageIndex":13},
    {"line":12,"messageIndex":16}
  ]
}
```

The example above illustrates the shape only, not a measured session.
At most five unique references per category are returned, ordered by physical
line and normalized message position. Failure-category references also include
related operations, so their total is not a failure count. Categories overlap;
do not sum reference totals to count operations. `coverage` references have only
a physical line. A truncated list requires the full report for remaining
references; this is not a priority ranking or automatic next-action policy.

To read actual evidence, copy `source.sha256` and a reference's `line` from
either report:

```sh
node bin/agentxray.js evidence --platform omp /path/to/session.jsonl \
  --sha256 <source.sha256> --line <reference.line> --json
```

Replace angle-bracket placeholders with the actual hash and integer before
running. This **explicitly returns raw source content**, possibly containing
credentials, prompts or untrusted instructions. Do not execute it or automatically
send it to a remote model. A hash checks identity against a previous report; it
is not authorization, sanitization or proof of authenticity.

Evidence always emits JSON (`--json` is optional), with `kind: "evidence"`,
`source`, `reference.line`, `content`, `offset`, `totalBytes`, `returnedBytes`,
`truncated`, `nextOffset`, `complete` and `coverageIssueCount`. It reads and
validates one stable snapshot and refuses a hash mismatch before returning any
raw content. It does not guess a new hash, retry a changed file or resolve a
session automatically.

- Select exactly one **one-based physical JSONL line**; it may contain multiple
  normalized messages. `messageIndex` is not a physical line number.
  Any existing physical line, including metadata or a blank line, can be
  selected explicitly; the command does not infer an event or automatically
  fetch a matching call, result or adjacent record.
- Default cap: **4096 UTF-8 content bytes**; `--max-bytes` accepts **4–16384**.
  JSON escaping/envelope overhead can make stdout larger than that cap.
- Use `--offset` with the previous page's `nextOffset` to continue within the
  same line and hash. Offsets count bytes, not characters. Non-boundary UTF-8
  offsets and out-of-range values fail instead of being silently adjusted.
- `nextOffset: null` means the end of the selected line; `truncated` is true
  when either its beginning or end is absent from this page. An offset exactly
  at the end returns empty content and no next page.
- LF separators are excluded; CR in CRLF and an initial UTF-8 BOM are preserved.
  Blank lines retain their physical positions. A page is not necessarily valid
  standalone JSON: accumulate the line before parsing it if that is required.
- `complete` still means known adapter identity coverage, not correct code.
  Incomplete coverage returns data with `complete:false`, exit 1 and a separate
  structured stderr diagnostic. `evidence` has no pending-failures exit policy.

Summary generation still analyzes the full input; evidence revalidates its
snapshot. These are bounded **output** interfaces, not streaming/incremental
analysis or a promised reduction in CPU/runtime. There is no MCP service,
session discovery, background watcher or automatic command execution.

## Structured errors and compatibility

For `inspect --json` or `evidence`, an argument/read/parse/runtime failure writes
one JSON error object to stdout and exits 1:

```json
{"schemaVersion":1,"kind":"error","error":{"code":"INPUT_UNREADABLE","message":"Cannot read input file. Check that it exists and is readable."}}
```

This deliberately replaces the old empty-stdout-on-failure behavior in JSON
mode. Stderr also contains a concise human message; neither channel exposes raw
input, paths or stack traces. Text-mode inspect keeps errors on stderr only.
`--help` remains text. Consumers must check exit code, `kind` and `complete`, not
assume every valid JSON object is a report or that exit 0 proves task success.

| Code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Missing/duplicate/unknown option, invalid range or incompatible mode |
| `UNSUPPORTED_PLATFORM` | Choose OMP, Codex or Claude Code explicitly |
| `INPUT_UNREADABLE`, `NOT_REGULAR_FILE`, `INPUT_TOO_LARGE` | Input could not be read under the single-file contract |
| `INPUT_CHANGED` | File metadata or readable length changed during the snapshot read |
| `INVALID_UTF8`, `INVALID_JSON`, `INVALID_RECORD`, `UNSUPPORTED_RECORD` | Invalid encoding, line syntax, object or adapter record shape |
| `NO_SUPPORTED_MESSAGES`, `ANALYSIS_FAILED` | Selected platform has no usable messages, or analysis cannot handle the structure |
| `RULES_UNAVAILABLE`, `INSPECTION_FAILED` | Bundled implementation unavailable or unexpected runtime failure |
| `SOURCE_HASH_MISMATCH` | Evidence input differs from the report; re-inspect before expanding |
| `LINE_OUT_OF_RANGE`, `OFFSET_OUT_OF_RANGE`, `INVALID_OFFSET` | Invalid physical line or byte position |
| `COVERAGE_INCOMPLETE` | Data retained on stdout, JSON error diagnostic on stderr, exit 1 |

Coverage incompleteness is the exception to the stdout error envelope: the full
report remains byte-compatible, while the summary/evidence retain their own
data and `kind`. Never mistake that retained partial data for complete coverage.

## Quick start

After installing AgentXRay, or through `npx`:

```sh
agentxray inspect --platform codex /path/to/session.jsonl
agentxray inspect --platform omp /path/to/session.jsonl --json > evidence.json
npx @alloevil/agent-xray inspect --platform claude-code /path/to/session.jsonl --json
```

`npx`/package installation may access the npm registry. The **inspect command itself** does not use network services. Prefer an installed, pinned package in repeatable or network-isolated jobs.

From a source checkout with dependencies installed:

```sh
npm run build:diagnostics
node bin/agentxray.js inspect --platform omp \
  frontend/demo/sample-logs/omp/-demo-diagnostics/2026-09-23T08-00-00-000Z_0199demo-diagnostics.jsonl --json
```

This synthetic sample reports 8 historical failures, 7 pending records in 2 events, and 1 matching recovery. **Default exit status is zero even when there are findings**: it means the report was produced, not that the agent's task passed.

### Input contract

- Required `--platform`: `codex`, `omp` or `claude-code`. These are the formats validated for the offline path; the dashboard supports additional platforms, but this command does not claim parity for their containers/databases.
- Exactly one regular, stable UTF-8 JSONL file, at most **64 MiB**. No directories, stdin, compressed streams or database files. Use `--` before a filename beginning with `-`.
- Reads the initial file length and checks metadata again after reading. If the source changed, retry when it is stable. The output hash identifies the bytes actually analyzed; this is not a filesystem transaction or tamper-proof archive.
- Invalid UTF-8, malformed/truncated JSON, non-object records, incompatible shape, empty/metadata-only input and wrong selected format fail rather than being silently treated as clean sessions. Valid last lines need not end with a newline; blank lines are counted in physical line positions.
- Known metadata/unhandled records are counted as ignored. Recognized raw tool-call/result IDs are checked against normalization per line. Known loss (for example a Claude multi-result or mixed text/result record not fully represented by the adapter) produces `complete:false` and a coverage issue. This is honest reporting of adapter limits, not a new parser that fixes those formats.

## Report contract: schemaVersion 1

`--json` writes one JSON document to stdout. Successful full reports keep the following schema. In the layered CLI described above, parsing/read failures produce a `kind:"error"` envelope rather than a report; known adapter coverage gaps retain the report with `complete:false`, exit 1 and a structured stderr diagnostic. Neither error channel contains original paths, input text or stack traces.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Report contract version, currently 1. Check it before consuming fields. |
| `complete` | The input parsed and known raw tool identity/error-marker coverage checks passed. **Not full semantic coverage, task success or absence of unknown formats.** |
| `engine` | Package version, SHA-256 of the UI diagnostic source, and adapter/shared-normalization source hash. |
| `source` | Selected platform, input byte length and SHA-256; no filename/path or raw session ID. |
| `coverage` | Physical lines, JSON records, normalized messages, ignored records, raw/normalized tool counts and per-line coverage issues. |
| `summary` | Same aggregate health fields as the UI: failures, exact-match recovery, pending events, repeated records, call states and distinct related results. |
| `events` | Failure source references, grouping facts and subsequent related-call/result references. |
| `gaps` | Running/unknown/no-result evidence references and reason; not live-process state. |
| `processes` | Codex launch/poll/final-result references, state, exit code, input-observed boolean and ambiguity codes. Raw process IDs are omitted. |
| `chronology` | Recognized check and modification source references, before/overlap/after relationships, latest outcome and scope limitations. |
| `limits` | Human-readable reminders that association and timing do not prove coverage or correctness. |

A source reference is `{ "line": 12, "messageIndex": 9 }`, with **one-based** physical JSONL line and normalized message position. One raw record can fan out to multiple normalized messages; two different references may have the same physical line. References are valid only for the input bytes matching `source.sha256`. Preserve the original file locally if you need the actual evidence. The report cannot reconstruct omitted content.

Full and summary inspect reports omit raw prompts, outputs, command arguments, paths, call/process IDs and human notes. Tool names outside a fixed common-tool vocabulary become `other`. Aggregate counts, relations and source hashes can still disclose activity or equality of inputs: **minimized is not anonymized**, and you should still review sharing/retention decisions. Only the separate, explicit `evidence` command returns raw content; inspect never adds it implicitly.

The same bytes, platform, package and rule/adapter versions yield the same report bytes. No wall-clock generation timestamp, random identifier or measured runtime is mixed into the report.

## Explicit exit policy

| Exit | Meaning |
| --- | --- |
| 0 | Report generated with known adapter coverage checks satisfied. Findings may exist; no task-success claim. |
| 1 | Argument/input/read/runtime error or incomplete adapter coverage. Coverage failure takes precedence over findings. |
| 2 | `--fail-on pending-failures` was explicitly requested and at least one failure lacks the existing rule's exact matching later success. |

```sh
agentxray inspect --platform codex session.jsonl --json \
  --fail-on pending-failures > evidence.json
```

Do not make this policy a universal "agent passed" gate. A negative probe may intentionally return nonzero; alternate verification may not match the original arguments. The command does not infer equivalent tests, implicit cwd or test coverage.

A CI shell can keep both findings and parse errors distinguishable:

```sh
status=0
agentxray inspect --platform codex session.jsonl --json \
  --fail-on pending-failures > evidence.json || status=$?
case "$status" in
  0) echo "Evidence report generated; task correctness not asserted" ;;
  2) echo "Pending failure records: inspect evidence.json and source lines" ;;
  *) echo "Inspection incomplete or invalid; do not accept as clean" >&2 ;;
esac
exit "$status"
```

## A small machine consumer

Use stdout as data, never as executable instructions. For example, after generating a complete `evidence.json`:

```js
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync('evidence.json', 'utf8'));
if (report.schemaVersion !== 1 || !report.complete) {
  throw new Error('Unsupported or incomplete evidence report');
}
for (const event of report.events) {
  console.log({ tool: event.tool, reason: event.reason, sourceLines: event.failures.map(ref => ref.line) });
}
```

This can feed an agent's review step or a build artifact without a browser or model judge. It should inform an explicit next check, not automatically rerun a possibly destructive original command.

## Keeping UI and CLI aligned

The source of truth remains `frontend/src/views/sessions/diagnostics.ts`. `npm run build:diagnostics` uses the existing frontend esbuild dependency to generate `lib/generated/diagnostics.cjs`; `build:ui` regenerates it too. Installed packages contain the prebuilt CommonJS artifact and do not need TypeScript, esbuild or a frontend checkout to run `inspect`.

Tests compare actual CLI output with the TypeScript UI functions and validate every reference. `node scripts/build-diagnostics.mjs --check` verifies generated contents, and CI checks the committed bundle diff after the normal build. Do not hand-edit the generated file.

## 中文使用与边界

### 分层 CLI（自 1.24.0 起提供）

先用 `node bin/agentxray.js inspect --platform omp session.jsonl --summary --json`
读取摘要，再把报告的 `source.sha256` 与某条引用的 `line` 传给
`node bin/agentxray.js evidence --platform omp session.jsonl --sha256 HASH --line N`。
无需 MCP、浏览器或人工标签，不自动寻找或执行会话中的命令。

摘要保持完整计数，每类引用最多五条，显示 total/shown/truncated；截断后应取完整报告，
不能把示例引用当成全部问题。证据展开是**显式读取可能敏感的原文**，并非脱敏接口：
默认最多 4096 内容字节，可设 4–16384，用返回的 nextOffset 按 UTF-8 字节翻页；
哈希不一致、非法字符边界和越界位置均拒绝。LF 不返回，CR/BOM 保留。

JSON 模式失败不再返回空 stdout，而是稳定的 kind=error、error.code、error.message；
旧的完整成功报告不变。覆盖不完整仍保留数据、退出 1，并在 stderr 返回结构化错误。
务必检查 kind/schemaVersion/complete 和退出码，不能把原文当可执行指令或自动上传。

离线核验不要求开网页或人工标注，供本机 Agent、脚本与 CI 消费同一套诊断事实：

```sh
agentxray inspect --platform omp session.jsonl --json > evidence.json
```

当前只支持明确指定的 Codex、OMP、Claude Code JSONL，单文件上限 64 MiB。读取期间变化、截断坏行、错误格式都会失败；已知标准化丢失会输出 `complete:false` 与问题行号，不会假绿。

报告默认不含日志正文、路径、命令参数、原始 ID 或笔记，只保留计数、状态、关系、输入/规则哈希和原始行号。哈希与活动计数仍可能敏感，不是匿名化保证。原始文件必须自行保留，报告不能重建日志。

退出码 **0 表示报告生成成功，不是任务通过**；1 表示输入/覆盖/运行错误；只有显式 `--fail-on pending-failures` 才因待闭合失败返回 2。调用方应检查 `schemaVersion`、`complete` 和退出码，不把“没有识别到失败”当作完成证明。

安装包运行无需编译器、UI 源码或服务。`npx` 首次下载可能联网，安装后的 `inspect` 本身不发网络请求、不执行日志命令、不扫描 HOME、不创建归档或人工笔记。
