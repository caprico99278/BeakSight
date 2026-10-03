# Task 11 Recovery Task 3 Independent Review

## Fixed package

- Review package SHA-256: `5063B9BC620925133ABAFCF65E2A97F26FB8AE31C0FA33ADAB2B2AFA2402CDFC`
- All 13 package, authority, BASE, HEAD, and package-file hashes matched before and after review.

## Verdict

`FAIL` — Critical: 0; Important: 1; Minor: 0.

## Important finding

### Reset-per-root regression is not killed

- Files: `tests/integration/isolated-interaction.test.ts:223-255`, `fixtures/site/hostile-candidates.html:8`; supporting paths `src/interaction/discover-candidates.ts:235-257,283-285,399-421,456-458`.
- Requirement: resetting `visitedNodes` per root must make both focused discovery and retained-inspection tests fail.
- Evidence: both focused tests use one hostile button with a direct `aria-label`. Labelled-root traversal is bypassed, and normalized text receives a one-element roots array. Moving `visitedNodes` initialization inside the per-root loop is behaviorally identical, so the existing probe does not kill this mutation.
- Required correction: retain the global 512-call hostile tests and add both-path multi-root coverage, or an equivalent mutation harness, that aggregates traversal across at least two roots and demonstrably fails when the counter is reset per root.

## Verified compliant areas

- The two serialized helper bodies are byte-identical and use `SHOW_ALL`.
- Current production shares one counter across roots, counts before filtering, uses `Text.substringData`, and caps output including separators at 1,024 characters.
- Candidate NodeLists remain bounded indexed scans.
- The fixture contains exactly 100,000 empty spans before trailing text.
- The one-line `FROZEN_ACTIVE` expectation maintenance is correct.
- Fresh focused 3/3, full isolated 45/45, interaction-policy 22/22, and typecheck passed.

No Git, dependency, live-target, or file-modifying review operation occurred.
