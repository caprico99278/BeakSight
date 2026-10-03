# Task 11 terminal recovery — Task 1 fix round 1 brief

## Authority

- Approved design: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`
- Approved plan Task 1: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md`, lines 59-328.
- Failed independent review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-review.md`, SHA-256 `9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C`.
- Fix exactly review findings I1 and I2. Task 2+ and Task 12 remain forbidden.

Read the complete independent review before editing. Its reproduced diagnostics and line references are binding evidence; implementation details remain yours to derive from the approved design.

## Approval-blocking findings

1. `runGuardProtocolTask()` calls invalidation in `finally` and again in its continuation. A synchronous throw or directly rejected raw-close Promise can clear the first active attempt before the second call, causing an implicit second physical close, `CLOSED`, and a fulfilled protocol callback without an explicit owner retry.
2. `initiateInvalidation()` performs `error instanceof GuardTaskDrainTimeoutError` on an arbitrary raw-close rejection. A hostile Proxy can throw from `getPrototypeOf`, escaping event containment as `unhandledRejection` before bounded normalization.

## Required TDD correction

- Before production edits, add focused tests that reproduce I1 for valid immediate failure timing. Cover at least one synchronous throw and one direct `Promise.reject` boundary through a real Guard protocol callback. Assert the callback observes the first raw failure, raw close count remains one, Guard remains non-terminal, and only a later explicit owner close performs attempt two and reaches `CLOSED`.
- Before production edits, add a focused event-containment test using the existing hostile Proxy shape as raw Context-close rejection. Capture process `unhandledRejection`, prove none escapes, prove the bounded failure is ledgered, and prove the Guard remains non-terminal/retryable.
- Run the focused tests against current production and record genuine RED caused by I1/I2, not browser environment or harness errors.
- Implement the minimum fix. One protocol callback/invalidation event must create or obtain exactly one current attempt Promise and reuse that same Promise for both early promotion/containment and the callback's semantic wait; it must never call retry-capable invalidation twice for one event.
- All rejection classification/containment before `errorMessage()` must be total for arbitrary JavaScript values. A hostile value must never make the containment path reject.
- Preserve canonical explicit-owner retry, single-flight overlap, publication-before-re-entry, invalidation priority, drain-only retry, terminal-only release, original page/install causes, and existing bounded ledgers.
- Rerun the corrected focused tests, the Task 1 expanded focus, both scoped files, repository suite, and `npm run typecheck`. Do not run build in this fix round.

## Scope and constraints

- Expected production edit: `src/safety/passive-request-guard.ts` only.
- Expected test edit: `tests/integration/passive-request-guard.test.ts` only.
- Do not modify `src/browser/context-factory.ts` or `tests/component/context-factory.test.ts` unless a newly failing Task 1 regression proves a necessary in-scope correction; if so, explain before editing.
- Append evidence to the existing Task 1 report, Task 5 report, and progress ledger.
- Create `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-report.md` and a fixed round-1 manifest.
- No Git operations, dependency/library download/install/import/package mutation, live-target access, Task 2/3/4/12 work, or subagents/reviewers.

## Frozen round-1 baseline

| Path | Bytes | SHA-256 |
|---|---:|---|
| `src/safety/passive-request-guard.ts` | 53193 | `0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2` |
| `src/browser/context-factory.ts` | 6815 | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` |
| `tests/integration/passive-request-guard.test.ts` | 152243 | `A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1` |
| `tests/component/context-factory.test.ts` | 22121 | `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9` |
| `package.json` | 899 | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | 57475 | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| Task 1 implementation report | 20999 | `1C98AE6F5B2CAB890948E312BD3108039AF6AE1984555DFA627D488FD12C219C` |
| failed independent review | 22431 | `9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C` |

## Handoff

The fix report must include exact RED/GREEN commands, exit codes/counts, production hashes unchanged at RED, final hashes, changed paths, mutation killed per test, regression/typecheck evidence, self-review, and constraint confirmation. Return under 15 lines. Independent re-review is controller-owned.
