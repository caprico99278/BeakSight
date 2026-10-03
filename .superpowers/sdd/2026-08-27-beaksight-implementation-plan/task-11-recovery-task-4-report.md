# Task 11 recovery — Task 4 report

## Status and authority

- Task 4 is implemented without starting Task 5.
- Approved design SHA-256: `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18`.
- Task 4 brief SHA-256: `04B7EDC8072155913033884135944105AE617A73E5B1D0082FEB4E1EB60912AD`.
- Both dispatched production/test hashes and both immutable Task 4 baseline-copy hashes matched before edits.
- No Git command was run. No commit was created. No dependency/package operation or live-target access was performed. The controller progress ledger was not edited.

## TDD mutations covered

1. **Deadline disposal ownership:** moving the post-acquisition deadline check outside the non-null handle owner lets a rejected `dispose()` replace the established `NOT_VERIFIABLE` status and deadline reason. The extended test caught exactly this behavior.
2. **Unexpected work plus close failure:** the old dual-failure branch leaked `AggregateError` and returned no interaction result. The replacement test requires a `BLOCKED_BY_SAFETY` result, the encoded `EXECUTION_FAILED` work reason/evidence, and a separate owner-close ledger invariant.
3. **Click evidence plus close failure:** the old close branch rejected after the click failure had already been encoded with changed evidence. The added test requires the work status/reason and `ariaExpanded` evidence to survive final owner close failure.

The RED tests were added before any production edit. The first non-escalated run stopped at installed-Chromium launch with `spawn EPERM` and was not treated as behavioral RED. Permission to launch the already-installed browser was then granted; no browser or package download occurred.

## Exact focused RED output

Command:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "deadline handle dispose failed|work and owner-close failures|click failure and owner close"
```

Output before the production edit:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t deadline handle dispose failed|work and owner-close failures|click failure and owner close


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (48 tests | 3 failed | 45 skipped) 1356ms
     × preserves the deadline outcome when deadline handle dispose failed 141ms
     × preserves both work and owner-close failures in a returned safety result 93ms
     × preserves changed evidence when click failure and owner close both fail 99ms

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > preserves the deadline outcome when deadline handle dispose failed
AssertionError: expected 'EXECUTION_FAILED' to be 'NOT_VERIFIABLE' // Object.is equality

Expected: "NOT_VERIFIABLE"
Received: "EXECUTION_FAILED"

 ❯ tests/integration/isolated-interaction.test.ts:841:29

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > preserves both work and owner-close failures in a returned safety result
Error: fixture work failed
 ❯ Object.goto tests/integration/isolated-interaction.test.ts:1082:49
 ❯ executeInteraction src/interaction/isolated-auditor.ts:148:22
 ❯ auditInteraction src/interaction/isolated-auditor.ts:334:25

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > preserves both work and owner-close failures in a returned safety result
Error: fixture close failed
 ❯ Object.close tests/integration/isolated-interaction.test.ts:1088:50
 ❯ auditInteraction src/interaction/isolated-auditor.ts:340:21

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > preserves changed evidence when click failure and owner close both fail
Error: fixture close failed
 ❯ Object.close tests/integration/isolated-interaction.test.ts:1155:50
 ❯ auditInteraction src/interaction/isolated-auditor.ts:340:21

 Test Files  1 failed (1)
      Tests  3 failed | 45 skipped (48)
   Start at  13:23:13
   Duration  1.95s (transform 134ms, setup 0ms, import 417ms, tests 1.36s, environment 0ms)
```

This was genuine behavioral RED: all three selected tests executed, and each failed on the old production ownership/finalization behavior rather than on test setup.

## Implementation and design decisions

- `elementHandle()` remains nullable at acquisition. A null handle returns the existing no-handle outcome without disposal because no resource was acquired.
- Every non-null handle path now enters one `try/finally` immediately. The acquisition-deadline check, retained inspection, admission, click, observation, safety, identity-loss, timeout, ordinary return, and unexpected throw paths all pass through the same finalizer.
- The handle finalizer catches `dispose()` rejection and records `INTERACTION_HANDLE_DISPOSE_FAILED`. It never replaces an established status, reason, or evidence.
- Once `sessionFactory()` succeeds, `auditInteraction()` computes exactly one `InteractionWorkOutcome`. Unexpected work throws are bounded once into `EXECUTION_FAILED` with immutable empty evidence.
- Owner close is attempted in one place exactly once. Rejection is recorded as `INTERACTION_OWNER_CLOSE_FAILED`; no `AggregateError` or raw close error escapes after a session exists.
- `finalizeInteractionOutcome()` is pure. Owner-close failure returns `BLOCKED_BY_SAFETY` with a bounded summary containing the prior work status and reason and reuses the exact immutable work evidence. Otherwise, a freeze event in the one final ledger snapshot preserves the approved Task 1 `BLOCKED_BY_SAFETY` precedence.
- The final Safety Ledger snapshot is taken once, after owner close completes or rejects and after the close invariant is recorded. Freeze evidence recorded during close is therefore retained. `SafetyLedger.snapshot()` copies and freezes all arrays/events/counters, so later ledger mutation is not aliased into the result.
- `input.sessionFactory(viewport)` remains outside the work/close catch boundary. Factory rejection still rejects `auditInteraction()` because no session, ledger, or evidence owner exists.

## Exact focused GREEN output

The identical focused command after the minimal production edit:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t deadline handle dispose failed|work and owner-close failures|click failure and owner close


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  3 passed | 45 skipped (48)
   Start at  13:24:03
   Duration  2.06s (transform 133ms, setup 0ms, import 483ms, tests 1.37s, environment 0ms)
```

## Required verification results

Full isolated-interaction plus interaction-policy command:

```text
> beaksight@0.1.0 test
> vitest run --run tests/unit/interaction-policy.test.ts tests/integration/isolated-interaction.test.ts


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  2 passed (2)
      Tests  70 passed (70)
   Start at  13:24:23
   Duration  11.48s (transform 142ms, setup 0ms, import 479ms, tests 10.89s, environment 0ms)
```

This full isolated suite includes and preserves all Task 3 discovery/retained traversal tests.

Adjacent request-policy, Safety Ledger, context-factory, passive-request-guard, and isolated-interaction command:

```text
> beaksight@0.1.0 test
> vitest run --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  5 passed (5)
      Tests  168 passed (168)
   Start at  13:24:43
   Duration  11.65s (transform 393ms, setup 0ms, import 1.43s, tests 17.85s, environment 0ms)
```

Typecheck:

```text
> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Build:

```text
> beaksight@0.1.0 build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
```

Both commands exited `0`.

Final maintained repository suite:

```text
> beaksight@0.1.0 test
> vitest run --run tests


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  26 passed (26)
      Tests  405 passed (405)
   Start at  13:28:23
   Duration  14.78s (transform 2.57s, setup 0ms, import 10.59s, tests 46.00s, environment 4ms)
```

## Changed files and SHA-256

| File | Before | After |
| --- | --- | --- |
| `src/interaction/isolated-auditor.ts` | `BD8FCB49BB765D27BBB18E8CC4562185B87BDDC326F96549A9C626558291BED0` | `5F76FAEC3F8CCC475BE60ABFA0E4709C1527559BA41881DCE508A6C14ABC23DD` |
| `tests/integration/isolated-interaction.test.ts` | `9B2605E13CEEB4B7026ED19B4AE88592213D3D4C7F3FE19AD31E58CAA40FB87E` | `9915397E473BBDEBB3284C19E9E8B5ED041CB17931F47AC002CC1E3382EAFEC0` |

The `Before` hashes are the dispatched files and their byte-identical immutable Task 4 baseline copies.

Package files are unchanged:

| File | Before | After |
| --- | --- | --- |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Every non-null ElementHandle path self-review

There is one production acquisition in `executeInteraction()`:

1. Deadline before acquisition: returns before acquiring a handle; no disposal ownership exists.
2. `elementHandle()` rejects: acquisition never returns a handle; the exception becomes the audit work outcome and no disposal is attempted.
3. `elementHandle()` returns `null`: the sole post-acquisition check outside the owner scope returns the existing no-handle outcome; no disposal is attempted.
4. Any non-null return immediately enters the single owner `try/finally`.
5. Deadline immediately after acquisition returns from inside the owner scope and still reaches caught disposal.
6. Fact-collection deadline, disconnected target, changed exact-node identity, exact-admission deadline/rejection, and pre-click deadline all return through the same finalizer.
7. Click success, ordinary click error, timeout click error, observation deadline, freeze detection before/after inspection, retained identity loss, verified evidence, and no-change deadline all return through the same finalizer.
8. Unexpected retained inspection/discovery/render exceptions unwind through the same finalizer before becoming the bounded work outcome.
9. `dispose()` is invoked exactly once for every non-null acquired handle. Its failure records `INTERACTION_HANDLE_DISPOSE_FAILED` once and cannot overwrite the work status/reason/evidence.

No second production disposal owner or optional-dispose branch remains.

## Every post-session return/throw path self-review

1. Input validation, candidate/viewport freezing, deadline validation, and `sessionFactory()` all occur before session ownership. Factory rejection is intentionally not caught and remains a rejection.
2. After session acquisition, `executeInteraction()` either returns an `InteractionWorkOutcome` or its throw is converted once into `EXECUTION_FAILED`; there is no result return in this phase.
3. `session.close()` is then awaited in exactly one location and on every work-value/work-error path. Success is retained; failure is caught and ledgered once.
4. One final ledger snapshot is taken only after the close attempt. This preserves close-time freeze events and the close-failure invariant in immutable evidence.
5. One pure finalizer applies close/freeze precedence without changing the work evidence object.
6. There is one result return and no explicit throw after session creation. The retired `AggregateError`, raw close rethrow, undefined-outcome branch, and duplicate cleanup ownership are absent.

## Concerns

- The sandbox initially denied spawning the installed Chromium (`spawn EPERM`). The required browser tests were rerun with explicit launch permission and then produced the genuine RED and all GREEN results above. No download occurred.
- An extra unscoped `npm test -- --run` verification attempt discovered six immutable `.superpowers` baseline/pre-fix test copies. Those copies cannot resolve their deliberately relocated relative imports, so Vitest reported six collection failures while all 26 maintained test files and all 405 maintained tests passed. No baseline or configuration was changed. The correct maintained-suite command, `npm test -- --run tests`, passed 26/26 files and 405/405 tests as recorded above.
- npm printed its routine notice that a newer npm major version exists. No install/update command was run, and package hashes remained unchanged.
- No implementation concern remains within Task 4 scope. Fresh independent specification/code-quality review is still the controller's next checkpoint; this implementer did not start Task 5.

## Fix round 1

### Review authority and entering state

- Independent review SHA-256 verified before edits: `85A19F4A4A6A596F042DD0B02FB1DDC76EADD60439125EEE89EB722C6162368C`.
- Entering production SHA-256: `5F76FAEC3F8CCC475BE60ABFA0E4709C1527559BA41881DCE508A6C14ABC23DD`.
- Entering test SHA-256: `9915397E473BBDEBB3284C19E9E8B5ED041CB17931F47AC002CC1E3382EAFEC0`.
- Entering `vitest.config.ts` SHA-256: `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184`.
- All four findings were technically verified against the entering source before implementation. Findings 1–3 received a separate genuine behavioral RED and focused GREEN in sequence. Finding 4 was test-only assertion hardening and required no production behavior change.

### Finding 1 — rejection value independent from close-failure state

Disposition: fixed. `auditInteraction()` now owns an explicit `closeFailed` boolean. Any rejected value, including `undefined`, records one `INTERACTION_OWNER_CLOSE_FAILED`, produces `BLOCKED_BY_SAFETY`, preserves the bounded work reason/evidence, and does not cause a second close.

Genuine RED:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t undefined owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (49 tests | 1 failed | 48 skipped) 1353ms
     × treats an undefined owner close rejection as a failed close exactly once 137ms

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > treats an undefined owner close rejection as a failed close exactly once
AssertionError: expected 'EXECUTION_FAILED' to be 'BLOCKED_BY_SAFETY' // Object.is equality

Expected: "BLOCKED_BY_SAFETY"
Received: "EXECUTION_FAILED"

 ❯ tests/integration/isolated-interaction.test.ts:1128:27

 Test Files  1 failed (1)
      Tests  1 failed | 48 skipped (49)
   Start at  13:45:29
   Duration  1.94s (transform 128ms, setup 0ms, import 415ms, tests 1.35s, environment 0ms)
```

Focused GREEN:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t undefined owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  1 passed | 48 skipped (49)
   Start at  13:45:47
   Duration  1.95s (transform 129ms, setup 0ms, import 432ms, tests 1.34s, environment 0ms)
```

### Finding 2 — total bounded error normalization

Disposition: fixed. The test cases use three different hostile rejection values:

1. Work rejects with a proxy whose prototype lookup throws during `instanceof`.
2. Handle disposal rejects with an `Error` proxy whose `message` getter throws.
3. Owner close rejects with a value whose `Symbol.toPrimitive` throws during string coercion.

`errorMessage()` now catches all inspection/coercion failures and returns the fixed bounded literal `Interaction error could not be safely normalized` without further coercing the rejected value. It reads a safe `Error.message` once and bounds it to 512 characters. Timeout classification separately catches hostile `instanceof` or `name` access. Work still closes exactly once; disposal cannot replace the deadline outcome; hostile close still returns a safety result.

Genuine RED:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t hostile work rejection|hostile handle dispose rejection|hostile owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (52 tests | 3 failed | 49 skipped) 1345ms
     × normalizes a hostile work rejection and still closes exactly once 144ms
     × preserves a deadline result when hostile handle dispose rejection normalization fails 94ms
     × normalizes a hostile owner close rejection into a safety result 91ms

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > normalizes a hostile work rejection and still closes exactly once
Error: hostile instanceof trap
 ❯ Object.getPrototypeOf tests/integration/isolated-interaction.test.ts:1145:15
 ❯ errorMessage src/interaction/isolated-auditor.ts:50:11
 ❯ auditInteraction src/interaction/isolated-auditor.ts:349:47

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > preserves a deadline result when hostile handle dispose rejection normalization fails
AssertionError: expected 'EXECUTION_FAILED' to be 'NOT_VERIFIABLE' // Object.is equality

Expected: "NOT_VERIFIABLE"
Received: "EXECUTION_FAILED"

 ❯ tests/integration/isolated-interaction.test.ts:1245:29

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > normalizes a hostile owner close rejection into a safety result
Error: hostile coercion trap
 ❯ Object.[Symbol.toPrimitive] tests/integration/isolated-interaction.test.ts:1264:15
 ❯ errorMessage src/interaction/isolated-auditor.ts:50:52
 ❯ auditInteraction src/interaction/isolated-auditor.ts:359:16

 Test Files  1 failed (1)
      Tests  3 failed | 49 skipped (52)
   Start at  13:46:48
   Duration  1.93s (transform 131ms, setup 0ms, import 410ms, tests 1.35s, environment 0ms)
```

Focused GREEN after implementation:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t hostile work rejection|hostile handle dispose rejection|hostile owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  3 passed | 49 skipped (52)
   Start at  13:47:15
   Duration  1.92s (transform 134ms, setup 0ms, import 409ms, tests 1.34s, environment 0ms)
```

The no-behavior refactor that cached `Error.message` was reverified with the same focus:

```text
Test Files  1 passed (1)
     Tests  3 passed | 50 skipped (53)
  Duration  1.93s (transform 139ms, setup 0ms, import 416ms, tests 1.34s, environment 0ms)
```

### Finding 3 — final freeze-first precedence

Disposition: fixed according to approved architecture design §8.1, which governs over the conflicting plan sample. The pure finalizer now checks the post-close immutable Safety Ledger snapshot for freeze evidence before checking owner-close failure. A close that records freeze evidence and then rejects returns the exact freeze reason and changed work evidence while retaining one close-failure invariant.

Genuine RED:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t freeze evidence outrank an owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/integration/isolated-interaction.test.ts (53 tests | 1 failed | 52 skipped) 1366ms
     × lets freeze evidence outrank an owner close rejection 139ms

 FAIL  tests/integration/isolated-interaction.test.ts > isolated fail-closed interaction audit > lets freeze evidence outrank an owner close rejection
AssertionError: expected 'Interaction owner close failed after …' to be 'Interaction activity was blocked by s…' // Object.is equality

Expected: "Interaction activity was blocked by safety freeze"
Received: "Interaction owner close failed after VERIFIED: Observable interaction state changed"

 ❯ tests/integration/isolated-interaction.test.ts:1493:27

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  13:47:53
   Duration  1.95s (transform 130ms, setup 0ms, import 405ms, tests 1.37s, environment 0ms)
```

Focused GREEN:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t freeze evidence outrank an owner close rejection


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  13:48:12
   Duration  1.91s (transform 119ms, setup 0ms, import 396ms, tests 1.34s, environment 0ms)
```

### Finding 4 — direct exactly-once assertions

Disposition: closed with test-only hardening. Representative ordinary deadline, click-failure, freeze, and unexpected-observation disposal paths now increment and assert direct `disposeCalls === 1`. Representative work+close and click+close rejection paths increment and assert `closeCalls === 1`. Each path also filters its final immutable Safety Ledger snapshot and asserts exactly one matching `INTERACTION_HANDLE_DISPOSE_FAILED` or `INTERACTION_OWNER_CLOSE_FAILED` code. The new undefined/hostile/freeze-close cases use full-array equality for the same exactly-one guarantee.

Focused verification:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t deadline handle dispose failed|work and owner-close failures|click failure and owner close|when handle disposal fails|when no outcome exists


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  6 passed | 47 skipped (53)
   Start at  13:49:30
   Duration  1.92s (transform 132ms, setup 0ms, import 416ms, tests 1.33s, environment 0ms)
```

### Fix-round aggregate verification

Combined Task 4 focus, including the original Task 4 cases, all new review cases, and representative exactly-once paths:

```text
> beaksight@0.1.0 test
> vitest run --run tests/integration/isolated-interaction.test.ts -t deadline handle dispose failed|work and owner-close failures|click failure and owner close|undefined owner close rejection|hostile work rejection|hostile handle dispose rejection|hostile owner close rejection|freeze evidence outrank an owner close rejection|when handle disposal fails|when no outcome exists


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  1 passed (1)
      Tests  11 passed | 42 skipped (53)
   Start at  13:50:12
   Duration  2.01s (transform 144ms, setup 0ms, import 475ms, tests 1.35s, environment 0ms)
```

Full isolated interaction plus interaction policy:

```text
> beaksight@0.1.0 test
> vitest run --run tests/unit/interaction-policy.test.ts tests/integration/isolated-interaction.test.ts


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  2 passed (2)
      Tests  75 passed (75)
   Start at  13:50:23
   Duration  13.49s (transform 179ms, setup 0ms, import 493ms, tests 12.89s, environment 0ms)
```

Adjacent five-suite safety matrix:

```text
> beaksight@0.1.0 test
> vitest run --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  5 passed (5)
      Tests  173 passed (173)
   Start at  13:50:44
   Duration  12.42s (transform 348ms, setup 0ms, import 1.38s, tests 18.76s, environment 0ms)
```

Required unscoped repository run with the entering fixed Vitest configuration:

```text
> beaksight@0.1.0 test
> vitest run --run


 RUN  v4.1.10 C:/Develop/github-repo/BeakSight


 Test Files  26 passed (26)
      Tests  410 passed (410)
   Start at  13:51:05
   Duration  15.65s (transform 2.90s, setup 0ms, import 11.31s, tests 48.71s, environment 4ms)
```

Typecheck:

```text
> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Build:

```text
> beaksight@0.1.0 build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
```

Both exited `0`.

### Fix-round changed and unchanged hashes

| File | Before fix round | After fix round |
| --- | --- | --- |
| `src/interaction/isolated-auditor.ts` | `5F76FAEC3F8CCC475BE60ABFA0E4709C1527559BA41881DCE508A6C14ABC23DD` | `DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814` |
| `tests/integration/isolated-interaction.test.ts` | `9915397E473BBDEBB3284C19E9E8B5ED041CB17931F47AC002CC1E3382EAFEC0` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` |

Unchanged authority/config/package files:

| File | Before and after SHA-256 |
| --- | --- |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `task-11-recovery-task-4-review.md` | `85A19F4A4A6A596F042DD0B02FB1DDC76EADD60439125EEE89EB722C6162368C` |

### Fix-round ownership and regression self-review

- The one production `elementHandle()` acquisition and one `targetHandle.dispose()` finalizer remain unchanged structurally. Null remains the only post-acquisition outcome outside the owner scope.
- The one production `session.close()` call remains after work-outcome computation and is reached even when hostile work normalization uses the fixed fallback.
- `closeFailed` is independent of the rejection value. Every caught close rejection records exactly one invariant before the one final snapshot.
- The finalizer order is now final freeze evidence, close failure, then work outcome. All branches reuse the existing immutable work evidence.
- Session-factory rejection remains outside the session-owned catch/finalization boundary.
- `AggregateError` remains absent. No cleanup ownership was duplicated.
- Full isolated and unscoped verification preserve Task 1–3 lifecycle, bounded-registry, and bounded-traversal contracts.

### Fix-round concerns

- Chromium initially requires the already-approved local launch permission in this sandbox; every browser verification used the installed executable, and no download occurred.
- npm emitted its routine newer-major notice during typecheck/build. No package operation occurred, and package hashes remained unchanged.
- No implementation concern remains within Fix round 1 scope. No Git operation or commit occurred, historical baselines/review were not modified, the progress ledger was not edited, and Task 5 was not started.

## Controller process-artifact discovery correction

The unscoped Vitest failure was traced to the controller's immutable SDD snapshots, not product tests: Vitest's default discovery included hidden `.superpowers/**/**.test.ts` files whose deliberately relocated relative imports cannot resolve. Moving or renaming historical snapshots would invalidate fixed prior review paths and hashes. The controller therefore constrained discovery to the repository's actual test tree with one configuration line:

```ts
include: ['tests/**/*.test.ts'],
```

`vitest.config.ts` changed from SHA-256 `12F557BEC4D096C73BABA4735D0C606728BA3825D4898AD2FC06F81DE565E279` to `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184`. No test outside `tests/` exists in the maintained repository; historical process snapshots remain immutable and reviewable. After this correction, the formerly failing unscoped command passed:

```text
npm test -- --run
Test Files  26 passed (26)
Tests       405 passed (405)
```

Controller reruns also passed: Task 4 focused 3/3, typecheck, and build. No dependency, package, Git, or live-target operation occurred.
