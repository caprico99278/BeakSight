# Task 11 fix round 1/5 brief — Git-free SDD

Independent specification review matched 27/27 hashes and returned NEEDS FIXES: 1 Critical, 2 Important, 1 Minor.

## Binding corrections

1. Bind admission and action to the same browser node. After isolated-page rediscovery, acquire an `ElementHandle` for the candidate and collect/validate the facts from that exact handle. If ordinal resolution now points to a different node, return NOT_VERIFIABLE without clicking. Keep that exact handle through click and post-condition collection; never re-resolve the generic ordinal for action.
2. Strengthen cross-context identity with bounded stable semantic facts such as accessible name and text fingerprint. Do not put fields expected to change through a valid interaction (for example aria-expanded/selected, controlled visibility, or layout) into the stable ID. The exact ElementHandle, not the stable ID alone, is the within-context node-identity authority.
3. Recheck the absolute deadline after every async/synchronous target-resolution boundary and immediately before invoking `ElementHandle.click()`. Locator/handle acquisition or fact collection that reaches the deadline must produce NOT_VERIFIABLE with zero click calls and no post evaluation.
4. Post-condition collection must inspect the same retained handle. If it is disconnected and an equivalent candidate now exists, report explicit `REPLACED`; if no equivalent exists, `MISSING`; retain `AMBIGUOUS` when stable identity resolves to multiple live nodes. None may produce VERIFIED. Add non-vacuous MISSING/AMBIGUOUS/REPLACED tests.
5. Split download proofs clearly. The data-URL case proves the browser download event is cancelled/recorded. A separate admitted interaction must attempt `/__download`, and the server request observation plus download counter must prove zero delivery. Do not claim a `/__download` assertion for a fixture that never requests it.

## Required RED/GREEN and regression

- Genuine RED for DOM insertion/reorder between rediscovery and target acquisition that would otherwise click a rejected `mailto:`/download/navigation node.
- Genuine RED for target resolution reaching the absolute deadline with `clickCalls === 0` required.
- Genuine RED for same-facts clone replacement after click, requiring `REPLACED` and non-VERIFIED.
- Direct MISSING and AMBIGUOUS evidence cases.
- Non-vacuous admitted HTTP download `/__download` zero-delivery proof plus separate data-download cancellation proof.
- Focused Task 11, Task 5/6/11 adjacent, typecheck, build, and full repository regression.

No Git, dependency operation, live target, hidden wait, DOM marker mutation, or site-specific production selector.
