# BeakSight Task 11 Terminal Recovery, DOM Budget, and Structured Outcome Design

Date: 2026-09-20  
Status: User-approved written specification  
Scope: Task 11 mandatory checkpoint correction only

## 1. Purpose

Task 11 Fix round 5 retained Context ownership after a failed raw close, but three load-bearing gaps remain:

1. a Guard left in `PASSIVE_INVALIDATING` or `FROZEN_INVALIDATING` has no later canonical owner path that can retry raw `BrowserContext.close()` and reach `CLOSED`;
2. candidate discovery and retained inspection cap returned candidates and descendant text, but `querySelectorAll()` may traverse the whole DOM and visibility ancestor walks do not share a total budget;
3. an owner-close failure changes the final result to `BLOCKED_BY_SAFETY` by embedding the prior work status/reason into a string, rather than retaining work and lifecycle/cleanup as separately queryable structured outcomes.

This specification corrects those three gaps without starting Task 12, adding a second safety owner, or weakening the fail-closed behavior already proved by Task 11.

## 2. Authority and supersession

This document is a user-requested correction to the approved Task 11 recovery design. It supersedes only the conflicting parts of:

- `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md` sections 4.4, 6, 8.2, 10, and 12;
- `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` examples that treat a failed invalidation close as permanently join-only, retain `querySelectorAll()` as candidate enumeration, or encode the work outcome only in the final reason.

All other Task 5/11 authorities and invariants remain binding:

- guarded Context lifecycle: `src/safety/passive-request-guard.ts`;
- Context/session ownership: `src/browser/context-factory.ts`;
- candidate discovery and exact retained-node inspection: `src/interaction/discover-candidates.ts`;
- interaction admission: `src/safety/interaction-policy.ts`;
- isolated interaction orchestration and final result: `src/interaction/isolated-auditor.ts`;
- safety history: `src/safety/safety-ledger.ts`.

No new route authority, safety classifier, candidate-policy owner, interaction entry point, target-specific selector, live-target operation, dependency, or package change is permitted. Git operations remain prohibited.

## 3. Chosen architecture

The correction uses three coordinated changes:

1. **Retryable single-flight close attempts.** The Guard phase remains the lifecycle authority. A separate module-local attempt owner represents only the currently executing physical-close/drain attempt. Failed attempts may be retried through the existing factory/session close entry points while ownership remains retained.
2. **One total DOM-work budget per browser operation.** Whole-document selector queries are removed from discovery and retained inspection. Candidate enumeration, exact-node resolution, descendant text, visibility ancestors, and related node lookups consume one shared finite budget for that operation.
3. **Two structured outcome axes.** The final interaction result retains the original work outcome and a separate lifecycle outcome. The top-level final status remains the conservative consumer-facing verdict.

No automatic timed retry loop is added. Arbitrary retry counts/backoff would introduce policy not requested by the product design. No recovery manager is added because it would duplicate the Guard lifecycle owner.

## 4. Retryable Guard lifecycle

### 4.1 Phase authority remains unchanged

The legal phases remain:

```text
INSTALLING
PASSIVE_ACTIVE
FROZEN_ACTIVE
PASSIVE_CLOSING
FROZEN_CLOSING
PASSIVE_INVALIDATING
FROZEN_INVALIDATING
CLOSED
```

`PASSIVE_INVALIDATING` and `FROZEN_INVALIDATING` are non-terminal retained-owner states. Only `CLOSED` authorizes factory/session ownership release.

Invalidation remains sticky and outranks normal close:

```text
PASSIVE_CLOSING -> PASSIVE_INVALIDATING
FROZEN_CLOSING  -> FROZEN_INVALIDATING
```

No retry may downgrade an invalidating phase to a closing or active phase.

### 4.2 Separate sticky state from the current attempt owner

`GuardState` must distinguish:

- the sticky lifecycle phase;
- whether raw Context close has already been confirmed;
- the single currently active close/drain attempt, if any.

Conceptually:

```ts
interface CloseAttemptResult {
  readonly invalidated: boolean;
}

interface GuardState {
  phase: GuardPhase;
  rawCloseConfirmed: boolean;
  closeAttempt: Promise<CloseAttemptResult> | undefined;
  // existing bounded tasks, registries, listeners, and ledger
}
```

The current `invalidationCompletion` must not remain a permanently settled join target for a non-terminal phase. It is replaced by, or narrowed into, the active-attempt owner. A rejected attempt is cleared only after its rejection is observable and only while the Guard is still non-terminal. A successful terminal attempt may remain internally observable until all joiners have settled, but no new work is admitted after `CLOSED`.

### 4.3 Canonical close attempt

All ordinary close and invalidation callers use one module-local `ensureCloseAttempt()`-style owner. It must:

1. synchronously return the existing attempt when one is active;
2. otherwise publish the new attempt into `GuardState` before invoking raw `context.close()` so re-entrant callbacks join it;
3. call raw `context.close()` only when `rawCloseConfirmed` is false;
4. set `rawCloseConfirmed = true` only after raw close fulfills;
5. detach owned listeners exactly once after raw close is confirmed;
6. perform the existing bounded stable task drain;
7. transition to `CLOSED` only when raw close is confirmed and the drain succeeds;
8. on raw-close rejection, retain listeners, retain ownership, retain the invalidating phase, ledger the bounded failure, reject the attempt, and make a later explicit retry possible;
9. on drain timeout after a confirmed raw close, retain the invalidating phase and ownership, reject the attempt, and allow a later attempt to retry the drain without issuing another raw close;
10. never run two raw close attempts concurrently.

The attempt Promise represents physical close plus owned-task drain. Its immutable `invalidated` result is captured from the invalidating phase immediately before the atomic transition to `CLOSED`; it is terminal metadata for outer callers, not a second lifecycle authority. Public close/invalidation functions retain their semantic responses:

- invalidation initiation resolves only after the attempt reaches `CLOSED`, and rejects when the current attempt fails or times out;
- a normal close promoted by invalidation cannot return normal success, even if the shared physical attempt reaches `CLOSED`;
- an explicit close invoked while an invalidating attempt is active joins it;
- an explicit close invoked in a non-terminal invalidating phase with no active attempt starts the next canonical attempt.

### 4.4 Retained owners and retry entry points

No new public close API is introduced.

- `BrowserContextFactory.closePassiveContext(context)` remains the Context owner retry entry point.
- `InteractionGuardedSession.close()` remains the session owner retry entry point.
- `ContextConstructionError.context` remains the construction-failure handoff to the same factory close entry point.

After any failed attempt:

- the factory retains the Context in `activeContexts`;
- the Context retains its Safety Ledger;
- the session does not mark itself closed;
- active browser operations remain rejected by the Guard;
- a subsequent owner close call can start or join a new attempt.

Only a read of the Guard's canonical `CLOSED` phase may release those owners.

### 4.5 Retry safety and liveness

The correction guarantees a path to terminal state; it does not claim an unrecoverable external browser process must eventually close. If every raw close attempt rejects forever, the Context remains non-terminal, fail-closed, owned, and retryable. A successful later raw close plus successful drain reaches `CLOSED` and releases ownership.

Tests must cover at least:

- first raw close rejects, second owner call succeeds, Guard reaches `CLOSED`, raw close count is exactly two, and ownership is released only after the second attempt;
- two callers overlapping the retry share one second attempt;
- invalidation during normal close remains sticky through failure and retry;
- raw close succeeds but drain times out, then a later attempt retries only the drain and reaches `CLOSED` without a second raw close;
- factory, interaction session, and construction-error retained Context all use the same canonical retry path.

## 5. Total DOM-work budget

### 5.1 Budget definition

`INTERACTION_CANDIDATE_LIMITS` gains one shared constant:

```ts
maxDomWork: 16_384
```

One invocation of candidate discovery, exact candidate-handle resolution, or retained-handle inspection creates exactly one mutable browser-local budget with `remaining = maxDomWork`. No page-visible global, DOM marker, string evaluation, or cross-invocation mutable state is allowed.

A unit is consumed before each of these operations:

- accepting a node returned by document/candidate `TreeWalker.nextNode()`;
- inspecting one candidate element for selector membership/facts;
- visiting one element in a visibility ancestor walk;
- accepting a node returned by descendant-text traversal;
- resolving one `aria-labelledby` or `aria-controls` node lookup;
- comparing one enumerated candidate with the retained target during live-ordinal determination.

The same node may consume more than one unit when separate work is performed on it. This is intentional: the bound covers total work, not unique node identity.

### 5.2 Eliminate whole-DOM selector enumeration

`document.querySelectorAll(INTERACTION_CANDIDATE_SELECTOR)` is forbidden in both discovery and retained inspection.

Candidate enumeration uses an incremental `TreeWalker` with `NodeFilter.SHOW_ELEMENT`. Each returned element is charged before `matches(INTERACTION_CANDIDATE_SELECTOR)` or equivalent local predicate evaluation. Traversal stops immediately when:

- the total DOM-work budget is exhausted;
- `maxCandidates` complete candidate records have been retained;
- the walker reaches the end of the document.

No NodeList/array materialization, unbounded selector engine result creation, recursive DOM function, `textContent`, or `nodeValue` is allowed.

### 5.3 Shared budget across candidate facts

Candidate enumeration and all facts for candidates retained by that invocation use the same budget instance. In particular:

- descendant text does not receive a new 512-node allowance for each helper call;
- accessible-name label roots share the invocation budget with candidate enumeration and normalized text;
- target and controlled-element visibility ancestor walks share the same budget;
- a candidate is appended only after all required facts have been collected within budget.

If the budget is exhausted while building a candidate, that partial candidate is discarded. Previously completed candidates remain immutable evidence, but the result is explicitly incomplete.

The existing text caps (`maxTextNodes`, `maxTextLength`, and character limits) remain secondary local caps. Reaching either the local text cap or the total budget stops text traversal immediately.

### 5.4 Structured discovery completeness

The canonical discovery function returns a structured result rather than an array that can hide incomplete traversal:

```ts
export interface InteractionCandidateDiscoveryResult {
  readonly candidates: readonly InteractionCandidate[];
  readonly completeness:
    | 'COMPLETE'
    | 'CANDIDATE_LIMIT_REACHED'
    | 'DOM_WORK_BUDGET_REACHED';
  readonly domWorkUsed: number;
}
```

The object, candidate array, candidates, and nested candidate geometry are immutable. `domWorkUsed` is a safe integer in `[0, maxDomWork]`.

Callers must not treat absence from an incomplete discovery as proof that a candidate is missing. During isolated rediscovery:

- no match plus `COMPLETE` means `MISSING`;
- no match plus either incomplete status means `NOT_VERIFIABLE` with the structured completeness reason;
- a unique exact candidate match may proceed only if that candidate record itself was completed before budget exhaustion;
- ambiguity remains fail-closed regardless of completeness.

### 5.5 Bounded exact-handle resolution and retained inspection

The existing unbounded locator/selector enumeration used to acquire the ordinal candidate must not become an escape hatch. `discover-candidates.ts` owns a bounded exact-handle resolver used by `isolated-auditor.ts`. It incrementally traverses candidate elements under its own `maxDomWork` invocation budget and returns one of:

```text
FOUND(handle, domWorkUsed)
MISSING(domWorkUsed)
DOM_WORK_BUDGET_REACHED(domWorkUsed)
```

The resolver does not classify or click. A non-null returned Handle enters the existing exactly-once Handle owner/finalizer immediately.

Retained inspection returns a discriminated result:

```text
CONNECTED(candidate, domWorkUsed)
DISCONNECTED(domWorkUsed)
DOM_WORK_BUDGET_REACHED(domWorkUsed)
```

Live ordinal determination uses incremental bounded candidate traversal and the same budget instance as the retained candidate's text, visibility, controlled-state, and label work. A budget result maps to `NOT_VERIFIABLE`, never `MISSING`, `MATCHED`, or `VERIFIED`.

### 5.6 DOM budget test contract

Tests must make the old implementation genuinely RED and prove the new work bound without asserting private source text:

- a large DOM with no early candidate proves discovery performs no more than `maxDomWork` charged node operations;
- a matching candidate after the total budget is not returned and completeness is `DOM_WORK_BUDGET_REACHED`;
- deeply nested visibility ancestors consume the same discovery/inspection budget;
- many candidate subtrees cannot receive independent reset text budgets;
- exact-handle resolution cannot use an unbounded selector query;
- retained live-ordinal scanning and candidate fact collection share one budget;
- discovery, resolution, and inspection each expose budget exhaustion distinctly from missing/disconnected;
- all existing selector semantics, candidate order, identity, `aria-labelledby`, `aria-controls`, visibility, hostile text, and exact-node behavior remain covered.

## 6. Structured interaction outcomes

### 6.1 Work outcome becomes public immutable evidence

The internal `InteractionWorkOutcome` becomes an exported immutable result component:

```ts
export interface InteractionWorkOutcome {
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
}
```

It records the outcome established by navigation, rediscovery, admission, click, observation, and Handle disposal-finalization boundaries before Context owner close is adjudicated. It is never rewritten to describe lifecycle cleanup.

### 6.2 Lifecycle outcome is a separate axis

The result also contains:

```ts
export type InteractionLifecycleOutcome =
  | {
      readonly status: 'CLOSED';
      readonly reason: string | null;
    }
  | {
      readonly status: 'NON_TERMINAL';
      readonly reason: string;
    };
```

`InteractionGuardedSession` exposes a read-only terminal query delegated to the Guard's canonical phase. It does not own or infer another lifecycle state machine.

After `session.close()`:

- fulfillment with Guard `CLOSED` yields `{ status: 'CLOSED', reason: null }`;
- rejection with Guard `CLOSED` yields `{ status: 'CLOSED', reason: boundedCloseReason }`, preserving cases where invalidation reached terminal state but the semantic close call reports safety invalidation;
- rejection while the Guard is non-terminal yields `{ status: 'NON_TERMINAL', reason: boundedCloseReason }`;
- fulfillment while the Guard is non-terminal is an invariant violation and yields `NON_TERMINAL` with a bounded invariant reason.

Handle-disposal and listener-cleanup failures remain structured Safety Ledger entries. The lifecycle axis records Context owner close/terminal state; it does not duplicate every ledger event.

### 6.3 Final result shape and compatibility

`InteractionAuditResult` becomes:

```ts
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

The existing top-level fields remain for downstream compatibility:

- `evidence` is the same immutable object as `work.evidence`;
- `status` is the conservative final verdict;
- `reason` describes only why that final verdict was selected and must not encode `work.status` or `work.reason` into an ad-hoc sentence.

Final verdict precedence is:

1. any final freeze/safety activity that requires blocking -> `BLOCKED_BY_SAFETY`;
2. lifecycle `NON_TERMINAL` or a close rejection/invariant -> `BLOCKED_BY_SAFETY`;
3. otherwise preserve `work.status` and `work.reason`.

Examples:

```text
work.status     = VERIFIED
work.reason     = Observable interaction state changed
lifecycle       = NON_TERMINAL / context close failed
final.status    = BLOCKED_BY_SAFETY
final.reason    = Interaction owner lifecycle did not reach terminal state
```

```text
work.status     = EXECUTION_FAILED
work.reason     = original click failure
lifecycle       = CLOSED / invalidated
final.status    = BLOCKED_BY_SAFETY
final.reason    = Interaction owner close reported a safety failure
```

The original work reason/evidence are read from `result.work`, not parsed from `result.reason`.

### 6.4 Snapshot and immutability boundary

The work outcome is finalized first. The owner close attempt then runs. The final Safety Ledger snapshot and lifecycle outcome are captured after that attempt settles. The returned result, work, lifecycle, evidence, arrays, candidates, and Safety Ledger snapshot are deeply immutable and retain no live ledger references.

Session-factory rejection remains the sole case where `auditInteraction()` rejects without an `InteractionAuditResult`, because no session/ledger owner exists.

### 6.5 Structured outcome tests

Tests must cover at least:

- `VERIFIED` work plus non-terminal close failure: final `BLOCKED_BY_SAFETY`, unchanged structured `work`, structured `NON_TERMINAL` lifecycle, and close failure in Safety Ledger;
- `EXECUTION_FAILED` work plus close failure: original status/reason/evidence remain directly accessible without string parsing;
- freeze activity after `VERIFIED` work: final blocked status while `work.status === 'VERIFIED'`;
- successful terminal close: lifecycle `CLOSED` and final status equals work status when no safety precedence applies;
- terminal invalidation whose semantic close reports an error: lifecycle remains `CLOSED`, final blocked status, and no false ownership retention;
- all nested result surfaces are immutable.

## 7. Files in scope

Expected production changes:

- `src/safety/passive-request-guard.ts`
- `src/browser/context-factory.ts`
- `src/safety/interaction-policy.ts`
- `src/interaction/discover-candidates.ts`
- `src/interaction/isolated-auditor.ts`

Expected test/fixture changes:

- `tests/component/context-factory.test.ts`
- `tests/integration/passive-request-guard.test.ts`
- `tests/integration/isolated-interaction.test.ts`
- bounded hostile fixture(s) under `fixtures/site/`

The implementation plan may narrow this list after tracing exact consumers, but it must not omit a required owner or add Task 12 work.

## 8. Required TDD sequence

Production code may change only after genuine RED evidence for each finding:

1. lifecycle retry and overlapping-owner REDs;
2. whole-DOM/ancestor/shared-budget REDs;
3. structured work/lifecycle result REDs.

Each RED must fail because the old production behavior violates the new contract, not because of a type error, missing fixture, or test harness mistake. The report must identify the production mutation each test kills.

Implementation proceeds one finding at a time with focused GREEN before the combined regression.

## 9. Required verification and independent review

After correction, fresh runs must include at least:

- Task 11 focus tests;
- full `tests/integration/isolated-interaction.test.ts` regression;
- lifecycle race/retry tests;
- DOM budget tests;
- `npm run typecheck`;
- `npm run build`;
- fresh independent specification review;
- fresh independent code-quality review.

The implementation plan must also run the six-file Task 11 regression and the repository suite unless a concrete environment gap prevents them. Every omitted command/gate must be recorded in the required `NOT RUN` format with reason, impact, and whether it blocks completion.

Independent review must explicitly adjudicate:

- retry liveness after raw close failure;
- single-flight overlap and raw-close cardinality;
- terminal-only owner release;
- invalidation-over-normal-close priority across retry;
- no `querySelectorAll()` or other unbounded selector enumeration in discovery, bounded handle resolution, or retained inspection;
- one shared budget across enumeration, visibility, labels/controls, text, and live ordinal;
- explicit budget exhaustion semantics;
- structured preservation of work status/reason/evidence;
- lifecycle truthfulness for terminal versus non-terminal close outcomes;
- S03-S08 zero-delivery and existing exact Handle ownership.

PASS requires Critical 0, Important 0, all required executed verification PASS, and a complete not-run ledger.

## 10. Non-goals

- Task 12 or later implementation;
- automatic background retries, retry timers, retry counts, or retry backoff;
- declaring a failed-close Context terminal or releasing it without confirmed `CLOSED`;
- a second lifecycle/recovery manager;
- unsafe interaction retry;
- site-specific selectors or target logic;
- DOM mutation/markers used to track budget;
- dependency/package changes;
- live-target access;
- Git operations.

## 11. Completion criteria

Task 11 remains unapproved until all of the following are true:

1. every non-terminal invalidating Context retains a canonical owner path for a later close/drain retry;
2. a later successful attempt reaches `CLOSED`, and overlapping attempts remain single-flight;
3. factory/session ownership is released only after canonical terminal confirmation;
4. discovery, exact-handle resolution, and retained inspection have finite total DOM work with explicit exhaustion outcomes;
5. whole-DOM `querySelectorAll()` enumeration and unbudgeted visibility ancestor traversal are absent from those paths;
6. work status/reason/evidence and lifecycle close/terminal outcome are separately structured and immutable;
7. final status remains fail-closed without destroying the original work outcome;
8. all required fresh tests/typecheck/build pass;
9. independent specification and quality reviews report Critical 0 and Important 0;
10. not-run items are explicitly recorded, and Task 12 has not started.

## 12. Author self-review

### Requirement coverage

| Binding requirement | Design authority |
| --- | --- |
| Failed raw close has a later terminal-recovery owner path | Sections 4.2–4.5 |
| Invalidation remains higher priority than normal close | Sections 4.1 and 4.3 |
| Ownership releases only after terminal state | Sections 4.3–4.4 |
| Discovery/inspection has one total DOM-work budget | Sections 5.1–5.5 |
| Whole-DOM selector enumeration is removed | Sections 5.2 and 5.5 |
| Visibility ancestors and text share the total budget | Sections 5.1 and 5.3 |
| Budget exhaustion is not hidden as missing/complete | Sections 5.4–5.6 |
| Original work status/reason/evidence remains structured | Sections 6.1 and 6.3 |
| Lifecycle/cleanup truth is a separate structured axis | Sections 6.2–6.4 |
| Final verdict remains fail-closed | Section 6.3 |
| Required fresh gates and independent review | Sections 8–9 |
| Task 12 remains blocked | Sections 1, 7, 10, and 11 |

### Consistency and scope audit

- No placeholder, undefined decision, or deferred implementation choice remains.
- `CLOSED` is the only terminal release authority; a fulfilled or rejected attempt does not independently authorize release.
- `rawCloseConfirmed` prevents a drain-timeout retry from issuing a second physical close, while a raw-close rejection remains retryable.
- Discovery completeness, exact-handle resolution, and retained inspection distinguish budget exhaustion from absence.
- The structured `work` and `lifecycle` axes do not create a second interaction-status or Guard-phase authority.
- The additive top-level fields preserve current downstream consumption while removing the need to parse work facts from a reason string.
- All production changes remain inside existing semantic owners. No dependency, Git, live-target, or Task 12 work is included.
