# Task 11 correction — Task 2 fix round 1 independent specification and quality review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Verdict and advancement

**FAIL — Critical 0 / Important 3 / new Minor 0.** Task 3 must not start. Task 11 remains unapproved and product Task 12 remains blocked.

The correction does repair the original retained-budget debit, connected reorder, ordinary Handle cleanup, runtime-envelope, document-root, and four explicitly tested budget-evidence counterexamples. Three binding edge contracts remain open: the invocation-wide 512-node secondary text cap is still reset per helper call, a primary rejection whose value is `undefined` is replaced rather than preserved, and `MISSING` is still the default for work that did not establish absence.

## Fixed-package integrity

The fixed manifest itself was read first and matched its required SHA-256 `EE5F4BC95F6598CED13CDF5C3D1F3A98BE0053A31C41FE109D0919111DC5F306`. Before reviewing implementation conclusions, all 25 paths in its Final fixed package were independently hashed and all 25 matched. After all review diagnostics, the same 25 paths were hashed again and all 25 still matched the manifest. There was no package drift, missing path, or review-time production/test change.

## Important findings

### I1 — The secondary `maxTextNodes` cap is reset for each helper call instead of being shared by the invocation

**Location:** `src/interaction/discover-candidates.ts:359-386`, `:407-426`, `:428-526`, `:626-652`, `:673-727`.

Both serialized fact collectors declare `let visitedNodes = 0` inside `boundedDescendantText()`. Every accessible-name call, normalized-text call, and later candidate therefore receives a fresh 512-node allowance. The total `maxDomWork` object is shared, so the hard 16,384 bound is present, but the approved design deliberately retains `maxTextNodes` as a secondary invocation-local cap and says descendant text must not receive a new 512-node allowance for each helper call (design §5.3 lines 185-196; test contract §5.6 line 251). This is not a request for a second total-work budget: it requires one text-node counter owned by each discovery/inspection invocation, while every accepted text node also continues to debit the shared total DOM-work budget.

A no-edit installed-Chromium diagnostic used one candidate with a 400-element labelled subtree and a separate 400-element candidate subtree. Current production accepted **802** `SHOW_ALL` nodes, returned `COMPLETE`, used 1,612 total DOM-work units, and published the candidate. This is below `maxDomWork` but above the binding 512-node secondary cap. Existing multi-root tests prove 512 is shared across roots within one helper call; they do not kill reset between accessible-name and normalized-text calls or between candidates. Add both-path mutation-proof coverage and share the secondary counter without weakening the total budget.

### I2 — `undefined` is both the resolver's “no primary error” sentinel and a legal primary rejection value

**Location:** `src/interaction/discover-candidates.ts:37-43`, `:101-106`, `:140-177`.

The resolver correctly attempts every ordinary property/envelope cleanup and reclaims a prospective FOUND child when cleanup fails. However, `primaryError` is initialized to `undefined`, the catch assigns the caught value, and `resolutionFailure()` interprets `undefined` as “no primary failure.” JavaScript promises may reject with `undefined`; the repository already treats that as a real rejection in lifecycle coverage. When `statusHandle.jsonValue()` rejects with `undefined`, all handles are disposed, but the caller receives `Error: Invalid bounded interaction handle resolution envelope` rather than the original `undefined` rejection. With an additional cleanup failure, the AggregateError similarly omits the primary rejection.

A no-edit injected-envelope diagnostic observed `isUndefined: false`, the replacement invalid-envelope error, and successful disposal of status/count/extra/envelope. Thus this is not a leak finding; it is the still-unmet fix-brief requirement to preserve the primary error while retaining cleanup accountability. Track primary-error presence with a separate boolean/result record and test `Promise.reject(undefined)` alone and together with cleanup failure.

### I3 — `MISSING` remains the default for outcomes that never established complete absence

**Location:** `src/interaction/isolated-auditor.ts:72-81`, `:183-203`, `:222-265`, `:280-303`, `:397`; focused correction coverage `tests/integration/isolated-interaction.test.ts:1085-1144`.

The five DOM-budget/incomplete-discovery branches at lines 206-210, 232-236, 249-253, 310-314, and 318-323 correctly publish `UNESTABLISHED`. But `emptyEvidence()` still defaults to `MISSING`, so deadline, work-exception, unresolved-transition, and pre-observation paths assert absence without a complete identity search. For example, a no-edit audit whose initial navigation merely outlived its deadline returned `NOT_VERIFIABLE`, reason `Interaction deadline expired after initial load`, and `identityStatus: MISSING`. `lastEvidence` is also initialized to MISSING before retained observation, and a changed exact retained node at lines 260-261 is reported with the same absence placeholder.

The fix brief's I6 contract is broader than the four parameterized budget tests: represent unestablished identity explicitly and allow `MISSING` only after complete absence. Make `UNESTABLISHED` the neutral/incomplete construction (or require an explicit status at every call), then pass `MISSING` only at branches whose complete discovery/resolution proves the relevant identity absent. Add exhaustive branch tests, including post-disconnection incomplete rediscovery and deadline/error paths; keep complete absence, ambiguity, replacement, and matched evidence distinct.

## Prior findings and test-strength adjudication

| Prior item | Result | Concrete evidence |
| --- | --- | --- |
| I1 retained facts need an independent debit and stop-before-follow-on work | **ADDRESSED** | accepted-node/membership, exact comparison, and facts are separately debited at `discover-candidates.ts:603-617`; helper/geometry transitions stop at `:631-670` and `:699-727`; boundary tests are at `isolated-interaction.test.ts:363-496`. |
| I2 connected retained reorder must return current ordinal | **ADDRESSED** | no equality check against the hint remains; live ordinal is returned at `discover-candidates.ts:594-617, 728-733`; real-browser insertion test `:498-521` passes. |
| I3 resolver must own every property and preserve primary plus cleanup failures | **NOT ADDRESSED** | all ordinary property and child cleanup is now owned at `discover-candidates.ts:101-169`, but Important I2 above shows a legal primary rejection value is discarded. |
| I4 resolver/snapshot runtime validation | **ADDRESSED** | safe count helper `:31-35`; resolver discriminant/count/child contradictions `:109-139`; snapshot container/discriminant/count/raw contradictions `:768-792`; malformed-envelope tests `isolated-interaction.test.ts:639-680`. |
| I5 matching document root must be included | **ADDRESSED** | charged root-pending traversal exists in resolution `:66-98`, discovery `:498-536`, and inspection `:585-617`; real-browser root/order test `isolated-interaction.test.ts:523-551` passes. |
| I6 incomplete absence must not publish MISSING | **NOT ADDRESSED** | the newly enumerated DOM-budget branches are corrected, but Important I3 above shows the binding “only complete absence” rule is not enforced across the auditor. |
| I7 original pre-implementation discovery/inspection RED gap | **HISTORICAL / ADJUDICATED, HONESTLY RECORDED** | fix brief line 9, fix report lines 38 and 74-76, Task 5 ledger lines 722-724, and progress lines 392-393 all preserve it as irreversible; no retroactive RED is claimed. |
| M1 exact completeness expectations | **ADDRESSED** | helper asserts its exact expected status at `isolated-interaction.test.ts:130-140`; ordinary, overflow, and hostile cases pass exact statuses. |
| M2 exact hostile fixture counts | **ADDRESSED** | exactly 20,000 scoped wrappers are asserted at `:151-174`; exactly 8,000 preceding nodes and 9,000 controlled wrappers are asserted at `:308-340`, excluding body/html scope. |
| M3 unsafe-click observation on the production path | **ADDRESSED** | a capture listener and exposed browser binding observe the acquired child path at `:1212-1238`, with zero browser events asserted at `:1281-1285`; the legacy locator counter remains supplementary only. |

## Independent contract audit

- `maxDomWork: 16_384` has one production owner, and discovery/resolution/inspection each create exactly one browser-local total budget. Accepted element work, matched-candidate inspection, retained comparison, candidate facts, visibility ancestors, text acceptances, and label/control lookups debit that budget. Exhaustion checks prevent the demonstrated prior identity/facts and final-visibility overreads. The secondary text cap remains Important I1.
- All three callbacks include the document root and then descendants in document order. No production `querySelectorAll`, locator/nth enumeration, NodeList materialization, recursive DOM traversal, `textContent`, or `nodeValue` escape was found. Partial candidates/snapshots are not published.
- Discovery/resolution/inspection maintain distinct COMPLETE/capped/budget, FOUND/MISSING/budget, and CONNECTED/DISCONNECTED/budget results. Node-side count/discriminant/container/child/raw validation is present. Important I2 concerns primary-error identity, not cleanup cardinality; Important I3 concerns evidence semantics, not the browser discriminants.
- Every ordinary resolver property, including unknown properties, is attempted for disposal; all cleanup attempts continue after a disposal error; a FOUND child transfers only after metadata and envelope cleanup succeed; the returned real Chromium child remains usable. The auditor owns a successfully transferred child in one `finally`.
- Exact hostile fixture construction is faithful: 20,000 scoped controlled ancestors, 20,000 late-candidate predecessors, and 100 × 512 repeated descendants. The combined runtime characterization proves 8,000 preceding elements plus 9,000 controlled ancestors. Only the deep controlled subtree is hidden.
- S03-S08 and zero-delivery assertions remain present. The fresh 12-test safety focus passed, and the Guard's structured discovery/evaluateHandle consumer preserves its cleanup assertions. No new safety owner, interaction entry point, selector policy owner, or target-specific logic was added.

## Reviewer-run evidence

Fresh reviewer commands/diagnostics, separate from implementer-reported evidence:

1. Initial fixed-manifest hash plus all 25 final-package hashes: exit 0, 25/25 match.
2. `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction"`: first restricted attempt exited 1 with Chromium `spawn EPERM` before tests and is excluded; the identical approved process-launch run exited 0, **29 passed / 68 skipped**.
3. `npm test -- --run tests/integration/isolated-interaction.test.ts -t "blocks an admitted|cancels and records|blocks an admitted HTTP|mechanically rejects|Service Worker"`: exit 0, **12 passed / 85 skipped**.
4. No-edit installed-Chromium secondary-cap diagnostic: exit 0; `accepted=802`, `completeness=COMPLETE`, `domWorkUsed=1612`, one candidate — demonstrates Important I1.
5. No-edit injected resolver diagnostic with `status.jsonValue() -> Promise.reject(undefined)`: exit 0; all acquired handles disposed, but rejection changed to `Invalid bounded interaction handle resolution envelope` — demonstrates Important I2.
6. No-edit audit deadline diagnostic: exit 0; `NOT_VERIFIABLE`, `Interaction deadline expired after initial load`, `identityStatus=MISSING` — demonstrates Important I3.
7. Production forbidden-path and budget-owner scans: no `querySelectorAll`, `.locator(`, or `.nth(` in the discovery/auditor production paths; one policy constant and three serialized total-budget initializers. Final 25-path SHA-256 recomputation: exit 0, 25/25 match.

Implementation-reported, not claimed as reviewer reruns: correction focus 29/29; combined DOM focus 40/40; isolated interaction 97/97; Guard 114/114; lifecycle focus 6/6; repository 26 files / 494 tests; typecheck/build exit 0. The pinned report honestly records the first lost-output rerun and historical I7 deviation.

## Not-run ledger

- **NOT RUN — full isolated-interaction, full Guard, and repository suites by this reviewer.** Reason: the implementer package already pins fresh broad runs; reviewer authorization called for narrow tests/no-edit diagnostics, which established both repaired behavior and the three remaining counterexamples. Impact: no duplicate reviewer full-suite claim. Completion blocker: the three Important findings, not this duplicate-run omission; rerun the required broad gates after correction.
- **NOT RUN — reviewer typecheck/build.** Reason: the reviewer changed no production/test/type file; pinned implementation runs exist. Impact: no fresh reviewer compiler/emitted-output claim. Completion blocker: no independent blocker beyond the Important findings; rerun after correction.
- **NOT RUN — live target, dependency/package operation, Git, correction Task 3/4, or product Task 12+.** Reason: expressly prohibited/out of scope. Impact: later structured-outcome and final checkpoint work remains pending. Completion blocker: yes for overall Task 11, not an additional Task 2 defect.

## Historical/deferred items

I7 remains the separately adjudicated historical evidence deviation and was not concealed or relabeled. The six earlier carried Minors remain outside this Task 2 fix: lifecycle-phase HTTP abort correlation; the failed-main-frame helper's dropped async return; page-readiness task-factory indentation; potentially large intermediate `String(error)` materialization; historical implementation-plan sample drift; and the construction-error runtime-class assertion. None is promoted into the new finding counts.

Only this review artifact was written. No production/test/fixture/spec/plan/report/manifest/package file was edited; no Git operation, dependency download/install/import/package mutation, live-target access, Task 3+ work, or subagent operation occurred.
