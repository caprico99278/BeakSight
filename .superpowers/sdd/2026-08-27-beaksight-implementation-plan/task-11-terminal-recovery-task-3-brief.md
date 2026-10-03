# Task 11 correction — Task 3 fixed implementation brief

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Scope

Implement only approved correction-plan Task 3, “Preserve work and lifecycle as separate structured result axes.” Task 1 and Task 2 are consumed as fixed prerequisites. Do not start correction Task 4 or product Task 12+.

Read the complete approved design, complete Task 3 plan section, Task 1 terminal-retry report/review, and final Task 2 round-2 report/review before editing. Follow the plan Steps 1–13 with strict TDD.

## Frozen baseline

Verify every hash before work; stop on mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` |
| `src/interaction/isolated-auditor.ts` | `9EDBFF6B7ADFE79053F2507A012262092C6AA874D849C9FCDC2C77C044BBCCCD` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |
| `tests/component/context-factory.test.ts` | `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9` |
| `tests/integration/isolated-interaction.test.ts` | `F5A889FF7F52682CD810CB3DAB3569D8116BD303CEAAA0CA0EFE860E1F70E894` |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-report.md` | `EF121EEB23F87BF8F409B29819C701997D1B4071362D74E118BFB1347B1DBC72` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-manifest.md` | `8249C9AB4E407A0373407685DBA339061D6532B0EC4F888C2FBBACD78BE8B221` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-review.md` | `17F2DC0440F187C03E1221CC2C3942AC0EBBDF1971F03F50F2A00F27180FED91` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `61D54731C4B6E690942C1481DB8FB64427F3C55107725B81ACAD361B56F9F0EA` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `3D53570100E1E51EB0FC70536017CC4C7C413D7D9368101CA99B07F62CE50302` |

## Required result contract

Implement and export the exact structured axes from the plan:

- `InteractionWorkOutcome`: original work `status`, `reason`, and frozen `evidence`.
- `InteractionLifecycleOutcome`: `CLOSED` with nullable close reason, or `NON_TERMINAL` with bounded reason.
- `InteractionAuditResult`: compatible top-level `status/reason/evidence`, plus immutable `work`, `lifecycle`, and detached immutable `safety`.
- `result.evidence === result.work.evidence` by identity.

Finalization priority is binding:

1. any safety freeze -> top-level `BLOCKED_BY_SAFETY`, freeze reason;
2. lifecycle `NON_TERMINAL` -> top-level `BLOCKED_BY_SAFETY`, fixed lifecycle reason;
3. terminal close rejection -> top-level `BLOCKED_BY_SAFETY`, fixed safety-failure reason;
4. otherwise mirror structured work status/reason.

Never encode `work.status`, `work.reason`, or evidence details into the final safety reason string.

## Lifecycle truth requirements

- Add `InteractionGuardedSession.isClosed(): boolean`; production delegates to `isPassiveRequestGuardClosed(context)`.
- Every test double owns an explicit `closed` boolean changed only by fake close behavior; no default-to-terminal fallback.
- Track close-failure presence separately from its value so rejection with `undefined` remains a failure.
- A close rejection with Guard terminal state produces lifecycle `CLOSED` plus rejection reason, not `NON_TERMINAL`; final verdict remains safety-blocked.
- A close rejection without terminal state produces lifecycle `NON_TERMINAL`; retain original work structurally.
- A fulfilled close whose Guard remains non-terminal records `INTERACTION_OWNER_CLOSE_NON_TERMINAL`, yields lifecycle `NON_TERMINAL`, and blocks final status.
- Preserve exactly-once close/finalization ownership and take the final ledger snapshot only after close/lifecycle invariant recording.

## Mandatory RED before production edits

Add tests first, typecheck the test-only state, then run the exact plan focus against unchanged production. Capture exact failures and recheck production hashes before editing. Required RED cases:

1. `EXECUTION_FAILED` work + rejected non-terminal close: fixed top-level reason, structured original work/evidence, structured lifecycle, exactly-one close, ledger failure.
2. `VERIFIED` work + rejected non-terminal close: final blocked, original verified reason/evidence preserved only under `work`, no ad-hoc string encoding.
3. Real factory terminal invalidation rejection: `lifecycle: CLOSED`, rejection reason retained, final blocked, original `VERIFIED` work retained.
4. Fulfilled-but-non-terminal fake close: invariant recorded and final blocked.
5. close rejection with exact value `undefined`: failure presence preserved for terminal and non-terminal outcomes.
6. Normal success immutable graph: result/work/lifecycle/evidence/changedFields/safety and every safety array frozen; evidence alias identity preserved.
7. Freeze precedence over every lifecycle/work combination and compatibility of top-level fields.

RED must reflect missing current behavior, not compile/harness/fixture failures or temporary production stubs.

## Implementation and test constraints

- Primary files: `src/browser/context-factory.ts`, `src/interaction/isolated-auditor.ts`, `tests/integration/isolated-interaction.test.ts`, `tests/component/context-factory.test.ts`.
- Update every session fake and all compile-time consumers of `InteractionGuardedSession`; preserve existing assertions unless the approved new final-reason contract intentionally replaces them.
- Use `outcome()`/dedicated constructors as the sole frozen work/lifecycle construction paths; bound lifecycle reason with the existing maximum.
- Deeply detach/freeze safety arrays and preserve all evidence immutability from Task 2.
- Preserve Task 1 retryability/terminal ownership and Task 2 bounded-DOM behavior.
- Use `apply_patch` for edits.
- No Git operations.
- No dependency/library download/install/new unapproved import/package mutation.
- No live target; no correction Task 4 or product Task 12+; no subagents/reviewers.
- Keep prior I7 historical evidence deviation unchanged and honest.

## Mandatory fresh verification

Run and report exact counts/exit codes:

1. Task 3 focus from plan Step 12.
2. Full `tests/integration/isolated-interaction.test.ts`.
3. Full `tests/component/context-factory.test.ts`.
4. Full `tests/integration/passive-request-guard.test.ts`.
5. Lifecycle race focus.
6. Task 2 DOM focus/non-regression.
7. Repository full suite.
8. Typecheck.
9. Build.
10. Static scans for old ad-hoc final reason interpolation, missing `isClosed` on session fakes, and forbidden whole-DOM paths.

Record every unrun item with reason, impact, and completion relevance.

## Deliverables

- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-report.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-manifest.md`
- append-only progress and Task 5 ledger entries

The manifest must record genuine-RED production baselines and every final changed/authority/package path hash. Stop after the fixed package. Independent Task 3 review is controller-owned.
