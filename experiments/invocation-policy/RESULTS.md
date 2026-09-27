# Invocation-policy pilot: baseline succeeds; automatic summaries add context cost

## Decision supported by this run

Do **not** add automatic AgentXRay reports to every coding task based on these
results. Keep the CLI optional. This run provides no observed need for additional
summary fields, event bundles or an automatic trigger implementation.

All three policies completed 12/12 synthetic recovery tasks, including both
behavior and final-source verification. Upfront summaries used **24.02% more
cumulative tokens** than the no-AgentXRay baseline. The optional arm used fewer
tokens than upfront, but **never called AgentXRay**. Its 4.46% lower usage than
baseline cannot be credited to diagnostic tooling it did not use.

This is evidence against mandatory insertion **on these tasks**, not proof that
execution evidence is useless, that the CLI never helps, or that a particular
automatic trigger would work in real production recovery.

## Design and provenance

- Frozen: `2026-09-26T23:48:04.798Z`, September 27 at 07:48:04 Asia/Shanghai.
- Six new synthetic tasks, two repetitions per task/policy, 36 sequential runs.
  Four tasks start broken and two already correct. The corpus is different from
  the preceding full-versus-layered experiment.
- Remote OMP `18.2.11`, selector `mify/deepseek/deepseek-flash`, thinking low;
  Node `22.23.2`, 20-call and 120-second agent budgets. No local inference.
- `baseline`: file tools/public checks and raw history; no AgentXRay action.
- `upfront`: same plus summary supplied initially and optional CLI actions.
- `ondemand`: no initial report; optional CLI actions identical to upfront.
- All task requirements, code, public tests, current source/suite hashes and raw
  histories are equally available. Hidden cases are not sent to the model.
- Completion requires explicit done, passing hidden behavior and a passed public
  check for the final source SHA-256 and identical suite hash. A historical exact
  match can be reused; otherwise the model can run the public check. No history
  read or AgentXRay call is compulsory.
- History wrappers/process envelopes are simulated. Their public-test results
  and source/suite hashes come from actual bounded evaluator runs. Stale-check
  histories contain prior passing source in edit records; recovering that source
  is allowed to every arm, not a hidden-answer advantage for the enabled arms.
- Manifest SHA-256:
  `c95dfb0467ff0020fe980e35c60adef05dac484b939295b88d3ff2ddc6049dc4`.
- Fifty-one code/dependency files, all task/log/check/report bytes and arm order
  were frozen before treatment. No trial outcomes were used to tune the corpus.

See [PROTOCOL.md](PROTOCOL.md) for the predeclared method, stopping rules and
limits. The baseline has a shorter tool schema because CLI actions are absent;
this is a practical policy comparison, not perfectly token-matched prompts.

## Results

| Metric | No AgentXRay | Upfront summary | Optional CLI |
| --- | ---: | ---: | ---: |
| Valid trials | 12/12 | 12/12 | 12/12 |
| Hidden behavior passed | 12/12 | 12/12 | 12/12 |
| Final-source verification satisfied | 12/12 | 12/12 | 12/12 |
| Combined task completion | 12/12 | 12/12 | 12/12 |
| Explicit false completion | 0 | 0 | 0 |
| Writes on initially correct tasks | 0/4 | 0/4 | 0/4 |
| Harmful changes on initially correct tasks | 0/4 | 0/4 | 0/4 |
| Tool calls, total | 68 | 68 | 68 |
| Public checks, total | 8 | 12 | 9 |
| Matching successful checks repeated | 1 | 4 | 2 |
| Trials reading raw history | 4 | 0 | 3 |
| New public check avoided using existing verification | 4 | 0 | 3 |
| Optional inspect/evidence calls | unavailable | 0 | 0 |
| Initial report bytes, sum | 0 | 37,914 | 0 |
| Tool response text bytes, sum | 54,202 | 26,248 | 49,529 |
| Cumulative tokens, sum | 175,340 | 217,450 | 167,521 |
| End-to-end seconds, mean | 11.93 | 11.18 | 10.36 |
| End-to-end seconds, median | 10.50 | 8.85 | 9.55 |

There were no invalid trials, missing submissions, public-check failures or
unnecessary modifications of the initially correct code. All 36 trials are
retained, without retry or sample replacement.

Each matched policy contrast contains 12 task/repeat pairs, **0 wins, 0 losses
and 12 ties** on combined acceptance:

- Upfront minus baseline: mean +3,509.17 tokens; +24.02% in the arm total.
  Upfront has more tokens in 9 pairs and fewer in 3.
- Optional minus baseline: mean −651.58 tokens; −4.46% in the arm total.
  Optional has fewer tokens in 7 pairs and more in 5, without using the CLI.
- Optional minus upfront: mean −4,160.75 tokens; −22.96% in the arm total.
  Optional has fewer tokens in 10 pairs and more in 2.

These are descriptive observations from six task clusters, not population
confidence, significance or formal noninferiority results.

### Token accounting

| Model-reported usage, sum | Baseline | Upfront | Optional |
| --- | ---: | ---: | ---: |
| Input | 43,526 | 43,233 | 37,749 |
| Output | 18,790 | 16,521 | 14,956 |
| Cache read | 113,024 | 157,696 | 114,816 |
| Cache write | 0 | 0 | 0 |
| Total tokens | 175,340 | 217,450 | 167,521 |
| Reasoning tokens | 10,061 | 8,003 | 6,855 |

Total includes context repeatedly read over all turns. Reasoning is reported
separately, not added twice. Cache/input/output prices differ; no dollar savings
claim follows from total-token ratios. Initial summary generation averaged
70.50 ms per upfront run; baseline and optional had no initial CLI generation.
Tool time is already included in model-process time, and final validation is
included in end-to-end time. The timing table does not show an across-the-board
slowdown from summaries: upfront was faster than baseline in mean elapsed time,
despite higher tokens. Remote latency, caching, sampling and mutable provider
weights prevent attributing small timing differences solely to the CLI policy.

### Per-task cumulative tokens (two repetitions)

Every task passes 2/2 in each arm.

| Task | Baseline | Upfront | Optional |
| --- | ---: | ---: | ---: |
| nested-config-recovery | 44,572 | 50,336 | 45,411 |
| cursor-page-background | 27,567 | 40,771 | 28,359 |
| retry-delay-after-edit | 22,637 | 35,469 | 23,321 |
| virtual-root-recovery | 28,611 | 40,853 | 26,536 |
| intervals-already-repaired | 27,993 | 25,864 | 28,335 |
| percentile-negative-probe | 23,960 | 24,157 | 15,559 |

## What the actual decisions show

- Baseline read raw history on the four already-correct instances and reused
  their exact-source verification without rerunning public tests. This decision
  did not require AgentXRay.
- Upfront read no raw history and ran a public check in every trial, including
  four exact matching successes already in history. The minimized summary itself
  does not expose arbitrary source/suite hash fields inside test output. We
  cannot establish why the model chose retesting rather than expanding evidence.
- Optional read raw history twice on the correct interval task and once during
  nested-config recovery. In the latter case it restored the earlier verified
  source exactly and reused the corresponding test receipt instead of rerunning.
  It did not invoke inspect or evidence.
- Repetition counts include restoring exactly the same historical source and
  then rerunning its deterministic public suite. This narrow definition does not
  imply that retesting after a restore is generally wrong or wasteful.

The tooling was available: the separate smoke invoked one real summary and one
real evidence request before fixing and verifying its own increment task. Those
forced smoke calls are excluded from all 36 trial metrics. Zero spontaneous CLI
calls means this run does not test trigger quality or diagnose an evidence
pagination bottleneck. Adding more tool features based on it would be speculation.

## Verification and remaining limits

- 8 selftests pass; 348 existing product tests pass after the experiment. Lint
  exits zero with the existing 91 warnings/159 informational diagnostics.
- The local audit matches 204 actual tool calls to tool results, reexecutes all
  29 public checks, validates historical receipts, regrades hidden cases and
  recomputes verification reuse from exact source/suite hashes.
- All frozen code and data hashes agree. Resume audits 36 saved trials with
  unchanged model-event files and zero new model calls. The previous layered
  experiment's frozen source manifest still validates.
- Preflight exposed an old evaluator limitation: directly embedding JSON as JS
  literals loses own `__proto__` keys. This new study uses its own JSON.parse-based
  bounded evaluator and checks input mutation; prior evaluators were not changed.
- All six references and initial classifications were validated before freeze.
  The four broken tasks have failing public cases, so a direct test/fix workflow
  is a strong alternative. The histories are short and simulated. This is **not
  a prospective real-world benchmark**, and acceptance still hits a ceiling.

Recommended product decision: retain explicit optional CLI access, do not insert
reports automatically into every task, and do not add event packs or a triggering
heuristic based on these results. A claim of diagnostic benefit still needs
qualifying work where execution state changes the best action; this corpus does
not establish it. Do not retroactively tune or relabel these trials as production
evidence. No runtime product code, version or release changed in this round.

Local receipts are under ignored `output/invocation-policy/`: `manifest.json`,
`frozen/`, `trials/`, `summary.json`, `audit.json`, `resume-receipt.json`,
`selftest-final.tap`, `product-tests.tap` and `lint.log`. Recompute sealed results
and hidden acceptance with `node experiments/invocation-policy/run.cjs summarize`;
that command makes no new model calls. Raw artifacts are not published.
