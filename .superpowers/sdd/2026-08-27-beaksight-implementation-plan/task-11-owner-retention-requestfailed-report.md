# Task 11 owner retention and requestfailed task ownership — implementation report

Date: 2026-09-22. Root: `C:/Develop/github-repo/BeakSight`. Scope: only the two Important findings frozen in `task-11-owner-retention-requestfailed-brief.md`.

## Outcome

Both findings are implemented and locally verified. `auditInteraction()` now has an explicit two-attempt total owner-close budget. It returns only after canonical `CLOSED`, or throws immutable `InteractionOwnerCleanupError` while retaining the exact session for upper-layer recovery. The `requestfailed` listener is synchronous/void and delegates into the existing bounded Guard Task Registry; it adds no second registry and participates in terminal drain.

Task 11 is not approved by this report. Independent review is controller-owned, and Task 12+ remains blocked.

## Frozen baseline and constraints

The correction brief SHA-256 matched `5191150DAF61DBBE95029286640F3CD7E1639CD8FBF9320C5907F87EF81BF203`. All 20 frozen paths in its baseline table were recomputed before test edits: 20 entries / 20 matches / 0 missing / 0 mismatch. The three production paths, three test paths, authorities, package files, configs, prior reviews, prior package, and append-only ledgers therefore began at the frozen state.

No Git command, dependency/library download/install/update, new import, package mutation, live-target access, Task 12+ work, subagent, or reviewer was used. The historical Task 2 I7 original behavioral-RED absence remains an explicitly adjudicated irreversible evidence deviation; no evidence in this correction is presented as repairing it.

## TDD evidence

Tests were changed before production. The accepted unchanged-production behavioral RED command was:

`npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts tests/integration/passive-request-guard.test.ts -t "owner cleanup|lifecycle priority retained close retry|requestfailed callback is void-owned|257 synchronous requestfailed|contains requestfailed task failure"`

It exited 1 with 8 assertion failures, 2 passes, and 250 skips. The failures were behavioral: three one-close-versus-two-close failures, one missing structured owner-handoff error, one retained session retry rejection, and three missing void/shared-registry requestfailed behaviors. There were no compilation, missing-module, type-surface, harness, or unhandled-rejection failures in the accepted run. An earlier restricted Chromium `spawn EPERM` run was an environment/process-launch failure and is excluded from RED evidence. No standalone test-only `npm run typecheck` was run at this RED checkpoint; Vitest successfully transformed and imported all selected tests.

Immediately after accepted RED, all five frozen non-test protection hashes still matched: the three production files plus `package.json` and `package-lock.json`. Thus the RED preceded production edits.

The identical focus became GREEN: exit 0, 10 passed / 250 skipped. Additional exact focused GREEN runs were:

- close failure to retry to `CLOSED`: `npm test -- --run tests/integration/isolated-interaction.test.ts -t "owner cleanup retry closes a real Factory Guard session"`; exit 0, 1 passed / 123 skipped;
- retained non-terminal owner/recovery: `npm test -- --run tests/integration/isolated-interaction.test.ts tests/component/context-factory.test.ts -t "owner cleanup exhaustion|owner cleanup retries fulfilled|owner cleanup preserves an undefined|retained close retry releases"`; exit 0, 5 passed / 138 skipped.

The first restricted attempt at the one-test close focus also encountered `spawn EPERM`; the identical authorized run above passed and is the accepted verification.

## Minimal implementation

### Owner retention

`src/interaction/isolated-auditor.ts` now declares named `INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT = 2`. After each settled `session.close()` call it consults only canonical `session.isClosed()`. Rejection and fulfilled-but-non-terminal anomalies are recorded and retained across the second attempt. A terminal recovery returns immutable structured work and `CLOSED` lifecycle, while cleanup anomaly precedence keeps the compatible top-level status safety-blocked without overwriting the original work outcome.

After two non-terminal settlements, the auditor records `INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED`, takes a detached frozen safety snapshot, and throws exported frozen `InteractionOwnerCleanupError`. The error retains the exact session, candidate id, frozen work, frozen `NON_TERMINAL` lifecycle, detached safety, and separate `lastCloseRejected` presence from `lastCloseError`, including rejection value `undefined`. A later `error.session.close()` follows the same Factory/Guard path and can reach `CLOSED` and release the factory owner.

`src/browser/context-factory.ts` retains a prior non-terminal close anomaly for the session. Once a later explicit close reaches terminal state, the earlier non-terminal attempt does not prevent the retained owner from completing and releasing. A first-attempt terminal semantic invalidation rejection still rejects immediately and is not retried unnecessarily.

### requestfailed task ownership

`src/safety/passive-request-guard.ts` now registers a synchronous/void `requestfailed` callback. It delegates all classification, evidence, and invalidation work through the existing `runGuardProtocolTask(guardState, 'requestfailed callback', 'GUARD_REQUEST_FAILED_TASK_FAILED', ...)` path. Inside the task it calls `requestInvalidation()` rather than awaiting `initiateInvalidation()`, allowing the task to leave `pendingTasks` before invalidation joins or starts terminal drain. The listener-facing completion is rejection-contained.

The implementation reuses `pendingTasks`, `admitGuardTask()`, `MAX_PENDING_GUARD_TASKS`, the existing overflow invalidation owner, and the existing drain. No second Set, queue, registry, background retry, owner table, or timer was added.

## Test strength and migrations

New tests use real Factory/Guard sessions for retry/recovery, exact session identity, frozen structured handoff data, post-handoff recovery and release, fulfilled non-terminal settlement, `Promise.reject(undefined)`, terminal semantic invalidation cutoff, synchronous requestfailed during raw close, 257-callback shared admission capacity, one overflow violation/owner, and process-level unhandled-rejection containment.

Existing assertions that expected persistent non-terminal cleanup to return a normal result were migrated to the binding structured-error contract. Async-listener timing assumptions were migrated to synchronous/void callback plus owned Guard microtask semantics. A redundant post-terminal CDP consume assertion was removed from the terminal-cutoff case; consume-once correlation remains covered by the adjacent mismatched-correlation test. Intermediate broad-run failures were these stale contract/timing expectations, not production regressions; after test migration all full regressions passed.

## Required fresh verification

All commands below ran from the repository root. Counts are Vitest test counts, and every listed accepted command exited 0.

1. Task 11 focus tests — `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts -t "retry|drain-only|synchronous re-entry|lifecycle priority|total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes|owner cleanup|requestfailed"`: 49 passed / 211 skipped.
2. Close failure -> retry -> `CLOSED` focus — `npm test -- --run tests/integration/isolated-interaction.test.ts -t "owner cleanup retry closes a real Factory Guard session"`: 1 passed / 123 skipped.
3. Non-terminal owner retention/recovery focus — `npm test -- --run tests/integration/isolated-interaction.test.ts tests/component/context-factory.test.ts -t "owner cleanup exhaustion|owner cleanup retries fulfilled|owner cleanup preserves an undefined|retained close retry releases"`: 5 passed / 138 skipped.
4. Close/invalidation race focus — `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts -t "retry|drain-only|synchronous re-entry|lifecycle priority|close begins|invalidation|owner cleanup"`: 44 passed / 216 skipped.
5. Guard task-registry boundedness focus — `npm test -- --run tests/integration/passive-request-guard.test.ts -t "256 admitted tasks|257 synchronous requestfailed|bounds .* admission|task admission is denied"`: 5 passed / 112 skipped.
6. requestfailed/close race focus — `npm test -- --run tests/integration/passive-request-guard.test.ts -t "requestfailed callback|failed-request invalidation|unobserved requestfailed|synchronous re-entry"`: 6 passed / 111 skipped.
7. DOM work-budget focus — `npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work|whole-DOM|budget exhaustion|bounded exact-handle|shared ancestor|shared text|candidate discovery"`: 23 passed / 101 skipped.
8. Full isolated-interaction — `npm test -- --run tests/integration/isolated-interaction.test.ts`: 124/124 passed.
9. Full passive-request-guard — `npm test -- --run tests/integration/passive-request-guard.test.ts`: 117/117 passed.
10. Full context-factory — `npm test -- --run tests/component/context-factory.test.ts`: 19/19 passed.
11. Six-file Task 11 regression — `npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts`: 6 files / 309 tests passed.
12. Repository full suite — `npm test`: 26 files / 524 tests passed.
13. Typecheck — `npm run typecheck`: exit 0. It was rerun after the final test migration and again exited 0.
14. Build — `npm run build`: exit 0.
15. Forbidden-boundary/package-drift scans:
   - `rg -n '本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*[''\"]|innerHTML\s*=|setAttribute\(' src`: no matches. One earlier incorrectly PowerShell-quoted attempt produced no usable evidence; the corrected literal command was rerun and is the accepted clean scan.
   - `rg -n "querySelectorAll\(.*INTERACTION_CANDIDATE_SELECTOR|querySelectorAll\(selector\)|locator\(INTERACTION_CANDIDATE_SELECTOR\)" src/interaction`: no matches.
   - `package.json` SHA-256 remained `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233`; `package-lock.json` remained `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.

No required implementation verification item is unrun.

## Final scoped hashes

| Path | SHA-256 |
| --- | --- |
| `src/browser/context-factory.ts` | `454261DD6964756E9C06C4B9FD1C1CB80E14FDA5D458CCDC06549E6C973B6D6D` |
| `src/interaction/isolated-auditor.ts` | `0A030F675C5CCE748416006A5B2FA1EBD2016EA633C4B27A9C88BDBA11A63059` |
| `src/safety/passive-request-guard.ts` | `49921091F4A92C5C7D9ADBE8CBA3621C6542B657E64217DFA5407B49CB02B7E3` |
| `tests/component/context-factory.test.ts` | `6C89F85B0A0582C552EFBE4737F3C78B68767F6466B002CBB8BF2BBFE7AB1670` |
| `tests/integration/isolated-interaction.test.ts` | `86B9AACF119734289DABD98EF319AFF00D915E91C40C7184E82FEA241621019E` |
| `tests/integration/passive-request-guard.test.ts` | `9E7617A4A06E15067073FE0287DA7B72205D01A05B2346448889945DEF8D81C6` |

## NOT RUN gates

NOT RUN — independent Task 11 specification review. Reason: explicitly controller-owned after fixed-package handoff; implementer self-review is prohibited. Impact: the correction's specification conformance is not independently accepted. Completion relevance: blocks Task 11 approval.

NOT RUN — independent Task 11 code-quality review. Reason: explicitly controller-owned after fixed-package handoff; implementer self-review is prohibited. Impact: the correction's quality is not independently accepted. Completion relevance: blocks Task 11 approval.

NOT RUN — Task 11 approval and Task 12+ implementation. Reason: clean independent review and explicit user approval remain required. Impact: no later product work is authorized. Completion relevance: Task 12 remains blocked.

## Handoff

The replacement fixed review package retains the full 89-entry ancestry and adds this correction brief and report. It is intentionally self-nonreferential. The controller owns manifest revalidation, independent review, final adjudication, and any subsequent correction loop.
