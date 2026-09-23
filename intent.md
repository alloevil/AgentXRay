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

The active `protect-default` ruleset requires a pull request and the `test` check. A local release commit can be prepared now; creating a new release branch requires explicit authorization before pushing and opening its PR. Do not bypass the ruleset.

## Non-goals

- No new platform, dependency, model call, account, telemetry, cloud log storage or automatic command execution.
- No automatic human judgments of real sessions, relaxed argument matching or fabricated accuracy/productivity/adoption claims.
- No changes to the frozen legacy UI, unrelated repository infrastructure or user's running services.
- Narrow-screen checks do not certify physical devices, software keyboards or all analytics/Trace/library screens.
