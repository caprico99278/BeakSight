# Task 10 implementer report — Git-free SDD

Status: fix round 1 verified; independent re-review pending.

## TDD evidence

### RED

- After adding only the Task 10 component and integration tests, `npx vitest run tests/component/performance-collector.test.ts tests/integration/performance-evidence.test.ts` failed 2/2 suites before test collection because `src/evidence/performance-collector.ts` did not exist. Both failures were the expected missing-feature module boundary.
- The first real-Chromium GREEN attempt then ran the new integration test and failed 1/1 with `PARTIAL / EVALUATION_FAILED`. Systematic diagnosis traced this to the serialized `page.evaluate()` callback capturing the Node-only `record()` helper. The existing integration test was the regression proof; the minimal fix made the browser callback self-contained.

### GREEN

- Focused component: 11/11 PASS.
- Focused guarded real-Chromium integration: 1/1 PASS.
- Task 5–10 adjacent regression: 164/164 PASS across 14 files.
- Standard repository suite: 277/277 PASS across 24 files.
- Typecheck: PASS.
- Build: PASS.

## Changed files

- `src/evidence/performance-collector.ts`
- `tests/component/performance-collector.test.ts`
- `tests/integration/performance-evidence.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-10-report.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` (factual append only)

No Task 1–9 production source, fixture, configuration, package manifest, lockfile, or binding design document changed. No Git operation was used.

## Architecture, evidence, and safety results

- `PerformanceCollector.installBeforeNavigation(context)` resolves the installed `web-vitals` entry through `import.meta.resolve()` and reads the sibling attribution IIFE independent of process cwd. It calls only public `context.addInitScript({ content })`; it creates no Page, navigation, route, fetch, or telemetry transport.
- Installation uses module-wide weak context identity. Concurrent/sequential calls across collector instances install once. Read or `addInitScript` failure is not marked installed and remains retryable.
- The combined init script creates a fresh closure-backed bounded state per document, registers CLS/FCP/INP/LCP/TTFB with `reportAllChanges`, stores only the latest normalized primitive facts, and exposes a non-configurable getter returning detached snapshots. Page assignment cannot replace or mutate the internal state. Missing INP remains `NOT_OBSERVED / null`; unsupported browser/library paths remain `UNSUPPORTED / null`; CLS zero is retained only through an actual callback.
- CLS/LCP/INP attribution uses explicit primitive allowlists. Raw entries, DOM nodes, callbacks, cycles, arbitrary library objects, and FCP/TTFB attribution are not retained.
- `collect(page, networkEvidence, { deadlineAtMs })` uses one self-contained read-only public `page.evaluate()` for Web Vital state and Navigation/Resource/Server Timing. It attaches no network listener and calls no browser header API or redaction helper.
- The required absolute deadline is adjudicated at entry, by timer race, after browser completion, and before/after terminal immutable result construction. Late resolution/rejection is handled by the outcome promise; timeout returns immutable `PARTIAL / DEADLINE_EXCEEDED` without late mutation. Early evaluation rejection returns immutable `PARTIAL / EVALUATION_FAILED` and invalid finite/nonnegative browser data returns `PARTIAL / INVALID_BROWSER_DATA` without retaining invalid numbers.
- Navigation evidence preserves DCL/load boundaries and transfer/encoded/decoded sizes. Resource evidence preserves bounded public timing and Server-Timing facts. Script, stylesheet, image, and fetch/xhr summaries prefer matching Task 7 request ID/URL/resource type and record `NETWORK_EVIDENCE`, `INITIATOR_TYPE`, or `UNKNOWN` category basis explicitly.
- Telemetry headers and candidates are cloned only from caller-supplied canonical Task 7 `NetworkEvidence`. Header observation failure remains `FAILED`; observed traceparent/tracestate/request/correlation fields and x-prefixed variants are copied without rereading or re-redacting. Candidates record frozen `TRACE_OR_CORRELATION_HEADER` and/or `GENERIC_URL_HINT` bases and are not called true RUM/APM traces.
- All result lists/objects are bounded and deeply frozen. The collector creates no Finding, Evidence ID, fingerprint, rule, threshold judgment, cross-page aggregate, body, secret, or telemetry send.
- Real Chromium used only the local fixture through the guarded Task 5/6 lifecycle. One document GET was observed before and after collection, no mutation method or extra telemetry request occurred, and the Safety Ledger reported zero invariant violations.
- Production scans found no `page.on`/`context.on`, browser header read, redaction, route/fetch/sendBeacon/XMLHttpRequest/WebSocket/body/postData, Finding/ID/fingerprint/rule, target identity, CDP/internal browser API, or target-specific token in the Task 10 source.
- `web-vitals` remains the existing locked 6.1.0 package. Package, lockfile, local IIFE, Task 7 network owner, Task 6 context owner, collector handle, and core contracts exactly match the Task 10 baseline hashes.

## Verification commands actually run

- `npx vitest run tests/component/performance-collector.test.ts tests/integration/performance-evidence.test.ts` — expected initial RED, 2/2 suites failed at the missing module boundary.
- `npx vitest run tests/component/performance-collector.test.ts tests/integration/performance-evidence.test.ts` — component 11/11 PASS; initial sandboxed Chromium launch failed with `spawn EPERM` before integration execution.
- `npx vitest run tests/integration/performance-evidence.test.ts` with approved Chromium process permission — first implementation run 0/1 due to the diagnosed Node-helper capture; final rerun 1/1 PASS.
- `npx vitest run tests/component/performance-collector.test.ts` — final 11/11 PASS.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts tests/component/layout-collector.test.ts tests/integration/layout-accessibility.test.ts tests/component/performance-collector.test.ts tests/integration/performance-evidence.test.ts` — 164/164 PASS across 14 files.
- `npx vitest run` — 277/277 PASS across 24 files.
- Final handoff gate `npm run typecheck`, `npm run build`, then `npx vitest run` — all exit 0; full suite 277/277 PASS across 24 files.
- `npm ls web-vitals --depth=0` — locked local `web-vitals@6.1.0` present.
- `rg` architecture/safety/bounded-state scans over `src/evidence/performance-collector.ts` — prohibited boundary tokens absent; explicit weak installation state and collection bounds present.
- `Get-FileHash -Algorithm SHA256` over Task 10 outputs and baseline authorities — manifest below.

## Not run

- `npx vitest run --maxWorkers=1` was not run because the standard repository suite passed 277/277 and the brief requires the single-worker rerun only if the known timing issue recurs. Impact: none; completion blocker: no.
- No live target audit or external-origin navigation was run; Task 10 verification used only the local fixture server. Impact: none at Task 10; completion blocker: no.
- No package install/update/download command was run. Impact: none; completion blocker: no.
- No Git command was run. Impact: Git-free manifests replace commit evidence; completion blocker: no.

## Concerns / honest gaps

- Independent review remains required before Task 10 can be declared complete.
- The public page global name is intentionally observable so collection can use public `page.evaluate()`, but it returns a detached snapshot from non-replaceable closure state; page code can read the evidence-in-progress but cannot replace or mutate the collector's internal state.

## SHA-256 manifest

```text
F414D073607121EA99556C6747C3104B5AD437385A31AECBF9820D2BA9BB846C  src/evidence/performance-collector.ts
6143EF9ED55C628DDC40EE2005257DE81EC86C2C8CAB2568FEA5B952CD5BCCA0  tests/component/performance-collector.test.ts
33D4FD6B8980D690B28C1C9AD861294F15B7BB0F592195A35BC94E6292F916AF  tests/integration/performance-evidence.test.ts
242003C5C0FE24C2F2562966229781C52252F4BAAB1222270FC4EF6575EE5604  src/evidence/network-collector.ts
5513CD0424738A8389B22A41209BA7A6B85B89812A0062E0E2CF31DDE506DFF2  src/evidence/collector-handle.ts
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
11F421FBCDD358C510FF808F539A208B292ADA13AD6E0C22A9356F51945BE35C  node_modules/web-vitals/dist/web-vitals.attribution.iife.js
```

## Fix round 1/5 — 2026-08-28

Independent review found 0 Critical and 8 Important issues. Genuine pre-production RED was captured as 14 component failures with 8 passes plus 2 real-Chromium capability-matrix failures with 1 pass.

The implementation now aligns INP/TTFB support with the installed library, uses nullable Vital availability instead of fabricated `NOT_OBSERVED` states, checks the deadline before input traversal, creates one bounded detached Task 7 projection before the async boundary, rejects malformed timing containers, excludes document/incompatible/ambiguous duplicate-URL correlation, leaves CSS initiator-only type unknown, and makes unsafe resource-summary addition unavailable under `PARTIAL / INVALID_BROWSER_DATA`. A root self-review added the heterogeneous known/unknown duplicate-URL regression before the final correlation correction.

Fresh adjacent verification exposed a separate existing Task 6 real-browser defect: immediately after `domcontentloaded`, Chromium could update `scrollY` without dispatching the first scroll event, so the lazy fixture never activated. Reproduction was consistent in isolation and observation showed zero scroll events/batches. A first `requestAnimationFrame` proved the rendering-opportunity boundary. `controlledScroll` now waits for that frame inside its already deadline-raced reset evaluation, checks the page deadline after the frame, and only then mutates scroll. Thus a late callback cannot mutate after deadline. No Task 6 test or fixture was weakened or changed.

Fresh verification after both corrections:

- Task 10 component: 23/23 PASS.
- Task 10 guarded/capability real Chromium: 3/3 PASS.
- Task 6 controlled-scroll focused: 13/13 PASS.
- Task 5–10 adjacent: 178/178 PASS across 14 files.
- Typecheck: PASS.
- Build: PASS.
- Standard full repository: 291/291 PASS across 24 files.
- `web-vitals@6.1.0` remains the existing installed dependency; package and lock hashes are unchanged.
- No Git, dependency download/update, live target access, or target-specific workaround was used.

Fresh SHA-256 review manifest is recorded in `task-10-fix-round-1-review-package.md`. Independent re-review remains required before Task 10 completion.

## Fix round 2/5 — 2026-08-28

Round 1 re-review marked six findings ADDRESSED and two PARTIAL. Three new focused RED tests proved: a request getter could advance the deadline before an already-captured response getter; unknown-initiator fetch/xhr duplicates were collapsed through their summary category; and overlong exact URLs/scalars were retained in the internal projection.

The projection now checks the deadline between top-level field reads and between scalar reads, bounds all retained scalar fields, and retains an exact correlation URL only when it is already within the public URL bound. Overlong URLs therefore cannot alias by truncation or participate in exact correlation. Unknown initiators with multiple candidates correlate only when normalized raw resource types are identical; aggregate category equality no longer claims a specific request ID/type. The round 1 reviewer Minor was also removed by deleting unused `emptyWebVitals()` dead code.

Fresh verification:

- Task 10 component: 26/26 PASS.
- Task 10 + Task 6 real-browser focused: 16/16 PASS.
- Task 5–10 adjacent: 181/181 PASS across 14 files.
- Typecheck: PASS.
- Build: PASS.
- Standard full repository: 294/294 PASS across 24 files.
- No Git, dependency download/update, live target access, or target-specific workaround was used.

Fresh SHA-256 review manifest is recorded in `task-10-fix-round-2-review-package.md`. Independent re-review remains required.

## Fix round 3/5 — 2026-08-28

Round 2 re-review found the two findings still PARTIAL at finer accessor boundaries. Six focused RED failures proved repeated array lengths, post-index scalar reads, FAILED status/errorText, repeated OBSERVED values reads, late header-value continuation, and raw resource-type truncation alias.

Projection now caches each caller container and length once; checks the absolute deadline after every top-level, length, index, scalar, header status/container, own-property, and header-value accessor before another caller-owned read; and never rereads `HeaderEvidence.values`. Display `resourceType` remains bounded while a separate exact normalized correlation discriminator exists only when the complete raw type is within the bound. Overlong raw types are excluded from correlation, so suffix differences cannot alias.

Fresh verification:

- Task 10 component: 32/32 PASS.
- Task 10 + Task 6 real-browser focused: 16/16 PASS.
- Task 5–10 adjacent: 187/187 PASS across 14 files.
- Typecheck: PASS.
- Build: PASS.
- Standard full repository: 300/300 PASS across 24 files.
- No Git, dependency download/update, live target access, or target-specific workaround was used.

Fresh SHA-256 review manifest is recorded in `task-10-fix-round-3-review-package.md`. Independent re-review remains required.

## Fix round 4/5 — 2026-08-28

Round 3 re-review found two remaining Important issues. Two focused RED failures proved that JavaScript `for...in` can cross from a Proxy `ownKeys` trap to a property-descriptor trap after the deadline, and that a known `fetch` initiator could take an earlier same-URL `xhr` request through the aggregate `fetch-xhr` category.

Header projection now snapshots `Reflect.ownKeys()` as one caller boundary, checks the deadline, then separately gates each own-property descriptor and only selected telemetry-header values. Unselected header values are not read. Request identity correlation now uses exact initiator-specific raw types (`fetch` versus `xhr` included); the aggregate category remains summary fallback only and cannot establish a request ID/type.

Fresh verification:

- Focused round 4 RED/GREEN: 2/2 PASS after the production correction.
- Task 10 component: 34/34 PASS.
- Task 10 + Task 6 real-browser focused: 16/16 PASS.
- Task 1–10 adjacent: 189/189 PASS across 14 files.
- Typecheck: PASS.
- Build: PASS.
- Standard full repository: 302/302 PASS across 24 files.
- No Git, dependency download/update, live-target access, or target-specific workaround was used.

Fresh SHA-256 review manifest is recorded in `task-10-fix-round-4-review-package.md`. Independent re-review remains required.

Independent fix round 4 re-review verified all 13 manifest hashes and returned PASS with 0 Critical, 0 Important, and 0 Minor findings. Both remaining findings are ADDRESSED, all preceding findings remain ADDRESSED, and Task 6 first-render-frame maintenance remains PASS. Task 10 is complete under the Git-free SDD protocol.
