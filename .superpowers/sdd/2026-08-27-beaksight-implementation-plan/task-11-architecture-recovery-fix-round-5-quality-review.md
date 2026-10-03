# Task 11 Architecture Recovery Fix Round 5/5 Independent Quality Re-review

## Verdict

**PASS — Critical: 0; Important: 0; historical/deferred Minor: 5; new Minor: 0.**

All three requested findings are **ADDRESSED**. No new Critical or Important defect was found in the correction surface or its interaction with Fix round 4 lifecycle priority. Two of the five carried Minors are outside this round's correction scope and are explicitly classified below. This is the independent quality-review verdict; overall Task 11 approval still requires the other independent review and the controller's checkpoint decision.

## Integrity and review method

The review package matched expected SHA-256 `419D59126CB6757FBCCB5A502C963229AC1457CA94121F23F9FF07F6DBDC7057` before source/test review.

All five package authorities matched:

| Authority | Verified SHA-256 |
|---|---|
| Original 48-entry package | `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44` |
| Fix round 5 brief | `E269E1DD349C825038989063718810E2A2E5A4218CA092F90917734D88DA300D` |
| Entering round-4 specification review | `F35E38C7137531776EEDE92436E7D51EB1A93611B518B0E449B9DD6646A80B8A` |
| Entering round-4 quality review | `0F6C699B016A54D50806C89E59453FA1ED018C1964F848035158897F3B179867` |
| Current append-only implementation report | `E9D29D14FEACECBD4665454373ECBEF581C7E308FC2B87E71064956AC22BF3EF` |

The original manifest has exactly 48 unique paths. Applying exactly the six package substitutions gives **48/48 matches, 42 unchanged original entries, zero missing files, and zero mismatches**. The nested binding lifecycle-priority brief also matches `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718`.

The prior report baseline `679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA` is preserved as an exact byte-equivalent UTF-8 prefix of the appended report, before the one-character separator preceding the new round-5 heading. Fourteen current path/hash rows in the round-5 report were independently checked, including both changed build outputs and both TypeScript configurations; all matched. Historical dispatch hashes are prior-state references, not additional substitutions into the current manifest.

Correctness judgments below come from production control flow and the actual maintained test bodies, not the implementation report's conclusions or its reported RED/GREEN claims. The Guard, factory, relevant callback/caller paths, admission/finalization boundaries, and new tests were inspected independently. Earlier unchanged traversal/result/ledger contracts were checked against the fixed manifest and their relevant source/test surfaces.

## Finding 1 — Construction rejection strands a non-terminal Context

**ADDRESSED.**

`BrowserContextFactory.createPassiveContext()` now registers the Context and ledger before Guard installation can reject (`src/browser/context-factory.ts:89-92`). Its catch releases both registrations only after the Guard confirms `CLOSED`; otherwise it throws `ContextConstructionError` carrying the retained Context (`:93-99`). A successfully closed failed construction still throws its original cause without leaving active factory ownership.

`createInteractionSession()` attempts canonical factory close after Page creation/readiness fails, and then exposes the retained Context if the Guard remains non-terminal (`:104-116`). This also covers the outer failure path where `newPage()` itself rejects. It does not fabricate a successful session or lose the only reachable Context before rejection.

The new error surface (`:24-35`) is minimal: an Error with a read-only Context reference and original `cause`, frozen before publication. The reference is intentionally usable by the existing `factory.closePassiveContext(error.context)` API; the Playwright transport object itself is not frozen. The error has no close implementation, lifecycle enum, promise owner, or permission to reuse an invalidating Context. Factory membership is still required by `#requireActiveContext()` (`:185-188`), and ordinary operation eligibility still uses the canonical Guard (`:191-194`). Thus it is an ownership handoff through a rejected construction, not another lifecycle authority or alternate close entry point.

For the readiness timing where Guard invalidation is already visible, `awaitPassiveRequestGuardReady()` preserves the failed setup rejection in the standard Error cause chain (`src/safety/passive-request-guard.ts:703-710`). The normal ready-await path preserves the original rejected value directly (`:718`). The factory wrapper retains that value as `cause` rather than normalizing it away.

The two new construction tests (`tests/component/context-factory.test.ts:123-178`) exercise a real factory and real Context construction with failures injected at route installation/CDP setup and raw Context close. They derive the Context used for later joins from the rejected error, check the original cause by identity, require the error to be frozen, call the canonical close twice, reject active Page reuse, inspect the retained ledger, and assert one raw close. Restoring post-install ownership registration, unconditional release, or a plain unreachable rethrow breaks these assertions. The terminal successful-close case remains checked at `:89-106`; foreign ownership rejection remains unchanged.

## Finding 2 — Failed-request event invalidation leaks rejection

**ADDRESSED.**

`initiateInvalidation()` now returns a contained initiation-view Promise (`src/safety/passive-request-guard.ts:485-492`). It observes the `invalidateContext()` result without replacing `GuardState.invalidationCompletion`. A known drain timeout is already ledgered and is contained at this event boundary; another initiation error is normalized and recorded. Public owners still await the original published completion and receive its stable rejection (`:819-830`).

All four failed-request invalidation branches await the contained view (`:1276`, `:1285`, `:1299`, `:1321`). The event handler therefore preserves its completion wait while no longer returning an unobserved drain-timeout rejection. It is not added to `pendingTasks`, so it cannot await a completion that is waiting for this same event Promise to drain. Its evidence work is synchronous before that wait.

The installation-phase `onPage` branch now uses the same contained initiator (`:1188-1194`). The other fire-and-forget Page/CDP/download/popup event paths also use this helper. Remaining direct `await invalidateContext()` calls belong to explicit operation/installation owners or the protocol wrapper's outer result, rather than a bare event initiation. No `void invalidateContext()` event branch remains.

The new failed-request timeout test (`tests/integration/passive-request-guard.test.ts:2415-2455`) deliberately leaves the event return unobserved, holds one admitted Download task through the deadline, checks zero process-level unhandled rejections, requires the identical timeout object from repeated public owner joins, and checks one raw close and a non-terminal Guard. This directly catches the entering production defect rather than merely checking the shared completion has a catch attached somewhere.

## Finding 3 — In-flight HTTP/WebSocket callbacks escape the evidence drain

**ADDRESSED.**

Both protocol registrations now enter `runGuardProtocolTask()` (`src/safety/passive-request-guard.ts:1331-1394` and `:1396-1479`). The wrapper has these ownership properties:

1. **Admission precedes all protocol body work.** The `CLOSED` check and the shared cap check run before the factory is invoked (`:546-549`). The admitted promise is inserted into the same `pendingTasks` set synchronously (`:553-567`), before its deferred body can run. HTTP request inspection, fallback/abort, and WebSocket URL/close handling all occur inside that body.
2. **The cap is shared and fail-closed.** `admitGuardTask()` owns the existing 256 limit and single bounded overflow report (`:506-515`). Its failure starts/joins reserved invalidation, and the protocol wrapper returns without invoking the body. No 257th fallback, abort, WebSocket close, or server connection is issued by the rejected callback. A denied HTTP route stays paused for Context teardown; no denied WebSocket is connected to a server.
3. **Evidence and failure handling remain owned.** The owned promise includes the entire protocol body, its protocol awaits, and its error/evidence catch (`:554-561`). Existing helpers now request invalidation as a flag after recording their facts (`:591-667`), rather than awaiting Context completion inside the drained task. Separate `failed` and `failure` fields preserve arbitrary rejection values, including `undefined`.
4. **There is no self-drain.** The finalizer deletes the task first, then synchronously initiates invalidation if requested (`:562-565`). It does not return/await the initiation promise. The outer callback joins the shared completion only after the owned promise has settled (`:568-571`). The set being drained therefore cannot contain a task waiting for that drain's completion.
5. **Invalidation cannot be lost between removal and close.** The deletion and invalidation initiation have no intervening await. `invalidateContext()` synchronously promotes an existing closing phase before returning its promise (`:444-451`). A close drain that resumes afterward sees the promoted phase.
6. **Empty drain and terminal publication are atomic.** `drainGuardTasks()` invokes `onDrained()` in the same synchronous segment as its final empty-set observation (`:372-376`). Successful invalidation writes `CLOSED` there (`:473-475`); normal close captures final invalidation priority and writes `CLOSED` there (`:856-859`). No await leaves an interval between the final empty set and terminal admission cutoff.
7. **Terminal callbacks perform no new protocol/evidence work.** A saved route callback invoked after `CLOSED` returns before even executing its body (`:546-547`). The outer completion join after an admitted task finalizes performs no further ledger mutation. A drain timeout never calls `onDrained()` and retains the non-terminal fail-closed state and the existing rejecting owner completion.

The paired pending-protocol tests (`tests/integration/passive-request-guard.test.ts:2458-2501`) hold HTTP fallback/WebSocket close across successful raw Context close. They require both public close and terminal state to remain pending, then inject a late failure and assert invalidation rejection, the exact final failure evidence, a terminal Guard after drain, one raw close, and snapshot stability. Removing protocol ownership or making the owned task await its own drain fails those assertions.

The paired admission tests (`:2503-2544`) admit 256 gated callbacks, then exercise overflow and an additional saved callback after terminal completion. They check the cap, one overflow invariant, no WebSocket server connection, one raw close, and unchanged post-cutoff evidence. Their body/cap assertions are supported by the source-level early-return proof above; no claim is made that every possible artificial mutation was executed by this reviewer.

The changed pre-existing test at `:703-744` is a valid terminal-contract correction. It still invokes a frozen HTTP navigation during invalidation drain and requires one blocked interaction request (`:725-729`). Only the saved callback after completion now expects zero abort calls and no additional evidence (`:735-743`). That strengthens terminal admission cutoff while preserving the during-drain freeze assertion.

## Fix round 4 and adjacent regression inspection

- **Single phase authority:** `isPassiveRequestGuardClosed()` remains a direct read of `guardStates.get(context)?.phase` (`src/safety/passive-request-guard.ts:752-754`). The construction error introduces no independent state machine. Session closure and factory active membership remain ownership markers derived from the Guard's terminal state.
- **Invalidation over normal close:** both closing phases still synchronously promote and join their already-published completion (`:444-451`). Normal close records whether promotion occurred at the atomic drained boundary and rejects after completion when invalidated (`:843`, `:856-869`). Frozen authority is not downgraded to passive authority.
- **Completion publication and one raw close:** invalidation publishes its completion before opening its raw-close start gate (`:453-481`); normal close publishes before calling raw close (`:833-845`). The protocol wrapper reuses these paths. No construction-error close implementation or new raw-close call site was introduced.
- **Terminal-only ownership release:** session `closed` is derived in `finally` from the Guard query (`context-factory.ts:127-135`); Context deletion in the canonical close and Page-close failure path remains terminal-conditioned (`:170`, `:181`). Active-only checks do not discard close ownership. Failed raw close retains a callable factory/session/error-context join and cannot authorize active reuse.
- **Deterministic ordering/status:** the unchanged real-session/audit regressions at `tests/integration/isolated-interaction.test.ts:1133-1273` cover INVALIDATING/CLOSED observation and both close/invalidation orders, preserving prior VERIFIED evidence while requiring BLOCKED_BY_SAFETY and one raw close. The new protocol wrapper feeds the same owner/finalizer path.
- **Bounds and cleanup:** pending task cap, reserved overflow owner, expected-failure/redirect registry caps and identity checks, and the 64 Page/CDP listener-group limit remain intact. Listener groups are released before exact inverse callbacks; individual inverse failure is ledgered and does not stop later cleanup. Raw close failure retains the applicable fail-closed listeners and invalidating phase. Protocol callbacks in a non-terminal failed-close phase continue to take fail-closed branches.
- **Existing finalizers/evidence:** descendant traversal, bounded indexed candidate selection, retained Handle identity, the single non-null Handle disposal scope, the audit's failure-presence flag and freeze/close/work precedence, and detached immutable Safety Ledger/result snapshots are unchanged by hash. No second interaction audit entry point was introduced.
- **S03-S08:** the unchanged audit tests retain real fixture request observations and mutation/download/upgrade counters, including separate generated-download cancellation and HTTP-download zero-delivery proofs. Protocol admission does not introduce any continue/fallback/connect operation in frozen, invalidating, overflow-denied, or terminal cases. These browser suites were not redundantly rerun by this reviewer.

## Carried Minor and out-of-scope classifications

| ID | Classification | Current location and disposition |
|---|---|---|
| M1 | Historical/deferred runtime Minor | `src/safety/passive-request-guard.ts:1410-1417`: lifecycle HTTP abort does not register the exact Request in `expectedRouteFailures`; the carried passive-teardown failure-correlation issue remains. It is separate from the now-correct protocol task ownership. |
| M2 | Historical/deferred test-helper Minor | `tests/integration/passive-request-guard.test.ts:317-330`: `emitFailedMainFrameRequest()` still returns void and drops the asynchronous handler result. The new production event containment resolves the Important failure independently of this helper cleanup. |
| M3 | Historical/deferred maintainability Minor | `src/safety/passive-request-guard.ts:929-930`: the long Page-readiness task-factory body remains mis-indented through line 1135. |
| M4 | Historical/deferred; outside the three round-5 corrections | `src/interaction/isolated-auditor.ts:58`: `String(error)` can materialize a large bigint/string before the 512-character slice. The separate Guard normalizer remains bounded; the audit normalizer is unchanged and not claimed fixed. |
| M5 | Historical non-runtime authority drift; outside correction scope | `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md:286-300` and `:1099-1131`: illustrative snippets still use undefined as an error-presence sentinel and place close failure before freeze. Current production/tests have the corrected behavior. |

New Minor: **0**. New out-of-scope observation: **0**. M4/M5 are the two explicitly classified existing observations outside this round's implementation scope, included in the five carried Minor count. Replacing approved querySelectorAll selection or redesigning ancestor traversal remains a future design topic, not a newly elevated checkpoint finding.

## Verification performed and not performed

Reviewer-executed checks: package/authority/manifest hashes; current report path/hash rows and append-only prefix integrity; independent production and test-body inspection; fresh forbidden-boundary and scoped type-escape scans (no matches); and interaction-entry-point inspection (one production `auditInteraction()` definition).

No test, probe, typecheck, or build was rerun in this re-review. The concrete questions about the three corrections were resolved by inspection; the instruction permits focused execution only when needed and prohibits redundant broad runs. The supplied package records 12/12 combined focus, 177/177 Guard/factory/auditor, 226/226 Task 11, 47/47 adjacent, and 441/441 full-suite passes, plus typecheck/build and controller fresh checks. Those remain supplied verification results, not reviewer-executed results and not substitutes for the independent control-flow assessment above. There was no new reviewer environment gap.

No Git operation, dependency change/download/import, live-target access, source/test mutation, or delegation occurred. The only file written is this requested review artifact, using `apply_patch`.
