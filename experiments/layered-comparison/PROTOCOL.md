# Full-report versus layered-CLI pilot

Frozen before treatment outcomes. This experiment changes no product code.
It asks whether initial summary plus optional evidence reduces **total** costs
compared with initial full inspect JSON, without degrading observed acceptance.

## Design

- Reuse all six unmodified tasks from `effectiveness-pilot/tasks.cjs`: four
  initially broken tasks and two initially correct. Two repeats × two arms = 24
  sequential trials, paired by task/repeat. Xorshift-shuffled task order, seed
  20260927; alternate initial arm order and reverse it for the second repeat.
- `full` receives stdout from the actual `inspect --json` CLI. `layered` receives
  actual `inspect --summary --json` stdout. Every other prompt element is equal.
- Same pinned OMP selector `mify/deepseek/deepseek-flash`, thinking low, same
  initial code/log/public tests, tool schema, 12-call limit and 90-second limit.
  Parent terminates at 105 seconds, force-kills at 110. Fresh workspace/process,
  no conversation reuse, provider fallback, local inference or user grading.
- **Both arms have the same capabilities**: raw synthetic log reads, full/summary
  report requests, actual hash-checked `evidence` CLI calls, bounded source writes,
  fixed public tests and done/blocked submission. Evidence access is not denied
  to the full arm. Neither arm is forced to expand: the treatment is initial
  context policy, not a claim that the model used the intended interface.
- Independent executable hidden acceptance is inherited unchanged. It lives
  outside the model workspace and is run only after OMP stops; no hidden feedback
  is supplied to any trial. Finite tests do not prove all input properties.
- Allowlisted tools only; no model shell/network/arbitrary filesystem tool.
  Candidate JS runs in the existing bounded Node child VM. This is a trusted
  synthetic benchmark harness, not a hardened adversarial-code service.

## Freeze and execution

`prepare` verifies every reference and initial classification, saves canonical
task definitions, synthetic logs and actual full/summary outputs, hashes all
experiment files, original task/evaluator files, product bin/lib JS, package and
lockfile, and records OMP/Node versions and randomized order. No files in earlier
experiments are edited. Outputs are under ignored `output/layered-comparison/`.

Before each trial, generate its initial report through the actual CLI and assert
exact byte agreement with the frozen output. Tool inspect/evidence calls spawn
the same actual CLI, never a copied implementation. All generated and returned
bytes, outputs, source hashes and usage are retained in local receipts.

Malformed transport, wrong model, missing usage, wrong tools, tool/usage receipt
inconsistency or runtime infrastructure failure invalidates the attempt and
stops the schedule. Preserve the attempt and incomplete schedule; never silently
retry a failure. Normal missing submission or budget stop remains an outcome
when the transport can still be audited. A time cap with incomplete transport is
retained as invalid, not dropped. `run` reuses only sealed valid saved trials,
checking event files, source, grade and frozen dependencies; partial directories
or stale locks require audit. It never substitutes another sample.

## Outcomes and accounting

Primary: final source passes every hidden case. Also record explicit done with
failed acceptance, missing finish, any write/harm on initially correct code,
tool calls, public failures, raw-log reads, full-report requests in layered runs,
evidence calls/byte pages/truncation/errors and repeated failed semantic actions
(excluding OMP intent text, including current source hash).

Record every tool's response text/envelope bytes and elapsed time. Sum all model
message usage fields separately: input, output, cache read/write, total and
reasoning. Reasoning is not added again to total. Usage includes repeated context
and every model follow-up after evidence reads; response bytes are not token
estimates. No dollar estimate is made from zero provider cost metadata.

Timing fields: setup, initial CLI generation (including Node process startup),
OMP process elapsed (including tools), final validation/evaluation, end-to-end.
Tool/CLI times are subsets of OMP elapsed and must not be added again. Full and
summary reports are regenerated separately for each trial. Offline corpus
generation/preflight and the separate smoke are excluded from task timing.

Report each arm and paired layered−full wins/losses/ties, mean/median differences
and per-task rows. Do not call 24 runs 24 independent tasks or make population
significance/noninferiority claims from six task clusters. Include invalid runs.

## Known limits, specified in advance

These short, previously studied synthetic tasks were all solved in the earlier
pilot. They may have a ceiling effect and can be solved from code/spec without
history. They are not prospective real tasks or a held-out test. If no evidence
is requested, the experiment measures initial-context overhead only, not whether
pagination is good. An improvement does not imply superiority over an ordinary
summary (not a control in this study), other models, larger logs or real work.

Repeated input may use shared provider caches; order counterbalancing cannot
remove all cache/latency confounds. The provider selector does not pin immutable
model weights. No parallel product tests/builds during treatment execution.
Summary may be larger than full output on some logs: report actual sizes, never
assume every summary is smaller. No post-hoc task enlargement or forced evidence
reads to manufacture a gain. Event evidence packs are not implemented here.

## Commands

Requires installed/authenticated OMP supporting the selector and Node >=22.13.
Only synthetic content is sent to the existing remote provider; calls may cost
money. No local-model service is invoked.

```sh
node --experimental-strip-types --test experiments/layered-comparison/harness.test.cjs
node experiments/layered-comparison/run.cjs smoke
node experiments/layered-comparison/run.cjs prepare
node experiments/layered-comparison/run.cjs run
node experiments/layered-comparison/run.cjs summarize
```

Smoke exercises evidence pagination/hash errors on a different increment task;
it is not one of the 24 trials. `summarize` audits frozen receipts and regrades
saved final code without new model calls. No automatic commit or publication.
