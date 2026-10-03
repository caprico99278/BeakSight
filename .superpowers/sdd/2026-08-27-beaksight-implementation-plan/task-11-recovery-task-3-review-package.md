# Task 11 Recovery Task 3 Fixed Review Package

## Review contract

Review Recovery Task 3 only, as a combined specification and code-quality review. Git operations are prohibited. Treat the immutable controller baseline copies below as `BASE` and the current workspace files below as `HEAD`. Do not modify files, download dependencies, contact a live target, or delegate work.

Required verdict: `PASS` only when there are zero Critical and zero Important findings. Report every finding with severity, file, line, requirement, evidence, and required correction. Minor findings may be deferred but must be enumerated.

## Authority documents

| Document | SHA-256 |
| --- | --- |
| `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md` | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` |
| `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-3-brief.md` | `2BA3BC9C9EA4D8AC8788EE6C12DA94AC58FDA8E6811EECA8DC64ADDF981541E5` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-3-report.md` | `B55995BCC0B3A0A5A877F98375B65DA2EC38F701B40FEC3D4637628B2AA8C0A4` |

## Immutable BASE

| Workspace file | Baseline copy | SHA-256 |
| --- | --- | --- |
| `src/interaction/discover-candidates.ts` | `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-3-baseline/discover-candidates.ts` | `1546FF3482EA43A374E4EF4E60147B9735D95D262C715DA49B0DA0F4366BB9E2` |
| `fixtures/site/hostile-candidates.html` | `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-3-baseline/hostile-candidates.html` | `57E90F400E219C1F8D5D51E5A7B536AD06ABEC9CA38095DE38A9889116B1BBF1` |
| `tests/integration/isolated-interaction.test.ts` | `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-3-baseline/isolated-interaction.test.ts` | `FD07D0DC94E7388CF8BC0EFBB196AC11E83AFF0E2F148CB258FFD798E6E0146D` |

The implementer report's reconstructed `Before` hashes are inaccurate and must not be used as BASE. The controller created the immutable copies before dispatch; the three hashes above are authoritative.

## Fixed HEAD

| File | SHA-256 |
| --- | --- |
| `src/interaction/discover-candidates.ts` | `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1` |
| `fixtures/site/hostile-candidates.html` | `755A6F10B14968EF7FF637110625F327D689F98E1A8EC54BEC25873B49B1B79F` |
| `tests/integration/isolated-interaction.test.ts` | `CE9AD48DC99FF63D170A7FD2DD84F830755E77DD8563CEF23E4CFFE76EFD5C7E` |

Package files stayed unchanged:

| File | SHA-256 |
| --- | --- |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Specification to verify

1. Both serialized browser callbacks use the same bounded traversal algorithm and remain semantically identical.
2. Each callback uses `document.createTreeWalker(root, NodeFilter.SHOW_ALL)`.
3. A single `visitedNodes` count is shared across all candidate roots in one callback invocation. Every non-null `nextNode()` result is counted before filtering by node type, and traversal stops after at most 512 visited descendants total.
4. Text output is bounded to 1,024 characters. Text extraction uses `Text.substringData`; it does not use whole-subtree `textContent` or equivalent unbounded materialization. Root separators must not exceed the cap.
5. Candidate NodeLists remain indexed and bounded; do not introduce iterator/materialization APIs over untrusted collections.
6. No production global, DOM marker, or unbounded string is introduced for testing.
7. The hostile fixture contains exactly 100,000 empty `span` descendants before the relevant text, so `SHOW_TEXT` would fail to enforce a total descendant-node limit.
8. Tests exercise both initial discovery and retained-candidate inspection, prove `SHOW_ALL`, and fail if either path calls `nextNode()` more than 512 times.
9. The only cross-task maintenance change is the one-line assertion update from retired `INTERACTION_FROZEN` vocabulary to the Task 1 approved phase `FROZEN_ACTIVE`; this must not mask a production regression.

Inspect both callback bodies directly and compare BASE to HEAD without Git. Confirm the mutation argument: replacing `SHOW_ALL` with `SHOW_TEXT`, moving the counter after the text-node filter, or resetting the counter per root must cause the focused tests to fail.

## Verification evidence

Implementer evidence after the one-line maintenance correction:

- focused traversal: 2 passed, 43 skipped
- double-freeze assertion: 1 passed, 44 skipped
- full isolated interaction: 45 passed
- interaction-policy unit: 22 passed
- `npm run typecheck`: passed

Controller evidence against the fixed HEAD:

- combined traversal plus double-freeze focus: 3 passed, 42 skipped
- full isolated interaction: 45 passed
- interaction-policy unit: 22 passed
- `npm run typecheck`: passed

No Git command, dependency download/import/update, package mutation, or live-target access was used.
