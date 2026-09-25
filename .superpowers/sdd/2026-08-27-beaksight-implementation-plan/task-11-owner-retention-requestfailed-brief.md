# Task 11 review correction — terminal owner retention and requestfailed task ownership

Date: 2026-09-22. Root: `C:/Develop/github-repo/BeakSight`.

## Scope and authority

Implement only the two user-reported Task 11 Important findings:

1. `auditInteraction()` must not return a normal result while its owner-managed Context is non-terminal and unreachable.
2. the `requestfailed` listener must use the existing bounded Guard Task Registry and participate in terminal drain.

The user approved the bounded design with one additional binding constraint: cleanup retry is finite. Use an explicit **two-attempt total close budget** (initial attempt plus one automatic retry). If both attempts finish with a non-terminal Guard state, throw a structured safety failure that retains the same session owner for upper-layer recovery. Do not add a second registry. Do not start Task 12+.

Read completely before editing: current Task 11 correction design/plan, latest fixed review package, latest final spec/quality reviews, this brief, and the current source/tests in scope.

## Frozen baseline

Verify every hash before work; stop on mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-08-27-beaksight-implementation-tasks.md` | `1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/browser/context-factory.ts` | `26C34D95FF4B104BC5950329B9AECA4B291B75C41F0D51CEA1AC983F51F488A4` |
| `src/interaction/isolated-auditor.ts` | `887127C795CB98ADA79B8C1E29CDB143F11C9F3D346462E4174BE4219A812220` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `tests/component/context-factory.test.ts` | `88E51355C9AF77ABC346AC2CE13BA77DBFA44E809BAA11ABC2BA9F67C74C388D` |
| `tests/integration/isolated-interaction.test.ts` | `80ADE243FE12F80FD98FFB63816957FE4E5A4486935F7F447943879777187EE9` |
| `tests/integration/passive-request-guard.test.ts` | `55FC9C0498312FA8A3A21A79AD26408F7A942970B5F834E87B4B05FF42757396` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md` | `A35D738CB3807488D5162744BCB3DE306B539092E87AF0474429EB271C115068` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-final-quality-fix-round-1-spec-review.md` | `CA51D89BC5A4B1038A2D82E95743BB402C4CBCE2DB700E3234BBD24AFB4EFD7F` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-final-quality-fix-round-1-quality-review.md` | `B05B4D86EB2CA03E1DB19C7B20DBB7D6F0E520B5D2CA64141DB73ED45B0D783F` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `8F274F19B3887D449C829D8F057F8C7BEC5354E25FEF14C8CDD0AF21222B88DC` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `974EA65B9386D00DC5C650769FF65DCB42C947DCEC83E4AF8B63A2E62454B87C` |

## Important 1 — bounded terminal cleanup ownership

### Required behavior

- Add an explicit named constant for exactly **2 total owner-close attempts** per audit.
- `auditInteraction()` keeps the same `InteractionAuditSession` strongly reachable across both attempts and checks canonical `session.isClosed()` only after each attempt settles.
- If attempt 1 rejects or fulfills non-terminal, record the existing invariant, retain the anomaly, and perform attempt 2 through the same `session.close()`/Factory/Guard SSOT.
- If either attempt reaches terminal:
  - return only a `CLOSED` lifecycle;
  - retain the latest cleanup anomaly reason structurally in the lifecycle;
  - if any rejected or fulfilled-non-terminal anomaly occurred, final top-level status remains `BLOCKED_BY_SAFETY` with the fixed close-safety reason;
  - preserve the original work outcome/evidence unchanged.
- If attempt 2 remains non-terminal, do **not** return `InteractionAuditResult`. Throw an exported structured `InteractionOwnerCleanupError` that:
  - has a fixed bounded safety message/name;
  - strongly retains the exact same `InteractionAuditSession` as a public read-only owner handoff;
  - retains candidate id, frozen work outcome, frozen `NON_TERMINAL` lifecycle, and detached frozen safety snapshot;
  - records `INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED` before taking that snapshot;
  - preserves last rejection presence separately from value, including `Promise.reject(undefined)`;
  - allows the upper layer to call `error.session.close()` and reach `CLOSED` through the same Factory/Guard path.
- No background retry, global owner table, replacement Factory registry, or optional/default terminal state. The thrown error is the explicit upper-layer ownership transfer, following the existing `ContextConstructionError` handoff pattern.
- Persistent non-terminal cleanup is bounded by attempt count; no unbounded loop or timer retry.

### Mandatory RED cases before production edits

1. Real Factory/Guard session: raw close fails once, automatic retry succeeds, audit returns only after `CLOSED`, raw close count is 2, work is preserved, final status is safety-blocked.
2. Both automatic attempts fail/non-terminal: audit rejects with `InteractionOwnerCleanupError`, not a normal result; the error retains the exact session and frozen structured diagnostics; a later `error.session.close()` succeeds and reaches `CLOSED`/factory release.
3. First close fulfills but remains non-terminal, second reaches `CLOSED`: invariant is retained, result is `CLOSED` and safety-blocked.
4. Rejection with value `undefined` is treated as a present anomaly and preserved in both recovered and exhausted paths.
5. Terminal semantic invalidation rejection does not retry unnecessarily and remains `CLOSED` plus safety-blocked.

## Important 2 — requestfailed in the existing Guard Task Registry

### Required behavior

- The registered `requestfailed` callback itself is synchronous/void and immediately delegates all request classification/evidence/invalidation work to existing `runGuardProtocolTask()` (or a thin non-owning wrapper around it).
- Use the existing `pendingTasks`, `admitGuardTask()`, `MAX_PENDING_GUARD_TASKS`, overflow invalidation, and drain. A second Set/queue/registry is forbidden.
- Replace in-task `await initiateInvalidation()` with `requestInvalidation()` so the task removes itself from `pendingTasks` before joining/starting invalidation; no self-drain deadlock.
- Contain the listener-facing returned Promise so EventEmitter cannot create an unhandled rejection. Preserve specific evidence/invariant recording.
- A requestfailed callback admitted during raw close must be observed by `drainGuardTasks()` before terminal transition.
- On 257 synchronous callbacks, at most 256 are admitted, `GUARD_TASK_LIMIT_REACHED` is recorded once, and the existing overflow invalidation owner is used.

### Mandatory RED cases before production edits

1. A requestfailed callback fired synchronously during raw close remains pending/drained and can promote invalidation before `CLOSED`.
2. 257 synchronous requestfailed callbacks prove the shared 256-task bound, one overflow violation, one invalidation owner, and no second registry/unhandled rejection.
3. A requestfailed task failure plus close/invalidation rejection produces no process-level unhandled rejection.
4. Existing expected route-failure suppression, main-frame classification, CDP correlation, and close-abort behavior remain unchanged.

## Strict TDD and file boundary

- Tests first. Run them against the frozen production hashes and capture genuine behavioral RED. Compilation errors, missing exports, temporary production stubs, harness errors, or renderer failures are not accepted RED.
- Recheck frozen production hashes immediately after accepted RED.
- Smallest coherent production scope: `src/interaction/isolated-auditor.ts`, `src/safety/passive-request-guard.ts`, and only if required for the canonical session contract `src/browser/context-factory.ts`.
- Test scope: `tests/integration/isolated-interaction.test.ts`, `tests/integration/passive-request-guard.test.ts`, `tests/component/context-factory.test.ts` as needed.
- Preserve Task 11 DOM-budget, Handle ownership, structured work/lifecycle, S03–S08, ordinal-cap, and close/invalidation precedence behavior.
- Use `apply_patch` for edits.
- No Git operations.
- No dependency/library download/install/update/new unapproved import/package mutation.
- No live target, no Task 12+, no implementer-spawned subagent/reviewer.
- Historical Task 2 I7 remains an explicit irreversible original-RED evidence deviation.

## Required fresh verification

Run and report exact command/count/exit code for:

1. Task 11 focus tests.
2. close failure -> retry -> `CLOSED` focus.
3. non-terminal owner retention/recovery focus.
4. close/invalidation race focus.
5. Guard task-registry boundedness focus.
6. requestfailed/close race focus.
7. DOM work-budget focus.
8. full `tests/integration/isolated-interaction.test.ts`.
9. full `tests/integration/passive-request-guard.test.ts`.
10. full `tests/component/context-factory.test.ts`.
11. six-file Task 11 regression.
12. repository full suite.
13. `npm run typecheck`.
14. `npm run build`.
15. forbidden-boundary/package-drift scans from the latest Task 4 report.

For every unrun item, append an exact NOT RUN block with reason, impact, and completion relevance.

## Deliverables

- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-owner-retention-requestfailed-report.md`
- replacement `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md`, retaining full ancestry and adding this brief/report
- append-only Task 5 and progress ledger entries

The replacement package must be self-nonreferential, fresh-hash every entry, and report entries/unique/missing/mismatch/duplicate plus substitutions/additions/removals against the current 89-entry package. Stop after implementation, verification, and package creation. Independent review is controller-owned.
