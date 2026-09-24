# AgentXRay: evidence-backed session review

## Goal

Help developers review their existing coding-agent logs locally: identify recorded failures, group repeated operations without losing evidence, record human review notes, and reopen review when evidence changes. Product usefulness and GitHub adoption are not established by feature count.

## Agreed behavior

- Failure detection describes loaded logs, not final task correctness. Only a later-started call with the same tool and complete arguments can provide automatic recovery evidence.
- Group unresolved failures by complete tool arguments and the call's user turn. A successful result separates groups. Missing arguments stay separate; object key order is ignored, parameter values and array order are preserved.
- Preserve every failure result and its evidence jump. Group membership is not proof of a common cause, serial retries or time wasted.
- OMP-native result states distinguish success/failure/running/cancelled/unknown, preserve original fields and expose source evidence. Arbitrary nested errors and daemon history are not automatically current execution failures.
- Human review notes are separate from automatic outcomes. Notes require evidence, stay in browser localStorage and are invalidated by changed full-result fingerprints; do not silently hide new failures.
- Below 768px use session-list/content navigation; desktop keeps two columns. Keep same-session drafts mounted while opening navigation. Evidence jumps scroll the message pane rather than moving the page navigation.

## Acceptance

- Node tests, UI build, lint and generated legacy-file drift checks pass.
- Synthetic browser walkthrough covers event membership, evidence jumps, review save/reload/isolation/staleness, storage failure, narrow-screen navigation and desktop regression.
- Published verification uses synthetic fixtures and aggregate descriptions only. Personal log manifests, raw output, local analysis scripts and browser run artifacts stay in ignored `output/`.
- Public instructions and screenshots are in `docs/diagnostics.md` and `docs/diagnostics-verification.md`; prior detailed local history remains in `output/release-1.18.0/intent-history.md` on the development machine only.

## Release authorization (2026-09-23)

The user explicitly requested commit, publish, then continued improvement. This supersedes the earlier development-only no-commit/no-publish boundary.

1. Release the tested feature set as v1.18.0 via the existing GitHub Release → npm workflow, after CI passes.
2. Verify the npm package/version and GitHub Pages deployment; do not claim publication based only on creating a tag.
3. After release, add a clearly synthetic failure-event walkthrough to the existing hosted demo so visitors can try the new workflow without local logs. Use the existing fixture generator and keep the current default demo session intact.
4. Keep version/lockfile, documented test counts and claims checks consistent. Never publish personal evaluation artifacts or credentials.

The active `protect-default` ruleset requires a pull request and the `test` check. The user subsequently authorized autonomous branch/PR creation, publication and roadmap changes. Follow the protected-branch workflow; do not bypass the ruleset.

## Hosted diagnostics walkthrough (next increment)

- Add one hand-written synthetic OMP session to the existing sample-log directory and regenerate bundled fixtures with the real backend.
- Keep the existing default demo session and all prior samples. Add a demo-only entry action that opens the diagnostic sample from any current tab or child transcript.
- The sample must produce 7 pending failure records in 2 events: 6 same-argument edit failures and 1 nested search failure; one earlier bash failure has a matching successful retry. A background bash start is not successful completion.
- Display a compact, clearly synthetic walkthrough with the actual counts, evidence/review instructions and a link to local usage. It does not upload notes, add model calls, or simulate live recovery in the static demo.
- Test the raw sample through the real parser and diagnostic rules, and assert the generated fixture matches it. Verify the hosted entry, evidence jump and browser-local review on desktop and narrow screens.
- Update the roadmap around measurable acceptance: public walkthrough first, safe review portability next, then owner dogfooding with explicit review outcomes. No star-count/adoption promise, no fabricated demand rankings, and no date promises.
- Publish through a separate protected PR/Pages deployment after the v1.18.0 release; do not mutate or republish the existing npm version.

Release receipt: PR #48 merged as `c882564`; v1.18.0 Publish run `35880348489` succeeded. The official npm registry reports latest=1.18.0, and a fresh temporary installation returned that CLI version and served the bundled review UI plus a synthetic OMP result. Registry processing delay was observed before successful installation; no global npm registry configuration was changed.

Hosted walkthrough acceptance: 216 tests pass, including raw-to-bundled fixture parity; regeneration is deterministic. Desktop and 360px browser checks cover the entry from another view/navigation, all six edit evidence links and local review with zero API requests. A height cap fixes the guide hiding the transcript on short screens; 740×360 remains cramped and is documented rather than called full mobile support.

## Review portability increment

- Continue the authorized roadmap with a current-session review transfer file, no backend or dependencies. Reject whole-browser scans, cross-directory fuzzy matching and silent overwrites.
- Export only valid, non-stale reviews for currently loaded automatic events. Construct a whitelist of hashed storage keys, evidence fingerprints, human statuses, notes and timestamps; no automatic logs, arguments, paths or session titles. Preview the exact JSON before a user-triggered download and warn that hand-written notes may contain secrets.
- Import a bounded JSON file (1 MiB, at most 500 unique records), validate the exact versioned schema and identifiers before accessing storage. Show all notes and per-record decisions before explicit confirmation. Treat files as untrusted human notes, not authenticated success evidence.
- Only exact current-event identity and full-evidence fingerprint matches with empty local slots may be imported. Distinguish unmatched, stale, already identical and conflicting local records; skip every existing slot, including corrupt/stale local entries. Never alter automatic failure/recovery counts.
- Recheck current evidence and local storage on confirmation. Invalidate previews when the active event set or loaded reviews change. If individual writes fail, report imported/skipped/failed counts accurately, preserve prior successes, never claim an atomic transaction or roll back other tabs.
- Export/import works between browsers or ports with identical platform, configured directory, session/child scope and evidence. Changed configured directory, missing/recovered events and changed transcripts intentionally do not match. This is not whole-history backup, encryption or collaborative conflict merging.
- Test privacy whitelist, limits/schema/version, duplicates, wrong scope, stale fingerprint, conflicts, unreadable storage, write failures, race rechecks and no-write preview; use synthetic browser migration across isolated contexts with zero review network requests.
- Publish as a new minor release through protected PR and the existing Release workflow after all checks pass. Keep private evaluation output ignored. Update claims/test totals, public guidance and roadmap acceptance without claiming productivity gains.

Portability acceptance: 17 new transfer tests and 103 focused tests pass. Browser tests exercised an actual 2-record download/import into an isolated browser, a different-origin restore, stale and cross-tab preview invalidation, no-overwrite conflicts, schema/size rejection, literal HTML notes and partial write failure/retry. Prepare v1.19.0 and verify the actual registry package and Pages deployment after protected checks, without mutating the prior v1.18.0 release.

## Follow-up evidence candidates (approved 2026-09-24)

- Add two explainable candidate relations, not semantic recovery: same tool with only top-level `i` differing; or a later explicit edit/write of the same recorded file in the same call-origin user turn.
- Candidates must have a recorded result and a call started after the event's last pending failure. Exclude pre-existing parallel calls, same-signature repeats, orphan/missing arguments and unrecognized modification tools. Record order, not wall-clock guessing, determines "later".
- Same-file tools are `edit`, `Edit`, `write`, `Write`, `MultiEdit`; support `path`/`file_path` only when unambiguous. Compare paths literally; require absolute paths or identical explicit absolute working directories for relative paths. Preserve cwd/workdir/working_directory distinctions. No filesystem resolution, symlink guessing, command parsing, cross-turn same-file links or cross-session/child joins.
- Only-i candidates may cross user turns within the currently viewed transcript; label their call turn. Compare every other argument value, not just a text preview. Do not strip `i` from the original automatic recovery rules.
- Each candidate shows the exact relation, call/result positions, five-state result status with its source fields, an output excerpt and a jump to the original result. Running/unknown/cancelled never display as successful verification. Show five initially, with all remaining candidates reachable and no silent success-only filtering.
- Failure/event/recovery counts and event membership must remain byte-for-byte equivalent on the frozen 15-session/2,024-result audit. Candidate success does not close an event, prove causality or certify the task.
- New/changed candidate evidence invalidates human review fingerprints for affected events; storage keys remain stable. Events with no candidates retain the previous fingerprint input to avoid unrelated invalidation. Transfer still contains only hashes and human notes, not raw candidate evidence.
- Validate synthetic counterexamples and the frozen real-log prefixes; preserve raw logs privately, output only sample numbers, relation/status counts and line numbers. Real data previously inspected is regression evidence, not a blind accuracy or time-saving benchmark.
- Update the isolated walkthrough and documentation. Do not introduce dependencies, model calls, new APIs, automatic commands, arbitrary error parsing, or change platform adapters.

Acceptance results: 255 tests and 125 focused checks pass. The frozen 15-session/2,024-result regression retains every original failure/event member and all counts. Strict matching finds three only-i candidates (failure/running/success); no same-file candidate qualifies in that real set because paths lack explicit directory context or turns differ. Synthetic same-file and five-state browser checks, load-more, result jumps and candidate-triggered review staleness pass. Prepare v1.20.0 via the authorized protected PR/release workflow, verify registry installation and public Pages before claiming release completion; do not publish private logs or raw evaluation artifacts.

## Automatic session health (approved 2026-09-24)

- Default to an automatic factual report, not a human-review queue. Show every diagnostic event regardless of saved manual labels. No user tagging, model invocation, account or network call is required.
- Summarize existing failure records, exact-argument recovery evidence, remaining events, repeated unresolved operations and unique follow-up result states. Candidate success is not automatic recovery; totals use documented units rather than a health score.
- Independently summarize each recorded tool call's last result in this transcript: success, failure, running, cancelled, unknown, or no recorded result. Calls/results link only by recorded ID and order. Orphan results and ambiguous/reused or missing call IDs are reported separately, never guessed. These are last-recorded states, not live process status or proof that a session ended.
- Surface running/unknown/no-result call evidence with original call/result navigation, including sessions without detected failures. Never call absence of detected failures task success.
- Keep manual notes and transfer as an explicit optional mode. Do not read/hash review storage before opt-in, delete saved notes, or allow its failures/labels to affect the automatic view. Switching back restores all automatic events.
- Preserve diagnostic rules, platform adapters, candidate matching and existing review fingerprints. Only add a derived summary and presentation changes.
- Add deterministic offline transformation tests with the same base data/rubric: append/remove success, alter command/cwd/i, insert pre-started parallel calls, pending/cancelled/unknown results, and verify exact expected outcomes plus complete evidence membership. Test shared candidate deduplication, ambiguous IDs, no-result/orphan records and input immutability.
- Validate against synthetic UI plus unchanged frozen-log failure/event outputs. Test metrics are known-case coverage and invariants, not human time saved or real-world accuracy. Publish no raw logs or automatic human labels.

## Modification / verification chronology (2026-09-24)

Continue the automatic-health worktree toward an execution-evidence product rather than adding another generic dashboard. User authorized autonomous improvement and roadmap changes; manual tagging is not a prerequisite.

- Recognize explicit `edit`, `Edit`, `write`, `Write`, `MultiEdit` calls with one unambiguous recorded `path`/`file_path`. Only a uniquely paired successful result is a completed modification-tool record; it does not prove bytes changed. Failed/running/unknown/no-result mutation calls remain visible in coverage counts. Patch/shell-embedded modifications are not parsed or guessed.
- Recognize only simple direct shell invocations of common test runners (`pytest`, `python[3] -m pytest`, `node --test`) and package-script conventions (`npm test`, `npm run test/build/lint/typecheck`, equivalent direct pnpm/yarn forms). Label runner vs script-name evidence separately; script bodies and actual coverage are not known. Reject compound commands, substitutions, quotes/redirection, help/watch/list-only modes and directory-changing flags. Count unrecognized shell commands explicitly.
- Compare call/result record order, not wall-clock guesses. A verification call must begin after a modification result to count as later. A prior result must finish before the modification call to count as prior; overlapping/in-flight checks are separate, never post-change validation. Keep the latest recorded state, including failures/cancelled/unknown/missing results; do not cherry-pick a passed check.
- Timeline is within the viewed transcript, not a proof of file coverage. Matching explicit absolute working directories is stronger scope evidence; missing directory context is labelled unknown. Known-different/conflicting directory contexts are excluded from the relation and counted. Do not resolve files, infer implicit `cd`, or assume the initial session cwd remains current.
- Surface the actionable fact “a check succeeded, then a modification tool succeeded, and no later recognized check is recorded” with both source jumps; do not say “bug”, “task failed”, “tests cover the file” or “ready to ship”. Every check and modification has access to its original call/result evidence. No verification is executed.
- Preserve all automatic diagnostics/candidate/review-fingerprint semantics. Reuse conservative unique-ID pairing for health and chronology; ambiguous/orphan IDs do not supply success evidence. Keep manual storage opt-in.
- Add deterministic temporal transformations (check→edit vs edit→check, overlap, failure after earlier success, delete/missing results, cwd mismatch) and frozen real-log coverage checks. Record recognized/excluded categories and keep production claims bounded by actual data. Do not upload private logs or add model calls/dependencies.

Real-log coverage refinement: the initial direct-only classifier recognized zero checks because logged shell commands are predominantly compound. Support a bounded, non-executing lexer for literal command segments with quotes, `&&`, `;`, newline and simple pipelines/redirections. Direct checks and a sole literal absolute `cd ... && check` may use the whole-call outcome; other recognized fragments are explicitly labelled "command contains a check; whether this fragment ran/passed is unknown", regardless of wrapper exit code. Reject substitutions, heredocs, shell control syntax and quoted executable names. Quoted strings in echo/python arguments must never become executable segments. Do not treat compound snippets as proven verification or infer their working directory. This replaces blanket compound exclusion, not the no-guessing/coverage boundary.

Validation: 290 tests pass, including 200 fixed health transformations and 120 temporal transformations without human labels. The frozen 15-session/2,024-result set retains exact v1.20 diagnostic output. It yields 59 check-containing calls, all with unknown fragment outcome; no check-coverage or task-success claim is made. Explicit edit/write tools return successfully 240 times; 112 have later check-containing calls and 128 do not. Browser checks cover default zero review-storage reads, optional-note preservation, live missing-result resolution, before/overlap/after chronology, source navigation and 390px rendering. Prepare the combined increment as v1.21.0 through the authorized protected PR/release path after final gates; keep the continuing project goal active, and do not claim real productivity or adoption from this release.

## Explicit Codex process evidence (2026-09-24)

- Real frozen Codex logs contain 60 exec_command background-start envelopes and 53 write_stdin calls. Improve the missing cross-call lifecycle evidence instead of adding generic metrics. No SDK, new API or execution is needed.
- Parse only recognized Codex wrapper headers before Output/Final output, on exec_command/write_stdin (including functions.* names). Do not interpret matching text in stdout or outputs of read tools. Require an unambiguous numeric process ID and unique call IDs within the loaded transcript; no cross-session/child joins.
- Link write_stdin session_id to a single recorded launcher only after that launch result. Preserve every polling call/result, whether input was sent, and terminal exit code. A reused process ID, overlapping polls, mismatching wrapper ID, malformed/error result or conflicting terminal sequence cannot certify completion.
- Show process lifecycle separately from per-tool-call last states: polling is not another launch. Never rewrite historical call results, existing failure/event/recovery rules or human review fingerprints. A process's last running observation is not a live status query.
- Verification chronology may use a uniquely associated terminal result, but must retain the original launch index/time. A check started before a modification and finished through a later poll remains overlapping, not post-change verification. Compound shell fragments still have unknown check outcomes. Input sent to a running process weakens check certainty; it is not silently treated as a clean test run.
- Add deterministic counterexamples and real frozen-log relationship checks before publication. Keep detailed process IDs, log text and commands private; public examples/screenshots are synthetic. Whole-process exit code is not subcommand coverage or task correctness.

Validation results: the frozen corpus has 60 Codex starts and 53 uniquely linked polls: 48 successful process exits, 1 failed exit and 11 last-recorded running starts. All prior per-call health and failure/candidate/recovery outputs remain identical. The implementation adds 23 tests including 40 fixed terminal transformations and generated-demo/raw-parser parity. Synthetic browser checks cover terminal-result jumps, original-start overlap semantics, unlinked poll counts, live completion and 390px layout. Prepare v1.22.0 through the previously authorized protected PR/release workflow after final checks; no private evidence or logs are published.

## Continuing boundaries

- No new platform, dependency, model call, account, telemetry, cloud log storage or automatic command execution.
- No automatic human judgments of real sessions, relaxed argument matching or fabricated accuracy/productivity/adoption claims.
- No changes to the frozen legacy UI, unrelated repository infrastructure or user's running services.
- Narrow-screen checks do not certify physical devices, software keyboards or all analytics/Trace/library screens.
