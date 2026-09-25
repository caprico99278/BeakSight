# Task 11 correction — independent Task 2 specification and quality review

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Verdict and advancement

**FAIL — Critical 0 / Important 7 / new Minor 3.** Six Importants concern implementation contracts; I7 is a required evidence gate that the fixed package does not establish. Six previously reported historical/deferred Minors are listed separately and are not included in the new finding count.

Task 2 must not advance to Task 3. Task 11 remains unapproved and Task 12 remains blocked. The successful implementation test counts do not resolve the demonstrated counterexamples below.

## Package integrity and method

The reviewer read the controller-frozen package first and independently recomputed all 14 SHA-256 hashes **before reading implementation conclusions**. All 14 matched; there were no missing paths or mismatches.

| Path | Independently calculated SHA-256 | Result |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | MATCH |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | MATCH |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` | MATCH |
| `src/interaction/discover-candidates.ts` | `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE` | MATCH |
| `src/interaction/isolated-auditor.ts` | `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B` | MATCH |
| `tests/integration/isolated-interaction.test.ts` | `E32E31412EBBD6DE8B589641D3F8151E3ED0F8E197426FD0D0F51FE66BF1DFD4` | MATCH |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` | MATCH |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` | MATCH |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | MATCH |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-brief.md` | `D010E1B3C77D3ECC3B33EBD540935F62FF3EEC95CA18A9ABF37D142E698FA563` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` | `12D992908C03588D61F3AD3DA7866608A5512595E5BCC0093CA31F52CABB32A2` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `58192365F35F91C2727A7B6C1418294F93971BA2C570303CF63D05FA803BB72E` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `EDBE57474AC3011A7D8EBB97CF27B40D74765D5CFE59A5897407E7542C5D8175` | MATCH |

Review inputs included the complete approved design, complete Task 2 section, fixed brief/report, all three scoped production files, both scoped integration test files, fixture, and `src/evidence/interaction-collector.ts`. Historical review/baseline artifacts were read to distinguish existing behavior and carried findings. No repository AGENTS.md was found by the scoped filename search. Findings were derived from code, then checked with narrowly targeted no-edit diagnostics where needed. The diagnostics imported current TypeScript source directly through Node's in-memory resolution hook; they did not rely on potentially stale `dist` output.

## Important findings

### I1 — Retained fact collection has no independent debit after target comparison

**Location:** `src/interaction/discover-candidates.ts:491-499`, `:572-590`; related discovery helper boundaries `:362-370` and visibility completion `:324-327` / `:546-549`.

The retained loop spends one unit on node acceptance/membership and the next unit on `candidate === element`. After finding the exact target it immediately reads `.form`, `aria-controls`, and accessible-name attributes without consuming the separately required candidate-facts unit. Discovery has that second candidate-inspection debit at lines 421-425; inspection has used its second debit for identity comparison instead. Thus the two required work categories are collapsed in inspection and its count under-reports work.

A no-edit synthetic callback diagnostic supplied 16,382 non-candidates followed by the retained candidate. Acceptance plus identity comparison used all 16,384 units. Before returning `DOM_WORK_BUDGET_REACHED`, the callback still read `form`, `aria-controls`, `aria-label`, `aria-labelledby`, `title`, and created a descendant walker. The returned count was 16,384, so the existing counter assertions miss these reads. Fact/helper transitions also need explicit exhaustion handling: a visibility walk that spends its last unit and returns false can be followed by name/geometry reads, and reaching the last ancestor can be followed by geometry access.

Apply the design's separate candidate-facts charge and its stop-before-further-DOM-work rule consistently. Add boundary tests that observe these operations, including the final identity debit and final visibility debit; a walker-only upper bound is insufficient. This finding does **not** demand a charge for every attribute getter: the approved candidate-facts grouping is valid, but it must actually have a budgeted entry, distinct from identity comparison.

### I2 — An unchanged retained node is reported disconnected after ordinal reorder

**Location:** `src/interaction/discover-candidates.ts:501-502`; consumer consequence `src/interaction/isolated-auditor.ts:298-315`.

`liveOrdinal !== ordinal` treats an ordinal hint as exact identity. Inserting an unrelated candidate before the retained node leaves that same node connected and within the allowed ordinal range, yet inspection returns `DISCONNECTED`. The auditor then performs semantic rediscovery and calls `collectDisconnectedInteractionEvidence`, which can report the unchanged node as `REPLACED`.

A real installed-Chromium no-edit diagnostic acquired the target at ordinal 0, prepended an unrelated button, and observed `isConnected === true`, live discovery `[0, Unrelated], [1, Target]`, but inspection `{ status: 'DISCONNECTED', domWorkUsed: 6 }`. The historical retained implementation searched for the exact element and returned its live ordinal; it did not require equality with the hint. Preserve that behavior while retaining the bounded scan and ordinal range checks. The current stable-ID test at `tests/integration/isolated-interaction.test.ts:662-683` only compares two discoveries, so it cannot catch this retained-handle regression.

### I3 — Resolver failures can strand acquired property/Element handles

**Location:** `src/interaction/discover-candidates.ts:81-106`.

The property-handle cleanup scope starts after the required-property check, never owns all entries returned by `getProperties()`, and disposes the two known metadata handles sequentially. A missing required property leaks the other acquired properties; a `jsonValue()` rejection leaks the element property; a status-handle disposal rejection skips count disposal. Most importantly, a prospective FOUND return can be replaced by metadata/envelope disposal rejection, leaving its child handle neither returned to the auditor nor disposed by the resolver. Envelope disposal does not dispose independently acquired child handles, as the normal lifetime test itself demonstrates.

No-edit injected-handle diagnostics confirmed: status-read rejection disposed only status/count/envelope, not the element; status-disposal rejection disposed only status/envelope, skipping both count and element; an extra property remained undisposed on MISSING. Own every acquired property immediately, attempt every cleanup despite an individual rejection, and transfer the FOUND child only after resolver cleanup has completed successfully. Preserve the original failure and account for cleanup failures without losing ownership. Add failure-path and unused-property tests; the real Chromium happy-path lifetime test alone is not a cleanup proof.

### I4 — Resolver and retained-snapshot Node boundaries accept invalid envelopes

**Location:** `src/interaction/discover-candidates.ts:89-100`, `:635-642`.

The resolver casts `domWorkUsed` without checking safe-integer/range constraints. Its optional `candidateHandle?.asElement()` produces `undefined` when the property is absent; the cast does not convert that to null, so `undefined !== null` permits `{ status: 'FOUND', handle: undefined }`. The retained-snapshot path accepts every non-CONNECTED status and publishes its count without container/status/count validation. This contrasts with discovery's actual checks at lines 438-446.

No-edit diagnostics returned FOUND with `domWorkUsed: -1`, FOUND with no handle, and retained `{ status: 'INVALID', domWorkUsed: -1 }` without rejection. Validate the three discriminated envelopes, the bounded safe integer, and FOUND's non-null ElementHandle before publication, coordinating rejection cleanup with I3. Type assertions and frozen wrappers do not establish the runtime contract.

### I5 — All three walkers omit a matching document element

**Location:** `src/interaction/discover-candidates.ts:51-58`, `:404-413`, `:481-489`.

`TreeWalker.nextNode()` starts after its root. Rooting the walkers at `document.documentElement` without separately accepting/inspecting that element changes the existing selector union: an `<html role="button">`, `<html role="tab">`, or root with a matching ARIA attribute is never considered. It also shifts the subsequent ordinals. The old document-wide selector included such a root.

A real Chromium diagnostic with `<html role="button" aria-label="Root candidate">` and one child button returned only `[0, button, Child]`; resolving ordinal 0 returned BUTTON. Include the root through the same charged incremental path in all three callbacks and retain document-order semantics. The plan's illustrative root choice has this omission too; the approved design's preservation requirement takes precedence over that sketch.

### I6 — Incomplete absence is still published as MISSING evidence

**Location:** `src/interaction/isolated-auditor.ts:70-80`, `:206-211`, `:232-246`.

The new incomplete-rediscovery branch correctly returns top-level `NOT_VERIFIABLE`, but passes `emptyEvidence(candidate)`, whose default `identityStatus` is `MISSING`. Exact-resolution and pre-admission inspection budget branches similarly publish MISSING evidence. Consequently a consumer of the structured evidence cannot distinguish proven absence from a scan that ran out of budget, contrary to design §5.4's explicit distinction. The post-inspection budget path can also retain the initial MISSING placeholder when no observation was completed.

Represent unestablished identity without asserting missing and cover auditor-level exhaustion at rediscovery, resolver, pre-admission inspection, and retained observation. The Step 12 illustrative `emptyEvidence` call does not satisfy the stronger approved absence semantics. Existing new tests call the discovery/resolver/inspection APIs directly and do not adjudicate the final evidence mapping.

### I7 — Required discovery/inspection behavioral RED is unestablished in the fixed evidence

**Location:** `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md:28-39`, `:49`.

The fixed report establishes export-presence RED and two resolver-stub failures. It explicitly excludes all eight discovery/inspection fixture failures because Chromium crashed before production behavior. After the hidden-host correction, it records final GREEN, but no replacement pre-implementation behavioral RED for whole-DOM enumeration, shared ancestors, shared text, late-target budget, or combined retained work. The appended historical report/progress do not supply that missing sequence either.

This is an evidence gap, not an allegation that an unreported run could not have occurred. Approved design §8 and Task 2 Steps 3-6/brief require genuine behavioral RED for these paths before implementing them; resolver-stub RED does not prove discovery/inspection failures. Supply the actual contemporaneous evidence if it exists. Otherwise record the deviation honestly and obtain controller adjudication; later mutation tests may strengthen verification but cannot retroactively establish pre-implementation TDD. This reviewer did not revert production to manufacture RED.

## New Minor findings

1. **M1 — Completeness assertions permit the wrong status.** `tests/integration/isolated-interaction.test.ts:93-94`, `:422-428`: the shared helper accepts either COMPLETE or CANDIDATE_LIMIT_REACHED for every fixture, and the overflow test never specifically requires CANDIDATE_LIMIT_REACHED. Several direct discoveries at `:480-503` and `:667-678` ignore completeness. Step 13 required COMPLETE for ordinary fixtures and the exact cap status for overflow. Assert each intended status so mutations that mark every result COMPLETE or every ordinary fixture capped are caught.
2. **M2 — Hostile fixture preconditions under-assert their exact structure.** `tests/integration/isolated-interaction.test.ts:109-118`, `:258-270`: the 20,000-chain check only requires at least 20,000 total ancestors; the combined check only requires at least 9,000 and never counts the 8,000 preceding nodes. The actual construction loops are faithful today. Count wrappers to the scoped host separately from body/html and assert the exact preceding-node count, so additional or reduced fixture structure cannot silently change which work category exhausts the budget.
3. **M3 — Unsafe-click counter no longer observes the acquired child.** `tests/integration/isolated-interaction.test.ts:764-774`, `:790-807`, `:819-820`: the new evaluateHandle interception returns the real envelope, but `unsafeClickCalls` is incremented only by the obsolete locator wrapper. The production resolver no longer uses that wrapper, making the zero-click assertion vacuous for the current path. Instrument the returned child or an observable browser click event while preserving the NOT_VERIFIABLE assertion.

## Requirement matrix and charge audit

| Requirement | Assessment and evidence |
| --- | --- |
| Exactly one production `maxDomWork: 16_384` | PASS: `interaction-policy.ts:43-51`; no additional production literal in the scoped paths. |
| One browser-local budget per serialized operation | PASS structurally: resolver `:39-50`, discovery `:269-280`, inspection `:468-479`; no page-global budget or cross-call state. |
| Charged incremental element enumeration/membership | Present in each loop. The accepted-element unit precedes local membership testing, matching the plan's enumeration sketch; no separate finding invents another non-candidate debit. Root coverage fails I5. |
| Charged candidate facts and retained identity comparison | Discovery has its candidate-facts debit. Resolution charges target ordinal comparison. Inspection charges target identity but omits a distinct facts debit: FAIL I1. |
| Shared descendant-text work and secondary caps | Both collectors use SHOW_ALL, charge each accepted node, cap each helper's aggregate label-root traversal at 512 nodes and bounded characters; all helper calls use the same total budget. No reset of the total per candidate/root. |
| Shared visibility and control/label lookup work | Ancestor visits and each getElementById lookup consume the invocation budget; correct innermost controlled target. Exact exhaustion transitions need I1 repair. |
| No extra walker acceptance after total limit | Loop guards precede nextNode at the total limit; no max+1 acceptance found. Other fact reads after the final comparison debit are demonstrated in I1. |
| No querySelectorAll/locator/nth whole-DOM escape in production | PASS source scan and call tracing of discovery/resolution/inspection/auditor. Fixture construction and test handle setup are not production escapes. |
| No partial candidate appended | Discovery appends only after collectCandidate returns a record; null abort preserves earlier complete candidates. Inspection returns no raw candidate on its explicit budget branches. I1 concerns missing work accounting, not an invented push-before-collection defect. |
| COMPLETE / CANDIDATE_LIMIT_REACHED / DOM_WORK_BUDGET_REACHED | Production status flow is conservative: full end => COMPLETE, retained cap => CANDIDATE_LIMIT_REACHED, failed collection/limit => DOM_WORK_BUDGET_REACHED. Exact cap test coverage needs M1. |
| FOUND / MISSING / budget distinction | Browser loop distinguishes them, but Node validation and ownership fail I3/I4. |
| CONNECTED / DISCONNECTED / budget distinction | True detached and late-target budget branches exist; ordinary reorder is falsely DISCONNECTED: I2. Snapshot validation fails I4. |
| Node-side validation and deep immutability | Discovery validates container/status/count; candidateFromRaw plus freezeInteractionCandidate validate/freeze candidate and nested geometry; candidate array/wrappers frozen. Resolver/snapshot metadata validation fails I4. Transport handles appropriately remain usable, unfrozen transport objects. |
| Envelope/status/count/unused child disposal; returned child lifetime | Normal child survives envelope disposal (existing Chromium test and reviewer diagnostic). Failure/extra-property ownership fails I3. Auditor has one finalizer after a successful FOUND handoff. |
| Auditor incomplete outcomes | Top-level budget branches map to NOT_VERIFIABLE, not VERIFIED; direct retained exhaustion does not initiate disconnected rediscovery. Structured MISSING evidence remains incorrect: I6. |
| Document order, generic selector semantics, stable ID/reorder, clone | Descendant order/union dedup and ID hashing preserved; document root omitted I5; retained reorder regressed I2; clone disconnection classification path remains present. |
| Hostile text / NodeList behavior | No full textContent/nodeValue or NodeList iteration in production; legacy probes now isolate SHOW_ALL while preserving 512-node assertions. |
| S03-S08 and Guard migration | Real request-observation/zero-delivery assertions remain in isolated tests `:691-755` and `:861-892`; Guard consumer uses structured discovery/evaluateHandle/CONNECTED at `passive-request-guard.test.ts:1772-1847`, preserving deferred cleanup assertions. No safety authority or transport entry point added. |
| Hidden-host 20,000 and 8,000/9,000 fidelity | PASS static construction: exactly 20,000 wrappers, 20,000 non-candidates, 100 × 512 descendant elements in fixture; exactly 8,000 preceding divs and 9,000 wrappers in combined test. Only the controlled chain is hidden, and target ID stays innermost. Hidden host is reached after the long chain, so it does not shortcut ancestor charging. Runtime precondition strength is M2. |
| Genuine staged RED / fixed verification evidence | Resolver API/stub evidence present; broader required RED unestablished I7. Reported GREEN counts are recorded below without being claimed as reviewer reruns. |

## Verification and evidence audit

Reviewer-executed read-only/no-edit diagnostics:

- Initial 14-file SHA-256 recomputation: exit 0, 14/14 matches.
- Current-source Node diagnostic using injected JSHandle/ElementHandle boundaries and a synthetic DOM walker: exit 0. Demonstrated invalid-count acceptance, FOUND without handle, unknown retained status acceptance, skipped disposal paths, and six fact/DOM operations after the final retained identity debit. Console results were observed directly; no diagnostic file was created.
- Current-source installed-Chromium diagnostic using only in-memory `page.setContent`: initial restricted launch exited 1 with `spawn EPERM` before assertions; the identical explicitly escalated no-edit command exited 0. Demonstrated root omission, usable returned child, and connected retained target incorrectly classified DISCONNECTED after insertion. The launch failure is an environment attempt, not behavioral RED.
- Source/consumer scans: no production querySelectorAll or locator/nth path in the scoped modules; all production discovery consumers are in the auditor; all maintained test consumers were traced. No dependency or package operation was run.

Implementation-reported evidence, **not independently rerun here**: focus 11/11; isolated interaction 68/68; Guard 114/114; repository 26 files / 465 tests; typecheck/build exit 0. These assertions appear in the pinned Task 2 report, and their test bodies were reviewed. They do not cover the demonstrated error/boundary/reorder cases sufficiently to establish the requested acceptance criteria.

NOT RUN — focused/full existing test suites: reviewer authorization permits only a narrow existing test or no-edit diagnostic to resolve concrete doubt; focused no-edit diagnostics resolved the relevant doubts. Impact: no new reviewer full-suite pass claim. Completion blocker: the seven Importants above, not the absence of a duplicate broad run.

NOT RUN — typecheck/build: no production/test edits by reviewer, static/diagnostic review only. Impact: rely on pinned implementation claims for these gates; no fresh reviewer compilation claim. Completion blocker: no independent additional blocker beyond findings; rerun appropriate gates after correction.

NOT RUN — Task 3/4/12 or live target: expressly outside Task 2 review authorization. Impact: structured work/lifecycle implementation and final whole-correction approval remain pending. Completion blocker: yes for final Task 11 approval, not an additional Task 2 defect.

## Historical/deferred items, kept separate

The preceding round-5 specification review listed six Minors; its quality review carried the first five. This Task 2 review neither claims they were fixed nor elevates them into new Task 2 blockers:

| Historical item | Source of carried classification |
| --- | --- |
| Lifecycle-phase HTTP abort correlation | `task-11-architecture-recovery-fix-round-5-quality-review.md`, carried M1; Guard lifecycle implementation outside this Task 2 correction. |
| Failed-main-frame test helper drops async return | Same artifact, carried M2; current helper remains `void` at `tests/integration/passive-request-guard.test.ts:350-364`. |
| Page-readiness task-factory indentation | Same artifact, carried M3; unrelated Guard implementation. |
| Auditor String(error) can materialize huge intermediate text | Same artifact, carried M4; `src/interaction/isolated-auditor.ts:58`. |
| Historical implementation-plan sample authority drift | Same artifact, carried M5; older recovery-plan snippets, not permission to override the current approved design. |
| Construction error test checks name/shape rather than runtime class | `task-11-architecture-recovery-fix-round-5-spec-review.md`, Minor 6; factory correction coverage outside Task 2. |

The former whole-DOM/ancestor-budget deferral is **superseded** by the current user-approved design and is not a reason to defer I1. Structured work/lifecycle result changes belong to Task 3 and were not demanded or implemented in this review.

## Constraints and handoff

Only this review artifact was written, using apply_patch. No production/test/fixture/spec/plan/report/package changes, Git operations, dependency installation/download, live target access, Task 3+ work, or subagents occurred. Browser diagnostics used the already-installed Chromium and in-memory local HTML, with acquired handles and browser closed in finally blocks. Address I1-I6 and adjudicate I7, strengthen the listed tests, then submit a new frozen package for independent review before advancement.
