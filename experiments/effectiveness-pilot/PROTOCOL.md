# Coding-agent effectiveness pilot

This is a small, synthetic intervention experiment, not a product benchmark or
evidence of adoption. Its question is whether supplying AgentXRay's existing
evidence report helps a fixed agent finish recovery tasks.

## Frozen design

- Six hand-designed JavaScript tasks, two repetitions, three arms: 36 sequential trials.
- A (`raw`): raw history available through a tool. B (`mechanical`): same plus
  recent normalized records. C (`xray`): same plus the current inspect report.
- Identical task specification, initial files, public cases, system prompt,
  tool API, model selector `mify/deepseek/deepseek-flash` and `low` thinking.
- B is mechanically truncated to C's byte budget; actual lengths and tokenizer
  costs differ. This is not an exact information-volume control.
- Fixed shuffled task order (seed 20260924), balanced arm ordering within repeats.
  Fresh workspace and OMP process per trial; no conversation/session reuse.
- Twelve executed tool calls and OMP's 90-second limit; parent terminates at
  105 seconds, kills at 110. Only `bench` is enabled: allowlisted reads, bounded
  solution writes, fixed public tests and `done`/`blocked` submission.
- Hidden executable cases remain outside the workspace. They run after the
  agent stops, with no hidden feedback, oracle access or interactive human review.
- A source/report/fixture hash manifest is written before treatment trials.
  Preflight validation and an independent infrastructure smoke are not samples.

## Scoring and exclusions

Primary: final code passes every hidden case. Also count explicit `done` with
hidden failure, missing submission, writes on initially correct tasks, harmful
changes, log reads, tool calls, public-test failures, repeated failed actions,
model-reported usage categories and process elapsed time.

An unnecessary write means *any* write on an initially correct task, including
byte-identical writes. Repeated failure means equal semantic tool arguments and
equal source hash; OMP's injected intent text is not part of this signature.
JSON results use structural comparison; object key order is irrelevant. Acceptance
is a finite behavior sample, not proof of all requirements (including non-mutation).

Missing `agent_end`, nonzero runner exit, provider error, wrong model selector or
extra tools stops the schedule. Preserve all invalid/timeout artifacts and report
the incomplete schedule; never selectively retry or silently drop failed runs.
Normal runs without `finish` remain in the denominator. Final-code acceptance
and explicit submission are separate metrics. No provider fallback is allowed.

Report each arm and task/repeat-matched C−A and C−B differences, including
wins/losses/ties. Results are descriptive: there are only six designed task
clusters, not 36 independent problem samples. No significance or population
confidence claim is appropriate. Keep input, output, cache read and cache write
separate; cumulative total tokens include repeated context. Zero provider cost
metadata does not establish zero price or dollar savings.

## Reproduction

Requires Node >=22.13, installed/authenticated OMP supporting the pinned selector,
and the repository's generated diagnostics. This uses the configured model
provider (potentially billable); it is not an offline model. No private logs are
sent. Candidate code uses a bounded VM in a restricted child process; this is
not a hardened hostile-code sandbox.

```sh
node --experimental-strip-types --test experiments/effectiveness-pilot/harness.test.cjs
node experiments/effectiveness-pilot/run.cjs smoke
node experiments/effectiveness-pilot/run.cjs prepare
node experiments/effectiveness-pilot/run.cjs run
node experiments/effectiveness-pilot/summarize.cjs
```

Artifacts stay in ignored `output/effectiveness-pilot/`: manifest, exact prompts,
OMP events, tool receipts, stderr, final code, per-trial result and aggregate
summary. `prepare` refuses to overwrite a manifest. `run` resumes only saved
completed trials and refuses incomplete trial directories. Preserve the whole
output directory before an explicitly separate replication; do not replace an
unfavorable study with a new run.

## Limits fixed before observing outcomes

Tasks are short, authored from known failure patterns, not held-out production
incidents. Models may repair them directly without reading history, causing a
ceiling effect. The mechanical recent-record baseline may omit old evidence;
winning against it would not prove superiority over competent summarization.
Reports are supplied automatically, so this does not measure autonomous discovery
or tool integration. One provider/model selector cannot establish cross-model
generalization; the provider may change its underlying weights. Shared provider
caching, sequential latency variation and unequal prompt lengths remain confounds.
Inspection-generation time is outside trial elapsed time. A null result must be
reported, not followed by tuning tasks and relabeling the result as held out.
