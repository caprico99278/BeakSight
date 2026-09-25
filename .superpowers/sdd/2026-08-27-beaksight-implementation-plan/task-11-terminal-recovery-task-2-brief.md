# Task 11 three-finding correction — Task 2 brief

## Authority

- Approved implementation plan: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md`
- Execute only `### Task 2: Bound total DOM work for discovery, exact Handle resolution, and retained inspection` (lines 332-644, ending immediately before Task 3).
- Approved design: `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`
- Plan SHA-256: `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D`
- Design SHA-256: `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E`
- Task 1 fix-round-1 independent review: PASS, Critical 0 / Important 0 / new Minor 0, SHA-256 `CD05B0D70F5FD1A141396912F505F61119B265EAFD92CFA94C3A02CE8B210D36`.

Read the complete Task 2 section and approved design before editing. The plan's interfaces, 15 steps, staged API RED, cleanup requirements, exact commands, and non-weakening requirements are binding.

## Scope

- Modify `src/safety/interaction-policy.ts`.
- Modify `src/interaction/discover-candidates.ts`.
- Modify `src/interaction/isolated-auditor.ts` only for Task 2 structured discovery/resolution integration.
- Modify `tests/integration/isolated-interaction.test.ts`.
- Create `fixtures/site/total-dom-budget.html` exactly as a deterministic local hostile fixture, correcting ID placement if required by the plan.
- Append evidence to the existing Task 11 report and progress ledger.
- Write `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` and a fixed Task 2 manifest.

Do not begin Task 3, Task 4, or Task 12. Do not modify package manifests or dependency state. Do not access a live target. Do not use Git. Do not spawn subagents or reviewers.

## Required behavior

- Define production `maxDomWork: 16_384` exactly once in `INTERACTION_CANDIDATE_LIMITS`.
- One shared finite budget per discovery, exact-handle resolution, or retained inspection operation.
- Charge enumeration, selector membership/candidate inspection, visibility ancestors, descendant text, label/control lookups, exact identity comparison, and live ordinal as specified; stop before any DOM read after exhaustion.
- Remove whole-document `querySelectorAll` and locator/nth escape hatches from these paths.
- Return explicit `COMPLETE`, `CANDIDATE_LIMIT_REACHED`, or `DOM_WORK_BUDGET_REACHED`; distinguish resolution/inspection budget exhaustion from missing/disconnected.
- Never return a partial candidate. Preserve exact candidate order, stable identity, reorder/clone semantics, hostile text behavior, existing NodeList regressions, and S03-S08 behavior.
- Every acquired JS/Element handle has deterministic disposal; a returned FOUND child handle must remain usable after envelope disposal.

Follow the plan's strict staged TDD sequence: fixture and tests first; export-presence RED before the temporary exact-signature throwing stub; behavior RED from the stub and old implementation; only then production implementation. Module-load/type-error failures do not count as behavioral RED.

## Frozen no-Git baseline

| Path | Bytes | SHA-256 |
|---|---:|---|
| `src/safety/interaction-policy.ts` | 6844 | `D63A211007C97368FA46EAD8D65CDFCC750AFDCA4B144175404495C6DCC8A9DF` |
| `src/interaction/discover-candidates.ts` | 19865 | `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1` |
| `src/interaction/isolated-auditor.ts` | 14929 | `DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814` |
| `tests/integration/isolated-interaction.test.ts` | 75330 | `FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20` |
| `fixtures/site/total-dom-budget.html` | missing | create in Task 2 |
| `package.json` | 899 | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | 57475 | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Report contract

Record baseline/final hashes, exact edited paths, staged API RED, behavioral RED names and intended causes, every GREEN/regression command with exit code/count, handle-cleanup reasoning, budget charge table for all three serialized callbacks, tests preserved/updated without weakening, self-review, and explicit no-Git/dependency/live-target/Task 3+ confirmation. Return under 15 lines. Independent review is controller-owned.
