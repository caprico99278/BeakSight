# Task 11 Architecture Recovery — Task 1 Fix Round 3 Review Package

Git is prohibited. Verify all hashes, then review only the invalidation-owner publication race and current-fix breakage.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-brief.md` |
| Report with fix round 3 | `8CE91D2460F72B66DE15FFE5D212D1C831F877672D98E2B6C1CCE982A98C3FA7` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-report.md` |
| Entering re-review | `400D858ED39B5CC74D22E186205EB123581ADE27270BC59EEBE44C07DD32149D` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-fix-round-2-review.md` |
| Current production | `15AB3E727B752EBDF9F6F2E018A308F8841F841560B37524BA3EEC59EEE2F9BF` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| Current test | `1C479F389F3ECB5C3CB6C0D3DD32E4107EA3CA40E9CED0916D6F0662392B5DD4` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

Predecessor hashes: production `1A6CC927E5A1FE7EE3C4DC433375CCFEDF17AE734C4ACC39FA62385B0A1DCA07`; test `443B10D53FE678DC9D0A98DA318BE6FD115CAA6D95FA953E7384F369E125BAF8`.

## Finding under verification

Invalidation owner publication race — phase changed to invalidating before `invalidationCompletion` was published, while the async completion invoked `context.close()` before assignment. Synchronous re-entry could therefore see invalidating with no owner and return an already-resolved promise before close/drain completion.

## Required contract

- Publish one stable GuardState-owned completion identity before the first externally re-entrant side effect. Every later invalidating re-entry receives that exact pending completion.
- No tracked-callback self-await, double close, early external/public completion, unhandled rejection, detached work, or false CLOSED after close failure.
- The guarded Context owner-close failure path must also leave an owned completion for later invalidating re-entry without initiating a second close.
- No Task 2 capacity or Task 5 listener teardown scope.

## Evidence for current hashes

- Genuine RED: synchronous `context.close()` -> requestfailed re-entry waiter settled before the first close gate (`expected true to be false`).
- Implementer GREEN: re-entry 1/1; all focused 11/11; adjacent 101/101; typecheck PASS.
- Controller fresh focused 11/11; adjacent 101/101; typecheck PASS.

## Restrictions and verdict

Read-only. No edits/creation, Git, `.git-sandbox-backup`, dependency operations, live target, or subagents. Do not repeat suites without a named unresolved code doubt. Return `ADDRESSED` or `NOT ADDRESSED` with absolute-path:line evidence, then new Critical/Important/Minor breakage and out-of-scope observations. PASS requires the finding addressed and no new Critical/Important breakage.
