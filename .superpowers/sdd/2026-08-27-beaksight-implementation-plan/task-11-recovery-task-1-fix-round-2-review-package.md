# Task 11 Architecture Recovery — Task 1 Fix Round 2 Review Package

Git is prohibited. Verify this manifest, then review only the remaining invalidation-completion finding and new breakage in its current correction.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-brief.md` |
| Report with fix round 2 | `9A4A95CFC82EEF7008991B2608A58C477231DB772CF25192E4D11714C1D702D3` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-report.md` |
| Entering re-review | `D36CF755A1C83967BD862AB3CAEB9BF3EBA809CF2D3D2C191D107C514BD166EB` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-fix-round-1-review.md` |
| Current production | `1A6CC927E5A1FE7EE3C4DC433375CCFEDF17AE734C4ACC39FA62385B0A1DCA07` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| Current test | `443B10D53FE678DC9D0A98DA318BE6FD115CAA6D95FA953E7384F369E125BAF8` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

Predecessor hashes were production `BC2E710E9BE8CB6EACD1D2FB98107C749DF7CEA0F51CA2E31A4518F153E0A673` and test `348952BDDBCE2840CFA807D91648C1F922615EEBC53A1A95EFD723771EE2F059`.

## Finding under verification

Successful safety invalidation drain/terminal ownership — NOT ADDRESSED: the prior code launched an unowned `void` async drain, so `invalidateContext()` returned successfully before owned tasks drained and before `CLOSED` was reached. Callers could observe successful invalidation return while tracked work remained pending, and no owner could await the eventual drain/terminal transition.

## Required contract

- GuardState owns an exactly-once, awaitable completion through Context close, stable guard-task drain, and legal matching `*_INVALIDATING -> CLOSED` after successful close.
- Initiation from a tracked callback cannot self-await/deadlock; external/public owners that require invalidation completion cannot return before it.
- Repeated invalidation shares the same owner and cannot close twice.
- Close failure remains matching invalidating, is ledgered, preserves frozen enforcement, and never claims CLOSED.
- No unhandled rejection, detached completion, Task 2 capacity, or Task 5 listener teardown.

## Evidence for current hashes

- Genuine RED: page-close-triggered invalidation settled before held download task drained; duplicate-failed-invalidation characterization already passed.
- Implementer GREEN: new 2/2; prior focused 8/8; adjacent 100/100; typecheck PASS.
- Controller fresh focused 10/10; adjacent 100/100; typecheck PASS.

## Restrictions and verdict

Read-only. No file edits/creation, Git, `.git-sandbox-backup`, dependency operations, live-target access, or subagents. Do not repeat suites without a named unresolved code doubt. Return `ADDRESSED` or `NOT ADDRESSED` with current absolute-path:line evidence, then new Critical/Important/Minor breakage and out-of-scope observations. PASS requires the finding addressed and no new Critical/Important breakage.
