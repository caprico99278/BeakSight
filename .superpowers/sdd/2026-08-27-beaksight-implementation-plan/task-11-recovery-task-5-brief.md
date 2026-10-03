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
rg -n "本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*['\"]|innerHTML\s*=|setAttribute\(" src
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

