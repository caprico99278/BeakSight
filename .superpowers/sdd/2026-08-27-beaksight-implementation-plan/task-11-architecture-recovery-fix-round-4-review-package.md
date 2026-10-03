# Task 11 Architecture Recovery Fix Round 4 Independent Review Package

## Review status and scope

Task 11 is not approved. This is a Git-free independent checkpoint after the user's binding lifecycle-priority correction. Task 12 and later work remain blocked.

Work read-only except for the requested review artifact. Do not use Git, mutate source/tests, download/install/update/import dependencies, access a live target, or delegate. Verify every hash before reviewing. Report every Critical, Important, and Minor finding. PASS requires zero Critical and zero Important findings.

## Authorities

- Original fixed 48-entry review package: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-review-package.md`, SHA-256 `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`.
- User lifecycle-priority correction brief: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-user-lifecycle-priority-brief.md`, SHA-256 `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718`.
- Implementer report: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`, SHA-256 `679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA`.
- Entering Fix round 2 specification review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-2-spec-review.md`, SHA-256 `82FEF3577F9798977EE690D999E4E2E44B62D248EA51A91F2691C27D8512CD7F`.
- Entering Fix round 2 quality review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-2-quality-review.md`, SHA-256 `407B708DB455050AD573C65080F5CD6A512275F0D41ECC5C47014D5D58E2B1B8`.

## Fixed manifest

Verify the original package's 48-entry manifest with exactly these six substitutions. All other 42 original entries must remain byte-identical:

```text
54B5A1272E21A9508B1305DA8A0A5E93E586BB76EFFA2384DEBE362687B17C28  src/safety/passive-request-guard.ts
F836BA9A3353CC7B70F59060AE3BD1D717F1ED3CC79CE7556DB3D812D1A51CB8  src/browser/context-factory.ts
7D41F62126A4F25EC9F453E78976FC43668039AD4506374D72429AA77A0A2ADE  tests/integration/passive-request-guard.test.ts
350C5E1DF4F5F1E18117C93501D2B73F9C2DDB021FCB77D5A003CF6C3036FA9F  tests/component/context-factory.test.ts
FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20  tests/integration/isolated-interaction.test.ts
679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```

Controller verification found exactly these six changes and 42 unchanged original entries, with zero missing files.

## Findings and requirements to adjudicate

Review the resulting full lifecycle behavior, not only individual assertions:

1. An active-only operation that observes invalidation must not discard factory close ownership; the later session owner must still join the published invalidation completion and evidence cutoff.
2. A successful invalidation must expose the same deterministic safety-invalidated public outcome whether observed while INVALIDATING or after CLOSED.
3. `invalidation > normal close` is an explicit state-machine priority. Invalidation requested during PASSIVE_CLOSING/FROZEN_CLOSING must be retained, promote lifecycle authority, and join the already-published owner without a second raw close.
4. `VERIFIED candidate -> close starts -> invalidation -> raw close succeeds` must finalize as BLOCKED_BY_SAFETY with work evidence and the final Safety Ledger snapshot preserved.
5. `invalidation -> close` and `close -> invalidation` must converge to the same final status, evidence cutoff, and raw-close cardinality.
6. Raw `context.close()` failure during invalidation/closing must not release factory/session ownership of a non-terminal Context. The owner must retain a valid join/retry path and must not issue a second raw close.
7. Factory owner release and session terminal marking occur only after Guard terminal state is confirmed. Page readiness and guarded Page-close failure paths must obey the same owner-release rule.
8. Prior drain-timeout stability, bounded task/correlation ownership, bounded listener groups and exact inverse cleanup, fail-closed listener retention, total bounded error normalization, all-node traversal bounds, ElementHandle/result finalization, S03-S08 zero-delivery proofs, package/config boundaries, and one interaction entry point must remain intact.

Specifically assess whether the new `isPassiveRequestGuardClosed()` query is a read-only lifecycle query backed by the single Guard phase authority, rather than a second lifecycle owner; whether every completion is published before re-entrant side effects; and whether any interleaving can reach normal success or release ownership after an accepted invalidation.

## TDD and verification evidence

- Mandatory RED: 3 failed / 68 skipped on unchanged production, exactly exposing VERIFIED leak, ordering divergence, and premature factory/session owner loss.
- Additional ownership RED: 2 failed / 14 skipped for Page-close and Page-readiness failure paths.
- Final lifecycle focus: 5/5 PASS.
- Three lifecycle/finalizer files: 170/170 PASS.
- Task 11 regression: 219/219 PASS.
- Adjacent regression: 47/47 PASS.
- Full maintained repository: 434/434 PASS on first run, no retry.
- Typecheck/build: PASS.
- Forbidden-boundary and scoped type-escape scans: clean; one unrelated pre-existing validated cast remains outside the changed files.
- Controller fresh verification: lifecycle focus 5/5, Task 11 regression 219/219, typecheck PASS, build PASS. The first sandboxed Chromium attempt failed before tests with `spawn EPERM`; the identical command passed using the already-installed Chromium at the permitted execution boundary. No dependency operation occurred.

Review test strength as well as production behavior. The four pre-existing close-success expectations changed to deterministic invalidation rejection only where the tests already triggered safety invalidation during close/drain; verify that this is contract correction rather than weakened evidence.

The three historical deferred Minors remain: lifecycle-phase HTTP abort correlation, asynchronous `emitFailedMainFrameRequest()` return, and page-readiness task-factory indentation. Enumerate them and any new Minor separately. Do not treat their presence as approval of the lifecycle checkpoint.
