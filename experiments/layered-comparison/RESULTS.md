# Layered CLI pilot: near-equal tokens, no evidence expansion observed

## Conclusion

On this fixed synthetic corpus, summary-first input reduced initial report bytes
by **30.91%**, but cumulative model tokens by only **0.65%**. Both arms passed
12/12 acceptances. Layered runs took longer on average and had two more tool
calls. Neither arm requested evidence, another report or the raw history.

This does **not** establish an overall efficiency gain, noninferiority on real
tasks, or a benefit from evidence pagination. It gives no observed basis for
adding event-evidence bundles to solve an expansion problem: no such expansion
occurred. Preserve the current optional CLI, but do not advertise it as a proven
agent-performance improvement or tune this corpus until a favorable result appears.

## Frozen design and receipts

- Date: 2026-09-27 Asia/Shanghai; protocol frozen at
  `2026-09-26T23:17:31.938Z` (07:17:31 local time).
- Model selector: `mify/deepseek/deepseek-flash`, thinking `low`;
  OMP `18.2.11`, Node `22.23.2`. Only the existing remote provider was used.
- Six unchanged tasks from the [earlier pilot](../effectiveness-pilot/RESULTS.md),
  two repetitions and two arms: 24 sequential trials, 12 matched task/repeat pairs.
- `full`: actual current full inspect JSON upfront. `layered`: actual current
  summary JSON upfront. Identical task/system/tools/budgets. Both arms could read
  the raw synthetic log or call the actual inspect/evidence CLI; no forced reads.
- Forty-seven source/dependency files, all task/log/report/acceptance bytes and
  trial order were hashed before treatment outcomes. Hashes remain unchanged.
- Manifest SHA-256:
  `b5cc0a9c555edf6b1f2faa1c23601867c97d0f2e7f821caee314192692b11531`.
- All 24 trials are valid; no model mismatch, provider error, budget stop, missing
  submission, excluded attempt or selective rerun. No real/private tasks included.
- See [PROTOCOL.md](PROTOCOL.md) for predeclared controls and limitations.

## Outcomes

| Metric | Full upfront | Summary upfront |
| --- | ---: | ---: |
| Hidden acceptance passed | 12/12 | 12/12 |
| Explicit false completion | 0/12 | 0/12 |
| Initially correct tasks modified | 0/4 | 0/4 |
| Initially correct tasks broken | 0/4 | 0/4 |
| Tool calls, total | 56 | 58 |
| Public checks, total | 12 | 13 |
| Public-check failures | 0 | 0 |
| Evidence requests | 0 | 0 |
| Additional full/summary requests | 0 | 0 |
| Raw-log reads | 0 | 0 |
| Initial report bytes, sum | 54,224 | 37,462 |
| Tool response text bytes, sum | 9,172 | 9,310 |
| Cumulative tokens, sum | 168,491 | 167,393 |
| Cumulative tokens, mean per trial | 14,040.92 | 13,949.42 |
| End-to-end seconds, mean | 6.77 | 11.86 |
| End-to-end seconds, median | 6.97 | 7.27 |

Full versus layered has **0 acceptance wins, 0 losses and 12 ties**. Layered uses
fewer tokens in 8 pairs and more in 4; the mean paired difference is −91.5 tokens,
the median paired difference −413.5 tokens. No significance/population claim is
made from six previously studied task clusters.

### Usage categories, not prices

| Provider usage field, sum | Full | Layered |
| --- | ---: | ---: |
| Input | 31,536 | 31,330 |
| Output | 8,187 | 9,727 |
| Cache read | 128,768 | 126,336 |
| Cache write | 0 | 0 |
| Total tokens | 168,491 | 167,393 |
| Reasoning tokens | 1,889 | 3,294 |

Total tokens include repeated context across turns. Reasoning is reported
separately and is not added again to total. Pricing differs by provider and token
category; a 0.65% token difference does not establish 0.65% lower dollar cost.

### Per task, two repetitions per arm

All six tasks passed 2/2 in both arms.

| Task | Full tokens | Layered tokens | Full tools | Layered tools |
| --- | ---: | ---: | ---: | ---: |
| rounding-after-check | 28,238 | 27,411 | 10 | 10 |
| rolling-window-background | 30,815 | 30,789 | 10 | 10 |
| finite-value-count | 32,444 | 26,641 | 10 | 10 |
| stable-dedupe-correct | 26,321 | 21,777 | 8 | 8 |
| negative-probe-correct | 20,238 | 22,203 | 8 | 8 |
| masked-validator | 30,435 | 38,572 | 10 | 12 |

In `masked-validator-r1-layered`, actual tool receipts show an additional source
rewrite and public test after the first public check passed. That pair has
9,612 more tokens than its full-control trial. This is model behavior under the
treatment, not evidence-pagination overhead. No claim is made about the model's
unobserved reasoning or why it chose the extra rewrite.

### Timing, including local work

Initial CLI generation averaged 43.69 ms for full and 45.95 ms for summary.
Mean OMP runtime, including tool execution, was 6.66 s versus 11.75 s.
Post-run audit/evaluation averaged 65.25 ms versus 64.54 ms. End-to-end includes
workspace setup, initial report generation, OMP/tools and final acceptance;
tool time is already inside OMP runtime and must not be added twice.

Mean end-to-end time rose by 75.15%, while the median rose much less. Three
layered trials lasted 23.18–27.27 s; their measured local tool time was only
33.74–50.18 ms. They are retained in all figures. The records do not separate
provider queueing, inference or transport delays, so **do not conclude that the
summary implementation caused the latency increase**. Ordering/cache effects
remain possible despite paired reverse ordering. No product builds/tests ran
concurrently with treatment trials.

## What this experiment does and does not answer

- It measures the whole observed interaction, not just the smaller initial
  report. Here, smaller reports did not produce a substantial total token gain.
- Evidence tooling was functional: the separate smoke exercised two 32-byte
  pages, a wrong-hash rejection and a successful repair. Its 8 calls and model
  usage are excluded from the 24 treatment trials.
- No treatment trial used evidence, pagination, report fallback or raw logs.
  Therefore this study cannot estimate those paths' efficiency, omission risk
  or whether a future event bundle would help.
- The tasks are short and previously inspected, and all passed in the earlier
  pilot. They have a completion ceiling and do not require recovering hidden
  historical state. No conclusion about real-world task completion is justified.
- The initial summary is not always smaller: `negative-probe-correct` is 2,992
  bytes versus 2,972 for full. The other five tasks have smaller summaries.
- This is not a comparison against an ordinary/mechanical summary. Results
  cannot establish AgentXRay-specific diagnostic value against that baseline.

No product code, thresholds, tasks or hidden cases were changed after observing
outcomes. A future study should be separately frozen and include work that
genuinely needs execution history; this result should not be overwritten by a
retuned synthetic rerun. No event-bundle implementation is justified by this run.

## Verification and local artifacts

- 6 experiment selftests pass; 348 existing product tests pass after the run.
- Lint exits zero with the existing 91 warnings and 159 informational diagnostics.
- The audit matches 114 actual `bench` calls to 114 recorded tool results, verifies
  allowlisted file access, checks every returned text hash/byte count, and confirms
  initial report is the only prompt difference within each paired task/repeat.
- Saved code is independently regraded against frozen hidden cases, agreeing
  with all original results. Usage categories sum to reported total tokens.
- Resumption audits/reuses all 24 saved trials with unchanged model-event files
  and zero new model calls. All 47 frozen source hashes remain unchanged.

Ignored `output/layered-comparison/` contains `manifest.json`, `frozen/`,
`trials/<id>/`, `summary.json`, `audit.json`, `resume-audit.log`, `selftest-final.tap`,
`product-tests.tap` and `product-lint.log`. Recompute the aggregate with
`node experiments/layered-comparison/run.cjs summarize` without invoking a model.
These local receipts are not publicly hosted or included in the npm package.
