# Task 11 correction — Task 2 fix round 1 implementation report

Date: 2026-09-20. Scope: independent Task 2 review I1–I6 plus test-strength Minors M1–M3 only. Task 3/4 and product Task 12+ were not started. Independent re-review is controller-owned.

## Frozen baseline

The fixed brief SHA-256 was verified first as `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E`. All 16 frozen paths in that brief then independently matched their expected SHA-256 values before test or production edits. Immediately after the accepted RED run, the four production baselines were rechecked unchanged:

| Production path | Genuine-RED baseline SHA-256 |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE` |
| `src/interaction/isolated-auditor.ts` | `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B` |
| `src/evidence/interaction-collector.ts` | `5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761` |

Package baselines also remained `package.json` `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` and `package-lock.json` `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.

## Genuine RED

Tests were added before production changes. `npm run typecheck` exited 0 on the test-only state, excluding module-load and compile failures. The first sandboxed browser attempt exited 1 with `spawn EPERM` before tests and was excluded. The first outside-sandbox run identified one synthetic visibility Proxy `Illegal invocation`; that harness error was corrected before accepting evidence. No production file changed during those attempts.

Accepted RED command:

`npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction"`

Result: exit 1; 25 failed, 4 passed, 68 skipped. Every failure was an observable current-production contract violation:

| Review contract / production mutation killed | Accepted RED evidence |
| --- | --- |
| I1, omit distinct retained fact debit | final exact-identity boundary performed one target fact read after all 16,384 units were consumed |
| I1, read geometry after final visibility debit | controlled geometry counter was 1 instead of 0 |
| I2, treat ordinal hint as identity | connected exact target after preceding insertion returned `DISCONNECTED` instead of `CONNECTED` ordinal 1 |
| I3, omit total acquired-handle ownership | status-read, metadata-dispose, extra-property, and envelope-failure cases left element/metadata/extra handles undisposed |
| I4, trust casts rather than runtime envelope checks | invalid counts, missing FOUND child, contradictory child/raw presence, invalid snapshot containers/statuses/counts resolved instead of rejecting |
| I5, start only at `TreeWalker.nextNode()` | matching `<html>` was omitted and the child remained ordinal 0 |
| I6, reuse absence placeholder for incomplete work | rediscovery, resolution, pre-admission inspection, and retained observation all published `MISSING` rather than unestablished identity |

The corrected behavioral RED is contemporaneous evidence for I1–I6. It does not and cannot recreate the original pre-implementation discovery/inspection RED missing from the prior Task 2 report. Per the controller adjudication, review I7 remains an honestly recorded irreversible historical evidence deviation; no later failure was relabeled as earlier evidence.

M1–M3 are test-strength corrections rather than missing production behavior: exact completeness expectations, exact scoped fixture counts, and the actual browser click event were added before production edits. They were retained through every GREEN run.

## Minimal implementation

- `discover-candidates.ts` now includes `document.documentElement` in the same charged incremental traversal for discovery, ordinal resolution, and retained inspection. Descendant order follows the root.
- Retained inspection charges accepted-node/membership, exact target comparison, and candidate facts separately. The old ordinal is validated only as a bounded hint; the exact connected node publishes its current live ordinal.
- Discovery and retained fact helpers stop before creating another walker or reading geometry/follow-on facts after a final ancestor/text/lookup debit. Partial candidates and snapshots are not published.
- Resolver extraction immediately owns every `getProperties()` handle, including unknown properties. All cleanup attempts run after read, validation, metadata-dispose, or envelope-dispose failure. A prospective FOUND child transfers only after metadata and envelope cleanup succeed; otherwise it is reclaimed. Primary and cleanup failures remain together through `AggregateError` when both exist.
- Resolver and retained snapshot boundaries validate container/discriminant, safe integer work count in `[0, 16_384]`, required/forbidden child/raw presence, and non-null FOUND `ElementHandle` before publication.
- `InteractionChangeEvidence.identityStatus` gained the smallest explicit typed extension, `UNESTABLISHED`. All four auditor budget-incomplete branches publish it; only complete absence publishes `MISSING`.
- Ordinary fixtures now assert exact `COMPLETE`, overflow asserts exact `CANDIDATE_LIMIT_REACHED`, and intentionally hostile traversal asserts exact `DOM_WORK_BUDGET_REACHED`. The hostile fixture precondition proves exactly 20,000 wrappers scoped below its host. The combined case proves exactly 8,000 preceding nodes and 9,000 controlled wrappers, excluding body/html. The unsafe insertion case observes an actual browser click event on the acquired production path.

## Verification

| Command | Result |
| --- | --- |
| `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction"` | exit 0; 29 passed, 68 skipped |
| `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction\|total DOM work\|whole-DOM\|budget exhaustion\|bounded exact-handle\|shared ancestor\|shared text"` | exit 0; 40 passed, 57 skipped; includes real-browser root/reorder/lifetime and synthetic exact-boundary cases |
| `npm test -- --run tests/integration/isolated-interaction.test.ts` | exit 0; 97/97 passed |
| `npm test -- --run tests/integration/passive-request-guard.test.ts` | exit 0; 114/114 passed |
| `npm test -- --run tests/integration/passive-request-guard.test.ts -t "retry of a failed invalidating\|overlapping retry\|drain-only retry\|invalidation priority"` | exit 0; 6 passed, 108 skipped; lifecycle retry/race focus |
| `npm test -- --run` | exit 0; 26/26 files, 494/494 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `rg -n "querySelectorAll\|\\.locator\\(\|\\.nth\\(" src/interaction/discover-candidates.ts src/interaction/isolated-auditor.ts` | exit 1 with no matches, expected clean result |
| `rg -n "maxDomWork\|used: 0" ...` scoped production scan | one policy constant and exactly three browser-local `used: 0` operation budgets; no shared/reset escape |

The first DOM-focus GREEN output was lost by the execution UI after the process completed, so the identical focus command was rerun and the reported 40/40 result is the captured fresh run. This is an execution-output gap only; it is not counted as a failed or omitted gate.

## Self-review and not-run ledger

- Cleanup behavior was reviewed against status-read failure, sequential disposal failure, unknown property ownership, prospective child reclamation, and real Chromium child lifetime after successful envelope disposal.
- The budget audit confirms root acceptance, candidate membership/facts, exact identity comparison, visibility ancestors, descendant text, label/control lookups, and live ordinal all share the operation-local budget. No whole-DOM selector/locator escape remains.
- No assertion was deleted or weakened. Existing exact node replacement, hostile text, NodeList, S03–S08, request zero-delivery, and Handle finalizer coverage all passed.
- NOT RUN — independent Task 2 fix-round-1 re-review. Reason: controller-owned by the SDD workflow. Impact: I1–I6 and M1–M3 are not independently accepted yet. Completion blocker: yes for Task 2 advancement.
- NOT RUN — correction Task 3/4 and product Task 12+. Reason: explicitly outside this fix round and blocked on clean Task 2 re-review. Impact: structured work/lifecycle correction and final Task 11 approval remain pending. Completion blocker: yes for overall Task 11, not for this implementation handoff.
- No Git operation, dependency/library download/install/update, package mutation, live-target access, subagent/reviewer spawn, or site-specific production logic occurred. The Playwright type-only `JSHandle` import uses the already-installed dependency and adds no runtime package/import surface.

Final file hashes are fixed in the companion manifest after this report and both append-only ledgers are written.
