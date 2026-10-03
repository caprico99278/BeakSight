# Task 11 correction — Task 2 fix round 2 brief

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Scope and gate

This is Task 2 fix round 2 only. Read the full approved design, Task 2 plan, round-1 fix brief/report/manifest, and round-1 independent review. Address only its three Important findings while preserving all earlier corrections. Do not start correction Task 3/4 or product Task 12+.

## Frozen baseline

Verify all hashes before work; stop on mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `75A7B67AA91AF205CA9AFB379F943F30F72150C05FCFDF6C73DBD626C0D0A9CB` |
| `src/interaction/isolated-auditor.ts` | `180CB34B2B8A2171E438CCAFC1A8E8272D60AB3E9837D31ABC1D17C5F6854399` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `tests/integration/isolated-interaction.test.ts` | `DA06A093CDA5CAFA272C04D4862C2F437694A326AECC9FD857A73B345B3A5B61` |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-brief.md` | `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-report.md` | `48C2FCED0D70541138D8066292023BE5155B924E01AD00CF66779C8D77311E46` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-manifest.md` | `EE5F4BC95F6598CED13CDF5C3D1F3A98BE0053A31C41FE109D0919111DC5F306` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-review.md` | `C7CF94321CEAEFF01A9670BC9C129DC7C024EFAFCD2EE7E2137CF39803AD21EA` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `F887635F092BE533414A025D8F3C4CE9E8FF7A5FF2B4B19147393015494AB5B9` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `0A8480846617A72EDC2810B9024086F30CD101F65312975878B5E99DACDCC6A2` |

## Required behavior

1. Invocation-wide secondary text cap:
   - one `maxTextNodes` counter per serialized discovery invocation and one per retained-inspection invocation;
   - share it across accessible-name roots, normalized-text collection, and all candidates in that invocation;
   - every accepted SHOW_ALL node must also debit the existing shared total `maxDomWork` budget;
   - when the secondary cap is reached, stop before accepting another text node and do not publish a partial candidate/snapshot;
   - preserve the existing 512 cap across multiple labelled roots and add coverage across helper calls and across candidates.
2. Primary failure presence:
   - distinguish “no primary failure” from a primary rejection whose value is `undefined`;
   - preserve `Promise.reject(undefined)` as the primary rejection when cleanup succeeds;
   - if cleanup also fails, retain both primary presence/value and cleanup failures without substituting an invalid-envelope error;
   - preserve all existing total cleanup and child-ownership guarantees.
3. Evidence semantics:
   - `UNESTABLISHED` is the neutral state whenever complete absence was not established, including deadline, navigation/work errors, unresolved transition, pre-observation initialization, changed retained node before a complete rediscovery, and post-disconnection incomplete rediscovery;
   - `MISSING` may appear only where a complete discovery/resolution establishes absence;
   - preserve `AMBIGUOUS`, `REPLACED`, `MATCHED`, and complete-absence behavior;
   - prefer making `emptyEvidence` neutral by default or require an explicit status at every call, then explicitly use `MISSING` only at proven-absence sites.

## Mandatory TDD sequence

Before production edits, add focused tests and capture a genuine behavioral RED against the frozen production hashes. At minimum:

- one candidate whose accessible-name traversal plus normalized-text traversal exceeds 512 accepted SHOW_ALL nodes while remaining below `maxDomWork`;
- multiple candidates whose aggregate accepted SHOW_ALL nodes exceed 512 while each alone does not;
- retained inspection equivalent spanning accessible name and normalized text;
- resolver `Promise.reject(undefined)` with successful cleanup, asserting the rejection remains `undefined` and every handle is disposed;
- resolver `Promise.reject(undefined)` plus cleanup failure, asserting primary presence/value and cleanup failure are both represented and all cleanup attempts occur;
- exhaustive auditor cases for initial-load deadline, navigation/work error, unresolved transition, before first observation, changed retained node, post-disconnection incomplete rediscovery, and each already-covered budget branch, all asserting `UNESTABLISHED` unless complete absence was proven;
- explicit complete-absence tests retaining `MISSING` and ambiguity/replacement/match tests retaining their statuses.

Reject harness errors, renderer crashes, missing exports, compilation failures, and temporary production stubs as RED evidence. Recheck production hashes after the accepted RED before editing implementation.

## Constraints

- Smallest coherent production changes: primarily `src/interaction/discover-candidates.ts` and `src/interaction/isolated-auditor.ts`; change the evidence type only if necessary.
- Preserve all prior I1-I6/M1-M3 fixes and tests.
- Use `apply_patch` for edits.
- No Git operations.
- No dependency/library download, install, new import from an unapproved library, package or lockfile change.
- No live target; no Task 3/4/12+; no subagents/reviewers.
- Do not rewrite approved/history artifacts. Append established progress/Task 5 ledgers only.
- Keep I7 recorded as the adjudicated irreversible historical evidence deviation; do not relabel later RED as original evidence.

## Mandatory verification and deliverables

Fresh-run: new correction focus; combined Task 2 DOM focus; full isolated-interaction; full Guard; lifecycle race focus; repository suite; typecheck; build; forbidden whole-DOM/budget-reset scan. Record exact counts/exit codes and all not-run items.

Create:

- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-report.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-manifest.md`

The manifest must include genuine-RED production baselines and every final changed/authority/package path hash. Stop after the fixed package; independent re-review is controller-owned.
