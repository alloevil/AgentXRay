# Invocation policy: no AgentXRay, upfront summary, or optional CLI

This is a new synthetic recovery/verification-decision experiment, not an owner
production benchmark. It introduces an actual **no-AgentXRay baseline** rather
than comparing only different reports from the same product. No product feature,
trigger, automatic hook or default setting is changed here.

## Arms and fairness

- `baseline`: current source, specification, public cases, source/suite metadata,
  raw synthetic history and read/write/test/finish; no AgentXRay tool actions.
- `upfront`: same inputs plus the actual current CLI summary in the initial
  prompt; optional inspect/evidence actions are available.
- `ondemand`: no initial report; may choose inspect/evidence when useful, with
  the identical enabled-tool schema as upfront. No instruction forces a call.

The baseline intentionally lacks the optional CLI tool fields/description. Its
smaller schema is part of the practical integration cost. This is not perfectly
token-matched prompting or a pure report-format ablation. Raw history and all
public checks remain accessible in every arm. No credentials or private owner
data are used; no local model is called.

## Tasks and objective

Six new deterministic JS tasks: nested JSON merge patch, cursor pagination,
retry delay, virtual-root path resolution, interval union and interpolated
quantiles. Four are broken; two already correct. Histories represent stale
success after later edits, background failure, alternative correction and an
expected negative probe. Tool/process wrappers and chronology are **simulated**,
not recovered production events. Public-test outcomes and source/suite hashes
inside those histories come from actual evaluator executions before freezing.

All behavior requirements are in the prompt. Current code, public test inputs
and source/suite hashes are visible; hidden tests add cases of the same spec, not
secret requirements. Independent reference implementations and initial
classifications are checked before trials. A dedicated bounded evaluator uses
JSON.parse rather than JS input literals (preserving __proto__ as an own data
key), and compares input after execution to catch mutation on each tested case.
Finite cases still do not prove arbitrary semantic equivalence or absence of
mutation for every untested input. Earlier experiment evaluators are unchanged.

To claim done, code must satisfy the behavior and have a recorded successful
public check for the final source SHA-256 and the identical public-suite hash.
The agent may reuse an exact matching success from history or simply run the
public check itself. No requirement forces reading the history or using XRay.
For the two correct tasks, a matching success already exists. Broken tasks need
verification of the repaired source; exactly restoring a previously verified
source hash may reuse its historical success, otherwise a new check is needed.
This is a realistic but narrow deterministic
verification-reuse criterion, not the definition of success for all agent work.

Record behavioral acceptance, verification evidence and combined task success
separately. Combined success requires explicit done, passing hidden behavior and
matching successful public-check evidence. The hidden grader never feeds results
back to the model. A source with hidden pass but missing verification is not a
fully completed task. A redundant public check means rerunning an already passed
source/suite combination in this frozen deterministic environment; it is not a
general claim that test reruns are wasteful.

## Freeze and budgets

Six tasks × two repeats × three arms = **36 sequential runs**. Fixed seed
20260927 shuffles task order; six permutations balance all arm positions in each
repeat, and the second repeat reverses each task's ordering. Pin the existing
OMP selector `mify/deepseek/deepseek-flash`, thinking low, 20 executed calls and
120 seconds; terminate at 135 seconds and force-kill at 140. Fresh conversations,
isolated workspaces and bench only. No live user workspace or general shell is
exposed. JS runs through a bounded Node child VM; it is not a hostile
code execution service.

Freeze source/dependency hashes, tasks, raw histories, actual test receipts,
workspace metadata and report bytes before model outcomes. Summary is regenerated
through the real CLI for each upfront trial; ondemand/baseline do not pay that
initial generation cost. Every optional inspect/evidence call invokes the actual
CLI. Previous experiments remain unchanged. No parallel builds/tests during runs.

Transport/model/tool/usage/receipt failures stop the entire schedule. Preserve
invalid, interrupted, cap-exhausted and unsuccessful trials, never selectively
retry. Resume only sealed audited completed trials. No retuning or forced tool
usage after seeing behavior. Independent synthetic smoke is not a study sample.

## Metrics and interpretation

Compare **each enabled arm against baseline first**, then ondemand against
upfront. Report task/repeat matched behavior and combined-success wins/losses/
ties, false completion, correct-task writes/harm, check repetitions, evidence
use, log reads, all tool calls, response bytes, CLI generation/expansion time,
all provider usage categories and end-to-end elapsed time. Cache/think fields are
not added twice. Local tool time is already inside model-process elapsed time;
initial report and final evaluation costs are reported separately. Zero provider
cost metadata is not free inference or a dollar estimate.

Six clusters are too few for population significance or noninferiority claims.
These are hand-authored tasks, not representative real-world recovery, and models
may solve them without history. Existing caches, remote latency and mutable
provider weights remain confounds. No calls means trigger usefulness is unproven;
baseline matching results at lower cost is evidence against mandatory insertion
on these tasks. This cannot establish universal benefit or failure of AgentXRay.

```sh
node --test experiments/invocation-policy/harness.test.cjs
node experiments/invocation-policy/run.cjs smoke
node experiments/invocation-policy/run.cjs prepare
node experiments/invocation-policy/run.cjs run
node experiments/invocation-policy/run.cjs summarize
```

Only run/smoke invoke the configured remote model and may be billable. Outputs,
including exact prompts/events and hashes, remain in ignored
`output/invocation-policy/`. No automatic commit, release or public log upload.
