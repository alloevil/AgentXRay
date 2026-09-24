# Diagnostics verification receipt

This receipt accompanies the evidence-backed diagnostics, local review queue and narrow-screen session workflow. All public screenshots and demo fixtures are synthetic. Personal session logs, sample manifests, review notes and detailed local evaluation artifacts are not distributed.

## Reproduce from a checkout

With Node 22.13+ and the project dependencies installed:

```sh
npm test
npm run build:ui
npm run lint
git diff --exit-code -- public/js/pure.js
node scripts/demo-diagnostics.cjs
```

Open the printed URL and select the OMP session marked `[Synthetic]`:

- Initially 72 unresolved failure records form 7 events, with 66 repeated edit failures in the first event. One earlier failure already has a matching success.
- First/last/all-evidence actions retain every original result, including results outside message pagination.
- Save a human review note. Refresh retains the note; another session cannot inherit it. Human status never changes automatic failure counts.
- Enter `n` in the terminal to append a synthetic failure. The repeated event now contains 67 failures and its previous review becomes stale.
- Enter `r` to append matching success. Six events and six unresolved records remain, with 68 automatically recovered failures (67 if `n` was not used).
- Enter `q` or Ctrl-C to stop the isolated server and clean up its temporary HOME.

## Recorded checks (2026-09-23)

| Check | Result |
| --- | --- |
| Node test suite | 214 passed, 0 failed, 0 skipped |
| Diagnostics/events/OMP/review focused suites | 84 passed |
| UI build | TypeScript and Vite passed |
| Lint | Exit 0; existing 91 warnings / 159 informational findings |
| Legacy generated bundle | No drift |
| Review persistence | Save, refresh, session isolation and cross-tab updates passed |
| Review invalidation | New failure/full-result changes reopen review; stale notes remain distinguishable |
| Storage failure | Read denial, corrupt records and write failure visibly reported; failed save never claims success |
| Evidence navigation | First/middle/last results retained; pagination expands and target is shown |
| Narrow screens | 360×640, 390×844, 740×360, 768×1024 and 1440×1000 checked |
| Touch simulation | Chromium mobile/touch taps navigate and save review |
| Virtual session list | 240 synthetic sessions; initially 16 rendered cards, final item reachable |

At 360px viewport width, the real session diagnostic panel measures 340px (the old fixed-sidebar layout left 44px). At 740×360, 75px remains for transcript scrolling; portrait orientation is more comfortable. On mobile and desktop, evidence jumps retain `window.scrollY=0` when starting at the top.

The preceding private, already-inspected regression set had 30 sessions and 9,076 tool results. Its 438 unresolved records grouped into 373 events while retaining all evidence; 373 in-memory synthetic review labels were checked for isolation and invalidation, then discarded. These aggregate counts are contextual observations, **not a public benchmark, independent human judgment, accuracy measure or proof of time saved**. The private dataset is deliberately not included; the commands above reproduce the public synthetic acceptance tests.

## Screenshots

![Synthetic event grouping](../screenshots/diagnostic-events.png)
![Synthetic human review](../screenshots/diagnostic-reviews.png)
![Synthetic narrow-screen review](../screenshots/diagnostic-mobile.png)

## Limits

- Human notes are unencrypted, browser-local and origin-specific; they are not authenticated evidence or a backup.
- Alternate commands, implicit working directories, background-task chains and semantic equivalence are not inferred.
- Existing aggregate statistics retain their original error-field semantics and may differ from diagnostic counts.
- No physical iOS/Android device, Safari or software-keyboard certification is claimed. Other complex pages are not fully covered by the narrow-screen checks.
- Existing lint findings and the Vite large-chunk warning remain; no claim of zero technical debt is made.

## Release and hosted walkthrough follow-up

The feature release is available as [v1.18.0](https://github.com/alloevil/AgentXRay/releases/tag/v1.18.0). Its [Publish run](https://github.com/alloevil/AgentXRay/actions/runs/35880348489) succeeded with a package tarball and provenance attached. An isolated installation from `https://registry.npmjs.org` returned CLI version `1.18.0`; the installed server served a synthetic OMP failure with normalized status and the bundled review UI. The initial registry query preceded npm processing and returned 404; success was recorded only after the registry and installation became available.

A separate hosted-demo increment adds the explicitly synthetic `0199demo-diagnostics` session and a **Try diagnostics** entry, leaving the default Claude demo and previous samples intact. Raw parser output and bundled messages are asserted equal by tests; 216 total Node tests now pass (two additional hosted-fixture tests). The existing 214-test count above records the release acceptance, not the updated suite size.

The hosted sample has 8 historical failures: one has a matching successful retry, leaving 7 pending records grouped into 2 events (6 edit failures and 1 nested search failure). A background start stays running. Six individual edit results, evidence jumps and browser-local review were verified; no backend API requests were made during the static walkthrough. Fixture regeneration produced identical bytes twice.

The demo-only guide is height-limited on short screens. Expanded guide checks leave about 102px for messages at 360×640 and 224px at 360×800; at 740×360 landscape only 35px remains, so portrait use is recommended. This does not change the normal local application's layout or imply physical-device certification.

## Review portability acceptance

The next increment adds explicit current-session export/import, not whole-history backup. Run `node --test test/review-transfer.test.js` for its 17 cases; the combined focused diagnostic/review suite contains 103 tests and the full suite contains 233 tests. Earlier counts above record earlier releases, not the current suite size.

Verified using synthetic notes and isolated browser contexts only:

- Actual JSON download contains only allowed hash/status/note/time fields. Unrelated browser storage, raw tool output, command arguments and paths are not copied. Acknowledgment is required before downloading or importing.
- Two notes migrate to an empty browser after a no-write preview and persist after refresh. Re-import is classified as identical and skipped; a different local note is a conflict and retained.
- An HTML-shaped note displays literally and does not execute. Unknown fields, malformed JSON, duplicate records, invalid identifiers, files over 1 MiB and lists over 500 records are rejected.
- Adding a failure while a preview is open disables confirmation. Re-preview imports the one still-matching event and skips the stale one. A different session skips both records.
- An independent `localhost` origin accepts the matching review exported on `127.0.0.1`; another tab writing first invalidates the preview and preserves that local note.
- A simulated quota failure on the second write reports **1 imported / 0 skipped / 1 failed**. Re-preview reports **1 imported / 1 skipped / 0 failed** on retry, preserving the first import. No atomic rollback is claimed.
- Browser migration sent zero backend write requests; automatic failure/recovery counts remained unchanged. At 360px, the transfer panel had no horizontal overflow.

This does not verify real-device file pickers, simultaneous cross-tab transaction safety or actual productivity gains. The file is unencrypted human text, not signed evidence; only current exact matches can be restored. Detailed local run artifacts remain ignored and are not published.

## Follow-up evidence acceptance

The follow-up increment adds evidence-only relationships, not automatic recovery. There are 22 new tests in `test/follow-up-evidence.test.js`, 125 combined diagnostic/review tests, and 255 tests in the full suite. The ordinary and hosted-demo UI builds pass; earlier counts above are historical release receipts.

Synthetic tests cover all five candidate states, only-top-level-`i` differences, complete argument comparison, exact tools, same-turn edit/write paths, explicit relative-path directories, missing/ambiguous fields, pre-existing parallel calls, missing results, call-turn vs result-turn, deduplication, full candidate output in review fingerprints, and unchanged exact-match recovery. The scripted demo `node scripts/demo-follow-up.cjs` exercises seven only-`i` candidates, one same-file candidate and excluded file/turn counterexamples. The browser checked all five labels, five-item initial display plus loading the rest, original result jumps, no page-navigation movement, stale review on newly appended candidate and no narrow-screen overflow.

A fixed, previously inspected set of 15 real sessions (five each from OMP, Codex and Claude Code) with 2,024 tool results was re-read by frozen-length/hash verification. Automatic results stayed at **142 failures, 141 pending records, 76 events and 1 recovered record**, including unchanged event members. An independent relation enumeration agreed with every candidate. It found **3 only-`i` candidates in OMP: one failure, one running result and one success**; Codex/Claude had none under these strict rules. No same-file relation qualified in this set: relevant observed paths lacked explicit absolute context or the calls belonged to later user turns. The code did not weaken criteria to inflate matches.

Storage keys stayed stable. Only the three events with added candidates acquired new review fingerprints; no-candidate events retained their previous fingerprint contract. No real review labels were persisted. Raw logs, parameters and detailed sample identifiers remain private; the regression is not an independent benchmark, global accuracy estimate or time-saving measurement.

The hosted synthetic sample now includes one later successful edit of the same absolute file path with different arguments. It remains **2 events / 7 pending records / 1 recovered record**. Browser checks verified the relation caveat, source result, desktop/mobile rendering and zero static-demo API requests.

## Automatic health and chronology acceptance

The next increment makes automatic facts the default. Saved manual labels do not hide automatic events, and the review store is not read or hashed until **人工笔记与迁移（可选）** is opened. Existing notes and transfers remain available. Refresh or returning to automatic mode shows all events again.

The test suite now has **290 passing Node tests**. `test/session-health.test.js` contains 11 cases including **200 fixed transformations** over 20 synthetic bases; `test/verification-chronology.test.js` contains 24 cases including **120 temporal transformations** over 20 bases. All known outcomes, evidence partitions and call-state accounting invariants pass without a model judge or human labels. These counts are regression coverage, not measured real-world accuracy or user time saved.

Health pairs only unique, ordered call IDs; it summarizes the last recorded state and separates unknown/no-result/running from failure and cancellation. Reused or absent IDs do not supply success evidence. One candidate referenced by multiple events is counted once by result position. Tests verify source messages are not modified.

Chronology distinguishes successful modification-tool results, prior successful checks, overlapping checks and later attempts. A later failure stays visible even if an earlier attempt passed; simultaneously initiated checks do not get an invented uniquely latest order. Known-different explicit directories are excluded and missing directory context is explicit. Tool success does not prove bytes changed; conventional script names do not prove contents or test coverage.

The initial direct-command recognizer found **zero checks** in the frozen real-log set. A bounded lexer was added for explicit command segments instead of hiding that coverage gap. It recognizes **59 calls containing checks** (52 OMP, 7 Claude Code), all with **unknown check outcome** because the commands are compound; a pipeline's successful exit is not assigned to its test fragment. Substitutions, heredocs, control flow and quoted mentions are not interpreted as executed checks. The Codex subset had no recognized checks or explicit edit/write records under this scope, so no conclusion about its verification quality follows.

The same 15 frozen sessions / 2,024 tool results retained exactly the v1.20.0 diagnostic output: 142 failures, 141 pending records, 76 events and 1 recovery. Explicit modification tools returned successfully 240 times; 112 had later recognized check-call/fragment records and 128 did not. **These are temporal relations only**—none establish that the modified file was tested, and unclassified commands may contain validation. The dataset was previously inspected, includes old sessions and is not a blind benchmark. Raw data and detailed sample IDs remain private.

Browser checks used synthetic fixtures only:

- Automatic mode works with review-storage reads denied; zero review-key reads occur before opt-in. Optional manual filtering returns to the complete event set on exit, and notes persist without becoming mandatory.
- A no-result call gains a recorded result without a reload; gaps fall from 3 to 2 while unrelated failures remain unchanged.
- A check passes before a modification; a second check overlaps it and a third uses another directory. None is reported as post-change validation. Appending a failed later check then a successful one updates the latest result and retains both attempts.
- Call/result jumps resolve to actual source records without moving outer page navigation. At 390px the chronology panel has no horizontal overflow; static demo uses zero backend API requests.

Use `node scripts/demo-verification.cjs` to replay the temporal example and `node scripts/demo-follow-up.cjs` for missing-result updates. The public hosted demo exposes the earlier-test/later-edit example under automatic health. Physical-device keyboards and every complex view are not certified. Existing lint findings (91 warnings / 159 infos) and bundle-size warnings remain.

## Codex background-process acceptance

This increment associates explicit Codex process IDs from launch result headers with later `write_stdin.session_id` calls. It does not rewrite the historical per-call state, failure counts, recovery or human review data. Process outcomes are a separate evidence chain; the original launch index is retained when chronology uses a final polling result.

The full suite has **313 passing tests**. The **23 process-evidence tests** cover success/failure/running/missing results, output-text false positives, malformed/contradictory headers, noncanonical identifiers, duplicate calls/results, reused process IDs, overlap, post-terminal polls, input-sending calls, source references, qualified tool names and multiple launches in one message. Forty fixed transformations verify terminal-result append without inferring automatic recovery. The generated hosted sample is asserted equal to the real Codex parser output.

The frozen real corpus was re-read under content hashes: all previous `diagnoseSession` and `summarizeSessionHealth` outputs match v1.21.0 exactly. In its Codex subset, 60 launch headers and 53 polling calls yielded **53 uniquely linked polls**, **48 successful process exits**, **1 failed exit**, and **11 launches whose last evidence is running**. Every process association and terminal result was checked against the recorded process ID and header boundary. No real commands, process IDs or detailed logs are published. These results do not establish live runtime state, test coverage, general accuracy or time savings.

Synthetic browser checks validate the process summary, unlinked poll count, source-result navigation, a test launched before an edit remaining overlapping, a later failed check remaining visible and live completion changing terminal process count from 2 to 3 without changing historical failure events. At 390px the process panel has no horizontal overflow. `node scripts/demo-process-evidence.cjs` reproduces the example locally without executing transcript commands.

Unknown/conflicting chains are not silently certified; callers who need live job control or cross-session task association still need stronger runtime evidence. Input is represented as a boolean in the process summary, though original call evidence remains accessible. Existing large-bundle and lint findings remain unchanged.

## Offline inspect acceptance

`agentxray inspect --platform <omp|codex|claude-code> <file> --json` adds a machine-consumable surface without a web server. The CommonJS rules are generated from the UI's TypeScript source, packaged under `lib/generated/`, compared against source in tests and checked for committed drift in CI. Historical UI diagnostic rules are unchanged.

The full suite now has **332 passing tests**, including **19 inspect tests**. Tests verify deterministic JSON, exact source references, minimized outputs, policy exits, malformed/truncated input, invalid UTF-8, directories/missing/oversized files, wrong platform, changed-read metadata, missing flags, blank/CRLF physical lines and generated-rule parity. A runtime guard blocks Express/http/https/net/server imports while the CLI runs; input bytes and temporary HOME entries remain unchanged.

Known Claude multi-result and text/result mixed records are tested as incomplete adapter coverage: JSON contains `complete:false`, raw/normalized counts and issue lines, and exit status is 1 even when a pending-failure gate was requested. This exposes an existing parser limitation instead of claiming it is fixed. Parsing failures output no partial report or sensitive line text.

An actual npm tarball was unpacked to an isolated directory with no `node_modules`, frontend source or TypeScript compiler. Inspect produced the expected OMP synthetic report (7 pending records, 2 events) directly from that artifact. This tests standalone inspection, not the dashboard dependency requirements.

The previously frozen 15 real sessions / 2,024 tool results were read only in memory. CLI report summaries matched UI rules exactly: 142 failures, 141 pending records, 76 events and 60 recorded Codex launches. **2,493 source references** were verified against the frozen original line/message mapping; repeated reports were byte-identical. No real raw text, commands, paths, process identifiers or human notes were emitted into public artifacts. This is rule/report parity, not real-world accuracy or evidence of time saved.

Reports omit raw content by construction, but hashes, counts and associations may still be sensitive. The output is not anonymized, signed task proof or an autonomous safety decision. Exit 0 means valid report production; only the explicitly requested `pending-failures` policy returns 2. See [the offline contract](offline-inspect.md).
