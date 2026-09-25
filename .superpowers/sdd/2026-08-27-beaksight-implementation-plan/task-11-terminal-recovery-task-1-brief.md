# Task 11 three-finding correction — Task 1 brief

## Authority

- Approved implementation plan: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md`
- Execute only `### Task 1: Make non-terminal invalidation close attempts retryable and single-flight` (lines 59-331, ending immediately before Task 2).
- Approved design: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`
- Plan SHA-256: `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D`
- Design SHA-256: `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E`

Read the complete Task 1 section and the approved design before editing. The plan's steps, interfaces, RED assertions, GREEN constraints, commands, and report requirements are binding.

## Scope

- Modify `src/safety/passive-request-guard.ts`.
- Modify `src/browser/context-factory.ts` only where Task 1 requires.
- Modify `tests/integration/passive-request-guard.test.ts`.
- Modify `tests/component/context-factory.test.ts`.
- Append evidence to `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` and `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`.
- Write the implementation report to `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md`.

Do not begin Task 2, Task 3, Task 4, or Task 12. Do not modify package manifests or dependency state. Do not access a live target. Do not use Git. Do not spawn subagents.

## Required behavior

- `*_INVALIDATING` remains non-terminal after a failed raw close and retains its owner.
- The next canonical close call retries the raw close and can reach `CLOSED`.
- Concurrent close callers share exactly one in-flight close/drain attempt.
- A successful raw close followed by drain failure retries drain only and never closes the raw Context twice.
- Only successful raw close plus successful drain can publish `CLOSED` and permit owner release.
- Preserve `invalidation > normal close` precedence and existing public close entry points.

Follow strict TDD: add the plan-specified focused tests, run them and capture a genuine intended RED before changing production, then implement the minimum change and rerun GREEN plus the Task 1 regression commands.

## Frozen no-Git baseline

| Path | Bytes | SHA-256 |
|---|---:|---|
| `src/safety/passive-request-guard.ts` | 54119 | `7B7B5B935AF17B28FF958F4E4F93619B550264DDF7625ED5C870096747BC6A66` |
| `src/browser/context-factory.ts` | 6656 | `92E79F378BBA393FAF62D83040C8081371D919D45AB18E773514EA4024FBC8B5` |
| `tests/integration/passive-request-guard.test.ts` | 144385 | `4B2CE15F072AFAABC4A78E8BF1833DB6C45D5E7DFC00CDFB1C61CA8A83F19107` |
| `tests/component/context-factory.test.ts` | 20043 | `D13622D52F23A12100AEDAD1B4AFAFFBABB94E3AB6D8FA053403DCDB86497C11` |
| `package.json` | 899 | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | 57475 | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Report contract

The report must record baseline and final hashes, exact edited paths, RED and GREEN commands with exit codes/test counts and the intended failure reason, all regression commands and results, invariant reasoning, self-review findings, and an explicit statement that Git/dependency/live-target/Task 2+ work did not occur. Return to the controller in fewer than 15 lines with status, test summary, concerns, and the report path.
