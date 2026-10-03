# Task 11 final quality fix round 1 — retained ordinal-cap truthfulness

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Scope

Address only final quality review Important I1: a connected exact retained node moved beyond `maxOrdinal` must not be classified `DISCONNECTED`. Preserve all accepted Task 1–3 behavior. Do not start product Task 12+.

Read the approved correction design/plan, Task 4 report/package, final spec review, and final quality FAIL review completely before editing.

## Frozen baseline

Verify all hashes first; stop on mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `3552F8CA91F75B5B835BFE7EE4B2DE202CBF35041F688740D56DC5327F2DE3A6` |
| `src/interaction/isolated-auditor.ts` | `A33F0F5F2F38335C558BEA81B5F5EF806E5D2E577F2493680ADCC4B1E121399A` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |
| `src/browser/context-factory.ts` | `26C34D95FF4B104BC5950329B9AECA4B291B75C41F0D51CEA1AC983F51F488A4` |
| `tests/integration/isolated-interaction.test.ts` | `A3AB1C3FBBD544CF57393D3E67A94E2B0CFDE8A352F78C5450B949A336413D3C` |
| `tests/integration/passive-request-guard.test.ts` | `55FC9C0498312FA8A3A21A79AD26408F7A942970B5F834E87B4B05FF42757396` |
| `tests/component/context-factory.test.ts` | `88E51355C9AF77ABC346AC2CE13BA77DBFA44E809BAA11ABC2BA9F67C74C388D` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-4-report.md` | `5465A983CC1B4790C2C63D7D4AD193C472EC29FBAA0DF6E72A044534D215112B` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md` | `24E33E21407B47258036FBCA2489D3E35DA64C2B9E4EC05DF00F57A5BCC4E91E` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-spec-review.md` | `B32ECD83D3B614FC6AA9DAC7BE269CEB15A462F5B4B02B8E2918C98B925477E5` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-quality-review.md` | `F84965281C0FDBCCC7EA0216880C86B0AC59B41AA6DDD2F1B36DB1E9B14E1AF4` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `297A3BA4A5816956BC50AB8639B7BFCBB78DDD6401D532E05637F65227F5EC1F` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `4F3BAD8869E7FDB3E7F8B87E48923B771E0457CB0CE9D6E1058B0020C3454F8B` |

## Binding repair

- `DISCONNECTED` is permitted only when the retained node is physically not connected or a complete selector traversal proves the exact node absent.
- If the exact retained node is found, connected, and selector-matching but its live ordinal exceeds `maxOrdinal`, return an explicit non-disconnected incomplete status. Prefer extending `InteractionHandleSnapshot` with `CANDIDATE_LIMIT_REACHED` to mirror discovery semantics.
- Do not publish an `InteractionCandidate` with an invalid ordinal and do not relabel the condition as `DOM_WORK_BUDGET_REACHED` unless the total work budget actually exhausted.
- The auditor must map this explicit limit status directly to conservative `NOT_VERIFIABLE` work with `UNESTABLISHED` identity and must not enter disconnected semantic rediscovery or publish `MISSING`/`REPLACED`.
- Preserve actual detach/complete absence as `DISCONNECTED`, total budget exhaustion as `DOM_WORK_BUDGET_REACHED`, and ordinal 0–99 retained nodes as `CONNECTED` with their live ordinal.
- Apply exact runtime-envelope validation and immutable conversion for the new discriminant; no raw candidate may accompany the incomplete status.

## Mandatory TDD

Before production edits, add focused tests and capture genuine behavioral RED against the frozen production hashes:

1. Retained node moves to live ordinal 99: returns `CONNECTED`, ordinal 99.
2. Same exact connected node moves to live ordinal 100: returns explicit candidate-limit incomplete status, never `DISCONNECTED`, with no candidate payload.
3. Auditor receiving/encountering the ordinal-100 retained result returns `NOT_VERIFIABLE` + `UNESTABLISHED` without disconnected rediscovery and without `MISSING`/`REPLACED` evidence.
4. Malformed new-status envelope with candidate payload or invalid count is rejected.
5. True detached/complete-absence behavior remains `DISCONNECTED`; total-work exhaustion remains distinct.

RED must be behavioral, not compile/harness/renderer/missing-export failure. Typecheck test-only state and recheck production hashes immediately after accepted RED.

## Implementation constraints

- Primary files: `src/interaction/discover-candidates.ts`, `src/interaction/isolated-auditor.ts`, `tests/integration/isolated-interaction.test.ts`.
- Update every exhaustive consumer/type guard of `InteractionHandleSnapshot`; preserve immutable/frozen result contracts and Handle ownership/disposal.
- Use `apply_patch` for edits.
- No Git operations.
- No dependency/library download/install/update/new unapproved import/package mutation.
- No live target, no Task 12+, no subagents/reviewers.
- Preserve historical Task 2 I7 exactly as an irreversible original evidence deviation.

## Fresh verification and final-package repair

After GREEN, rerun:

- new ordinal-cap focus;
- full isolated-interaction;
- lifecycle race focus;
- DOM budget focus;
- exact Task 4 user-required focus;
- six-file Task 11 regression;
- repository full suite;
- typecheck and build separately;
- both forbidden-boundary scans and package/lock hashes.

Create:

- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-final-quality-fix-round-1-report.md`
- replace/update `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md` as the new fixed final package, preserving prior package ancestry and adding this brief/report while retaining the failed quality review and passed spec review as history;
- append Task 5/progress ledgers.

The new package must fresh-hash every entry, report entries/unique/missing/mismatch/duplicate and substitutions/additions/removals against the 85-entry package, and remain self-nonreferential. Do not edit or overwrite the prior spec/quality review artifacts. Stop after implementation, gates, report, and repaired package. Controller owns fresh dual re-review.
