# Task 11 Architecture Recovery Task 5 Implementation Report

Date: 2026-08-31  
Scope: listener teardown implementation and implementation verification only  
Status: implementation verified locally; independent review/package/checkpoint closure remains controller-owned

## Constraints observed

- No Git command or Git metadata operation was used.
- `.git-sandbox-backup` was not modified.
- No dependency/package import, install, update, or download was performed.
- Only the already-installed headless Chromium was used, with execution approval.
- No live target was accessed.
- No subagent was created and Task 12 was not started.
- `task-11-report.md`, `progress.md`, historical reports/reviews/baselines, and the final architecture review package were not modified.
- This is the only new report created by the implementation pass.

## Dispatch and immutable baseline verification

All dispatch hashes matched before editing:

| Artifact | Entering SHA-256 |
|---|---|
| Task 5 brief | `2360AE3AA9D84FBDDF8EB90769EBC48E4B46B73BE5DCE3947144D07235FA00E3` |
| `src/safety/passive-request-guard.ts` | `D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB` |
| `tests/integration/passive-request-guard.test.ts` | `6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A` |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` |

The three immutable files in `task-11-recovery-task-5-baseline/` matched their corresponding entering production/test files byte-for-byte by SHA-256. The approved design hash was `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18`.

## Root cause and implementation

The guard already declared `GuardState.listenerCleanups`, but no registration populated it and neither successful owner close nor successful invalidation consumed it. Context, CDP, and Page callbacks therefore outlived the guard's logical terminal boundary in the harness and had no exact inverse ownership.

`detachGuardListeners()` now splices the shared queue before invoking callbacks. Every cleanup is therefore admitted for at most one attempt. A callback failure records the bounded Safety Ledger invariant `GUARD_LISTENER_CLEANUP_FAILED` through the existing bounded `recordInvariantViolation()` path and does not stop later cleanup callbacks.

Every owned event registration is named and has an exact inverse in the one `listenerCleanups` owner:

| Owner | Event | Named handler | Exact inverse |
|---|---|---|---|
| BrowserContext | `page` | `onPage` | `context.off('page', onPage)` |
| BrowserContext | `requestfailed` | `onRequestFailed` | `context.off('requestfailed', onRequestFailed)` |
| CDPSession | `close` | `onSessionClose` | `session.off('close', onSessionClose)` |
| CDPSession | `Fetch.requestPaused` | `onRequestPaused` | `session.off('Fetch.requestPaused', onRequestPaused)` |
| Page | `download` | `onDownload` | `page.off('download', onDownload)` |
| Page | `popup` | `onPopup` | `page.off('popup', onPopup)` |
| Page | `framenavigated` | `onFrameNavigated` | `page.off('framenavigated', onFrameNavigated)` |

Successful owner close and successful safety invalidation now follow the same terminal ownership rule: `context.close()` succeeds, listeners are detached, guard-owned tasks are stable-set drained, and only then phase becomes `CLOSED`. A rejected close never runs listener cleanup, retains the fail-closed callbacks, keeps an invalidating phase, drains already-owned work, and propagates the rejection.

Self-review found that the prior `closeError !== undefined` sentinel could misclassify `Promise.reject(undefined)` as success. A separate RED/GREEN cycle added an explicit `closeFailed` presence flag, so arbitrary rejection values now retain the invalidating phase/listeners and are rethrown.

## Strict TDD evidence

### Listener ownership RED

Command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "detaches every owned listener exactly once before successful Context close returns"
```

Observed before production correction: 1 file failed; 1 test failed and 84 were skipped. The assertion expected Context/CDP inverse removals but `removedListeners` was `[]`. This was the intended missing-cleanup failure.

After the minimal cleanup implementation, the identical command passed: 1 file passed; 1 test passed and 84 were skipped. The combined initial listener contract command then passed 3 tests with 82 skipped.

### Arbitrary rejection RED

Command:

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "retains fail-closed listeners when Context close rejects undefined"
```

Observed before the rejection-presence correction: 1 file failed; 1 test failed and 85 were skipped because the close promise resolved `undefined` instead of rejecting. After adding the explicit presence flag, the identical command passed: 1 file passed; 1 test passed and 85 were skipped.

### Focused behavior proved

- Successful close attempts all seven exact inverse removals once and clears Context/CDP harness handlers.
- A failed Page `download` inverse records exactly one `GUARD_LISTENER_CLEANUP_FAILED`; Page `popup`/`framenavigated`, both Context, and both CDP cleanup attempts still run.
- Re-entering `closePassiveGuardedContext()` after success is rejected and does not retry any cleanup, including the failed inverse.
- Error and `undefined` Context-close rejections perform zero listener removal attempts, retain every fail-closed handler, leave the guard invalidated, and make no second raw close attempt.
- The Safety Ledger snapshot remains unchanged after successful close and a microtask turn, proving no late owned callback mutation in the focused harness.
- Existing successful-invalidation tests were updated from stale manual post-terminal callback invocation to the design-authoritative assertion that callbacks are absent after `CLOSED`. In-progress invalidation still retains and exercises them.

## Verification evidence

An intermediate complete focused run exposed three stale successful-invalidation assertions: 195 tests passed and 3 failed because the tests manually invoked callbacks that the new terminal contract had correctly detached. Systematic root-cause comparison against the successful-close and rejected-close paths showed the expectations were obsolete. Only those terminal assertions/titles were updated; production was unchanged for this correction. The next focused run passed 198/198. The later arbitrary-rejection RED/GREEN added one test, so all final counts below are fresh after the last production edit.

### Final focused and adjacent suites

```powershell
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts
```

Result: exit 0; 6/6 files passed; 199/199 tests passed.

```powershell
npm test -- --run tests/integration/controlled-scroll.test.ts tests/component/performance-collector.test.ts
```

Result: exit 0; 2/2 files passed; 47/47 tests passed.

### Type and build gates

```powershell
npm run typecheck
```

Result: exit 0 (`tsc -p tsconfig.json --noEmit`).

```powershell
npm run build
```

Result: exit 0 (`tsc -p tsconfig.build.json` plus schema copy). The required build refreshed generated `dist/safety/passive-request-guard.js`; its current SHA-256 is `773982DD07C9843A5EA7291AF769F95697975682024A3AAF5BEA575D9C448CE7`.

The npm commands printed an informational npm 12 availability notice. No update command was run.

### Full repository suite

```powershell
npm test
```

Result: exit 0 on the first run; 26/26 files passed; 414/414 tests passed. Vitest did not report a worker exit, so the brief's conditional single retry was neither allowed nor needed.

### S03-S08 maintenance

The final focused and full runs executed the existing real-Chromium fixture-server proofs: external action candidates are mechanically rejected before launch; popup and navigation targets do not reach the server; generated download cancellation is separated from HTTP `/__download` zero delivery; WebSocket upgrade count remains zero; and Service Worker registration observes only the initial fixture page request. Mutation/download/upgrade counters remain zero where asserted. No S03-S08 authority or interaction entry point changed.

### Forbidden-boundary scan

```powershell
rg -n '本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*[''\"]|innerHTML\s*=|setAttribute\(' src
```

Result: `rg` exit 1 with no output, the expected no-match result. No target identity, string evaluation, `innerHTML` mutation, or `setAttribute()` marker was found in `src/**`.

### Final hashes

| Artifact | Entering SHA-256 | Final SHA-256 | Disposition |
|---|---|---|---|
| `src/safety/passive-request-guard.ts` | `D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB` | `5B51E854FD09165BB21CDA5FAAAE10F7587E7B179C31157C426D459D76A9CCDF` | intended production change |
| `tests/integration/passive-request-guard.test.ts` | `6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A` | `5780BDE5F3A00EAF51E16A92AE6B67A1FF054A35E1EA2AAFFC60C6B76513998F` | intended test/harness change |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` | unchanged |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged |

The three owned source/test files remain UTF-8-compatible LF-only (`CR=0`).

## Contract self-review

### Successful owner close

- Phase changes to the matching closing phase before the raw close.
- Raw `context.close()` is invoked once.
- Cleanup occurs only after raw close resolves.
- The cleanup queue is cleared before callbacks run.
- Every cleanup failure is isolated and ledgered; later callbacks still run.
- Stable task drain completes before terminal `CLOSED`.
- Re-entry is rejected without duplicate cleanup.

### Successful safety invalidation

- The previously published invalidation owner remains authoritative.
- Successful raw close detaches the same shared listener set before final drain/`CLOSED`.
- Tests no longer treat a detached post-terminal callback as public behavior.

### Failed owner/invalidation close

- Cleanup is not called.
- Existing Context/CDP/Page handlers remain installed for fail-closed lifecycle handling.
- The invalidating phase is retained and no active phase is restored.
- Ordinary `Error` and `undefined` rejection presence remain distinguishable at this guard boundary.
- Re-entry does not issue a duplicate raw close.

### Tasks 1-4 preservation

No phase vocabulary, invalidation owner publication, task admission/cap, registry cap/retention/identity, request policy, traversal, handle ownership, result finalization, Safety Ledger schema, context factory, or interaction public interface was changed. Final focused/full suites cover those contracts.

## Deferred Minors disposition

The three carried recovery Minors remain deliberately deferred and were not widened into this listener-only implementation:

1. Task 1 lifecycle-phase HTTP abort correlation in `expectedRouteFailures` remains deferred. Listener teardown changes the successful terminal boundary but does not alter route-failure correlation semantics while close is in progress.
2. Task 1 `emitFailedMainFrameRequest()` async-return test-helper cleanup remains deferred. Task 5 updated only the expectations that became invalid after terminal detachment.
3. Task 2 page-guard task-factory indentation cleanup remains deferred. Reformatting that large pre-existing block was outside the exact listener ownership change and would enlarge the review surface.

No new non-blocking implementation concern was identified.

## Remaining controller work / concerns

- The fixed review package, independent specification review, independent code-quality review, `task-11-report.md`, `progress.md`, and mandatory checkpoint decision are intentionally not part of this implementation handoff.
- Local implementation gates have no environment gap. Official/independent review remains pending and this report does not claim Task 11 checkpoint closure.
- No commit was created because all Git operations were prohibited.

---

## Fix round 1 — accepted final-review Guard findings

Date: 2026-08-31  
Scope: the four controller-accepted, related Guard findings only  
Status: implementation and all required local gates pass; final independent review remains controller-owned

### Authority and scope disposition

Before editing, the final specification review (`DFCEDB78401E2BE49748B132B40FF8C9684C7CAB8E2CB2ABD7845D97BBE20F1A`), final quality review (`5AF4F76FD2E320937DD49E5E5CD21FFBE60A46DD1DF2C5963E24EE55FD1499C1`), and approved recovery design §§4–6 (`D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18`) were read completely. The entering implementation hashes matched dispatch:

| Artifact | Fix-round entering SHA-256 |
|---|---|
| `src/safety/passive-request-guard.ts` | `5B51E854FD09165BB21CDA5FAAAE10F7587E7B179C31157C426D459D76A9CCDF` |
| `tests/integration/passive-request-guard.test.ts` | `5780BDE5F3A00EAF51E16A92AE6B67A1FF054A35E1EA2AAFFC60C6B76513998F` |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` |
| this report | `DF2276DC918059C1507FA3D4410242D5F83799CF1E93B03B99E3693AD4B2DEDD` |

The controller ruled the review's `querySelectorAll()`/ancestor concern outside this approved recovery. Design §6 explicitly retains a single `querySelectorAll('*')` snapshot plus bounded indexed `NodeList` access. `src/interaction/discover-candidates.ts` was not modified.

### Per-finding implementation disposition

1. **Drain timeout — fixed.** `drainGuardTasks()` now returns `DRAINED` or `TIMED_OUT`. A guard-owned once flag records `GUARD_PENDING_TASK_DRAIN_TIMEOUT` exactly once. Owner close and safety invalidation retain an invalidating phase and reject with the bounded deterministic `GuardTaskDrainTimeoutError` after a timeout; neither can transition to `CLOSED` or report ordinary success. The published failed completion remains stable, one raw close is issued, and a late task settlement cannot turn re-entry into clean success.
2. **Invalidation-owner join — fixed.** Public Context close now detects `PASSIVE_INVALIDATING`/`FROZEN_INVALIDATING`, requires the already-published completion owner, and awaits that exact owner. Successful invalidation returns only after raw close, listener teardown, and stable owned-task drain. A missing completion owner remains a deterministic invariant error. The racing test proves one raw close and that a deferred listener failure is in the ledger before the joining observer returns.
3. **Bounded listener lifetime ownership — fixed.** The one `listenerCleanups` owner now contains a fixed Context group and a map capped at 64 live Page/CDP groups. Each Page/CDP group owns exactly three Page and two CDP inverses. Guarded Page close and CDP session close delete/release the group; successful Context close or invalidation clears all group ownership before invoking any callback. Cleanup failures remain isolated and ledgered. Partially installed Page/CDP groups are released before invalidation even when raw Context invalidation close fails. At the cap, no Page or CDP listener is installed, one `GUARD_LISTENER_GROUP_LIMIT_REACHED` is recorded, and safety invalidation starts once.
4. **Guard error normalization — fixed.** `errorMessage()` no longer uses `instanceof Error` or object coercion. Primitive cases are explicit; object/function `message` access is guarded; successful text is capped at 2,048 characters; and every unsafe/non-string object case returns the fixed `Guard error could not be safely normalized` fallback without secondary coercion. Hostile proxies with throwing prototype/property/coercion behavior prove task invalidation, cleanup continuation, and enforcement owner-outcome identity are preserved.

### Listener ownership and lifecycle table

| Group | Live bound | Owned exact inverses | Release boundary | Failure behavior |
|---|---:|---|---|---|
| Context | exactly 1 | `context.off('page', onPage)`; `context.off('requestfailed', onRequestFailed)` | successful Context owner close or successful safety invalidation | owner is cleared before callbacks; each failure records `GUARD_LISTENER_CLEANUP_FAILED`; later inverses continue |
| Page/CDP | at most 64 live groups | `page.off('download', onDownload)`; `page.off('popup', onPopup)`; `page.off('framenavigated', onFrameNavigated)`; `session.off('close', onSessionClose)`; `session.off('Fetch.requestPaused', onRequestPaused)` | successful guarded Page close, CDP session close, partial-setup rollback, or successful Context terminal cleanup | map entry and group queue are cleared before callbacks; each inverse is attempted at most once; one failed inverse does not stop the rest |
| Overflow candidate | admitted only below 64 | none at/above cap | immediate fail-close/invalidation | limit ledgered once; no unowned listener set; no duplicate raw close |

Context close rejection still retains the complete fail-closed Context/Page/CDP listener ownership and the invalidating phase. The partial-setup exception releases only an incomplete Page/CDP group that cannot enforce the full contract; the Context group remains installed when invalidation close rejects.

### Strict one-finding-at-a-time TDD evidence

**Finding 1 RED:**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "drain timeout|drain times out"
```

Exit 1: 1 file failed; 2 tests failed and 85 skipped. Owner close resolved ordinary `undefined`, and safety invalidation exposed only the generic invalidated error rather than the stable timeout result. The final identical focused command exited 0 with 2/2 passed and 85 skipped. An intermediate run had both assertions pass but Vitest correctly rejected the run for an asynchronously handled rejection; the test attached its rejection expectation before advancing fake time, after which the run was clean.

**Finding 2 RED:**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "joins a spontaneous invalidation owner"
```

Exit 1: 1 test failed and 87 skipped because the public close observer settled immediately. The identical GREEN command exited 0 with 1/1 passed and 87 skipped.

**Finding 3 RED:**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "cleanup group|group cap|partially installed"
```

Exit 1: 2 tests failed, 1 passed, and 88 skipped. Sequential closed-page churn retained all 140 CDP inverses until Context close, and the 65th live group did not fail closed. The partial-setup test was then strengthened with raw Context-close failure so it could prove rollback independent of terminal Context cleanup. The identical GREEN command exited 0 with 3/3 passed and 88 skipped.

**Finding 4 RED:**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "hostile listener-task|hostile listener-cleanup|hostile enforcement"
```

Exit 1: 3/3 tests failed and 91 skipped. Hostile prototype access prevented invalidation, replaced the cleanup/owner outcome, and stopped later inverses. The identical GREEN command exited 0 with 3/3 passed and 91 skipped.

The combined fix-focus command passed 9/9 tests with 85 skipped.

### Final verification evidence

| Gate | Exact final result |
|---|---|
| Six-file Task 5 focused command | exit 0; 6/6 files; 207/207 tests |
| Adjacent command | exit 0; 2/2 files; 47/47 tests |
| `npm run typecheck` | exit 0; `tsc -p tsconfig.json --noEmit` |
| `npm run build` | exit 0; build TypeScript plus schema copy |
| unscoped `npm test` | exit 0 first run; 26/26 files; 422/422 tests; no worker exit, therefore no retry |
| forbidden-boundary `rg` scan | exit 1, no output/no matches, expected |

The first compile-gate attempt exposed a TypeScript-only missing terminal return in the otherwise exhaustive `typeof` switch. The fixed fallback was added with `apply_patch`; typecheck and build were rerun successfully. The complete six-file focused and adjacent commands were also rerun after that final production edit and produced the counts above. The full suite was already run after that edit.

### Fix-round hashes and package/config audit

| Artifact | Entering SHA-256 | Final SHA-256 | Disposition |
|---|---|---|---|
| `src/safety/passive-request-guard.ts` | `5B51E854FD09165BB21CDA5FAAAE10F7587E7B179C31157C426D459D76A9CCDF` | `D0E521349C5DB3DF5357CBD7658C8029829831765BA177B34DC9CD29A0487943` | intended production correction |
| `tests/integration/passive-request-guard.test.ts` | `5780BDE5F3A00EAF51E16A92AE6B67A1FF054A35E1EA2AAFFC60C6B76513998F` | `3A3A545FDF5614EF07B36CB23114F61686F7CEAEF7FFD9F8FE6ABF1B8FB903AA` | intended test/harness correction |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` | unchanged |
| `dist/safety/passive-request-guard.js` | `773982DD07C9843A5EA7291AF769F95697975682024A3AAF5BEA575D9C448CE7` | `82AA5B616613424F06BE902ADE528E0CCCCB0AEB7552A27CF8CE6F38C3213AE3` | required build output |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | same | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | same | unchanged |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | same | unchanged |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | same | unchanged |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | same | unchanged |

### Path self-review and preserved contracts

- **Successful owner close:** one raw close; exact inverse ownership cleared before callbacks; cleanup failures continue; stable-set drain must report `DRAINED` before `CLOSED`; re-entry cannot repeat cleanup.
- **Owner drain timeout:** one raw close; listeners already detach only after raw close succeeds; timeout ledgered once; phase remains invalidating; the stable owner completion rejects on every observer even after late task settlement.
- **Successful safety invalidation:** the owner is published before side effects; public close joins it; successful raw close detaches listeners; stable drain captures all already-owned evidence before `CLOSED` and observer return.
- **Safety-invalidation timeout/failure:** timeout rejects deterministically and cannot become `CLOSED`; failed raw close retains complete fail-closed listeners and invalidating phase.
- **Page/session terminal lifecycle:** successful guarded Page close or CDP session close deletes the Page/CDP group before any inverse callback; later Context cleanup has no duplicate work.
- **Overflow/partial setup:** cap overflow admits no listeners and initiates safety closure once; incomplete setup rolls back every successfully registered inverse without depending on raw Context close success.
- **Hostile errors:** no prototype test, name access, or object coercion occurs; a throwing `message` access becomes a fixed fallback; the original enforcement rejection remains the caller-visible owner outcome.
- Tasks 1–4 phase/invalidation/task ownership, capped registries, redirect traversal, all-node candidate traversal, Handle identity, and result finalization were not widened. S03–S08 and both interaction entry points remain unchanged and passed in the full/focused suites.

The three previously deferred recovery Minors retain exactly their prior disposition: lifecycle-phase HTTP abort correlation, async-return cleanup in `emitFailedMainFrameRequest()`, and the pre-existing Task 2 page-guard task-factory indentation are not part of this accepted fix round. No new deferred Minor was introduced.

### Constraints and remaining concern

No Git operation, dependency/package operation, download, live-target access, subagent, Task 12 work, baseline/review/progress mutation, or final review-package creation occurred. The controller-owned final independent specification/quality re-review and mandatory checkpoint remain pending. There is no local test or environment concern; this report does not claim the independent checkpoint is closed.

---

## Fix round 2 — production factory join, overflow containment, rollback, and related Minors

Date: 2026-08-31  
Scope: the four controller-accepted Fix round 1 re-review issues only  
Status: implementation and all required local gates pass; independent re-review remains controller-owned

### Review authority and entering state

The Fix round 1 specification re-review (`0A7A7BAF23E40FDCD84A12BE0407B11A5E11BFBF0D9743B0F2D19AA147321BD0`) and quality re-review (`BDD536772F31DA48D734DB877E03CC3FF2010B514451DFD5ABB4BF12749B8802`) were read completely before editing. Their accepted findings were checked against the real factory/session path and current Guard implementation rather than implemented from review prose alone.

| Artifact | Fix-round entering SHA-256 |
|---|---|
| `src/safety/passive-request-guard.ts` | `D0E521349C5DB3DF5357CBD7658C8029829831765BA177B34DC9CD29A0487943` |
| `src/browser/context-factory.ts` | `359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A` |
| `tests/integration/passive-request-guard.test.ts` | `3A3A545FDF5614EF07B36CB23114F61686F7CEAEF7FFD9F8FE6ABF1B8FB903AA` |
| `tests/component/context-factory.test.ts` | `8BE9A65549A1EC73CB2EEA7A40F4F6E9A0C33E18A9E987DF3CBA826FC28B94D0` |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` |
| this report | `E5B53A6949B929A4FF89341260211D5B3AF4457EE73C80163ADEC336D33EB851` |

`src/interaction/discover-candidates.ts`, the approved querySelector/NodeList ruling, historical baselines/reviews, controller progress, and the final review package were not modified.

### Accepted-issue dispositions

1. **Production factory/session invalidation join — fixed.** `BrowserContextFactory.closePassiveContext()` now requires factory ownership but does not demand an active low-level Guard phase before calling `closePassiveGuardedContext()`. An owned invalidating Context therefore reaches the Guard's published-owner join. Factory ownership is deleted only in the existing `finally` after that join returns or rejects. The integration test uses the real `BrowserContextFactory`, real `InteractionGuardedSession.close()`, installed Chromium, and a local fixture HTTP load; a spontaneous CDP-session invalidation races a deferred Download cancellation. Session close stays pending until the cancellation rejection is ledgered, returns through the same invalidation owner, and observes one raw Context close.
2. **Overflow reserved-slot rejection containment — fixed.** `beginOverflowInvalidationOnce()` still stores the `.finally()`-derived reserved-slot promise and still clears the slot in `finally`. A terminal catch is now attached only to that derived promise. The shared rejecting `GuardState.invalidationCompletion` is unchanged, so public close continues to observe the stable timeout failure. With 256 never-settling admitted tasks plus one denied overflow task, the regression records no process `unhandledRejection`, records the task limit and drain timeout once each, makes one raw close, keeps invalidating, and returns the same public timeout failure on re-entry.
3. **Readiness-admission rollback — fixed.** When `ensurePageGuard()` cannot admit its readiness task after the Page listener group has been reserved and its three handlers installed, it now calls `releasePageListenerGroup()` before publishing the readiness rejection. Overflow invalidation was already initiated synchronously by task admission; the release therefore happens before its raw-close side effect. The regression makes invalidation close reject and all 256 admitted tasks time out, proving the denied Page's `download`, `popup`, and `framenavigated` inverses run exactly once, no second CDP session is constructed, readiness rejects, one raw close occurs, and public re-entry neither retains nor retries the group. Existing partial CDP listener-setup and successful/failed terminal cleanup tests remain green.
4. **Two related Minors — closed.** `abortUnreadyNavigation()` now has an explicit `abortFailed` presence flag, so `Promise.reject(undefined)` is ledgered, invalidation completes, and the original `undefined` rejection is rethrown. Guard error normalization now maps every bigint directly to the existing fixed bounded fallback without calling `String()`; the `2n ** 1_000_000n` regression preserves the original owner outcome while proving no decimal text reaches the ledger.

### Strict TDD evidence

**Factory/session join RED/GREEN**

```powershell
npm test -- --run tests/component/context-factory.test.ts -t "joins an already-published invalidation"
```

After correcting the test setup to establish the design-required initial HTTP(S) load through the local fixture server, RED exited 1: 1 test failed and 11 skipped because `InteractionGuardedSession.close()` settled before the deferred evidence cutoff. The identical GREEN command exited 0: 1/1 passed and 11 skipped.

**Overflow reserved slot RED/GREEN**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "contains the reserved overflow owner"
```

RED exited 1: 1 test failed and 93 skipped; the process observer captured one unhandled `GuardTaskDrainTimeoutError`. The identical GREEN command exited 0: 1/1 passed and 93 skipped.

**Admission rollback RED/GREEN**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "rolls back a Page listener group"
```

The harness was first corrected so the 256 scheduled tasks gate `Fetch.failRequest`, the command they observe after synchronous overflow invalidation, rather than the pre-invalidation `Fetch.continueRequest` branch. The resulting genuine RED exited 1: denied-Page inverse removals were `[]` rather than the three exact Page events; 1 test failed and 94 skipped. The identical GREEN command exited 0: 1/1 passed and 94 skipped.

**Undefined abort RED/GREEN**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "preserves an undefined abort rejection"
```

RED exited 1: the handler returned `RESOLVED` instead of `REJECTED_UNDEFINED`; 1 test failed and 95 skipped. The identical GREEN command exited 0: 1/1 passed and 95 skipped.

**Huge-bigint RED/GREEN**

```powershell
npm test -- --run tests/integration/passive-request-guard.test.ts -t "normalizes a huge bigint rejection"
```

RED exited 1: the ledger contained the first 2,048 decimal digits rather than the fixed normalization fallback; 1 test failed and 96 skipped. The identical GREEN command exited 0: 1/1 passed and 96 skipped.

The combined two-file Fix round 2 focus exited 0 with 2/2 files, 5/5 tests passed, and 104 skipped.

### Required final verification

| Gate | Exact result |
|---|---|
| Six-file Task 5 focused command | exit 0; 6/6 files; 211/211 tests |
| Adjacent command | exit 0; 2/2 files; 47/47 tests |
| `npm run typecheck` | exit 0; `tsc -p tsconfig.json --noEmit` |
| `npm run build` | exit 0; build TypeScript plus schema copy |
| unscoped `npm test` | exit 0 on first run; 26/26 files; 426/426 tests; no worker exit, so no retry |
| forbidden-boundary scan | `rg` exit 1 with no output/no matches, expected |

The npm commands printed only the informational npm 12 availability notice; no package operation was run.

### Fix-round final hashes

| Artifact | Entering SHA-256 | Final SHA-256 | Disposition |
|---|---|---|---|
| `src/safety/passive-request-guard.ts` | `D0E521349C5DB3DF5357CBD7658C8029829831765BA177B34DC9CD29A0487943` | `9DB463B3EC0282A4CD76E720178A67C3E5B27DB0F2321A56A2C8C2CB24D5FF55` | intended Guard fixes |
| `src/browser/context-factory.ts` | `359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A` | `ED97E9EA64E4EFE736B4BFC2C43EA2DC729A6EB33D97D832EFAD28D1A778C632` | intended production join fix |
| `tests/integration/passive-request-guard.test.ts` | `3A3A545FDF5614EF07B36CB23114F61686F7CEAEF7FFD9F8FE6ABF1B8FB903AA` | `8E7A30BF0EAF4DA1CE1DBFD1F46055BAE47C79C9D3D19148DE85E22CCA00F941` | intended Guard/harness regressions |
| `tests/component/context-factory.test.ts` | `8BE9A65549A1EC73CB2EEA7A40F4F6E9A0C33E18A9E987DF3CBA826FC28B94D0` | `8E5F4426F6A562C34AB0CFA1D02DF126C23A53B15E2AE6DAFCD6975540939813` | intended production factory integration test |
| `tests/integration/isolated-interaction.test.ts` | `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B` | same | unchanged |
| `dist/safety/passive-request-guard.js` | prior Fix round 1 final `82AA5B616613424F06BE902ADE528E0CCCCB0AEB7552A27CF8CE6F38C3213AE3` | `DF302C75FEA9CDF7C9E53CE0956278926F8ADB8F9F5CE80F65DB040D84FC7BA3` | required build output |
| `dist/browser/context-factory.js` | not part of the dispatch hash set | `0456FF9C9D10CDD3AF5268CA045619DE85D1639FCCCA7991084DF5175C8EED10` | required build output |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | same | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | same | unchanged |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | same | unchanged |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | same | unchanged |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | same | unchanged |

### Preserved contracts, deferred Minors, and concerns

The single low-level phase/close owner, shared rejecting invalidation completion, task and registry bounds, bounded listener cleanup groups, traversal/Handle identity, Task 4 result finalizer, S03–S08, packages/config, and both interaction entry points remain unchanged. Factory ownership is neither widened to foreign Contexts nor removed before a joining owner completes.

The three deliberately carried historical Minors remain deferred exactly as before: lifecycle-phase HTTP abort correlation in `expectedRouteFailures`, the async-return cleanup of `emitFailedMainFrameRequest()`, and the pre-existing page-readiness task-factory indentation. This round closes only the two newly accepted related Minors (`undefined` abort presence and bigint conversion).

No Git operation, dependency/package operation, download, live-target access, subagent, Task 12 work, baseline/review/progress mutation, or final review-package creation occurred. There is no local environment or implementation concern. Controller-owned independent re-review and mandatory checkpoint closure remain pending.

## Fix round 4 — lifecycle priority and terminal ownership (2026-09-20)

Binding authority: `task-11-recovery-user-lifecycle-priority-brief.md`, verified SHA-256 `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718`. All five dispatch baseline hashes matched before edits. The incoming Fix round 3 state remains unreviewed; this report does not approve it. The binding user brief supersedes the earlier design's prohibition on necessary factory changes and the plan's Git/progress/dispatch procedures. Only this implementer report is updated.

### Mandatory RED, recorded before production edits

Command: `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts -t "lifecycle priority"`.

First attempt: sandbox Chromium launch `spawn EPERM`; 2 suites failed before tests, 71 skipped, with the existing component afterAll also reporting undefined browser.close. This is an environment attempt, not RED. The identical command was retried with standard sandbox escalation against installed Chromium. No dependency operation occurred.

Genuine RED: exit 1; 2 files failed; 3 failed, 68 skipped (71). Exact failures:

1. `lifecycle priority rejects the mutation that drops invalidation during close after VERIFIED work`: `AssertionError: expected 'VERIFIED' to be 'BLOCKED_BY_SAFETY' // Object.is equality` at isolated-interaction.test.ts:1250.
2. `lifecycle priority rejects the mutation that lets normal close win only when it starts first`: `AssertionError: expected 'VERIFIED' to be 'BLOCKED_BY_SAFETY' // Object.is equality` at isolated-interaction.test.ts:1267.
3. `lifecycle priority rejects premature factory ownership deletion and session closed mutation after failed invalidation close`: expected two `Passive request guard context was invalidated` outcomes; received `Interaction owner session was already closed` and `BrowserContext is not owned by this factory or is no longer active` at context-factory.test.ts:320.

The first two tests use real factory sessions, discovery, auditInteraction, click/evidence/finalization, and installed local Chromium. A raw-close gate and a Playwright requestfailed boundary event expose the ordering race without recording a freeze event. The third uses repeated real freeze activation to invalidate, with rejection only at raw Context close. Every test names the production mutation it catches. No production source was edited before these three assertions failed.

### Root-cause trace and implementation

1. `auditInteraction()` had already established VERIFIED work and changed evidence when its real session owner began close. The Guard entered FROZEN_CLOSING. A real installed requestfailed handler then found an unclassifiable navigation frame, recorded FRAME_CLASSIFICATION_FAILED, and called `invalidateContext()`.
2. The closing-phase early return discarded that invalidation request. Raw close and drain succeeded, the phase became CLOSED, session close fulfilled, and the unchanged finalizer preserved VERIFIED because no freeze event or owner-close rejection existed. Reversing the ordering entered FROZEN_INVALIDATING first and made public close reject. This accounts for both the leak and the order dependence.
3. Normal close now publishes its drain-completion owner before the raw close side effect. An invalidation arriving during either closing phase synchronously promotes it to the corresponding invalidating phase and joins that same completion. The reserved overflow path also delivers its invalidation during closing instead of silently returning. Neither path issues another raw close.
4. After raw close succeeds, listener cleanup and the bounded stable drain finish before CLOSED. The normal-close caller captures the final invalidating phase before terminal transition and rejects with the existing deterministic invalidation outcome. The finalizer consequently returns BLOCKED_BY_SAFETY with the VERIFIED work evidence and final Safety Ledger intact. The finalizer itself was not changed.
5. Factory `finally` previously deleted ownership even after non-terminal raw failure, and session close marked itself closed before its first await. The factory now asks the Guard's production `isPassiveRequestGuardClosed()` query before deletion; the session similarly marks itself closed only after terminal confirmation. This read-only cross-owner query is used by production ownership cleanup, not exported for test inspection or as a second interaction entry point.
6. Tracing every factory ownership deletion exposed the same defect in Page readiness and guarded Page close failure catches. Those catches now retain Context ownership unless terminal close is confirmed; readiness cleanup goes through the factory's existing guarded close owner. Guard admission still rejects reuse of every closing/invalidating Context.

Additional genuine RED before production edits: `npm test -- --run tests/component/context-factory.test.ts -t "lifecycle priority retains"` exited 1; 2 failed, 14 skipped (16). Both PAGE_CLOSE and PAGE_READINESS variants expected `Passive request guard context was invalidated` from later factory owner calls but received `BrowserContext is not owned by this factory or is no longer active` (context-factory.test.ts:365). These tests specifically catch either page-failure catch deleting the non-terminal Context owner. They use real factory/Guard operations and inject failures at Playwright Page close/CDP setup/raw Context close boundaries.

### Ownership and phase transitions

| Starting phase | Event | Phase and raw-close ownership | Public close result / factory-session ownership |
|---|---|---|---|
| PASSIVE_ACTIVE / FROZEN_ACTIVE | Normal owner close | Corresponding CLOSING; completion published before exactly one raw close | Waits for raw close, owned listener cleanup, and stable drain |
| PASSIVE_CLOSING / FROZEN_CLOSING | Safety invalidation, including overflow | Corresponding INVALIDATING; joins the existing completion; no second raw close | After successful close/drain, CLOSED plus invalidation rejection; terminal ownership released |
| PASSIVE_ACTIVE / FROZEN_ACTIVE | Safety invalidation first | Corresponding INVALIDATING; existing invalidation owner issues exactly one raw close | A public owner call joins it; successful close/drain reaches CLOSED and returns the same invalidation rejection |
| Either INVALIDATING | Raw Context close fails | Remains INVALIDATING; fail-closed listeners retained; stable task drain still runs | Factory retains ownership and session remains retryable; later calls join the recorded completion and return invalidation, without another raw close |
| Either CLOSING | Raw Context close fails | Corresponding INVALIDATING; original rejection preserved, including undefined | Factory retains ownership; initiating caller receives original failure, later owner joins remain fail-closed |
| Closing / invalidating | Task drain times out | INVALIDATING retained; one bounded drain-timeout invariant and shared rejecting completion | No clean success or terminal ownership release; later calls observe the existing failure |
| Either CLOSING | Raw close and drain succeed with no invalidation | CLOSED after listener cleanup and empty stable task set | Normal success; factory/session ownership released |

Here retry means a later owner call can rejoin the established fail-closed completion. It does not retry the interaction, issue a second raw close, or assert that a failed raw close physically terminated the Context. The phase remains the sole lifecycle authority. Completion promises own waiting and rejection observation, not an independent lifecycle status.

### GREEN and regression evidence

All browser commands after the initial EPERM used the permitted escalation and already-installed Chromium with local fixtures. No setup/test changes were needed to obtain the three mandatory REDs. Commands and exact results:

| Command | Result |
|---|---|
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts -t "lifecycle priority"` | First GREEN after production correction: exit 0; 2 files; 5 passed, 68 skipped (73) |
| `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts` | First broad run: exit 1; 4 failed, 166 passed (170); see exact disposition below |
| Same three-file command after updating the four superseded success expectations | exit 0; 3/3 files; 170/170 tests |
| `npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts` | exit 0; 6/6 files; 219/219 tests |
| `npm test -- --run tests/integration/controlled-scroll.test.ts tests/component/performance-collector.test.ts` | exit 0; 2/2 files; 47/47 tests |
| `npm test` | exit 0 on first full-suite run; 26/26 files; 434/434 tests; no worker exit and no retry |
| `npm run typecheck` | exit 0 both initial and final runs; strict TypeScript check |
| `npm run build` | exit 0 on first run; TypeScript compilation and existing schema-copy step |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts -t "lifecycle priority rejects"` | Final exact mandatory checkpoint: exit 0; 2 files; 3 passed, 70 skipped (73) |

The four broad-run failures all threw `Error: Passive request guard context was invalidated` from the corrected end of normal close. Their names were `drains a deferred download-cancel rejection before guarded context close returns`, `drains a deferred popup-close rejection before guarded context close returns`, `does not let a mismatched failure consume a lifecycle correlation record`, and `does not let an expired lifecycle correlation suppress a later matching failure`. Each intentionally causes safety invalidation during a pending close or its drain. The binding priority correction supersedes their old successful-close expectation. Only `await closing` became `await expect(closing).rejects.toThrow('Passive request guard context was invalidated')`; their existing bounded-drain, late-evidence, exact-correlation, and raw-close assertions remain. No production change was made in response to these four failures. This is a disclosed contract-expectation update, not an environment retry or evidence deletion.

The focused and full runs preserve S03–S08 real fixture-server zero-delivery assertions for external actions, navigation/popups, mutation/download requests, WebSocket upgrades, and Service Worker activity. Candidate discovery, Handle identity/disposal, deadline authority, work/freeze/error precedence, and immutable result evidence remain covered by the unchanged maintained tests. Npm printed its informational update notice; it was ignored.

### Boundary and type-escape scans

`rg -n '本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*[''\"]|innerHTML\s*=|setAttribute\(' src` exited 1 with no matches (expected).

`rg -n '\bas\s+any\b|:\s*any\b|<any>|as unknown as|@ts-ignore|@ts-expect-error|@ts-nocheck' src/safety/passive-request-guard.ts src/browser/context-factory.ts src/interaction/isolated-auditor.ts src/interaction/discover-candidates.ts` exited 1 with no matches (expected). The same scan across all `src` found only the pre-existing schema-validated cast at `src/config/validate-config.ts:120` (`input as unknown as AuditConfig`); that file was not changed. An initial broad `\bany\b` scan matched only the English word “any” in the existing before-pages installation error message; no type escape was introduced.

### Changed files and SHA-256 checkpoint

Source changes are limited to Guard lifecycle/completion handling and factory/session terminal ownership. Test changes are the five named regressions plus the four updated closing-result assertions. This report is append-only. Required build outputs are also listed. Unchanged authorities are explicitly identified.

| Artifact | Final SHA-256 | Disposition |
|---|---|---|
| `src/safety/passive-request-guard.ts` | `54B5A1272E21A9508B1305DA8A0A5E93E586BB76EFFA2384DEBE362687B17C28` | changed from verified dispatch `09BFCA669E62D5CF0D1EE9B3FC9A83F0512F86716D20A21197F9712234DF6A8E` |
| `src/browser/context-factory.ts` | `F836BA9A3353CC7B70F59060AE3BD1D717F1ED3CC79CE7556DB3D812D1A51CB8` | changed from verified dispatch `ED324497E7DDA358868D7C01D71926CD0DFA2A548E2EE7BCECCB936FA3350282` |
| `tests/integration/passive-request-guard.test.ts` | `7D41F62126A4F25EC9F453E78976FC43668039AD4506374D72429AA77A0A2ADE` | changed from verified dispatch `BA37461400CA78A0C91B9EBFF36434A97DAE1C552290553B86738B5C954F842C` |
| `tests/component/context-factory.test.ts` | `350C5E1DF4F5F1E18117C93501D2B73F9C2DDB021FCB77D5A003CF6C3036FA9F` | changed from verified dispatch `6EF2E190220B5B7E56C1C8BAE6E714B5E9AB39D4CF22EEFDEDD0798DAE0CFE8D` |
| `tests/integration/isolated-interaction.test.ts` | `FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20` | changed from verified dispatch `D55D612B9C514F3B8115975AC5F82BD00648A809C4524FB4067BAAF2B4EC4BF3` |
| `dist/safety/passive-request-guard.js` | `D6626E771156BE6F58506B67BC600C03F4CF3901F7EFC522E2160EEEF3EFA8D1` | required build output |
| `dist/browser/context-factory.js` | `909E499BE1F1CA5A6A6234240F6F6DEB49A93A5A65431F4704CE95C057C3BEC2` | required build output |
| `src/interaction/isolated-auditor.ts` | `DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814` | not edited |
| `src/interaction/discover-candidates.ts` | `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1` | not edited |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged |
| Recovery design | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` | unchanged |
| Recovery implementation plan | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` | unchanged |
| Binding lifecycle-priority brief | `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718` | unchanged |

The final whole-report SHA-256 is calculated after this append and supplied in the implementer handoff, avoiding a self-referential hash inside the file it hashes.

### Self-review and deferred-Minor disposition

- Mandatory priority/order/ownership defects have genuine RED and GREEN evidence. Mutating the closing invalidation branch back to an early return breaks both audit tests; restoring unconditional factory deletion or early session.closed breaks the ownership test; restoring either page-failure ownership deletion breaks its parameterized regression.
- Terminal confirmation belongs to the Guard. Factory active-only operations still consult that Guard; retention never makes an invalidating Context reusable. Foreign Context rejection remains covered. Failed raw close retains the exactly-once completion and enforcement listeners. Completion is published before side effects and its rejection is observed.
- Raw-close cardinality, frozen evidence during teardown, bounded stable drain, timeout rejection, listener-group rollback/cleanup, original undefined/hostile failures, and previous result preservation remain green. The changed normal-close result reflects actual safety invalidation through the existing finalizer rather than adding an alternate result path.
- Historical Minors remain deferred: lifecycle-phase HTTP abort correlation in `expectedRouteFailures`; async-return cleanup of `emitFailedMainFrameRequest()`; pre-existing page-readiness task-factory indentation. The prior two related Minors (undefined abort presence and huge-bigint normalization) remain fixed. No deferred-Minor work was added in this round.
- No Git operations or commits, dependency installation/update/download/import, live-target access, subagents, Task 12 work, or edits to controller-owned reviews/packages/progress occurred. No code/test failure remains from the executed gates. This is the implementer's DONE checkpoint only; independent review and Task 11 approval remain controller-owned and pending.

## Fix round 5/5 — construction ownership and protocol callback cutoff (2026-09-20)

Status: DONE for the implementation and required local verification. Task 11 approval remains controller-owned and pending; Task 12 was not started. No Git operation or commit was performed.

### Binding authority, baseline verification, and scope

Before any edit, the round 5 brief, both round 4 reviews, lifecycle-priority brief, and the entire existing Task 5 report were read, and their SHA-256 values matched:

| Authority | Verified SHA-256 |
|---|---|
| `task-11-recovery-fix-round-5-brief.md` | `E269E1DD349C825038989063718810E2A2E5A4218CA092F90917734D88DA300D` |
| `task-11-architecture-recovery-fix-round-4-spec-review.md` | `F35E38C7137531776EEDE92436E7D51EB1A93611B518B0E449B9DD6646A80B8A` |
| `task-11-architecture-recovery-fix-round-4-quality-review.md` | `0F6C699B016A54D50806C89E59453FA1ED018C1964F848035158897F3B179867` |
| `task-11-recovery-user-lifecycle-priority-brief.md` | `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718` |
| This report, before this append | `679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA` |

All five source/test dispatch hashes matched before editing: Guard `54B5A1272E21A9508B1305DA8A0A5E93E586BB76EFFA2384DEBE362687B17C28`; factory `F836BA9A3353CC7B70F59060AE3BD1D717F1ED3CC79CE7556DB3D812D1A51CB8`; Guard tests `7D41F62126A4F25EC9F453E78976FC43668039AD4506374D72429AA77A0A2ADE`; factory tests `350C5E1DF4F5F1E18117C93501D2B73F9C2DDB021FCB77D5A003CF6C3036FA9F`; isolated-interaction tests `FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20`. The report baseline was rechecked immediately before this append and still matched.

The systematic-debugging, strict TDD (including writing-good-tests), and verification-before-completion instructions were read and applied. No dependency install/update/download/import, live-target access, subagent dispatch, Git operation, discovery change, controller review/package/progress mutation, or Task 12 work occurred. All browser execution used already-installed Chromium and local fixtures. Source/test/report edits used `apply_patch`; the required build regenerated existing outputs.

### Root-cause trace and coherent correction

1. **Construction owner reachability.** Factory ownership was recorded only after Guard installation fulfilled. Failed installation followed by failed invalidation raw close left an INVALIDATING Context without a reachable owner. Session construction had the analogous gap after Page-readiness rejection: a private WeakSet entry existed, but no Context or session reached the caller. Ownership now registers immediately after `newContext()` returns. When construction rejects, the factory queries the Guard's existing terminal predicate: terminal installation failure releases ownership and preserves the original throw; non-terminal failure throws the frozen `ContextConstructionError` carrying the Context and original failure through standard `cause`. Failed session construction uses the same error and the same factory close/join API. Nothing retries raw close.
2. **Readiness failure information.** Real Chromium can emit Page readiness failure before `newPage()` returns. The later readiness check then previously threw only a generic invalidated error. The check now preserves that established message and attaches the already-rejected readiness error as its standard `cause`. The construction error consequently retains the full protocol failure chain. No readiness failure reactivates a Context or bypasses the phase gate.
3. **Fire-and-forget event rejection.** The async `requestfailed` listener directly awaited a rejecting invalidation Promise. Its own rejected Promise was separate from the shared owner completion, so observing public close did not contain it. `initiateInvalidation()` now returns its already-contained completion view, and the listener awaits that view. The listener still waits through completion (including re-entrant raw-close events), but cannot leak the expected timeout rejection. Public close still joins the original rejecting completion. The installation-phase `onPage` branch now uses this same contained initiator. Other CDP/Page/download/popup initiators already used this discipline; none was changed to await its own task drain.
4. **Protocol callbacks missing from drain.** HTTP fallback/abort and WebSocket close callbacks were asynchronous work outside `pendingTasks`. Raw close could succeed, close could publish CLOSED, and only then would a protocol rejection add an invariant. Both route entry points now use `runGuardProtocolTask()` and the same capped admission predicate as existing Guard tasks. Their protocol handling, error normalization, and evidence recording remain owned through settlement.
5. **Self-drain prevention and invalidation priority.** A route body marks a local invalidation request; it never awaits invalidation while tracked. The owned task's `finally` removes its Promise and synchronously initiates invalidation afterward. Only the untracked public callback continuation can await the shared completion. Thus closing-to-invalidating promotion happens before a draining owner can become terminal, with no cycle and no second raw close. Original HTTP rejections, including undefined, remain caller-visible after cleanup; unexpected callback errors receive a bounded task invariant and also request invalidation. Every WebSocket close failure requests invalidation, including a callback that began in PASSIVE_ACTIVE and failed during close.
6. **Atomic final cutoff.** Refusing admission immediately after raw close would break existing frozen enforcement while admitted tasks still drain. Instead `drainGuardTasks()` invokes its terminal callback synchronously at the final empty-set observation. Normal close captures invalidation priority and changes to CLOSED there only when raw close succeeded; invalidation likewise changes to CLOSED there only after successful raw close. No await exists between that final empty-set observation and CLOSED. Protocol callbacks may still enter during non-terminal drain under the shared cap and current phase policy; CLOSED refuses admission and performs no protocol/evidence work.

The correction stays within the Guard/factory ownership layer. The audit finalizer, interaction result schema, discovery traversal, identity/disposal, request policy, Safety Ledger, and configuration authorities were not edited.

### Construction-owner API contract

`ContextConstructionError extends Error` is exported from the existing factory module. It has `readonly context: BrowserContext`, `override readonly cause: unknown`, a fixed error name/message, and a frozen instance. It carries no close function, phase, retry flag, mutable status, independent completion, or alternate lifecycle transition. Its only purpose is making the already-factory-owned Context reachable when no normal construction result can be returned.

The caller retains its existing `BrowserContextFactory` and uses `factory.closePassiveContext(error.context)` to join cleanup. `getSafetyLedger(error.context)` remains available; active-only operations remain rejected by the Guard. The frozen error cannot have its Context or cause reassigned. The referenced Context remains the live canonical Context; freezing the error does not freeze Playwright itself. The constructor error does not become a second lifecycle authority: GuardState.phase remains the only phase, and all joins go through the unchanged factory/Guard close path. The error contains the failure from the rejected construction; readiness's pre-existing invalidated error additionally preserves the original readiness rejection as `cause`.

When Guard installation has already reached CLOSED, creation still rejects with the original error, deletes active ownership and its installation-only ledger registration, and produces no construction-owner wrapper. Successful construction return shapes remain unchanged. Session-construction failure after a terminal close likewise rethrows the original failure. The two new real-factory tests obtain their usable Context solely from the rejected construction and rejoin it twice without another raw close.

### Mandatory RED before production edits

All seven new tests were added before changing either production source file. Command:

```powershell
npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "round 5"
```

First attempt: exit 1; 2 suites failed before tests; 120 skipped. Installed Chromium could not launch inside the sandbox (`browserType.launch: spawn EPERM`); existing afterAll hooks then reported undefined `browser.close`. This was an environment attempt, not behavioral RED. The identical command was rerun with standard sandbox escalation, without changing tests or production.

Genuine RED: exit 1; **2 failed files; 7 failed, 113 skipped (120)**. Exact assertion outcomes against unchanged production:

| New test / production mutation killed | Exact RED outcome |
|---|---|
| `round 5 construction ownership rejects an unreachable non-terminal owner after GUARD_INSTALLATION fails` — registration after installation or throwing without the retained Context | Expected `{ name: 'ContextConstructionError', context: Any<Object>, cause: Error('round 5 GUARD_INSTALLATION failed') }`; received only `Error: round 5 GUARD_INSTALLATION failed` (factory test line 150) |
| Same construction test, `PAGE_READINESS` — session construction discards its retained owner | Expected the construction-owner error; received only `Error: Passive request guard context was invalidated` (factory test line 150) |
| `round 5 event ownership contains failed-request invalidation without changing the public timeout` — listener directly awaits rejecting invalidation | `AssertionError: expected [ GuardTaskDrainTimeoutError { message: 'Guard-owned listener tasks did not settle before cleanup deadline', name: 'GuardTaskDrainTimeoutError' } ] to deeply equal []` (Guard test line 2447) |
| `round 5 protocol ownership drains a pending HTTP callback before terminal close and final evidence` — fallback callback omitted from owned drain / callback self-awaits invalidation | `AssertionError: expected true to be false // Object.is equality` for `settledBeforeProtocol` (Guard test line 2486) |
| Same pending callback test, `WEBSOCKET` — close callback omitted from owned drain / callback self-awaits invalidation | Same `expected true to be false` for `settledBeforeProtocol` (line 2486) |
| `round 5 protocol ownership bounds HTTP admission and rejects terminal callbacks without delivery` — route bypasses shared cap or terminal admission check | `AssertionError: expected 257 to be 256 // Object.is equality` for `callsAtOverflow` (Guard test line 2534) |
| Same admission test, `WEBSOCKET` — route bypasses shared cap or terminal admission check | Same `expected 257 to be 256` (line 2534) |

The event test already established identical public timeout object identity on later join, one raw close, and non-terminal phase before failing the zero-unhandled assertion. The pending-protocol tests capture settlement/phase while the operation is held, then reject it and require invalidation rather than timeout, final invariant evidence, terminal state, one raw close, and a stable subsequent ledger snapshot. They therefore detect both omitted ownership and self-drain. The admission tests hold 256 real Guard callbacks at Playwright protocol methods, invoke an overflow callback, then require no 257th operation, one raw close, one cap invariant, zero WebSocket server connections, and no operation or ledger mutation from a saved callback invoked after CLOSED. Fakes/gates remain at Playwright boundaries; Guard/factory behavior is real.

### GREEN, intermediate failures, and retry disclosure

The identical seven-test focus first passed after the initial ownership correction: exit 0; 2 files; **7 passed, 113 skipped**. The first complete three-file run then exposed **6 failures, 171 passes (177)**. They were investigated rather than hidden or blanket-updated:

- `keeps frozen invalidation enforcement active until its owned task drains, then remains terminal`: `expected [] to have a length of 1 but got +0`. Initial refusal after raw close was too early. Admission now follows the Guard phase and the terminal transition is atomic with the empty drain; the test's during-drain enforcement assertion is unchanged.
- `publishes a re-entrant invalidation waiter before the first context close side effect`: `expected true to be false` for the re-entrant observer. An initially synchronous listener removed the existing completion wait. The final async listener awaits the contained initiation view; all original waiting/raw-close assertions remain unchanged.
- `rolls back a Page listener group when its readiness task admission is denied`: expected `/invalidated/i`, received `Passive request guard task admission was denied`.
- The three `invalidates and rejects readiness when ... setup fails` variants (`newCDPSession`, `Page.getFrameTree`, `Fetch.enable`): expected `/invalidated/i`, received the respective original setup error. The final readiness correction preserves the existing invalidated message and adds the original error via standard `cause`; these four prior tests were not modified.

After those source corrections, command `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "round 5|keeps frozen invalidation|publishes a re-entrant|rolls back a Page|invalidates and rejects readiness"` returned **1 failed, 12 passed, 107 skipped (120)**. Its sole remaining assertion was the terminal half of the first test: `expected +0 to be 1` for an artificial HTTP callback invoked after CLOSED. The new brief explicitly requires stopping terminal admission. Its one expectation changed from one abort to zero aborts, with an explanatory comment: sending an asynchronous abort after CLOSED could itself produce evidence after the cutoff. All during-drain freeze evidence, terminal rejection, and raw-close behavior remain asserted. This is the only changed pre-existing test assertion.

The new construction test's readiness cause assertion was refined to verify the complete standard cause chain instead of requiring removal of the pre-existing generic readiness error. It still requires immutable reachable Context ownership, exact original protocol-error identity in that chain, two valid factory joins, rejected active reuse, the invalidation-failure ledger event, and one raw close. The originally recorded missing-owner RED remains genuine.

The complete three-file rerun then passed **177/177**. The final later source edit made `ContextConstructionError.cause` readonly in its TypeScript surface and clarified the overflow comment; subsequent formatting indented only the newly wrapped route bodies. The deferred Page-readiness task-factory indentation was not changed. Final combined focus, build, typecheck, and the full suite ran after the final source formatting. No test was retried for nondeterminism or a worker exit. The only environment retry was the initial authorized Chromium launch escalation. Informational npm update notices were ignored; no update operation ran.

### Required verification commands and exact outcomes

| Command | Result |
|---|---|
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts -t "round 5"` | First GREEN: exit 0; 2/2 files; 7 passed, 113 skipped (120) |
| `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts` | Corrected full run: exit 0; 3/3 files; 177/177 tests |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/isolated-interaction.test.ts -t "lifecycle priority"` | exit 0; 2/2 files; 5 passed, 70 skipped (75) |
| `npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/unit/interaction-policy.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts` | exit 0; 6/6 files; 226/226 tests |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts -t "round 5|lifecycle priority"` | Final combined focus: exit 0; 3/3 files; 12 passed, 165 skipped (177) |
| `npm test -- --run tests/integration/controlled-scroll.test.ts tests/component/performance-collector.test.ts` | exit 0; 2/2 files; 47/47 tests |
| `npm test` | First and only full-suite run in this round: exit 0; 26/26 files; 441/441 tests; no worker exit/retry |
| `npm run typecheck` | exit 0 on initial, readonly-surface, and final invocations; no TypeScript failures |
| `npm run build` | exit 0 on its first and only invocation; TypeScript compilation and existing schema copy |

All required gates executed; none is marked not-run or an outstanding environment gap. Independent review/official checkpoint approval is pending. Existing S03–S08 fixture-server zero-delivery, immutable snapshots, traversal bounds, retained Handle identity/disposal, finalizer precedence, arbitrary rejection handling, listener rollback, cap/timeout behavior, and lifecycle ordering tests passed in the maintained full suite. No finalizer-only status patch was made.

### Protocol admission, drain, and delivery proof

- Admission uses one shared `pendingTasks` set and the existing maximum of 256, with the existing reserved overflow invalidation owner. The cap check happens before constructing the owned task or invoking its protocol body. HTTP, WebSocket, CDP, readiness, download, and popup work compete for this same bound; protocol work does not obtain a second independent 256-slot pool.
- Overflow invokes no fallback, continue, abort, close, or connection body for the denied callback. Existing reserved invalidation publishes the single close owner and promotes CLOSING when necessary. HTTP remains intercepted and paused: the installed Playwright implementation's `RouteHandler._handleInternal()` awaits both its handling Promise and the handler; returning from our handler alone does not complete handling or fall through to network continuation. WebSocket remains unconnected to the server: the matched handler path does not call `connectToServer()`; its `_afterHandle()` may ensure the local page endpoint is opened but never connects it upstream. These installed implementation boundaries were inspected read-only; no dependency was imported or changed.
- The callback's owned Promise covers protocol awaits and all ledger/error finalization. Its `finally` deletes it from the set before synchronously initiating invalidation. The outer callback can then await shared completion and preserve its original rejection without contributing itself to that drain. The mandatory late HTTP/WebSocket failures finish as invalidation, not `GUARD_PENDING_TASK_DRAIN_TIMEOUT`, demonstrating no self-await.
- A callback entering during close/drain is bounded and uses the current closing/invalidating/frozen policy, so it cannot start a newly allowed fallback. Once the final empty set is observed, CLOSED is assigned synchronously before drain returns. A callback entering afterward is denied before reading protocol request facts or recording evidence. Thus no interval exists where terminal status can be published while newly admitted work is absent from the drain.
- Event containment observes only the event's initiation view. It does not catch/replace `GuardState.invalidationCompletion` or the result of public `closePassiveGuardedContext()`. The event timeout test proves repeated public joins receive the same timeout object while process `unhandledRejection` stays empty and terminal status stays false.
- All owner paths retain the existing exactly-once raw close. Neither error wrapper, callback tracking, overflow denial, cause preservation, nor the atomic drain callback calls raw close independently. A failed close retains the same non-terminal owner and fail-closed enforcement; joining is not a second physical close attempt.

### Phase / ownership table

| Phase / trigger | Work and completion ownership | Public result and owner release |
|---|---|---|
| Construction; Guard installation fails; invalidation raw close succeeds and drains | Factory has registered ownership; Guard reaches CLOSED | Original construction error; factory releases installation ownership; no owner wrapper |
| Construction; installation or readiness fails; invalidation raw close fails | Guard remains INVALIDATING, same completion and one raw close; factory retains Context | Frozen `ContextConstructionError` exposes Context/cause; repeated existing factory close joins reject invalidated; active operations remain refused |
| ACTIVE protocol callback, operation pending, normal close begins | Callback occupies one shared bounded slot; raw close may finish but stable drain waits | No clean close/CLOSED before callback evidence finishes |
| Pending protocol operation fails during CLOSING | Evidence completes; task removes itself; invalidation synchronously promotes and joins existing completion | CLOSED only after raw-close success and empty stable drain; owner rejects invalidated with final invariant visible |
| CLOSING / INVALIDATING with more callbacks before cutoff | Shared bounded admission, lifecycle/frozen blocking; overflow uses reserved invalidation | Retains enforcement and one close owner; no second raw close |
| Shared task cap reached | Denied callback body is never invoked; one cap invariant and reserved invalidation | No denied HTTP delivery or WebSocket upstream connection; admitted work still drains |
| Raw close succeeds and final pending set is empty | Guard atomically assigns CLOSED within the drain's synchronous terminal callback | Factory/session may release ownership; all future protocol callbacks are refused without late evidence |
| Raw close fails, or drain times out | No terminal callback may release Context; INVALIDATING retained | Construction/existing owner stays reachable; public completion outcome remains stable; no physical-close retry |

### Boundary / type-escape scans

`rg -n '本来の監査対象のサイト|www\.本来の監査対象のサイト\.com|evaluate\(\s*[''\"]|innerHTML\s*=|setAttribute\(' src` returned exit 1 with no matches, the expected result.

`rg -n '\bas\s+any\b|:\s*any\b|<any>|as unknown as|@ts-ignore|@ts-expect-error|@ts-nocheck' src/safety/passive-request-guard.ts src/browser/context-factory.ts src/interaction/isolated-auditor.ts src/interaction/discover-candidates.ts` returned exit 1 with no matches (also rerun separately to verify its exact exit code). The same scan of all `src` returned only the pre-existing schema-validated `input as unknown as AuditConfig` at `src/config/validate-config.ts:120`; that file is unchanged. No production type escape was introduced.

### Final source, test, build, package/config, and authority hashes

| Artifact | Final SHA-256 | Disposition |
|---|---|---|
| `src/safety/passive-request-guard.ts` | `7B7B5B935AF17B28FF958F4E4F93619B550264DDF7625ED5C870096747BC6A66` | changed |
| `src/browser/context-factory.ts` | `92E79F378BBA393FAF62D83040C8081371D919D45AB18E773514EA4024FBC8B5` | changed |
| `tests/integration/passive-request-guard.test.ts` | `4B2CE15F072AFAABC4A78E8BF1833DB6C45D5E7DFC00CDFB1C61CA8A83F19107` | five added cases; one terminal abort expectation corrected |
| `tests/component/context-factory.test.ts` | `D13622D52F23A12100AEDAD1B4AFAFFBABB94E3AB6D8FA053403DCDB86497C11` | two added construction cases |
| `dist/safety/passive-request-guard.js` | `19DC55618F746A848E9744FBE45016DE04B15E350D8F69C49526063C89B1EF0A` | changed build output |
| `dist/browser/context-factory.js` | `6BFFDD8FE87892869E9E5DC2292724CE383BD212EC8E522A5E417EFEB79695EC` | changed build output |
| `tests/integration/isolated-interaction.test.ts` | `FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20` | unchanged |
| `src/interaction/isolated-auditor.ts` | `DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814` | unchanged |
| `src/interaction/discover-candidates.ts` | `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1` | unchanged |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged |
| Recovery design | `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18` | unchanged |
| Recovery implementation plan | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` | unchanged |

Both review and both brief authority hashes were rechecked after verification and remain identical to the table above. A before/after SHA-256 comparison of all 37 files under `dist` found exactly the two changed outputs listed above, with 35 identical files and no missing output. This report is append-only; the final whole-report hash is computed after this append and supplied in the handoff, avoiding a self-referential hash in the hashed report.

### Self-review and deferred-Minor disposition

- All seven mandatory/additional ownership cases were genuine RED before production edits and are GREEN in the final full suite. Reverting construction owner exposure/registration breaks the real construction tests; restoring bare failed-request invalidation breaks the process-rejection assertion; omitting protocol ownership breaks the held-operation cutoff tests; bypassing the cap or terminal check breaks the admission tests; awaiting invalidation before removing the protocol task prevents the required invalidation completion without timeout.
- No callback can publish protocol evidence after successful terminal close: owned finalization precedes deletion, invalidation promotion is synchronous after deletion, and the empty-set/CLOSED transition is atomic. Refusing new terminal callbacks also avoids fresh asynchronous abort failures after the cutoff. Non-terminal raw-close failure and timeout intentionally retain ownership and their established public completion.
- The ordinary factory/session lifecycle and immutable success return APIs remain unchanged. The construction error adds reachability only where construction otherwise cannot return its non-terminal Context. No factory-wide cleanup list, second completion, retry-close method, duplicate phase authority, or finalizer status shortcut was added.
- Historical Minors remain deferred: lifecycle-phase HTTP abort correlation through `expectedRouteFailures`, async-return cleanup of `emitFailedMainFrameRequest()`, and the pre-existing Page-readiness task-factory indentation. The separate isolated-auditor BigInt/String normalization Minor remains outside this correction and unchanged. The previously reported non-runtime implementation-plan illustration drift also remains unchanged. No unrelated Minor was silently fixed.
- No test, type, build, or environment failure remains at handoff. The successful local gates do not approve Task 11: controller-owned independent specification/quality review and the checkpoint decision are still pending.

## 2026-09-20 terminal recovery correction — Task 1 controller ruling

The approved correction design §4.3(8) supersedes failed-close drain/no-retry expectations: reject the failed attempt promptly while retaining listeners/tasks/ownership, then allow explicit owner retry to close/drain. Preserve primary page-close and installation errors by observing invalidation-attempt failure at those wrapper boundaries. Readiness failure hands off the non-terminal Context without automatically retrying, and session construction rethrows that handoff unchanged. Task 1 TDD/evidence is recorded in `task-11-terminal-recovery-task-1-report.md`; Task 2+ remains untouched and no approval is claimed.

### Task 1 implementation verification — 2026-09-20

Canonical close/invalidation now uses one published active attempt plus confirmed raw-close fact. Failed attempts remain invalidating and retryable; raw-close success followed by timeout retries only drain. Construction handoff preserves ownership and primary cause without an implicit retry. The unchanged public factory/session owner APIs release only at canonical CLOSED. Full implementation history, baseline hashes, all failed/interrupted runs and their diagnoses, invariant reasoning, and self-review are in `task-11-terminal-recovery-task-1-report.md`.

- Genuine pre-production RED: `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry"`: exit 1, 13 intended failures / 2 passed / 110 skipped. Initial sandbox-only `spawn EPERM` was an environment failure; the exact approved outside-sandbox rerun produced genuine RED while production hashes still matched the baseline.
- Additional ordinary-overlap RED: `npm test -- --run tests/integration/passive-request-guard.test.ts -t "overlapping ordinary close"`: exit 1, 1 intended failure / 106 skipped (one caller settled while raw close was still gated). Minimum fix preserves already-closing phase and joins the active attempt.
- Final GREEN: `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5"`: exit 0, 23 passed / 105 skipped.
- Final Task 1 regression: `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`: exit 0, 128 passed.
- Final `npm run typecheck`: exit 0. Final `npm test`: exit 0, 26 files / 449 tests passed.
- Final SHA-256: `src/safety/passive-request-guard.ts` = `0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2`; `src/browser/context-factory.ts` = `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508`; `tests/integration/passive-request-guard.test.ts` = `A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1`; `tests/component/context-factory.test.ts` = `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9`.
- Package hashes remain unchanged: `package.json` = `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233`; `package-lock.json` = `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`. Fixed authority/source/test/report package: `task-11-terminal-recovery-task-1-manifest.md`.
- NOT RUN — independent Task 1 reviews: controller-owned, approval-blocking. NOT RUN — `npm run build`: Task 1 fixed scope excludes emitted outputs; deferred to final verification, blocks Task 11 approval but not this implementation handoff. NOT RUN — Task 2+ implementation/correction gates: explicitly out of scope, blocks Task 11 overall approval. No Git, dependency change, live-target access, subagent/reviewer spawning, or Task 2+ work occurred.

### Task 1 fix round 1 — 2026-09-20

Independent-review I1/I2 now have focused corrections: one retained invalidation Promise for a protocol callback, and total arbitrary-value rejection classification before bounded normalization. Historical implementation claims are superseded where the failed review demonstrated implicit retries and escaped hostile rejection. Only Guard source/test changed; factory/session contracts remain covered by regression.

- Genuine RED command: `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"`; exit 1, 5 failed / 109 skipped, both production hashes frozen. Initial sandbox `spawn EPERM` excluded from RED. Same command GREEN: exit 0, 5 passed / 109 skipped.
- Expanded GREEN: `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5|fix round 1"`; exit 0, 28 passed / 105 skipped.
- Scoped regression: `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`; exit 0, 133 passed. `npm test`: exit 0, 26 files / 454 passed. `npm run typecheck`: exit 0.
- Final SHA-256: Guard `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB`; Guard test `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF`. Factory/test/packages unchanged.
- Evidence and fixed index: `task-11-terminal-recovery-task-1-fix-round-1-report.md`, `task-11-terminal-recovery-task-1-fix-round-1-manifest.md`. Failed review and historical manifest preserved; deferred Minors unchanged.
- NOT RUN — independent re-review: controller-owned, blocks Task 1 approval/Task 2 start. NOT RUN — build: expressly excluded, no emitted-output verification, blocks final Task 11 but not fix handoff. Task 2/3/4/12 untouched. No Git, dependency/library download/install/new import/package mutation, live-target access, subagent/reviewer spawning, or non-scoped edits.

### Terminal recovery correction — Task 2 fix round 1 — 2026-09-20

The failed Task 2 independent review reported Critical 0 / Important 7 / new Minor 3. Fix round 1 addresses I1–I6 and M1–M3: retained inspection now has distinct identity/fact debits and stops after final visibility/text/lookup work; exact connected retained identity survives ordinal movement; resolver property/Element handles have total cleanup and transfer-after-cleanup ownership; resolver/snapshot envelopes have runtime discriminant/count/presence validation; matching `<html>` participates in all three charged traversals; and budget-incomplete auditor evidence uses typed `UNESTABLISHED`, never `MISSING`.

- Genuine current-production RED: `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 correction"` exited 1 with 25 failed / 4 passed / 68 skipped after a test-only `npm run typecheck` PASS and production SHA recheck. The initial sandbox `spawn EPERM` and one corrected Proxy harness error are excluded from behavioral RED.
- GREEN: correction focus 29/29; combined new/legacy DOM focus 40/40; isolated-interaction 97/97; passive-request-guard 114/114; lifecycle race focus 6/6; repository 26 files / 494 tests; typecheck/build exit 0; production whole-DOM selector/locator/nth scan clean.
- Test-strength repairs assert exact ordinary/overflow/hostile completeness, exactly 20,000 scoped hostile wrappers, exactly 8,000 preceding nodes and 9,000 controlled wrappers, and a browser click event on the production acquired-child path.
- Controller ruling on I7: the original Task 2 discovery/inspection behavioral-RED gap is irreversible and remains an explicit deviation. This round does not manufacture or relabel evidence; its new RED proves only the correction contracts against the frozen current baseline.
- Full evidence and final no-Git package index: `task-11-terminal-recovery-task-2-fix-round-1-report.md` and `task-11-terminal-recovery-task-2-fix-round-1-manifest.md`.
- NOT RUN — independent fix-round re-review: controller-owned and Task 2 advancement-blocking. NOT RUN — correction Task 3/4 and product Task 12+: outside scope and blocked. No Git, dependency download/install/update, package mutation, live-target access, or site-specific production logic occurred.

### Terminal recovery correction — Task 2 fix round 2 — 2026-09-20

The Task 2 fix-round-1 independent re-review reported Critical 0 / Important 3 / new Minor 0. Fix round 2 gives each discovery/inspection invocation one secondary text-node owner shared across accessible-name, normalized-text, and candidates; preserves a present resolver primary rejection even when its legal value is `undefined`; and makes `UNESTABLISHED` the neutral evidence state, reserving `MISSING` for complete absence.

- Frozen package: 17/17 SHA-256 entries matched. Test-only typecheck passed. Accepted current-production RED `npm test -- --run tests/integration/isolated-interaction.test.ts -t "Task 2 fix round 2"`: exit 1, 10 failed / 3 passed / 97 skipped; the initial sandbox `spawn EPERM` is excluded. Production and package hashes remained at the frozen baselines after RED.
- Fresh GREEN: fix focus 13/13; combined Task 2 DOM focus 53/53; isolated-interaction 110/110; passive-request-guard 114/114; lifecycle race focus 6/6; repository 26 files / 507 tests; typecheck/build exit 0; production whole-DOM selector/locator/nth and budget-reset scans clean.
- Six stale legacy assertions were migrated from capped partial-candidate publication to the binding fix-round-2 contract: secondary-cap exhaustion is structured and no partial candidate/snapshot escapes. The first full run's only failures were those six expectations (104 passed / 6 failed); the migrated full file passes 110/110.
- Historical I7 remains an adjudicated irreversible evidence deviation. The correction RED is not represented as the missing original Task 2 temporal evidence.
- Full evidence and fixed no-Git package index: `task-11-terminal-recovery-task-2-fix-round-2-report.md` and `task-11-terminal-recovery-task-2-fix-round-2-manifest.md`.
- NOT RUN — independent fix-round-2 re-review: controller-owned and Task 2 advancement-blocking. NOT RUN — correction Task 3/4 and product Task 12+: outside scope and blocked. No Git, dependency/library download/install/update/new import/package mutation, live-target access, implementer subagent/reviewer spawn, or site-specific production logic occurred.

### Terminal recovery correction — Task 3 — 2026-09-20

Interaction work and Context lifecycle are now separate immutable result axes. Production reads canonical Guard terminal truth after exactly one owner-close attempt, preserves arbitrary rejection presence including `undefined`, records fulfilled-but-non-terminal close as an invariant before the final ledger snapshot, and applies final precedence `freeze > NON_TERMINAL > terminal close rejection > work`. Top-level compatibility remains, with `result.evidence === result.work.evidence`.

- Fixed package: 16/16 SHA-256 baselines matched. Test-only typecheck passed. Accepted pre-production plan-focus RED was 6 failed / 107 skipped; additional undefined/freeze RED was 5 failed / 108 skipped. Initial restricted Chromium `spawn EPERM` is excluded. Production hashes remained frozen through RED.
- Fresh GREEN: expanded Task 3 focus 15/15; isolated-interaction 113/113; context-factory 19/19; passive-request-guard 114/114; lifecycle race focus 11/11; Task 2 DOM focus 53/53; repository 26 files / 510 tests; typecheck/build exit 0; old reason interpolation and whole-DOM production scans clean.
- Every session fake owns explicit terminal state through a closure or case-local boolean. Normal fulfillment alone does not imply terminal state; terminal invalidation rejection remains `lifecycle: CLOSED`, while unresolved owner close remains `NON_TERMINAL` and owned.
- Full evidence and fixed no-Git package index: `task-11-terminal-recovery-task-3-report.md` and `task-11-terminal-recovery-task-3-manifest.md`.
- Historical Task 2 I7 remains visible and unchanged. NOT RUN — independent Task 3 review: controller-owned and Task 4 advancement-blocking. NOT RUN — correction Task 4/final dual review and product Task 12+: outside scope and blocked. No Git, dependency/library download/install/update/new import/package mutation, live-target access, implementer subagent/reviewer spawn, or site-specific production logic occurred.

### Terminal recovery correction — Task 4 fresh checkpoint verification — 2026-09-20

Task 3's independent review passed with Critical 0 / Important 0 / new Minor 0 and a 26/26 fixed-package match. The fresh Task 4 verifier then matched its brief and all 25 starting hashes before running every approved Step 1–8 command.

- User-required three-file focus: the restricted attempt failed before tests with Chromium `spawn EPERM` and is environment-only; the identical approved process-launch rerun passed 3 files, 40 passed / 206 skipped.
- Full isolated-interaction: 113/113 PASS. Lifecycle race suite: 35 passed / 98 skipped. DOM-budget suite: 23 passed / 90 skipped. Six-file Task 11 regression: 295/295 PASS.
- Typecheck and build each exited 0. Adjacent regression passed 47/47. Full repository regression passed 26 files / 510 tests on its only product-evidence run; no worker-process exit or conditional rerun occurred.
- Both required forbidden-boundary scans returned exit 1 with no matches. Package and lock hashes remain `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` and `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`.
- Prior fixed package comparison: 48 entries / 48 unique paths; 11 current substitutions, 37 unchanged, 0 missing. The correction package retains all 48 and adds 37 paths, for 85 entries / 85 unique paths / 0 removals / 0 duplicates.
- Historical Task 2 I7 remains an adjudicated irreversible original behavioral-RED deviation. It is not repaired or relabeled by later correction evidence.

NOT RUN
- command: independent Task 11 correction specification review
- reason: controller-owned after fixed-package handoff; checkpoint verifier cannot review its own package
- impact: final specification acceptance remains unproved
- completion blocker: yes

NOT RUN
- command: independent Task 11 correction code-quality review
- reason: controller-owned after fixed-package handoff; checkpoint verifier cannot review its own package
- impact: final quality acceptance remains unproved
- completion blocker: yes

NOT RUN
- command: Task 11 approval and product Task 12+ implementation
- reason: dual reviews and explicit user approval remain required
- impact: Task 11 remains unapproved and Task 12 remains blocked
- completion blocker: yes

Full fresh evidence and constraints are in `task-11-terminal-recovery-task-4-report.md`. No Git, dependency/library/package, live-target, production/test/spec/plan, reviewer-delegation, or Task 12+ operation occurred.

### Terminal recovery correction — final quality fix round 1 — 2026-09-20

The first final specification review passed Critical 0 / Important 0, while the independent quality review failed Critical 0 / Important 1 because a connected exact retained node at live ordinal 100 was falsely published as `DISCONNECTED`. Fix round 1 introduces the truthful payload-free `CANDIDATE_LIMIT_REACHED` retained snapshot, validates it exactly, and maps it directly to conservative `NOT_VERIFIABLE` / `UNESTABLISHED` work without disconnected rediscovery. Ordinal 99 remains `CONNECTED`; true detach remains `DISCONNECTED`; real total-work exhaustion remains `DOM_WORK_BUDGET_REACHED`.

- All 19 fixed baselines matched. Accepted pre-production behavioral RED: 4 failed / 5 passed / 111 skipped after one excluded restricted Chromium `spawn EPERM`; test-only typecheck passed and all three production hashes remained frozen.
- Fresh GREEN: ordinal-cap focus 9/9; isolated-interaction 120/120; exact Task 4 focus 40 passed / 213 skipped; lifecycle race 35 passed / 98 skipped; DOM-budget plus ordinal boundary 30 passed / 90 skipped; six-file Task 11 regression 302/302; repository 26 files / 517 tests; typecheck/build exit 0; both forbidden scans clean.
- Package/lock remain fixed. Changed final source/test hashes: discovery `3A484C01FBDD8AE722476001040672AE0D70FFAA0D5501D7ED2447BA827614C9`; auditor `887127C795CB98ADA79B8C1E29CDB143F11C9F3D346462E4174BE4219A812220`; isolated test `80ADE243FE12F80FD98FFB63816957FE4E5A4486935F7F447943879777187EE9`.
- Full evidence: `task-11-terminal-recovery-final-quality-fix-round-1-report.md`. Historical Task 2 I7 remains explicit and unrepaired.

NOT RUN
- command: fresh independent Task 11 specification and code-quality re-reviews
- reason: controller-owned after fixed-package handoff; implementer self-review is not independent
- impact: the final-quality correction remains independently unaccepted
- completion blocker: yes

NOT RUN
- command: Task 11 approval and product Task 12+ implementation
- reason: fresh dual re-review and explicit user approval remain required
- impact: Task 11 remains unapproved and Task 12+ remains blocked
- completion blocker: yes

### Owner retention and requestfailed task ownership correction — 2026-09-22

The two user-reported Important findings are implemented. `auditInteraction()` now uses a named two-attempt total owner-close budget and either returns after canonical `CLOSED` or throws frozen `InteractionOwnerCleanupError` retaining the exact session, structured work/lifecycle/safety data, and arbitrary last-rejection presence/value for upper-layer recovery. The synchronous/void `requestfailed` listener now delegates through the existing bounded `runGuardProtocolTask`/`pendingTasks` registry, uses `requestInvalidation()`, joins terminal drain, and adds no second registry.

- Frozen correction baseline: brief hash matched; 20/20 frozen paths matched before tests.
- Accepted unchanged-production RED: 8 behavioral failures / 2 passes / 250 skips; production and package hashes remained frozen immediately afterward. Restricted Chromium `spawn EPERM` was excluded, and no standalone test-only typecheck was run at that checkpoint.
- Fresh GREEN: correction focus 10/10; close retry 1/1; owner retention/recovery 5/5; Task 11 broad focus 49/49; close/invalidation 44/44; boundedness 5/5; requestfailed race 6/6; DOM budget 23/23.
- Full verification: isolated interaction 124/124; passive Guard 117/117; context factory 19/19; six-file Task 11 309/309; repository 26 files / 524 tests; typecheck/build exit 0; both forbidden scans clean; package/lock unchanged.
- Final production hashes: factory `454261DD6964756E9C06C4B9FD1C1CB80E14FDA5D458CCDC06549E6C973B6D6D`; auditor `0A030F675C5CCE748416006A5B2FA1EBD2016EA633C4B27A9C88BDBA11A63059`; Guard `49921091F4A92C5C7D9ADBE8CBA3621C6542B657E64217DFA5407B49CB02B7E3`.
- Evidence report: `task-11-owner-retention-requestfailed-report.md`, SHA-256 `1F045D678F01BD63F219163777C7AE5973B88FFFDF4BECB1FA706FB14D1AB532`.
- Historical Task 2 I7 remains explicitly adjudicated and unrepaired. No Git, dependency/library mutation, new import, live target, Task 12+, subagent, or reviewer work occurred.

NOT RUN
- command: independent Task 11 specification and code-quality reviews
- reason: controller-owned after fixed-package handoff; implementer self-review is prohibited
- impact: this correction remains independently unaccepted
- completion blocker: yes for Task 11 approval

NOT RUN
- command: Task 11 approval and product Task 12+ implementation
- reason: clean independent review and explicit user approval remain required
- impact: Task 12 remains blocked
- completion blocker: yes
