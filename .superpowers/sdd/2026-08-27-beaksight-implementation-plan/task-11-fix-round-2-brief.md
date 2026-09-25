# Task 11 fix round 2/5 brief — Git-free SDD

Fix round 1 independent re-review matched 30/30 hashes and returned NEEDS FIXES: 0 Critical, 2 Important, 1 Minor. All entering Critical/Important findings are ADDRESSED.

## Binding corrections

1. `visible: false` is valid candidate evidence, not malformed input. Rectangles must remain finite, nonnegative, and internally consistent. A visible candidate requires positive width/height; a non-visible candidate may have a zero-size rectangle. Discovery of one hidden generic candidate must not abort other candidates. Policy must mechanically reject it as `NOT_VISIBLE`.
2. The retained exact node may legitimately become hidden after an admitted interaction. Its finite zero-size post rectangle and `visible: false` must be collectable, with visibility/layout change evidence eligible for VERIFIED when the same ElementHandle remains connected.
3. Initial rediscovery resolution must return evidence consistent with the reason: zero semantic matches -> `MISSING`; multiple matches -> `AMBIGUOUS`. Do not reuse a default MISSING constructor for both. Add direct non-vacuous initial ambiguity coverage.
4. Close the download Minor now if possible: add a focused guard-handler test with a fake Download whose resolved `cancel()` invocation is directly observed after freeze, while retaining the real-browser data-event record and separate HTTP server zero-delivery tests. Do not claim filesystem contents or server delivery from a data URL.

## Required verification

- Genuine real-browser RED/GREEN: page with hidden generic candidate plus visible candidate discovers both, hidden is REJECT/NOT_VISIBLE, discovery does not throw.
- Genuine real-browser RED/GREEN: an admitted same node hides itself and returns VERIFIED with `visible` (and if applicable bounding box) change.
- Initial duplicate semantic identity returns `NOT_VERIFIABLE`, reason ambiguous, evidence `AMBIGUOUS`.
- Direct fake Download cancel invocation proof after interaction freeze.
- Focused Task 11, Task 5/6/11 adjacent, typecheck, build, and full repository regression.

No Git, dependency operation, live target, hidden wait, DOM marker mutation, or site-specific production selector.
