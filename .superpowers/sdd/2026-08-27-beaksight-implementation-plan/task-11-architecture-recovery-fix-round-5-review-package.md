# Task 11 Architecture Recovery Fix Round 5/5 Independent Re-review

## Scope and integrity

Task 11 remains unapproved until both re-reviews PASS with zero Critical and zero Important. Task 12+ remain blocked.

Work read-only except for the requested review artifact. Do not use Git, mutate source/tests, download/install/update/import dependencies, access a live target, or delegate. Verify all hashes before reading/reviewing.

Authorities:

- Original 48-entry package: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-review-package.md`, SHA-256 `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`.
- Fix round 5 brief: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-fix-round-5-brief.md`, SHA-256 `E269E1DD349C825038989063718810E2A2E5A4218CA092F90917734D88DA300D`.
- Entering specification review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-4-spec-review.md`, SHA-256 `F35E38C7137531776EEDE92436E7D51EB1A93611B518B0E449B9DD6646A80B8A`.
- Entering quality review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-4-quality-review.md`, SHA-256 `0F6C699B016A54D50806C89E59453FA1ED018C1964F848035158897F3B179867`.
- Append-only implementation report: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`, SHA-256 `E9D29D14FEACECBD4665454373ECBEF581C7E308FC2B87E71064956AC22BF3EF`.

Verify the original package's 48-entry manifest with exactly these six substitutions; the other 42 entries must be byte-identical:

```text
7B7B5B935AF17B28FF958F4E4F93619B550264DDF7625ED5C870096747BC6A66  src/safety/passive-request-guard.ts
92E79F378BBA393FAF62D83040C8081371D919D45AB18E773514EA4024FBC8B5  src/browser/context-factory.ts
4B2CE15F072AFAABC4A78E8BF1833DB6C45D5E7DFC00CDFB1C61CA8A83F19107  tests/integration/passive-request-guard.test.ts
D13622D52F23A12100AEDAD1B4AFAFFBABB94E3AB6D8FA053403DCDB86497C11  tests/component/context-factory.test.ts
FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20  tests/integration/isolated-interaction.test.ts
E9D29D14FEACECBD4665454373ECBEF581C7E308FC2B87E71064956AC22BF3EF  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```

Controller verification: 48 entries, exactly six changed, 42 unchanged, zero missing.

## Findings to verdict

Verdict each finding ADDRESSED or NOT ADDRESSED, with file:line evidence. Inspect the correction surface for new Critical/Important breakage.

1. **Construction rejection can strand a non-terminal guarded Context.** Installation failure and interaction-session Page-readiness failure combined with raw close failure previously returned no externally reachable owner/join path. Verify factory ownership is registered before failure can occur; terminal success releases it; non-terminal failure returns a minimal immutable typed owner surface; original cause is preserved; the existing canonical factory close joins the same completion; foreign/active reuse stays rejected; and raw close remains exactly once. Confirm this surface is not a second lifecycle authority or alternate close implementation.
2. **Failed-request event invalidation leaks an unhandled rejection.** Verify every fire-and-forget event path contains only its initiation-view rejection, while the shared public invalidation completion remains rejecting/stable. The event handler must retain any required completion wait without creating unhandled rejection or self-drain. Confirm installation-phase `onPage` equivalent handling.
3. **In-flight HTTP/WebSocket callbacks are outside the stable drain.** Verify callbacks use the single bounded pending owner before any protocol body, rejected admission performs no 257th HTTP/WebSocket protocol operation/delivery, admitted work covers protocol await plus evidence/error finalization, task deletion precedes synchronous invalidation initiation, the outer callback can await the shared completion without self-drain, and terminal CLOSED admission performs no new asynchronous protocol/evidence work. Confirm empty-drain/CLOSED publication is atomic against callback admission, one raw close is preserved, and final Safety Ledger evidence cannot arrive after the cutoff.

Also verify no regression in the user-binding `invalidation > normal close` priority, terminal-only Context/session owner release, deterministic order convergence, listener/task/correlation bounds, failed-close fail-closed enforcement, Handle/result finalization, and S03-S08 zero-delivery contracts.

Review the one modified pre-existing terminal test expectation: after CLOSED, a saved callback now expects zero abort/protocol calls. Determine whether this correctly enforces terminal admission cutoff without weakening the during-drain freeze/evidence assertions.

## Evidence

- Seven mandatory/additional tests: genuine RED 7/7 against unchanged production; final GREEN 7/7.
- Prior lifecycle-priority focus: 5/5 PASS.
- Final combined focus: 12/12 PASS.
- Guard/factory/auditor full: 177/177 PASS.
- Task 11 six-file regression: 226/226 PASS.
- Adjacent regression: 47/47 PASS.
- Full maintained repository: 441/441 PASS, 26 files, first run, no retry.
- Typecheck/build PASS; scans clean; package/config unchanged.
- Controller fresh verification on final hashes: focus 12/12, Task 11 226/226, typecheck PASS, build PASS.
- One initial Chromium `spawn EPERM` occurred before tests and was retried using the already-installed browser at the permitted execution boundary. No dependency operation occurred.

The historical/deferred Minors remain separately listed in the report. Enumerate any new Minor or out-of-scope observation, but do not use Minor findings to hide a remaining Critical/Important defect.
