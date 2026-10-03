# Task 11 owner retention and requestfailed task ownership — independent review

Date: 2026-09-22. Root: `C:/Develop/github-repo/BeakSight`. Scope: specification-compliance and code-quality review of only the two corrections authorized by `task-11-owner-retention-requestfailed-brief.md`.

## Verdict

**PASS — Critical 0 / Important 0 / current Minor 0.**

The correction satisfies the bounded terminal-owner handoff and shared `requestfailed` task-ownership contracts. The review package is intact at **91/91 matching entries**, with 91 unique paths, 0 missing, 0 mismatches, 0 duplicates, and 0 self-reference. No current approval-blocking finding was found.

This review does not itself constitute user approval of Task 11. Product Task 12+ remains blocked pending controller adjudication and explicit user approval.

## Package and manifest integrity

The package SHA-256 was recomputed before review and matched the required value exactly:

`6253DAB3BEA76CDAC3AF377B1DCDDD0107E83F1E7FB1A4F3CB66ACF625D72BF3`

The Markdown manifest was parsed mechanically. Every row was independently hashed from the current workspace rather than trusting the package's declared counts.

- Initial result: **91 entries / 91 unique paths / 91 matches / 0 missing / 0 mismatches / 0 duplicates / 0 self-reference**.
- Final result, recomputed after this review artifact was written and immediately before finalization: **package hash exact; 91 entries / 91 unique paths / 91 matches / 0 missing / 0 mismatches / 0 duplicates / 0 self-reference**.
- The review artifact is intentionally outside the self-nonreferential package manifest.

## Specification compliance

### 1. Finite close budget and canonical terminal truth

**PASS.** `src/interaction/isolated-auditor.ts:53-55` declares the named total-attempt limit as 2. `auditInteraction()` uses a bounded `for` loop (`:488-527`), invokes only `session.close()`, and reads canonical `session.isClosed()` only after each close settlement (`:491-504`). It stops after a terminal first attempt, retries only a non-terminal first settlement, and has no cleanup timer, background retry, or unbounded loop.

The first-attempt terminal semantic invalidation case remains one attempt: the rejected close is recorded, canonical terminal truth is then observed, and the audit returns `CLOSED` plus `BLOCKED_BY_SAFETY`. This is consistent with the brief's explicit requirement not to retry terminal semantic invalidation unnecessarily.

### 2. Sticky invalidation, terminal recovery, and preserved work

**PASS.** Guard invalidation promotion remains sticky (`src/safety/passive-request-guard.ts:493-498`), while `ensureCloseAttempt()` publishes the attempt before raw-close side effects, retains non-terminal failed attempts for explicit retry, and changes to `CLOSED` only at the successful stable-drain boundary (`:437-490`). The Factory derives release from `isPassiveRequestGuardClosed()` and removes active ownership only after that canonical query is true (`src/browser/context-factory.ts:130-145`, `:188-194`).

When the second attempt reaches terminal, `auditInteraction()` publishes only a frozen `CLOSED` lifecycle, retains the latest cleanup anomaly reason, applies the fixed close-safety top-level verdict, and reuses the previously finalized `work` and exact `work.evidence` (`src/interaction/isolated-auditor.ts:513-525`). The original structured work axis is not overwritten by lifecycle recovery.

### 3. Exhausted cleanup cannot return a normal result

**PASS.** After two non-terminal settlements, the only path records `INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED`, takes the final detached ledger snapshot, and throws exported `InteractionOwnerCleanupError` (`src/interaction/isolated-auditor.ts:529-545`). No `InteractionAuditResult` is returned from this state.

### 4. Exact-session owner transfer and immutable diagnostics

**PASS.** The exported frozen error retains the exact `InteractionAuditSession`, candidate id, frozen work, frozen `NON_TERMINAL` lifecycle, detached frozen Safety Ledger snapshot, and independent rejection-presence/value fields (`src/interaction/isolated-auditor.ts:58-88`). `lastCloseRejected` remains distinct from `lastCloseError`, including a present rejection whose value is `undefined` (`:486-495`, `:543-544`).

The work/evidence surfaces are frozen at construction; candidate geometry and changed-field arrays are also copied/frozen. `SafetyLedger.snapshot()` creates new frozen records, arrays, and counter records (`src/safety/safety-ledger.ts:180-199`). The real-session exhaustion test proves exact identity, two automatic raw-close attempts, frozen diagnostics, later `error.session.close()`, terminal `CLOSED`, and Factory release (`tests/integration/isolated-interaction.test.ts:2446-2507`).

### 5. No second owner registry; terminal-only Factory release

**PASS.** The correction introduces no global owner table or replacement Factory registry. Session-local `retainedNonTerminalFailure` only reconciles the existing session close call with the same Factory/Guard owner (`src/browser/context-factory.ts:121-145`). The Guard retains its single module-local `WeakMap` lifecycle owner and existing `pendingTasks` registry; Factory membership is removed only after canonical terminal confirmation.

### 6. Synchronous/void requestfailed ownership and rejection containment

**PASS.** The installed callback is declared `(request: Request): void`, delegates immediately to `runGuardProtocolTask()`, and returns no Promise (`src/safety/passive-request-guard.ts:1263-1324`). All classification, correlation, evidence, and invalidation work occurs inside that owned task. It calls the non-owning `requestInvalidation()` signal rather than awaiting `initiateInvalidation()` (`:1272-1320`).

`runGuardProtocolTask()` removes its owned Promise from `pendingTasks` before promoting invalidation (`:578-593`), preventing self-drain deadlock. The listener-facing completion is explicitly rejection-contained (`:1323`). Expected route-failure suppression, main-frame classification, CDP failure consumption, and close-abort suppression remain in the same task (`:1269-1319`).

### 7. Raw-close race and 257-callback bound

**PASS.** The close attempt is published before raw `context.close()` (`src/safety/passive-request-guard.ts:446-454`), so a synchronous `requestfailed` emission during raw close is admitted into the existing `pendingTasks`. The stable drain observes it before its atomic `CLOSED` transition (`:350-383`, `:467-477`). Its post-task invalidation promotion occurs synchronously after removal from the task set and before the drain can observe an empty terminal boundary (`:585-592`).

Admission uses the existing `MAX_PENDING_GUARD_TASKS = 256`, `admitGuardTask()`, one-shot `taskLimitReported`, and `beginOverflowInvalidationOnce()` owner (`:29`, `:518-538`, `:561-594`). The 257-callback regression requires void callback returns, exactly one `GUARD_TASK_LIMIT_REACHED`, one raw-close/invalidation owner, and terminal completion (`tests/integration/passive-request-guard.test.ts:2755-2779`). The shared protocol-bound mutation tests independently require exactly 256 admitted callbacks (`:2865-2904`). No second Set, queue, or registry was added.

### 8. Task 11 non-regression surface

**PASS.** The correction does not alter request policy, interaction policy, discovery, evidence collection, DOM-budget ownership, S03-S08 interaction delivery barriers, or structured outcome precedence. The package pins those authorities and tests. Source inspection confirmed freeze precedence, canonical lifecycle precedence, exact evidence aliasing, expected route-failure suppression, CDP correlation, close-abort suppression, and the previously corrected candidate/DOM-work branches remain intact.

The reviewer scans found no target/site markers or `innerHTML`/`setAttribute` escape in `src`, and no forbidden whole-DOM candidate selector/locator path in `src/interaction`. `package.json` and `package-lock.json` retained their frozen hashes.

### 9. TDD evidence, test strength, and historical evidence boundaries

**PASS.** The implementation report records one accepted unchanged-production behavioral RED: exit 1 with 8 assertion failures, 2 passes, and 250 skips. The reported failures correspond to the old one-attempt/unreachable-owner and async/unowned-listener behaviors, not missing exports, compilation failures, a harness failure, or Chromium startup. The earlier restricted Chromium `spawn EPERM` attempt is explicitly excluded.

The report and append-only ledgers explicitly disclose that standalone RED-time `npm run typecheck` was **NOT RUN**; they do not imply otherwise. They also record rechecks of frozen production/package hashes immediately after RED. This independent reviewer could inspect the frozen inputs, current tests, and retained report/ledger evidence, but did not attempt to recreate temporal RED by modifying or reverting production because edits and Git operations were prohibited.

The current tests have real mutation strength across exact retry cardinality, exact session identity, post-handoff terminal recovery/release, fulfilled non-terminal settlement, `Promise.reject(undefined)`, terminal invalidation cutoff, raw-close admission/drain, overflow ownership, and process-level rejection containment. No assertion weakening was found. The migrated assertions reflect the new binding contract: persistent non-terminal cleanup throws instead of returning a normal result, and the EventEmitter listener itself is synchronous/void.

Historical Task 2 I7 remains separately and honestly recorded as the irreversible absence of the original Task 2 pre-implementation behavioral RED. Neither this correction's RED nor this review relabels it as repaired.

## Code-quality review

No current finding was identified.

- The retry policy is named, finite, local to the audit owner, and separated from Guard lifecycle authority.
- Error normalization remains total for hostile values; rejection presence does not alias the value.
- The handoff class follows the existing frozen `ContextConstructionError` pattern without introducing a parallel lifecycle owner.
- The requestfailed callback uses the common protocol-task abstraction rather than duplicating admission, overflow, drain, or invalidation logic.
- The invalidation signal and pending-task deletion ordering is explicit and avoids an ownership cycle.
- Existing bounded ledger, task, correlation, listener, and DOM-work constraints remain unchanged.

Finding counts: **Critical 0 / Important 0 / current Minor 0**.

## Reviewer-owned execution

Reviewer evidence is separate from the implementer/verifier evidence above.

1. Initial package hash:

   `Get-FileHash -Algorithm SHA256 -LiteralPath '.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md'`

   Result: exact required hash.

2. Mechanical manifest parse/recompute, run initially and again after writing this artifact:

   `$package = '.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md'; $self = $package.Replace('\\','/'); $rows = foreach ($line in Get-Content -LiteralPath $package) { if ($line -match '^\\| `([^`]+)` \\| `([0-9A-F]{64})` \\|$') { [pscustomobject]@{Path=$Matches[1]; Expected=$Matches[2]} } }; $dupes = $rows | Group-Object Path | Where-Object Count -gt 1; $selfRefs = $rows | Where-Object { $_.Path.Replace('\\','/') -eq $self }; $results = foreach ($row in $rows) { if (-not (Test-Path -LiteralPath $row.Path -PathType Leaf)) { [pscustomobject]@{Path=$row.Path; Status='MISSING'; Expected=$row.Expected; Actual=''} } else { $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $row.Path).Hash; [pscustomobject]@{Path=$row.Path; Status=$(if($actual -ceq $row.Expected){'MATCH'}else{'MISMATCH'}); Expected=$row.Expected; Actual=$actual} } }`

   Result on both accepted runs: 91/91 matches, zero missing/mismatch/duplicate/self-reference.

3. Narrow correction focus, restricted attempt:

   `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts tests/integration/passive-request-guard.test.ts -t "owner cleanup|lifecycle priority retained close retry|requestfailed callback is void-owned|257 synchronous requestfailed|contains requestfailed task failure"`

   Result: exit 1 before test execution because installed Chromium launch failed with `spawn EPERM`; 3 suites failed and 260 tests were skipped. This is an environment/process-launch attempt, not product evidence.

4. Identical narrow correction focus with approved local-process permission:

   `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts tests/integration/passive-request-guard.test.ts -t "owner cleanup|lifecycle priority retained close retry|requestfailed callback is void-owned|257 synchronous requestfailed|contains requestfailed task failure"`

   Result: exit 0; **3 files passed; 10 tests passed / 250 skipped / 260 total**.

5. Accepted boundary/package scan:

   `rg -n '本来の監査対象のサイト|www\\.本来の監査対象のサイト\\.com|innerHTML\\s*=|setAttribute\\(' src`

   `rg -n 'querySelectorAll\\(.*INTERACTION_CANDIDATE_SELECTOR|querySelectorAll\\(selector\\)|locator\\(INTERACTION_CANDIDATE_SELECTOR\\)' src/interaction`

   `Get-FileHash -Algorithm SHA256 -LiteralPath 'package.json'; Get-FileHash -Algorithm SHA256 -LiteralPath 'package-lock.json'`

   Result: both scans had no matches; package hash `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233`; lock hash `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.

6. One earlier combined scan command had invalid PowerShell quoting and produced only a parser error. It is excluded from evidence; the corrected commands above are the accepted scan evidence.

Read-only inspection also covered the complete correction brief/report/package, all three changed production files, the Safety Ledger snapshot owner, the focused changed test blocks, current Task 11 terminal-recovery authority, the two prior final reviews, and the append-only Task 5/progress evidence entries.

## Implementer/verifier evidence assessed, not rerun as reviewer evidence

The package/report records: correction focus 10/10; close retry 1/1; owner retention/recovery 5/5; Task 11 focus 49/49; close/invalidation focus 44/44; Guard bound 5/5; requestfailed race 6/6; DOM budget 23/23; isolated interaction 124/124; passive Guard 117/117; context factory 19/19; six-file regression 309/309; repository 26 files / 524 tests; typecheck and build exit 0; both forbidden scans clean; package/lock fixed.

Those counts were checked for internal consistency against the current test inventory and pinned hashes, but are not relabeled as reviewer executions. The reviewer independently reran only the 10-test correction selection above.

## Reviewer NOT RUN ledger

NOT RUN

- command: close-retry-only 1-test focus, retained-owner 5-test focus, close/invalidation 44-test focus, Guard-bound 5-test focus, requestfailed-race 6-test focus, DOM-budget 23-test focus, the three full changed test files, six-file regression, and repository full suite
- reason: the matching package already pins fresh implementer/verifier executions, and the reviewer instruction permits only narrow diagnostics needed for a concrete doubt; the combined 10-test correction selection resolved the current correction questions
- impact: those broad/focused counts remain implementer/verifier evidence, not reviewer-owned runtime evidence
- completion relevance: no blocker for this review verdict

NOT RUN

- command: reviewer `npm run typecheck` and `npm run build`
- reason: no production/test/type file was changed by the reviewer, current package hashes match, and fresh implementer executions are pinned
- impact: compiler/build results remain implementer/verifier evidence
- completion relevance: no blocker for this review verdict

NOT RUN

- command: standalone RED-time `npm run typecheck`
- reason: it was not run by the implementer at the historical RED checkpoint and cannot be retroactively created; the accepted Vitest run transformed/imported the selected tests, and the omission is explicitly disclosed
- impact: no standalone compiler proof exists at that temporal checkpoint
- completion relevance: honest evidence limitation, not a current code/spec defect

NOT RUN

- command: recreation of the pre-production RED
- reason: doing so would require production rollback/mutation or Git operations, both prohibited for this reviewer
- impact: temporal RED is assessed from frozen hashes, the retained failure record, tests, and append-only ledgers rather than independently recreated
- completion relevance: no blocker; the recorded failures are genuine behavioral failures and are not presented as compiler/harness RED

NOT RUN

- command: Git operations, dependency/library download/install/update/import, package mutation, live-target access, delegation/subagents, or Task 12+
- reason: expressly prohibited or outside scope
- impact: none of these operations is needed for the verdict
- completion relevance: Task 12+ remains blocked pending controller adjudication and explicit user approval

## Historical/deferred items — not current findings

Historical evidence deviation: **Task 2 I7** remains the separately adjudicated irreversible absence of original Task 2 behavioral-RED evidence. It is unchanged and not retroactively repaired.

The six previously carried historical/deferred Minor observations remain separate from the current finding count:

1. lifecycle-phase HTTP abort correlation does not add the exact Request to `expectedRouteFailures` before abort;
2. the historical test helper `emitFailedMainFrameRequest()` drops its asynchronous callback result;
3. the page-readiness tracked-task body remains materially mis-indented;
4. interaction error normalization can materialize a large successful `String(error)` before slicing;
5. superseded 2026-08-31 plan illustrations retain historical error-presence/close-precedence drift, while current authority and production are correct;
6. a construction regression checks `ContextConstructionError` by name/shape rather than runtime `instanceof`.

None was introduced or worsened by this correction, and none is a current Critical/Important blocker.

## Handoff

The independent combined specification/code-quality review is **PASS** with Critical 0 / Important 0 / current Minor 0 and a clean 91/91 manifest. Task 11 remains controller/user approval-gated; Task 12+ is explicitly blocked.

Review Sweep Completed: yes
