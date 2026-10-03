# Task 11 Architecture Recovery — Task 2 Fixed Review Package

Git is prohibited. Verify every SHA-256, compare each immutable BASE file with its current HEAD file, and return both specification-compliance and code-quality verdicts for Task 2.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `A5895957D9BEDA83D1BF7022DFEB65876E02D02776424F1A8B548BE99F679871` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-brief.md` |
| Implementer report | `CD530B7767945837BE4DDF502F65702484BEF4409016D9EF3ADC7F3370BC9EFE` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-report.md` |
| Approved design | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` | `C:\Develop\github-repo\BeakSight\doc\design\2026-08-31-beaksight-task-11-architecture-recovery-design.md` |
| Approved plan | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` | `C:\Develop\github-repo\BeakSight\doc\design\2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` |
| BASE production | `898D0D371C384D7CFA417570D84FA7DC5CAAB8A0005894B5611107CFB01CE3FD` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-baseline\passive-request-guard.ts` |
| BASE test | `7CD8FF1B90E9608D68EB97D006DE3B8C063A67FDE5C3F292B30F10FDED2117B6` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-baseline\passive-request-guard.test.ts` |
| HEAD production | `1B364A7C29B53F227E23228734D315657D4A6A0B5D94A94A5BA6C06DA48FF001` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| HEAD test | `79F193D97440BC292E4A61494B77129501CCA7C8FC8CF8FE9FEE086B0AC998B6` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

## Binding constraints and controller ruling

- Task factories are admitted before creation; at most 256 active Context tasks; the 257th factory never starts; overflow invariant/Context invalidation are exactly once.
- `ExpectedCdpFailureRegistry`: at most 64 live entries/Page; 1,000 ms; exact method/URL/error consume; one match deleted; expired/empty entries removed; clear removes Page state; method <=32 and URL <=2,048 are validated before uppercase/no truncation alias.
- `RedirectPredecessorRegistry`: at most 64 live/session; 1,000 ms; requestId <=256, method <=32, URL <=2,048; exact predecessor consumed once; expired entries purged; clear on session teardown; overflow/identity fail current Document closed without eviction-based success.
- No raw unbounded string may be uppercased or retained before validation. Bounds apply to every insertion and lookup identity path, including redirected predecessor lookup.
- Task 1 `GuardState.phase` and published `invalidationCompletion` remain authoritative. Overflow keeps a reserved `overflowInvalidation` slot but routes through the same exactly-once Context invalidation owner. It cannot pre-set invalidating before publication, double close, self-await through its own task drain, detach work, return early, or skip drain on close failure.
- Task 1 lifecycle behavior remains unchanged; no public inspection export, second policy/route authority, dependency drift, live target, site identity, DOM marker, or private Playwright API.
- The Task 1 lifecycle-abort correlation and async test-helper Minors remain deferred and are not Task 2 failures unless this change worsened them.

The illustrative Task 2 `GuardState` snippet omitted `invalidationCompletion`; the controller ruled that omission conflicts with the approved single-owner design and reviewed Task 1 interface. Retaining and reusing it is required. Cost if wrong: rework the overflow owner, not a silent Task 1 regression.

## Executed evidence for exact HEAD

- Genuine RED: 4 of 5 new tests failed as expected; the existing raw implementation already passed expiry/consume and that case was not counted as RED.
- Implementer and controller focused registry tests: 5/5 PASS.
- Implementer and controller Task 1 lifecycle regression: 12/12 PASS.
- Implementer and controller adjacent request-policy/safety-ledger/context-factory/guard suite: 115/115 PASS.
- Typecheck PASS; package hashes unchanged.

## Review focus

Adjudicate all limits, expiry boundary, exact one-time consume/delete, Page/session clear, overlong input before normalization, no identity alias, and current-request fail-closed behavior. Audit every task-factory call and every invalidation invoked inside a tracked factory: a tracked task must not await an invalidation completion whose drain includes that same task. Audit overflow owner publication/retention and every redirect requestId insertion/lookup. Verify tests are deterministic and non-vacuous and that denied factory/no-start is directly observed.

## Restrictions and verdict

Read-only. No edits/creation, Git, `.git-sandbox-backup`, dependency operations, live target, or subagents. Do not rerun suites merely to repeat evidence; one focused test requires a named doubt. Cite every finding as current absolute-path:line. PASS requires spec compliance plus 0 Critical and 0 Important. List Minors separately.
