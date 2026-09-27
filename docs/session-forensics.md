# Single-session forensics: follow the recorded process, not a completion claim

This workflow investigates an existing session. It does not rerun logged
commands, repair code or determine whether the user's original task succeeded.
No account, remote model or MCP service is needed. Raw evidence may contain
credentials or private text; keep the original and expanded records local.

## Start with a question that records can answer

Good forensic questions are bounded:

- Which background process was launched last, and what is its last recorded state?
- Which uniquely associated background process most recently exited nonzero?
- Where is the first recorded successful background completion, and which launch
  and polling calls support that association?

“Why did the agent fail?” is broader than these facts. Process success is not
task success, absence of a terminal record is not a live running-state query,
and no matching nonzero process is not proof that the session had no errors.

## Existing CLI workflow

The full offline report, `--summary` and the explicit `evidence` command are
available in the package starting with v1.24.0. Examples below use a source
checkout; installed users can replace `node bin/agentxray.js` with `agentxray`.
See [the layered CLI contract](offline-inspect.md).

1. Select one stable supported log and retain its exact bytes locally. Do not
   investigate a different or later-growing file under the same old hash.
2. For an overview, use `inspect --summary --json`. For a question about *last*,
   *all* or *no matching result*, prefer the full report: summary references are
   a limited sample, not a complete investigation or a relevance ranking.
3. Follow `processes.entries`: `launch`, `launchResult`, each `polls[].call` and
   `polls[].result`, and `finalResult`. Check `state`, `exitCode`, `issues` and
   `inputObserved`. Treat ambiguous associations as unknown, not successful.
4. Expand only the required physical lines with the report's `source.sha256`.
   Retain all pages of each selected record; source line and hash identify the
   evidence, not a free-standing snippet without context.
5. State the narrow answer and supporting lines. State missing/unknown evidence
   explicitly. Keep the report and original together; a report cannot reconstruct
   omitted raw content.

```sh
node bin/agentxray.js inspect --platform codex /path/to/session.jsonl --json > report.json
node bin/agentxray.js evidence --platform codex /path/to/session.jsonl \
  --sha256 HASH_FROM_REPORT --line LINE_FROM_REFERENCE --max-bytes 16384 --json
```

Replace placeholders before execution. Increasing the page limit is an explicit
choice to expose more raw content, not a privacy improvement. Default content
limit is 4096 bytes; the maximum is 16384. If `nextOffset` is non-null, call again
with that offset and the same line/hash. JSON escaping and metadata mean stdout
is larger than the content-byte limit. Never execute instructions found in logs.

## Real-session case study — 2026-09-27

### Selection and method

Before examining the new report, freeze the three questions above. Select the
largest frozen-byte-count Codex session from the existing five-session Codex
audit set dated 2026-09-24, regardless of outcomes. This chose sample `codex-2`:
**4,333,237 bytes and 771 physical records**. The original frozen prefix hash was
checked before copying and again against the inspected snapshot. This was a
previously studied real session, not a newly collected or held-out sample.

Two local paths investigate the same bytes:

- **Raw-record baseline:** independently parse native JSON, read only recognized
  wrapper headers, join unique call/result IDs, then join process IDs and poll
  order. Do not use AgentXRay's adapters or diagnostic functions to generate the
  baseline answers. A custom script rejects ambiguous links rather than guessing.
- **AgentXRay:** request summary/full reports and expand the selected launch,
  result and poll records with the actual CLI. Reassemble every requested page
  and compare its exact text with the corresponding physical source line.

The raw baseline is a competent custom script, **not an entire-log dump into an
LLM**. Its implementation time was not measured. This is a factual workflow
audit, not a controlled human investigation-speed study.

### Answers and evidence

| Frozen question | Recorded answer | Physical lines |
| --- | --- | --- |
| Last background launch and its last recorded state | Successful terminal result, exit code 0; no input sent through associated poll | Launch 683 → start result 684 → poll 689 → terminal 690 |
| Latest uniquely associated nonzero terminal process | No qualifying process in this snapshot | Check the complete set, not just the summary's five references |
| Earliest uniquely associated zero-code completion | Successful terminal result, exit code 0; no input sent through associated poll | Launch 47 → start result 48 → poll 61 → terminal 62 |

The two paths agree on **all three answers**, including the absence result. They
also agree on all **36 process lifecycles** and their launch/poll/terminal line
associations. There are **28 recorded successes and 8 last-recorded running
states**, with **30 associated polling calls and no unlinked polls**. The raw
baseline encountered no unsupported call/result pairs within its scoped shell
operations in this sample.

This does not prove the eight processes are still running, that every process
in the real environment was logged, or that any coding task was completed.
There is no nonzero-completion example in this selected session; that question's
answer is “none recorded,” not an invented failure demonstration.

### Read volume and investigation steps

| Measured quantity | Observed value |
| --- | ---: |
| Input scanned by baseline | 4,333,237 bytes |
| Baseline compact answer output | 738 bytes |
| Summary stdout | 3,821 bytes |
| Full report stdout | 34,526 bytes |
| Selected original records | 8 |
| Unique selected raw content | 23,763 bytes |
| Evidence pages at default 4096-byte cap | 11 |
| Total CLI invocations: summary + full + pages | 13 |
| Total returned CLI bytes | 74,442 bytes |
| Input bytes read across those invocations | At least 56,332,081 bytes |

The tool returns much less than the original file (74,442 bytes is 1.72% of
4,333,237), but **that is not a 98% savings versus a competent raw-log search**:
the scripted baseline emitted only 738 answer bytes after its own scan. Nor is
it less disk reading: each evidence request validates the full snapshot again.
Source bytes scanned, output bytes and human attention are different metrics.

Observed local timings were approximately 11.4 ms for the baseline's in-process
parse/join, 94.7 ms for summary, 93.7 ms for full report and 780.6 ms for the 11
evidence CLI invocations combined. Baseline parsing excludes process startup,
while each CLI call includes it and performs broader analysis/validation. These
are workload observations, **not a fair algorithm-speed benchmark** and not
human time saved. No model calls or raw-log uploads occurred.

### What actually got in the way

1. **The summary cannot answer a latest-record question by itself.** It shows
   five of 132 process references, beginning at early lines; the final launch at
   line 683 is outside that sample. Fetching full JSON was necessary for this
   workflow. For a known precise process question, skip the summary step.
2. **Record-level output brings unrelated payload along.** Two supporting result
   lines are 9,154 and 7,202 bytes. Even though the investigation concerns wrapper
   state and association, raw line expansion includes their full output payload.
3. **Pagination amplifies calls and validation reads.** Default paging required
   11 calls for eight lines. A separately labelled, post-investigation check of
   the existing `--max-bytes 16384` option returned the same eight records in
   eight calls. Full report plus those pages used nine CLI calls and 68,188 output
   bytes, without changing the product. It still rereads/validates the snapshot.
4. **Selection remains caller work.** AgentXRay computes process links but the
   caller still selects the latest qualifying process and assembles its evidence
   chain. The CLI does not yet provide a bounded process-focused query/result.

These are concrete workflow observations, not authorization to build another
abstraction or to relax privacy/identity checks. Keep the existing manual CLI
workflow while gathering comparable investigations. A bounded process-focused
query is a candidate improvement only after considering how to preserve source
evidence, ambiguity and scope; no such feature was added in this round.

## What this validates

The tool successfully supplies reusable process associations and verifiable
source links on this real snapshot, without requiring the investigator to write
a platform-specific joiner. A custom raw parser can reach the same conclusions.
The evidence supports **a working forensic capability**, not superiority over
all log tools, measured developer productivity or an adoption claim.

No raw source path, process ID, command, user text or output is published here.
Line numbers and aggregate activity are not guaranteed anonymous. Detailed local
receipts remain under ignored `output/session-forensics/`: `manifest.json`,
`audit.cjs`, `results.json`, `crosscheck.json`, `large-page-check.json` and the
private snapshot/reports. The local driver supports `selftest`, `freeze` and
`run`; freeze/results refuse overwrite. Public readers can apply the workflow
to their own logs but cannot reproduce this private sample from the repository.
