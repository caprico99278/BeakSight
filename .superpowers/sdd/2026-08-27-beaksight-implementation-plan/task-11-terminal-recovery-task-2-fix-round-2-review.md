# Task 11 correction — Task 2 fix round 2 independent specification and quality review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Verdict and advancement

**PASS — Critical 0 / Important 0 / new Minor 0.** The three Important findings from the fix-round-1 review are ADDRESSED, prior I1–I6 and M1–M3 have not regressed, and Task 2 permits the controller to begin correction Task 3. This does not approve Task 11 or permit product Task 12+; those remain gated by correction Tasks 3 and 4 and user approval.

## Fixed-package integrity

The fixed manifest was read first and matched its required SHA-256 `8249C9AB4E407A0373407685DBA339061D6532B0EC4F888C2FBBACD78BE8B221`. Before conclusions, all 25 paths in its Final fixed package were independently hashed and all 25 matched. After source review and reviewer-run diagnostics, the same 25 paths were recomputed: **25 checked / 25 matched / 0 mismatched**. No package drift or review-time production/test/spec/plan/report/manifest change occurred.

## Fix-round-1 Important findings

### I1 — Invocation-wide secondary text ownership: ADDRESSED

- Discovery creates one callback-local `textWork` owner at `src/interaction/discover-candidates.ts:357`; retained inspection creates one at `:591`. Neither counter is page-global, helper-local, or shared across invocations.
- Every accessible-name root, fallback name traversal, normalized-text traversal, and later candidate in the same discovery callback uses the same counter through `boundedDescendantText()` (`:366-393`, `:414-433`, `:435-503`). Retained accessible-name and normalized-text work share the inspection counter at `:634-700` and `:702-770`.
- Both callbacks test `textWork.used` before `nextNode()`, debit the shared total `domWork` for every non-null accepted `SHOW_ALL` node, and then increment the secondary counter. At the exact cap they stop before accepting another node, return an incomplete result, and do not publish the in-progress candidate/snapshot. Completed earlier candidates remain immutable evidence.
- The focused real-browser regressions cover accessible-name plus normalized-text aggregation, aggregation across candidates, and retained inspection. Fresh reviewer execution passed all 13 round-2 tests and the combined 53-test DOM/correction focus.

There is no per-helper `visitedNodes` reset and no cross-invocation mutable text state.

### I2 — Present `undefined` primary rejection: ADDRESSED

- Resolver extraction now tracks `primaryErrorPresent` separately from `primaryError` (`src/interaction/discover-candidates.ts:105-148`). `resolutionFailure()` branches on presence rather than value (`:37-48`).
- A sole `Promise.reject(undefined)` is rethrown as `undefined`. When cleanup also fails, `AggregateError.errors` begins with the present `undefined` primary followed by cleanup failures.
- The existing immediate ownership model is retained: every property from `getProperties()`, including unknown properties, is cleaned; metadata and envelope cleanup are both attempted; a prospective FOUND child is transferred only after successful validation and cleanup, otherwise it is reclaimed (`:150-183`).
- Focused tests exercise `undefined` alone and with cleanup failure, while the maintained status-read, metadata-dispose, unknown-property, envelope-failure, malformed-envelope, and real-Chromium child-lifetime cases remain passing.

### I3 — Neutral evidence unless identity is established: ADDRESSED

- `emptyEvidence()` now defaults to `UNESTABLISHED` (`src/interaction/isolated-auditor.ts:72-81`). Deadline, navigation/work error, freeze-transition error, pre-observation state, exact retained-node change, and budget-incomplete paths therefore no longer assert absence.
- Direct `MISSING` construction remains only at complete initial rediscovery absence (`:213-218`), bounded resolver `MISSING` (`:228-237`), and complete retained-handle disconnection before admission (`:245-261`). Post-disconnection rediscovery returns `UNESTABLISHED` when incomplete and no completed semantic match exists (`:320-328`); complete rediscovery continues through `collectDisconnectedInteractionEvidence()`.
- `AMBIGUOUS`, `REPLACED`, and `MATCHED` remain distinct. Real fixture regressions continue to prove initial ambiguity, post-disconnection missing/ambiguous/replaced, successful matched change evidence, and matched mechanical rejection.
- The explicit round-2 auditor cases for initial-load deadline, navigation error, unresolved safety transition, pre-observation freeze, changed retained node, incomplete post-disconnection rediscovery, all four budget branches, and complete rediscovery/resolution absence passed in the reviewer focus/full-file runs.

## Prior I1–I6 and M1–M3 non-regression

| Prior item | Result | Review evidence |
| --- | --- | --- |
| I1 distinct retained accepted-node/comparison/fact work and stop-before-follow-on reads | **ADDRESSED / no regression** | Retained traversal and fact boundary remain at `discover-candidates.ts:603-625`; final-identity and final-visibility boundary tests pass in the 53-test focus. |
| I2 connected exact retained node survives reorder with current live ordinal | **ADDRESSED / no regression** | Exact identity, not the ordinal hint, determines connection at `:602-625`; the real-browser preceding-insertion case passes. |
| I3 total resolver Handle ownership/cleanup | **ADDRESSED / strengthened** | All property/envelope cleanup and prospective-child reclamation remain; round-2 presence handling closes the only residual edge. |
| I4 resolver/snapshot runtime envelope validation | **ADDRESSED / no regression** | Exact discriminants, safe bounded counts, and required/forbidden child/raw forms remain validated at `:113-143` and `:776-800`; malformed matrices pass. |
| I5 matching document root and document order | **ADDRESSED / no regression** | Resolution, discovery, and inspection retain charged root-pending traversal at `:70-102`, `:505-543`, and `:593-625`; the root/child ordinal test passes. |
| I6 incomplete identity is not MISSING | **ADDRESSED / strengthened** | All previously corrected budget branches remain `UNESTABLISHED`; neutral default now covers the additional work/deadline paths. |
| M1 exact completeness assertions | **ADDRESSED / no regression** | Ordinary, candidate-limit, total-budget, and secondary-budget expectations are exact. |
| M2 exact hostile fixture shape | **ADDRESSED / no regression** | Fixture/test preconditions prove exactly 20,000 scoped wrappers and the combined test proves exactly 8,000 predecessors plus 9,000 scoped controlled ancestors without body/html contamination. |
| M3 unsafe-click observation on production path | **ADDRESSED / no regression** | Browser capture-event instrumentation on the acquired child remains authoritative and asserts zero events; the old locator counter remains supplementary. |

## Independent contract audit

- `maxDomWork: 16_384` has one policy owner. Resolution, discovery, and retained inspection have exactly three callback-local total-budget owners; discovery and inspection have exactly two invocation-local secondary text owners.
- Candidate enumeration, exact resolution, and retained inspection contain no production `querySelectorAll`, `.locator(`, or `.nth(` path. There is no NodeList materialization, recursive DOM traversal, `textContent`, or `nodeValue` shortcut in these callbacks.
- Root/document order, live ordinal, visibility ancestors, label/control lookups, descendant text, candidate facts, and retained comparison remain on the bounded paths. Budget exhaustion stays distinct from complete missing/disconnected outcomes and partial candidate/snapshot publication is absent.
- The hostile fixture remains deterministic and local: no network or post-load mutation, with only the scoped deep subtree hidden. The production candidate selector remains generic and no site-specific route/selector authority was added.
- Guard discovery consumption remains structured. The reviewer-run full Guard file passed 114/114, including lifecycle retry/race and deferred-cleanup interaction consumers. The isolated safety focus passed 12/12, preserving S03–S08 and fixture-server zero-delivery assertions.

## Reviewer-run evidence

Fresh reviewer evidence, separate from the implementation report:

1. Initial manifest and package integrity: manifest hash matched; 25/25 final-package hashes matched.
2. `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 fix round 2"`: the restricted launch exited before tests with Chromium `spawn EPERM` and is excluded; the approved process-launch rerun exited 0, **13 passed / 97 skipped**.
3. Combined Task 2 DOM/correction focus: exit 0, **53 passed / 57 skipped**.
4. S03–S08/zero-delivery focus: exit 0, **12 passed / 98 skipped**.
5. `npm test -- --run tests/integration/isolated-interaction.test.ts`: exit 0, **110/110 passed**.
6. `npm test -- --run tests/integration/passive-request-guard.test.ts`: the restricted launch exited before tests with Chromium `spawn EPERM` and is excluded; the approved process-launch rerun exited 0, **114/114 passed**.
7. Static production scans: no `querySelectorAll`, `.locator(`, or `.nth(` in discovery/auditor; one `maxDomWork` policy constant, three total-budget owners, two secondary-text owners, and no helper-local `visitedNodes` reset. All `MISSING`/neutral evidence construction sites were enumerated and adjudicated.
8. Final fixed-package integrity: **25/25 hashes matched**.

Implementation-reported, not relabeled as reviewer execution: genuine RED 10 failed / 3 passed / 97 skipped with frozen production hashes; repository 26 files / 507 tests; named lifecycle focus 6/6; typecheck and build exit 0; emitted artifacts and forbidden scans pinned in the fixed manifest/report.

## Not-run ledger

- **NOT RUN — repository-wide suite by this reviewer.** Reason: the reviewer ran both full in-scope integration files plus the focused safety and Task 2 sets; the fixed implementation report pins the fresh 507-test repository run. Impact: no duplicate reviewer repository-wide claim. Completion relevance: no Task 2 blocker because in-scope independent coverage passed and the fixed package is unchanged.
- **NOT RUN — separate named lifecycle-focus command by this reviewer.** Reason: the full 114-test Guard file was run and includes those maintained cases; the implementation report separately pins 6/6 for the named filter. Impact: no duplicate filtered-count claim. Completion relevance: no Task 2 blocker.
- **NOT RUN — reviewer typecheck and build.** Reason: the reviewer changed no production/test/type/emitted file, and build would rewrite fixed emitted artifacts; the manifest pins implementer typecheck/build success and matching dist hashes. Impact: no independent compiler/build claim. Completion relevance: no Task 2 blocker; final Task 11 verification remains Task 4 work.
- **NOT RUN — live target, dependency/library/package operation, Git, correction Task 3/4, or product Task 12+.** Reason: expressly prohibited or outside this review. Impact: structured outcome work and final Task 11 approval remain pending. Completion relevance: Task 3 is now unblocked; Task 11 and product Task 12 remain blocked on later gates/user approval.

## Historical/deferred items

Historical I7 is visible in the round-1 brief/report/review, round-2 brief/report, Task 5 ledger, and progress ledger as the controller-adjudicated irreversible original behavioral-RED deviation. The round-2 RED is explicitly correction-only and is not presented as retroactive evidence. I7 is therefore not concealed or falsely relabeled and is not a new implementation finding.

The six earlier carried/deferred Minors listed in the round-1 review are unchanged and outside this Task 2 fix-round-2 package. None is promoted into this review's new finding count.

Only this review artifact was written. No production, test, fixture, spec, plan, report, manifest, package, lockfile, or emitted file was edited; no Git operation, dependency/library operation, live-target access, Task 3+ implementation, or subagent operation occurred.
