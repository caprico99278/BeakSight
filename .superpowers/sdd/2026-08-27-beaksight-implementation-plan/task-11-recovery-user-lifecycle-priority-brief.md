# Task 11 Recovery — User Lifecycle-Priority Correction

## Status and authority

Task 11 is not approved. Task 12 and later work are blocked. This brief records the user's binding correction after the unreviewed Fix round 3 workspace state.

No Git operation is permitted. Do not download, install, update, or import dependencies. Do not access a live target. Use `apply_patch` for edits. Do not dispatch subagents.

## Confirmed root cause

The current Guard conflates close-in-progress with terminal close:

- `invalidateContext()` discards an invalidation request when phase is `PASSIVE_CLOSING` or `FROZEN_CLOSING`.
- `BrowserContextFactory.closePassiveContext()` releases `#activeContexts` in `finally`, including raw/guard close failure and other non-terminal outcomes.
- `InteractionGuardedSession.close()` sets its local `closed` flag before terminal ownership release is established, making a failed/non-terminal close non-retryable.

Consequently the outcome can depend on whether normal close or safety invalidation starts first, and a physically unconfirmed Context can lose its owner.

## Required state-machine contract

1. Make `invalidation > normal close` an explicit priority rule.
2. An invalidation requested during `PASSIVE_CLOSING` or `FROZEN_CLOSING` must be retained and reflected in the terminal public outcome; it must not be discarded by an early return.
3. A `VERIFIED` work outcome followed by normal-close start and then safety invalidation must finalize as `BLOCKED_BY_SAFETY`, even when raw Context close succeeds.
4. `invalidation -> close` and `close -> invalidation` must converge to the same final interaction status and preserve final Safety Ledger evidence through the stable cutoff.
5. Factory/session ownership may be released only after a terminal Guard state is confirmed. A close failure while invalidation is active must not remove factory ownership or permanently mark the session closed. The owner must retain a valid retry/join path without issuing a second raw close.
6. Preserve exactly-once raw close, bounded stable task drain, listener cleanup ownership, fail-closed state, and all prior Task 11 recovery contracts.

## Mandatory genuine RED tests

Before modifying production, add and run behavioral tests proving all three old failures:

1. `VERIFIED candidate -> close starts -> invalidation -> raw close succeeds` always yields `BLOCKED_BY_SAFETY` with final evidence.
2. `invalidation -> close` and `close -> invalidation` yield the same final status and raw-close cardinality.
3. `context.close()` failure during invalidation does not cause `BrowserContextFactory` or `InteractionGuardedSession` to lose ownership of the non-terminal Context; a later owner call can still join/retry according to the state machine.

Each test must name the production mutation it catches and exercise the real production path. Prefer the real `BrowserContextFactory` and `auditInteraction()` path; use a controlled raw-close gate/failure only at the Playwright boundary. Record the exact failing assertion/output before any production edit.

## Minimal implementation and verification

After all mandatory REDs fail for the expected lifecycle defect, implement the smallest coherent state-machine correction. Do not patch only the finalizer or only the tests. Do not change `discover-candidates.ts` or start Task 12.

Run and record:

- the three mandatory focus tests;
- all lifecycle/finalizer focus tests in `tests/integration/passive-request-guard.test.ts`, `tests/component/context-factory.test.ts`, and `tests/integration/isolated-interaction.test.ts`;
- the complete Task 11 regression set;
- the full maintained repository suite if the Task 11 set passes;
- `npm run typecheck`;
- `npm run build`;
- the existing forbidden-boundary/type-escape scans;
- SHA-256 hashes for every changed source, test, report, package/config authority.

Append a full Fix round 4 report to `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`, including root-cause trace, RED/GREEN commands and outputs, exact test counts, first-run/retry disclosure, ownership/phase transition table, files changed, hashes, self-review, and deferred-Minor disposition.

Current unreviewed workspace baselines at dispatch:

```text
09BFCA669E62D5CF0D1EE9B3FC9A83F0512F86716D20A21197F9712234DF6A8E  src/safety/passive-request-guard.ts
ED324497E7DDA358868D7C01D71926CD0DFA2A548E2EE7BCECCB936FA3350282  src/browser/context-factory.ts
BA37461400CA78A0C91B9EBFF36434A97DAE1C552290553B86738B5C954F842C  tests/integration/passive-request-guard.test.ts
6EF2E190220B5B7E56C1C8BAE6E714B5E9AB39D4CF22EEFDEDD0798DAE0CFE8D  tests/component/context-factory.test.ts
D55D612B9C514F3B8115975AC5F82BD00648A809C4524FB4067BAAF2B4EC4BF3  tests/integration/isolated-interaction.test.ts
```

These include incomplete/unreviewed Fix round 3 work. Treat them as the immutable dispatch baseline; do not claim that round complete.
