# BeakSight Task 11 Architecture Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the Task 11 mandatory checkpoint by replacing scattered lifecycle, bounds, handle-ownership, and cleanup-error conditions with one fail-closed guarded phase machine and bounded owners.

**Architecture:** Keep the existing Task 5 request guard and Task 11 interaction auditor as the only production entry points. Internally, use one discriminated guard phase, bounded task/correlation owners, total-node browser traversal limits, one ElementHandle lifetime scope, and one outcome finalizer that preserves evidence across cleanup failures.

**Tech Stack:** Node.js 24.x, TypeScript 7.0.2 strict ESM, Playwright Library 1.62.1, Vitest 4.1.10. Use only the existing locked dependencies and Chromium.

**Spec:** `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md`

## Global Constraints

- Git operations are prohibited. Do not run `git`, create a worktree, commit, stage, stash, reset, or touch `.git-sandbox-backup`.
- Do not install, download, import, update, or replace a dependency. `package.json` and `package-lock.json` must retain their current SHA-256 values.
- Do not access the live target. Use only local fixtures and the existing locked Chromium.
- Preserve the public production entry points `discoverInteractionCandidates(page)`, `classifyInteractionCandidate(candidate)`, and `auditInteraction(input)`.
- Preserve `src/safety/request-policy.ts` as the only passive HTTP policy and `src/safety/interaction-policy.ts` as the only interaction admission policy.
- Add no route authority, request classifier, DOM marker, site-specific selector, target identity, string-evaluated browser program, or private Playwright API.
- Every production correction starts with a genuine failing test and ends with fresh focused verification.
- A browser command that fails only with `spawn EPERM` may be rerun with standard sandbox escalation using the already-installed Chromium; it must not trigger a download.
- Each task ends with a SHA-256 checkpoint instead of a Git commit and must receive a fresh independent specification review before the next task.
- Task 11 is complete only after a final independent code-quality review reports 0 Critical and 0 Important.

## File responsibility map

- Modify `src/safety/passive-request-guard.ts`: the sole guarded Context phase machine, async-task owner, CDP failure correlation, redirect predecessor correlation, freeze-time request/popup/download/navigation/WebSocket recording, and owner close/drain order.
- Modify `src/interaction/discover-candidates.ts`: bounded candidate enumeration and bounded total-node/text collection in both browser-evaluation paths.
- Modify `src/interaction/isolated-auditor.ts`: exact ElementHandle lifetime owner and final work/freeze/owner-close outcome adjudication.
- Modify `tests/integration/passive-request-guard.test.ts`: fake-harness and real-Chromium lifecycle, overflow, correlation, and server-boundary proofs.
- Modify `tests/integration/isolated-interaction.test.ts`: hostile traversal, Handle disposal/deadline, work plus close failure, and final evidence proofs.
- Modify `fixtures/site/hostile-candidates.html`: deterministic large non-text descendant fixture followed by bounded text.
- Do not modify `src/safety/safety-ledger.ts`, `src/safety/request-policy.ts`, `src/safety/interaction-policy.ts`, or `src/browser/context-factory.ts`; existing APIs are sufficient. Stop for redesign if a public consumer change becomes necessary.

---

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

### Task 2: Bound guard-owned tasks and request-correlation registries

**Files:**
- Modify: `src/safety/passive-request-guard.ts:17-158,423-623,680-728`
- Test: `tests/integration/passive-request-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 `GuardState.phase`, `isFrozenPhase()`, and `invalidatingPhase()`.
- Produces: module-private `trackGuardTask()`, `ExpectedCdpFailureRegistry`, and `RedirectPredecessorRegistry`; no new export.
- Fixed limits: 256 active tasks per Context, 64 expected failures per Page, 64 redirect predecessors per CDP session, 1,000 ms retention, 32-character method identity, 2,048-character URL identity.

- [ ] **Step 1: Add failing overflow, expiry, consume, and no-start tests**

Add tests using the fake guard harness:

```ts
it('fails closed once when guard-owned task admission exceeds 256', async () => {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  const gates = Array.from({ length: 257 }, () => createDeferred<void>());
  let cancelCalls = 0;
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = createHarnessPage(harness, {
    url: 'https://example.test/fixture',
    onEvent: (event, handler) => eventHandlers.set(event, handler),
  });
  await awaitPassiveRequestGuardReady(page);
  await activateInteractionFreeze(page);

  for (let index = 0; index < gates.length; index += 1) {
    eventHandlers.get('download')?.({
      url: () => `data:text/plain,${index}`,
      suggestedFilename: () => `${index}.txt`,
      cancel: () => {
        cancelCalls += 1;
        return gates[index]!.promise;
      },
    } as unknown as Download);
  }
  await expect.poll(() => cancelCalls).toBe(256);
  expect(ledger.snapshot().invariantViolations.filter(
    (event) => event.code === 'GUARD_TASK_LIMIT_REACHED',
  )).toHaveLength(1);
  expect(harness.closeCount).toBe(1);
  for (const gate of gates.slice(0, 256)) gate.resolve(undefined);
});

it('bounds expected CDP failure correlations and fails the overflow request closed', async () => {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = await readyHarnessPage(harness);
  Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
  await activateInteractionFreeze(page);

  for (let index = 0; index < 65; index += 1) {
    harness.cdpRequestPausedHandler?.({
      requestId: `frozen-${index}`,
      frameId: 'root-frame',
      request: { method: 'GET', url: `https://example.test/frozen-${index}` },
    });
    await expect.poll(
      () => harness.cdpCommands.filter((command) => command === 'Fetch.failRequest').length,
    ).toBe(index + 1);
  }
  expect(ledger.snapshot().invariantViolations.filter(
    (event) => event.code === 'EXPECTED_CDP_FAILURE_LIMIT_REACHED',
  )).toHaveLength(1);
  emitFailedMainFrameRequest(harness, page, {
    method: 'GET',
    url: 'https://example.test/unrelated',
    errorText: 'net::ERR_FAILED',
  });
  expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
  ]));
});

it('purges expired and consumed expected CDP failure correlations', async () => {
  vi.useFakeTimers();
  try {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
    const page = await readyHarnessPage(harness);
    Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
    await activateInteractionFreeze(page);
    harness.cdpRequestPausedHandler?.({
      requestId: 'expires',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/expires' },
    });
    await vi.advanceTimersByTimeAsync(1_001);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET', url: 'https://example.test/expires', errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
    ]));

    harness.cdpRequestPausedHandler?.({
      requestId: 'consumed-once',
      frameId: 'root-frame',
      request: { method: 'GET', url: 'https://example.test/consumed-once' },
    });
    await Promise.resolve();
    const before = ledger.snapshot().invariantViolations.length;
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET', url: 'https://example.test/consumed-once', errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations).toHaveLength(before);
    emitFailedMainFrameRequest(harness, page, {
      method: 'GET', url: 'https://example.test/consumed-once', errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    expect(ledger.snapshot().invariantViolations.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds redirect predecessors and consumes the exact predecessor once', async () => {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  await readyHarnessPage(harness);
  for (let index = 0; index < 64; index += 1) {
    harness.cdpRequestPausedHandler?.({
      requestId: `document-${index}`,
      frameId: 'root-frame',
      request: { method: 'GET', url: `https://example.test/document-${index}` },
    });
    await Promise.resolve();
  }
  harness.cdpRequestPausedHandler?.({
    requestId: 'redirect-current',
    redirectedRequestId: 'document-0',
    frameId: 'root-frame',
    request: { method: 'GET', url: 'https://example.test/redirect-current' },
  });
  await Promise.resolve();
  harness.cdpRequestPausedHandler?.({
    requestId: 'overflow-current',
    frameId: 'root-frame',
    request: { method: 'GET', url: 'https://example.test/overflow-current' },
  });
  await expect.poll(() => ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'REDIRECT_PREDECESSOR_LIMIT_REACHED' }),
  ]));
  expect(ledger.snapshot().invariantViolations.filter(
    (event) => event.code === 'REDIRECT_PREDECESSOR_LIMIT_REACHED',
  )).toHaveLength(1);
});

it('rejects overlong method and URL correlation identities without truncation alias', async () => {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = await readyHarnessPage(harness);
  Object.defineProperty(page, 'url', { value: () => 'https://example.test/fixture' });
  await activateInteractionFreeze(page);
  const prefix = `https://example.test/${'a'.repeat(2_100)}`;
  harness.cdpRequestPausedHandler?.({
    requestId: 'overlong-a', frameId: 'root-frame', request: { method: 'G'.repeat(33), url: `${prefix}A` },
  });
  await Promise.resolve();
  emitFailedMainFrameRequest(harness, page, {
    method: 'G'.repeat(33), url: `${prefix}B`, errorText: 'net::ERR_BLOCKED_BY_CLIENT',
  });
  expect(ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'CDP_CORRELATION_IDENTITY_REJECTED' }),
    expect.objectContaining({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED' }),
  ]));
});
```

- [ ] **Step 2: Run the five tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "task admission exceeds|expected CDP failure correlations|purges expired|redirect predecessors|overlong method and URL"
```

Expected: failures show more than 256 task factories start, raw arrays/Maps accept more than 64 entries, expired entries remain until unrelated failure, or overlong values can be retained.

- [ ] **Step 3: Replace Promise-after-creation tracking with factory admission**

Use this module-private contract:

```ts
const MAX_PENDING_GUARD_TASKS = 256;

function trackGuardTask(
  guardState: GuardState,
  purpose: string,
  rejectionCode: string,
  factory: () => Promise<unknown>,
): boolean {
  if (guardState.pendingTasks.size >= MAX_PENDING_GUARD_TASKS) {
    if (!guardState.taskLimitReported) {
      guardState.taskLimitReported = true;
      guardState.ledger.recordInvariantViolation({
        code: 'GUARD_TASK_LIMIT_REACHED',
        message: purpose,
      });
    }
    beginOverflowInvalidationOnce(guardState);
    return false;
  }
  let owned!: Promise<void>;
  owned = Promise.resolve().then(factory).then(
    () => undefined,
    (error: unknown) => guardState.ledger.recordInvariantViolation({
      code: rejectionCode,
      message: errorMessage(error),
    }),
  ).finally(() => guardState.pendingTasks.delete(owned));
  guardState.pendingTasks.add(owned);
  return true;
}
```

`beginOverflowInvalidationOnce()` uses one reserved Promise slot and does not start a second Context close when phase is already closing/invalidating. Convert every current `guardState.trackTask(existingPromise, code)` call into a factory.

Use this exact reserved-slot shape in `GuardState` and its helper:

```ts
interface GuardState {
  phase: GuardPhase;
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly pageGuards: WeakMap<Page, PageGuardRecord>;
  readonly pendingTasks: Set<Promise<void>>;
  readonly listenerCleanups: Array<() => void>;
  overflowInvalidation: Promise<void> | undefined;
  taskLimitReported: boolean;
  ensurePageGuard(page: Page): PageGuardRecord;
}

function beginOverflowInvalidationOnce(guardState: GuardState): void {
  if (guardState.overflowInvalidation !== undefined || isClosingOrInvalidatingPhase(guardState.phase)) {
    return;
  }
  guardState.phase = invalidatingPhase(guardState.phase);
  guardState.overflowInvalidation = closeInvalidatedContext(guardState).finally(() => {
    guardState.overflowInvalidation = undefined;
  });
}

async function closeInvalidatedContext(guardState: GuardState): Promise<void> {
  let closeSucceeded = false;
  try {
    await guardState.context.close();
    closeSucceeded = true;
  } catch (error) {
    guardState.ledger.recordInvariantViolation({
      code: 'GUARD_CONTEXT_INVALIDATION_FAILED',
      message: errorMessage(error),
    });
  } finally {
    await drainGuardTasks(guardState);
  }
  if (closeSucceeded) guardState.phase = 'CLOSED';
}
```

This reserved close path records rejection and leaves `*_INVALIDATING`; it transitions to `CLOSED` only when close and drain both complete successfully. Task 5 adds successful-close listener detachment before the terminal phase.

- [ ] **Step 4: Implement the bounded expected-failure registry**

Add the request type and a module-private class with these exact methods and algorithm:

```ts
interface CorrelationRequest {
  readonly method: string;
  readonly url: string;
}

class ExpectedCdpFailureRegistry {
  readonly #entries = new WeakMap<Page, ExpectedCdpFailure[]>();
  readonly #identityReported = new WeakSet<Page>();
  readonly #limitReported = new WeakSet<Page>();
  readonly #ledger: SafetyLedger;

  constructor(ledger: SafetyLedger) {
    this.#ledger = ledger;
  }

  register(page: Page, request: CorrelationRequest, now: number): ExpectedCdpFailure | null {
    if (request.method.length > 32 || request.url.length > 2_048) {
      if (!this.#identityReported.has(page)) {
        this.#identityReported.add(page);
        this.#ledger.recordInvariantViolation({
          code: 'CDP_CORRELATION_IDENTITY_REJECTED',
          message: 'Expected CDP failure identity exceeded its bound',
        });
      }
      return null;
    }
    const live = (this.#entries.get(page) ?? []).filter((entry) => entry.expiresAt >= now);
    if (live.length >= 64) {
      if (!this.#limitReported.has(page)) {
        this.#limitReported.add(page);
        this.#ledger.recordInvariantViolation({
          code: 'EXPECTED_CDP_FAILURE_LIMIT_REACHED',
          message: 'Expected CDP failure correlation limit reached',
        });
      }
      this.#entries.set(page, live);
      return null;
    }
    const expected = {
      method: request.method.slice(0, 32).toUpperCase(),
      url: request.url,
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      expiresAt: now + 1_000,
    } satisfies ExpectedCdpFailure;
    live.push(expected);
    this.#entries.set(page, live);
    return expected;
  }

  remove(page: Page, expected: ExpectedCdpFailure): void {
    const remaining = (this.#entries.get(page) ?? []).filter((entry) => entry !== expected);
    if (remaining.length === 0) this.#entries.delete(page);
    else this.#entries.set(page, remaining);
  }

  consume(
    page: Page,
    request: CorrelationRequest & { readonly errorText: string },
    now: number,
  ): boolean {
    if (request.method.length > 32 || request.url.length > 2_048) return false;
    const method = request.method.slice(0, 32).toUpperCase();
    const live = (this.#entries.get(page) ?? []).filter((entry) => entry.expiresAt >= now);
    const index = live.findIndex((entry) => entry.method === method
      && entry.url === request.url
      && entry.errorText === request.errorText);
    if (index < 0) {
      if (live.length === 0) this.#entries.delete(page);
      else this.#entries.set(page, live);
      return false;
    }
    live.splice(index, 1);
    if (live.length === 0) this.#entries.delete(page);
    else this.#entries.set(page, live);
    return true;
  }

  clear(page: Page): void {
    this.#entries.delete(page);
    this.#identityReported.delete(page);
    this.#limitReported.delete(page);
  }
}
```

`register()` purges expired entries, rejects method length >32 or URL length >2,048 without truncating identity, and returns `null` on the 65th live entry after recording `EXPECTED_CDP_FAILURE_LIMIT_REACHED`. `consume()` requires exact uppercase method, URL, and error text, removes exactly one live match, and removes an empty Page array from the WeakMap.

Before the CDP handler constructs `interceptedRequest`, validate raw protocol strings without first uppercasing them:

```ts
function boundedCorrelationRequest(method: string, url: string): CorrelationRequest | null {
  if (method.length > 32 || url.length > 2_048) return null;
  return { method: method.slice(0, 32).toUpperCase(), url };
}
```

If this returns `null`, record `CDP_CORRELATION_IDENTITY_REJECTED` once through the owning registry, issue `Fetch.failRequest(BlockedByClient)`, and invalidate the Context. Do not call `event.request.method.toUpperCase()` before this gate.

- [ ] **Step 5: Implement the bounded redirect predecessor registry**

Inside each CDP page guard, replace the raw Map with this session-local owner:

```ts
interface RedirectPredecessor {
  readonly request: CorrelationRequest;
  readonly expiresAt: number;
}

class RedirectPredecessorRegistry {
  readonly #entries = new Map<string, RedirectPredecessor>();
  readonly #ledger: SafetyLedger;
  #identityReported = false;
  #limitReported = false;

  constructor(ledger: SafetyLedger) {
    this.#ledger = ledger;
  }

  remember(requestId: string, request: CorrelationRequest, now: number): boolean {
    this.#purge(now);
    if (requestId.length > 256 || request.method.length > 32 || request.url.length > 2_048) {
      if (!this.#identityReported) {
        this.#identityReported = true;
        this.#ledger.recordInvariantViolation({
          code: 'CDP_CORRELATION_IDENTITY_REJECTED',
          message: 'Redirect predecessor identity exceeded its bound',
        });
      }
      return false;
    }
    if (this.#entries.size >= 64) {
      if (!this.#limitReported) {
        this.#limitReported = true;
        this.#ledger.recordInvariantViolation({
          code: 'REDIRECT_PREDECESSOR_LIMIT_REACHED',
          message: 'Redirect predecessor correlation limit reached',
        });
      }
      return false;
    }
    this.#entries.set(requestId, {
      request: { method: request.method.slice(0, 32).toUpperCase(), url: request.url },
      expiresAt: now + 1_000,
    });
    return true;
  }

  take(requestId: string, now: number): CorrelationRequest | undefined {
    this.#purge(now);
    const entry = this.#entries.get(requestId);
    this.#entries.delete(requestId);
    return entry?.request;
  }

  clear(): void {
    this.#entries.clear();
    this.#identityReported = false;
    this.#limitReported = false;
  }

  #purge(now: number): void {
    for (const [requestId, entry] of this.#entries) {
      if (entry.expiresAt < now) this.#entries.delete(requestId);
    }
  }
}
```

`remember()` purges expired entries, records each identity/limit invariant at most once, and returns false at 64 live entries or for an overlong identity. The caller fails the current paused Document and invalidates the Context without recording a duplicate invariant. `take()` deletes before returning so a predecessor is consumed once. Clear the registry when its CDP session closes or guarded Context teardown removes listeners.

- [ ] **Step 6: Run focused registry tests and all Task 5 tests**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "task admission exceeds|expected CDP failure correlations|purges expired|redirect predecessors|overlong method and URL"
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
npm run typecheck
```

Expected: all selected tests PASS, correlation mismatch tests remain PASS, typecheck exit 0.

- [ ] **Step 7: Record the no-Git checkpoint and request fresh specification review**

Record SHA-256 for the two changed files plus RED/GREEN commands in the SDD progress ledger. A fresh reviewer must inspect overflow fail-closed behavior, exact consume/delete, expiry, no truncation alias, and no untracked Promise before Task 3.

---

### Task 3: Bound total browser traversal work in both candidate paths

**Files:**
- Modify: `src/interaction/discover-candidates.ts:177-312,327-483`
- Modify: `fixtures/site/hostile-candidates.html`
- Test: `tests/integration/isolated-interaction.test.ts:84-231`

**Interfaces:**
- Consumes: unchanged `INTERACTION_CANDIDATE_LIMITS.maxTextNodes === 512` as the total visited-node budget and `maxTextLength * 4 === 1_024` as the character budget.
- Produces: unchanged `discoverInteractionCandidates(page)` and `inspectInteractionCandidateHandle(handle, ordinalHint)`.

- [ ] **Step 1: Change the hostile fixture to place text after 100,000 non-text descendants**

Replace the fixture script with deterministic fragment construction:

```html
<script>
  const label = document.getElementById('hostile-label');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 100000; index += 1) {
    fragment.append(document.createElement('span'));
  }
  fragment.append(document.createTextNode('must-not-require-unbounded-traversal'));
  label.append(fragment);
</script>
```

- [ ] **Step 2: Add failing total-node tests for discovery and retained inspection**

Add `INTERACTION_CANDIDATE_LIMITS` to the existing interaction-policy import. In both browser paths, instrument `document.createTreeWalker` so any `whatToShow !== NodeFilter.SHOW_ALL` throws `all-node traversal is required`, and its returned `nextNode()` throws after 512 calls. This makes the current `SHOW_TEXT` implementation genuinely RED and makes the call bound meaningful after `SHOW_ALL` returns every descendant. Keep existing assertions that `textContent`, `nodeValue`, and NodeList iteration throw if used.

```ts
async function installTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) throw new Error('all-node traversal is required');
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') return Reflect.get(target, property, target);
            return () => {
              nextNodeCalls += 1;
              if (nextNodeCalls > maxNodes) throw new Error('total node traversal exceeded its bound');
              return target.nextNode();
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightTraversalCount', {
      configurable: true,
      get: () => nextNodeCalls,
    });
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightTraversalCount: number }
  ).__beakSightTraversalCount);
}

const readNextNodeCalls = await installTraversalProbe(page);
const candidates = await discoverInteractionCandidates(page);
const nextNodeCalls = await readNextNodeCalls();
expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
expect(candidates).toHaveLength(1);
```

The retained path must obtain the first candidate handle, reset the counter, call `inspectInteractionCandidateHandle(handle, 0)`, and assert the same limit.

- [ ] **Step 3: Run both tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "total descendant nodes during discovery|total descendant nodes during retained inspection"
```

Expected: current `SHOW_TEXT` implementation performs native traversal across the non-text descendants and cannot prove the all-node bound; the instrumentation/fixture assertion fails.

- [ ] **Step 4: Replace text-only walking in both serialized callbacks**

Use the same self-contained implementation in discovery and retained inspection:

```ts
const boundedDescendantText = (roots: readonly Element[], maxCharacters: number): string => {
  let result = '';
  let visitedNodes = 0;
  for (const root of roots) {
    if (result.length >= maxCharacters || visitedNodes >= limits.maxTextNodes) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    while (result.length < maxCharacters && visitedNodes < limits.maxTextNodes) {
      const node = walker.nextNode();
      if (node === null) break;
      visitedNodes += 1;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const textNode = node as Text;
      const remaining = maxCharacters - result.length;
      result += textNode.substringData(0, Math.min(textNode.length, remaining));
    }
    if (result.length > 0 && result.length < maxCharacters) result += ' ';
  }
  return result.slice(0, maxCharacters);
};
```

Do not extract this into a page-visible global or string source. Keep both callbacks self-contained and identical, with shared numeric limits from `INTERACTION_CANDIDATE_LIMITS`.

- [ ] **Step 5: Run all candidate discovery/interaction tests and typecheck**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts
npm test -- --run tests/unit/interaction-policy.test.ts
npm run typecheck
```

Expected: hostile total-node tests and all prior NodeList/text/identity tests PASS.

- [ ] **Step 6: Record the no-Git checkpoint and request fresh specification review**

Record hashes for `discover-candidates.ts`, `hostile-candidates.html`, and `isolated-interaction.test.ts`. The reviewer must inspect both serialized callbacks and confirm that each `nextNode()` return increments the shared all-node budget before Task 4.

---

### Task 4: Give ElementHandle and audit finalization one owner each

**Files:**
- Modify: `src/interaction/isolated-auditor.ts:137-375`
- Test: `tests/integration/isolated-interaction.test.ts:536-1218`

**Interfaces:**
- Consumes: unchanged `InteractionAuditSession`, `InteractionAuditInput`, `InteractionWorkOutcome`, `SafetyLedger`, and Task 1 final guard snapshot behavior.
- Produces: unchanged `auditInteraction(input): Promise<InteractionAuditResult>`; once a session exists it returns a result even when owner close rejects. Session-factory failure still rejects.

- [ ] **Step 1: Add the handle-acquisition deadline plus dispose-failure RED**

Extend the existing ElementHandle acquisition deadline test so `elementHandle()` advances the fake clock to the deadline and returns a handle whose `dispose()` throws.

```ts
expect(result.status).toBe('NOT_VERIFIABLE');
expect(result.reason).toBe('Interaction deadline expired during target handle acquisition');
expect(result.evidence.after).toBeNull();
expect(result.safety.invariantViolations).toContainEqual({
  code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
  message: 'deadline handle dispose failed',
});
```

- [ ] **Step 2: Replace the old AggregateError expectation with work-outcome plus close-failure RED**

Change `preserves both work and owner-close failures` to require a returned safety result. Add a second case where click mutates evidence, throws an ordinary Error, and `session.close()` rejects.

```ts
expect(result.status).toBe('BLOCKED_BY_SAFETY');
expect(result.reason).toContain('EXECUTION_FAILED');
expect(result.reason).toContain('original click failure');
expect(result.evidence.changedFields).toContain('ariaExpanded');
expect(result.safety.invariantViolations).toContainEqual({
  code: 'INTERACTION_OWNER_CLOSE_FAILED',
  message: 'fixture close failed',
});
```

For an unexpected `goto()` throw plus close rejection, assert both messages are observable through final reason and Safety Ledger.

- [ ] **Step 3: Run the new tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "deadline handle dispose failed|work and owner-close failures|click failure and owner close"
```

Expected: current pre-`try` dispose rejection overwrites NOT_VERIFIABLE, and current close branch rejects/discards the encoded work outcome.

- [ ] **Step 4: Move every non-null Handle path under one finalizer**

After `elementHandle()` returns, check only `null` outside the owner scope. Put the deadline check and every later return inside:

```ts
if (targetHandle === null) {
  return outcome('NOT_VERIFIABLE', 'Candidate target handle was not resolved', emptyEvidence(before));
}
try {
  if (remaining() === 0) {
    return outcome(
      'NOT_VERIFIABLE',
      'Interaction deadline expired during target handle acquisition',
      emptyEvidence(before),
    );
  }
  const resolvedSnapshot = await inspectInteractionCandidateHandle(targetHandle, before.ordinal);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target fact collection', emptyEvidence(before));
  }
  if (!resolvedSnapshot.connected) {
    return outcome('NOT_VERIFIABLE', 'Candidate target disconnected before admission', emptyEvidence(before));
  }
  const resolvedCandidate = resolvedSnapshot.candidate;
  if (resolvedCandidate.candidateId !== before.candidateId) {
    return outcome('NOT_VERIFIABLE', 'Candidate target changed during exact-node resolution', emptyEvidence(before));
  }
  const exactAdmission = classifyInteractionCandidate(resolvedCandidate);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during exact-node admission', emptyEvidence(before));
  }
  if (exactAdmission.action === 'REJECT') {
    if (['EXTERNAL_ACTION', 'NAVIGATION_HREF', 'DOWNLOAD'].includes(exactAdmission.reason)) {
      session.ledger.recordBlockedExternalAction({
        candidateId: resolvedCandidate.candidateId,
        url: resolvedCandidate.href,
        reason: exactAdmission.reason,
      });
    }
    return outcome('REJECTED_UNSAFE', exactAdmission.reason, matchedPreInteractionEvidence(resolvedCandidate));
  }

  const clickBudgetMs = remaining();
  if (clickBudgetMs === 0 || Date.now() >= effectiveDeadlineAtMs) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before exact-node click', emptyEvidence(resolvedCandidate));
  }
  let clickFailed = false;
  let clickError: unknown;
  try {
    await targetHandle.click({ timeout: clickBudgetMs });
  } catch (error) {
    clickFailed = true;
    clickError = error;
  }

  let lastEvidence = emptyEvidence(resolvedCandidate);
  while (true) {
    let identityLossReason: string | undefined;
    let observationDeadlineExpired = false;
    const safety = session.ledger.snapshot();
    if (hasFreezeEvent(safety)) {
      return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
    }
    if (clickFailed && remaining() === 0) {
      return clickFailureOutcome(clickError, lastEvidence);
    }
    if (remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before post-condition observation', lastEvidence);
    }
    try {
      const retainedSnapshot = await inspectInteractionCandidateHandle(targetHandle, resolvedCandidate.ordinal);
      observationDeadlineExpired = remaining() === 0;
      if (retainedSnapshot.connected) {
        lastEvidence = collectInteractionChangeEvidence(resolvedCandidate, retainedSnapshot.candidate);
      } else if (!observationDeadlineExpired) {
        const liveCandidates = await discoverInteractionCandidates(session.page);
        observationDeadlineExpired = remaining() === 0;
        lastEvidence = collectDisconnectedInteractionEvidence(resolvedCandidate, liveCandidates);
        identityLossReason = `Retained candidate identity became ${lastEvidence.identityStatus}`;
      }
    } catch (error) {
      if (hasFreezeEvent(session.ledger.snapshot())) {
        return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
      }
      throw error;
    }
    const afterObservationSafety = session.ledger.snapshot();
    if (hasFreezeEvent(afterObservationSafety)) {
      return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
    }
    if (clickFailed) return clickFailureOutcome(clickError, lastEvidence);
    if (identityLossReason !== undefined) return outcome('NOT_VERIFIABLE', identityLossReason, lastEvidence);
    if (observationDeadlineExpired || remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during post-condition observation', lastEvidence);
    }
    if (lastEvidence.identityStatus === 'MATCHED' && lastEvidence.changedFields.length > 0) {
      return outcome('VERIFIED', 'Observable interaction state changed', lastEvidence);
    }
    if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
      return outcome('NOT_VERIFIABLE', 'No observable change before interaction deadline', lastEvidence);
    }
  }
} finally {
  try {
    await targetHandle.dispose();
  } catch (error) {
    session.ledger.recordInvariantViolation({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: errorMessage(error),
    });
  }
}
```

Delete the old pre-`try` `remaining() === 0` branch and its optional dispose. This scope must be the only owner of the non-null Handle.

- [ ] **Step 5: Collapse audit work and close errors into one result finalizer**

Make `workOutcome` always exist before owner close:

```ts
let workOutcome: InteractionWorkOutcome;
try {
  workOutcome = await executeInteraction(session, input, candidate, effectiveDeadlineAtMs);
} catch (error) {
  workOutcome = outcome('EXECUTION_FAILED', errorMessage(error), emptyEvidence(candidate));
}

let closeError: unknown;
try {
  await session.close();
} catch (error) {
  closeError = error;
  session.ledger.recordInvariantViolation({
    code: 'INTERACTION_OWNER_CLOSE_FAILED',
    message: errorMessage(error),
  });
}

const finalSafety = session.ledger.snapshot();
const finalOutcome = finalizeInteractionOutcome(workOutcome, closeError, finalSafety);
```

The pure finalizer is:

```ts
function finalizeInteractionOutcome(
  work: InteractionWorkOutcome,
  closeError: unknown,
  safety: SafetyLedgerSnapshot,
): InteractionWorkOutcome {
  if (closeError !== undefined) {
    return outcome(
      'BLOCKED_BY_SAFETY',
      `Interaction owner close failed after ${work.status}: ${work.reason}`,
      work.evidence,
    );
  }
  if (hasFreezeEvent(safety)) {
    return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', work.evidence);
  }
  return work;
}
```

Do not catch `input.sessionFactory()` failure because no session/evidence owner exists yet.

- [ ] **Step 6: Run all isolated interaction tests, focused Task 11, and typecheck**

Run:

```powershell
npm test -- --run tests/unit/interaction-policy.test.ts tests/integration/isolated-interaction.test.ts
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts
npm run typecheck
```

Expected: all selected tests PASS; original click/timeout/freeze evidence precedence remains intact.

- [ ] **Step 7: Record the no-Git checkpoint and request fresh specification review**

Record hashes for `isolated-auditor.ts` and `isolated-interaction.test.ts`, plus RED/GREEN outputs. The reviewer must explicitly adjudicate pre-deadline disposal, encoded work plus close failure, session-factory rejection, immutable evidence, and final freeze precedence.

---

### Task 5: Integrate lifecycle listener teardown, run full verification, and close the mandatory checkpoint

**Files:**
- Modify: `src/safety/passive-request-guard.ts`
- Test: `tests/integration/passive-request-guard.test.ts`
- Test: `tests/integration/isolated-interaction.test.ts`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-report.md`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- Create: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-review-package.md`

**Interfaces:**
- Consumes: Tasks 1-4 production behavior and all prior Task 5/6/11 contracts.
- Produces: a fixed SHA-256 review manifest and Task 11 mandatory-checkpoint evidence. No new runtime API.

- [ ] **Step 1: Add failing exactly-once listener teardown test**

Extend `GuardHarness` with `readonly removedListeners: readonly string[]`. In `createGuardHarness()`, keep the current active handler variables and add exact inverse removal:

```ts
const removedListeners: string[] = [];

// Add this method inside the existing rawContext object literal.
off(event: string, handler: (value: unknown) => void): void {
  removedListeners.push(`CONTEXT:${event}`);
  if (event === 'page' && pageHandler === handler) pageHandler = undefined;
  if (event === 'requestfailed' && requestFailedHandler === handler) requestFailedHandler = undefined;
},

// Add this method inside the existing fake session object literal.
off(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
  removedListeners.push(`CDP:${event}`);
  if (event === 'Fetch.requestPaused' && cdpRequestPausedHandler === handler) cdpRequestPausedHandler = undefined;
  if (event === 'close' && cdpCloseHandler === handler) cdpCloseHandler = undefined;
},
```

Expose `removedListeners` from the harness. Extend `createHarnessPage()` with `onOffEvent?: (event: string, handler: (...arguments_: unknown[]) => void) => void` and call it from a general Page `off()` branch before the existing `close`-handler branch. Add this test:

```ts
it('detaches every owned listener exactly once before successful Context close returns', async () => {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  const pageRemoved: string[] = [];
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));
  const page = createHarnessPage(harness, {
    onOffEvent: (event) => pageRemoved.push(event),
  });
  await awaitPassiveRequestGuardReady(page);
  await closePassiveGuardedContext(harness.context);
  const snapshotAtClose = ledger.snapshot();

  expect(harness.removedListeners).toEqual(expect.arrayContaining([
    'CONTEXT:page',
    'CONTEXT:requestfailed',
    'CDP:Fetch.requestPaused',
    'CDP:close',
  ]));
  expect(pageRemoved).toEqual(expect.arrayContaining(['download', 'popup', 'framenavigated']));
  expect(new Set(harness.removedListeners).size).toBe(harness.removedListeners.length);
  expect(new Set(pageRemoved).size).toBe(pageRemoved.length);
  expect(harness.pageHandler).toBeUndefined();
  expect(harness.requestFailedHandler).toBeUndefined();
  expect(harness.cdpRequestPausedHandler).toBeUndefined();
  expect(harness.cdpCloseHandler).toBeUndefined();
  await Promise.resolve();
  expect(ledger.snapshot()).toEqual(snapshotAtClose);
});
```

Expected before production correction: FAIL because current anonymous listeners are never detached.

- [ ] **Step 2: Store and detach owned listener cleanup callbacks**

Add `readonly listenerCleanups: Array<() => void>` to `GuardState`. Register named handlers and immediately push exact inverse operations:

```ts
context.on('page', onPage);
guardState.listenerCleanups.push(() => context.off('page', onPage));
context.on('requestfailed', onRequestFailed);
guardState.listenerCleanups.push(() => context.off('requestfailed', onRequestFailed));
session.on('Fetch.requestPaused', onRequestPaused);
guardState.listenerCleanups.push(() => session.off('Fetch.requestPaused', onRequestPaused));
session.on('close', onSessionClose);
guardState.listenerCleanups.push(() => session.off('close', onSessionClose));
```

After successful `context.close()` and before the final task-set emptiness check, run each cleanup exactly once, catch/ledger `GUARD_LISTENER_CLEANUP_FAILED`, clear the array, then complete stable drain and transition to `CLOSED`. If close rejects, keep fail-closed listeners installed and leave phase `*_INVALIDATING`; the final audit result is already `BLOCKED_BY_SAFETY`.

Use this cleanup function:

```ts
function detachGuardListeners(guardState: GuardState): void {
  const cleanups = guardState.listenerCleanups.splice(0);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      guardState.ledger.recordInvariantViolation({
        code: 'GUARD_LISTENER_CLEANUP_FAILED',
        message: errorMessage(error),
      });
    }
  }
}
```

- [ ] **Step 3: Run the complete focused and adjacent suites**

Run:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts
npm test -- --run tests/integration/controlled-scroll.test.ts tests/component/performance-collector.test.ts
npm run typecheck
npm run build
```

Expected: all files and tests PASS; typecheck/build exit 0.

- [ ] **Step 4: Run the full repository suite twice if a worker exits**

Run:

```powershell
npm test
```

If and only if Vitest reports a worker-process exit with no individual test failure, rerun the identical command once and record both outputs. Any actual test failure is a failure, not an environment gap.

- [ ] **Step 5: Run forbidden-boundary and package-drift checks**

Run:

```powershell
rg -n "example|www\.example\.com|evaluate\(\s*['\"]|innerHTML\s*=|setAttribute\(" src
Get-FileHash package.json,package-lock.json -Algorithm SHA256
```

Expected: no target identity/string-evaluation/DOM-marker mutation in `src/**`; package hashes remain:

```text
package.json       75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233
package-lock.json  A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A
```

- [ ] **Step 6: Create the fixed review package**

Create a manifest containing every Task 11/Task 5 production file, changed test/fixture, relevant Task 5/6 authority file, package files, approved design, and this plan. Generate each SHA-256 with `Get-FileHash`; do not copy stale hashes. The package must require reviewers to verify every entry before reading and prohibit edits, Git, dependency operations, live target access, and subagents.

- [ ] **Step 7: Run fresh independent specification and quality reviews**

Specification review must adjudicate all five final entering findings, the approved design completion criteria, S03-S08, Task 5 policy ownership, exact Handle identity, deadline authority, immutable evidence, and no second entry point. Code-quality review must independently inspect lifecycle races, bounded registries/tasks, listener cleanup, all-node traversal, status/error precedence, tests, and maintainability.

PASS requires:

```text
manifest hashes: all match
Critical: 0
Important: 0
focused/adjacent/typecheck/build/full: PASS
```

- [ ] **Step 8: Update Task 11 report/progress and mandatory checkpoint**

Record every command, test count, exit code, hash manifest, reviewer verdict, and any environment-only rerun. Mark Task 11 complete only when both independent reviews PASS. Then update the root plan to begin Task 12; otherwise stop and report the exact unresolved finding without starting Task 12.

---

## Author self-review

### Spec coverage

| Approved design requirement | Plan evidence |
| --- | --- |
| Single discriminated guarded phase and frozen-close precedence | Task 1 Steps 1-6 |
| All freeze activity classes and passive teardown separation | Task 1 Steps 1, 4, 6 |
| Bounded task admission before Promise creation | Task 2 Steps 1-3 |
| Bounded/expiring/exact expected-failure registry | Task 2 Steps 1, 4, 6 |
| Bounded/consuming redirect predecessor registry | Task 2 Steps 1, 5, 6 |
| No overlong correlation alias or full uppercase before validation | Task 2 Steps 1, 4-5 |
| Total visited-node and character limits in both browser paths | Task 3 Steps 1-5 |
| One non-null ElementHandle owner scope | Task 4 Steps 1, 3-4 |
| One work/freeze/close finalizer preserving reason/evidence | Task 4 Steps 2-6 |
| Listener teardown before successful terminal phase | Task 5 Steps 1-2 |
| S03-S08, full regressions, hashes, forbidden scans, independent reviews | Task 5 Steps 3-8 |

### Placeholder and type audit

- No `TBD`, `TODO`, deferred implementation instruction, undefined production interface, or “handle edge cases” placeholder remains.
- `GuardPhase`, `GuardState`, `CorrelationRequest`, `ExpectedCdpFailureRegistry`, `RedirectPredecessorRegistry`, `InteractionWorkOutcome`, and `SafetyLedgerSnapshot` names are consistent across producer and consumer steps.
- Every test-only helper introduced by a snippet is defined before use in the plan.
- No task requires a dependency, public consumer change, Git operation, live target, private Playwright API, or second semantic owner.
