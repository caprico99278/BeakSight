# Task 11 Architecture Recovery Fix Round 5/5 Specification Review

## Verdict

`PASS` — Critical: 0; Important: 0; Minor: 6 (historical/deferred: 5; new: 1; out-of-scope: 0).

All three findings in the Fix Round 5 review package are **ADDRESSED**. The correction preserves the binding `invalidation > normal close` priority and the earlier Task 11 safety/ownership contracts. The one new Minor is a behavioral-test identity assertion gap; production itself uses the exported typed error correctly and the gap is not approval-blocking.

## Package, authority, and manifest integrity

- The Fix Round 5 review package matched its required SHA-256 before review: `419D59126CB6757FBCCB5A502C963229AC1457CA94121F23F9FF07F6DBDC7057`.
- Every package authority matched:
  - original 48-entry package: `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`;
  - Fix Round 5 brief: `E269E1DD349C825038989063718810E2A2E5A4218CA092F90917734D88DA300D`;
  - entering Fix Round 4 specification review: `F35E38C7137531776EEDE92436E7D51EB1A93611B518B0E449B9DD6646A80B8A`;
  - entering Fix Round 4 quality review: `0F6C699B016A54D50806C89E59453FA1ED018C1964F848035158897F3B179867`;
  - append-only implementation report: `E9D29D14FEACECBD4665454373ECBEF581C7E308FC2B87E71064956AC22BF3EF`.
- The binding lifecycle-priority brief referenced by the Fix Round 5 brief also matched `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718`.
- The original package contained exactly 48 manifest entries. Substituting exactly the six review-package hashes produced **48/48 matches**: six substitutions, 42 byte-identical original entries, zero missing files, and zero mismatches.
- The entering reviews and implementer report were treated as scope/history, not as evidence that production behavior is correct.

## Finding-by-finding adjudication

### 1. Construction rejection can strand a non-terminal guarded Context — ADDRESSED

`BrowserContextFactory.createPassiveContext()` now records both ledger and active ownership immediately after Context creation and before Guard installation can fail (`src/browser/context-factory.ts:82-92`). On installation failure it releases those owners only when the Guard reports terminal `CLOSED`; otherwise it throws `ContextConstructionError` carrying the still-owned Context (`src/browser/context-factory.ts:93-100`). Page/readiness failure in `createInteractionSession()` attempts the same canonical factory close and exposes that Context through the same typed error when it remains non-terminal (`src/browser/context-factory.ts:104-117`).

The error is a minimal exported `Error` subclass, stores the original cause and Context, and freezes its own surface (`src/browser/context-factory.ts:24-36`). It is not a lifecycle authority or alternate close path: cleanup still goes through `BrowserContextFactory.closePassiveContext()`, which calls the Guard's canonical close/join operation and deletes active ownership only after the Guard's read-only terminal query says `CLOSED` (`src/browser/context-factory.ts:176-182`; `src/safety/passive-request-guard.ts:752-755`). Active reuse is rejected by the normal Guard-active gate (`src/browser/context-factory.ts:148-159`, `:191-194`), and a foreign factory has no entry in its private ownership sets.

The parameterized production-path regression injects both Guard-installation and Page-readiness failures together with raw Context-close failure. It proves the exposed Context is frozen into the construction error, the original failure/cause chain is preserved, the existing factory close can be joined repeatedly, page reuse is rejected, failed-close evidence remains reachable, and raw close stays exactly once (`tests/component/context-factory.test.ts:123-178`). The pre-existing successful invalidation test still proves terminal construction failure releases the ledger owner (`tests/component/context-factory.test.ts:89-107`).

### 2. Failed-request event invalidation leaks an unhandled rejection — ADDRESSED

`invalidateContext()` still publishes and returns the single shared completion, including its stable timeout rejection (`src/safety/passive-request-guard.ts:430-482`). `initiateInvalidation()` now creates only a contained fire-and-forget view: it consumes that view's timeout rejection while leaving the shared completion untouched, and ledgers any unexpected owner failure (`src/safety/passive-request-guard.ts:485-493`). Every invalidating branch of the asynchronous `requestfailed` listener awaits this contained view, not the rejecting shared owner (`src/safety/passive-request-guard.ts:1270-1323`). The installation-phase and admission-limit `onPage` initiators are synchronous callbacks that invoke the same contained view without producing a returned rejecting Promise (`src/safety/passive-request-guard.ts:1179-1209`).

The RED/GREEN regression holds a Guard-owned task through drain timeout, triggers the failed-request event without observing its returned Promise, and proves zero process `unhandledRejection`, one raw close, non-terminal ownership, and object-identical timeout rejection from repeated public joins (`tests/integration/passive-request-guard.test.ts:2415-2456`). Because the contained event view is not entered into `pendingTasks`, it cannot await its own drain.

### 3. In-flight HTTP/WebSocket callbacks are outside the stable drain — ADDRESSED

Both route registrations enter `runGuardProtocolTask()` before reading request facts, making protocol calls, or publishing evidence (`src/safety/passive-request-guard.ts:1331-1479`). That owner synchronously checks `CLOSED`, shares the existing 256-task admission bound, and adds admitted work to `pendingTasks` before its factory begins (`src/safety/passive-request-guard.ts:506-516`, `:537-567`). Rejected admission therefore performs no 257th protocol action. An admitted owner covers protocol await plus catch/evidence work; its `finally` removes itself before synchronously initiating invalidation, and only the returned outer callback awaits the shared completion (`src/safety/passive-request-guard.ts:553-571`). This avoids self-drain while making Playwright's callback observe the canonical completion.

Drain's final empty-set check and terminal transition occur in one synchronous boundary (`src/safety/passive-request-guard.ts:343-377`). Consequently no callback can be admitted between the last empty observation and `CLOSED`; a saved callback invoked after terminal state returns without starting protocol/evidence work (`src/safety/passive-request-guard.ts:543-549`). The HTTP/WebSocket pending-callback regressions prove close remains unsettled until late protocol failure and evidence are finalized, then converges to the invalidated outcome with one raw close and a stable final ledger (`tests/integration/passive-request-guard.test.ts:2458-2501`). The cap/cutoff regressions prove exactly 256 protocol invocations, no 257th operation or server connection, one limit event, one raw close, and no post-terminal evidence mutation (`tests/integration/passive-request-guard.test.ts:2503-2544`).

## Binding lifecycle and recovery regression review

- **Invalidation priority and exactly-one raw close remain intact.** Invalidation synchronously promotes a normal closing phase and joins the already-published completion (`src/safety/passive-request-guard.ts:444-451`). Normal close publishes that completion before raw close, drains under the shared owner, detects promotion at the terminal boundary, and reports invalidation precedence (`src/safety/passive-request-guard.ts:819-870`). No second phase or status authority was introduced.
- **Terminal-only owner release remains intact.** Session and factory ownership flags are updated only from `isPassiveRequestGuardClosed()` (`src/browser/context-factory.ts:127-135`, `:176-182`). Failed raw close retains an invalidating phase, the same joinable completion, and fail-closed listener enforcement; listeners detach only after successful raw close (`src/safety/passive-request-guard.ts:458-479`, `:819-870`).
- **Order convergence and finalization remain intact.** The interaction auditor still preserves completed work, closes the session, snapshots final safety evidence afterward, and applies close/freeze precedence in its single final result (`src/interaction/isolated-auditor.ts:363-390`). The isolated-interaction source and regression test are byte-identical to the supplied Round 5 manifest substitution, so the prior real-path order-convergence and invariant-only invalidation coverage was not weakened.
- **Bounds and cleanup remain intact.** Guard tasks share the 256-entry bound; listener groups, expected CDP failures, redirect predecessors, correlation values, and ledger evidence retain their explicit caps and exact-inverse cleanup (`src/safety/passive-request-guard.ts:167-332`, `:343-413`, `:506-535`, `:872-1146`). Successful close detaches listener groups; failed close leaves them active for fail-closed enforcement.
- **Handle/result and S03-S08 contracts remain intact.** The retained non-null Handle still has one `try/finally` disposal owner (`src/interaction/isolated-auditor.ts:228-336`), and final result construction remains after close/final-ledger capture (`src/interaction/isolated-auditor.ts:363-390`). The route implementation still classifies before allowing delivery and fail-closes mutation/navigation/WebSocket paths (`src/safety/passive-request-guard.ts:1331-1479`); the unchanged isolated-interaction regression continues to cover S03-S08 server-side zero delivery.

## Modified terminal test expectation

The change from one abort to zero protocol calls after `CLOSED` is correct and strengthens the terminal admission contract. The test still proves that a callback admitted during invalidation is handled under freeze and publishes its one blocked-interaction event (`tests/integration/passive-request-guard.test.ts:718-730`). Only after the owned download task drains and the Guard reaches terminal state does it invoke the saved callback; zero aborts and an unchanged ledger then prove that terminal admission performs no asynchronous protocol/evidence work (`tests/integration/passive-request-guard.test.ts:731-745`). Continuing to expect an abort after this cutoff would contradict the new atomic terminal boundary and could permit evidence after the final snapshot.

## Test-strength review

- The seven new cases exercise real factory/Guard control flow and restrict injected gates/failures to Browser/Playwright boundaries. The package records genuine RED 7/7 against unchanged production and GREEN 7/7 after the correction.
- Construction coverage spans both failure points, both terminal/non-terminal release behavior, cause preservation, canonical rejoin, forbidden reuse, ledger reachability, and raw-close cardinality.
- Event coverage observes Node's `unhandledRejection` boundary while independently asserting the unchanged public owner rejection and non-terminal state.
- Protocol coverage checks both HTTP and WebSocket for in-flight drain ownership, late failure evidence, shared invalidation, cap overflow, terminal cutoff, no server connection, final-ledger stability, and one raw close. The pending-callback tests would deadlock/time out if a task awaited its own drain.
- The supplied broader evidence (focus 12/12, Guard/factory/auditor 177/177, Task 11 226/226, adjacent 47/47, full repository 441/441, typecheck and build PASS) is consistent with the inspected paths but was not used in place of source/test tracing.

## Minor findings

1. **Historical/deferred:** lifecycle-phase HTTP abort correlation still relies on a coarse `expectedRouteFailures` WeakSet. The closing/invalidating branch aborts without adding the Request (`src/safety/passive-request-guard.ts:1410-1417`), while `requestfailed` consumes only previously inserted identities (`src/safety/passive-request-guard.ts:1270-1273`), leaving the previously documented teardown edge susceptible to a spurious failure classification.
2. **Historical/deferred:** `emitFailedMainFrameRequest()` still returns `void` and discards the asynchronous event-handler result (`tests/integration/passive-request-guard.test.ts:317-330`), requiring timing/polling in related tests.
3. **Historical/deferred:** the Page-readiness tracked-task callback remains materially mis-indented (`src/safety/passive-request-guard.ts:925-931`), obscuring its actual ownership scope.
4. **Historical/deferred authority drift:** the approved recovery implementation plan still uses `undefined` as an error-presence sentinel and illustrates close-failure precedence ahead of freeze evidence (`doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md:286-300`, `:1099-1132`). Production and tests implement the corrected semantics.
5. **Historical/deferred:** interaction-owner error normalization still performs `String(error)` before applying its 512-character slice (`src/interaction/isolated-auditor.ts:50-60`). A huge bigint or expensive successful coercion can allocate unbounded intermediate text.
6. **New, test-strength only:** the construction regression imports `ContextConstructionError` only as a type and checks its `name`/shape rather than `instanceof` the exported runtime class (`tests/component/context-factory.test.ts:3`, `:147-165`). Production does instantiate the class (`src/browser/context-factory.ts:93-95`, `:113-115`), so the required surface is implemented, but a future lookalike error could pass this behavioral test while weakening the documented runtime catch discriminator.

New Minor: 1. Historical/deferred Minor: 5. Out-of-scope observation: 0. The previously discussed alternative candidate-selection/ancestor-traversal architecture remains future design work, not a finding in this checkpoint.

## Verification and constraints

No test suite was rerun. Inspection resolved the review questions, and the package already provides fresh focused, Task 11, full-suite, typecheck, and build evidence; duplicating broad suites was prohibited. No Git operation, dependency/package mutation, download/import, live-target access, source/test mutation, or delegation was performed. The only write is this requested review artifact.

Review Sweep Completed.
