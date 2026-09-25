# Task 11 Architecture Recovery — Task 1 Fix Round 1 Review Package

Git is prohibited, so this scoped package uses immutable original BASE copies, the predecessor HEAD hashes recorded by the controller/report, and the current full files. Verify every available SHA-256 before review. The review scope is the three entering findings and any Critical/Important breakage introduced in their current implementation.

## Manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-brief.md` |
| Implementer report with fix appendix | `E760F0FC0BF99C9CD1C44A231A3B1E41B50386800A90A43FEAA6636A8D42DFBE` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-report.md` |
| Entering specification review | `F6202E4134ED7C386D7F018935324CC333F9EB0D15571A05F72B4294D1C2424D` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-spec-review.md` |
| Original BASE production | `1C0E00688A903895D265CAADCFB13D142752918BD7CEAA99EA4CBC197ACA8A3B` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-baseline\passive-request-guard.ts` |
| Original BASE test | `3D4C7694B763C6B0824F0204555DFCD7808F13F0292898910A3E7D2D5C9EB636` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-baseline\passive-request-guard.test.ts` |
| Current production | `BC2E710E9BE8CB6EACD1D2FB98107C749DF7CEA0F51CA2E31A4518F153E0A673` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| Current test | `348952BDDBCE2840CFA807D91648C1F922615EEBC53A1A95EFD723771EE2F059` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

Predecessor HEAD hashes seen by the entering review were production `8A0F29FA8ED39A21C7514D38957502B0BFF481FB1D32FD151564EE18815C7D11` and test `07BFB22681157C811FD925231507FF7C5DD431483470260369AC4615068A9424`. The controller did not retain a second full copy of that predecessor HEAD before the fix. Therefore, verify each finding against the current implementation and its new tests, and use the original BASE only to identify unrelated Task 1 scope. Do not infer a change from a hash alone.

## Findings under verification

1. Installation can make the illegal transition `PASSIVE_INVALIDATING -> PASSIVE_ACTIVE`: activity observed during installation starts invalidation, but installation completion unconditionally assigns `PASSIVE_ACTIVE`.
2. Successful safety invalidation never drains owned tasks or transitions to `CLOSED`; it remains `*_INVALIDATING` after `context.close()`.
3. Frozen HTTP and CDP activity is recorded only after enforcement succeeds, contrary to record-first precedence. An enforcement rejection therefore loses the observed interaction evidence.

## Fix evidence for the current hashes

- Genuine fix RED: four named tests failed (`4 failed | 64 skipped`) before the fix: record-first HTTP, record-first CDP, installation no-reactivation, and frozen invalidation drain/terminal behavior.
- Implementer GREEN: four new tests passed; original Task 1 four passed; adjacent suite `98 passed`; typecheck exit 0.
- Controller fresh combined focused run: `8 passed | 60 skipped`.
- Controller fresh adjacent run: `98 passed`; fresh typecheck exit 0 with no diagnostics.

## Restrictions

Read-only. Do not edit/create files, run Git, touch `.git-sandbox-backup`, install/download/import/update dependencies, access the live target, or dispatch subagents/reviewers. Do not rerun suites merely to repeat the evidence. A focused test is allowed only for a specific code doubt not answered by the report.

## Required scoped verdict

For each finding, return `ADDRESSED` or `NOT ADDRESSED` with current absolute-path and line evidence. Then list new Critical/Important/Minor breakage attributable to the fix; observations outside the finding/current-fix scope are non-blocking and separately labeled. PASS requires all three findings addressed and no new Critical/Important breakage.
