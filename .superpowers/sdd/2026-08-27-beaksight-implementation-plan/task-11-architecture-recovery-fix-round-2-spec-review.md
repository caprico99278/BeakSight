# Task 11 Architecture Recovery Fix Round 2 Specification Re-review

## Verdict

`PASS` — Critical: 0; Important: 0; Minor: 5.

Review Sweep Completed. This is the required independent specification checkpoint result; it does not perform Task 12 work.

## Package and manifest integrity

- Fix-round-2 review-package SHA-256 matched `F97B44BD15C43423268941E10338FABB500691568CC9C4BF29E786FC68139051` before the package was read.
- Original review-package SHA-256 matched `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`.
- Fix-round-1 review-package SHA-256 matched `EF2BD29AAA782A81A2E7E0006358E6F1EA181C30C327E85127C3A526C83B8FE4`.
- Entering specification-review SHA-256 matched `0A7A7BAF23E40FDCD84A12BE0407B11A5E11BFBF0D9743B0F2D19AA147321BD0`; entering quality-review SHA-256 matched `BDD536772F31DA48D734DB877E03CC3FF2010B514451DFD5ABB4BF12749B8802`.
- The original 48-entry manifest was verified with exactly the five authorized substitutions: **48/48 matched**, comprising 5 substitutions and 43 byte-identical original entries. It was reverified after tests with 48/48 matches, 0 missing, and 0 mismatched.
- Package/config authorities remained fixed: `package.json` `75E991...`, `package-lock.json` `A9396C...`, `vitest.config.ts` `095BD4...`, `discover-candidates.ts` `E1056A...`, and unchanged `isolated-interaction.test.ts` `E3A194...` all matched.

## Five correction dispositions

1. **Real factory/session invalidation join — addressed.** `BrowserContextFactory.closePassiveContext()` now checks factory ownership without prematurely rejecting the low-level invalidating phase, then awaits `closePassiveGuardedContext()` and deletes factory-active ownership only in `finally`. The real Chromium/local-fixture test drives `BrowserContextFactory -> InteractionGuardedSession.close()`, spontaneous CDP invalidation, one raw Context close, a deferred Download cancellation, and the final ledger cutoff. Session close remains pending until the admitted cancellation rejection is recorded.
2. **Overflow reserved-slot rejection containment — addressed.** `beginOverflowInvalidationOnce()` stores only the `.finally()`-derived promise, attaches a terminal non-observing rejection handler to that derived promise, and leaves `GuardState.invalidationCompletion` as the shared stable rejecting completion. The 256-never-settling-task test observes no process `unhandledRejection`, exactly one admission-limit invariant, exactly one drain-timeout invariant, one raw close, and the same public timeout failure on re-entry.
3. **Readiness-admission listener rollback — addressed.** A denied readiness task calls `releasePageListenerGroup()` before the synchronously published overflow invalidation reaches its raw-close side effect. The regression forces 256 admitted pending tasks and an invalidation-close failure, then proves the denied Page's three exact inverses run once, no second CDP session is constructed, readiness rejects, public close retains the stable timeout failure, and no cleanup is retried.
4. **Undefined abort rejection — addressed.** `abortUnreadyNavigation()` uses an independent `abortFailed` presence flag, records `HTTP_ABORT_FAILED: undefined`, completes invalidation, and rethrows the original `undefined` value instead of resolving successfully.
5. **Huge-BigInt Guard normalization — addressed in the Guard semantic owner.** The Guard type-switch returns its fixed fallback for every bigint without decimal conversion; the real abort path preserves the original bigint owner outcome and records only the bounded fallback. A separate pre-existing interaction-owner normalization concern remains Minor below.

The five correction tests are behavioral rather than vacuous: each exercises its production path and asserts timing/ownership, failure identity, exact cleanup or invariant effects, and raw-close cardinality as applicable.

## Prior blocker and contract re-adjudication

- **Drain timeout and completion stability:** addressed. Live tasks cannot produce ordinary success or `CLOSED`; owner and invalidation paths keep an invalidating phase, record timeout once, publish stable failure, issue one raw close, and cannot become clean after late settlement.
- **Low-level and factory-level invalidation joining:** addressed. Both public layers now wait through raw close, stable drain, and final evidence cutoff without creating a second close entry point.
- **Bounded async/correlation ownership:** addressed. Admission occurs before factory creation at 256 tasks; expected-failure and redirect registries remain capped, expiring, exact, consuming, and string-bounded; denied work is fail-closed. The correction closes the reserved-slot and partial-listener ownership gaps.
- **Listener lifecycle:** addressed. One fixed Context group plus at most 64 live fixed-size Page/CDP groups are owned; terminal Page/session paths release groups, cleanup ownership is cleared before callbacks, later cleanup continues after failures, partial setup rolls back, cap overflow admits no unowned listener, successful Context close detaches before final stable drain/`CLOSED`, and failed close retains fail-closed listeners.
- **Total-node traversal blocker:** addressed under approved design section 6. Both browser callbacks use identical `SHOW_ALL` all-node/character budgets and bounded indexed NodeList access. Per controller ruling, replacing `querySelectorAll` selection or adding a new ancestor-work architecture is outside this recovery.
- **Frozen-versus-closing authority:** addressed. The single Guard phase remains authoritative and final freeze evidence outranks close failure and work outcome.
- **ElementHandle ownership:** addressed. The one non-null retained handle enters one protected owner scope immediately, is used for fact recollection, admission, click, and post-condition identity, and has one caught/ledgered disposal finalizer.
- **Encoded work plus close failure:** addressed. Session work, freeze, disposal, and close are reduced to one immutable result; reason/evidence are preserved and final evidence is snapped after owner close/drain.
- **S03-S08 and Task 5 policy ownership:** preserved. Request policy remains the sole HTTP(S)/WebSocket authority; zero-delivery server-boundary proofs, exact retained-node identity, absolute deadline gates, immutable evidence, safety-ledger bounds, and the single exported `auditInteraction()` entry point remain covered by unchanged authority code/tests and the passing full suite.
- **Recovery Tasks 1-5 completion:** Task 1 phase/invalidation ownership, Task 2 bounded task/correlation ownership, Task 3 total-node traversal, Task 4 Handle/result finalization, and Task 5 listener/full-gate integration satisfy their approved completion criteria after these corrections.

No Critical/Important requirement contradiction, missing behavior, or vacuous safety proof remains.

## Minor findings and disposition

1. **Historical documentation drift, unchanged:** the approved implementation plan's illustrative Context-close and outcome-finalizer snippets still use an `undefined` error sentinel and show close failure before final freeze evidence. Production and tests use the corrected presence flags and freeze-first precedence; this is non-runtime plan drift.
2. **Historical/deferred, unchanged:** lifecycle-phase HTTP abort correlation remains represented by the `expectedRouteFailures` boundary and can still be classified as `HTTP_MAIN_FRAME_DELIVERY_FAILED` in the documented edge case.
3. **Historical/deferred, unchanged:** test helper `emitFailedMainFrameRequest()` still discards its asynchronous handler result.
4. **Historical/deferred, unchanged:** the pre-existing page-readiness task-factory block retains its indentation/readability debt.
5. **Newly identified pre-existing Minor, not introduced by Fix Round 2:** `src/interaction/isolated-auditor.ts:50-60` still applies `String(error)` to non-`Error` work/dispose/close rejection values before slicing. A huge bigint (or similarly expensive successful coercion) can therefore materialize unbounded text even though the returned reason is capped. The new regression proves the Guard normalizer only; no interaction-owner huge-bigint regression exists. This does not escape the error or alter the fail-closed result, so it is Minor, but the interaction semantic owner should use the same primitive type-switch/fixed fallback discipline in a later bounded cleanup.

Future design candidate, not a current finding: replace static `querySelectorAll` candidate selection and/or introduce a separately approved ancestor-traversal work budget. The controller explicitly ruled this outside the approved Task 11 recovery.

## Fresh commands and environment

- Five-correction focus: `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "joins an already-published invalidation|contains the reserved overflow owner|rolls back a Page listener group|preserves an undefined abort rejection|normalizes a huge bigint rejection"` — exit 0; 2 files; **5/5 passed**, 104 skipped.
- Full repository: `npm test` — exit 0 first run; 26 files; **426/426 passed**; no retry.
- `npm run typecheck` — exit 0; no TypeScript diagnostics.
- Forbidden production escape-hatch/string-evaluation/marker scan — `rg` exit 1 with no matches, expected.
- SHA-256/manifest checks — all expected hashes matched before and after test execution.
- Build was not rerun because this review was read-only apart from this mandated review artifact and the build emits `dist`; the package records independent controller typecheck/build PASS.
- Existing local Chromium ran successfully. No environment gap, dependency operation, package update, Git operation, live-target access, or delegation occurred.
