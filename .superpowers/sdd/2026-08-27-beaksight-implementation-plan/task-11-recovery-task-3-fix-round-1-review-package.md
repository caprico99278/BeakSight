# Task 11 Recovery Task 3 Fix Round 1 Re-review Package

## Re-review contract

Re-review the sole Important finding from the prior Task 3 review and detect new breakage within this correction. Git operations are prohibited. Work read-only; do not modify files, download/import/update dependencies, access a live target, or delegate.

Return `PASS` only if the entering Important is fully addressed and the exact correction introduces zero Critical and zero Important findings. Enumerate any Minor findings.

## Fixed authorities and entering review

| Artifact | SHA-256 |
| --- | --- |
| Original fixed review package | `5063B9BC620925133ABAFCF65E2A97F26FB8AE31C0FA33ADAB2B2AFA2402CDFC` |
| Entering independent review | `B7520D01B2C73C814EE2E34616DFB47710EF85801001D1DFD6E7BDAFE5243F95` |
| Updated implementer report | `2E83FFCEF9433269199EB312DE3160AC8A64B3C6ADBA953220272E66C6DB8AA5` |
| Approved design | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` |
| Approved implementation plan | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` |

## Entering finding

The initial focused hostile tests supplied only one text root. They therefore did not kill moving/resetting `visitedNodes` inside the per-root loop. Required correction: retain the original 512-call tests and add both-path multi-root aggregate-budget coverage, or an equivalent mutation proof, that fails for reset-per-root.

## Fixed correction scope

Permanent changes relative to the prior fixed HEAD:

| File | Prior state | Current SHA-256 |
| --- | --- | --- |
| `tests/integration/isolated-interaction.test.ts` | `CE9AD48DC99FF63D170A7FD2DD84F830755E77DD8563CEF23E4CFFE76EFD5C7E` | `9B2605E13CEEB4B7026ED19B4AE88592213D3D4C7F3FE19AD31E58CAA40FB87E` |
| `fixtures/site/multi-root-candidates.html` | absent | `9870AECCC9B4830C2C89E778FC7B929A7888F64BCF17238CCB07C430D9FB9919` |

Required unchanged files:

| File | SHA-256 |
| --- | --- |
| `src/interaction/discover-candidates.ts` | `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1` |
| `fixtures/site/hostile-candidates.html` | `755A6F10B14968EF7FF637110625F327D689F98E1A8EC54BEC25873B49B1B79F` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Required checks

1. The original two global 512-call tests remain present and equivalent.
2. The new fixture produces at least two distinct roots actually passed to `boundedDescendantText` on both initial discovery and retained-handle inspection.
3. Each root contributes descendants, and the aggregate exceeds 512 while each root remains individually below 512.
4. Correct production stops at exactly 512 non-null descendant returns across roots.
5. A reset inside the per-root loop would exceed the probe and fail both new tests. Review the implementer report's temporary mutation RED evidence and independently validate the reasoning from code/fixture.
6. The test probe itself counts non-null returns and is installed before the relevant call in each path; it does not depend on a production global or DOM marker.
7. The fixture's fallback naming makes the test deterministic without causing an extra traversal that confounds the count.
8. No permanent production behavior or unrelated test contract changed.

The implementer temporarily applied the exact reset-per-root mutation to both serialized callbacks using `apply_patch`; both new tests failed, then the source was restored to its required SHA. The final correction must contain no trace of that mutation.

## Verification evidence against fixed correction

Implementer:

- temporary mutation: both new tests failed (2 failed, 45 skipped)
- restored aggregate focus: 2 passed, 45 skipped
- original Task 3 hostile focus: 2 passed, 45 skipped
- full isolated interaction: 47 passed
- interaction-policy unit: 22 passed
- typecheck: passed

Controller:

- combined original plus aggregate focus: 4 passed, 43 skipped
- full isolated interaction: 47 passed
- interaction-policy unit: 22 passed
- typecheck: passed

No Git command, dependency operation, package mutation, or live-target access occurred.
