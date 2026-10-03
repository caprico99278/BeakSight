# Task 11 Architecture Recovery Fix Round 4 Independent Quality Review

## Verdict

**NEEDS FIXES — Critical: 0; Important: 2; Minor: 4.**

The explicit closing-to-invalidating priority change and terminal-only Context/session ownership release are coherent. The full lifecycle still has two uncovered asynchronous paths that prevent approval: an uncontained event-listener rejection, and route work that is absent from the final evidence drain. These are newly identified findings in existing lifecycle code, not claims that Fix round 4 introduced both paths. Task 11 remains unapproved.

## Authority and integrity verification

The supplied review-package SHA-256 matched before review:

`5C2E4B18EEA3052B8004FA24171B1409799446AD648622037A426D5083F4DF99`

All five package authority hashes matched:

| Authority | SHA-256 |
|---|---|
| Original fixed review package | `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44` |
| User lifecycle-priority brief | `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718` |
| Implementer Task 5 report | `679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA` |
| Entering round-2 specification review | `82FEF3577F9798977EE690D999E4E2E44B62D248EA51A91F2691C27D8512CD7F` |
| Entering round-2 quality review | `407B708DB455050AD573C65080F5CD6A512275F0D41ECC5C47014D5D58E2B1B8` |

The substituted manifest contains exactly 48 unique paths: 48/48 current hashes match, exactly six substitutions are used, all other 42 original entries remain byte-identical, and no file is missing. The source/test inspection started after this manifest verification. Package and lock hashes are unchanged. The additional report hashes for `dist/safety/passive-request-guard.js`, `dist/browser/context-factory.js`, `tsconfig.json`, and `tsconfig.build.json` also match. The existing built Guard, whose SHA-256 is `D6626E771156BE6F58506B67BC600C03F4CF3901F7EFC522E2160EEEF3EFA8D1`, was used for the two narrow read-only probes below.

The assessment derives from independent inspection of the entire Guard and Context factory, their audit finalizer consumer, relevant bounded-ownership/traversal/evidence surfaces, and the actual test bodies. The implementer and specification-review conclusions were not used as proof of correctness.

## Important findings

### I1 — Contain invalidation rejection at the failed-request event boundary

**Locations:** `src/safety/passive-request-guard.ts:1220`, `:1226`, `:1235`, `:1249`, `:1271`, and the event registration at `:1278`.

`onRequestFailed` is registered directly as an asynchronous Context event listener. Its failure branches await `invalidateContext()`. That completion is intentionally rejecting when the bounded drain expires (`:467-469`, or the normal-close completion rejection at `:808-812`). Nothing observes/contains the rejection of the event listener's own returned Promise. Observing the shared close Promise elsewhere does not observe this separate Promise.

A deterministic local probe installed the actual built Guard, admitted one frozen Download whose cancellation remained pending, then invoked the installed `requestfailed` listener with a navigation whose frame classification throws. The process-level `unhandledRejection` observer received the drain-timeout Error. The public owner join also correctly rejected, but that did not prevent the event rejection:

```json
{"probe":"requestfailed-drain-timeout","unhandled":["Guard-owned listener tasks did not settle before cleanup deadline"],"ownerOutcome":"Guard-owned listener tasks did not settle before cleanup deadline","rawCloses":1,"closed":false}
```

This is not solely a fake-emitter convention. The installed Playwright event emitter invokes the returned Promise and rethrows rejected listener results when no rejection handler is configured (`node_modules/playwright-core/lib/coreBundle.js:10745-10760`). Exact `off()` removal does not install an error observer for already-running listeners. On normal Node unhandled-rejection settings this can terminate execution while the audit is trying to produce its fail-closed result.

**Required correction:** make fire-and-forget event invalidation use the same contained initiation discipline as the CDP callbacks, while preserving the rejecting public owner completion and avoiding adding a task that awaits its own drain. Audit other bare invalidation initiators as part of the same correction, including the installation-phase `onPage` branch at `:1143`. Add a focused failed-request-plus-drain-timeout regression asserting no unhandled rejection, one raw close, a retained non-terminal owner, and the unchanged public timeout result. The existing overflow containment test at `tests/integration/passive-request-guard.test.ts:2353` only exercises the reserved overflow Promise; it cannot detect this separate event-listener Promise.

### I2 — Include already-running route callbacks in the evidence cutoff

**Locations:** HTTP route registration at `src/safety/passive-request-guard.ts:1342`; `continueNative()` at `:613-624`; WebSocket route registration at `:1281`; `drainGuardTasks()` at `:343-370`; terminal transition at `:807-819`.

The HTTP and WebSocket callbacks are asynchronous Guard work but never enter `pendingTasks`. Only tracked Page/CDP/download/popup work is included in the bounded drain. A callback that already captured its phase and is awaiting a protocol operation can therefore continue after `closePassiveGuardedContext()` reports success and sets `CLOSED`. Its later failure is appended to the ledger after the final snapshot; a subsequent call to `invalidateContext()` is discarded by the `CLOSED` early return at `:426`.

The narrow local probe used the actual built Guard, with a deferred `route.fallback()` at the Playwright boundary:

1. Start an allowed non-navigation GET callback in `PASSIVE_ACTIVE`; its fallback Promise remains pending.
2. Activate interaction freeze, then call guarded Context close. Raw close succeeds once.
3. Guarded close resolves and the terminal query returns true while the route is still pending.
4. Reject the fallback. The route now records `HTTP_FALLBACK_FAILED` after the purported cutoff; invalidation sees `CLOSED` and does nothing.

```json
{"probe":"in-flight-route-cutoff","closeOutcome":"resolved","rawCloses":1,"closed":true,"beforeLateFailure":[],"afterLateFailure":[{"code":"HTTP_FALLBACK_FAILED","message":"late fallback failure"}]}
```

This violates the approved recovery design's section 4.3 requirement that already-started callbacks settle before close completion, and section 8.3's authoritative final snapshot. By inspection, an audit whose work has already become `VERIFIED` can preserve that status because its close resolves and its snapshot misses the later invariant (`src/interaction/isolated-auditor.ts:121-136`, `:371-389`). The probe directly demonstrates the premature Guard cutoff; that audit-status consequence is a trace through the unchanged finalizer, not a claim of a separately executed end-to-end browser reproduction.

There is no documented ownership transfer to raw Playwright close: inspection of the installed implementation shows that `BrowserContext.close()` awaits channel/Context closure, not completion of active route handlers (`node_modules/playwright-core/lib/coreBundle.js:61951-61976`, `:62194-62203`). The current tests avoid the gap by awaiting the HTTP/WebSocket callback before releasing the Context-close gate, for example `tests/integration/passive-request-guard.test.ts:1012-1014` and `:1043-1047`.

**Required correction:** give in-flight protocol callbacks bounded ownership through their error/evidence finalization and stop new callback admission at the terminal boundary. Preserve raw-close-once and ensure a tracked callback never awaits the same completion that drains it. Add a regression with a protocol operation still pending when raw Context close succeeds, then reject it and assert that the owner cannot report normal completion or publish its final evidence before the failure is accounted for. Cover both relevant HTTP and WebSocket routes rather than only adding an extra finalizer status check.

## Fix-round requirement adjudication

| Requirement | Independent result |
|---|---|
| Active-only operation cannot discard factory close ownership | Correct in inspected production: `#requireActiveGuardedContext()` only checks eligibility (`context-factory.ts:166-169`). The gated real-session regression at test line 253 exercises an intervening rejected activation before owner join. |
| Same public invalidation outcome before/after successful invalidation completes | Correct for an invalidation already accepted by the Guard: public joining close rejects after completion (`passive-request-guard.ts:773-782`), and the `CLOSED` observer rejects with the same message through the active-state requirement. Tests cover both join timings and final cleanup evidence. |
| Invalidation outranks both normal closing phases | Correct: lines 438-445 promote synchronously and join the published completion. Both frozen and passive identity are retained by `invalidatingPhase()`. |
| Completion publication before re-entrant raw close | Correct: invalidation's start gate is published at lines 448-481; normal close publishes at lines 785-796 before calling raw close. The resolver continuation and final phase transition have no intervening await. |
| VERIFIED work, close, then accepted invalidation | Correct for the tested event path: lines 817-819 reject after drain, feeding the existing safety finalizer while retaining work evidence. I2 prevents extending that conclusion to all already-running callbacks. |
| Ordering convergence | The real-factory audit tests compare both orders, full safety snapshots, changed evidence fields, and raw-close cardinality (`isolated-interaction.test.ts:1204-1273`). They catch restoration of the closing-phase early return. |
| Raw-close rejection retains a valid owner join | Correct for existing factory/session ownership: Context deletion and session terminal marking are conditioned on the Guard's `CLOSED` query (`context-factory.ts:109`, `:156`); later calls rejoin the recorded completion without another raw close. The failed raw-close test checks an actually still-open Page. |
| Page readiness and guarded Page-close failure paths | Context ownership now follows the same terminal query; readiness cleanup enters the factory owner path. Both parameterized regressions check repeated later joins and one raw close (`context-factory.test.ts:348-370`). |
| Read-only terminal query is not another phase authority | `isPassiveRequestGuardClosed()` is a direct read of `guardStates.get(context)?.phase === 'CLOSED'` (`passive-request-guard.ts:704-707`). It writes no state. Factory/session markers reflect terminal ownership only; active eligibility still delegates to the Guard. |
| Bounded drain and timeout stability | Correct for admitted tracked tasks and shared owner results; timed-out owners remain non-terminal and cannot later succeed. I1 and I2 are remaining holes at the event/protocol boundaries. |

## Preserved surfaces and test strength

- Pending-task admission is checked before factory invocation, capped at 256, and deletes owned tasks in `finally`. The reserved overflow completion is observed without self-draining. Expected-failure and redirect registries retain their caps, expiry, exact matching/consumption, and overlong-identity rejection.
- Listener ownership is bounded by 64 Page/CDP groups plus the Context group. The owner removes a group before running exact inverses; each inverse is attempted once, errors are ledgered, and subsequent cleanup continues. Partial Page/CDP installation releases its incomplete group; raw Context close failure retains the fail-closed installed groups. No new listener cleanup regression was found, apart from the callback containment/cutoff issues above.
- Guard error normalization handles null/undefined/primitives and hostile property access without allowing normalization errors to replace the owner result. Its bigint branch avoids decimal conversion. Separate failure-presence flags preserve undefined rejections in raw Context close, unready navigation abort, and the audit finalizer. See Minor M4 for the unchanged audit normalizer's narrower allocation bound.
- Both browser-side descendant collectors use the same SHOW_ALL algorithm and increment the shared per-root-group node count before filtering for text; each group has the 512-node/1,024-character budget. Candidate selection and retained ordinal lookup use bounded indexed access. No discovery code changed in this round. Replacing approved `querySelectorAll()` or redesigning ancestor traversal remains an out-of-scope future design topic, not a checkpoint finding.
- Every non-null acquired ElementHandle is inside the single `try/finally` disposal scope before deadline/admission branches. Disposal errors are caught and ledgered. The audit finalizer keeps freeze-before-close-failure-before-work precedence, preserves the immutable work evidence, records close rejection independently of its value, and obtains a detached Safety Ledger snapshot.
- Safety Ledger event collections, method keys/counters, and stored text remain bounded; snapshots copy and freeze entries and containers. Interaction change evidence and candidate geometry are detached/frozen.
- S03-S08 tests retain actual fixture request observations and mutation/download/upgrade counters. Generated data-URL download cancellation is distinguished from HTTP download zero delivery. Mechanical rejection, popup/navigation/mutation/WebSocket blocking, and Service Worker absence are still asserted. This review did not rerun those already-evidenced browser suites.
- The four changed close-success expectations are legitimate contract corrections: deferred download cancellation, deferred popup close, mismatched lifecycle correlation, and expired lifecycle correlation each trigger invalidation while close is pending. Their late-evidence/correlation assertions remain present. Replacing resolution with deterministic invalidation rejection does not weaken those proofs.
- The new priority tests use the real factory/session and `auditInteraction()` with the gate/failure injection at the raw Playwright boundary. The status/evidence assertions would fail if closing invalidation were dropped; the repeated-owner assertions would fail if unconditional ownership deletion or early session closure returned. They are strong for their named mutations, but do not replace coverage of I1/I2.

## Minor findings

1. **M1 — Historical/deferred, in scope:** `src/safety/passive-request-guard.ts:1355`. Passive lifecycle HTTP aborts do not add the exact Request to `expectedRouteFailures`. A matching `blockedbyclient` failure can be treated as a new allowed-delivery invariant while close is pending. This is the carried HTTP correlation Minor; it is distinct from the untracked callback cutoff in I2.
2. **M2 — Historical/deferred, test helper:** `tests/integration/passive-request-guard.test.ts:316` and `:322`. `emitFailedMainFrameRequest()` declares `void` and drops the async listener return, so callers cannot await its completion. This is the carried helper Minor. I1 is a separate production error-containment defect, not a relabeling of this test-helper cleanup.
3. **M3 — Historical/deferred, maintainability:** `src/safety/passive-request-guard.ts:879-880`. The page-readiness task factory's long `try` body retains the older indentation, obscuring its ownership scope through line 1085.
4. **M4 — Newly identified, pre-existing in-scope finalizer:** `src/interaction/isolated-auditor.ts:58`. The arbitrary-rejection fallback calls `String(error)` before slicing to 512 characters. Unlike the corrected Guard normalizer, a very large bigint is fully converted to decimal first, so bounded stored output does not bound intermediate normalization work. Prefer the same non-materializing primitive fallback discipline for arbitrary audit rejection values. Existing hostile-error tests prove exception containment but do not cover this allocation behavior. This Minor is based on direct source inspection; no large-allocation stress test was run.

No out-of-scope Minor is included in the count. M4 is newly reported, not newly introduced by Fix round 4.

## Verification performed and limits

Executed by this reviewer:

- SHA-256 verification of the fixed package, all five authorities, all 48 substituted manifest entries, and the additional built-output/TypeScript-config hashes noted above.
- Independent source/test inspection and fresh forbidden-boundary/type-escape scans. The specified scans produced no matches; production contains one `auditInteraction()` entry point at `src/interaction/isolated-auditor.ts:339`.
- One inline `node --input-type=module` process containing two narrow diagnostic probes, only because the concrete event-rejection/cutoff doubts required an execution check. It imported only existing repository build modules; it did not import a dependency, write a test, launch Chromium, or contact any server. Exit code 0 means the diagnostic program completed; the observed output demonstrates the two failed lifecycle properties and is not a passing-test claim.

Not rerun: broad Vitest suites, typecheck, or build. The fixed package records 170/170 lifecycle/finalizer, 219/219 Task 11, 47/47 adjacent, and 434/434 full-suite passes, plus typecheck/build passes and the controller's fresh checks. Those are supplied evidence against the verified files; they do not cover the two newly demonstrated cases. No fresh reviewer environment gap occurred.

No Git operation, dependency change/download/import, live-target access, production/test mutation, or delegation occurred. The only authored file is this requested quality-review artifact, written with `apply_patch`.
