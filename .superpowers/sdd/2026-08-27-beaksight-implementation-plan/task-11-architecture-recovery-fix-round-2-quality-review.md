# Task 11 Architecture Recovery Fix Round 2 Code-quality Re-review

## Verdict

`NEEDS FIXES` — Critical: 0; Important: 2; Minor: 3.

Fix-round review-package SHA-256 `F97B44BD15C43423268941E10338FABB500691568CC9C4BF29E786FC68139051` matched before reading. The original fixed package SHA `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`, round-1 package SHA `EF2BD29AAA782A81A2E7E0006358E6F1EA181C30C327E85127C3A526C83B8FE4`, and both entering-review hashes matched. The original 48-entry manifest matched before and after testing with exactly the five authorized substitutions and all other 43 entries unchanged.

## Important findings

1. **Factory invalidation ownership can still be discarded before the session close joins.** `BrowserContextFactory.closePassiveContext()` now correctly allows an owned invalidating Context to reach `closePassiveGuardedContext()`, but `#requireActiveGuardedContext()` still deletes that same factory ownership whenever another guarded operation observes the invalidating phase (`src/browser/context-factory.ts:168-175`). For an `InteractionGuardedSession`, an invalidation racing the normal `activateInteractionFreeze()` call can therefore make activation reject and remove `#activeContexts`; the following `session.close()` sets its local `closed` flag and then fails `#requireActiveContext()` at lines 153-165 without awaiting the published invalidation completion. `auditInteraction()` can again take its final snapshot before raw close, stable drain, and late evidence complete. The new integration test calls `session.close()` immediately after publishing invalidation, so it never exercises this intervening active-operation rejection. **Required correction:** separate ordinary-operation eligibility from factory close ownership, or otherwise retain a closable owner until the published invalidation is joined. Add a real factory/session regression that publishes a gated invalidation, has an active-only session operation observe/reject it, then proves `session.close()` still waits through the evidence cutoff and one raw close.

2. **Successful invalidation join has timing-dependent public outcome and can lose safety precedence.** `closePassiveGuardedContext()` returns success when called while invalidation is in progress and that completion reaches `CLOSED` (`src/safety/passive-request-guard.ts:760-774`), but the same call made after that same invalidation already reached `CLOSED` falls through to `requireActiveGuardState()` and rejects. Thus one stable successful invalidation produces success or failure solely according to observer timing. On the in-progress-success branch, `InteractionGuardedSession.close()` resolves; `auditInteraction()` then has `closeFailed === false`, and `finalizeInteractionOutcome()` only checks freeze-event collections before preserving the work outcome (`src/interaction/isolated-auditor.ts:113-136`). An invariant-only safety invalidation such as unexpected CDP detachment can therefore preserve even a clean/verified work outcome when joined in progress, while the already-completed race becomes `BLOCKED_BY_SAFETY`. The new factory test includes a blocked Download, does not call `auditInteraction()`, and explicitly expects the success branch, so it cannot detect this status race. **Required correction:** after awaiting a pre-existing invalidation owner, expose one deterministic safety-invalidated outcome for both in-progress and already-completed observers (for example, reject after the stable evidence cutoff, or return an explicit invalidation result consumed by the finalizer). Add an end-to-end audit regression using invariant-only invalidation and assert stable `BLOCKED_BY_SAFETY`, preserved evidence, final ledger cutoff, and raw-close-once behavior in both timing orders.

## Fix-round correction adjudication

- The real factory/session direct-close path now reaches and waits on an already-published low-level invalidation when ownership has not first been removed. The two Important races above prevent this correction from being complete across the public lifecycle.
- Overflow invalidation now observes only the `.finally()`-derived reserved-slot promise while preserving the shared rejecting `invalidationCompletion`; no unhandled-rejection path remains in the corrected combination.
- Page-readiness admission denial releases the three installed Page inverses synchronously before overflow invalidation's raw-close side effect.
- `abortUnreadyNavigation()` now tracks failure presence separately from its value and rethrows `undefined` after invalidation.
- BigInt guard errors now take the fixed bounded fallback without decimal conversion.
- Earlier drain-timeout, raw-close-once, stable task drain, listener bound/removal/continuation, partial CDP setup, hostile proxy normalization, registry/task bounds, Handle ownership, result evidence preservation, Safety Ledger immutability/bounds, and package/config contracts remain clean in the inspected paths.

## Minors

1. **Historical/deferred:** lifecycle-phase HTTP abort correlation still uses the carried `expectedRouteFailures` disposition.
2. **Historical/deferred:** `emitFailedMainFrameRequest()` still drops the asynchronous failed-request handler return.
3. **Historical/deferred:** the page-readiness task-factory block retains its pre-existing indentation/maintainability issue.

The round-1 `undefined` abort sentinel and BigInt materialization Minors are closed. No newly introduced Minor was found.

Per controller ruling, replacement of the approved `querySelectorAll()`/bounded indexed NodeList selection or addition of a new ancestor-traversal architecture is a **future design candidate**, not a current Critical, Important, or Minor checkpoint finding.

## Verification and environment

Reviewer-run commands:

- Fix Round 2 two-file correction focus: 2/2 files, 5/5 tests passed, 104 skipped.
- Unscoped full repository suite: 26/26 files, 426/426 tests passed.
- `npm run typecheck`: PASS (`tsc -p tsconfig.json --noEmit`).
- Forbidden production-boundary scan: expected `rg` exit 1 with no matches.
- Production type-escape scan for `any`, `@ts-ignore`, `@ts-expect-error`, and `eslint-disable`: expected `rg` exit 1 with no matches.
- Post-test substituted manifest: 48/48 matched; five substitutions used; 43 original entries unchanged.

The installed Chromium required the approved execution boundary and then ran successfully. No unresolved environment gap exists. Build was not rerun by this read-only reviewer because it writes generated artifacts; the package records implementer and controller build PASS. No Git command, dependency/package mutation, download, live-target access, or delegation occurred. The only file written was this controller-requested review artifact.

Review Sweep Completed.
