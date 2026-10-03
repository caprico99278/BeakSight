# Task 11 Architecture Recovery — Task 1 Fix Round 4 Review Package

Git is prohibited. The two `fix-round-4-pre` files are immutable predecessor copies captured before the fresh implementer began. Verify all hashes, compare each predecessor with its current file, and review only the two entering Important findings plus new breakage in this fix.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-brief.md` |
| Entering quality review | `277F5E462CC262AF955D1C4F739F3E12CC614867B4D20CF8D521D3A03361B778` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-quality-review.md` |
| Report with fix round 4 | `D54093462FC395EA67CE79C12FC29A7EDE94A06CC2A80293DBEF886C1B9AC992` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-report.md` |
| Fix BASE production | `15AB3E727B752EBDF9F6F2E018A308F8841F841560B37524BA3EEC59EEE2F9BF` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-fix-round-4-pre\passive-request-guard.ts` |
| Fix BASE test | `1C479F389F3ECB5C3CB6C0D3DD32E4107EA3CA40E9CED0916D6F0662392B5DD4` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-fix-round-4-pre\passive-request-guard.test.ts` |
| Fix HEAD production | `898D0D371C384D7CFA417570D84FA7DC5CAAB8A0005894B5611107CFB01CE3FD` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| Fix HEAD test | `7CD8FF1B90E9608D68EB97D006DE3B8C063A67FDE5C3F292B30F10FDED2117B6` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

## Findings under verification

1. Installation could fulfill after installation-time activity moved the guard to invalidating or `CLOSED`; unchanged `context-factory.ts` treats fulfillment as active success. It must await invalidation and reject whenever the final phase is not `INSTALLING`.
2. Safety invalidation drained pending tasks only when Context close succeeded. On close failure it could resolve while owned work still mutated the ledger. It must bounded-drain regardless of close outcome, while `CLOSED` remains success-only.

The two entering Minor observations are not part of this fix round and must be reported only as out-of-scope if still present.

## Evidence for exact HEAD

- Genuine RED: both new cases failed (`2 failed | 70 skipped`): installation fulfilled instead of rejecting, and failed-close public cleanup settled before held owned work.
- Implementer GREEN: new 2/2; prior focused 11/11; adjacent 102/102; typecheck PASS.
- Controller fresh unique focused 12/12; adjacent 102/102; typecheck PASS.

## Restrictions and verdict

Read-only. No edits/creation, Git, `.git-sandbox-backup`, dependencies, live target, or subagents. Do not repeat suites without a named doubt. Verdict each finding `ADDRESSED` or `NOT ADDRESSED` with current absolute-path:line evidence; list Critical/Important/Minor breakage introduced by the exact BASE-to-HEAD fix; list unrelated observations separately. PASS requires both findings addressed and no new Critical/Important breakage.
