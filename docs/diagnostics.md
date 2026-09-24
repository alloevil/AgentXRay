# Evidence-backed failure events

**Get an automatic, evidence-backed session check without labelling events.** AgentXRay summarizes recorded failures, related operations and result gaps; it does not decide whether the agent finished your task correctly. Human notes remain optional.

## Automatic session health

The default **自动会话体检** view requires no human labels, review storage access or model calls. It displays all automatic events even if you previously marked some as expected or verified elsewhere.

- **Failure follow-up evidence:** failure-record count, remaining event count and recorded same-argument successful retries. Candidate success does not count as automatic recovery.
- **Repeated operations:** unresolved events with multiple failures, plus the number of failure records in those events. This does not include already recovered episodes or estimate time wasted.
- **Later related results:** candidate result positions are deduplicated across events, with separate success/failure/running/cancelled/unknown counts. Event links and original result jumps remain available.
- **Call-result gaps:** each recorded call is associated with its last recorded result by ID and order. Running, unknown and missing-result calls are listed with evidence. A missing result does not mean the process is still running; an old running record is not a live status check. Cancelled/stopped calls are counted separately, not treated as gaps.
- Missing/reused call IDs are ambiguous, not guessed. Orphan or pre-call results and unassignable results are counted separately. No detected failures is not a task-success verdict.

Open **人工笔记与迁移（可选）** only if you want to save notes, filter by manual labels or transfer reviews. This enables the existing local-review workflow without deleting prior notes. **返回自动体检** restores every automatic event; refresh returns to the automatic view. Review-storage denial does not block the default view.

### Offline evaluation without human labels

`node --test test/session-health.test.js` checks 200 deterministic transformations across 20 fixed synthetic bases: append/remove a matching success, change command/cwd/i, insert a pre-started parallel call, and supply running/cancelled/unknown results. Each uses explicit expected recovery counts, complete event-evidence membership and a call-state partition invariant. Separate cases cover latest-result updates, missing/orphan/reused IDs, embedded calls and shared candidate deduplication.

These are **known-case tests**, not human judgments or a real-world precision benchmark. Computation time is not time saved by a person. The existing frozen-log regression is also checked against the preceding implementation without changing its diagnostic output.

Try `node scripts/demo-follow-up.cjs`: the fixture includes running, unknown and no-result calls. Enter `c` to append the missing result; the gap count falls without changing unrelated failures. No labels are needed. Enter `q` to clean up the isolated server.

![Synthetic automatic session health](../screenshots/automatic-health.png)

## Codex background-process evidence

The **Codex 后台进程证据** section links a recorded `exec_command` launch header (`Process running with session ID ...`) to later `write_stdin` calls with that exact numeric `session_id`. It shows launch and polling source records, whether input was sent, and an unambiguous terminal exit result where available.

This is a separate unit from per-tool-call state: the historical launch still returned a running/unknown record, while the process may have finished through a later poll. Polling is not a second launch, and none of these links changes failure events, automatic retry recovery or saved review fingerprints.

- Only supported Codex wrapper headers **before** `Output:` / `Final output:` are used, on exact `exec_command` / `write_stdin` tool names or their `functions.`-qualified forms. Matching text printed in stdout or read from a file is not process metadata.
- Launch and poll call IDs must be unique in the currently viewed transcript. Process IDs must be nonnegative safe integers; string IDs and missing launch history are not guessed.
- Reused process IDs, duplicate launch/poll records, mismatched returned IDs, missing or invalid polling results, overlapping polls or polls after a terminal result make completion ambiguous. The original records remain accessible, but no final result is adopted from the conflicting chain.
- A last running record is not live process monitoring. Input-sending polls are marked without showing input text in the process summary. The raw call remains available if you choose to inspect it.
- A recognized verification command can use its linked final process result, but retains its **original launch position**. A check launched before an edit and finished afterward still overlaps the edit; it is not post-edit verification. Input-fed processes and compound shell fragments keep an unknown check outcome even when the process exits zero.

Use the hosted demo's **Codex** tab and select the `[Synthetic demo] Background process evidence` session. It contains two launches: one finishes through a poll, one has only a running record, plus an unlinked poll. The previous default demo remains unchanged.

For live updates from a source checkout:

```sh
node scripts/demo-process-evidence.cjs
```

Select the Codex synthetic session. Three launches initially include a successful exit, a failed exit and a pending process; one poll has no matching launch. Enter `c` to append the missing completion and watch the process evidence update, or `q` to stop and clean up. No logged commands are executed.

![Synthetic Codex process evidence](../screenshots/codex-process-evidence.png)

## Modification and verification chronology

The **修改—检查时序** section asks a narrower, evidence-based question than “did the task pass?”:

> Did a check return successfully before a modification tool returned successfully, and what check commands are recorded afterward?

It shows each explicit modification-tool success, the nearest earlier successful check, all overlapping checks, the later check calls and the latest later outcome. A passed check from before an edit cannot certify that edit. A check started before the edit completed is not post-change validation, even if its result arrived later. A failed later check is not hidden because an earlier check passed.

**Recognition scope:**

- Modifications are `edit`, `Edit`, `write`, `Write` and `MultiEdit` with an unambiguous literal `path`/`file_path` and a uniquely paired successful tool result. This is a tool-result fact, not proof that bytes changed. Failed/incomplete mutation calls and unsupported patch/parameter formats are counted separately.
- Direct test runners include `pytest`, `python[3] -m pytest` and `node --test`. `npm test` and named `test/build/lint/typecheck` scripts under npm/pnpm/yarn are recognized as **script-name conventions**, not verified script contents. Help/watch/list-only/dry-run modes are excluded.
- A sole literal absolute `cd ... && check` can provide directory context. If that whole command fails, the failure may be in `cd`, so the check outcome is unknown.
- A bounded lexer recognizes check command segments in more complex `&&`, `;`, newline or pipeline commands without executing anything. A fragment inside `npm test | tail ...` is **not known to have run or passed** from the wrapper exit code, even when the wrapper succeeds. Quoted text inside echo/python arguments is not treated as an executable command. Substitutions, heredocs and shell control syntax are not interpreted.
- Only same-transcript record order is compared. Known-different/conflicting explicit directories are excluded. Missing directory context is labelled unknown. No filesystem lookup, implicit directory tracking, source coverage or cross-session causality is inferred.

Every displayed modification/check links to its original call and, when present, result. Unclassified execution calls remain counted, so “no later recognized check” never means “no testing occurred”. The original failure/candidate rules and human-note fingerprints remain unchanged.

Try the controlled sequence in a source checkout:

```sh
node scripts/demo-verification.cjs
```

The OMP synthetic session begins with a passed check, a completed edit, an overlapping check, and a different-directory check. No relevant later check is recorded. Enter `f` to append a failed post-edit check, then `s` for a successful check: the UI updates automatically and retains both attempts. Enter `q` or Ctrl-C to clean up. No command from the synthetic transcript is executed.

The static hosted sample likewise has an earlier passed test followed by a later same-file edit. Its background `verify-config` script is intentionally outside the current naming allowlist; do not confuse “unclassified” with “failed”.

![Synthetic modification/check chronology](../screenshots/verification-chronology.png)

This guide covers the React UI. The synthetic terminal walkthrough uses a source checkout; package installation and published versions are listed in GitHub Releases.

## Try it without sharing your logs

For a no-install tour, open the [hosted demo](https://alloevil.github.io/AgentXRay/) and click **体验自动体检 / Try diagnostics**. Its synthetic sample has 7 pending failure records in 2 events (6 repeated edits and 1 search failure), plus an earlier automatically recovered test failure. Open the first/last/all evidence or optionally record a browser-local review note. This is a static sample: no live results are appended and no actual tool commands run. The terminal walkthrough below is a separate, larger fixture for live updates.

From the repository root, after installing the root and frontend dependencies:

```sh
npm run build:ui
node scripts/demo-diagnostics.cjs
```

Open the printed local address, select **OMP**, then the **[Synthetic]** session. The script creates a temporary HOME with synthetic logs, not your real sessions. It executes no logged tool commands and needs no model credentials.

1. **Start with the summary:** 72 pending failure records become 7 events. The first card contains 66 failures of the same edit operation. Five event cards appear initially; “再显示…” reveals the rest.
2. **Follow the evidence:** “首条证据” / “末条证据” jump to the first / last result. “全部 66 条证据” retains every result, including different error text, with individual jump buttons. A jump expands the original tool result, including results outside message pagination.
3. **Watch the update:** keep Auto-refresh enabled, enter `r` in the demo terminal, then press Enter. The script appends a synthetic same-argument success. The repeated event disappears: 6 pending records / 6 events remain, and 67 failed records now have later matching success evidence (including one earlier synthetic recovery).
4. Enter `q` or press Ctrl-C to stop the isolated server and remove its temporary data.

The synthetic “66 → 1” example is a fixture, not an accuracy or productivity benchmark.

![Synthetic failure-event walkthrough](../screenshots/diagnostic-events.png)

## Use your existing logs

Run `npm start` from the built checkout. Select a session and open its **消息** view. The “自动会话体检” panel uses the currently loaded transcript; selecting a child session analyzes the child, not the parent's combined history. No SDK, new log instrumentation or model call is required for these rules.

Start with repeated operations, open the latest failure, and inspect the surrounding calls. A card is a reason to review the transcript—not an instruction to rerun a possibly destructive command. Equivalent commands, alternate verification and external fixes still require your judgment.

## Follow-up evidence candidates

When a failure event has matching later operations, expand **后续相关操作**. These are leads for your review, **not automatic recovery or proof that the original task passed**. Each candidate shows its relationship, call/result message positions, call's user turn, tool outcome and source evidence, arguments, and a jump to the original result. Five are shown initially; the rest can be loaded without filtering out unsuccessful results.

Two relationships are supported:

| Relationship | Required evidence | Not inferred |
| --- | --- | --- |
| Only top-level `i` differs | Same exact tool, equal non-empty remaining arguments, but different full arguments. Object key order is ignored; values and array order are retained. May cross user turns within this transcript. | That `i` is semantically irrelevant, or that the later call fixes the earlier problem. |
| Same-file modification | Explicit `edit`, `Edit`, `write`, `Write` or `MultiEdit` calls, same call-origin user turn, changed parameters, and the same literal `path`/`file_path` plus recorded working-directory fields. | Paths hidden in shell commands/patches, different turns, symlinks, path normalization, or implicit directory changes. |

Both require a recorded result and a call started **after the event's last pending failure**. Results from pre-existing parallel calls, orphan results, missing arguments and calls without results are excluded. Same-file matching requires absolute paths, or identical explicit absolute `cwd`/`workdir`/`working_directory` for relative paths; ambiguous fields are rejected. Different directory field names are not treated as aliases.

Status labels distinguish **success (tool result), failure, running, cancelled/stopped and unknown**. Source fields are shown, not inferred from optimistic prose. A running background job is not success. Platform adapters and automatic failure/recovery matching remain unchanged, including preserving `i` in automatic retry comparison. A same-file edit that returned success may have changed something else entirely.

New or changed candidate evidence requires human review again: the event's storage key remains stable, but the review fingerprint includes complete candidate results and arguments. Existing notes become stale only for affected events; events without candidates retain their old fingerprint contract. Review-transfer files still contain only hashes and handwritten notes, not raw candidate logs.

### Try all five states locally

From a built source checkout:

```sh
node scripts/demo-follow-up.cjs
```

Select its OMP `[Synthetic]` session. The first bash failure has seven only-`i` candidates covering the five outcome states; an edit failure has one same-file candidate. An unrelated file and a different user turn are excluded. **Three automatic failure events remain**, even when a candidate is successful. Save a review and type `n` in the terminal to append another candidate: that review becomes stale, without changing automatic failure/recovery counts. Type `q` or Ctrl-C to stop the isolated demo.

The hosted **Try diagnostics** sample also includes a successful same-file edit with changed arguments. Its existing seven pending failure records and two events do not disappear. Both demos are synthetic; no logged command is executed.

![Synthetic follow-up evidence](../screenshots/follow-up-evidence.png)

## Local review workflow

Human review is optional: first open **人工笔记与迁移（可选）**. The automatic result and your judgment are separate. The header always reports automatic events and pending failure records. In optional mode, the review filters show which events you have inspected:

| Queue | Meaning |
| --- | --- |
| 待复核 / Unreviewed | No current review, evidence changed, or local review could not be read. |
| 需跟进 / Follow-up | You recorded a concrete next check or unresolved concern. |
| 预期失败 / Expected failure | You recorded why this failure was expected, such as a negative probe. |
| 其他验证已通过 / Verified elsewhere | You recorded alternative verification that the exact-argument rule cannot establish. This is your note, not an automatic success claim. |
| 全部 / All | All automatic events, including manually reviewed ones, with their original evidence. |

Click **记录人工复核**, choose a status and write **1–1000 characters of evidence or next steps**. Save, change or revoke a review without modifying session logs. Start with **待复核** next time; **需跟进** is your follow-up list. An empty review queue does not imply a passed task.

Notes survive refresh in the same browser and origin, and updates sync between tabs on that origin. Notes are separated by platform, configured log directory, session, child and event. Event identifiers and full-evidence revisions are SHA-256 fingerprints; the app does not copy raw logs or arguments into the review store. Your note itself is stored as plain text, so **do not paste secrets**.

Appending a failure or changing the full result—including text beyond the displayed preview—invalidates the old revision. The event returns to **待复核**, and where its identity is unchanged the old note remains visible with an expiration warning. Changed event identities (for example changed parameters or shifted first occurrence) start unreviewed rather than reusing a potentially unrelated note.

**Try invalidation:** in the synthetic demo, save a review on the 66-failure event, then enter `n` in the terminal. A new failure joins the event (67 failures), and the old review becomes stale without a page reload. Enter `r` afterward to append a matching success: that event leaves the automatic queue, with 68 recorded failures now having matching success evidence. If you did not use `n`, the original demo count remains 67 recovered records.

![Synthetic local review with explicit evidence](../screenshots/diagnostic-reviews.png)

Storage limits:

- Reviews stay in this browser's localStorage, not on the AgentXRay server, in your session logs or in the cloud. No review API, account or model call is used.
- They are not encrypted, authenticated attestations or a backup. Another browser, a changed hostname/port, private mode or cleared site data may make them unavailable. Other tabs use the latest saved record; there is no collaborative edit merge.
- Storage denial, a corrupt record or quota exhaustion is shown explicitly. A failed save does not count as saved; unreadable reviews remain unreviewed. You can revoke an individual review without clearing unrelated settings.
- Use localhost or HTTPS for browser cryptography. If fingerprints cannot be calculated, saving reviews is disabled while automatic diagnostics remain available.
- Notes are not automatically deleted when an event becomes automatically recovered or its identity changes; they may remain in site storage. Current-event export/import is available below, but there is no whole-history review archive or automatic cross-device sync.

## Transfer reviews between browsers

Open **人工笔记与迁移（可选）**, then **迁移当前会话复核 / Export & import** in the diagnostics panel. This is a local, explicit file transfer—not a server backup or authenticated proof that a task passed.

1. On the source browser, open the session you reviewed and select **预览导出**. The full JSON is shown before downloading. Only reviews whose identity and full-evidence fingerprint still match the **currently loaded automatic events** are included; the selected review filter does not limit the export.
2. Inspect the notes, acknowledge the plaintext warning, then select **下载复核 JSON**. The filename is always `agentxray-reviews.json`, without a session ID or path. Store it safely: notes you typed may include secrets even though the app does not copy logs into the file.
3. On the destination browser/origin, open the same session with the same platform, configured log-directory setting and child scope. Select the JSON file. **No review is written during preview.** Every record shows its note, timestamp and one decision: import, unmatched, stale, already identical, or local conflict.
4. After checking the preview, acknowledge the warning and select **确认导入匹配记录**. Only exact current-event/full-evidence matches with an empty local slot are written. Every existing local slot is kept—even an old or corrupt one. Clear it explicitly in the ordinary review UI first if you intend to replace it, then preview again.
5. The result reports imported, skipped and failed counts. Evidence/review changes invalidate an open preview. Storage is rechecked immediately before each write; partial failures retain successful writes and report failures, not an all-or-nothing transaction. Re-preview to retry; already-imported records are skipped.

### File format and boundaries

- Format `agentxray-review-transfer`, version `1`; maximum **1 MiB UTF-8** and **500 unique records**. Invalid JSON, unknown fields/versions, duplicate keys in the record list, invalid storage identifiers and invalid review fields are rejected before import writes.
- Top-level fields: `format`, `version`, `exportedAt`, `records`. Each record has `storageKey` and `record`; the nested record has `version`, `fingerprint`, `status`, `note`, `reviewedAt`.
- Only hash identifiers, evidence fingerprints, human states, human-written notes and timestamps are exported. Raw commands, log content, paths, session titles and automatic diagnostics are not copied into the file. Notes are plain text, not redacted or encrypted; HTML in a note is displayed as text.
- Matching preserves the existing fingerprint contract. Different browser or port can work; changed directory settings, session/child scope, first occurrence, original arguments or full evidence do not. There is no fuzzy cross-machine path remapping. If source logs are no longer available at the destination, the file cannot recreate them.
- Files can be edited or fabricated. A matching hash is an association check, **not a signature, trust guarantee or independent task verification**. Imported human labels never modify automatic failure/recovery counts.
- This is not a complete browser/history backup: recovered, missing, stale or unloaded event notes are excluded. Unreadable current records abort export with an error rather than silently producing an incomplete file. Exceeding limits requires a smaller current-session set; automatic splitting is not provided.
- Browser localStorage has no multi-tab transaction. The app skips observed conflicts and rechecks each write, but cannot guarantee a lock against truly simultaneous independent writes. No remote requests or automatic cloud sync are added.

![Synthetic review transfer preview](../screenshots/review-transfer.png)

## What an event means

| Rule | Behavior |
| --- | --- |
| Same operation | Exact tool name and complete argument values; object key order is ignored, array order and values are preserved. OMP's `i` field is not stripped. |
| User-turn boundary | Calls must originate in the same user turn. A late result stays in its call's turn. No user message yet is shown explicitly. |
| Success boundary | A matching successful result separates later groups. Only a call started after the failure can recover that failure; pre-existing parallel calls cannot. Recovery itself is not restricted to one user turn. |
| Missing data | Missing calls/arguments stay separate. Unknown completion does not silently become success. |
| Evidence | Each pending failure belongs to exactly one event. First, last and every member remain accessible. Ranking is by member count, then first occurrence. |
| Time | The card reports the interval between first and last failure records, not execution duration or time wasted. Missing, invalid or non-monotonic timestamps produce unknown duration. |
| No causal claim | Errors may differ and calls may overlap. Grouping does not prove a common cause, serial retries, an infinite loop, deception or task failure. |

OMP results distinguish success, failure, running, cancelled and unknown with field-source evidence. Eval/search nested errors are recognized; stopping a daemon or listing historical failures is not automatically a new execution failure. A successful eval containing error observations keeps those observations visible: process success does not prove the probe or task passed.

Existing aggregate error statistics still use their original `isError` field. They may differ from this diagnostic count; this feature does not migrate those metrics.

## Narrow-screen session workflow

Below 768px, the session workflow uses the available width rather than reserving a fixed sidebar:

- Tap **会话列表** to open navigation. Select a session—even the currently selected one—to return to its content. **返回内容** or Escape also closes navigation; keyboard focus returns to the toggle.
- Session-list search and the current review form remain mounted while switching between list and content. This preserves an unsaved draft **within the same session**; it does not promise draft persistence across session changes or page reloads.
- Scroll the platform bar horizontally to reach more platforms. The active platform stays visible; desktop displays the existing two-column layout at 768px and above.
- The summary has a height limit on narrow screens, including short landscape viewports. Expanded details scroll inside the summary, leaving space for the transcript.
- First/last/individual evidence jumps scroll the message area, not the outer page, so navigation remains available. Review notes and stale-evidence handling work as on desktop.

Validated in Chromium at 360×640, 390×844, 740×360, 768×1024 and 1440×1000. A separate mobile/touch emulation passed tap navigation and review saving. At 360px, the actual diagnostic panel is **340px wide**, up from the previous broken 44px layout. This replaces the earlier component-only narrow-screen check.

![Narrow-screen synthetic review](../screenshots/diagnostic-mobile.png)

These checks cover navigation, session messages and the review workflow—not complete mobile certification of Trace, analytics, prompts, library or every settings control. No physical iOS/Android device or on-screen keyboard was tested. This UI change does not alter server network binding or expose your logs for remote access. Review storage still requires a suitable browser origin (localhost or HTTPS for fingerprints). [Verification receipt](diagnostics-verification.md).

## Reproducible checks

```sh
node --test test/diagnostic-events.test.js test/diagnostics.test.js test/omp-outcome.test.js
node --test test/diagnostic-reviews.test.js
node --test test/review-transfer.test.js
node --test test/follow-up-evidence.test.js
node --test test/session-health.test.js
node --test test/verification-chronology.test.js
node --test test/codex-process-evidence.test.js
npm test
npm run build:ui
npm run lint
```

The local frozen regression set contained 30 sessions and 9,076 tool results. Grouping reduced 438 pending cards to **373 events (14.84% fewer cards)**, retaining all 438 evidence records. One event contains 66 edit failures. Failure detection and recovery counts did not change. This already-inspected set is not a blind evaluation, an accuracy estimate or evidence of time saved. Real logs are not included in the repository; the synthetic demo works without them. [Local verification receipt](diagnostics-verification.md).

## 中文使用指南

### 自动体检无需人工标注

默认进入“自动会话体检”，直接展示失败后完成证据、重复失败操作、去重后的后续相关结果，以及调用最后记录状态。全部自动事件都可见，不因旧人工标签而隐藏；不开启笔记时不会读取复核存储。

“调用结果缺口”列出记录为执行中、未知、未记录结果的调用，并可跳转证据。这里说的是日志最后状态，不是实时进程；未知不等于失败，未记录结果也不代表任务未完成。重复/候选数字都有明确单位，不提供笼统健康分。

人工笔记保留为可选：点击“人工笔记与迁移（可选）”才打开旧队列及迁移功能，旧笔记不删除；“返回自动体检”恢复所有事件。刷新默认回到自动模式。

无需人工参与的验收：`node --test test/session-health.test.js` 在 20 个固定合成基例上运行 200 个规则变换，检查已知恢复结果、证据分组和调用状态总数，不靠模型自评或人打标签。它证明规则对这些用例的行为，不等同真实准确率或节省时间。

### 修改与验证的先后顺序

自动体检中的“修改—检查时序”展示：修改工具何时成功返回、此前最近的成功检查、重叠检查、之后出现的检查，以及最新结果。**测试在修改之前通过，不代表修改之后通过；并行检查晚返回，也不算修改后的验证。**

直接测试运行器和约定命名的 test/build/lint/typecheck 脚本分开标识。有限解析器能看见 `cd ... && npm test` 等命令片段，但复合命令的整体退出码不能证明测试片段执行或通过，尤其是接 `tail` 等管道时。未知范围和未归类命令都会显示，不把“未识别”解释成“没测试”。

这里比较当前会话的记录顺序，已知不同工作目录不关联、目录缺失显示未知；不判断文件测试覆盖、不执行日志命令、不宣判任务成功。所有原始调用/结果可以点击查看。修改仅识别明确 edit/write/MultiEdit 工具，shell/patch 修改等暂不解析。

运行 `node scripts/demo-verification.cjs`，在合成会话中输入 `f` / `s` 分别追加修改后的失败/成功检查，观察结果自动更新；`q` 退出。另有 120 个固定时序变换测试，覆盖先后、重叠、缺结果等反例，无需人工参与。

**目标：先找到值得复查的重复操作，再追溯证据，而不是把几百条失败强行解释成几个根因。**

免安装体验：[在线 Demo](https://alloevil.github.io/AgentXRay/)，点击“体验自动体检 / Try diagnostics”。这个独立合成案例将 7 条待复查记录聚为 2 个事件（6 次同参 edit 失败、1 次搜索失败），并展示一次早先测试失败的自动恢复。可查看全部证据、填写本浏览器的人工复核；它是静态示例，不追加真实结果。下面的本机终端演示则使用更大的合成日志来验证实时变化。

从源码仓库运行 `npm run build:ui`，再运行 `node scripts/demo-diagnostics.cjs`。打开终端打印的地址，选择 OMP 的 `[Synthetic]` 会话：

- 初始为 **72 条待复查记录 → 7 个事件**，66 条同参 edit 失败集中在第一张卡片；默认展示 5 个事件，可以继续加载。
- 点击“首条证据”“末条证据”或“全部 66 条证据”，可以跳转任意一条原始结果，不因聚合丢失细节。
- 保持自动刷新，在终端输入 `r` 并回车，追加合成成功结果；页面自动变为 **6 个事件、6 条待复查记录、67 条已有同参成功记录**。
- 输入 `q` 或 Ctrl-C 退出并清理。演示使用临时 HOME 和合成日志，不读取你的真实会话、不执行日志里的命令。

日常使用：构建后运行 `npm start`，选择你的会话，在“消息”视图查看“自动会话体检”。子会话独立分析；优先读最新失败和前后操作，不要不加判断地重跑原命令。

**边界：**只合并同调用轮次、同工具、完整同参数的记录，不忽略 `i` 或工作目录；成功结果切断分组，缺少参数不合并。事件可含并行调用和不同错误，不等于同一根因或串行重试。首末间隔不是耗时或浪费时间。执行中、取消和未知不算成功验证；其他方式修复、等价命令、后台任务链仍需人工判断。

本机冻结回归是 **438 → 373 个事件，少 14.84% 卡片，保留全部 438 条证据**，不是“问题减少了 14.84%”，也没有证明省下多少时间。既有聚合统计仍使用原始错误标记，可能与诊断数字不同。源码体验与安装方法见本页及 GitHub Releases；合成终端演示需要源码检出。

会话与复核流程的窄屏布局现已修复；此前 360px 下固定侧栏挤压正文的问题不再存在，具体范围见“窄屏操作”。其他复杂页面没有因此被宣称全面适配。

## 本机复核闭环

这是可选功能，不是使用前提。先打开“人工笔记与迁移（可选）”，再查看事件证据、点击“记录人工复核”，选择：

- **需跟进**：写清楚下一步检查什么、哪里仍不确定。
- **预期失败**：写清楚为什么这个失败是合理的，例如负向探测无匹配。
- **其他验证已通过**：记录替代验证的命令、结果与时间；这是人工判断，不是自动成功证据。

每次必须填写 1–1000 字依据。可重新复核、撤销单条标记，或在“全部”中查看所有自动事件。**复核队列为空，不代表任务通过**；人工标记不会改变顶部的自动失败/恢复计数。

在合成演示里，先给 66 条失败的事件写一条依据，再在终端输入 `n`：第 67 条失败加入后，旧标记失效、事件重新待复核，并保留旧依据供对照。此后输入 `r`，自动成功记录才会关闭这一事件（累计 68 条恢复，包含先前演示中的 1 条）。

**存储边界：**标记只在当前浏览器同源 localStorage 中保存，刷新可恢复、同源多标签页会同步，但不上传后端、不改原始日志。自动保存的内容为哈希标识、完整证据指纹、状态、时间和你手写的依据，不复制原始日志或参数；手写依据是明文，请勿填写密钥。不同日志目录、平台、会话及子会话隔离。换浏览器、端口、清除站点数据可能不可见或丢失，不能当备份；多标签页采用最后一次保存，不做协作合并。

新增失败、完整输出变化或状态依据变化会要求重新复核；身份变化的事件不沿用旧标记。读取损坏、浏览器拒绝存储或配额不足会明确报错，不会假装保存成功。使用 localhost 或 HTTPS 以便计算指纹。自动恢复或身份变化后的旧笔记不会自动清理；可迁移当前有效复核，但不是历史归档或自动跨设备同步。

## 迁移复核记录

先打开“人工笔记与迁移（可选）”，再展开“迁移当前会话复核 / Export & import”：

1. **源浏览器**打开已有复核的会话，点击“预览导出”，检查将下载的完整 JSON，勾选明文提醒后下载。仅导出当前自动事件中仍有效的复核，筛选队列不影响范围。
2. **目标浏览器**打开相同平台、配置目录、会话及子会话，选择文件。预览逐条展示依据、时间与处理决定，尚不写入数据。
3. 只有**身份和完整证据匹配、本地没有任何记录**的条目可导入。过期、不匹配、重复均跳过；不同、过期或损坏的本地记录也不覆盖。确需替换时，先在原复核界面主动撤销，再重新预览。
4. 明确确认后导入，显示成功、跳过、失败数量。预览期间证据或复核变化会禁用旧确认；确认时再次核对。部分写入失败不回滚成功项，可重新预览重试，已成功项会跳过。

限制 **500 条、1 MiB UTF-8**，严格检查版本、允许字段、哈希标识、重复记录和依据格式；导出文件只含哈希、状态、时间和手写笔记，不自动包含日志、命令、参数或路径。**手写内容仍可能含秘密，文件未加密、未脱敏、未签名**；不要盲目信任他人给的复核文件，哈希匹配不等于结论可信。导入不会改变自动失败/恢复计数。

不同浏览器、端口可迁移，但目录配置或原始会话/证据变化会拒绝匹配，不自动改写路径。没有原始日志时不能用文件重建事件。已恢复、过期或未加载事件不在导出范围；这不是整库备份。多标签页只做写入前复查，不提供跨标签页事务锁。操作均在浏览器本地完成，没有新增上传或同步服务。

本轮的 373 个真实冻结事件只使用**内存中的合成测试标记**检验隔离与失效，没有替你判断真实事件，也没有把这些测试标记写成真实复核。完整证据见 [本机复核验收](diagnostics-verification.md)。

## Codex 后台进程证据

展开“Codex 后台进程证据”，可以沿着 `exec_command` 的包装头进程 ID，找到同一会话内 `write_stdin.session_id` 对应的轮询与最终退出结果。启动、每次轮询和结果均可跳转。

它与“每条工具调用的最后记录状态”分开统计：历史启动结果不被改写，轮询也不是另一次启动。重复进程 ID、重复调用/结果、返回 ID 不符、交叠轮询、终止后继续轮询或缺少可靠结果时，完成状态保持未知。只认包装头，不把 stdout 中的示例文本当证据，不跨会话猜测。

若这个进程运行的是可识别检查，时序视图可采用唯一关联的终止结果，但仍保留原始启动位置：修改前启动、修改后才返回的测试仍是“重叠”，不算修改后验证。发送过输入或执行复合命令的检查结果仍保持未知；整个进程退出零码不代表任务通过。

在线 Demo 的 Codex 页有明确标记的合成案例；源码可运行 `node scripts/demo-process-evidence.cjs`，输入 `c` 为待完成进程追加结果，`q` 退出。当前只支持上述 Codex 输出契约，不宣称 OMP/Claude 后台任务链也已覆盖。

## 后续相关操作

失败事件下若有候选，可展开“后续相关操作”，查看匹配依据、五类状态、调用/结果位置、参数摘要及原始结果。**它不自动关闭事件，不代表任务已通过。**

- “仅 i 不同”：同工具，只有顶层 `i` 不同，其余完整参数相同，可跨当前会话内的用户轮次；不等于认定 `i` 无语义影响。
- “同文件修改”：仅限明确 edit/write/MultiEdit 工具、同调用轮次、相同记录路径及显式工作目录；允许不同修改参数，不推断它们是同一修复。
- 都必须在事件最后一次失败之后发起且已有结果。此前已启动的并行调用、无结果、缺参数、孤立结果不参与。
- 相对路径必须有相同的显式绝对工作目录；没有就不猜。不同字段名、隐式 cwd、软链、跨轮次修改、命令里的文件名都不自动关联。
- 成功、失败、执行中、取消、未知均有标签和字段依据。候选新增或变化会使受影响旧复核过期；不会改变自动失败/恢复计数，也不会把原始日志加入迁移文件。

源码运行 `node scripts/demo-follow-up.cjs` 可体验五类状态、无关文件反例和实时追加候选。页面里保存复核后，终端输入 `n` 验证重审；`q` 退出。在线 Demo 的合成诊断案例也有一条同文件成功修改，但仍保留原来的失败事件。

## 窄屏操作

- 小于 768px 时，点击“会话列表”进入导航，选择当前或其他会话后返回正文；“返回内容”或 Escape 也可关闭列表。桌面仍是双栏。
- 在同一会话内，打开列表再返回不会清空搜索词或未保存的复核草稿；切换其他会话、刷新页面不保证未保存草稿。
- 平台栏支持横向滚动，当前平台自动保持可见；会话列表的设置和全局搜索入口仍可使用。
- 摘要在窄屏/短横屏限制高度，展开详情后可内部滚动，不再把消息区挤没。证据跳转只滚动消息区，顶部导航保持可用。
- 360px 下诊断区由 **44px → 340px**；360×640、390×844、740×360、768×1024、1440×1000 布局及 Chromium 触屏模拟通过。另验证了 240 个合成会话的虚拟列表、长会话 ID/路径和新增失败使复核过期。

这是浏览器窄屏与触屏模拟验收，不是 iPhone/Android 真机或软键盘兼容性认证；Trace、统计、Prompts、资产库及完整设置流程不在本轮全面适配范围。没有改变服务监听地址或自动向网络暴露日志。[本轮证据](diagnostics-verification.md)。
