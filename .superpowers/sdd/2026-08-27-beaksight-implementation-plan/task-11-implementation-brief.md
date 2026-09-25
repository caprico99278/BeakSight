# Task 11 implementation brief — Git-free SDD

Status: approved architecture from the user-selected design and implementation plan. Git operations and dependency changes are prohibited.

## Architectural choice

Extend the existing Task 5 guarded-context authority with a one-way interaction-freeze transition. Do not stack an unrelated route layer on top of the passive guard and do not create a second request-policy implementation. A stacked route would make Task 5's `requestfailed` observer interpret intentionally blocked same-origin navigation as an invariant failure; a duplicate guard would split the safety SSOT.

The lifecycle is:

```text
fresh owner-managed context (`serviceWorkers: block`)
-> Task 5 passive guard ready before target navigation
-> initial passive target load completes
-> one-way interaction freeze activates
-> generic candidate discovery and mechanical admission
-> at most one candidate action
-> post-condition evidence and frozen safety events
-> owner closes the disposable context exactly once
```

No context, page, candidate state, or listener may be reused for the next candidate.

## Components and contracts

### `src/safety/interaction-policy.ts`

- Define a bounded immutable `InteractionCandidate` containing a deterministic candidate ID, generic-discovery ordinal, tag, role, accessible-name approximation, text fingerprint, ARIA expanded/controls/selected state, form association/semantics, href, scheme/origin classification, download/type/disabled facts, and bounding box.
- `classifyInteractionCandidate(candidate)` is pure and fail-closed.
- Reject submit/reset controls, implicit-submit buttons, form submission semantics, every navigation href, download behavior, special/external schemes, disabled/non-visible candidates, and malformed/unsupported candidate data.
- Text or button wording is never an admission authority.

### `src/interaction/discover-candidates.ts`

- Use one bounded read-only `page.evaluate()` over the generic union `button,[role="button"],[role="tab"],[aria-expanded],[aria-controls],details>summary`.
- Deduplicate elements in document order and retain at most a documented finite maximum.
- Compute bounded descriptive facts without adding attributes, event listeners, or site-specific selectors. The ordinal refers only to this generic union snapshot.
- Produce deeply immutable detached candidates. Hash bounded normalized descriptive input in Node for `candidateId`/text fingerprint; never persist unbounded page strings.

### Task 5 guard extension and Safety Ledger

- Add a one-way, explicitly asserted transition from active passive guard to `INTERACTION_FROZEN`; activation before the current page guard is ready or after invalidation fails closed.
- Once frozen, every new HTTP request/navigation is aborted by the same guard authority, marked as an expected guard failure, and recorded without generating a false invariant violation.
- The already-installed WebSocket route changes classification to interaction freeze and never calls `connectToServer()`.
- Register popup and download observation before the click. Popups are immediately owner-closed and recorded. Downloads are cancelled and recorded. Any unexpected main-frame or child-frame navigation is recorded/blocked by the route/CDP authority.
- Extend `SafetyLedger` with immutable bounded event categories needed by the design: blocked external actions, interaction requests/navigations, popups, downloads, and interaction WebSockets. Preserve all existing Task 5 public behavior and snapshots.
- Service Workers remain blocked at context creation. Interaction code must not create a context without that option or bypass the guarded factory/session dependency.

### `src/evidence/interaction-collector.ts`

- Collect only detached immutable pre/post ARIA, visibility/state, text fingerprint, and layout facts for the rediscovered generic candidate. Do not create Findings or infer aesthetic/semantic quality.
- A changed ARIA/visibility/state/layout fact is verifiable evidence. Missing/replaced/ambiguous candidate identity is explicit, never silently passed.

### `src/interaction/isolated-auditor.ts`

- `auditInteraction(input)` receives an injected owner-managed guarded session factory, target URL, previously discovered candidate identity, viewport, and absolute/relative interaction budget.
- It performs initial passive load, activates freeze, rediscovers the same candidate deterministically, mechanically classifies it, and clicks only an admitted candidate.
- Result precedence: rejected admission -> `REJECTED_UNSAFE`; any freeze event -> `BLOCKED_BY_SAFETY`; observable allowed post-condition change -> `VERIFIED`; no provable change before deadline -> `NOT_VERIFIABLE`; genuine execution/collection failure -> `EXECUTION_FAILED`.
- Timeout cannot produce VERIFIED. `NOT_VERIFIABLE` is never treated as PASS.
- The owner close runs exactly once in all paths. Preserve both work and close failures rather than discarding either.

## TDD and acceptance evidence

1. Unit RED/GREEN for every mechanical admission/rejection class and immutable bounded candidate inputs.
2. Discovery RED/GREEN proving generic selection, deduplication, stable bounded facts, no page mutation, and no site-specific selector.
3. Real Chromium RED/GREEN for safe accordion (`VERIFIED`, changed ARIA/visibility, zero post-freeze server activity).
4. Real Chromium RED/GREEN for pre-rejected mailto/tel/external/download/form controls and admitted buttons that attempt popup, download, navigation, WebSocket, and Service Worker bypass.
5. Fixture-server assertions, not Playwright intent alone, must prove applicable launch/download/mutation/upgrade target counters remain zero for S03–S08.
6. Guard installation/activation failure must prevent the interaction click. Context ownership and exactly-once destruction require direct tests.
7. Run focused Task 11 tests, Task 5/6/11 adjacent regressions, typecheck, build, and full repository suite. Then freeze SHA-256 review scope and require a fresh independent PASS with no Critical/Important finding.

## Explicit non-goals

- No fixed site selector or candidate allowlist.
- No semantic Finding generation.
- No baseline comparison.
- No hidden wait, hidden skip, raw browser internals, dependency addition/update/download, live target access, or Git operation.
