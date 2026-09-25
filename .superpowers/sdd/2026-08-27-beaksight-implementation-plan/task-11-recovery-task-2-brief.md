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

