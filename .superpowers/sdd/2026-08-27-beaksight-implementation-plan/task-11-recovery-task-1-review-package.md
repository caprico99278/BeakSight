# Task 11 Architecture Recovery — Task 1 Fixed Review Package

This package replaces Git BASE/HEAD review metadata because the user prohibited every Git operation. The immutable comparison boundary is the two baseline copies plus the two current files below. Verify every SHA-256 before review. If any hash differs, stop and report a package-integrity failure.

## Authority and evidence manifest

| Role | SHA-256 | Absolute path |
| --- | --- | --- |
| Task brief | `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-brief.md` |
| Implementer report | `19F085732DA2153423A115D1BE9097C02781B1FC256A1C448F7BF28869CCE0E0` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-report.md` |
| Approved design | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` | `C:\Develop\github-repo\BeakSight\doc\design\2026-08-31-beaksight-task-11-architecture-recovery-design.md` |
| Approved implementation plan | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` | `C:\Develop\github-repo\BeakSight\doc\design\2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` |
| BASE production | `1C0E00688A903895D265CAADCFB13D142752918BD7CEAA99EA4CBC197ACA8A3B` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-baseline\passive-request-guard.ts` |
| BASE test | `3D4C7694B763C6B0824F0204555DFCD7808F13F0292898910A3E7D2D5C9EB636` | `C:\Develop\github-repo\BeakSight\.superpowers\sdd\2026-08-27-beaksight-implementation-plan\task-11-recovery-task-1-baseline\passive-request-guard.test.ts` |
| HEAD production | `8A0F29FA8ED39A21C7514D38957502B0BFF481FB1D32FD151564EE18815C7D11` | `C:\Develop\github-repo\BeakSight\src\safety\passive-request-guard.ts` |
| HEAD test | `07BFB22681157C811FD925231507FF7C5DD431483470260369AC4615068A9424` | `C:\Develop\github-repo\BeakSight\tests\integration\passive-request-guard.test.ts` |
| Package manifest | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `C:\Develop\github-repo\BeakSight\package.json` |
| Lockfile | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `C:\Develop\github-repo\BeakSight\package-lock.json` |

The implementer report says the before hashes were not captured; that sentence is inaccurate. The controller captured and copied both baseline files before the implementer began, as shown above. Judge the fixed baseline files and hashes, not that report sentence.

## Review boundary

Compare each BASE file to its corresponding HEAD file. Only these two source/test files belong to Task 1. The report and this package are process artifacts. `tests/integration/isolated-interaction.test.ts` was listed as an available Task 1 test surface but was unchanged, which is acceptable only if every required Task 1 behavior is completely proven in the changed guard integration test.

No Git command may be run. Do not edit any file, install/download/import/update a dependency, launch or access the live target, dispatch a subagent, or touch `.git-sandbox-backup`. Do not run the test suite merely to repeat the controller and implementer evidence.

## Binding global constraints

- `GuardState.phase` must be the sole Context lifecycle/mode authority with exactly `INSTALLING`, `PASSIVE_ACTIVE`, `FROZEN_ACTIVE`, `PASSIVE_CLOSING`, `FROZEN_CLOSING`, `PASSIVE_INVALIDATING`, `FROZEN_INVALIDATING`, and `CLOSED`.
- The state must be registered synchronously before the first installation `await`; installation success is only `INSTALLING -> PASSIVE_ACTIVE`; installation failure remains invalidating and cannot reactivate.
- Frozen phase takes precedence over closing/invalidation for HTTP, CDP Document, popup, download, frame-navigation, and WebSocket observation: record exactly once, then fail closed. Passive close/invalidation fails closed without inventing an interaction event. Passive classification occurs only in `PASSIVE_ACTIVE`.
- Context owner close transitions active to matching closing, closes, changes to matching invalidating on failure, drains tracked tasks while preserving frozen authority, rethrows close failure, and reaches `CLOSED` only after successful close/drain.
- `activateInteractionFreeze()` changes only `PASSIVE_ACTIVE -> FROZEN_ACTIVE`; public entry points remain unchanged.
- Page-only close correlation may remain Page-scoped but may not decide Context freeze authority.
- Do not implement Task 2 bounds/registries or Task 5 listener teardown in this slice beyond the Task 1 structural fields required by the approved plan.
- No public production inspection export, dependency drift, live-target access, new route authority/policy, DOM marker, site selector/identity, string-evaluated browser program, or private Playwright API.
- Every production correction must have genuine RED evidence first.

## Executed evidence for this exact HEAD

- Implementer RED after adding tests and before production correction: 2 expected failures (frozen HTTP and frozen CDP); passive-close and aggregate popup/download/frame/WebSocket cases passed.
- Implementer GREEN: focused `4 passed | 60 skipped`; adjacent `94 passed`; typecheck exit 0.
- Controller fresh focused run: the sandboxed attempt failed only at existing Chromium `spawn EPERM`; approved existing-browser retry passed `4 passed | 60 skipped`.
- Controller fresh adjacent run: `94 passed`; typecheck exit 0 with no TypeScript diagnostics.
- Package hashes are unchanged from the approved baseline.

## Required verdict

Return both specification and code-quality verdicts. Every finding must cite a HEAD file and line. PASS requires specification compliance plus 0 Critical and 0 Important. Minor observations are non-blocking but must still be listed. Explicitly adjudicate transition legality, phase-snapshot event precedence, close-failure/drain behavior, repeated/concurrent installation, Page close correlation, task-scope restraint, and whether the new tests would fail for the named lifecycle regression.
