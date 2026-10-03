# Task 11 correction — Task 3 implementation report

Date: 2026-09-20. Scope: approved correction Task 3 only, preserving interaction work and Context lifecycle as separate structured result axes. Correction Task 4 and product Task 12+ were not started. Independent review is controller-owned.

## Frozen baseline and TDD evidence

The fixed brief matched SHA-256 `A9DD67817322532A1B2F749198222CD66DE8BE38E0D520CC09E5E99593247589`. All 16 frozen baseline paths matched before test edits. The complete approved design, Task 3 plan section, Task 1 terminal-retry final report/review, and Task 2 fix-round-2 report/review were read before editing.

Tests were added while production remained byte-identical. A test-local expected-result type adapter allowed `npm run typecheck` to pass before the new production fields existed. Immediately before accepted RED, the production hashes were rechecked unchanged:

| Path | Genuine-RED baseline SHA-256 |
| --- | --- |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` |
| `src/interaction/isolated-auditor.ts` | `9EDBFF6B7ADFE79053F2507A012262092C6AA874D849C9FCDC2C77C044BBCCCD` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |

The first restricted browser launch failed before tests with Playwright Chromium `spawn EPERM`; it is excluded as environment evidence. The identical approved process-launch run of the plan focus was the accepted behavioral RED:

`npm test -- --run tests/integration/isolated-interaction.test.ts -t "structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes"`

Result: exit 1, **6 failed / 107 skipped**. All six failures were current-production contract violations: absent work/lifecycle axes, old work-status/reason interpolation, failure to block fulfilled-but-non-terminal close, and terminal invalidation using the old final reason.

Additional pre-production focus:

`npm test -- --run tests/integration/isolated-interaction.test.ts -t "undefined close rejection|freeze event recorded during owner close|freeze evidence outrank"`

Result: exit 1, **5 failed / 108 skipped**. Both terminal and non-terminal `undefined` rejection cases retained only the old ad-hoc final reason, while all three freeze-priority combinations lacked the structured axes. Production hashes were rechecked unchanged after these RED runs. Each test kills a concrete production mutation: dropping rejection presence, inferring terminal state from rejection/fulfillment, string-encoding work, applying lifecycle precedence above freeze, omitting axes, or breaking evidence aliasing/immutability. No source-mutating mutation run is claimed.

## Minimal implementation

- `InteractionGuardedSession.isClosed()` is a read-only query delegated directly to `isPassiveRequestGuardClosed(context)`. The existing session-local `closed` flag still enforces single owner-close use and is assigned only from canonical Guard terminal truth.
- `InteractionWorkOutcome` is exported and remains constructed only through frozen `outcome()`. `InteractionLifecycleOutcome` has frozen `CLOSED` and `NON_TERMINAL` constructors with bounded reasons.
- Owner-close rejection presence is tracked separately from its arbitrary rejection value. `undefined` therefore remains a present failure. Terminal truth is read only after close settles: rejection plus terminal Guard yields `CLOSED` with a reason; rejection plus non-terminal Guard yields `NON_TERMINAL`; fulfillment plus non-terminal Guard records `INTERACTION_OWNER_CLOSE_NON_TERMINAL` before the final snapshot.
- The pure finalizer implements the required order: freeze evidence, non-terminal lifecycle, terminal close rejection, otherwise work. Final safety reasons never interpolate work status, work reason, or evidence.
- The returned frozen result includes immutable `work`, `lifecycle`, and detached ledger `safety`; `result.evidence` is exactly `result.work.evidence` by identity. Existing evidence and Safety Ledger constructors retain deep array/event freezing.
- Every compile-time session fake was updated. Successful fake close owns an explicit closure boolean and changes it only after fake close fulfillment; rejected fakes remain non-terminal unless a test explicitly models terminal rejection. Real-session wrappers preserve the production terminal query.
- Context-factory tests now directly prove `session.isClosed()` is false after failed raw close and true only after later canonical terminal recovery.

The first full isolated-interaction GREEN attempt exposed only two legacy assertions still expecting the deliberately removed ad-hoc reason (**111 passed / 2 failed**). They were migrated to assert the fixed final reason plus structured work/lifecycle. The expanded focus then passed 15/15 and the final full file passed 113/113. One earlier wrapper invocation yielded without a final summary and is not used as evidence; the captured authoritative rerun is reported below.

## Fresh verification

| Command | Fresh result |
| --- | --- |
| Task 3 expanded focus: `npm test -- --run tests/integration/isolated-interaction.test.ts -t "hostile owner close|changed evidence when click failure|structured work|non-terminal lifecycle|terminal invalidation|fulfilled without terminal|immutable result axes|lifecycle priority|undefined close rejection|freeze event recorded during owner close|freeze evidence outrank"` | exit 0; 15 passed / 98 skipped |
| `npm test -- --run tests/integration/isolated-interaction.test.ts --reporter=default` | exit 0; 113/113 passed |
| `npm test -- --run tests/component/context-factory.test.ts` | exit 0; 19/19 passed |
| `npm test -- --run tests/integration/passive-request-guard.test.ts` | exit 0; 114/114 passed |
| lifecycle race focus across Guard/factory/auditor | exit 0; 11 passed / 235 skipped |
| Task 2 DOM/correction focus | exit 0; 53 passed / 60 skipped |
| `npm test -- --run` | exit 0; 26/26 files, 510/510 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |

Static scans:

- `rg -n "Interaction owner close failed after|after \$\{work\.status\}" src` returned exit 1 with no matches, the expected clean result.
- `rg -n "querySelectorAll|\.locator\(|\.nth\(" src/interaction/discover-candidates.ts src/interaction/isolated-auditor.ts` returned exit 1 with no matches, preserving Task 2's bounded paths.
- Session-fake enumeration plus strict typecheck found no missing `isClosed` contract. The shared fake helper owns one explicit closure boolean; exceptional/terminal cases own explicit local booleans.
- `package.json` and `package-lock.json` remain at their frozen hashes; no dependency or package mutation occurred.

## Self-review and constraints

All finalizer branches were traced with arbitrary rejection values, terminal/non-terminal truth, freeze combinations, successful work compatibility, failed work preservation, identity aliasing, and immutable nested surfaces. Exactly one owner close remains in each audit. Final ledger capture occurs after both close-failure and fulfilled-non-terminal invariant recording. Task 1 retryability/terminal-only ownership and Task 2 total DOM budgets remain covered by their fresh full/focused regressions.

Historical Task 2 I7 remains an adjudicated irreversible original-RED deviation and is unchanged; this report does not relabel it. Existing historical/deferred Minors were not silently resolved.

**NOT RUN — independent Task 3 specification/quality review.** Reason: controller-owned by the SDD workflow. Impact: this implementation is not independently accepted. Completion blocker: yes for Task 3 advancement and correction Task 4.

**NOT RUN — correction Task 4/final dual review and product Task 12+.** Reason: expressly outside this implementation scope and blocked on clean Task 3 review. Impact: Task 11 remains unapproved. Completion blocker: yes for overall Task 11, not for this implementation handoff.

No Git operation, dependency/library download/install/update/new import, package mutation, live-target access, subagent/reviewer spawn, destructive action, site-specific production logic, or Task 4/12+ work occurred. Only `apply_patch` was used for file edits.
