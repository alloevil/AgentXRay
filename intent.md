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

## Non-goals

- No new platform, dependency, model call, account, telemetry, cloud log storage or automatic command execution.
- No automatic human judgments of real sessions, relaxed argument matching or fabricated accuracy/productivity/adoption claims.
- No changes to the frozen legacy UI, unrelated repository infrastructure or user's running services.
- Narrow-screen checks do not certify physical devices, software keyboards or all analytics/Trace/library screens.
