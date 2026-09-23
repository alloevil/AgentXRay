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
