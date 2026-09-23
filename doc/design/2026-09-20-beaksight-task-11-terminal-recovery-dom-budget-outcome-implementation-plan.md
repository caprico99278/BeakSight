# BeakSight Task 11 Terminal Recovery, DOM Budget, and Structured Outcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining Task 11 lifecycle, DOM-work, and result-structure gaps without starting Task 12.

**Architecture:** Keep `GuardPhase` as the sole Context lifecycle authority while making each physical close/drain attempt retryable and single-flight. Replace whole-DOM candidate selector enumeration with bounded incremental traversal that shares one work budget per discovery/resolution/inspection operation, then retain interaction work and Context lifecycle as separate immutable result axes.

**Tech Stack:** Node.js, TypeScript strict mode, Playwright Library, Vitest, existing fixture server and Safety Ledger.

**Spec:** `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`

## Global Constraints

- Task 11 remains unapproved until both independent reviews report Critical 0 and Important 0.
- Do not start Task 12 or later work.
- Git operations are prohibited. Replace commit/diff provenance with fresh SHA-256 baselines, append-only reports, and fixed review-package manifests.
- Do not download, install, update, or import a new dependency without prior user approval. This plan requires none.
- Do not access a live target. Use only local fixtures and the installed Playwright Chromium.
- `src/**` remains target-agnostic; no site selector, target identity, domain, URL, or page-specific workaround may be added.
- `src/safety/passive-request-guard.ts` remains the sole guarded Context lifecycle authority.
- `src/interaction/discover-candidates.ts` remains the sole dynamic candidate discovery, bounded resolution, and retained-inspection owner.
- `src/safety/interaction-policy.ts` remains the interaction admission and candidate-limit owner.
- `src/interaction/isolated-auditor.ts` remains the sole isolated interaction orchestration/final-result owner.
- Invalidation permanently outranks normal close; no retry may downgrade `*_INVALIDATING`.
- Factory/session ownership releases only when the Guard reports `CLOSED`.
- `maxDomWork` is exactly `16_384`, defined once in `INTERACTION_CANDIDATE_LIMITS`.
- Budget exhaustion must be structured and must not be reported as complete discovery, missing identity, disconnected identity, matched identity, or verified work.
- The final consumer status remains fail-closed, while original work status/reason/evidence remains structurally available.
- Every production change follows genuine RED, minimal GREEN, focused regression, then independent review.
- Every unexecuted command/gate is recorded as `NOT RUN` with command, reason, impact, and completion-blocker status.

## File Structure

| Path | Responsibility in this correction |
| --- | --- |
| `src/safety/passive-request-guard.ts` | Retryable single-flight raw close plus drain owner; sticky invalidation and terminal transition. |
| `src/browser/context-factory.ts` | Retained Context/session ownership and read-only terminal query delegated to the Guard. |
| `src/safety/interaction-policy.ts` | Single source for `maxDomWork = 16_384` and existing candidate limits. |
| `src/interaction/discover-candidates.ts` | Bounded discovery result, bounded exact-handle resolution, and bounded retained inspection. |
| `src/interaction/isolated-auditor.ts` | Consumes structured discovery/resolution and returns separate work/lifecycle axes. |
| `tests/integration/passive-request-guard.test.ts` | Lifecycle retry, re-entry, overlap, invalidation priority, and drain-only retry proof. |
| `tests/component/context-factory.test.ts` | Factory/session/construction-owner retention and terminal-only release proof. |
| `tests/integration/isolated-interaction.test.ts` | DOM-work, exact Handle, structured work/lifecycle, S03-S08, and audit regressions. |
| `fixtures/site/total-dom-budget.html` | Deterministic hostile whole-document, deep-ancestor, controlled-element, and repeated-subtree cases. |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | Append-only RED/GREEN/verification report. |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | Status, rulings, fix rounds, and not-run ledger. |

## Review Focus

1. **Synchronous re-entry before raw close starts:** a close callback that invalidates immediately must see the already-published attempt owner and must not start a second raw close. Task 1 adds this race test.
2. **Failed attempt followed by overlapping retry callers:** the later retry must issue exactly one additional raw close and both callers must observe the same attempt result. Task 1 adds the overlap test.
3. **Raw close fulfilled but task drain timed out:** the later retry must drain again without issuing another raw close. Task 1 adds the drain-only retry test.
4. **Budget exhaustion while collecting one otherwise valid candidate:** no partial candidate may be retained or reported as missing/complete, and ancestor/text work must share the enumeration budget. Task 2 adds controlled-target and repeated-subtree tests.
5. **Terminal invalidation reported as a semantic close rejection:** the result lifecycle must say `CLOSED`, the final verdict must remain blocked, and the original work outcome must remain directly queryable. Task 3 adds this result test.

---

### Task 1: Make non-terminal invalidation close attempts retryable and single-flight

**Files:**
- Modify: `src/safety/passive-request-guard.ts:88-104, 430-503, 819-870, 890-910`
- Modify: `src/browser/context-factory.ts:17-22, 104-137, 176-183`
- Test: `tests/integration/passive-request-guard.test.ts:64-262, 1889-1980, 2350-2420`
- Test: `tests/component/context-factory.test.ts:123-178, 355-429`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`

**Interfaces:**
- Consumes: existing `GuardPhase`, `drainGuardTasks()`, `detachGuardListeners()`, `isPassiveRequestGuardClosed()`, `BrowserContextFactory.closePassiveContext()`, and `InteractionGuardedSession.close()`.
- Produces: one module-local `CloseAttemptResult`, `GuardState.rawCloseConfirmed`, `GuardState.closeAttempt`, and retry semantics through the unchanged public close entry points.

- [ ] **Step 1: Record the no-Git baseline**

Run:

```powershell
Get-FileHash src/safety/passive-request-guard.ts,src/browser/context-factory.ts,tests/integration/passive-request-guard.test.ts,tests/component/context-factory.test.ts,package.json,package-lock.json -Algorithm SHA256
```

Append the paths and hashes to the report before editing. Expected package hashes remain:

```text
package.json       75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233
package-lock.json  A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A
```

- [ ] **Step 2: Extend the Guard harness with deterministic per-attempt close outcomes**

Add this option beside the existing close options:

```ts
readonly contextCloseAttempts?: readonly (
  | { readonly outcome: 'RESOLVE' }
  | { readonly outcome: 'REJECT'; readonly error: unknown }
)[];
```

In the fake `close()`, select the current zero-based attempt before incrementing the count:

```ts
const attemptIndex = closeCount;
closeCount += 1;
const attempt = options.contextCloseAttempts?.[attemptIndex];
if (attempt?.outcome === 'REJECT') return Promise.reject(attempt.error);
if (attempt?.outcome === 'RESOLVE') return;
```

Keep the existing gate, callback, single-error, and arbitrary-rejection branches for old tests. Do not make production expose an attempt counter.

- [ ] **Step 3: Add the raw-close retry and overlap RED tests**

Add focused tests with these observable assertions:

```ts
it('retries a failed invalidating raw Context close and reaches CLOSED', async () => {
  const firstFailure = new Error('first raw close failed');
  const harness = createGuardHarness({
    contextCloseAttempts: [
      { outcome: 'REJECT', error: firstFailure },
      { outcome: 'RESOLVE' },
    ],
  });
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set(['https://example.test']));

  await expect(closePassiveGuardedContext(harness.context)).rejects.toBe(firstFailure);
  expect(isPassiveRequestGuardClosed(harness.context)).toBe(false);
  await expect(closePassiveGuardedContext(harness.context)).rejects.toThrow(/invalidated/i);

  expect(harness.closeCount).toBe(2);
  expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
});
```

For overlap, gate only the second attempt, start two owner calls after the first failure, prove both remain unsettled while gated, release once, then assert `closeCount === 2`, both reject as invalidated, and the Guard is `CLOSED`. This test kills a retry implementation that creates one raw close per waiter.

- [ ] **Step 4: Add invalidation-priority and synchronous re-entry RED tests**

Use `onContextClose` to emit a real request-failure invalidation synchronously from the first normal close. Assert:

```ts
expect(harness.closeCount).toBe(1);
expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
await expect(closing).rejects.toThrow(/invalidated/i);
```

Add the failure/retry variant where the re-entrant first attempt rejects and the second explicit owner call succeeds. Assert the second attempt remains invalidating and never returns normal success.

- [ ] **Step 5: Add the drain-only retry RED test**

Use fake timers and an admitted Download cancellation gate. Let raw close fulfill, advance beyond the existing 1,000 ms drain deadline, and assert the first public close rejects with `GuardTaskDrainTimeoutError`. Resolve the Download gate, invoke close again, and assert:

```ts
expect(harness.closeCount).toBe(1);
expect(isPassiveRequestGuardClosed(harness.context)).toBe(true);
```

The old implementation fails because it returns the settled timeout completion forever; a naive retry fails by calling raw close twice.

- [ ] **Step 6: Add factory, session, and construction-owner RED tests**

Replace the old assertions that repeated retained-owner closes never retry. For a Playwright Context spy, make the first raw close reject and the second delegate to the original bound close:

```ts
const rawClose = context.close.bind(context);
let attempt = 0;
vi.spyOn(context, 'close').mockImplementation(async () => {
  attempt += 1;
  if (attempt === 1) throw new Error('first retained close failed');
  await rawClose();
});
```

For each of session, factory, and `ContextConstructionError.context`, assert:

```ts
await expect(firstOwnerClose).rejects.toThrow('first retained close failed');
expect(contextOrPageIsPhysicallyOpen).toBe(true);
await expect(secondOwnerClose).rejects.toThrow(/invalidated/i);
expect(attempt).toBe(2);
expect(contextOrPageIsPhysicallyClosed).toBe(true);
await expect(factory.closePassiveContext(context)).rejects.toThrow(/no longer active|not owned/i);
```

The final assertion proves factory ownership releases only after terminal confirmation.

- [ ] **Step 7: Run the new tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry"
```

Expected before production edits: the later call joins the already-settled completion, raw close remains at one, and the Guard never reaches `CLOSED`. Record every failing test name and expected failure in the report.

- [ ] **Step 8: Replace the permanent invalidation completion with one active attempt owner**

Add module-local types and state:

```ts
interface CloseAttemptResult {
  readonly invalidated: boolean;
}

type CloseAttemptSource = 'OWNER_CLOSE' | 'SAFETY_INVALIDATION';

interface GuardState {
  // existing fields
  rawCloseConfirmed: boolean;
  closeAttempt: Promise<CloseAttemptResult> | undefined;
}
```

Remove `invalidationCompletion`. Initialize `rawCloseConfirmed: false` and `closeAttempt: undefined` during Guard installation.

Implement one helper with publication-before-side-effect:

```ts
function ensureCloseAttempt(
  guardState: GuardState,
  source: CloseAttemptSource,
): Promise<CloseAttemptResult> {
  if (guardState.phase === 'CLOSED') {
    return Promise.resolve(Object.freeze({ invalidated: true }));
  }
  if (guardState.closeAttempt !== undefined) return guardState.closeAttempt;

  let begin!: () => void;
  const start = new Promise<void>((resolve) => { begin = resolve; });
  let attempt!: Promise<CloseAttemptResult>;
  attempt = (async () => {
    await start;
    if (!guardState.rawCloseConfirmed) {
      try {
        await guardState.context.close();
        guardState.rawCloseConfirmed = true;
      } catch (error) {
        guardState.phase = invalidatingPhase(guardState.phase);
        guardState.ledger.recordInvariantViolation({
          code: source === 'OWNER_CLOSE'
            ? 'GUARDED_CONTEXT_CLOSE_FAILED'
            : 'GUARD_CONTEXT_INVALIDATION_FAILED',
          message: errorMessage(error),
        });
        throw error;
      }
    }

    detachGuardListeners(guardState);
    let invalidated = false;
    const drainResult = await drainGuardTasks(guardState, () => {
      invalidated = guardState.phase === 'PASSIVE_INVALIDATING'
        || guardState.phase === 'FROZEN_INVALIDATING';
      guardState.phase = 'CLOSED';
    });
    if (drainResult === 'TIMED_OUT') {
      guardState.phase = invalidatingPhase(guardState.phase);
      throw new GuardTaskDrainTimeoutError();
    }
    return Object.freeze({ invalidated });
  })();

  guardState.closeAttempt = attempt;
  void attempt.then(
    () => undefined,
    () => {
      if (guardState.closeAttempt === attempt && guardState.phase !== 'CLOSED') {
        guardState.closeAttempt = undefined;
      }
    },
  );
  begin();
  return attempt;
}
```

Do not copy this helper into factory/session code. If the existing `drainGuardTasks()` callback cannot atomically distinguish timeout from terminal transition, adjust it so `onDrained` runs only after a final empty-set observation and never on timeout; do not set `CLOSED` before knowing the drain succeeded.

- [ ] **Step 9: Route invalidation and public close through the shared attempt**

`invalidateContext()` must synchronously promote closing/active phases, then:

```ts
await ensureCloseAttempt(guardState, 'SAFETY_INVALIDATION');
```

`closePassiveGuardedContext()` must:

```ts
const startedInvalidating = guardState.phase === 'PASSIVE_INVALIDATING'
  || guardState.phase === 'FROZEN_INVALIDATING';
if (!startedInvalidating) {
  guardState.phase = ownerClosingPhase(guardState.phase);
}
const result = await ensureCloseAttempt(guardState, 'OWNER_CLOSE');
if (startedInvalidating || result.invalidated) {
  throw new Error('Passive request guard context was invalidated');
}
```

An active attempt is always joined. A non-terminal invalidating state with no attempt starts a retry. Preserve `initiateInvalidation()` rejection containment and the reserved overflow owner, but make them observe the current attempt rather than a permanent completion.

- [ ] **Step 10: Verify focused GREEN and prior lifecycle priority**

Run:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5"
```

Expected: all selected tests PASS, exactly-one overlap assertions pass, and close-first/invalidate-first remain `BLOCKED_BY_SAFETY`.

- [ ] **Step 11: Run the Task 1 regression and typecheck**

Run:

```powershell
npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts
npm run typecheck
```

Expected: both files PASS; typecheck exit 0.

- [ ] **Step 12: Record the checkpoint and request an independent Task 1 review**

Append RED/GREEN commands, counts, exit codes, and fresh hashes for all Task 1 files to the report and progress ledger. Prepare a fixed hash package containing the spec, this plan, Task 1 source/tests, package files, and report. The reviewer must verdict retry liveness, single-flight overlap, publication-before-re-entry, drain-only retry, terminal-only release, and invalidation priority. Do not begin Task 2 until Critical/Important findings are addressed.

---

### Task 2: Bound total DOM work for discovery, exact Handle resolution, and retained inspection

**Files:**
- Modify: `src/safety/interaction-policy.ts:43-50`
- Modify: `src/interaction/discover-candidates.ts:11-18, 176-323, 325-499`
- Modify: `src/interaction/isolated-auditor.ts:16-20, 200-260, 290-300`
- Modify: `tests/integration/isolated-interaction.test.ts:1-470, 539-650`
- Create: `fixtures/site/total-dom-budget.html`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`

**Interfaces:**
- Consumes: `INTERACTION_CANDIDATE_SELECTOR`, `INTERACTION_CANDIDATE_LIMITS`, `InteractionCandidate`, and the exact Handle owner in `executeInteraction()`.
- Produces:

```ts
export interface InteractionCandidateDiscoveryResult {
  readonly candidates: readonly InteractionCandidate[];
  readonly completeness: 'COMPLETE' | 'CANDIDATE_LIMIT_REACHED' | 'DOM_WORK_BUDGET_REACHED';
  readonly domWorkUsed: number;
}

export type InteractionHandleResolution =
  | { readonly status: 'FOUND'; readonly handle: ElementHandle<Element>; readonly domWorkUsed: number }
  | { readonly status: 'MISSING'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };

export type InteractionHandleSnapshot =
  | { readonly status: 'CONNECTED'; readonly candidate: InteractionCandidate; readonly domWorkUsed: number }
  | { readonly status: 'DISCONNECTED'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };
```

- [ ] **Step 1: Record the Task 2 baseline hashes**

Run:

```powershell
Get-FileHash src/safety/interaction-policy.ts,src/interaction/discover-candidates.ts,src/interaction/isolated-auditor.ts,tests/integration/isolated-interaction.test.ts,package.json,package-lock.json -Algorithm SHA256
```

Append results to the report before editing.

- [ ] **Step 2: Create the hostile total-budget fixture**

Create `fixtures/site/total-dom-budget.html` with four deterministic sections generated synchronously by a local inline script:

```html
<!doctype html>
<html lang="en">
<body>
  <button id="early" type="button" aria-controls="deep-controlled">Early candidate</button>
  <div id="deep-controlled"></div>
  <section id="no-early-candidate"></section>
  <section id="many-candidate-subtrees"></section>
  <script>
    const controlled = document.querySelector('#deep-controlled');
    let parent = controlled;
    for (let index = 0; index < 20000; index += 1) {
      const wrapper = document.createElement('div');
      parent.replaceWith(wrapper);
      wrapper.append(parent);
      parent = wrapper;
    }

    const empty = document.querySelector('#no-early-candidate');
    for (let index = 0; index < 20000; index += 1) empty.append(document.createElement('div'));
    const late = document.createElement('button');
    late.type = 'button';
    late.textContent = 'Candidate beyond budget';
    empty.append(late);

    const repeated = document.querySelector('#many-candidate-subtrees');
    for (let candidateIndex = 0; candidateIndex < 100; candidateIndex += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', `Repeated candidate ${candidateIndex}`);
      for (let nodeIndex = 0; nodeIndex < 512; nodeIndex += 1) button.append(document.createElement('span'));
      repeated.append(button);
    }
  </script>
</body>
</html>
```

If replacing `#deep-controlled` changes its ID ownership, preserve the ID on the outermost wrapper so `getElementById('deep-controlled')` resolves a node with 20,000 ancestors. The fixture must perform no network or mutation after load.

- [ ] **Step 3: Add whole-DOM enumeration and explicit completeness RED tests**

Add tests that navigate to the fixture and temporarily replace `Document.prototype.querySelectorAll` in the page with a throwing function after fixture construction. Call `discoverInteractionCandidates(page)` and assert it does not throw from selector enumeration.

Add a separate page/fixture state with 20,000 non-candidates before a late candidate and assert:

```ts
expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
expect(result.domWorkUsed).toBe(INTERACTION_CANDIDATE_LIMITS.maxDomWork);
expect(result.candidates.some(({ accessibleName }) => accessibleName === 'Candidate beyond budget')).toBe(false);
expect(Object.isFrozen(result)).toBe(true);
expect(Object.isFrozen(result.candidates)).toBe(true);
```

The old implementation either calls the forbidden query or returns the late candidate after an unbounded whole-document scan.

- [ ] **Step 4: Add shared ancestor/text budget RED tests**

For the early `aria-controls` candidate whose controlled node has 20,000 ancestors, assert budget exhaustion occurs while building that candidate and the partial candidate is absent. For the repeated candidate subtrees, assert total `domWorkUsed` never exceeds 16,384 and later candidate records are absent; this kills any per-candidate reset.

Instrument `document.createTreeWalker` in a characterization helper so every returned node increments a page-visible test counter. Compare that counter with returned `domWorkUsed` only for the operations the test wrapper observes; assert neither exceeds `maxDomWork`. The expected value must be the literal `16_384`, not computed by the production helper.

- [ ] **Step 5: Add bounded exact-handle resolution and retained-inspection RED tests**

First add a compilable runtime export-presence test without statically importing a missing symbol:

```ts
const discoveryModule = await import('../../src/interaction/discover-candidates.js');
expect(discoveryModule).toHaveProperty('resolveInteractionCandidateHandle');
```

Run that one test and observe the expected assertion failure. Then add the smallest exported async stub with the exact signature from this task's Interfaces block; the stub must throw `Bounded interaction handle resolution is not implemented`. Add the behavioral tests below and observe them fail with that exact stub error. This establishes a genuine API RED followed by a genuine behavior RED without accepting a module-load or TypeScript error.

With `querySelectorAll` patched to throw, statically import and exercise the stubbed `resolveInteractionCandidateHandle`:

```ts
const resolution = await resolveInteractionCandidateHandle(page, 0);
expect(resolution.status).toBe('FOUND');
if (resolution.status === 'FOUND') {
  try {
    const snapshot = await inspectInteractionCandidateHandle(resolution.handle, 0);
    expect(snapshot.status).toBe('CONNECTED');
  } finally {
    await resolution.handle.dispose();
  }
}
```

Add late-target and deep-controlled variants that return `DOM_WORK_BUDGET_REACHED`, never `MISSING`/`DISCONNECTED`. Keep the exact-node reorder and clone-replacement tests; update them to the new discriminants without weakening their assertions.

- [ ] **Step 6: Run the DOM tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text"
```

Expected before the minimal implementation: `querySelectorAll` throws, late candidates are returned or no completeness exists, visibility can exceed the total budget, and the resolver behavior fails with the exact temporary stub error. Module-load and TypeScript errors are not accepted as behavioral RED evidence.

- [ ] **Step 7: Add the single budget constant**

Extend the existing frozen limit object:

```ts
export const INTERACTION_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 100,
  maxTextLength: 256,
  maxTextNodes: 512,
  maxAttributeLength: 512,
  maxUrlLength: 2_048,
  maxOrdinal: 99,
  maxDomWork: 16_384,
});
```

Do not define `16_384` elsewhere in production.

- [ ] **Step 8: Implement a browser-local total-budget primitive in every serialized callback**

Because Playwright serializes callbacks, repeat this exact local primitive inside discovery, resolution, and inspection rather than creating a page global:

```ts
const domWork = {
  used: 0,
  exhausted: false,
  consume(): boolean {
    if (this.used >= limits.maxDomWork) {
      this.exhausted = true;
      return false;
    }
    this.used += 1;
    return true;
  },
};
```

Call `consume()` before every node acceptance, candidate inspection, visibility ancestor, label/control lookup, and retained-target comparison listed in the spec. When it returns false, stop synchronously without another DOM read.

- [ ] **Step 9: Replace discovery `querySelectorAll` with bounded `SHOW_ELEMENT` traversal**

Use this control shape inside `page.evaluate`:

```ts
const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
const selected: RawInteractionCandidate[] = [];
let completeness: InteractionCandidateDiscoveryResult['completeness'] = 'COMPLETE';
while (selected.length < limits.maxCandidates) {
  const node = walker.nextNode();
  if (node === null) break;
  if (!domWork.consume()) {
    completeness = 'DOM_WORK_BUDGET_REACHED';
    break;
  }
  const element = node as Element;
  if (!element.matches(selector)) continue;
  if (!domWork.consume()) {
    completeness = 'DOM_WORK_BUDGET_REACHED';
    break;
  }
  const candidate = collectCompleteCandidate(element, selected.length, domWork);
  if (candidate === null) {
    completeness = 'DOM_WORK_BUDGET_REACHED';
    break;
  }
  selected.push(candidate);
}
if (selected.length === limits.maxCandidates && completeness === 'COMPLETE') {
  completeness = 'CANDIDATE_LIMIT_REACHED';
}
return { candidates: selected, completeness, domWorkUsed: domWork.used };
```

Implement `collectCompleteCandidate`, `visibility`, `accessibleName`, and `boundedDescendantText` inside the callback so each accepts the same `domWork` object. Do not read one more node after budget exhaustion. Convert and deep-freeze the structured result in Node.js after validating the container, completeness, and `domWorkUsed`.

- [ ] **Step 10: Implement bounded exact-handle resolution**

Add `resolveInteractionCandidateHandle(page, ordinal)` in `discover-candidates.ts`. Validate `ordinal` against `maxOrdinal`, then use `page.evaluateHandle` with bounded `SHOW_ELEMENT` traversal. Return a browser envelope `{ status, element, domWorkUsed }`, extract the status/used fields, retain the element property handle only for `FOUND`, dispose the envelope and all unused property handles, and freeze the Node-side discriminated wrapper.

Required cleanup shape:

```ts
const envelope = await page.evaluateHandle(/* bounded callback */, { selector, limits, ordinal });
let elementHandle: ElementHandle<Element> | null = null;
try {
  const properties = await envelope.getProperties();
  const statusHandle = properties.get('status');
  const domWorkHandle = properties.get('domWorkUsed');
  const candidateHandle = properties.get('element');
  if (statusHandle === undefined || domWorkHandle === undefined) {
    throw new Error('Invalid bounded interaction handle resolution envelope');
  }
  try {
    const status = await statusHandle.jsonValue();
    const domWorkUsed = await domWorkHandle.jsonValue();
    elementHandle = candidateHandle?.asElement() as ElementHandle<Element> | null;
    if (status === 'FOUND' && elementHandle !== null) {
      return Object.freeze({ status, handle: elementHandle, domWorkUsed });
    }
    await candidateHandle?.dispose();
    return Object.freeze({ status, domWorkUsed });
  } finally {
    await statusHandle.dispose();
    await domWorkHandle.dispose();
  }
} finally {
  await envelope.dispose();
}
```

Before relying on child-handle lifetime after envelope disposal, add one focused real-Chromium test that calls `handle.evaluate(element => element.isConnected)` after resolver return. If Playwright invalidates the child, restructure extraction without leaking the envelope; do not fall back to `locator().nth()`.

- [ ] **Step 11: Implement bounded retained inspection**

Remove retained `querySelectorAll`. Traverse candidate elements incrementally from `document.documentElement`, consuming the shared budget until the exact retained `element` identity is observed. Then collect all candidate facts with that same budget. Return `DOM_WORK_BUDGET_REACHED` if either live ordinal or fact collection exhausts it, `DISCONNECTED` only when the node is not connected or complete traversal proves absence, and `CONNECTED` only with a complete candidate.

- [ ] **Step 12: Integrate structured discovery/resolution into the auditor**

Update rediscovery:

```ts
const rediscovered = await discoverInteractionCandidates(session.page);
const matching = rediscovered.candidates.filter((item) => item.candidateId === candidate.candidateId);
if (matching.length === 0 && rediscovered.completeness !== 'COMPLETE') {
  return outcome('NOT_VERIFIABLE', `Candidate rediscovery was incomplete: ${rediscovered.completeness}`, emptyEvidence(candidate));
}
```

Replace `page.locator(...).nth(...).elementHandle()` with `resolveInteractionCandidateHandle`. `MISSING` maps to the existing unresolved result, budget exhaustion maps to `NOT_VERIFIABLE`, and only `FOUND` enters the existing Handle owner scope. Update retained inspection branches to the new discriminants; budget exhaustion maps to `NOT_VERIFIABLE` and never triggers disconnected candidate rediscovery as though identity were absent.

- [ ] **Step 13: Update all discovery consumers and preserve exact prior behavior**

Change tests/helpers from:

```ts
const candidates = await discoverInteractionCandidates(page);
```

to:

```ts
const discovery = await discoverInteractionCandidates(page);
expect(discovery.completeness).toBe('COMPLETE');
const candidates = discovery.candidates;
```

For fixtures intentionally reaching `maxCandidates`, assert `CANDIDATE_LIMIT_REACHED`. Update `inspectInteractionCandidateHandle` checks from `connected` booleans to the exact status discriminants. Do not delete or weaken candidate order, stable identity, node replacement, ambiguous/missing, hostile text, NodeList iterator, or S03-S08 tests.

- [ ] **Step 14: Verify DOM GREEN and isolated-interaction regression**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text"
npm test -- --run tests/integration/isolated-interaction.test.ts
npm run typecheck
```

Expected: DOM focus PASS, the entire isolated-interaction file PASS, typecheck exit 0.

- [ ] **Step 15: Record the checkpoint and request an independent Task 2 review**

Append RED/GREEN evidence and hashes for Task 2 files. Prepare a fixed hash package. The reviewer must inspect all three serialized callbacks, reject any hidden `querySelectorAll`/locator enumeration, verify every charged path shares its invocation budget, verify no partial candidate escapes, and confirm budget exhaustion is distinct from missing/disconnected. Do not begin Task 3 with an open Critical/Important finding.

---

### Task 3: Preserve work and lifecycle as separate structured result axes

**Files:**
- Modify: `src/browser/context-factory.ts:17-22, 119-137`
- Modify: `src/interaction/isolated-auditor.ts:33-137, 339-390`
- Test: `tests/integration/isolated-interaction.test.ts:980-1360`
- Test: `tests/component/context-factory.test.ts:240-429`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`

**Interfaces:**
- Consumes: Task 1 retryable terminal query and Task 2 structured candidate operations.
- Produces:

```ts
export interface InteractionWorkOutcome {
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
}

export type InteractionLifecycleOutcome =
  | { readonly status: 'CLOSED'; readonly reason: string | null }
  | { readonly status: 'NON_TERMINAL'; readonly reason: string };

export interface InteractionAuditResult {
  readonly candidateId: string;
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
  readonly work: InteractionWorkOutcome;
  readonly lifecycle: InteractionLifecycleOutcome;
  readonly safety: SafetyLedgerSnapshot;
}
```

- [ ] **Step 1: Record the Task 3 baseline hashes**

Run:

```powershell
Get-FileHash src/browser/context-factory.ts,src/interaction/isolated-auditor.ts,tests/component/context-factory.test.ts,tests/integration/isolated-interaction.test.ts -Algorithm SHA256
```

Append results before editing.

- [ ] **Step 2: Add required read-only terminal query to every session test double**

Extend `InteractionGuardedSession`:

```ts
readonly isClosed: () => boolean;
```

Production delegates directly:

```ts
isClosed: (): boolean => isPassiveRequestGuardClosed(context),
```

Every test double must own an explicit `closed` boolean changed only by its fake close behavior. Do not default missing fakes to terminal; doing so would hide lifecycle bugs.

- [ ] **Step 3: Add structured work/non-terminal lifecycle RED**

Replace string-containment assertions in `preserves both work and owner-close failures` with:

```ts
expect(result.status).toBe('BLOCKED_BY_SAFETY');
expect(result.reason).toBe('Interaction owner lifecycle did not reach terminal state');
expect(result.work).toEqual({
  status: 'EXECUTION_FAILED',
  reason: 'fixture work failed',
  evidence: result.evidence,
});
expect(result.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'fixture close failed' });
expect(result.evidence).toBe(result.work.evidence);
```

Keep the existing Safety Ledger close-failure assertion and exactly-one close count.

- [ ] **Step 4: Add VERIFIED work plus failed lifecycle RED**

Use the existing click-change fixture, then make session close reject while `isClosed()` remains false. Assert final blocked status, `work.status === 'VERIFIED'`, the original observable-change reason/evidence, and structured non-terminal lifecycle. Assert the final reason does not contain `VERIFIED` or the work reason; this kills ad-hoc string encoding.

- [ ] **Step 5: Add terminal invalidation semantic-rejection RED**

Use a real factory session whose close reaches Guard `CLOSED` but rejects `Passive request guard context was invalidated`. Assert:

```ts
expect(result.lifecycle).toEqual({
  status: 'CLOSED',
  reason: 'Passive request guard context was invalidated',
});
expect(result.status).toBe('BLOCKED_BY_SAFETY');
expect(result.work.status).toBe('VERIFIED');
```

This prevents treating every close rejection as physically non-terminal.

- [ ] **Step 6: Add fulfilled-but-non-terminal invariant RED and immutability RED**

Create a fake session whose `close()` fulfills but `isClosed()` returns false. Require one Safety Ledger invariant:

```text
INTERACTION_OWNER_CLOSE_NON_TERMINAL
Interaction owner close fulfilled without terminal Guard state
```

Require final `BLOCKED_BY_SAFETY` and lifecycle `NON_TERMINAL`. For a normal successful audit, assert `Object.isFrozen` on result, work, lifecycle, evidence, changedFields, safety, and every safety array.

- [ ] **Step 7: Run the new result tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes"
```

Expected before production edits: `work`, `lifecycle`, and `isClosed` behavior are absent, while the old reason contains the work status/reason.

- [ ] **Step 8: Export and freeze the work/lifecycle types**

Make `InteractionWorkOutcome` public. Keep `outcome()` as the only constructor and ensure it returns a frozen object with frozen evidence supplied by the existing evidence constructors.

Add constructors:

```ts
function closedLifecycle(reason: string | null): InteractionLifecycleOutcome {
  return Object.freeze({ status: 'CLOSED', reason });
}

function nonTerminalLifecycle(reason: string): InteractionLifecycleOutcome {
  return Object.freeze({ status: 'NON_TERMINAL', reason: reason.slice(0, MAX_INTERACTION_REASON_LENGTH) });
}
```

- [ ] **Step 9: Capture close presence, terminal truth, and lifecycle separately**

Use an explicit presence flag so rejection with `undefined` remains a failure:

```ts
let closeFailed = false;
let closeError: unknown;
try {
  await session.close();
} catch (error) {
  closeFailed = true;
  closeError = error;
  session.ledger.recordInvariantViolation({
    code: 'INTERACTION_OWNER_CLOSE_FAILED',
    message: errorMessage(error),
  });
}

const terminal = session.isClosed();
if (!closeFailed && !terminal) {
  session.ledger.recordInvariantViolation({
    code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
    message: 'Interaction owner close fulfilled without terminal Guard state',
  });
}
const lifecycle = terminal
  ? closedLifecycle(closeFailed ? errorMessage(closeError) : null)
  : nonTerminalLifecycle(closeFailed
    ? errorMessage(closeError)
    : 'Interaction owner close fulfilled without terminal Guard state');
```

Take the final Safety Ledger snapshot only after this logic so the invariant is retained.

- [ ] **Step 10: Replace string-encoding finalization with two-axis finalization**

Use one pure finalizer:

```ts
function finalizeInteractionOutcome(
  work: InteractionWorkOutcome,
  lifecycle: InteractionLifecycleOutcome,
  closeFailed: boolean,
  safety: SafetyLedgerSnapshot,
): { readonly status: InteractionStatus; readonly reason: string } {
  if (hasFreezeEvent(safety)) {
    return Object.freeze({ status: 'BLOCKED_BY_SAFETY', reason: 'Interaction activity was blocked by safety freeze' });
  }
  if (lifecycle.status === 'NON_TERMINAL') {
    return Object.freeze({ status: 'BLOCKED_BY_SAFETY', reason: 'Interaction owner lifecycle did not reach terminal state' });
  }
  if (closeFailed) {
    return Object.freeze({ status: 'BLOCKED_BY_SAFETY', reason: 'Interaction owner close reported a safety failure' });
  }
  return Object.freeze({ status: work.status, reason: work.reason });
}
```

Return a frozen `InteractionAuditResult` where `evidence: work.evidence`, `work`, `lifecycle`, and the detached final safety snapshot are included. Never interpolate `work.status` or `work.reason` into the final safety reason.

- [ ] **Step 11: Update all session fakes and compatibility assertions**

For successful fake sessions:

```ts
let closed = false;
const session: InteractionGuardedSession = {
  // page, ledger, freeze
  close: async () => { closed = true; },
  isClosed: () => closed,
};
```

For failing fakes, leave `closed = false`; for terminal invalidation fakes, set `closed = true` before rejecting. Preserve all existing top-level status/reason/evidence assertions except those intentionally replaced by the new final reason contract. Add `expect(result.evidence).toBe(result.work.evidence)` where evidence identity matters.

- [ ] **Step 12: Verify result GREEN and full isolated interaction**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes|lifecycle priority"
npm test -- --run tests/integration/isolated-interaction.test.ts
npm run typecheck
```

Expected: focused and entire file PASS; typecheck exit 0.

- [ ] **Step 13: Record the checkpoint and request an independent Task 3 review**

Append RED/GREEN evidence and current hashes. The fixed review package must ask the reviewer to trace every finalizer branch, arbitrary rejection values including `undefined`, terminal truth, immutable aliasing, final freeze precedence, and top-level compatibility. Do not begin Task 4 with an open Critical/Important finding.

---

### Task 4: Run the Task 11 checkpoint verification and dual independent review

**Files:**
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`
- Modify: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- Create: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md`
- Create after review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-spec-review.md`
- Create after review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-quality-review.md`

**Interfaces:**
- Consumes: reviewed outputs of Tasks 1–3 and all existing Task 5/11 safety contracts.
- Produces: fixed no-Git review manifest, complete executed/not-run ledger, dual independent verdicts, and the Task 11 mandatory-checkpoint report. It does not authorize Task 12 automatically.

- [ ] **Step 1: Run the user-required fresh focus tests**

Run exactly:

```powershell
npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts -t "retry|drain-only|synchronous re-entry|lifecycle priority|total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes"
```

Record test files, passed/failed/skipped counts, exit code, and any environment-only Chromium `spawn EPERM` rerun. A sandbox launch failure is not a product PASS; rerun the identical command with existing-browser process permission and record both attempts.

- [ ] **Step 2: Run the full isolated-interaction regression**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts
```

Expected: all tests in the file PASS, including S03-S08 server counters, candidate identity, deadlines, Handle disposal, DOM budget, and structured result assertions.

- [ ] **Step 3: Run the lifecycle race suite**

Run:

```powershell
npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "retry|drain-only|synchronous re-entry|lifecycle priority|close begins|invalidation"
```

Expected: all selected tests PASS; no unhandled rejection; no duplicate raw close per overlapping attempt.

- [ ] **Step 4: Run the DOM budget suite**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text|candidate discovery"
```

Expected: all selected tests PASS; work counts do not exceed 16,384 and exhaustion remains explicit.

- [ ] **Step 5: Run the six-file Task 11 regression**

Run:

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts
```

Expected: all six files and all tests PASS.

- [ ] **Step 6: Run typecheck and build**

Run separately and record each exit code:

```powershell
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 7: Run adjacent and full repository regressions**

Run:

```powershell
npm test -- --run tests/integration/controlled-scroll.test.ts tests/component/performance-collector.test.ts
npm test
```

If and only if Vitest reports a worker-process exit with no individual test failure, rerun the identical full command once and record both results. Any named test failure is a product/test failure and blocks approval.

- [ ] **Step 8: Run forbidden-boundary and package-drift scans**

Run:

```powershell
rg -n "example|www\.example\.com|evaluate\(\s*['\"]|innerHTML\s*=|setAttribute\(" src
rg -n "querySelectorAll\(.*INTERACTION_CANDIDATE_SELECTOR|querySelectorAll\(selector\)|locator\(INTERACTION_CANDIDATE_SELECTOR\)" src/interaction
Get-FileHash package.json,package-lock.json -Algorithm SHA256
```

The first scan must have no target identity, string evaluation, or production DOM-marker mutation findings. The second must have no whole-DOM candidate enumeration or locator escape hatch in the corrected interaction paths. Package hashes must match the Global Constraints.

- [ ] **Step 9: Update the not-run ledger honestly**

For every required command/gate not executed, append:

```text
NOT RUN
- command: <exact command or gate>
- reason: <concrete reason>
- impact: <what remains unproved>
- completion blocker: yes/no
```

Remove or supersede the pre-correction not-run entries only with exact executed evidence. Never convert a not-run item to PASS from an earlier run.

- [ ] **Step 10: Create the fixed no-Git review package**

Generate a SHA-256 manifest containing at least:

- both Task 11 correction design/plan documents and the original recovery authorities;
- every Task 1–3 production file;
- every changed test and fixture;
- package/lock and Vitest/TypeScript configs;
- append-only implementation report and progress ledger;
- relevant Task 5/11 policy/evidence owners unchanged by the correction.

For every entry use fresh `Get-FileHash`; record total entries, unique paths, changed substitutions against the prior 48-entry package, missing paths, and mismatches. The review package must prohibit Git, edits, dependencies, live target access, and reviewer delegation.

- [ ] **Step 11: Dispatch fresh independent specification and quality reviews**

Use two reviewers that did not implement the correction. Give each only the spec, plan, implementation report, fixed review package, and binding global constraints. Do not tell either reviewer to ignore or downgrade a finding.

The specification reviewer must verdict every completion criterion and all three user findings. The quality reviewer must independently inspect concurrency/re-entry, promise ownership/unhandled rejection, browser Handle cleanup, budget honesty, structured result truthfulness, and test mutation strength.

Reviewers may run narrowly focused probes only when inspection cannot resolve a concrete question; they must not duplicate broad suites already recorded in the package.

- [ ] **Step 12: Apply the review gate and report without starting Task 12**

PASS requires:

```text
manifest: all entries match
Critical: 0
Important: 0
user-required fresh gates: PASS
typecheck/build: PASS
not-run ledger: complete
```

If either review reports Critical/Important, append the exact finding and continue the scoped Superpowers fix/re-review loop without starting Task 12. If both pass, mark only the Task 11 technical checkpoint ready for user approval. Task 12 remains blocked until the user explicitly approves Task 11.

## Plan self-review

### Spec coverage

| Spec requirement | Owning task |
| --- | --- |
| Retryable non-terminal close path | Task 1 Steps 3–10 |
| Attempt publication before re-entry | Task 1 Steps 4 and 8 |
| Raw close retry versus drain-only retry | Task 1 Steps 3, 5, and 8 |
| Terminal-only factory/session release | Task 1 Step 6 |
| One `maxDomWork = 16_384` authority | Task 2 Step 7 |
| No whole-DOM selector/locator enumeration | Task 2 Steps 3, 5, 9–12 |
| Shared enumeration/text/ancestor/live-ordinal budget | Task 2 Steps 4, 8–11 |
| Explicit incomplete discovery/inspection | Task 2 Steps 3–5 and 12 |
| Structured immutable work outcome | Task 3 Steps 3–4 and 8–10 |
| Structured truthful lifecycle outcome | Task 3 Steps 5–10 |
| Top-level fail-closed compatibility | Task 3 Steps 4, 5, and 10 |
| Required fresh gates and independent review | Task 4 Steps 1–12 |
| Honest not-run ledger | Task 4 Step 9 |
| Task 12 remains blocked | Global Constraints and Task 4 Step 12 |

### Type consistency

- `CloseAttemptResult.invalidated` is defined in Task 1 and consumed only by Guard outer semantics.
- `InteractionCandidateDiscoveryResult`, `InteractionHandleResolution`, and `InteractionHandleSnapshot` are defined in Task 2 before the auditor consumes them.
- `InteractionWorkOutcome`, `InteractionLifecycleOutcome`, and the additive `InteractionAuditResult` fields are defined and produced in Task 3.
- `InteractionGuardedSession.isClosed()` delegates to the Guard and is required on every test double; no optional default can fabricate terminal state.
- Budget status literals are identical in producer, consumer, and tests.

### Placeholder and review-focus audit

- The placeholder scan is clean; every helper, status literal, edge case, and verification action is defined in the owning task.
- Every Review Focus item has a named RED and owning task.
- Every task ends with focused verification, fresh SHA evidence, and an independent scoped review before the next task.
- Git commit steps are intentionally replaced by SHA-256 checkpoints because the user prohibits every Git operation.
