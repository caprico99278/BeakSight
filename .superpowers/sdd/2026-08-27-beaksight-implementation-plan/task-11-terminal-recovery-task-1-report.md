# Task 11 terminal recovery — Task 1 implementation evidence

Date: 2026-09-20. Status: TDD implementation in progress; independent review pending.

## Authority and no-Git baseline

Read the complete fixed Task 1 brief, approved design, and implementation plan Task 1 before edits. No Task 2+ work is authorized here.

Baseline command (exit 0): `Get-FileHash src/safety/passive-request-guard.ts,src/browser/context-factory.ts,tests/integration/passive-request-guard.test.ts,tests/component/context-factory.test.ts,package.json,package-lock.json,doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md,doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md -Algorithm SHA256 | Format-List`

| Path | Baseline SHA-256 |
| --- | --- |
| src/safety/passive-request-guard.ts | 7B7B5B935AF17B28FF958F4E4F93619B550264DDF7625ED5C870096747BC6A66 |
| src/browser/context-factory.ts | 92E79F378BBA393FAF62D83040C8081371D919D45AB18E773514EA4024FBC8B5 |
| tests/integration/passive-request-guard.test.ts | 4B2CE15F072AFAABC4A78E8BF1833DB6C45D5E7DFC00CDFB1C61CA8A83F19107 |
| tests/component/context-factory.test.ts | D13622D52F23A12100AEDAD1B4AFAFFBABB94E3AB6D8FA053403DCDB86497C11 |
| package.json | 75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233 |
| package-lock.json | A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md | 1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md | A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D |

All baseline hashes match the frozen brief. Source/tests have not yet been edited at this checkpoint.

## Pre-edit authority clarification

Implementation paused before test/source edits under the brief's instruction to stop and ask if ambiguous. The controller has been asked to resolve these concrete conflicts:

1. Task 1 Step 8 immediately rejects a raw-close failure without draining owned tasks. Existing regression `drains late evidence after failed frozen safety-invalidation close without closing twice` requires download task finalization before close settlement and preservation of the initiating page-close error. The design preserves other Task 11 safety/evidence invariants but does not explicitly supersede that failed-close drain boundary.
2. `createPassivePage()` and `createInteractionSession()` already call the canonical factory close in construction catch branches. With Step 6's first-fails/second-succeeds raw-close spy, making that API retryable allows those catch calls to close during construction, before the required non-terminal `ContextConstructionError.context` handoff. Retaining the construction owner appears to require preventing implicit retry once invalidation is already underway; the plan does not specify this adjustment.
3. Installation and page-close error paths await `invalidateContext()` before rethrowing their original error. Its newly rejecting raw-close result would mask those original errors, conflicting with construction-cause assertions that Step 6 preserves.

No source/test mutation has occurred and baseline hashes remain the current source/test/package hashes. Only this evidence report has been created at this checkpoint.

NOT RUN — `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry"`; reason: authority clarification before test edits; impact: intended RED not established; completion blocker: yes.

NOT RUN — `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5"`; reason: implementation not started; impact: GREEN unproven; completion blocker: yes.

NOT RUN — `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts` and `npm run typecheck`; reason: implementation not started; impact: Task 1 regression/type verification pending; completion blocker: yes.

NOT RUN — full repository `npm test`, final build and independent Task 1 review; reason: no implementation/review package yet; impact: completion verification pending; completion blocker: yes. Independent review is controller-owned; this implementer is forbidden to spawn reviewers.

No Git command/operation, dependency download/install/import/package mutation, live-target access, subagent creation, or Task 2/3/4/12 work occurred.

## Controller ruling — resumed TDD

The controller resolved the pre-edit questions using approved design §4.3(8): raw-close failure promptly rejects the active attempt while retaining listeners/tasks/owner for later explicit retry. The late-evidence regression must be rewritten to prove the next attempt waits for retained tasks and reaches CLOSED. Original page-close and installation errors remain the wrapper errors; those wrappers observe/contain an already-ledgered invalidation-attempt rejection. `createPassivePage()` must release ownership only for CLOSED after readiness failure, otherwise hand off `ContextConstructionError` immediately; `createInteractionSession()` must rethrow that handoff unchanged and avoid an implicit second attempt. These rulings supersede the historical no-retry expectations. All new/adjusted tests precede production edits.

## Genuine RED before production edits

Command: `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry"`.

The sandboxed launch returned exit 1 with `browserType.launch: spawn EPERM` in both setup hooks (125 skipped; teardown also could not close an uninitialized browser). This is an environment failure, not RED. The exact same command was approved/executed with existing Chromium outside the process-launch restriction: exit 1, 2 failed files, 13 failed / 2 passed / 110 skipped (125 total), duration 2.94 s. No unhandled rejection was reported. Production hashes were re-read after RED and still match the original two baseline hashes.

Intended RED failures:

| Test | Observed old-behavior failure / mutation killed |
| --- | --- |
| round 5 retained close retry preserves the construction cause after GUARD_INSTALLATION fails | Raw close remains 1, expected 2; permanent completion prevents explicit recovery. |
| round 5 retained close retry preserves the construction cause after PAGE_READINESS fails | Raw close remains 1, expected 2; construction handoff cannot recover. |
| lifecycle priority retained close retry releases session ownership only at CLOSED | Physical page remains open after retry; expected closed. |
| retained close retry releases the factory Context only after physical close | Raw close remains 1, expected 2. |
| lifecycle priority retained close retry recovers the Context owner after PAGE_CLOSE fails | Raw close remains 1, expected 2. |
| lifecycle priority retained close retry recovers the Context owner after PAGE_READINESS fails | Readiness throws ordinary invalidated error instead of ContextConstructionError handoff. |
| retains late evidence after failed close until an explicit retry drains it | Old attempt waits for drain timeout and masks page-close error; expected original page-close failure while work remains pending. |
| performs a drain-only retry after a listener-task drain timeout | Retry returns permanently settled timeout instead of reaching terminal invalidated outcome. |
| keeps safety invalidation sticky through a drain-only retry | Same permanently settled timeout prevents terminal recovery. |
| ledgers context close failure and retains retry ownership while failures persist | Retry returns old semantic invalidated error instead of a new raw-close failure/attempt. |
| retry of a failed invalidating raw Context close reaches CLOSED | Raw close remains 1, expected 2. |
| overlapping retry callers share one raw close and remain pending until it settles | Second attempt never starts; raw count stays 1 instead of 2. |
| synchronous re-entry preserves invalidation priority with retry=true | Retry raw count stays 1 instead of 2. |

The `retry=false` re-entry case passes already and is retained as priority/publication regression coverage. Construction tests additionally assert one attempt before handoff, exact original installation/readiness cause, and physical/terminal release after the retry, killing implicit-retry and causal-masking implementations.

## GREEN development and regression history

The minimum implementation replaces permanent invalidation completion with the shared active close/drain attempt and physical-close confirmation. Readiness construction follows the controller ruling; installation/page-close wrappers retain original errors. Guard task admission, stable-drain logic, timeout constants, ledger normalization, and listener cleanup ownership remain the existing implementations.

The first expanded GREEN command was `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5"`. It stalled while a new `toMatchObject` assertion recursively inspected a live Playwright Context; interrupted with Ctrl-C, exit 1, no final test counts. Diagnostic isolation:

- `npm test -- --run tests/integration/passive-request-guard.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5" --reporter=verbose`: exit 0, 14 passed / 92 skipped.
- `npm test -- --run tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5" --reporter=verbose`: reached the PAGE_READINESS Context assertion after five selected passes and stalled; interrupted with Ctrl-C, exit 1, no final counts.
- Replaced only recursive Context comparison with the equivalent stronger identity assertion `(failure as ContextConstructionError).context` `toBe(context)`; causal/name assertions remain independent. The expanded command then passed 20 / 105 skipped, exit 0. No production change was made to address this assertion issue.

Self-review then found ordinary concurrent close callers reapplying `ownerClosingPhase(CLOSING)`, which throws instead of joining. Added `overlapping ordinary close callers share the active close attempt without retry` first and ran `npm test -- --run tests/integration/passive-request-guard.test.ts -t "overlapping ordinary close"`: exit 1, 1 failed / 106 skipped. Intended RED: while raw close is gated, settled caller count is 1 rather than 0. Minimum production fix: apply the owner-closing phase transition only while the phase is not already closing/invalidating. Expanded GREEN then passed 21 / 105 skipped, exit 0.

First full two-file regression, `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`: exit 1, 122 passed / 4 failed, plus one asynchronously handled assertion rejection. The four old-contract failures were:

- `does not close an already invalidated Context twice after readiness failure`: now returns the explicitly required retained construction handoff while its raw close is pending; changed the assertion to verify original cause/Context identity and join the still-active attempt without another raw close.
- `rolls back a Page listener group when its readiness task admission is denied`: old expected drain timeout conflicts with prompt raw-close failure; now asserts raw failure and later explicit retry while preserving all denied-listener rollback checks. Its obsolete deferred assertion caused the reported handled-rejection warning; awaiting the correct prompt failure removed it.
- `retains fail-closed listeners when Context close rejects`: old second-call result/count assumed no retry; now checks two failed attempts and retained listeners.
- `retains fail-closed listeners when Context close rejects undefined`: now checks the original undefined rejection on both failed attempts and retained listeners.

Second full two-file run: exit 1, 124 passed / 2 failed (the two listener-retention cases above still expected one ledger entry despite two actual failed attempts). Updated their exact expected ledgers to contain the two bounded failure records. Third full two-file run: exit 0, 126 passed; `npm run typecheck`: exit 0. A subsequent `npm test`: exit 0, 26 files / 447 tests passed. No production change was needed for these superseded assertions.

Supplemental self-review checked whether HTTP/WebSocket callbacks might accidentally consume a second invalidation attempt. Added two cases asserting callback receives raw-close failure, count stays 1/non-terminal, and only later explicit owner close increments to 2/CLOSED. `npm test -- --run tests/integration/passive-request-guard.test.ts -t "a failed.*invalidation attempt remains"`: exit 0, 2 passed / 107 skipped. These passed immediately and are supplemental regression coverage, not claimed as RED; no production change followed. Current Promise ordering joins the same active attempt.

## Final fresh verification

All browser tests below used already-installed Chromium and local fixtures with approved process-launch escalation; no dependency command was executed. Typechecking ran in the default sandbox.

| Exact command | Exit | Final result |
| --- | --- | --- |
| `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry\|drain-only\|retained close\|synchronous re-entry\|lifecycle priority\|round 5"` | 0 | 2 files; 23 passed / 105 skipped / 128 total; 1.90 s |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts` | 0 | 2 files; 128 passed / 0 failed; 6.16 s |
| `npm run typecheck` | 0 | TypeScript strict check passed |
| `npm test` | 0 | 26 files; 449 passed / 0 failed; 15.76 s |

The table escapes filter pipes for Markdown rendering; the literal shell filter is `"retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5"`. Final test output reports no unhandled errors. The package-manager upgrade notice is informational; no upgrade was performed.

Additional read-only commands: `Get-FileHash src/safety/passive-request-guard.ts,src/browser/context-factory.ts -Algorithm SHA256 | Format-List` after RED (exit 0; unchanged production); `rg -n 'invalidationCompletion|as any|as unknown as|@ts-ignore|@ts-expect-error' src/safety/passive-request-guard.ts src/browser/context-factory.ts` (exit 1, expected no matches). Final baseline command was repeated after all tests and exited 0; authority and package hashes remained identical.

## Final fixed hashes and edited paths

| Path | Final SHA-256 | Disposition |
| --- | --- | --- |
| src/safety/passive-request-guard.ts | 0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2 | changed |
| src/browser/context-factory.ts | 6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508 | changed |
| tests/integration/passive-request-guard.test.ts | A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1 | changed |
| tests/component/context-factory.test.ts | F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9 | changed |
| package.json | 75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233 | unchanged |
| package-lock.json | A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A | unchanged |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md | 1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E | unchanged |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md | A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D | unchanged |

Exact additional edited/created paths, all under `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`: appended `task-11-recovery-task-5-report.md`; appended `progress.md`; created this `task-11-terminal-recovery-task-1-report.md`; created `task-11-terminal-recovery-task-1-manifest.md` as the requested fixed review package index. No other source, test, configuration, package, fixture, or build-output path was edited by this implementer. The manifest records report/ledger hashes after their final append, avoiding self-referential hashes here.

## Invariant reasoning and self-review

- Lifecycle phase remains the sole admission/terminal authority. Rejection clears only the active attempt reference, never phase or owner. `rawCloseConfirmed` is factual physical-close confirmation set only after fulfillment, not another lifecycle state machine.
- The start barrier publishes one attempt before invoking raw close. Both ordinary overlap and invalidating retry overlap join it; synchronous request-failure invalidation promotes the phase and never starts another physical close.
- Failed raw close retains all listeners and admitted tasks; bounded ledger records include the original raw error even when undefined. Later owner close starts one fresh attempt. Successful raw close detaches each owned listener once; cleanup groups already consumed remain inert on drain-only retry.
- `drainGuardTasks` retains its atomic final-empty-set/terminal callback and never invokes that callback on timeout. Immutable `CloseAttemptResult.invalidated` is captured immediately before `CLOSED`, preserving safety precedence for callers after phase transition.
- Only confirmed raw close plus successful drain reaches `CLOSED`. The existing factory/session finalizers continue to consult that canonical state before release. Construction failures hand back the retained Context and original cause without a nested implicit retry.
- Page-close and installation wrapper catches contain secondary close-attempt rejection only after it is ledgered and preserve their primary causal error. Current event rejection containment and reserved overflow ownership remain intact; full regression proves no final unhandled rejection.
- Mutation coverage includes permanent completion retention, one raw close per waiter, late publication before synchronous callback, marking raw close before fulfillment, a second raw close after drain timeout, normal success after invalidation, premature factory/session release, construction implicit retry, and masking primary construction/page errors.
- Resolved self-review finding: ordinary normal-close overlap initially reapplied the phase transition; genuine RED and minimum correction documented above. Investigated protocol double-invalidation concern did not reproduce and required no correction. No known unresolved Task 1 correctness finding remains; independent reviewers retain authority to assess the package.
- No public close API, new retry policy/count/backoff, background retry timer, second owner, dependency/type escape, or live-target behavior was added. Existing local listener/ledger limits and terminal protocol cutoff remain covered.

## Final status and remaining gates

Task 1 implementation and executed verification are complete; independent review is pending. Task 11 remains unapproved; Task 2+ and Task 12 were not started.

NOT RUN — independent Task 1 specification/code-quality review; reason: controller-owned reviewers, explicitly forbidden to this implementer; impact: approval-blocking retry liveness/single-flight/re-entry/drain-only/terminal-release/invalidation-priority review remains pending; completion blocker: yes for Task 1 checkpoint approval and Task 2 start.

NOT RUN — `npm run build`; reason: not a Task 1 step and build outputs are outside this implementer's fixed file scope; impact: fresh emitted build verification is deferred to the later approved final verification task; completion blocker: no for this Task 1 implementation handoff, yes for final Task 11 approval.

NOT RUN — separately filtered DOM-budget/structured-outcome correction gates and their implementation tasks; reason: Task 2+ is explicitly forbidden here; impact: the other two Task 11 correction findings remain outside this handoff; completion blocker: yes for Task 11, no for Task 1 implementation. The repository suite includes existing interaction/DOM tests but is not claimed to implement or verify future corrected contracts.

Final explicit constraint confirmation: no Git commands/operations; no dependency/library download, installation, new import, or package mutation; no live-target access; no subagents/reviewers spawned; no Task 2/3/4/12 work. Only existing local test/browser tooling was used. Historical pending/not-run entries above are preserved for audit and superseded by this final status only where fresh results are listed.

## Task 1 fix round 1 — I1/I2 correction, 2026-09-20

The failed independent review supersedes earlier claims here that protocol double-invalidation could not reproduce and event rejection containment was complete. The historical text above is retained. Round 1 captures one invalidation Promise per protocol callback and protects arbitrary rejection classification before bounded normalization; only the Guard source and Guard integration test changed.

Genuine RED: `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"`, exit 1, 5 failed / 109 skipped; four synchronous/direct-rejection HTTP/WebSocket cases observed the wrong callback outcome and one unobserved requestfailed event escaped hostile prototype error. Both production hashes still matched the frozen baseline at RED. Initial sandbox browser `spawn EPERM` was excluded from RED evidence. Same focus GREEN: exit 0, 5 passed / 109 skipped.

Expanded GREEN: `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5|fix round 1"`, exit 0, 28 passed / 105 skipped. Two-file regression `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`: exit 0, 133 passed. `npm test`: exit 0, 26 files / 454 passed. `npm run typecheck`: exit 0.

Final Guard SHA-256: `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB`; Guard-test SHA-256: `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF`. Factory, factory test, packages, approved authorities, failed review, and historical manifest are unchanged. Complete evidence/mutation reasoning/self-review: `task-11-terminal-recovery-task-1-fix-round-1-report.md`; new fixed index: `task-11-terminal-recovery-task-1-fix-round-1-manifest.md`.

NOT RUN — independent re-review: controller-owned, blocks Task 1 approval/Task 2 start. NOT RUN — build: forbidden for this fix round, no fresh emitted-output verification, blocks final Task 11 approval but not this handoff. Task 2/3/4/12 remain untouched. No Git, dependency/library download/install/new import/package mutation, live-target access, subagent/reviewer spawning, or out-of-scope edit occurred. Historical deferred Minors remain unchanged.
