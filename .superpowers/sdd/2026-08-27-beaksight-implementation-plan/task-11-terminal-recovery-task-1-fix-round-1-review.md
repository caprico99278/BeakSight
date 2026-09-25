# Task 11 terminal recovery — Task 1 fix round 1 independent re-review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: the fixed Task 1 round-1 package, I1/I2, and preservation of the approved Task 1 lifecycle contracts.

## Verdict

**PASS — Critical 0, Important 0, new Minor 0. I1 and I2 are ADDRESSED.**

The current code retains one invalidation Promise for each HTTP/WebSocket callback, preserving the first failed attempt even after the active-attempt slot clears. Hostile raw-close rejection cannot escape the initiation containment path through prototype inspection. No new approval-blocking defect was identified in the complete scoped production files or tests.

This verdict clears this Task 1 re-review gate only. It does not approve Task 11 overall, execute Task 2+, or authorize Task 12. Five named historical/deferred Minors and one separately recorded historical test-strength item are inventoried below; none is silently resolved or counted as new.

## Fixed-package verification and reading scope

Read the round-1 manifest first, then independently computed SHA-256 for every listed path with PowerShell `Get-FileHash -LiteralPath ... -Algorithm SHA256`, comparing each actual digest to the manifest. **15 entries, 15 matches, 0 missing, 0 mismatches.** Manifest SHA-256: `9A4D978BAD4FAE013C450CE5107657D4EC4F118713BCDE1869091A83589C0354`.

| Path | Independently computed SHA-256 | Result |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | MATCH |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | MATCH |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` | MATCH |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` | MATCH |
| `tests/integration/passive-request-guard.test.ts` | `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF` | MATCH |
| `tests/component/context-factory.test.ts` | `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9` | MATCH |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | MATCH |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md` | `17028C242B03A28B85A3E3C0980C45C5C7B12269805FF6D49D497253762E70F9` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `58192365F35F91C2727A7B6C1418294F93971BA2C570303CF63D05FA803BB72E` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `66E0B6642EF7C5E7CAEA04A9C660BAC910148A82AE56DD476A5CE2E56A8BB62C` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-review.md` | `9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-manifest.md` | `32597D2FB33DDEB31E564F6AE022232FEFE99DE176BBB3C9019B285E614DEE45` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-brief.md` | `CF5886FCF9BBB2865AB1ECF106B18CCC370EA843D9D05D2D518ACBA36C51B162` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-report.md` | `C8D7C08FD9F94B223A94EE80AF3B32052AFE8E438B161826B01FD5180E396184` | MATCH |

Read the complete failed independent review, round-1 fix brief and report, approved design, plan introduction and complete Task 1 (lines 59–328), both complete production files, and both complete scoped test files. Checked the pinned controller ruling in the Task 1 report and Task 5 report 687–689, and the historical inventory/status in Task 5 report 679–689 and progress ledger 366 onward. Truncated tool output was followed by narrower reads. No Git provenance was used.

## I1 — ADDRESSED: one protocol callback observes exactly one attempt

Current locations: `src/safety/passive-request-guard.ts:574`, `:586–597`; tests `tests/integration/passive-request-guard.test.ts:2062–2093`.

`runGuardProtocolTask()` removes its owned evidence task at line 586, then calls `invalidateContext()` exactly once at line 590 and stores that returned Promise. The contained initiation view at line 591 and semantic callback wait at line 596 observe this same Promise. Neither observation reacquires the retry-capable owner. The assignment and synchronous phase promotion occur in the same finalization turn, before a waiting task drain can transition to CLOSED.

For a synchronous raw-close throw or a directly rejected Promise, the active attempt can still be cleared at lines 481–486 before `owned.then` runs. That is now safe: the callback-local `invalidation` remains the original rejected Promise, so `await invalidation` rejects with the original raw value before any saved HTTP operation error can be thrown. A WebSocket callback likewise cannot convert the failed first attempt to fulfillment. There is no loop, timer, or second invalidation call in this path. With no other event/owner invocation, the Guard remains non-terminal until a later explicit owner call starts attempt two.

The four new cases exercise installed HTTP and WebSocket handlers at both immediate boundaries. Their `mockImplementationOnce` callback at lines 2070–2073 is deliberately **not async**: it either throws directly or returns `Promise.reject(closeFailure)` directly. Thus it bypasses the extra adoption turns still present in the older harness at lines 222–228. Assertions at 2086–2092 check failure identity, exactly one raw call, non-terminal fail-closed admission, then explicit owner recovery with exactly two raw calls and CLOSED. The reported five-test RED includes both wrong-cause HTTP outcomes and incorrectly fulfilled WebSocket outcomes. This closes the precise timing hole in the failed review.

## I2 — ADDRESSED: hostile raw-close rejection remains contained

Current locations: `src/safety/passive-request-guard.ts:500–515`, `:591`; tests `tests/integration/passive-request-guard.test.ts:2095–2127`.

`containInvalidationFailure()` places the `instanceof GuardTaskDrainTimeoutError` operation inside a try/catch. A Proxy throwing from `getPrototypeOf` is therefore handled before the original value reaches `errorMessage()`. That normalizer guards property access at lines 155–163, truncates strings to the existing 2,048-character bound, and uses a fixed fallback for hostile object/function access and bigint. The raw-close catch at lines 455–463 and containment catch at lines 507–510 independently record bounded messages; the raw rejection identity remains unchanged for the semantic caller. Known drain timeouts still avoid a duplicate initiation-owner entry.

`initiateInvalidation()` returns the fulfilled contained view at line 515, so both void initiation callers and async requestfailed listeners can finish without a hostile-value rejection. The protocol path uses the same helper on its retained Promise at line 591, preventing a separate escaped containment rejection while preserving the callback's intended semantic rejection. The overflow owner separately attaches a value-independent rejection handler at line 526; primary page/install wrappers also use value-independent catches.

The new event test invokes the actual installed requestfailed handler without observing its Promise (2109–2112), crosses two real `setImmediate` turns (2113–2114), and checks no process `unhandledRejection`, both bounded raw/owner failure ledger entries, one failed physical attempt, retained fail-closed state, and explicit owner retry to CLOSED. Its hostile Proxy at test lines 96–107 throws on both prototype and property access. The process observer is removed in `finally`; it does not swallow the assertion evidence. The older async-adoption close timing is acceptable here because this test isolates containment, not I1. Combined with the shared helper's source trace, it covers the original escaped-initiation failure without hiding the public failure contract.

## Preserved Task 1 contracts

References below use `Guard` for `src/safety/passive-request-guard.ts`, `factory` for `src/browser/context-factory.ts`, `Guard tests` for `tests/integration/passive-request-guard.test.ts`, and `factory tests` for `tests/component/context-factory.test.ts`.

| Contract | Current assessment and tight evidence |
| --- | --- |
| Retry liveness and prompt raw failure | PASS. Guard 455–463 rejects before cleanup/drain, and 481–486 clears the non-terminal attempt. Guard 847–861 admits explicit retry. Guard tests 1950–1979 prove persistent rejection remains owned and later success reaches CLOSED. |
| Retained tasks/listeners after failure | PASS. The raw failure exits before Guard 467; no pending set is cleared. Guard tests 755–820 hold retained work through successful retry and check no early settlement; 1413–1468 check actual listener retention for Error and undefined rejection. |
| Overlapping retry callers | PASS. Guard 444 returns the existing attempt; tests 1982–2008 gate attempt two, require zero settled callers while gated, then assert two total physical closes and both invalidation outcomes. |
| Overlapping ordinary close callers | PASS. Guard 855–858 preserves an already-closing phase and shares the attempt. Tests 2011–2031 require both callers pending while gated and one total raw close. |
| Publication before synchronous re-entry | PASS. Guard 448–450 creates a start barrier, 480 publishes the attempt, and 489 releases it. Tests 897–969 retain a re-entrant waiter across both close and drain gates; 2130–2155 verify success and failure/retry invalidation priority. |
| Sticky invalidation over normal close | PASS. Guard 496 promotes synchronously; 470–478 captures invalidation metadata at the atomic terminal transition. Guard 853–861 never downgrades an invalidating phase and rejects normal success after promotion. Deferred cleanup tests 1562–1625 and protocol tests 2688–2731 establish late invalidation precedence. |
| Drain-only retry | PASS. Guard 454 confirms raw close only on fulfillment and 451 skips subsequent physical close. Timeout at 474–476 retains invalidating phase. Tests 1627–1678 and 1681–1722 require one raw close after eventual terminal recovery; the first also requires no repeated listener cleanup. |
| CLOSED only after successful stable drain | PASS. Guard 350–383 transitions through the callback only after the final empty-set observation; 469–478 separates timeout and terminal result. Protocol task deletion and promotion at 586–591 preserve the no-self-drain ordering. Tests 2688–2731 hold HTTP/WebSocket work through the evidence cutoff. |
| Terminal-only factory/session release | PASS. Factory 94–99, 134–136, 155–159, 174, and 185 consult canonical Guard CLOSED. Factory tests 360–387 and 411–433 check a physically open page after failure, explicit retry closure, and subsequent owner rejection. |
| Construction handoff without implicit retry | PASS. Factory 94–95 and 155–156 expose retained Context; 110 rethrows that handoff unchanged. Factory tests 123–178 and 439–471 require one initial failed close, retained ownership, primary cause, later explicit retry, then release. |
| Primary page/install causes | PASS. Guard 835–836, 1144–1145, and 1475–1476 contain secondary invalidation rejection before rethrowing the original. Factory tests 158–165 check exact construction identity/cause chain; Guard test 792 and factory test 456 preserve page-close failure. |
| Bounded failures and no escaped initiation rejection | PASS for the scoped raw-close contract. Guard 36, 138–167, 455–463, and 500–515 bound normalization and contain hostile classification. Guard tests 2095–2127 exercise raw-close hostility; 2642–2686 preserve timeout event containment. |
| Overflow/task admission and terminal cutoff | PASS. Guard 518–537 retains one reserved overflow observer; protocol admission at 569–572 rejects terminal/capped work. Tests 2581–2640 and 2733–2774 retain cap, timeout, no-server-connect, one-close, and immutable-cutoff checks. |
| No second lifecycle authority | PASS. Guard phase remains the admission/terminal authority; `rawCloseConfirmed` is a physical fact and `CloseAttemptResult.invalidated` is terminal metadata. Callback-local `invalidation` only observes an existing attempt. Factory session `closed` is assigned solely from the canonical terminal query. |

## Test strength and verification evidence

The new tests have observable mutation strength: restoring the second protocol invalidation call breaks identity/count/terminal assertions at both immediate timings; restoring unguarded `instanceof` breaks the unhandled-rejection and owner-ledger assertions. Keeping a rejected attempt forever breaks explicit recovery. A per-waiter close breaks the overlap count and pending assertions. Premature CLOSED/release breaks retained-task, physical-page, and factory ownership assertions. Repeating raw close after timeout breaks drain-only cardinality. Moving callback invalidation before removal from pending work breaks the existing protocol drain tests. These are source/test reasoning and the pinned implementer's RED evidence; **no source-mutating mutation run is claimed**.

The fix report accurately distinguishes the initial Chromium `spawn EPERM` environment failure from genuine RED with both production hashes frozen. Its exact final commands and recorded results are:

| Implementer command (not rerun by this reviewer) | Recorded result |
| --- | --- |
| `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"` | RED exit 1: 5 failed / 109 skipped; final GREEN exit 0: 5 passed / 109 skipped. |
| `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry\|drain-only\|retained close\|synchronous re-entry\|lifecycle priority\|round 5\|fix round 1"` | Exit 0: 28 passed / 105 skipped. Table escapes represent literal filter pipes. |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts` | Exit 0: 133 passed. |
| `npm run typecheck` | Exit 0. |
| `npm test` | Exit 0: 26 files / 454 passed. |

Reviewer execution: manifest hashing and read-only source/test/authority inspection only. **No test suite or diagnostic was rerun.** The direct timing override and shared containment implementation resolve the specific doubts by inspection, so an additional probe was not necessary. Reported suite results remain attributed to the implementer, not represented as independent execution.

NOT RUN — reviewer focused/two-file/repository Vitest commands and `npm run typecheck`; reason: no remaining concrete doubt required a rerun, and the fixed package already records fresh verification; impact: execution is not independently reproduced in this re-review; completion blocker: no for this source-review verdict.

NOT RUN — `npm run build`; reason: explicitly excluded from this fix round and review; impact: no fresh emitted-output verification; completion blocker: yes for eventual Task 11 approval, no for this Task 1 re-review.

NOT RUN — Task 2+ implementation and correction gates, final Task 11 dual review; reason: outside this fixed scope; impact: DOM-budget, structured-outcome, and overall checkpoint acceptance remain outstanding; completion blocker: yes for Task 11 overall. Task 12 remains blocked.

## Historical/deferred inventory — not new findings

All five named entries are explicitly preserved by `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md:684` and the failed review. Current in-scope locations were checked:

| Historical item | Reference/current location | Disposition |
| --- | --- | --- |
| Lifecycle-phase HTTP abort lacks expected-route correlation | Guard 1403–1408, compared with requestfailed guard at 1264 and frozen branch registration at 1395 | Historical Minor, unchanged; outside I1/I2 fix. |
| `emitFailedMainFrameRequest()` drops async return | Guard tests 325–337 | Historical Minor, unchanged. The new hostile-event test intentionally invokes the installed handler unobserved; its process assertion is separate. |
| Page-readiness task-factory indentation | Guard 922–924 and 1122–1128 | Historical style Minor, unchanged. |
| Isolated-auditor BigInt/String normalization | Task 5 report 684 | Historical out-of-package Minor. No fresh auditor source adjudication is claimed. |
| Earlier implementation-plan illustration drift | Task 5 report 684 | Historical non-runtime Minor, unchanged; does not invalidate the approved current Task 1 contract. |
| Prior specification review's additional test-strength-only item | Progress ledger 366; failed Task 1 review historical inventory | Separately recorded historical item. This package does not identify its original precise source location; its resolution is not inferred and no source reference is invented. |

No Critical, Important, or new Minor remains from this review. Historical counts are five named deferred items plus one separately recorded prior test-strength item, not six new findings.

## Handoff and constraints

Only this requested review artifact was created, using `apply_patch`. Production, tests, specifications, plans, reports, manifests, packages, and lockfile were not modified. No Git, dependency download/install/import, live target, browser launch, Task 2+ implementation, or subagent operation occurred. The review is independent of implementation and does not rewrite the failed review or historical evidence. All 15 manifest entries are rechecked at handoff; this artifact's digest is supplied separately to avoid self-reference.
