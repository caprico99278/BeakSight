# Task 11 fix round 3/5 brief — Git-free SDD

Fix round 2 independent re-review matched 33/33 hashes and returned NEEDS FIXES: 0 Critical, 2 Important, 0 Minor. Every entering round 2 finding is ADDRESSED.

## Binding corrections

1. Result precedence after post-observation is: any freeze event -> BLOCKED_BY_SAFETY; then any click failure -> timeout as NOT_VERIFIABLE or other failure as EXECUTION_FAILED; only a successful click may yield VERIFIED from changed evidence. Preserve observed evidence on the failure result. A click that mutates state and then throws `TimeoutError` must never produce VERIFIED.
2. A non-empty `aria-controls` whose target is currently absent/unresolvable is valid bounded evidence with `controlledVisible:null` and `controlledHidden:null`; it must not abort discovery or other candidates. When controlled state is observed, both values must be boolean and exact inverses. Reject inconsistent one-null or same-boolean pairs as malformed.

## Required RED/GREEN

- Direct deterministic RED/GREEN: click mutates ARIA state then throws `TimeoutError`; result is NOT_VERIFIABLE with observed changedFields retained, never VERIFIED.
- Direct deterministic RED/GREEN: click mutates state then throws ordinary Error; result EXECUTION_FAILED, never VERIFIED.
- Real-browser RED/GREEN: valid missing-target `aria-controls` candidate plus safe sibling are both discovered; no page-wide throw. The unresolved candidate retains null/null controlled state.
- Unit contract cases for valid null/null unresolved and invalid mixed/equal boolean pairs.
- Focused Task 11, Task 5/6/11 adjacent, typecheck, build, and full repository regression.

No Git, dependency operation, live target, hidden wait, DOM marker mutation, or site-specific production selector.
