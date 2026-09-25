# Task 11 Recovery — Task 1 Report

## Implemented behavior

- Replaced Context lifecycle/mode split authority with `GuardState.phase`: `INSTALLING`, passive/frozen active, closing, invalidating, and closed phases.
- Registered the single guard state synchronously before installation awaits. Removed `installationStates`, `invalidatingContexts`, and `ownerClosingContexts`.
- Applied phase-snapshot precedence to HTTP, paused CDP Documents, popups, downloads, frame navigations, and WebSockets. Frozen closing/invalidating records actual frozen activity; passive closing/invalidating fails closed without inventing interaction events.
- Context owner close now transitions to its corresponding closing phase, drains tracked tasks, preserves frozen authority during the drain, changes to matching invalidating phase on close failure, and becomes `CLOSED` only after a successful close.
- Preserved public API compatibility for uninstalled/invalidated guards while keeping `requireGuardState()` as the internal phase gate.

## TDD and RED evidence

Production mutation identified before adding tests: giving close/invalidation precedence over freeze causes a real late frozen HTTP/CDP activity to be aborted as generic lifecycle teardown, producing no interaction ledger evidence. The popup/download/frame/WebSocket test catches the same mutation in all remaining event paths; the passive-close test prevents the opposite misclassification.

Command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

First sandboxed attempt could not start the already-installed Chromium: `browserType.launch: spawn EPERM`. The normal approved retry executed the tests and genuinely failed 2 cases:

```text
tests/integration/passive-request-guard.test.ts (64 tests | 2 failed | 60 skipped)
× records a frozen HTTP navigation observed while owner context close is pending
  expected [] to have a length of 1 but got +0
× records a frozen CDP Document observed while owner context close is pending
  expected [] to have a length of 1 but got +0
Tests 2 failed | 2 passed | 60 skipped (64)
```

This is the expected pre-correction gap: the former Context close marked lifecycle invalid before the frozen-mode handler, so the events were aborted but not recorded as interaction activity. The passive owner-close characterization and the aggregate frozen event test passed in RED.

## Verification

Focused GREEN command (rerun after final compatibility corrections):

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Result: exit 0; `1 passed`, `4 passed | 60 skipped (64)`.

Adjacent Task 5 regression command:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Result: exit 0; `3 passed`, `94 passed (94)`.

Typecheck command:

```powershell
npm run typecheck
```

Result: exit 0; `tsc -p tsconfig.json --noEmit` produced no diagnostics.

## Files changed and SHA-256

Before hashes for the two edited files were not captured before the TDD edit. Current hashes:

```text
8A0F29FA8ED39A21C7514D38957502B0BFF481FB1D32FD151564EE18815C7D11  src/safety/passive-request-guard.ts
07BFB22681157C811FD925231507FF7C5DD431483470260369AC4615068A9424  tests/integration/passive-request-guard.test.ts
```

Changed files:

- `src/safety/passive-request-guard.ts`
- `tests/integration/passive-request-guard.test.ts`
- This report

Package hashes match the Task 10 baseline and were not changed:

```text
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

## Self-review and concerns

Reviewed transition legality, frozen event precedence, Context close failure/rethrow behavior, listener-task draining, Page-only close correlation, error paths, and public API compatibility. `GuardState.phase` is the sole Context lifecycle/mode authority; no new production inspection export, route authority, policy duplication, dependency change, live-target access, Git operation, or progress-ledger edit was made.

Concern: the first focused run required normal execution approval solely because sandboxed Chromium spawn returned `EPERM`; the approved retry used the existing local browser and completed normally. Fresh independent specification/quality review remains required before Recovery Task 2.

## Fix round 1

### Findings corrected

- Installation now changes to `PASSIVE_ACTIVE` only when its phase remains `INSTALLING`; installation activity that invalidated the Context cannot reactivate it.
- Successful safety invalidation now defers owned-task draining until the initiating callback can settle, then transitions `PASSIVE_INVALIDATING` or `FROZEN_INVALIDATING` to `CLOSED`. A close failure remains invalidating and is ledgered.
- Frozen HTTP and CDP Document handlers ledger the observed interaction request/navigation before attempting `route.abort()` or `Fetch.failRequest`, preserving evidence if enforcement rejects.

### Test-first mutations and RED

Mutations named before the tests: moving frozen ledger writes after enforcement loses evidence on enforcement rejection; unconditional installation success reactivates an invalidated owner; omitting invalidation drain leaves frozen enforcement active indefinitely rather than becoming terminal.

Command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "records frozen HTTP activity before a failed abort|records frozen CDP activity before a failed Fetch.failRequest|does not reactivate after installation activity|keeps frozen invalidation enforcement"
```

Genuine RED result (exit 1): `4 failed | 64 skipped (68)`. HTTP and CDP each reported `expected [] to have a length of 1 but got +0`; installation reactivation reported that the active-guard assertion did not throw; terminal invalidation reported two frozen interaction requests instead of one.

### GREEN and regression verification

The same focused command passed: exit 0; `4 passed | 64 skipped (68)`.

Original Task 1 focused command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Result: exit 0; `4 passed | 64 skipped (68)`.

Adjacent command:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Result: exit 0; `3 passed`, `98 passed (98)`.

`npm run typecheck` exited 0 with no diagnostics.

### Hashes and self-review

Before/after known hashes:

```text
8A0F29FA8ED39A21C7514D38957502B0BFF481FB1D32FD151564EE18815C7D11 -> BC2E710E9BE8CB6EACD1D2FB98107C749DF7CEA0F51CA2E31A4518F153E0A673  src/safety/passive-request-guard.ts
07BFB22681157C811FD925231507FF7C5DD431483470260369AC4615068A9424 -> 348952BDDBCE2840CFA807D91648C1F922615EEBC53A1A95EFD723771EE2F059  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

Self-review: checked the phase guards at installation completion, invalidation close success/failure, deferred drain, terminal transition, and both record-first frozen paths. The correction adds no public inspection API, policy owner, dependency, live-target access, Git operation, or Task 2/Task 5 implementation. Fresh independent review is still required before Task 2.

## Fix round 2

### Finding corrected

Successful invalidation is now owned by `GuardState.invalidationCompletion`. The exactly-once promise performs Context close, stable task drain, and then the legal matching `*_INVALIDATING -> CLOSED` transition. Repeated invalidations return that same promise without another close. Close failure is ledgered and leaves the matching invalidating phase; no terminal transition is made.

The call-site audit separates initiators from awaiters: CDP/page/download/requestfailed callbacks that are themselves tracked only initiate the owned completion (`void invalidateContext(...)`); route, WebSocket, page-close, activation, and installation owners await completion where their public operation must not return early. This prevents a tracked callback from awaiting a drain that includes itself, without detached completion work or unhandled rejection.

### Test-first RED and GREEN

Mutations named before tests: returning after Context close without awaiting the owned drain lets page-close safety cleanup finish while a download cancellation remains pending; a duplicate invalidation can start a second close; transitioning to `CLOSED` after failed Context close loses frozen enforcement.

RED command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "does not complete page-close-triggered invalidation|shares one failed safety-invalidation owner"
```

Genuine RED result (exit 1): `1 failed | 1 passed | 68 skipped (70)`. The page-close test reported `expected true to be false`: the public close operation had already settled before the held download task drained. (The initial test form also surfaced the expected early page-close rejection as an unhandled test rejection; the assertion was immediately made observing-only before production correction.)

The same focused GREEN command passed: exit 0; `2 passed | 68 skipped (70)`.

Prior Fix round 1 focused command passed: `4 passed | 66 skipped (70)`.

Original Task 1 focused command passed: `4 passed | 66 skipped (70)`.

Adjacent command:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Result: exit 0; `3 passed`, `100 passed (100)`.

`npm run typecheck` exited 0 with no diagnostics.

### Hashes and self-review

```text
BC2E710E9BE8CB6EACD1D2FB98107C749DF7CEA0F51CA2E31A4518F153E0A673 -> 1A6CC927E5A1FE7EE3C4DC433375CCFEDF17AE734C4ACC39FA62385B0A1DCA07  src/safety/passive-request-guard.ts
348952BDDBCE2840CFA807D91648C1F922615EEBC53A1A95EFD723771EE2F059 -> 443B10D53FE678DC9D0A98DA318BE6FD115CAA6D95FA953E7384F369E125BAF8  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

Self-review: verified the completion promise is stored before returning, repeated invalidations reuse it, tracked callbacks no longer await their own drain, external public owners still await completion, close failure remains nonterminal, and no Task 2 capacity or Task 5 listener-teardown behavior was added. Fresh independent review remains required before Task 2.

## Fix round 3

### Finding corrected

`invalidateContext()` now creates a deferred start gate, creates the stable completion promise that awaits that gate, stores that exact promise on `GuardState.invalidationCompletion`, and only then releases the gate that permits `context.close()`. Therefore no external side effect can run before the completion identity is published. Every later `*_INVALIDATING` re-entry returns that exact stored promise; the former resolved fallback was removed.

The explicit guarded-context close failure path also now publishes a stored invalidation completion before switching to its matching invalidating phase, resolves it after the already-required task drain, and rethrows the close failure. This handles the other legal producer of an invalidating phase without a second Context close or a false `CLOSED` transition.

### Test-first RED and GREEN

The initial route-based re-entry test was discarded because its abort rejection crossed an `await`, allowing owner publication before re-entry; it was not a valid race test. The replacement synchronously invokes the captured `requestfailed` listener from fake `context.close()`, captures its returned lifecycle promise as a second waiter, holds both the close gate and a tracked download cancellation, and asserts exactly one close.

RED command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "publishes a re-entrant invalidation waiter"
```

Genuine RED result (exit 1): `1 failed | 70 skipped (71)` with `expected true to be false`; the re-entrant requestfailed waiter had settled before the initial close gate. This deterministically demonstrated the unpublished-owner race.

The same command passed after correction: exit 0; `1 passed | 70 skipped (71)`. A targeted owner-close failure regression (`publishes ...|ledgers lifecycle failRequest uncertainty`) also passed: `2 passed | 69 skipped (71)`.

All Task 1 focused tests were then run together: `11 passed | 60 skipped (71)`. The adjacent command passed: `3 passed`, `101 passed (101)`. `npm run typecheck` exited 0 with no diagnostics.

### Call-site audit, hashes, and self-review

- Tracked CDP/page/download callbacks remain initiation-only and do not await their own drain.
- `requestfailed` is an untracked async lifecycle boundary and awaits the stored invalidation completion, making synchronous re-entry observable and shared.
- Route, WebSocket, page-close, activation, and installation owners retain their awaited completion behavior.
- No `void` async completion/drain remains; the completion promise is stored before close, consumed by all re-entry, and has no unhandled rejection path.

```text
1A6CC927E5A1FE7EE3C4DC433375CCFEDF17AE734C4ACC39FA62385B0A1DCA07 -> 15AB3E727B752EBDF9F6F2E018A308F8841F841560B37524BA3EEC59EEE2F9BF  src/safety/passive-request-guard.ts
443B10D53FE678DC9D0A98DA318BE6FD115CAA6D95FA953E7384F369E125BAF8 -> 1C479F389F3ECB5C3CB6C0D3DD32E4107EA3CA40E9CED0916D6F0662392B5DD4  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

Self-review: verified completion publication occurs before the first re-entrant `context.close()` side effect, invalidating re-entry never receives a synthetic resolved promise, repeated paths share one close owner, explicit close failure remains invalidating, and Task 2 capacity/Task 5 listener teardown remain untouched. Fresh independent review remains required before Task 2.

## Fix round 4

### Findings corrected

- Installation now rejects whenever installation-time activity changes the final phase away from `INSTALLING`. It awaits the already-published invalidation owner before rejecting, so `ContextFactory.createPassiveContext()` cannot register a closed or invalidating Context as active.
- Safety invalidation now performs the bounded stable `pendingTasks` drain after either Context-close success or failure. Only successful close transitions the matching invalidating phase to `CLOSED`; failed close remains in `PASSIVE_INVALIDATING` or `FROZEN_INVALIDATING` with its late ledger evidence included in the completion cutoff.

### Test-first mutations and RED

Mutations named before the tests: omitting the non-`INSTALLING` rejection lets installation fulfill after invalidation and creates false consumer success; nesting `drainGuardTasks()` under close success lets public cleanup settle before a held guard-owned task records late evidence after failed invalidation close.

Focused command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "does not reactivate after installation activity|drains late evidence after failed frozen safety-invalidation close"
```

The first sandboxed invocation was inconclusive because existing Chromium spawn returned `EPERM` (`72 skipped`); the approved retry used the same command and existing local Chromium. Genuine RED result: exit 1; `2 failed | 70 skipped (72)`. The installation case received `{ status: 'FULFILLED' }` instead of `REJECTED`; the failed-close drain case reported `expected true to be false` because the public close operation had already settled.

### GREEN and regression verification

The same focused command passed after the production correction: exit 0; `2 passed | 70 skipped (72)`.

All prior 11 Task 1 focused tests:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "records frozen HTTP activity before a failed abort|records frozen CDP activity before a failed Fetch.failRequest|does not reactivate after installation activity|keeps frozen invalidation enforcement|does not complete page-close-triggered invalidation|shares one failed safety-invalidation owner|publishes a re-entrant invalidation waiter|frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Result: exit 0; `11 passed | 61 skipped (72)`.

Adjacent suite:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
```

Result: exit 0; `3 passed`, `102 passed (102)`.

```powershell
npm run typecheck
```

Result: exit 0 with no TypeScript diagnostics.

### Files, hashes, self-review, and concerns

Modified only `src/safety/passive-request-guard.ts`, `tests/integration/passive-request-guard.test.ts`, and this report.

```text
15AB3E727B752EBDF9F6F2E018A308F8841F841560B37524BA3EEC59EEE2F9BF -> 898D0D371C384D7CFA417570D84FA7DC5CAAB8A0005894B5611107CFB01CE3FD  src/safety/passive-request-guard.ts
1C479F389F3ECB5C3CB6C0D3DD32E4107EA3CA40E9CED0916D6F0662392B5DD4 -> 7CD8FF1B90E9608D68EB97D006DE3B8C063A67FDE5C3F292B30F10FDED2117B6  tests/integration/passive-request-guard.test.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json (unchanged)
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json (unchanged)
```

Self-review covered every invalidation initiator/awaiter, the published exactly-once completion gate, the successful/failed close branches, the installation exits, phase writes, frozen enforcement after failed close, record-first behavior, and the unchanged `context-factory.ts` consumer. Tracked CDP/page/download callbacks remain initiation-only; route, WebSocket, page-close, activation, request-failure, and installation owners retain awaited completion where required. No completion rejection or unhandled-rejection path was introduced, and there was no policy duplication, public inspection API, listener teardown, Task 2 work, dependency change, live-target access, or Git operation.

Concerns: the two review-ledgered Minor findings remain intentionally unchanged for final triage. The first focused attempt required an approved retry solely because sandboxed Chromium spawn returned `EPERM`; all conclusive runs used the existing installed browser and passed. Fresh independent review is still required before Recovery Task 2.
