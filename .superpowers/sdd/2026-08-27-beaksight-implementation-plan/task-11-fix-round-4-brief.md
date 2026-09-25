# Task 11 fix round 4/5 brief — Git-free SDD

Fix round 3 independent re-review matched 34/34 hashes and returned NEEDS FIXES: 0 Critical, 1 Important, 0 Minor. The aria-controls finding is ADDRESSED; click-failure precedence remains PARTIAL at one boundary.

## Binding correction

Immediately after the first post-click Safety Ledger snapshot:

1. any freeze event remains BLOCKED_BY_SAFETY;
2. if the click failed and the absolute deadline is already reached, return the click-failure outcome before any post-evaluation or generic deadline outcome: TimeoutError -> NOT_VERIFIABLE, ordinary Error -> EXECUTION_FAILED, preserving the click error reason and current evidence;
3. if time remains, observe the retained node, then apply freeze > click failure > identity/deadline > VERIFIED as already designed.

A click ordinary Error must never be overwritten by deadline merely because the click call itself consumed the remaining budget. Do not perform a post browser evaluation after that deadline.

## Required RED/GREEN

- Deterministic RED/GREEN: `ElementHandle.click()` advances time exactly to the effective deadline and throws ordinary Error; expect EXECUTION_FAILED, original reason, zero post evaluations.
- Deterministic TimeoutError counterpart: NOT_VERIFIABLE, original reason, zero post evaluations.
- Preserve existing state-change-then-error evidence case when time remains.
- Focused Task 11, Task 5/6/11 adjacent, typecheck, build, full suite.

No Git, dependency operation, live target, hidden wait, DOM marker mutation, or site-specific production selector.
