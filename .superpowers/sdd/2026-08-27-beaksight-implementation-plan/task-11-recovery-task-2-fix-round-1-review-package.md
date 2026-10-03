# Task 11 Architecture Recovery — Task 2 Fix Round 1 Review Package

Git is prohibited. Verify every SHA-256, compare the immutable fix BASE files with fix HEAD, and re-review the three entering Important findings plus new breakage in this exact fix.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `A5895957D9BEDA83D1BF7022DFEB65876E02D02776424F1A8B548BE99F679871` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-brief.md` |
| Entering review | `B17E9C4D3931B721B087D8F2D3F444E88CD2AB24FBE2100510AD91760C16E513` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-review.md` |
| Report with fix appendix | `0AF09081AC2B83334E7B50BA55C51BCEB7E5B781A46A9D109012FA8B31AEC851` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-report.md` |
| Fix BASE production | `1B364A7C29B53F227E23228734D315657D4A6A0B5D94A94A5BA6C06DA48FF001` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-fix-round-1-pre\passive-request-guard.ts` |
| Fix BASE test | `79F193D97440BC292E4A61494B77129501CCA7C8FC8CF8FE9FEE086B0AC998B6` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-2-fix-round-1-pre\passive-request-guard.test.ts` |
| Fix HEAD production | `D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| Fix HEAD test | `6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

## Findings under verification

1. Tracked paused-Document invalidation paths awaited invalidation completion whose drain contained the same task, forcing timeout and false terminal behavior.
2. Redirect predecessor lookup did not validate the 256-character request-ID bound and treated invalid/missing/expired/consumed supplied predecessor as no redirect instead of failing the current Document closed.
3. Harness/tests did not retain CDP command parameters and could not directly prove exact predecessor consume, the specific overflow/invalid current request failed, exactly-one invalidation, or absence of self-drain timeout.

The prior indentation Minor and the two older carry-forward Minors are outside this fix loop. Formatting within the necessarily changed tracked CDP block may be evaluated as part of this fix but is not an entering requirement.

## Required contracts

- A tracked factory initiates/reuses the Task 1 published invalidation owner but cannot await completion whose drain includes itself. No unowned rejection/double close/detached close; no `GUARD_PENDING_TASK_DRAIN_TIMEOUT` from these paths.
- Only absent `redirectedRequestId` means no redirect. A supplied ID is bounded before Map access and returns FOUND/MISSING/INVALID; missing includes expired or already-consumed. All non-FOUND supplied IDs fail the exact current Document and initiate exactly one invalidation.
- Exact predecessor consumes once. The first valid redirected current continues; reuse fails the second exact current. The 65th exact request, overlong identity, missing/expired predecessor all fail their own request IDs.
- Harness extension must preserve existing command-name evidence and add bounded typed parameters sufficient for exact assertions; it must not create production inspection APIs.

## Exact HEAD evidence

- Genuine fix RED: 4 failed / 1 passed initially; the initially passing 65th test was strengthened, then mutation-proven RED by restoring the self-await branch temporarily and immediately restoring it.
- Implementer and controller fix focused: 5/5 PASS.
- Implementer and controller original Task 2 focused: 5/5 PASS.
- Implementer and controller Task 1 lifecycle: 12/12 PASS.
- Implementer and controller adjacent: 120/120 PASS; typecheck PASS.

## Restrictions and verdict

Read-only. No edits/creation, Git, `.git-sandbox-backup`, dependencies, live target, or subagents. Do not repeat suites without a named doubt. Verdict each finding `ADDRESSED` or `NOT ADDRESSED` with current absolute-path:line evidence. Inspect only the fix diff for new Critical/Important/Minor breakage; list unrelated observations separately. PASS requires all findings addressed and no new Critical/Important breakage.
