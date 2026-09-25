# Task 11 final quality fix round 1 implementation report

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Scope: final-quality Important I1 only. Task 11 remains unapproved and Task 12+ remains blocked.

## Frozen baseline and constraints

The fixed brief matched SHA-256 `56055B94A9682947A8933F2411EEFF43A1C118769050A2DD9526D0B7D8ED0E56`. All 19 frozen paths matched before test or production edits: **19 checked / 19 matched / 0 missing / 0 mismatched**. The complete correction design and plan, Task 4 report, prior 85-entry package, passed final specification review, and failed final quality review were read before implementation.

No Git operation, dependency/library download/install/update/new import, package mutation, live-target access, subagent/reviewer dispatch, or Task 12+ work occurred. Historical Task 2 I7 remains an irreversible original behavioral-RED deviation and is not relabeled by this fix.

## Root cause

`inspectInteractionCandidateHandle()` proved exact retained-node identity first, but then combined `!found` and `liveOrdinal > maxOrdinal` into the same `DISCONNECTED` result. At live ordinal 100 the node was connected, selector-matching, and found under the DOM-work budget; only publication of an `InteractionCandidate` was forbidden because its ordinal contract ends at 99. The auditor consequently treated this bounded-publication condition as physical identity loss and entered disconnected rediscovery.

The smallest truthful repair is a fourth retained-snapshot discriminant, `CANDIDATE_LIMIT_REACHED`, with no candidate payload. Physical absence remains `DISCONNECTED`; actual total-work exhaustion remains `DOM_WORK_BUDGET_REACHED`; ordinals 0–99 remain `CONNECTED` with complete immutable candidates.

## Strict TDD evidence

### Test-only RED preparation

Before production edits, focused tests were added for:

- a retained exact node moved to live ordinal 99 remaining `CONNECTED` with ordinal 99;
- the same retained exact node moved to live ordinal 100 producing `CANDIDATE_LIMIT_REACHED`, never `DISCONNECTED`, with no candidate payload and a frozen wrapper;
- valid immutable conversion of the new runtime snapshot envelope;
- rejection of a new-status envelope carrying `raw` and rejection of an out-of-range work count;
- auditor direct mapping in both pre-admission and retained-observation paths to `NOT_VERIFIABLE` plus `UNESTABLISHED`, with no disconnected rediscovery and no `MISSING`/`REPLACED` evidence;
- unchanged real detach and real ancestor-budget outcomes.

The initial restricted command failed before tests with Chromium `spawn EPERM` and is excluded from product RED evidence:

```text
npm test -- --run tests/integration/isolated-interaction.test.ts -t "maximum live ordinal 99|live ordinal 100|candidate-limit|distinguish true absence|shared ancestor budget exhaustion"
exit 1; suite setup failure; 120 skipped; Chromium spawn EPERM
```

The identical approved local-process rerun was the accepted behavioral RED:

```text
exit 1; 1 file; 4 failed / 5 passed / 111 skipped / 120 total
```

Exact intended failures:

1. live ordinal 100 returned `{ status: 'DISCONNECTED', domWorkUsed: 205 }` instead of candidate-limit incompleteness;
2. a valid `CANDIDATE_LIMIT_REACHED` runtime snapshot was rejected as an invalid envelope;
3. the auditor pre-admission path returned `EXECUTION_FAILED` instead of `NOT_VERIFIABLE`;
4. the auditor retained-observation path returned `EXECUTION_FAILED` instead of `NOT_VERIFIABLE`.

The same run passed live ordinal 99, true detachment, true DOM-work exhaustion, and malformed new-status payload/count rejection. Thus the RED was behavioral rather than compile, harness, renderer, or missing-export failure. Test-only `npm run typecheck` exited 0. Immediately afterward these production hashes still matched the frozen baseline:

| Production path | Frozen SHA-256 after accepted RED |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `3552F8CA91F75B5B835BFE7EE4B2DE202CBF35041F688740D56DC5327F2DE3A6` |
| `src/interaction/isolated-auditor.ts` | `A33F0F5F2F38335C558BEA81B5F5EF806E5D2E577F2493680ADCC4B1E121399A` |

### Minimal GREEN implementation

- Extended `InteractionHandleSnapshot` with `{ status: 'CANDIDATE_LIMIT_REACHED'; domWorkUsed }`.
- Split complete-traversal absence (`!found`) from a found exact node whose `liveOrdinal > maxOrdinal`.
- Added the new discriminant to exact Node-side runtime validation; only `CONNECTED` may carry raw candidate facts.
- Mapped candidate-limit results directly in both auditor inspection sites to `NOT_VERIFIABLE` with `UNESTABLISHED` evidence. The retained path returns before disconnected rediscovery.

No candidate with ordinal 100 is constructed, no DOM-work exhaustion is fabricated, and existing Handle ownership/disposal is unchanged.

## Fresh verification

Every required gate was run fresh after the production repair.

| Gate | Exact command | Result |
| --- | --- | --- |
| Ordinal-cap focus | `npm test -- --run tests/integration/isolated-interaction.test.ts -t "maximum live ordinal 99\|live ordinal 100\|candidate-limit\|distinguish true absence\|shared ancestor budget exhaustion"` | exit 0; 1 file; 9 passed / 111 skipped / 120 total; 9.00 s |
| Full isolated interaction | `npm test -- --run tests/integration/isolated-interaction.test.ts` | exit 0; 1 file; 120/120 passed; 72.39 s |
| Exact Task 4 user-required focus | `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts -t "retry\|drain-only\|synchronous re-entry\|lifecycle priority\|total DOM work\|whole-DOM\|budget exhaustion\|bounded exact-handle\|structured work\|non-terminal lifecycle\|terminal invalidation\|fulfilled without terminal\|immutable result axes"` | exit 0; 3 files; 40 passed / 213 skipped / 253 total; 54.06 s |
| Lifecycle race focus | `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "retry\|drain-only\|synchronous re-entry\|lifecycle priority\|close begins\|invalidation"` | exit 0; 2 files; 35 passed / 98 skipped / 133 total; 1.54 s |
| DOM budget plus ordinal boundary | `npm test -- --run tests/integration/isolated-interaction.test.ts -t "total DOM work\|whole-DOM\|budget exhaustion\|bounded exact-handle\|shared ancestor\|shared text\|candidate discovery\|candidate-limit\|maximum live ordinal 99\|live ordinal 100"` | exit 0; 1 file; 30 passed / 90 skipped / 120 total; 62.56 s |
| Six-file Task 11 regression | `npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts` | exit 0; 6 files; 302/302 passed; 75.52 s |
| Repository regression | `npm test` | exit 0; 26 files; 517/517 passed; 77.17 s |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 |

Both required forbidden-boundary scans returned exit 1 with no matches:

```text
rg -n '本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*[''\"]|innerHTML\s*=|setAttribute\(' src
rg -n 'querySelectorAll\(.*INTERACTION_CANDIDATE_SELECTOR|querySelectorAll\(selector\)|locator\(INTERACTION_CANDIDATE_SELECTOR\)' src/interaction
```

Package files remain unchanged:

```text
package.json       75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233
package-lock.json  A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A
```

Final changed implementation/test hashes before ledger/package creation:

```text
src/interaction/discover-candidates.ts          3A484C01FBDD8AE722476001040672AE0D70FFAA0D5501D7ED2447BA827614C9
src/interaction/isolated-auditor.ts             887127C795CB98ADA79B8C1E29CDB143F11C9F3D346462E4174BE4219A812220
tests/integration/isolated-interaction.test.ts  80ADE243FE12F80FD98FFB63816957FE4E5A4486935F7F447943879777187EE9
```

## Review-package repair contract

The prior fixed package SHA-256 is `24E33E21407B47258036FBCA2489D3E35DA64C2B9E4EC05DF00F57A5BCC4E91E`. It contains 85 entries / 85 unique paths. The replacement package retains all 85 paths, freshly hashes their current contents after the append-only ledgers, and adds exactly four historical/fix artifacts:

1. the passed prior final specification review;
2. the failed prior final quality review;
3. this fix-round brief;
4. this fix-round report.

Expected replacement comparison: **89 entries / 89 unique paths / 5 substitutions / 4 additions / 0 removals / 0 missing / 0 duplicate paths / 0 mismatches**. The five substituted prior paths are the two production files, the integration test, the Task 5 append-only report, and the progress ledger. The replacement package is self-nonreferential; its own hash is supplied only at controller handoff.

## Self-review and not-run ledger

Mutation check:

- merging `liveOrdinal > maxOrdinal` back into `DISCONNECTED` fails both real ordinal-100 cases;
- omitting runtime recognition fails the valid new-envelope test;
- permitting raw candidate data on the incomplete status or accepting an invalid count fails the malformed-envelope cases;
- routing the status through disconnected rediscovery fails the auditor reason/evidence/no-second-discovery test;
- moving the boundary to ordinal 99 fails the maximum valid ordinal test;
- relabeling real detach or work exhaustion fails the retained distinct-outcome tests.

No unrelated production, test, fixture, package, config, design, plan, or prior review artifact was modified. Historical Task 2 I7 remains explicit and unrepaired.

NOT RUN
- command: fresh independent Task 11 correction specification re-review
- reason: controller-owned after this fixed implementation/package handoff; implementer self-review cannot replace it
- impact: specification acceptance of the final quality repair remains independently unproved
- completion blocker: yes

NOT RUN
- command: fresh independent Task 11 correction code-quality re-review
- reason: controller-owned after this fixed implementation/package handoff; implementer self-review cannot replace it
- impact: the ordinal-cap truthfulness, envelope validation, auditor mapping, and mutation strength remain independently unaccepted
- completion blocker: yes

NOT RUN
- command: Task 11 approval and product Task 12+ implementation
- reason: fresh dual re-review and explicit user approval remain required
- impact: Task 11 remains unapproved and Task 12+ remains blocked
- completion blocker: yes
