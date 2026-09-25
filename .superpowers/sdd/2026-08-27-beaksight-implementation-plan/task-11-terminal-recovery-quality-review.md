# Task 11 terminal recovery correction — final independent code-quality review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: final quality gate for the approved Task 11 terminal-recovery, total-DOM-budget, and structured-outcome correction.

## Verdict

**FAIL — Critical 0 / Important 1 / new Minor 0.**

The retryable Guard lifecycle, terminal-only owner release, total Handle cleanup, shared DOM-work accounting, immutable two-axis result finalization, and their principal race/mutation tests are internally coherent. One retained-inspection boundary still violates the approved discriminated-result contract: a connected exact node that moves beyond ordinal 99 is reported as `DISCONNECTED`. Task 11 therefore does not pass the final quality gate, and Task 12+ remains blocked.

## Fixed-package integrity

The fixed review package matched required SHA-256 `24E33E21407B47258036FBCA2489D3E35DA64C2B9E4EC05DF00F57A5BCC4E91E` before conclusions.

The manifest was independently parsed and recomputed before source review and again after all source/test/evidence inspection, immediately before this artifact was created:

- entries: **85**;
- unique paths: **85**;
- missing paths: **0**;
- duplicate paths: **0**;
- SHA-256 mismatches: **0**.

No listed package content drifted during this review. The final review artifact is not a manifest entry.

## Important finding

### I1 — A connected retained node beyond the ordinal cap is falsely classified as disconnected

**Location:** `src/interaction/discover-candidates.ts:602-625`; consumer consequence `src/interaction/isolated-auditor.ts:339-360`; incomplete boundary in `tests/integration/isolated-interaction.test.ts:529-545`.

Retained inspection correctly finds the exact retained `element` by identity and computes its live ordinal. It then returns `DISCONNECTED` whenever `liveOrdinal > limits.maxOrdinal`:

```ts
if (!found || liveOrdinal > limits.maxOrdinal) {
  return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
}
```

That combines two materially different facts. `!found` after complete traversal proves absence, but `liveOrdinal > 99` proves the opposite: the exact node was found, is still connected, and is still selector-matching. The approved design permits `DISCONNECTED` only when the node is not connected or complete traversal proves absence. It also requires incomplete/bounded outcomes to remain distinct from missing/disconnected.

A concrete counterexample is deterministic: acquire the initial ordinal-0 button, insert 100 selector-matching buttons before it, then inspect the retained Handle. The loop finds the same node at live ordinal 100 under the 16,384 work budget, but publishes `DISCONNECTED`. In the auditor this causes disconnected rediscovery; discovery retains only ordinals 0–99 and returns `CANDIDATE_LIMIT_REACHED`, so the exact connected node's observable post-click state is discarded as `NOT_VERIFIABLE`/`UNESTABLISHED`. The final result is conservative, but the retained API's status is false and the exact-node verification contract is not met.

The existing reorder regression inserts only one button and proves ordinal `0 -> 1`; it does not kill the cap-boundary mutation. Add a boundary test with enough preceding candidates to move the retained node beyond `maxOrdinal`, require that the node is never described as disconnected, and represent the bounded/candidate-limit condition explicitly. Because `InteractionCandidate.ordinal` currently forbids values above 99, the repair should introduce or otherwise define a truthful non-disconnected incomplete outcome rather than publishing an invalid candidate or relabeling the condition as physical disconnection.

## Independent quality audit

### Guard attempt ownership and retained owner lifecycle

- `ensureCloseAttempt()` publishes the Promise before raw `context.close()` can invoke a synchronous callback. Active callers join one attempt; rejection clearing is attached before publication to callers and only clears a matching non-terminal attempt.
- A raw-close rejection leaves `rawCloseConfirmed === false`, promotes or retains `*_INVALIDATING`, retains listeners/tasks, and allows a later explicit owner retry. A fulfilled raw close sets the flag only after fulfillment. A drain-timeout retry therefore drains again without issuing a second raw close.
- Invalidation synchronously promotes active/closing phases and never downgrades on retry. Normal close observes both its entry phase and the terminal attempt's captured invalidation bit, so close-first and invalidation-first cannot return normal success after invalidation wins.
- Arbitrary rejection values are preserved through the Guard attempt. Hostile prototype inspection in event containment is guarded, error normalization is bounded, and fire-and-forget invalidation owners attach rejection containment. The focused tests include synchronous throw, direct rejection, `undefined`, hostile Proxy behavior, and process-level unhandled-rejection observation.
- Factory Context membership is removed only after `isPassiveRequestGuardClosed(context)`. Session-local `closed` is derived in `finally` from that canonical query. Failed construction hands the retained Context out through `ContextConstructionError.context`; factory, session, and construction-error paths all reach the same close entry point.
- Raw-close and drain-only cardinality assertions are mutation-relevant: ordinary overlap stays at one raw close, failed-raw-close overlap adds exactly one second raw close, and drain-only recovery stays at one total raw close.

No new Critical/Important issue was found in these lifecycle paths.

### Handle ownership and total DOM-work accounting

- Resolution owns every property Handle returned by the envelope, validates the status/count/Element contradictions, attempts all metadata/unknown/envelope cleanup despite individual failures, reclaims a prospective child on any primary or cleanup failure, and transfers the ElementHandle only after successful cleanup. Presence is distinct from value, so a primary `Promise.reject(undefined)` is preserved, including inside an `AggregateError` with cleanup failures.
- The auditor enters one `finally` immediately after a successful `FOUND` transfer and attempts the retained ElementHandle disposal exactly once. Disposal failure is ledgered without destroying the established work outcome.
- Resolution, discovery, and retained inspection each have one browser-local `maxDomWork` owner. Discovery and inspection each also have one invocation-wide secondary text owner. Root plus descendant traversal preserves document order; no production `querySelectorAll`, locator/nth enumeration, NodeList materialization, recursion, `textContent`, or `nodeValue` escape was found.
- Accepted elements, matched-candidate work, retained comparison, candidate facts, visibility ancestors, label/control lookup, and accepted descendant nodes stay on the shared total budget. Exact identity/fact and final-visibility boundary tests assert that follow-on fact/geometry reads do not occur after exhaustion. In-progress candidates/snapshots are not published.
- Node-side discovery, resolution, and snapshot containers validate bounded safe-integer work counts and exact discriminants, and detached candidates/geometry are frozen.

The ordinal-cap misclassification in I1 is the sole approval-blocking defect found in this area.

### Structured work/lifecycle result and safety precedence

- `InteractionWorkOutcome` is frozen before owner close and retains work status, bounded reason, and evidence. `InteractionLifecycleOutcome` is derived after close settlement from the canonical session terminal query; close rejection presence is tracked separately from its value.
- The returned top-level evidence is the exact `work.evidence` object. Candidate geometry, evidence, changed-field arrays, work, lifecycle, result, Safety Ledger record/arrays/events, and the detached final snapshot are immutable.
- Final precedence is truthful: freeze evidence first, then non-terminal lifecycle, then terminal close rejection, otherwise original work. Fixed safety reasons do not interpolate or require parsing the original work status/reason.
- Tests cover `VERIFIED` and `EXECUTION_FAILED` work under failed close, terminal semantic invalidation rejection, fulfilled-but-non-terminal invariant recording, `undefined` close rejection, hostile normalization, freeze precedence combinations, and clean terminal success.

No new Critical/Important issue was found in finalization, aliasing, or freezing.

### S03–S08 and mutation strength

The maintained isolated-interaction tests still use fixture request observations and server counters for zero delivery of mutation, navigation, download, and WebSocket activity. They observe the acquired child path rather than relying only on the obsolete locator counter. The fixed package reports fresh 113/113 isolated-interaction, 295/295 six-file Task 11, 510/510 repository, typecheck, and build passes; those are verifier evidence and are not relabeled as reviewer execution.

Lifecycle and result tests have strong branch/cardinality assertions. DOM tests cover root inclusion, single-insertion reorder, exact identity/fact/visibility exhaustion boundaries, shared ancestor/text budgets, runtime envelope validation, property cleanup failures, and child lifetime. I1 identifies the remaining mutation gap at the 99/100 ordinal boundary.

## Historical and deferred items

Historical Task 2 I7 remains exactly what the package says it is: the original pre-implementation discovery/inspection behavioral RED was not captured. Later correction REDs prove their own fixes but do **not** retroactively repair that temporal evidence gap. This review does not relabel it as executed, repaired, or as a new implementation finding.

The five previously carried quality Minors remain separate from the new finding count and were not silently promoted or discarded:

1. lifecycle-phase HTTP abort correlation does not register the exact Request in `expectedRouteFailures`;
2. the test helper `emitFailedMainFrameRequest()` drops its asynchronous return;
3. the page-readiness task-factory block remains materially mis-indented;
4. isolated-auditor `String(error)` can materialize a large bigint/string before slicing;
5. historical implementation-plan snippets retain superseded error-presence/precedence examples.

None was caused by this correction. I1 is independent of those carried items.

## Reviewer-run evidence and not-run ledger

Reviewer-executed, read-only work:

1. fixed package SHA-256 check and two independent 85-entry manifest recomputations: package matched; **85/85 matched**, zero missing/duplicate/mismatch on both passes;
2. complete reads of the approved correction design, implementation plan, Task 4 report, fixed package, current Guard/factory/discovery/auditor/evidence/policy/ledger sources, scoped correction reviews/reports, and the relevant lifecycle/DOM/result tests;
3. static production scans for `querySelectorAll`, locator/nth, `textContent`, `nodeValue`, DOM walkers/lookups/ancestor walks, and budget-owner/reset sites.

NOT RUN
- command: any reviewer test or ad-hoc browser probe
- reason: control-flow inspection gives a direct deterministic counterexample for I1; duplicating the broad verifier suites would not resolve it, and the review instruction permits only narrow execution for unresolved doubt
- impact: no reviewer-owned runtime pass count is claimed; I1 remains approval-blocking from the source/status contract and missing boundary mutation test
- completion blocker: no additional blocker beyond I1

NOT RUN
- command: `npm run typecheck`, `npm run build`, full isolated-interaction, lifecycle, DOM, six-file Task 11, adjacent, or repository suites by this reviewer
- reason: the fixed package already pins fresh verifier runs and this reviewer changed no production/test/type file
- impact: all such counts remain verifier evidence, not reviewer evidence; they do not negate the demonstrated boundary defect
- completion blocker: no additional blocker beyond I1; all required broad gates must be rerun after its correction

NOT RUN
- command: Git, dependency/library/package operations, live-target access, delegation/subagents, Task 12+
- reason: expressly prohibited or outside review scope
- impact: none of those operations supplies missing Task 11 quality acceptance
- completion blocker: Task 12 remains blocked on a clean correction/re-review and user approval

Only this review artifact was created. No production, test, fixture, authority, report, manifest, package, lockfile, or configuration file was edited.
