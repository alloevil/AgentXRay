# Restricted remote trial runner

This runner uses the existing OMP provider selection
`mify/deepseek/deepseek-flash`, thinking `low`. It never invokes a local model.
Its input is a sealed [sanitized disclosure](DISCLOSURE.md), not a source
repository or raw capture. Admission alone does not establish useful outcomes.

## Fixed treatment

Each admitted task has two repetitions of A/raw history access, B/mechanical
recent-record context and C/AgentXRay context. All three use identical sanitized
task, code, public checks, history access and tool API. A deterministic permutation
derived from the frozen gate hash is reversed for the second repetition to
counterbalance early/late positions. These are six runs of **one task**, not six
independent real-world examples.

Before any model outcome, `private/remote-study/manifest.json` freezes the model,
OMP version, executable hashes, exact prompts, budgets, order and disclosure hash.
All runs are sequential, in fresh temporary workspaces and conversations. The
only treatment difference is the supplement; B is not a model-generated summary.

## Tools and isolation

OMP's normal tools, extensions, skills, rules, session persistence, LSP and
prewalk are disabled. The explicitly loaded extension enables only `bench`:

- List/read allowlisted source files; read the same history as `@history`.
- Write only declared files, at most 128 KiB per write. No test edits, path
  escape, other-arm supplement access, general shell or hidden-test access.
- Run only the frozen public check, in a disposable Docker copy with no
  network, read-only root, dropped capabilities and bounded resources.
- Submit `done` or `blocked`. Calls after submission are refused.

Each response passes the disclosure gate before reaching the model, including
full public-check output before truncation. Gate failures stop the trial with a
fixed non-sensitive error rather than exposing host paths or original values.
Generated source cannot replace a symlink target or modify read-only files.

The cap is 40 executed tools and 300 seconds in OMP. The parent terminates at
315 seconds and forcibly kills at 320; owned Docker labels allow cleanup even
if OMP dies during a check. Normal user containers/services are not stopped.

The transformed hidden oracle, its command and file hashes are sealed in private
gate metadata, never in the model's working directory. Only after OMP exits does
the coordinator evaluate the saved final source on another Docker copy. Hidden
feedback is never returned to the model or included in a subsequent repetition.

## Results and resumption

```sh
node experiments/prospective-study/cli.cjs run DISCLOSURE_DIRECTORY
node experiments/prospective-study/cli.cjs status output/prospective-study
```

The run command performs real, potentially billable remote model calls. It
rejects raw captures and unsealed/changed disclosures. Provider errors, missing
agent-end/usage, model/tool mismatches, gate failures, invalid evaluation and
interrupted attempts stay on disk and stop the schedule. There is no automatic
retry or provider fallback. Completed saved trials are audited before reuse;
incomplete trial directories and stale process locks require an explicit audit.

Artifacts remain under `DISCLOSURE_DIRECTORY/private/remote-study/`:

- Frozen manifest, per-trial prompt, OMP events/stderr and tool receipts.
- Saved final source and independent hidden-check output.
- Sealed results plus aggregate `summary.json`, including any invalid attempts.

Count final hidden acceptance, explicit false completion, missing submission,
writes/harm on initially correct code, tool/check calls and usage categories.
A candidate exception with nonzero hidden-check exit fails acceptance; an exit
zero without the required case witness is not counted as success. Case identities
must match the frozen oracle whenever a witness is available.

Token totals include repeated context/cache usage, not dollar cost. Admission
time is reported once per dataset, with supplement generation included inside
that admission phase. Per-trial preparation, model/tool runtime and post-run
evaluation are separate. These fields are not a complete machine-cost meter.
No improvement/adoption claim follows from a single task or successful plumbing.

## Prospective capture

The optional OMP capture extension watches only the AgentXRay repository root.
It saves the current prompt, current-branch history and working-tree bytes before
ordinary agent execution. It does not intercept or sanitize normal OMP provider
requests; these privacy gates apply to the separate experiment runner.

Local configuration is `output/prospective-study/config.json`. `enabled: true`
enables capture; `contracts` is keyed by the task prompt's SHA-256. Independent
acceptance/reference must be frozen before admission. With no matching contract,
the candidate is pending, not a success and not automatically sent to a model.
Capture failures leave an exclusion receipt without interrupting ordinary work.

Installation of the small forwarding extension does not alter existing OMP
extensions, system rules or active processes. It applies to newly launched OMP
sessions, not retroactively to past/current sessions. Disabling the local config
stops future intake. The coordinator remains responsible for task-specific
acceptance; the runner does not invent correctness labels from arbitrary prompts.

## Infrastructure smoke

`remote-smoke.cjs OUTPUT_DIRECTORY PINNED_NODE_IMAGE_ID` creates a fresh,
explicitly synthetic multi-file tax-repair task and its independent oracle,
then performs local disclosure admission. Its receipt contains the disclosure
directory to pass to `cli.cjs run`. Reusing an existing destination is refused.

This task tests model/tool integration, not real-world usefulness. Smoke
captures and runs are excluded from real-task counters. No private owner logs
are used in the smoke prompts. Keep failed infrastructure attempts as well as
successful ones; never present these trials as prospective real tasks.

## Verified checkpoint — 2026-09-24

The synthetic multi-file smoke completed all six runs with the fixed remote
selector. The following numbers describe infrastructure, not real task benefit:

| Arm | Valid runs | Hidden acceptance passed | Tool calls | Cumulative tokens including cache |
| --- | ---: | ---: | ---: | ---: |
| A: raw history | 2/2 | 2/2 | 14 | 18,555 |
| B: mechanical context | 2/2 | 2/2 | 12 | 20,089 |
| C: AgentXRay context | 2/2 | 2/2 | 12 | 23,905 |

All 38 recorded tool invocations are `bench`, with allowlisted file access.
Independent reevaluation of the saved final sources reproduces all four hidden
case results in every run. Original replacement-map literals do not appear in
the recorded model events. Resuming the study audits/reuses the six saved runs
without changing any model-event file or making new model calls. There were no
invalid trials or explicit false completions. This is one easy synthetic task;
the table demonstrates neither completion-rate improvement nor a cost advantage.

The forwarding extension is installed locally as
`~/.omp/agent/extensions/agentxray-prospective.ts`. Both explicit loading and
normal automatic loading were exercised in native OMP invocations. Each probe
returned `READY`, made no agent tool calls, captured 262 files before model
execution and recorded a separate end observation. They remain labelled
`infrastructure-check`, not real task samples. The existing extension's hash is
unchanged; no active user session or shared inference service was restarted.

Capture is now enabled for **new OMP sessions at the AgentXRay repository root**.
Local config has `enabled: true`, `infrastructureProbe: false`, and no predefined
task contracts. Real captures therefore require task-specific acceptance before
admission; capture alone neither grades a task nor launches six paid trials.
At this checkpoint: zero real candidates, zero real admitted tasks and zero real
treatment runs. The coordinator must obtain qualifying prospective tasks before
claiming a benefit relative to ordinary context.

Validation: 29/29 experiment tests and 332/332 product tests pass. Capturing the
repository revealed a Biome nested-root-config error caused by the frozen copy
of `biome.json` under ignored output. Adding only `!!output` to the root Biome
configuration fixes it without changing any snapshot or the 69 checked source
files. A regression test reproduces the error without that exclusion and passes
with it. Lint exits zero with the existing 91 warnings and 159 informational
diagnostics; these are not claimed fixed.

Receipts stay in ignored `output/prospective-study/`:

- `remote-chain-audit.json`: actual tools, source hashes, independent grades and usage.
- `remote-smoke-resume-audit.log`: six audited reused runs, zero new model calls.
- `capture-integration-audit.json`: native explicit/default-loading capture checks.
- `remote-tests-final.tap`: 29 experiment tests; `remote-product-tests.tap`: 332 product tests.
- `remote-product-lint-fixed.log`: lint after the narrowly scoped output exclusion.

`remote-smoke-20260924/receipt.json` points to the synthetic study's complete
manifest and per-trial artifacts. Raw owner logs, maps and private workspaces are
not published. No product version was released as part of this integration.
