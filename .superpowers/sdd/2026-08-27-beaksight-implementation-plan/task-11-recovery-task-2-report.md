# Task 11 Recovery — Task 2 Report

## Implementation

- Replaced promise-after-creation tracking with module-private `trackGuardTask()` factory admission at the fixed per-Context limit of 256. The four production call sites are CDP page readiness, paused Document handling, frozen popup close, and frozen download cancellation. Denied factories never begin; the 257th admission records one `GUARD_TASK_LIMIT_REACHED` and starts the existing Task 1 `invalidateContext()` owner through the reserved `overflowInvalidation` retention slot.
- Retained Task 1 `invalidationCompletion`. Overflow delegates to its synchronous owner-publication path before `context.close()` can begin; there is no second Context close path. Existing drain-after-close-success-or-failure and success-only `CLOSED` transitions remain unchanged.
- Added module-private bounded `ExpectedCdpFailureRegistry` (64 entries/Page, 1,000 ms, exact one-time consume/delete/clear, one identity and one limit report/Page) and `RedirectPredecessorRegistry` (64/session, 1,000 ms, request-id 256, exact take/delete/clear).
- Raw method and URL bounds are checked before any uppercase normalization. Overlong CDP identities fail the paused request and invalidate; identity values are not truncated into correlation aliases. Request-failure handling now consumes through the bounded registry and reports an overlong main-frame delivery as an invariant rather than letting policy classification hide it.
- CDP session close clears both session redirect state and Page expected-failure state. No public API or production-only inspection export was added.

## Test-first RED

Command (first sandboxed attempt was inconclusive because existing local Chromium spawn returned `EPERM`; approved retry used the same command and local Chromium):

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "task admission exceeds|expected CDP failure correlations|purges expired|redirect predecessors|overlong method and URL"
```

Genuine RED: exit 1; 4 failed, 1 passed, 72 skipped. The failures proved the 257th download factory started, expected failures and redirect predecessors were unbounded, and overlong correlation input was not rejected. `purges expired and consumed expected CDP failure correlations` passed unexpectedly because the old request-failure callback already filtered expiry and spliced its raw array; it was not counted as RED and remains a regression test for the registry's exact consume/expiry behavior. The five tests respectively catch removal/bypass of the 256 factory admission, 64 expected-failure limit, expiry/exact consume/delete, 64 redirect limit/exact predecessor take, and raw-length rejection before normalization.

## GREEN and required verification

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "task admission exceeds|expected CDP failure correlations|purges expired|redirect predecessors|overlong method and URL"
```

Exit 0: 5 passed, 72 skipped.

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "records frozen HTTP activity before a failed abort|records frozen CDP activity before a failed Fetch.failRequest|does not reactivate after installation activity|keeps frozen invalidation enforcement|drains late evidence after failed frozen safety-invalidation close|does not complete page-close-triggered invalidation|shares one failed safety-invalidation owner|publishes a re-entrant invalidation waiter|frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Exit 0: 12 passed, 65 skipped.

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Exit 0: 4 files, 115 passed. An earlier run had 115 passing assertions but two unhandled deferred-readiness rejections; attaching a non-observing handler at public readiness-promise creation made the required rerun clean.

```powershell
npm run typecheck
```

Exit 0 with no TypeScript diagnostics.

## Files and hashes

```text
1B364A7C29B53F227E23228734D315657D4A6A0B5D94A94A5BA6C06DA48FF001  src/safety/passive-request-guard.ts
79F193D97440BC292E4A61494B77129501CCA7C8FC8CF8FE9FEE086B0AC998B6  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

## Call-site, bounds, and correlation self-review

- `rg` confirms all former `trackTask` uses were replaced by four `trackGuardTask` factory calls; no `trackTask` remains. Factories are invoked only after set admission and are never awaited by their own callback/drain path.
- Task admission uses a reserved overflow promise only as retention; Task 1's `invalidationCompletion` remains the sole published close owner. Admission does not pre-set an invalidating phase.
- Expected failures retain at most 64 live entries per Page; redirects retain at most 64 live entries per CDP session. Both purge only after 1,000 ms, delete a consumed item before return, and clear session/page state on detachment. Method, URL, and request-id raw bounds are 32, 2,048, and 256 respectively.
- The 65th expected-failure path and redirect path issue `Fetch.failRequest` and invalidate instead of retaining unbounded state. Exact method (uppercase only after length validation), URL, and error text are required for consumption.

## Carry-forward minors and concerns

- Lifecycle-phase HTTP abort correlation can be treated as `HTTP_MAIN_FRAME_DELIVERY_FAILED`: remains deferred; this Task 2 registry work did not naturally change the `expectedRouteFailures` lifecycle ownership boundary.
- `emitFailedMainFrameRequest()` discards its async handler result: remains deferred; the added tests use it only where its synchronous ledger effect is intentionally asserted, and fixing the helper is outside Task 2 scope.
- No Git, progress-ledger, dependency, package, live-target, policy/route-authority, DOM/selector, or public-API change was made. Fresh independent review remains required before Task 3.

## Fix round 1

### Review findings corrected

- Tracked paused-Document callbacks now initiate the Task 1-published invalidation owner through `initiateInvalidation()` and never await its completion. The helper contains unexpected owner errors in the ledger; the completion remains state-owned by `GuardState.invalidationCompletion`. The page-readiness, popup-close, download-cancel, lifecycle fail-request, and CDP-detachment tracked-adjacent initiation sites use the same helper where they do not own an awaited public boundary.
- Redirect lookup is now a bounded discriminated result. A supplied `redirectedRequestId` is length-checked before Map access and yields `FOUND`, `MISSING`, or `INVALID`; only `undefined` means no redirect. Missing, expired, consumed, and invalid supplied predecessor IDs fail that exact current CDP request and initiate invalidation. A missing supplied predecessor records `REDIRECT_PREDECESSOR_MISSING`; an overlong identifier retains the single `CDP_CORRELATION_IDENTITY_REJECTED` report.
- The fake CDP harness now preserves existing command-name logs and also records `{ method, params }`. Tests assert exact `Fetch.failRequest` and `Fetch.continueRequest` request IDs, one close, bounded state, and absence of `GUARD_PENDING_TASK_DRAIN_TIMEOUT` after advancing the 1,000 ms deadline.

### Test-first RED

New focused command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "self-draining|exact redirect predecessor|supplied redirect predecessor|65th exact"
```

Initial genuine RED: exit 1; 4 failed, 1 passed, 77 skipped. Overlong identity and expected-failure cap both recorded the deterministic self-drain timeout; exact predecessor reuse did not invalidate; supplied missing/overlong/expired IDs did not fail the current request. The initial 65th-current test passed unexpectedly because it observed close initiation but did not advance the drain deadline. It was tightened before the production correction to advance 1,001 ms and reject the timeout.

Mutation proof for that tightened assertion (temporarily restored the overlong-path `await invalidateContext()` and immediately restored the implementation):

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "self-draining an overlong"
```

Genuine RED: exit 1; 1 failed, 81 skipped, with `GUARD_PENDING_TASK_DRAIN_TIMEOUT` present. This proves the deadline assertion detects the self-await cycle rather than hidden latency.

### GREEN and required verification

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "self-draining|exact redirect predecessor|supplied redirect predecessor|65th exact"
```

Exit 0: 5 passed, 77 skipped.

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "task admission exceeds|expected CDP failure correlations|purges expired|redirect predecessors|overlong method and URL"
```

Exit 0: 5 passed, 77 skipped.

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "records frozen HTTP activity before a failed abort|records frozen CDP activity before a failed Fetch.failRequest|does not reactivate after installation activity|keeps frozen invalidation enforcement|drains late evidence after failed frozen safety-invalidation close|does not complete page-close-triggered invalidation|shares one failed safety-invalidation owner|publishes a re-entrant invalidation waiter|frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Exit 0: 12 passed, 70 skipped.

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Exit 0: 4 files, 120 passed.

```powershell
npm run typecheck
```

Exit 0 with no TypeScript diagnostics.

### Final hashes and audit

```text
D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB  src/safety/passive-request-guard.ts
6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

The call-site audit finds every invalidating branch in the tracked CDP handler now calls `initiateInvalidation()` rather than awaiting `invalidateContext()`. The helper starts/reuses the already-published owner and catches only unexpected owner errors; it neither creates a second close path nor detaches an unowned rejection. Exact log assertions cover `overlong-current`, `expected-cap-current`, `reused-current`, missing/overlong/expired current IDs, and `overflow-current`; the successful `redirect-current` receives `Fetch.continueRequest` and no failure. The touched CDP handler was also formatted for readability; the review indentation Minor and both carry-forward Minors remain non-blocking and unchanged.
