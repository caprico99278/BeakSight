# Task 11 terminal recovery correction — final independent specification review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: the approved Task 11 terminal-recovery, total-DOM-work, and structured-outcome correction only.

## Verdict

**PASS — Critical 0 / Important 0 / new Minor 0.** Six previously recorded historical/deferred Minors remain carried and are classified separately below. Historical Task 2 I7 remains an adjudicated irreversible TDD-evidence deviation; it is still explicit and was not relabeled as repaired.

The implementation satisfies all three user findings and correction completion criteria 1–8 and 10. Completion criterion 9 is procedurally only half-closed at the instant of this review: this independent specification review is PASS, while the separately dispatched final code-quality review remains controller-owned. That pending peer verdict is not an implementation defect and does not permit Task 11 approval or Task 12+. Task 11 can advance to the controller's dual-review gate only if the independent quality review also reports Critical 0 / Important 0.

## Fixed-package integrity

The fixed review package itself independently matched required SHA-256 `24E33E21407B47258036FBCA2489D3E35DA64C2B9E4EC05DF00F57A5BCC4E91E` before conclusions were drawn.

The manifest was parsed independently rather than trusting its declared counts:

- initial recomputation: **85 entries / 85 unique paths / 0 duplicates / 0 missing / 0 mismatches**;
- final recomputation after review and after writing this artifact: **85 entries / 85 unique paths / 0 duplicates / 0 missing / 0 mismatches**;
- package and lock independently remain `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` and `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.

No manifest entry drifted during review. This review artifact is intentionally outside the frozen 85-entry manifest.

## User finding 1 — terminal recovery, ownership, and invalidation priority

**PASS.**

The Guard has one sticky phase authority plus one current-attempt owner. `GuardState` separates `phase`, `rawCloseConfirmed`, and `closeAttempt` (`src/safety/passive-request-guard.ts:95-105`). `ensureCloseAttempt()` returns an active attempt synchronously and publishes a new Promise before the raw close side effect (`:437-490`). Raw-close confirmation is set only after fulfillment (`:451-455`); listeners detach only after confirmation (`:467`); `CLOSED` is assigned only inside the successful final empty-set drain boundary (`:469-478`, with the boundary implemented at `:350-383`). A raw-close rejection promotes or preserves the invalidating phase and rejects (`:455-464`), while the rejection continuation clears only the non-terminal attempt owner (`:480-488`), leaving a later explicit owner call able to retry. A drain timeout retains invalidation and retries the drain without another raw close because `rawCloseConfirmed` remains true (`:451`, `:474-476`).

Invalidation is never discarded during close. `invalidateContext()` synchronously applies `invalidatingPhase()` before joining or starting the canonical attempt (`:493-498`). Owner close preserves whether it entered invalidating and also consumes terminal attempt metadata, so either an invalidating start or invalidation during an ordinary close produces semantic invalidation rather than normal success (`:846-861`). Protocol work publishes only one invalidation Promise and awaits that same attempt; it does not consume an implicit retry after a fast failure (`:560-598`). Arbitrary/hostile rejection inspection is contained (`:500-515`).

Factory/session release is terminal-only. `isPassiveRequestGuardClosed()` is a direct read of the canonical `CLOSED` phase (`:779-782`). Factory construction keeps a failed non-terminal Context and ledger (`src/browser/context-factory.ts:90-101`); page/session construction hands the same retained Context out as `ContextConstructionError` when terminal state was not confirmed (`:105-118`, `:151-162`). A session sets its local retry guard from the canonical query only in `finally` (`:121-139`), and factory close removes `activeContexts` only when that query is true (`:182-188`). Thus a failed physical close remains owned, inactive for browser work, and retryable; terminal semantic invalidation releases the owner even though the close call rejects.

Mutation-proof tests cover the required liveness and ordering:

- first raw close rejection, second owner retry, exact two-call cardinality, and terminal recovery (`tests/integration/passive-request-guard.test.ts:2009-2022`);
- two overlapping retry callers share one second attempt (`:2024-2051`), while overlapping ordinary callers share the original attempt (`:2053-2074`);
- HTTP/WebSocket callback failure remains non-terminal until an explicit owner retry (`:2076-2135`), and hostile unobserved rejection produces no `unhandledRejection` (`:2137-2169`);
- synchronous invalidation re-entry during normal close remains sticky with and without first-attempt failure (`:2172-2198`);
- a confirmed raw close followed by drain timeout retries only the drain, keeps listener cleanup exactly once, and reaches terminal with raw-close count one (`:1627-1679`); the invalidation variant remains sticky (`:1681-1719`);
- session ownership is retained through first close failure and released only after `CLOSED` (`tests/component/context-factory.test.ts:360-390`); direct factory retry does the same (`:413-438`); construction and page/readiness handoffs preserve the same owner path (`:123-182`, `:441-473`).

The user's two race assertions are present at final-result level with real Guard invalidation: close-first after `VERIFIED` is always `BLOCKED_BY_SAFETY` with `lifecycle: CLOSED` and one raw close (`tests/integration/isolated-interaction.test.ts:2398-2461`), and invalidation-first versus close-first has identical final status and safety evidence (`:2463-2474`).

## User finding 2 — one honest bounded DOM-work budget

**PASS.**

`INTERACTION_CANDIDATE_LIMITS.maxDomWork` has one production authority and is exactly `16_384` (`src/safety/interaction-policy.ts:43-51`). Resolution, discovery, and retained inspection each create one callback-local mutable total budget (`src/interaction/discover-candidates.ts:57-69`, `:344-356`, `:578-590`); discovery and retained inspection each also own one invocation-wide secondary text counter (`:357`, `:591`). There is no page-global marker or cross-invocation state.

All three operations use root-inclusive, incremental `SHOW_ELEMENT` traversal rather than a whole-document selector result: resolver `:70-102`, discovery `:505-543`, and retained live-ordinal scan `:592-625`. The accepted-node debit precedes selector inspection; matched-candidate work receives the separate fact/ordinal debit. Retained inspection has distinct debits for accepted-node work, exact-target comparison, and retained facts (`:603-625`). The exact node, not the stale ordinal hint, establishes connection; its current live ordinal is returned (`:614-625`, `:740`).

The same operation-local total budget flows through descendant text (`:366-393`, `:634-660`), every visibility ancestor (`:394-413`, `:661-680`), label lookup (`:414-433`, `:681-700`), control lookup and controlled visibility (`:435-470`, `:702-735`), candidate facts, and live ordinal. The invocation-wide `textWork` cap is shared across label roots, normalized text, and later candidates rather than resetting in each helper. Boundary checks discard an in-progress candidate/snapshot and stop before follow-on geometry or fact reads. Discovery appends only after the complete candidate returns (`:533-538`).

The structured producer outcomes are explicit and runtime-validated: discovery publishes `COMPLETE`, `CANDIDATE_LIMIT_REACHED`, or `DOM_WORK_BUDGET_REACHED` with a safe bounded count and frozen candidates (`:25-29`, `:515-562`); resolution publishes only `FOUND`, `MISSING`, or budget exhaustion and validates discriminant/count/ElementHandle contradictions (`:20-23`, `:105-183`); inspection publishes only `CONNECTED`, `DISCONNECTED`, or budget exhaustion and validates count/raw-shape contradictions before freezing (`:566-568`, `:776-800`).

Handle ownership is exact. Resolver owns every acquired envelope property, including unknown properties; it attempts all property and envelope cleanup, reclaims a prospective child on any pre-transfer failure, preserves a present primary rejection even when the value is `undefined`, aggregates cleanup failures, and transfers the ElementHandle only after successful validation/cleanup (`:37-48`, `:105-183`). The auditor admits a `FOUND` child immediately into one `try/finally` and disposes it exactly once, recording bounded disposal failure (`src/interaction/isolated-auditor.ts:268-398`).

Incomplete work remains fail-closed. Auditor rediscovery maps incomplete absence to `NOT_VERIFIABLE` with `UNESTABLISHED`, not `MISSING` (`:229-247`); resolver and pre-admission inspection budget outcomes do the same (`:257-290`); retained inspection budget exhaustion never triggers disconnected rediscovery (`:339-360`). Only complete absence sites construct `MISSING` evidence.

The correction tests prove the old escape hatches and boundary errors cannot return:

- patched `Document.prototype.querySelectorAll` does not affect discovery (`tests/integration/isolated-interaction.test.ts:244-252`), and late target exhaustion returns exactly 16,384 with no candidate (`:254-266`);
- deep ancestor work discards the partial candidate (`:268-276`), repeated subtrees share total work (`:278-289`), and combined 8,000 preceding nodes plus 9,000 controlled ancestors exhaust one retained-inspection budget (`:339-377`);
- bounded resolution retains a usable real Chromium child after envelope disposal and does not use whole-DOM queries (`:291-308`); late resolution and retained live-ordinal/ancestor work are distinct from missing/disconnected (`:310-337`);
- exact final-identity and final-visibility boundary probes prove no facts, descendant walker, or geometry read occurs after the last allowed debit (`:395-527`);
- the same retained node remains connected with its new ordinal after insertion, and matching document root participates in discovery/resolution/inspection (`:529-580`);
- invocation-wide secondary text ownership is covered across accessible-name/normalized-text, across candidates, and in retained inspection (`:584-651`);
- resolver cleanup, `undefined` primary preservation, malformed envelopes, and child reclamation are covered at `:682-828`; shared 512-node label/text caps and retained NodeList avoidance remain covered at `:1060-1171`.

The deterministic hostile fixture creates exactly 20,000 controlled ancestors, 20,000 pre-target non-candidates, and 100 × 512 repeated descendants (`fixtures/site/total-dom-budget.html:4-32`) with only the scoped deep subtree hidden. Production contains no `querySelectorAll`, `.locator(`, `.nth(`, `textContent`, or `nodeValue` escape in the discovery/auditor path; the fixed verifier's explicit forbidden scan also returned no matches.

## User finding 3 — separate immutable work and lifecycle outcomes

**PASS.**

The exported result contract contains additive `work` and `lifecycle` axes while retaining compatibility fields (`src/interaction/isolated-auditor.ts:33-51`). `outcome()` is the single work constructor and freezes the original bounded status/reason/evidence before owner close (`:99-105`). Lifecycle has separate frozen `CLOSED` and `NON_TERMINAL` constructors with bounded reasons (`:107-119`).

After work is fixed, the auditor calls owner close once, tracks rejection presence separately from rejection value, records close failure, reads canonical terminal truth only after settlement, records fulfilled-non-terminal state before snapshot, and then constructs lifecycle plus the detached final Safety Ledger (`:425-460`). Terminal rejection is truthfully `CLOSED` with its semantic failure reason; physical uncertainty is `NON_TERMINAL`; fulfillment without canonical terminal state is a recorded invariant.

The pure finalizer implements the required conservative precedence: freeze evidence first, then non-terminal lifecycle, then terminal close rejection, otherwise the original work status/reason (`:133-166`). None of the safety reasons interpolate or encode `work.status` or `work.reason`. The returned object is frozen and `result.evidence` is the same object as `result.work.evidence` (`:461-469`). Evidence constructors freeze their arrays/candidates (`src/evidence/interaction-collector.ts:24-61`), candidate geometry is detached/frozen (`src/safety/interaction-policy.ts:139-146`), and `SafetyLedger.snapshot()` copies/freezes its record, arrays, and every event (`src/safety/safety-ledger.ts:180-199`).

Tests cover every required branch:

- `EXECUTION_FAILED` work plus non-terminal close failure retains the original work and separate lifecycle without string parsing (`tests/integration/isolated-interaction.test.ts:2213-2253`);
- `VERIFIED` work remains directly queryable under rejected non-terminal lifecycle, while the final reason contains neither `VERIFIED` nor the work reason (`:2255-2286`);
- fulfilled-but-non-terminal close records the invariant and blocks (`:2288-2318`);
- terminal invalidation rejection remains `lifecycle: CLOSED`, preserves `VERIFIED` work, and blocks the top level (`:2320-2396`);
- `undefined` close rejection presence is retained for both terminal and non-terminal truth (`:2476-2521`), and hostile rejection normalization remains structured (`:2643-2684`);
- click/work failure and close failure keep original changed evidence (`:2686-2765`);
- freeze evidence recorded during close outranks verified work, non-terminal close, and unsafe work (`:2767-2915` and the following unsafe-work case);
- a normal successful result has matching top-level/work status, `CLOSED/null` lifecycle, aliasing identity, and deep frozen result/evidence/Safety Ledger surfaces (`:1545-1576`).

## Correction completion-criteria matrix

| # | Verdict | Independent specification evidence |
| --- | --- | --- |
| 1. Every non-terminal invalidating Context has a later close/drain owner path | **PASS** | Canonical attempt clearing/restart `passive-request-guard.ts:437-498`; factory/session/construction retry tests cited above. |
| 2. Later success reaches `CLOSED`; overlap is single-flight | **PASS** | Atomic terminal drain `:469-478`; overlap/retry tests `passive-request-guard.test.ts:2009-2074`; drain-only tests `:1627-1719`. |
| 3. Factory/session ownership releases only after terminal confirmation | **PASS** | `context-factory.ts:90-101`, `:121-139`, `:182-188`; component tests `:123-182`, `:360-390`, `:413-473`. |
| 4. Discovery, exact resolution, retained inspection have finite total work and explicit exhaustion | **PASS** | Three callback-local owners and discriminants/validation in `discover-candidates.ts`; boundary tests cited above. |
| 5. No whole-DOM enumeration or unbudgeted visibility walk | **PASS** | Root-inclusive TreeWalkers and shared visibility helpers; production/static scans clean. |
| 6. Work and lifecycle are separately structured and immutable | **PASS** | `isolated-auditor.ts:33-51`, `:99-119`, `:425-469`; deep immutability tests `isolated-interaction.test.ts:1545-1576`. |
| 7. Final status is fail-closed without destroying work | **PASS** | Finalizer `isolated-auditor.ts:141-166`; close/freeze/work matrix tests `isolated-interaction.test.ts:2213-2521`, `:2643-2915`. |
| 8. Required fresh tests, typecheck, and build pass | **PASS (package evidence)** | Task 4 report lines 9-29 records focus 40, isolated 113, lifecycle 35, DOM 23, six-file 295, adjacent 47, repository 510, typecheck/build exit 0, and clean scans. |
| 9. Both final independent reviews report Critical 0 / Important 0 | **PARTIAL / controller gate pending** | This specification review is PASS 0/0. The separate quality review is not claimed by this reviewer and must independently pass before checkpoint closure. |
| 10. Not-run ledger complete; Task 12 not started | **PASS** | Task 4 report lines 37-59 and append-only ledgers record both pending reviews plus approval/Task 12; no Task 12 implementation is present or claimed. |

## Fresh verification and safety non-regression

Verifier evidence was checked, not relabeled as reviewer execution. The fresh Task 4 report records:

- exact user-required three-file focus: restricted launch failed before tests with Chromium `spawn EPERM` and was honestly excluded; identical approved process-launch run passed **40 / 206 skipped**;
- full isolated interaction **113/113**;
- lifecycle race/retry **35 passed / 98 skipped**;
- DOM budget **23 passed / 90 skipped**;
- six-file Task 11 regression **295/295**;
- typecheck exit 0; build exit 0;
- adjacent regression **47/47**;
- repository **26 files / 510 tests**, one product-evidence run, no worker exit;
- both forbidden scans clean and package hashes fixed.

S03-S08 safety behavior remains represented by real server-observation assertions: popup/navigation/WebSocket/mutation attempts do not reach their forbidden fixture endpoints and all write/download/WebSocket counters stay zero (`tests/integration/isolated-interaction.test.ts:1578-1600`); generated and HTTP downloads are recorded while `/__download` delivery remains zero (`:1602-1626`). Exact acquired-child click prevention is observed through the browser capture path (`:1628-1695` and subsequent assertions). These tests are part of the fresh 113-test full-file and 295-test six-file evidence. Task 5/11 policy and Safety Ledger owners remain in the matching manifest; this correction did not add a route, classifier, candidate-policy owner, or interaction entry point.

## Historical Task 2 I7 and not-run ledger

Task 2's original pre-implementation discovery/inspection behavioral RED is irrecoverable. It remains explicitly recorded as an evidence deviation at `task-11-recovery-task-5-report.md:717-724`, repeated without relabeling at `:726-735` and `:747-756`, and in `progress.md:391-396`, `:399`, and `:403`. Later correction REDs prove only their frozen correction baselines. This review does not call them retroactive repair and does not count I7 as a new implementation finding.

All required Task 4 Step 1-8 commands were executed. The frozen not-run ledger is complete and truthful:

- independent specification review: superseded only by this artifact;
- independent code-quality review: **NOT RUN by this reviewer** and remains the controller's separate blocking gate;
- Task 11 user approval and Task 12+: **NOT RUN**, correctly blocking product progression.

No other required command is omitted. Historical task-local `NOT RUN` entries are preserved as chronology and explicitly superseded only by later exact evidence; they were not rewritten into prior PASS claims.

## Historical/deferred Minors (not new correction findings)

These six carried observations remain visible and do not affect the Critical/Important PASS threshold:

1. Lifecycle-phase HTTP abort still does not place the exact Request into `expectedRouteFailures` before abort (`src/safety/passive-request-guard.ts:1403-1410`), retaining the documented teardown-correlation edge.
2. The test helper `emitFailedMainFrameRequest()` still returns `void` and drops the asynchronous callback result (`tests/integration/passive-request-guard.test.ts:325-338`).
3. The Page-readiness tracked-task body remains materially mis-indented (`src/safety/passive-request-guard.ts:918-940`).
4. Interaction error normalization can materialize a large successful `String(error)` before slicing it to 512 characters (`src/interaction/isolated-auditor.ts:56-66`).
5. The superseded 2026-08-31 implementation-plan illustrations retain the historical `undefined`-sentinel and close-before-freeze drift; current production and the 2026-09-20 correction authority implement the corrected semantics.
6. The construction regression imports `ContextConstructionError` only as a type and checks the runtime error by name/shape rather than `instanceof` (`tests/component/context-factory.test.ts:3`, `:149-178`); production does instantiate and freeze the exported class (`src/browser/context-factory.ts:25-36`, `:92-100`).

**New Minor: 0. Historical/deferred Minor: 6.**

## Reviewer execution and constraints

Reviewer-run evidence is separate from verifier/implementer evidence. I executed only read-only inspection and hashing before the one authorized artifact write:

1. read the Superpowers requesting-code-review instruction;
2. hashed and read the fixed review package;
3. parsed and hashed all 85 manifest rows with independent duplicate/missing/mismatch counts;
4. enumerated headings/line counts and read the complete correction design, complete correction plan in four contiguous ranges, and complete Task 4 report;
5. used `rg -n` plus numbered `Get-Content` ranges to inspect the complete relevant Guard/factory lifecycle, all 801 lines of `discover-candidates.ts`, the complete auditor, Safety Ledger snapshot, evidence collector, interaction policy, total-DOM fixture, and the cited tests;
6. read the Task 2 failed/fix reviews and reports, Task 3 review, prior final recovery reviews, Task 5 append-only ledger, and progress ledger only as evidence/history, never as inherited conclusions;
7. ran read-only source scans for forbidden selector/locator paths, budget owners/debits/statuses, outcome/finalizer branches, lifecycle owners, historical Minor sites, I7/not-run entries, and Task 12 status;
8. recomputed the fixed package and all 85 manifest hashes at the end.

**NOT RUN by this reviewer:** broad or focused test suites, typecheck, build, browser diagnostics, mutation runs, live target access, dependency/package operations, Git, Task 12+, and any delegated/subagent review. Inspection resolved the specification questions, and the fixed package already contains fresh broad verification; duplicating it was neither needed nor authorized. No production, test, fixture, design, plan, report, manifest, package, lockfile, config, or prior review was edited. This is the only artifact written.

## Handoff

The final specification review gate is PASS with matching manifest and Critical 0 / Important 0. This does **not** approve Task 11 by itself. The controller must combine it with the independently produced quality-review verdict; Task 12 remains blocked until both reviews pass and the user explicitly approves Task 11.
