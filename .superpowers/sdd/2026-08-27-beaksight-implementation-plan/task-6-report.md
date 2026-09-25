# Task 6 implementation report

## Status

DONE

Implemented the guarded passive BrowserContext/Page lifecycle, bounded DOM/height settling, and deadline-aware progressive controlled scroll with a real Chromium lazy-growth fixture. Git operations were not used and `.git-sandbox-backup` was not touched.

## RED evidence

Command:

```text
npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
```

Initial result before production implementation:

```text
Test Files  2 failed (2)
Tests       no tests
```

Both suites failed to load because `src/browser/context-factory.ts` (and the other planned browser modules) did not exist. This was the expected missing-behavior RED.

The first real-Chromium run inside the restricted sandbox failed to launch Chromium with `spawn EPERM`; rerunning with the required execution permission exposed one test expectation error (8 passed, 1 failed): Playwright correctly returns `null` for a successful `data:` navigation because there is no network response. The assertion was corrected to require that documented return and verify the resulting page title; production behavior was not weakened.

## Implementation

- `BrowserContextFactory` snapshots locale, timezone, canonical passive origins, and per-call viewport values. It creates exactly one `SafetyLedger` per Context.
- Every Context is created with `serviceWorkers: 'block'`; Task 5's passive guard is installed before the Context is exposed or any Page exists.
- `createPassivePage()` does not expose a Page until `awaitPassiveRequestGuardReady()` resolves.
- owner teardown delegates to `closePassiveGuardedPage()` and `closePassiveGuardedContext()`. Foreign or inactive Context/Page instances are rejected. Task 5 exclusively owns installation failure invalidation; readiness cleanup delegates to its guarded Context close only while the guard remains active.
- the Context-to-ledger mapping remains retrievable after owner close so later orchestration can inspect truthful lifecycle evidence.
- canonical passive-origin conversion is exported from the existing Task 5 `request-policy.ts` owner and reused by the factory; no second passive-origin interpretation was added.
- `waitForPageSettled()` explicitly awaits `domcontentloaded`, observes ready state and document height over a stable window, and returns immutable `SETTLED` or honest `PARTIAL` metadata.
- `controlledScroll()` resets to the document top, uses at most 0.9 viewport height per step, waits deterministically, re-observes geometry after every step, tracks lazy height growth, and completes only after current-bottom plus a stable-height window. Its absolute deadline races browser evaluation and returns immutable `PARTIAL` metadata rather than hanging.
- `lazy-content.html` appends three separate height-extending batches only when the browser approaches the current bottom.

## GREEN and verification evidence

```text
npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
PASS — 2 files, 10 tests, 0 failures, exit 0

npx vitest run tests/unit/request-policy.test.ts
PASS — 1 file, 19 tests, 0 failures, exit 0

npm run typecheck
PASS — TypeScript strict no-emit compile, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 16 files, 214 tests, 0 failures, exit 0
```

The real-Chromium integration proves three lazy height increases, final stable bottom completion, deadline `PARTIAL` completion in under one second, and zero Safety Ledger invariant violations during guarded owner teardown.

## Changed files

- `src/browser/context-factory.ts` — guarded Context/Page construction, ownership, ledger lookup, and teardown facade.
- `src/browser/page-settling.ts` — bounded DOM-ready/height-stability observer.
- `src/browser/controlled-scroll.ts` — progressive scroll and immutable COMPLETE/PARTIAL results.
- `src/safety/request-policy.ts` — exposes the existing canonical passive-origin function for Task 6 reuse; classification continues to use the same owner.
- `tests/component/context-factory.test.ts` — context options, required dependency, isolation, readiness, ownership, installation failure, snapshots, and close truthfulness.
- `tests/integration/controlled-scroll.test.ts` — guarded real-Chromium settling, lazy growth, final bottom, and deadline behavior.
- `fixtures/site/lazy-content.html` — deterministic multi-batch lazy-content fixture.

## Ownership and isolation scans

- `networkidle` occurrences in Task 6 production: 0.
- target-specific identity/domain occurrences in Task 6 production and the touched request policy: 0.
- raw `newContext()` / `newPage()` calls are confined to `BrowserContextFactory`.
- raw Page/Context close calls are confined to Task 5's guarded adapter; Task 6 construction, readiness cleanup, and normal owner teardown all defer to Task 5 ownership.
- Safety policy classification remains in `src/safety/request-policy.ts`; Task 6 does not add method/navigation decisions.

## File hashes

```text
5747226E04681F1857B1B8BE163206DDC452C815BBF0654ADBCEDB8F59736E8E  src/browser/context-factory.ts
6C6AA0CDB0A38340D8DD0CB39C4DE237DFC7A0940852AB145691637894883F07  src/browser/page-settling.ts
4C3540664896AE952C99AD1FF98280C697844E7A81F05637F97F48368AE399F7  src/browser/controlled-scroll.ts
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
23797AE5CF3EAD89834EAA4175DFDD6020C8B91EDDB85C6D367DA3BDE21B89B3  tests/component/context-factory.test.ts
FF041987114FFA9487CBBC9E7ADFCB96FBD02537D63ED0B12485E281CE49F1C6  tests/integration/controlled-scroll.test.ts
91B80876EDF24A46C494215E0CC59D23F1632750852AF7F7DAFDF1304B5E1768  fixtures/site/lazy-content.html
```

## Concerns / not run

- No Task 6 verification remains unrun.
- Chromium execution required permission outside the restricted process sandbox; the permitted fresh runs passed.
- Later Tasks 14/15 must pass one absolute page deadline through settling and scrolling, and must use only the factory lifecycle methods. The factory intentionally preserves ledgers after close for final status/safety accounting.

## Fix Round 1/5

### Entering findings and root causes

- Critical — deadline races: `beforeDeadline()` accepted an operation that won `Promise.race()` without checking whether completion was still strictly before the absolute deadline. Observation timestamps could therefore equal/exceed the deadline, and an already-dispatched scroll callback could mutate after the function had returned `PARTIAL`.
- Important — lifecycle cleanup: the factory raw-closed after Task 5 installation/readiness failures, duplicating Task 5 invalidation and bypassing its guarded owner contract.
- Important — lifecycle synchronization: factory-local active ownership was not checked against Task 5's installed/invalidated SSOT immediately before `newPage()`, and Page-close failure did not retire factory ownership.
- Important — shrink completeness: bottom stability reset on growth but not shrink, allowing a changed document to inherit an old stable window.
- Important — ledger isolation: the dependency could return one mutable ledger identity to multiple Contexts, including Contexts issued by different factory instances.

### Fix-round RED evidence

After adding source-targeted regression tests:

```text
npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
FAIL — 2 files, 9 failed / 9 passed, exit 1
```

The failures separately reproduced post-deadline observations, late reset mutation, false completion after height shrink, double installation close, invalidated-context `newPage()`, guarded Page-close ownership leakage, readiness double close, and ledger identity reuse.

A broader identity-boundary test was then added after the first fixes:

```text
npx vitest run tests/component/context-factory.test.ts
FAIL — 1 file, 1 failed / 10 passed, exit 1
```

It proved that a per-factory ledger registry still allowed the same ledger to be reused by a second factory instance.

### Fixes

- Both deadline racers now post-check `Date.now()` after an operation wins and reject completion at or after the absolute deadline. Already-started operations receive a rejection handler even when the deadline was expired on entry.
- Settling and scrolling refuse to append observations timestamped at or after the deadline, so `SETTLED`/`COMPLETE` always ends with a strictly pre-deadline observation.
- Both `scrollTo` reset and `scrollBy` callbacks receive the absolute deadline, check browser-side time immediately before mutation, and return a deadline sentinel. Node-side post-checking remains authoritative.
- A delayed-evaluate regression proves the caller receives `PARTIAL` first and releasing the late callback does not change scroll state.
- Scroll stability now resets on any height change; `heightGrowthCount` still increments only for growth.
- Task 5 now exposes `assertPassiveRequestGuardActive(context)`, a narrow read-only assertion over its existing guard-state authority. No state semantics were duplicated in Task 6.
- Factory installation failure no longer issues a second raw close. Readiness failure delegates to Task 5 guarded Context close only when Task 5 still reports the guard active; an already invalidated Context is not closed again.
- Factory calls the Task 5 assertion before raw `newPage()`. Guarded Page-close failure removes Page ownership and retires Context activity.
- issued `SafetyLedger` identities are held in a module-level `WeakSet`; reuse is rejected before another `BrowserContext` is constructed, including across factory instances.

### Fix-round GREEN and regression evidence

```text
npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
PASS — 2 files, 18 tests, 0 failures, exit 0

npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/unit/safety-ledger.test.ts tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts
PASS — 6 files, 109 tests, 0 failures, exit 0

npm run typecheck
PASS — strict no-emit compile, exit 0

npm run build
PASS — production build and schema copy, exit 0

npm test
PASS — 16 files, 222 tests, 0 failures, exit 0
```

### Fix-round changed-file hashes

```text
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
CE5A59071A1F509F69E85E11D2869EF337502AAC4B2D6200118C47DFA0AA8276  src/browser/page-settling.ts
3A217FB3C179933351B31970F134A4F7C9587E55C8C1BDB2A3E3A82243AA7808  src/browser/controlled-scroll.ts
B8AB932D3665FC036D2B20C7F902AFBB0ABA17417F66CB9B4808F3A5E203AD09  src/safety/passive-request-guard.ts
8BE9A65549A1EC73CB2EEA7A40F4F6E9A0C33E18A9E987DF3CBA826FC28B94D0  tests/component/context-factory.test.ts
103E25447615BD96DE37CEE3C30444BA2713213209ADE8F50B2DB6F36BB2151A  tests/integration/controlled-scroll.test.ts
```

### Deferred minors

The two reviewer minors remain deferred as directed: disappearing-document characterization and explicit finite/nonnegative validation of browser-derived geometry. No required verification remains unrun.

## Fix Round 2/5

### Entering Critical remainder and root cause

- A rejected operation escaped directly from `Promise.race()`, bypassing the fulfilled-result post-clock check. Rejection at/after the authoritative deadline was therefore mislabeled as `DOM_READINESS_FAILED` or `EVALUATION_FAILED`.
- A strictly pre-deadline observation could satisfy stability, then terminal result construction/freezing could cross the deadline without a final adjudication, allowing `SETTLED`/`COMPLETE` after authority expired.

### RED evidence

```text
npx vitest run tests/integration/controlled-scroll.test.ts -t "classifies late|downgrades terminal"
FAIL — 1 file, 6 failed / 7 skipped, exit 1
```

The five late-rejection tests cover DOM readiness, settling evaluation, scroll reset, scroll measurement, and scroll step. Each also proves that the equivalent rejection strictly before the deadline retains its genuine DOM/EVALUATION failure reason. The sixth test crosses the deadline while freezing terminal settling and scroll results.

### Fixes

- `beforeDeadline()` now normalizes both fulfillment and rejection into a resolved typed outcome before racing the timer. It checks the absolute clock before inspecting that outcome: expiry always becomes `DEADLINE`, while only a rejection completed strictly before expiry is rethrown.
- Already-expired entry and timer-win paths retain a rejection handler through outcome normalization, avoiding late unhandled rejections.
- `settledBeforeDeadline()` and `completeBeforeDeadline()` check the clock immediately before terminal construction and again after the immutable terminal object is fully built/frozen. Either crossing returns `PARTIAL / DEADLINE_EXCEEDED` with the already-captured strictly pre-deadline observations.
- The shrink regression was made deterministic with an explicit fake clock after a combined regression run showed real scheduling could exceed its intentionally small stability window before the shrink fixture was injected. Production scroll behavior was unchanged by that test-only correction.

### GREEN and verification evidence

```text
npx vitest run tests/integration/controlled-scroll.test.ts -t "classifies late|downgrades terminal"
PASS — 1 file, 6 passed / 7 skipped, exit 0

npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/unit/safety-ledger.test.ts tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts
PASS — 6 files, 115 tests, 0 failures, exit 0

npm run typecheck
PASS — strict no-emit compile, exit 0

npm run build
PASS — production build and schema copy, exit 0

npm test
PASS — 16 files, 228 tests, 0 failures, exit 0
```

One earlier combined regression invocation reported 114/115 because the real-time shrink fixture completed its legal stable window before injecting the shrink. After converting only that fixture clock to deterministic advancement, the focused shrink test passed and the fresh combined 115/115 and full 228/228 runs passed.

### Fix-round changed-file hashes

```text
DDC341818E10E627931CA5AE7C55BD9D63022B160D586EDB0E6CE6078EABFD31  src/browser/page-settling.ts
12C271A5E75954BD43636D4193BC3842C8BF825E872CBA74D797C1CEC9667BB6  src/browser/controlled-scroll.ts
F905E1E46BD0F7B32A94E17F880CDE6E8F9E36BB3905281F3404F4265D202D1F  tests/integration/controlled-scroll.test.ts
```

Task 5 APIs and all four Important fixes from Round 1 remain unchanged. The two reviewer minors remain deferred as directed. No required verification remains unrun.

## Cross-task verification stability maintenance

The real-Chromium 40 ms deadline test had a semantically over-specific assertion: it required a non-null final geometry snapshot even though an authoritative deadline may legitimately expire before the first geometry read completes. Production correctly returns `PARTIAL / DEADLINE_EXCEEDED` with `finalSnapshot: null` and no observations in that case.

No production file was changed. The test now retains the deadline reason and sub-second non-hanging assertions, and distinguishes the two truthful outcomes:

- no snapshot implies no completed observations;
- any present snapshot must be strictly pre-deadline and not at bottom.

Characterization and verification:

```text
before edit: exact real-Chromium test, 4 concurrent runs
PASS — 4/4; confirms the known failure is load-sensitive rather than deterministic in isolation

after edit: exact real-Chromium test, 4 concurrent runs
PASS — 4/4, each 1 passed / 12 skipped

npx vitest run tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
PASS — 2 files, 24 tests, 0 failures, exit 0

npm run typecheck
PASS — strict no-emit compile, exit 0

npm test
PASS — standard parallel run, 22 files, 265 tests, 0 failures, exit 0
```

Hashes:

```text
8E4778202AC122AC5F701BF624A4D21F4B2F0154268BD475DA129DB4C5A6C1B1  tests/integration/controlled-scroll.test.ts
12C271A5E75954BD43636D4193BC3842C8BF825E872CBA74D797C1CEC9667BB6  src/browser/controlled-scroll.ts (unchanged)
DDC341818E10E627931CA5AE7C55BD9D63022B160D586EDB0E6CE6078EABFD31  src/browser/page-settling.ts (unchanged)
```

No Git operation or dependency operation was used. This is test-stability maintenance only and is not an overall project-completion claim.
