# Task 11 fix round 5/5 brief — final Git-free quality correction

The final independent code-quality review matched 34/34 hashes and returned NEEDS FIXES: 0 Critical, 5 Important, 2 Minor. Specification re-review already PASSed. This is the final correction round.

## Binding corrections

### 1. Drain guard-owned async listener tasks

- Add a GuardState-owned pending-task registry and track every fire-and-forget guard listener task that can mutate the ledger or invalidate/close a page/context: CDP paused work, popup close, download cancel, page-guard readiness/invalidation, request-failure invalidation, and equivalent callbacks.
- Guarded context close must first mark owner closing/invalidate the mode so no new ordinary work is admitted, close the context, then drain the stable pending-task set before returning. Loop for tasks spawned by task settlement. Use an explicit bounded cleanup deadline; on timeout, record one bounded invariant before returning so the final snapshot is honest and later detail cannot turn a clean result into an unreported clean success.
- All task rejection paths must be observed exactly once. Add deferred download-cancel/popup-close rejection tests proving owner close waits and the final `auditInteraction` safety snapshot contains the failure.

### 2. Bound browser work before materialization

- Do not spread/Array.from the full generic `querySelectorAll()` result. Index only the first `maxCandidates` NodeList entries. Retained-handle ordinal lookup must scan at most the configured limit and fail closed if the node is outside it.
- Replace full-subtree `textContent` materialization with a bounded text-node walk that stops after explicit node/character limits; use it for candidate text and referenced accessible-label text in both discovery and retained inspection.
- Add hostile-page tests that make iterator/full-text paths fail or count traversal, proving production does not enumerate/materialize beyond its limits. Returned data remains at most 100 candidates and bounded strings.

### 3. Bound every Safety Ledger category

- Apply consistent event-count and string bounds to Task 5 and interaction arrays, including invariant violations. Snapshot work must therefore be bounded.
- Bound method keys, cap distinct method-map entries, and saturate counters safely. Overflow/truncation is represented once through a bounded invariant without recursive overflow.
- Preserve existing short-value behavior and Task 5 semantics. Add large blocked-request/invariant/URL/method tests for cap, truncation, saturation/overflow evidence, deep immutability, and bounded snapshot.

### 4. Make every late freeze event authoritative

- Remove the REJECTED_UNSAFE exception from final freeze precedence. Any close-time interaction request/navigation/popup/download/WebSocket event makes the final status BLOCKED_BY_SAFETY while retaining the admission/evidence context.
- Add the direct rejected-candidate + close-time freeze regression.

### 5. Preserve outcome/evidence across ElementHandle disposal failure

- Do not allow `finally { await handle.dispose() }` to overwrite an established outcome or work error.
- Record disposal failure as a bounded invariant while retaining the original click/safety status, reason, and evidence. If no outcome exists, preserve both work and dispose failures explicitly rather than discarding either.
- Add click-failure + dispose-failure and safety-block + dispose-failure tests; assert both causes remain observable and evidence is retained.

### Minor in scope

- Validate rectangle `x === left` and `y === top` within tolerance in addition to edge/size consistency.
- Browser-side fact extraction duplication may remain a documented Minor only if unifying it would require a page-visible mutable global, string evaluation, or another safety regression. Keep both paths covered by shared contract tests and identical bounds.

## Required verification

- Genuine RED before production correction for all five Important groups and rectangle consistency.
- Focused Task 11/Task 5, Task 5/6/11 adjacent, typecheck, build, and full repository suite.
- Forbidden-boundary and package-drift scans.

No Git, dependency operation, live target, hidden wait, DOM marker mutation, site-specific production selector, or subagent.
