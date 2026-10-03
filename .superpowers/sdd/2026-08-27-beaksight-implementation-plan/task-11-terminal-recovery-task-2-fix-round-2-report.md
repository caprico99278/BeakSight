# Task 11 correction — Task 2 fix round 2 implementation report

Date: 2026-09-20. Scope: the three Important findings from the Task 2 fix-round-1 independent review only. Correction Task 3/4 and product Task 12+ were not started. Independent re-review is controller-owned.

## Frozen baseline

The fixed brief matched SHA-256 `DF0C80E6A150EA335D241BFBDDC5A622F794144CB47D6BF0BFEDF0B507E0A4E1`. All 17 frozen paths in that brief matched before test edits. A test-only `npm run typecheck` then exited 0. Immediately after the accepted behavioral RED, the production/package baselines were rechecked unchanged:

| Path | Genuine-RED baseline SHA-256 |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `75A7B67AA91AF205CA9AFB379F943F30F72150C05FCFDF6C73DBD626C0D0A9CB` |
| `src/interaction/isolated-auditor.ts` | `180CB34B2B8A2171E438CCAFC1A8E8272D60AB3E9837D31ABC1D17C5F6854399` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Genuine RED

Tests were added for all three findings before production edits. The first restricted run failed before any test with Playwright Chromium `spawn EPERM`; it is an excluded environment attempt. The identical approved process-launch run was the accepted RED:

`npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 fix round 2"`

Result: exit 1; **10 failed / 3 passed / 97 skipped**. The failures were current-production contract violations, not compilation, missing exports, temporary production stubs, renderer crashes, or harness errors:

| Finding / mutation killed | Accepted RED evidence |
| --- | --- |
| Invocation-wide secondary text cap | discovery published a candidate after 602 accepted text-traversal nodes split between accessible name and normalized text; two candidates each received an independent allowance; retained inspection returned CONNECTED after the same reset |
| Undefined primary rejection presence | successful cleanup replaced `Promise.reject(undefined)` with an invalid-envelope Error; cleanup failure returned only the cleanup Error instead of retaining both `undefined` primary presence and cleanup failure |
| Neutral evidence semantics | initial-load deadline, navigation error, failed safety transition, pre-observation freeze, and changed retained node all published `MISSING` rather than `UNESTABLISHED` |

The three passing focused cases were required regressions: incomplete post-disconnection rediscovery was already `UNESTABLISHED`, while complete rediscovery and complete resolution absence remained `MISSING`.

The prior Task 2 I7 remains an adjudicated irreversible historical evidence deviation. This contemporaneous RED proves only the fix-round-2 contracts against the frozen current baseline; it is not relabeled as the missing original Task 2 pre-implementation RED.

## Minimal implementation

- Discovery owns one browser-local secondary `textWork` counter for the whole serialized invocation. Accessible-name roots, normalized-text collection, and every candidate share it. Each accepted SHOW_ALL node still debits the same total `domWork` budget. Reaching `maxTextNodes` stops before another node acceptance and makes the in-progress candidate incomplete; no partial candidate is appended.
- Retained inspection owns the equivalent one-invocation `textWork` counter shared across accessible-name and normalized-text work. Secondary-cap exhaustion returns the structured budget result and no partial snapshot.
- Resolver failure handling now tracks primary-error presence separately from its value. A sole `undefined` rejection remains `undefined`; when cleanup also fails, `AggregateError.errors` retains `[undefined, ...cleanupErrors]`. Existing all-property cleanup and prospective-child reclamation are unchanged.
- `emptyEvidence()` is neutral by default (`UNESTABLISHED`). The only direct `MISSING` construction sites are complete rediscovery absence, bounded resolver `MISSING`, and a complete retained-handle `DISCONNECTED` result before admission. Complete post-disconnection rediscovery continues to use `MISSING`/`REPLACED`/`AMBIGUOUS`; matched evidence remains `MATCHED`.
- Six legacy secondary-cap assertions were migrated from publishing capped/truncated candidates to the binding fix-round-2 rule: exact cap exhaustion is structured and the partial candidate/snapshot is not published. The first full run exposed only those six stale expectations (**104 passed / 6 failed**); no production regression was present. After the assertion migration, the full file passed.

## Verification

| Command | Fresh result |
| --- | --- |
| `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 fix round 2"` | exit 0; 13 passed, 97 skipped |
| `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction\|Task 2 fix round 2\|total DOM work\|whole-DOM\|budget exhaustion\|bounded exact-handle\|shared ancestor\|shared text"` | exit 0; 53 passed, 57 skipped |
| `npm test -- --run tests/integration/isolated-interaction.test.ts` | exit 0; 110/110 passed |
| `npm test -- --run tests/integration/passive-request-guard.test.ts` | exit 0; 114/114 passed |
| `npm test -- --run tests/integration/passive-request-guard.test.ts -t "retry of a failed invalidating\|overlapping retry\|drain-only retry\|invalidation priority"` | exit 0; 6 passed, 108 skipped |
| `npm test -- --run` | exit 0; 26/26 files, 507/507 tests passed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `rg -n "querySelectorAll\|\.locator\(\|\.nth\(" src/interaction/discover-candidates.ts src/interaction/isolated-auditor.ts` | exit 1 with no matches; expected clean result |
| scoped `maxDomWork` / `used: 0` / `textWork` / `maxTextNodes` scan | one policy `maxDomWork`, three browser-operation total-budget owners, and exactly two invocation-wide secondary text counters; no `visitedNodes` helper-local reset remains |

The first combined-focus process completed after the wrapper yielded without its final summary, so it was not used as evidence. The identical command was rerun and the captured 53/53 result above is the authoritative fresh run.

## Self-review and not-run ledger

- Resolver cleanup still attempts every acquired property/envelope disposal and reclaims a prospective FOUND child unless transfer is fully validated and cleanup succeeds. The new presence bit changes only primary-error identity.
- Discovery/inspection have no `querySelectorAll`, locator/nth enumeration, page-global budget, cross-invocation state, per-helper text counter, or partial candidate/snapshot publication. Root ordering, exact retained identity, envelope validation, S03–S08, request zero-delivery, and Handle finalization all passed the maintained regressions.
- Neutral evidence was checked across deadline, work error, transition failure, pre-observation state, changed retained node, incomplete rediscovery, all budget branches, and complete absence. Existing full-file tests preserve `AMBIGUOUS`, `REPLACED`, and `MATCHED` outcomes.
- **NOT RUN — independent Task 2 fix-round-2 re-review.** Reason: controller-owned by the SDD workflow. Impact: the three Important findings are not independently accepted yet. Completion blocker: yes for Task 2 advancement and correction Task 3 start.
- **NOT RUN — correction Task 3/4 and product Task 12+.** Reason: expressly outside this fix round and blocked on a clean independent Task 2 re-review. Impact: structured work/lifecycle outcomes and final Task 11 approval remain pending. Completion blocker: yes for overall Task 11, not for this implementation handoff.
- No Git operation, dependency/library download/install/update, new library import, package mutation, live-target access, subagent/reviewer spawn, or site-specific production logic occurred.

Final fixed-package hashes are recorded in the companion manifest after this report and both append-only ledgers are updated.
