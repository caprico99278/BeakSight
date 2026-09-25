# Task 11 terminal recovery correction — final-quality fix round 1 independent code-quality re-review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: independent quality re-review after the retained ordinal-cap repair. Task 11 remains user-unapproved and product Task 12+ remains blocked.

## Verdict

**PASS — Critical 0 / Important 0 / new Minor 0.**

The previous quality-review Important I1 is addressed. A connected exact retained node at live ordinal 100 is no longer reported as `DISCONNECTED`; it produces a frozen, payload-free `CANDIDATE_LIMIT_REACHED` result, and both auditor consumers map that result directly to conservative `NOT_VERIFIABLE` work with `UNESTABLISHED` identity. The repair preserves ordinal 99 as a valid connected candidate, keeps physical/complete absence distinct from actual DOM-work exhaustion, and retains the existing exactly-once Handle owner. No new Critical, Important, or Minor finding was found in the corrected code or its non-regression surface.

This verdict is the code-quality gate only. It does not approve Task 11, replace the separate specification re-review, or authorize Task 12+.

## Fixed-package integrity

The review package matched required SHA-256 `A35D738CB3807488D5162744BCB3DE306B539092E87AF0474429EB271C115068` before any conclusion.

The complete manifest was independently parsed and recomputed twice: once before source review and once after all inspection and the narrow reviewer test, immediately before this artifact was created. Both passes produced:

- entries: **89**;
- unique paths: **89**;
- matched entries: **89**;
- missing paths: **0**;
- duplicate paths: **0**;
- SHA-256 mismatches: **0**.

The final package recheck still matched the required package hash. This review artifact is intentionally outside the self-nonreferential manifest.

## Prior Important I1 — addressed

### Exact retained identity and the ordinal 99/100 boundary

`inspectInteractionCandidateHandle()` retains the exact `ElementHandle` node and compares each selector-matching enumerated element by object identity (`src/interaction/discover-candidates.ts:603-620`). The result boundary is now truthful:

- a complete traversal that never finds the exact node returns `DISCONNECTED` (`:621-623`);
- the exact connected selector-matching node at live ordinal greater than `maxOrdinal` returns `CANDIDATE_LIMIT_REACHED` (`:624-625`);
- only an in-range exact node receives the separate candidate-facts debit and can publish `CONNECTED` with a complete immutable candidate (`:627-775`).

The new limit result carries only `status` and `domWorkUsed`; it does not construct an invalid ordinal-100 `InteractionCandidate`. Actual total-budget exhaustion remains `DOM_WORK_BUDGET_REACHED` at every scan/fact boundary, while an initially detached node and complete exact-node absence remain `DISCONNECTED`. Thus candidate capacity, identity absence, and total-work exhaustion remain separate facts.

The real-browser regressions acquire ordinal 0, retain that exact handle, and then insert 99 or 100 selector-matching predecessors. Ordinal 99 remains `CONNECTED` with live ordinal 99; ordinal 100 returns payload-free `CANDIDATE_LIMIT_REACHED`, explicitly not `DISCONNECTED`, and the wrapper is frozen (`tests/integration/isolated-interaction.test.ts:554-620`). The existing true-detach and shared-ancestor-budget cases remain separate (`:319-390`), and the overflow fixture independently confirms an already out-of-cap retained node is not called disconnected (`:1255-1275`).

### Work-count semantics and runtime envelope

The retained traversal continues to use one operation-local `domWork` owner. Root/descendant acceptance, matched-candidate identity comparison, the separate retained-candidate facts admission, label/control lookup, descendant-text acceptance, and every visibility ancestor debit the same counter (`src/interaction/discover-candidates.ts:580-739`). The candidate-limit branch occurs only after the charged exact-identity comparison and before any candidate-fact publication; it therefore neither fabricates budget exhaustion nor spends/readies facts that cannot be represented. `domWorkUsed` is validated as a safe integer in `[0, 16_384]` (`:31-35`, `:783-790`).

The Node boundary recognizes exactly the four retained discriminants, requires `raw` only for `CONNECTED`, rejects `raw` on every incomplete/absence result, converts the connected raw record through the existing candidate validator/freezer, and freezes every returned wrapper (`:780-807`). The malformed-envelope matrix rejects candidate-limit raw payload and out-of-range work, while the positive case proves payload absence and wrapper freezing (`tests/integration/isolated-interaction.test.ts:883-910`).

### Both auditor consumers, evidence, and no rediscovery

The pre-admission branch handles `CANDIDATE_LIMIT_REACHED` before `DISCONNECTED` and returns `NOT_VERIFIABLE` with `UNESTABLISHED` evidence (`src/interaction/isolated-auditor.ts:274-298`). The retained-observation branch does the same and returns before the only disconnected rediscovery branch (`:345-375`). Neither path can publish `MISSING`, `REPLACED`, `MATCHED`, `VERIFIED`, or an invalid candidate from this condition.

The two-branch mutation test injects the status separately before admission and during retained observation, makes any second discovery throw, makes an improper pre-admission click throw, and asserts `NOT_VERIFIABLE`, `UNESTABLISHED`, no `MISSING`/`REPLACED`, and exactly one initial discovery (`tests/integration/isolated-interaction.test.ts:1529-1587`). This kills removal of either consumer branch and routing through disconnected rediscovery.

### Handle ownership and disposal

Only `FOUND` transfers an ElementHandle from the resolver after complete metadata/envelope cleanup (`src/interaction/discover-candidates.ts:105-183`). The auditor installs the transferred handle into its single `try/finally` immediately at `src/interaction/isolated-auditor.ts:268-270`; every pre-admission and observation return, including both candidate-limit branches, crosses the exactly-once disposal attempt at `:402-410`. Disposal failure remains a bounded structured Safety Ledger invariant without overwriting the established work result. Existing cleanup tests cover unknown/envelope/property failures, present `undefined` primary rejection, prospective-child reclamation, and outcome-preserving finalizer failure.

## Non-regression quality audit

### Guard lifecycle and terminal ownership

No regression was found in the retryable lifecycle. `ensureCloseAttempt()` publishes the attempt owner before raw close side effects, joins active callers, sets `rawCloseConfirmed` only after fulfillment, preserves sticky invalidation after raw-close failure or drain timeout, and clears only a matching non-terminal rejected attempt (`src/safety/passive-request-guard.ts:437-490`). Invalidation synchronously promotes the phase before joining/starting the attempt (`:493-498`), so close-first and invalidation-first retain the same priority. A later raw-close retry can reach `CLOSED`; a drain-only retry does not issue another raw close.

Factory and session ownership still release only after `isPassiveRequestGuardClosed()` reports canonical `CLOSED` (`src/browser/context-factory.ts:90-101`, `:121-139`, `:151-162`, `:182-188`). Construction failure exposes the retained Context through `ContextConstructionError.context`. The lifecycle tests retain exact retry/overlap/raw-close cardinality, drain-only recovery, hostile rejection containment, construction/session/factory retry, and close-order assertions.

### Total/shared DOM budgets

`maxDomWork` remains the single production constant at 16,384 (`src/safety/interaction-policy.ts:43-51`). Resolution, discovery, and retained inspection each create one callback-local total budget; discovery and inspection each retain one invocation-wide secondary text counter. All production candidate enumeration remains root-inclusive incremental `TreeWalker` traversal. Reviewer static scans found no `querySelectorAll`/locator/nth candidate-enumeration escape and no target identity, string-evaluation, or production DOM-marker mutation.

Candidate records are appended only after complete fact collection, and the retained snapshot publishes a candidate only after the same invocation budget completes all facts. Incomplete discovery/resolution/inspection remains structured and cannot become complete absence or verified work. The previous retained accepted-node/comparison/fact boundary, root inclusion, current live ordinal, text-cap ownership, resolver-envelope validation, and all acquired-handle cleanup corrections remain present.

### Structured work/lifecycle finalizer

The work and lifecycle axes remain separately frozen and queryable (`src/interaction/isolated-auditor.ts:33-51`, `:99-119`). Work is finalized before owner close. Rejection presence is independent of rejection value, canonical terminal truth is read after settlement, fulfilled-but-non-terminal close is ledgered before the final snapshot, and lifecycle truth distinguishes `CLOSED` from `NON_TERMINAL` (`:438-472`). Final precedence remains freeze evidence, non-terminal lifecycle, terminal close rejection, then original work (`:141-165`); safety reasons do not encode the work status or reason. The returned top-level evidence is the same object as `work.evidence`, and the result/safety/evidence surfaces remain detached and frozen (`:472-482`).

### S03-S08 and test strength

The isolated-interaction regressions still assert fixture-server non-delivery for admitted popup, navigation, WebSocket, mutation, generated download, and HTTP download paths, including zero write/download/WebSocket counters (`tests/integration/isolated-interaction.test.ts:1690-1771`). Exact acquired-child click protection, identity-loss classifications, successful exact-node change evidence, deadline behavior, Handle finalization, lifecycle races, and freeze/close precedence remain covered. The three changed production/test files are the only functional substitutions in this fix; Guard, factory, policy, ledger, evidence, package, and lock hashes remain pinned by the matching manifest.

## Reviewer execution

Reviewer-owned evidence was kept separate from implementer/verifier evidence.

Executed read-only checks:

1. read the Superpowers review and completion-verification instructions;
2. verified the fixed package SHA-256 and independently parsed/recomputed all 89 manifest rows before review;
3. read the complete approved correction design and implementation plan, fix brief/report, prior failed quality review, passed specification review, current changed production/tests, Guard/factory/policy/ledger/evidence owners, relevant prior Task 2 reviews, and append-only evidence ledgers;
4. inspected all 808 lines of `discover-candidates.ts`, all 483 lines of `isolated-auditor.ts`, and the relevant lifecycle, DOM-budget, structured-outcome, S03-S08, envelope, and Handle tests;
5. ran static scans for all status producers/consumers, budget owners/debits/DOM reads, forbidden whole-DOM candidate paths, target-specific/string-evaluation/DOM-marker boundaries, and package hashes;
6. ran the narrow existing ordinal/candidate-limit/distinct-outcome focus. The restricted attempt exited 1 before any test with Chromium `spawn EPERM` and 120 skipped; the identical authorized local-process rerun exited 0 with **9 passed / 111 skipped / 120 total**;
7. recomputed the package and every one of the 89 manifest entries after all inspection and execution: package matched, 89/89 entries matched, zero missing/duplicate/mismatch.

Implementer/verifier evidence checked but not relabeled as reviewer execution remains: ordinal focus 9/9; full isolated-interaction 120/120; exact Task 4 focus 40 passed / 213 skipped; lifecycle focus 35 passed / 98 skipped; DOM/ordinal focus 30 passed / 90 skipped; six-file regression 302/302; repository 26 files / 517 tests; typecheck/build exit 0; both forbidden scans clean; fixed package/lock hashes.

## Historical/deferred items

Historical Task 2 I7 remains an irreversible absence of the original pre-implementation discovery/inspection behavioral RED. The fix-round RED proves only the ordinal-cap repair against its frozen baseline. The package, fix report, Task 5 append-only report, and progress ledger preserve that distinction; this review does not relabel it as repaired or retroactive evidence.

The six carried historical/deferred Minor observations remain separate from the new finding count and are unchanged: lifecycle-phase HTTP abort correlation, the failed-main-frame test helper's dropped async result, page-readiness indentation, potentially large successful `String(error)` materialization before slicing, superseded historical-plan examples, and the construction regression's type-only `ContextConstructionError` import/runtime shape assertion. They predate this repair and do not reopen a Critical/Important contract.

## Not-run ledger

NOT RUN
- command: full isolated-interaction, lifecycle, DOM-budget, six-file, adjacent, and repository suites by this reviewer
- reason: the fixed package contains fresh verifier-owned broad runs; reviewer authorization requested a narrow existing test only for concrete doubt and prohibited duplicate broad execution
- impact: broad pass counts remain verifier evidence rather than reviewer evidence; the corrected 99/100 and consumer branches received a separate narrow reviewer run
- completion blocker: no

NOT RUN
- command: `npm run typecheck` and `npm run build` by this reviewer
- reason: the reviewer changed no production/test/type file and the matching package pins fresh post-fix compiler/build exits
- impact: compiler/build results are verifier evidence, not an independently duplicated reviewer claim
- completion blocker: no

NOT RUN
- command: live target access, dependency/library download/install/update/import, package mutation, Git operations, delegation/subagents, and Task 12+
- reason: expressly prohibited or outside this re-review scope
- impact: none of those operations is needed for the quality verdict; Task 12 remains blocked pending the complete controller gate and explicit user approval
- completion blocker: no for this quality verdict; yes for starting Task 12 until the remaining external gates are satisfied

Only this review artifact was created. No production, test, fixture, authority, report, manifest, package, lockfile, configuration, or prior review artifact was edited.
