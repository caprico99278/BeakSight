# Task 11 correction — Task 2 fix round 1 brief

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Authority and scope

This is a correction round for Task 2 only. Read the complete approved design, the complete Task 2 plan section, the original Task 2 brief/report, and the independent FAIL review before editing. Do not begin correction Task 3/4 or product Task 12+.

The controller adjudicates review finding I7 as an irreversible historical evidence gap: the original discovery/inspection behavioral RED cannot be recreated contemporaneously. Record that deviation honestly in the fix report and not-run/deviation ledger. Do not manufacture or relabel evidence. This round must nevertheless establish genuine new RED failures against the current production baseline for every corrected behavior below before any production edit.

## Frozen baseline

Verify every hash before work. Stop and report a mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE` |
| `src/interaction/isolated-auditor.ts` | `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B` |
| `src/evidence/interaction-collector.ts` | `5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761` |
| `tests/integration/isolated-interaction.test.ts` | `E32E31412EBBD6DE8B589641D3F8151E3ED0F8E197426FD0D0F51FE66BF1DFD4` |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-brief.md` | `D010E1B3C77D3ECC3B33EBD540935F62FF3EEC95CA18A9ABF37D142E698FA563` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` | `12D992908C03588D61F3AD3DA7866608A5512595E5BCC0093CA31F52CABB32A2` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-review.md` | `BEE091885E1ED3BB2713BD8EDDF36E0F55021E8A112238E46F0BD3C54230AB68` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `58192365F35F91C2727A7B6C1418294F93971BA2C570303CF63D05FA803BB72E` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `EDBE57474AC3011A7D8EBB97CF27B40D74765D5CFE59A5897407E7542C5D8175` |

## Required correction behavior

Address independent review I1-I6 and strengthen M1-M3. Treat the review text as the exact finding authority.

1. Retained inspection budget:
   - charge accepted-node/membership work, exact retained-target comparison, and candidate-facts collection as distinct approved work categories;
   - stop before every further DOM operation when no unit remains, including fact collection after identity comparison and operations after the final visibility debit;
   - no partial candidate/snapshot publication.
2. Retained identity:
   - an exact acquired element that remains connected must stay `CONNECTED` after unrelated insertions/reordering;
   - return its current live ordinal when within policy range; the old ordinal is a hint, not identity;
   - true detach/replacement and budget exhaustion remain distinct.
3. Resolver ownership and cleanup:
   - own every property handle from `getProperties()` immediately, including unknown/unused properties;
   - attempt all cleanups even when one read/dispose fails;
   - never strand the prospective child element;
   - transfer a FOUND child only after metadata/envelope cleanup succeeds; preserve the primary error while retaining cleanup accountability.
4. Runtime envelope validation:
   - validate container, exact discriminant, safe-integer `domWorkUsed` in `[0, maxDomWork]`, required/forbidden element presence, and a non-null ElementHandle for FOUND;
   - apply equivalent validation to retained snapshots;
   - reject malformed/unknown status, negative/out-of-range/non-integer counts, missing FOUND child, and contradictory child presence.
5. Root candidate preservation:
   - discovery, ordinal resolution, and retained inspection must include a matching `document.documentElement` through the same charged incremental path;
   - preserve document order and ordinals for descendants.
6. Incomplete evidence semantics:
   - budget-incomplete discovery/resolution/pre-admission/retained observation must never publish `identityStatus: MISSING`;
   - represent identity as unestablished using the existing evidence schema if possible; if the schema cannot express it, make the smallest explicit typed extension and update all exhaustive consumers/tests;
   - only complete absence may be `MISSING`.
7. Test-strength fixes:
   - assert exact completeness for ordinary and overflow fixtures;
   - assert exactly 20,000 scoped ancestors, exactly 8,000 preceding nodes, and exactly 9,000 controlled ancestors without body/html contamination;
   - instrument the actual acquired child or a browser click event so the unsafe-click assertion observes the production path.

## Mandatory RED before production edits

Add focused tests first and run them against the frozen production hashes. Capture exact command, exit code, failing test names/messages, and re-check that all production hashes above are unchanged. At minimum prove RED for:

- final retained identity debit leaves no room for candidate facts and performs no uncharged fact/descendant-walker DOM reads;
- final visibility debit performs no later geometry/name/fact DOM reads;
- connected exact retained node after an unrelated preceding insertion returns CONNECTED with the new live ordinal;
- resolver status read failure, metadata dispose failure, extra properties, and prospective FOUND cleanup do not leak any acquired handle;
- malformed resolver and retained envelopes are rejected for every category above;
- matching root `<html>` is discovered, resolved, and retained with ordinal 0;
- each auditor-level incomplete branch exposes unestablished identity, never MISSING;
- exact status/fixture/click instrumentation assertions for M1-M3.

Tests must fail because current production violates the asserted behavior, not because of renderer crashes, missing exports, type errors, broken fixtures, mocks that bypass the production boundary, or intentionally throwing temporary production stubs. If a real-browser fixture is too large to render reliably, use a faithful bounded synthetic callback boundary for the budget-edge unit tests and keep at least one real-browser integration case for root/reorder/lifetime behavior.

## Implementation constraints

- Make the smallest coherent changes. Primary allowed production files: `src/interaction/discover-candidates.ts`, `src/interaction/isolated-auditor.ts`, and only if needed for typed unestablished identity, `src/evidence/interaction-collector.ts` plus exhaustive consumers.
- Allowed tests/fixture: `tests/integration/isolated-interaction.test.ts`, `tests/integration/passive-request-guard.test.ts`, `fixtures/site/total-dom-budget.html` only if truly necessary. Preserve existing assertions.
- No Git commands or operations.
- No dependency/library download, install, import addition, package update, or lockfile change.
- No live target.
- No subagents or reviewers.
- Use `apply_patch` for edits.
- Do not edit approved design/plan, original brief/report/review, or historical artifacts. Append only the controller progress/Task 5 ledgers if their established format requires it.

## Mandatory verification

After GREEN, fresh-run and report exact counts/exit codes:

1. New focused correction tests.
2. Full `tests/integration/isolated-interaction.test.ts`.
3. Full `tests/integration/passive-request-guard.test.ts` because its discovery consumer is in scope.
4. Lifecycle race tests named in the correction plan if separable; otherwise identify their containing command/count.
5. DOM budget tests, including real-browser root/reorder and synthetic exact-boundary cases.
6. Repository test suite.
7. Typecheck.
8. Build.
9. Production forbidden-path scan for `querySelectorAll`, locator/nth whole-DOM enumeration, and budget-reset escapes.

Record any unrun item in the not-run ledger with impact and completion relevance. Do not claim independent review.

## Deliverables

- Implementation/tests satisfying the correction.
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-report.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-manifest.md`
- Append the established progress and Task 5 report ledgers without rewriting history.
- The manifest must enumerate every changed/review-authority/package path with final SHA-256 and identify production-baseline hashes used for genuine RED.

Stop after the implementation report/package. The controller will arrange a fresh independent review.
