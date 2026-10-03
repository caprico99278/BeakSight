# Task 11 terminal recovery correction — final quality fix round 1 independent specification re-review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: the approved Task 11 terminal-recovery, total-DOM-work, structured-outcome correction and the final-quality ordinal-cap repair only.

## Verdict

**PASS — Critical 0 / Important 0 / new Minor 0.** Historical Task 2 I7 remains one explicitly adjudicated, irreversible evidence deviation and is classified separately below. Six previously carried historical/deferred Minors also remain separate from the current finding count.

The final-quality repair addresses the prior quality review's sole Important finding without weakening the three original user corrections. A retained exact node at live ordinal 99 remains `CONNECTED` with ordinal 99. The same connected node at live ordinal 100 produces a frozen, payload-free `CANDIDATE_LIMIT_REACHED`, not `DISCONNECTED` and not fabricated DOM-work exhaustion. Both auditor observation sites map that result directly to `NOT_VERIFIABLE` with `UNESTABLISHED` evidence, before the disconnected-rediscovery branch. True detachment remains `DISCONNECTED`, actual total-work exhaustion remains `DOM_WORK_BUDGET_REACHED`, and the existing acquired-Handle owner/finalizer remains unchanged.

This specification PASS does not by itself approve Task 11. Completion criterion 9 remains a controller-level dual-review gate until the separately dispatched final code-quality re-review also reports Critical 0 / Important 0. Task 12+ remains blocked pending that result and explicit user approval.

## Fixed-package integrity

The fixed review package independently matched required SHA-256 `A35D738CB3807488D5162744BCB3DE306B539092E87AF0474429EB271C115068` before any conclusion.

The manifest was parsed mechanically rather than trusting its declared counts:

- initial recomputation: **89 entries / 89 unique paths / 0 duplicates / 0 missing / 0 mismatches**;
- final recomputation after source/evidence inspection and after writing this artifact: **89 entries / 89 unique paths / 0 duplicates / 0 missing / 0 mismatches**;
- package and lock independently remain `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` and `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.

No frozen package entry drifted during review. This review artifact is intentionally outside the self-nonreferential 89-entry manifest.

## Prior Important I1 — retained ordinal-cap truthfulness

**ADDRESSED.** `InteractionHandleSnapshot` now has an explicit `CANDIDATE_LIMIT_REACHED` discriminant with only `domWorkUsed` (`src/interaction/discover-candidates.ts:565-569`). Retained inspection first proves physical connection, incrementally searches for the exact retained element, and keeps complete-traversal absence as `DISCONNECTED` (`:593-623`). Once exact identity is found, `liveOrdinal > maxOrdinal` returns candidate-limit incompleteness immediately (`:624-625`), before candidate-fact collection and before any invalid ordinal can be passed to `candidateFromRaw()`.

The 99/100 boundary is exact:

- ordinal 99 follows the connected candidate-fact path and publishes the live ordinal (`discover-candidates.ts:624-775`);
- ordinal 100 returns `CANDIDATE_LIMIT_REACHED` with the actual bounded work count and no `raw`/candidate data (`:624-625`);
- only actual exhaustion of `maxDomWork` returns `DOM_WORK_BUDGET_REACHED` (`:605-614`, `:627-628`, and the bounded fact helpers);
- physical disconnection or complete selector traversal proving exact-node absence remains `DISCONNECTED` (`:593`, `:621-623`).

Node-side conversion validates that the container is a non-array object, `domWorkUsed` is a safe integer in the shared range, and the status is one of the four exact discriminants (`:780-790`). Only `CONNECTED` may carry `raw`; every non-connected/incomplete status carrying raw candidate facts is rejected (`:792-807`). The public result is newly constructed and frozen, so `CANDIDATE_LIMIT_REACHED` is payload-free and immutable.

The auditor consumes the new status exhaustively at both required points. Pre-admission inspection returns `NOT_VERIFIABLE` with `UNESTABLISHED` evidence at `src/interaction/isolated-auditor.ts:285-290`. Retained observation does the same at `:356-361`, before the `DISCONNECTED`-only rediscovery branch beginning at `:362`. It therefore cannot publish `MISSING` or `REPLACED`, cannot issue a second discovery for this condition, and cannot masquerade as work-budget exhaustion.

Handle lifetime did not change: the `FOUND` child is admitted to the existing owner scope at `isolated-auditor.ts:268-270`, and every return from either candidate-limit branch still crosses the exactly-once disposal `finally` at `:402-411`.

## Repair-test contract and mutation strength

The repair tests kill the demonstrated false-disconnection mutation and distinguish every adjacent outcome:

- real Chromium ordinal 99 requires `CONNECTED` and candidate ordinal 99 (`tests/integration/isolated-interaction.test.ts:554-584`);
- real Chromium ordinal 100 requires exactly `CANDIDATE_LIMIT_REACHED`, no candidate property, a frozen result, and explicitly rejects `DISCONNECTED` (`:586-620`);
- the existing overflow fixture independently exercises a connected candidate at ordinal 100 (`:1255-1275`);
- malformed new-status raw payload and out-of-range count are rejected, while a valid new envelope is converted to a frozen payload-free result (`:883-910`);
- pre-admission and retained-observation cases both require `NOT_VERIFIABLE`, `UNESTABLISHED`, no `MISSING`/`REPLACED`, and exactly one discovery; the retained case throws if rediscovery occurs (`:1529-1587`);
- true detach remains `DISCONNECTED` (`:380-391`), while ancestor and live-ordinal work exhaustion remain exact `DOM_WORK_BUDGET_REACHED` with count 16,384 (`:319-337`).

The accepted pre-production RED was behavioral: four intended failures exposed the old `DISCONNECTED`, missing runtime discriminant, and two missing auditor branches, while ordinal 99, true detachment, true budget exhaustion, and malformed-envelope rejection already passed. Test-only typecheck passed and all production hashes remained frozen through that RED. This repair evidence is correctly limited to the ordinal-cap correction and is not represented as retroactive Task 2 evidence.

## User finding 1 — retryable lifecycle, invalidation priority, and terminal-only release

**PASS / unchanged by the ordinal repair.** The matching frozen Guard and factory sources retain the previously reviewed architecture:

- `GuardState` separates sticky phase, `rawCloseConfirmed`, and the one current `closeAttempt` (`src/safety/passive-request-guard.ts:89-105`);
- `ensureCloseAttempt()` returns an active owner synchronously, publishes a new owner before raw close, confirms raw close only after fulfillment, transitions to `CLOSED` only after the stable drain, clears a failed non-terminal attempt for later explicit retry, and avoids a second raw close on drain-only retry (`:437-490`);
- `invalidateContext()` promotes the phase before joining/starting the attempt (`:493-498`), and owner close preserves invalidation priority through terminal metadata (`:846-861`);
- protocol callbacks retain one invalidation Promise and do not consume an implicit retry (`:560-598`);
- canonical `CLOSED` is the only release query (`:779-782`);
- construction failure retains the Context when non-terminal, session `closed` derives only from the canonical query, and factory membership is removed only after that query is true (`src/browser/context-factory.ts:90-101`, `:105-139`, `:151-162`, `:182-188`).

The frozen lifecycle tests still cover failed raw close then successful owner retry, exact two-call cardinality, overlapping retry single-flight, sticky invalidation during close, drain-only retry with one raw close, and session/factory/construction ownership (`tests/integration/passive-request-guard.test.ts:1627-1719`, `:2009-2051`, `:2076-2198`; `tests/component/context-factory.test.ts:123-182`, `:360-473`). Final-result race tests retain close-first `BLOCKED_BY_SAFETY` and equal invalidation-first/close-first final status (`tests/integration/isolated-interaction.test.ts:2586-2620` and adjacent lifecycle-priority cases). The fresh post-repair lifecycle focus passed 35 tests with 98 skipped.

## User finding 2 — one finite and truthful total DOM-work budget

**PASS.** `maxDomWork` still has one production authority and equals 16,384 (`src/safety/interaction-policy.ts:43-51`). Resolution, discovery, and retained inspection each use one browser-local budget; discovery and inspection each retain one invocation-wide secondary text counter. Incremental root-inclusive `TreeWalker` traversal replaces whole-DOM selector/locator enumeration. The same operation budget charges accepted elements, selector inspection, exact retained comparison, candidate facts, label/control lookup, descendant text, visibility ancestors, and live ordinal. Partial candidates/snapshots do not escape.

The ordinal repair preserves this accounting: retained traversal charges the accepted element and selector/identity work before comparing the exact retained target (`src/interaction/discover-candidates.ts:605-619`), and the candidate-limit return uses the actual accumulated count without performing candidate facts (`:621-628`). The shared fact budget remains in descendant text, visibility, labels, controls, and geometry boundaries (`:638-775`). Static reviewer scans found no `querySelectorAll`, `.locator(`, or `.nth(` in `src/interaction`, and no target identity or production DOM-marker mutation in `src`.

Structured absence/exhaustion remains truthful in the auditor: incomplete discovery and budget outcomes are `NOT_VERIFIABLE`/`UNESTABLISHED`; only complete absence is `MISSING`. The repair adds candidate-limit incompleteness as a third distinct conservative path rather than reusing either absence or work exhaustion. The fresh post-repair isolated-interaction regression passed 120/120 and the DOM/ordinal focus passed 30 with 90 skipped.

## User finding 3 — separate immutable work and lifecycle axes

**PASS.** The ordinal repair did not alter the two-axis result contract or finalization. `InteractionWorkOutcome` and `InteractionLifecycleOutcome` remain exported, immutable, and additive to the compatibility fields (`src/interaction/isolated-auditor.ts:21-50`, `:92-119`). Work is finalized before owner close; close rejection presence is separate from its value; canonical terminal truth is read after settlement; fulfilled non-terminal state is ledgered before the final snapshot (`:413-460`). Final precedence remains freeze, non-terminal lifecycle, terminal semantic close rejection, then work (`:133-166`). The returned result is frozen, and `result.evidence` is the exact `work.evidence` object (`:461-469`).

The current tests retain `EXECUTION_FAILED` and `VERIFIED` work beneath non-terminal close failure, terminal invalidation with `lifecycle: CLOSED`, fulfilled-but-non-terminal invariant recording, arbitrary/`undefined` rejection presence, freeze precedence, aliasing, and deep immutability (`tests/integration/isolated-interaction.test.ts:1690-1720`, `:2358-2518`, `:2622-2915`). The fresh full-file, six-file, repository, typecheck, and build gates all passed after the ordinal repair.

## Correction completion-criteria matrix

| # | Verdict | Independent specification evidence |
| --- | --- | --- |
| 1. Every non-terminal invalidating Context retains a later close/drain owner path | **PASS** | Canonical failed-attempt clearing/restart and retained factory/session/construction ownership cited above. |
| 2. Later success reaches `CLOSED`; overlap remains single-flight | **PASS** | `ensureCloseAttempt()` publication/drain boundary and exact raw-close cardinality tests remain in the matching package. |
| 3. Factory/session ownership releases only after terminal confirmation | **PASS** | Direct `isPassiveRequestGuardClosed()` gates all owner release; failed attempts leave the owner retryable. |
| 4. Discovery, exact resolution, and retained inspection have finite total work and explicit exhaustion | **PASS** | One 16,384 budget per serialized callback, structured statuses, and boundary tests; ordinal cap is now separately truthful. |
| 5. No whole-DOM selector enumeration or unbudgeted visibility walk | **PASS** | Incremental TreeWalkers/shared visibility budget; reviewer source scan clean. |
| 6. Work and lifecycle remain separately structured and immutable | **PASS** | Public frozen axes, detached final ledger, frozen evidence/result surfaces. |
| 7. Final status remains fail-closed without destroying work | **PASS** | Freeze/lifecycle/close precedence retains the original `work` object and evidence. |
| 8. Required fresh tests, typecheck, and build pass | **PASS (fixed-package evidence)** | Ordinal focus 9/9; isolated 120/120; exact Task 4 focus 40 passed / 213 skipped; lifecycle 35 passed / 98 skipped; DOM/ordinal 30 passed / 90 skipped; six-file 302/302; repository 26 files / 517 tests; typecheck/build exit 0; both scans clean. |
| 9. Both final independent reviews report Critical 0 / Important 0 | **PARTIAL / controller gate pending** | This fresh specification re-review is PASS 0/0. The independently dispatched quality re-review is not claimed here and must also pass. |
| 10. Not-run ledger is complete and Task 12 has not started | **PASS** | Fix report, Task 5 report, and progress preserve pending dual review/approval entries; all named Task 12 source/test paths remain absent. |

## Fresh-gate evidence, ledgers, and historical Task 2 I7

The implementer/verifier evidence was inspected rather than relabeled as reviewer execution. After the production repair it records every fix-brief gate as fresh:

- ordinal-cap focus: 9/9;
- full isolated interaction: 120/120;
- exact user-required three-file Task 4 focus: 40 passed / 213 skipped;
- lifecycle race focus: 35 passed / 98 skipped;
- DOM budget plus ordinal boundary: 30 passed / 90 skipped;
- six-file Task 11 regression: 302/302;
- repository: 26 files / 517 tests;
- typecheck and build: exit 0 each;
- both forbidden scans: no matches;
- package and lock: fixed hashes.

The initial restricted Chromium `spawn EPERM` occurred before tests and is explicitly excluded. The identical approved-process RED command then produced the four intended behavioral failures. No named product failure was reclassified as environmental.

Historical Task 2 I7 remains truthful. The missing original pre-implementation discovery/inspection behavioral RED is still recorded as irreversible at `task-11-recovery-task-5-report.md:717-724`, repeated at `:726-735`, `:747-756`, and preserved in `progress.md`. The final-quality RED proves only the frozen ordinal-cap correction. Neither the fix report nor the append-only ledgers describe it as retroactive repair.

The post-repair not-run ledger correctly retains only controller-owned fresh dual re-review and Task 11 approval/Task 12+ progression. This artifact supersedes the specification half only; the quality re-review remains separate. No required implementation verification command is silently omitted under the approved fix brief.

## Historical/deferred items — separate from current findings

**Historical evidence deviation: 1.** Task 2 I7, described above, is irrecoverable temporal evidence absence and is not a current production/specification defect.

**Historical/deferred Minors: 6.** These are unchanged, were not caused by the ordinal repair, and do not affect the current Critical/Important PASS threshold:

1. lifecycle-phase HTTP abort correlation still does not register the exact Request in `expectedRouteFailures` before abort;
2. `emitFailedMainFrameRequest()` still drops the asynchronous callback result in the test helper;
3. the page-readiness tracked-task body remains materially mis-indented;
4. interaction error normalization can materialize a large successful `String(error)` before slicing;
5. superseded 2026-08-31 plan illustrations retain historical error-presence/close-precedence drift, while current production follows the 2026-09-20 authority;
6. the construction regression checks `ContextConstructionError` by name/shape rather than runtime `instanceof`, although production creates and freezes the exported class.

**New Minor: 0.** None of the historical items was silently discarded, promoted, or represented as newly introduced by this repair.

## Reviewer execution and not-run ledger

Reviewer execution was independent and read-only until this one authorized artifact write:

1. hashed the fixed package and read it completely;
2. parsed all 89 manifest rows and independently recomputed count, uniqueness, existence, and SHA-256 match before review;
3. read the complete approved correction design and implementation plan;
4. read the complete final-quality fix brief/report, prior final specification PASS, and prior final quality FAIL;
5. inspected the complete changed discovery and auditor production files, the repair-test blocks, the unchanged lifecycle/factory owners, interaction-policy limits, original Task 11 authority, Task 4 report, append-only Task 5 report, and progress ledger;
6. ran read-only source scans for forbidden selector/locator escape paths, target-specific/DOM-marker production code, and absence of the named Task 12 files;
7. recomputed the package and all 89 manifest entries after writing this artifact.

NOT RUN
- command: broad/focused test suites, browser probes, `npm run typecheck`, or `npm run build` by this reviewer
- reason: source and mutation-test inspection resolved the specification questions; the fixed package already pins fresh post-repair executions, and reviewer instructions prohibit duplicating broad suites
- impact: all pass counts remain implementer/verifier evidence, not reviewer-owned runtime evidence
- completion blocker: no

NOT RUN
- command: independent final code-quality re-review
- reason: separately dispatched controller-owned peer gate; this specification reviewer cannot claim its result
- impact: Task 11 dual-review completion criterion remains open until that artifact reports Critical 0 / Important 0
- completion blocker: yes for Task 11 approval and Task 12+

NOT RUN
- command: Git, dependency/library/package operations, live-target access, delegation/subagents, or Task 12+
- reason: expressly prohibited or outside this review scope
- impact: none of those operations supplies missing specification evidence; Task 12 remains intentionally blocked
- completion blocker: Task 12 remains blocked on clean dual review plus explicit user approval

No production, test, fixture, design, plan, report, package, manifest, lockfile, configuration, or prior review artifact was edited. This is the only artifact created.

## Handoff

The final-quality-fix specification re-review gate is **PASS** with all 89 manifest entries matching and Critical 0 / Important 0 / new Minor 0. The previous ordinal-cap Important is addressed. The controller must still combine this result with the independently produced quality re-review; Task 11 is not user-approved by this artifact, and Task 12+ remains blocked.
