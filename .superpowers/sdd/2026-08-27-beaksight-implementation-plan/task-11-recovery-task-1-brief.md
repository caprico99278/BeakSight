### Task 1: Replace split lifecycle/mode flags with one guarded phase machine

**Files:**
- Modify: `src/safety/passive-request-guard.ts:12-52,254-420,449-818`
- Test: `tests/integration/passive-request-guard.test.ts`
- Test: `tests/integration/isolated-interaction.test.ts`

**Interfaces:**
- Consumes: existing `SafetyLedger.recordBlockedInteractionRequest()`, `recordBlockedInteractionNavigation()`, `recordBlockedPopup()`, `recordBlockedDownload()`, and `recordBlockedInteractionWebSocket()`.
- Produces: unchanged public functions `installPassiveRequestGuard()`, `activateInteractionFreeze()`, `closePassiveGuardedPage()`, `closePassiveGuardedContext()`, `awaitPassiveRequestGuardReady()`, and `assertPassiveRequestGuardActive()`.
- Internal contract: `GuardState.phase` is the only Context lifecycle/mode authority.

- [ ] **Step 1: Add failing frozen-close route and CDP tests**

Add this test-only helper beside `emitFailedMainFrameRequest()`:

```ts
function createHarnessRoute(
  page: Page,
  facts: { readonly method: string; readonly url: string; readonly navigation: boolean },
): { readonly route: Route; readonly abortCalls: () => number } {
  let abortCalls = 0;
  const frame = { parentFrame: () => null, page: () => page };
  const request = {
    method: () => facts.method,
    url: () => facts.url,
    isNavigationRequest: () => facts.navigation,
    frame: () => frame,
  } as unknown as Request;
  return {
    route: {
      request: () => request,
      abort: async () => { abortCalls += 1; },
      fallback: async () => undefined,
    } as unknown as Route,
    abortCalls: () => abortCalls,
  };
}
```

Then add these named tests using the existing `createGuardHarness()`, `readyHarnessPage()`, `createDeferred()`, `httpHandler`, and `cdpRequestPausedHandler`:

```ts
it('records a frozen HTTP navigation observed while owner context close is pending', async () => {
  const closeGate = createDeferred<void>();
  const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = await readyHarnessPage(harness);
  Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
  await activateInteractionFreeze(page);

  const closing = closePassiveGuardedContext(harness.context);
  await expect.poll(() => harness.closeCount).toBe(1);
  const routed = createHarnessRoute(page, {
    method: 'GET',
    url: 'https://example.test/late-navigation',
    navigation: true,
  });
  await harness.httpHandler?.(routed.route);
  closeGate.resolve(undefined);
  await closing;

  expect(routed.abortCalls()).toBe(1);
  expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
  expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
});

it('records a frozen CDP Document observed while owner context close is pending', async () => {
  const closeGate = createDeferred<void>();
  const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = await readyHarnessPage(harness);
  Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
  await activateInteractionFreeze(page);

  const closing = closePassiveGuardedContext(harness.context);
  await expect.poll(() => harness.closeCount).toBe(1);
  harness.cdpRequestPausedHandler?.({
    requestId: 'late-document',
    frameId: 'root-frame',
    request: { method: 'GET', url: 'https://example.test/late-document' },
  });
  await expect.poll(() => harness.cdpCommands.filter((value) => value === 'Fetch.failRequest').length).toBe(1);
  closeGate.resolve(undefined);
  await closing;

  expect(ledger.snapshot().blockedInteractionRequests).toHaveLength(1);
  expect(ledger.snapshot().blockedInteractionNavigations).toHaveLength(1);
});

it('does not invent an interaction event during passive owner context close', async () => {
  const closeGate = createDeferred<void>();
  const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = await readyHarnessPage(harness);
  const routed = createHarnessRoute(page, {
    method: 'GET',
    url: 'https://example.test/passive-close',
    navigation: true,
  });

  const closing = closePassiveGuardedContext(harness.context);
  await expect.poll(() => harness.closeCount).toBe(1);
  await harness.httpHandler?.(routed.route);
  closeGate.resolve(undefined);
  await closing;

  expect(routed.abortCalls()).toBe(1);
  expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
  expect(ledger.snapshot().blockedInteractionNavigations).toEqual([]);
});

it('records popup download frame and WebSocket activity while frozen owner close is pending', async () => {
  const closeGate = createDeferred<void>();
  const harness = createGuardHarness({ contextCloseGate: closeGate.promise });
  const ledger = new SafetyLedger();
  const handlers = new Map<string, (...arguments_: unknown[]) => void>();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = createHarnessPage(harness, {
    url: 'https://example.test/fixture',
    onEvent: (event, handler) => handlers.set(event, handler),
  });
  await awaitPassiveRequestGuardReady(page);
  await activateInteractionFreeze(page);
  const closing = closePassiveGuardedContext(harness.context);
  await expect.poll(() => harness.closeCount).toBe(1);

  handlers.get('download')?.({
    url: () => 'data:text/plain,late', suggestedFilename: () => 'late.txt', cancel: async () => undefined,
  } as unknown as Download);
  handlers.get('popup')?.({
    url: () => 'https://example.test/late-popup', close: async () => undefined,
  } as unknown as Page);
  handlers.get('framenavigated')?.({ url: () => 'https://example.test/late-frame' });
  await harness.webSocketHandler?.({
    url: () => 'wss://example.test/late', close: async () => undefined,
  } as unknown as WebSocketRoute);
  closeGate.resolve(undefined);
  await closing;

  const snapshot = ledger.snapshot();
  expect(snapshot.blockedDownloads).toHaveLength(1);
  expect(snapshot.blockedPopups).toHaveLength(1);
  expect(snapshot.blockedInteractionNavigations).toHaveLength(1);
  expect(snapshot.blockedInteractionWebSockets).toHaveLength(1);
});
```

Do not add a production-only inspection export.

- [ ] **Step 2: Run the three tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
```

Expected before production correction: at least the two frozen-close cases FAIL because closing/invalidation is checked before `INTERACTION_FROZEN`; the passive-close characterization must PASS or reveal a separate misclassification that is included in this task.

- [ ] **Step 3: Add the single internal phase type and transition helpers**

Replace `InstallationState`, `GuardMode`, and Context owner-closing authority with:

```ts
type GuardPhase =
  | 'INSTALLING'
  | 'PASSIVE_ACTIVE'
  | 'FROZEN_ACTIVE'
  | 'PASSIVE_CLOSING'
  | 'FROZEN_CLOSING'
  | 'PASSIVE_INVALIDATING'
  | 'FROZEN_INVALIDATING'
  | 'CLOSED';

function isFrozenPhase(phase: GuardPhase): boolean {
  return phase === 'FROZEN_ACTIVE'
    || phase === 'FROZEN_CLOSING'
    || phase === 'FROZEN_INVALIDATING';
}

function isClosingOrInvalidatingPhase(phase: GuardPhase): boolean {
  return phase === 'PASSIVE_CLOSING'
    || phase === 'FROZEN_CLOSING'
    || phase === 'PASSIVE_INVALIDATING'
    || phase === 'FROZEN_INVALIDATING'
    || phase === 'CLOSED';
}

function ownerClosingPhase(phase: GuardPhase): GuardPhase {
  if (phase === 'PASSIVE_ACTIVE') return 'PASSIVE_CLOSING';
  if (phase === 'FROZEN_ACTIVE') return 'FROZEN_CLOSING';
  throw new Error(`Guarded Context close is invalid from ${phase}`);
}

function invalidatingPhase(phase: GuardPhase): GuardPhase {
  return isFrozenPhase(phase) ? 'FROZEN_INVALIDATING' : 'PASSIVE_INVALIDATING';
}
```

Change `GuardState` to contain `phase: GuardPhase` and remove `mode`. Keep page-level close ownership only for Page-specific correlation; it must not decide Context freeze authority.

Remove `installationStates`, `invalidatingContexts`, and `ownerClosingContexts`. `guardStates` becomes the sole Context registry. `installPassiveRequestGuard()` must construct and register a `GuardState` with `phase: 'INSTALLING'` synchronously before its first `await`, so a concurrent/repeated installation observes the same owner and fails closed. Replace `requireInstalledGuardState()` with:

```ts
function requireGuardState(context: BrowserContext, allowed: readonly GuardPhase[]): GuardState {
  const state = guardStates.get(context);
  if (state === undefined || !allowed.includes(state.phase)) {
    throw new Error(`Passive request guard phase is not allowed (${state?.phase ?? 'MISSING'})`);
  }
  return state;
}
```

Initialize `pendingTasks` to an empty Set, `listenerCleanups` to an empty Array, `overflowInvalidation` to `undefined`, and `taskLimitReported` to `false` when the state is created. Installation success transitions only `INSTALLING -> PASSIVE_ACTIVE`; installation failure transitions through `PASSIVE_INVALIDATING` and cannot be reactivated.

- [ ] **Step 4: Make event precedence derive from the phase snapshot**

At the beginning of HTTP route and CDP paused handlers, read `const phase = guardState.phase` once. Apply this order:

```ts
if (isFrozenPhase(phase)) {
  // Record the observed interaction request/navigation exactly once,
  // then abort or Fetch.failRequest.
  return;
}
if (isClosingOrInvalidatingPhase(phase)) {
  // Fail closed without inventing an interaction event.
  return;
}
if (phase !== 'PASSIVE_ACTIVE') {
  // Ledger installation/lifecycle invariant and fail closed.
  return;
}
// Only here call classifyPassiveRequest().
```

Apply the same frozen-phase predicate to popup, download, `framenavigated`, and WebSocket callbacks. `activateInteractionFreeze()` changes only `PASSIVE_ACTIVE -> FROZEN_ACTIVE`.

- [ ] **Step 5: Make Context close preserve frozen authority through drain**

Implement this exact ordering in `closePassiveGuardedContext()`:

```ts
guardState.phase = ownerClosingPhase(guardState.phase);
let closeError: unknown;
try {
  await context.close();
} catch (error) {
  closeError = error;
  guardState.phase = invalidatingPhase(guardState.phase);
  guardState.ledger.recordInvariantViolation({
    code: 'GUARDED_CONTEXT_CLOSE_FAILED',
    message: errorMessage(error),
  });
} finally {
  await drainGuardTasks(guardState);
}
if (closeError !== undefined) throw closeError;
guardState.phase = 'CLOSED';
```

Do not set a generic `INVALIDATED` value before close. Update `assertPassiveRequestGuardActive()`, `awaitPassiveRequestGuardReady()`, Page close, and invalidation to accept only their explicitly legal phases.

- [ ] **Step 6: Run focused lifecycle tests and adjacent Task 5 regression**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "frozen HTTP navigation|frozen CDP Document|passive owner context close|popup download frame and WebSocket"
npm test -- --run tests/unit/request-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
npm run typecheck
```

Expected: all selected tests PASS; no direct passive request changes; typecheck exit 0.

- [ ] **Step 7: Record the no-Git checkpoint and request fresh specification review**

Run:

```powershell
Get-FileHash src/safety/passive-request-guard.ts,tests/integration/passive-request-guard.test.ts -Algorithm SHA256
```

Append hashes, RED output, GREEN output, and review result to `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`. Do not start Task 2 until a fresh independent reviewer reports 0 Critical and 0 Important for Task 1.

---

