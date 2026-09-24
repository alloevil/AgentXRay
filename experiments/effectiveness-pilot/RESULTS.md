# Effectiveness pilot: no demonstrated advantage over mechanical context

## Run receipt

- Date: 2026-09-24; final protocol frozen at `2026-09-24T02:23:49.630Z`.
- Product base: v1.23.0, commit `45e9cb8f85f42b50b19dd753655e11bbf27bcb81`.
- Runtime: Node 22.23.2, OMP 18.2.11; model selector
  `mify/deepseek/deepseek-flash`, thinking `low`.
- 6 synthetic tasks × 2 repeats × 3 arms = 36 completed valid trials.
- No invalid runs, timeouts, budget stops or missing submissions. No trial reruns.
- Final manifest SHA-256:
  `b4ea0f47fbeb7a0dddbb957a7cf098355bfbbd756ad76c6258333753d27c6f08`.
- See [the frozen protocol](PROTOCOL.md) for controls, scoring and limitations.

## Results

| Metric | A: raw history access | B: mechanical recent records | C: AgentXRay report |
| --- | ---: | ---: | ---: |
| Hidden acceptance passed | 12/12 | 12/12 | 12/12 |
| Initially broken tasks repaired | 8/8 | 8/8 | 8/8 |
| Explicit false completion | 0/12 | 0/12 | 0/12 |
| Writes on initially correct tasks | 0/4 | 0/4 | 0/4 |
| Harmful changes on initially correct tasks | 0/4 | 0/4 | 0/4 |
| Trials reading raw history | 8/12 | 0/12 | 1/12 |
| Tool calls, total | 64 | 56 | 59 |
| Tool calls, mean | 5.33 | 4.67 | 4.92 |
| Cumulative tokens, mean per trial | 18,099.58 | 12,508.83 | 14,072.58 |
| Elapsed seconds, mean | 7.09 | 6.34 | 6.90 |
| Elapsed seconds, median | 6.48 | 6.45 | 6.30 |

Public-test failures and repeated failed tool actions were zero in every arm.
Every trial ran public tests. Hidden acceptance was rerun against each saved final
source and agreed with the original result.

### Token accounting

These are accumulated model usage fields across turns, including repeated
context and cache reads, not unique prompt length or monetary cost. Reasoning
tokens are reported separately and are not added again to `totalTokens`.

| Usage field, sum over 12 trials | A | B | C |
| --- | ---: | ---: | ---: |
| Input | 52,560 | 29,418 | 33,932 |
| Output | 10,779 | 8,176 | 9,499 |
| Cache read | 153,856 | 112,512 | 125,440 |
| Cache write | 0 | 0 | 0 |
| Total tokens | 217,195 | 150,106 | 168,871 |
| Reasoning tokens | 3,423 | 1,775 | 2,391 |

### Paired outcomes

Each contrast uses the same task and repetition, 12 pairs. C versus A and C
versus B both have **0 wins, 0 losses, 12 ties** in hidden acceptance.

- C minus A: mean −4,027 cumulative tokens (−22.25% of A's mean),
  −0.42 tool calls and −0.19 seconds per trial.
- C minus B: mean +1,563.75 cumulative tokens (+12.50% of B's mean),
  +0.25 tool calls and +0.56 seconds per trial.
- Every task (`rounding-after-check`, `rolling-window-background`,
  `finite-value-count`, `stable-dedupe-correct`, `negative-probe-correct`,
  `masked-validator`) passed 2/2 in each arm.

## Interpretation

This pilot does **not** demonstrate that AgentXRay improves task completion or
prevents false completion. All arms reached the acceptance ceiling. C consumed
less cumulative context than A, but the non-diagnostic B consumed still less;
the observed reduction cannot establish a unique benefit from diagnostic facts.
These sample differences are not population estimates or significance claims.

The result does not establish that the product has no value either. The tasks
are short, their code can be repaired without historical evidence, and B/C
usually did not read the raw log. A difficult real recovery workload might behave
differently; this experiment does not answer that question. B/C actual byte and
token lengths differ. Provider caching, variable latency and ordinary host load
(including local regression checks early in the run) limit timing comparisons.
Report generation is not included in measured trial duration.

Do not market this as improved coding accuracy or 22% cost savings. A defensible
next research question is whether execution facts change decisions on genuinely
history-dependent recovery tasks **beyond a simple summary baseline**. Any such
study needs newly frozen tasks and acceptance, not tuning and rerunning this
corpus until C wins. No new product behavior is approved or implemented here.

## Local verification artifacts

All full artifacts remain in ignored `output/effectiveness-pilot/`; no private
logs were used or uploaded. The repository contains this summary and executable
protocol, not publicly hosted raw model receipts.

- `manifest.json`: frozen sources, cases, report hashes and arm order.
- `trials/<id>/`: prompt, OMP events, tool receipts, stderr, final code, result.
- `summary.json`: arm metrics and all paired differences.
- `audit.json`: 36 trials, 179 actual tool calls matched to 179 receipts;
  only `bench`, allowlisted reads/writes, unchanged frozen hashes and token totals.
- `resume-check.log`: 36 saved trials skipped, no new model calls.
- `selftest.tap`: 5 experiment selftests passed.
- `product-tests.tap`: 332 product tests passed, 0 failed.
- `product-lint.log`: exit 0, 91 warnings and 159 informational diagnostics in
  existing lint scope; experiments are outside that configured scope.

Regenerate the aggregate with
`node experiments/effectiveness-pilot/summarize.cjs`. It audits saved code hashes,
regrades hidden cases, checks model/tool identities and recomputes usage from
OMP events before writing the summary. No production code or release changed.
