# Task 5 Report: Safety Guard, Safety Ledger, and Header Redaction

## Status

PASS — Fix Round 5 repairs are implemented and verified; final independent re-review is pending.

Commits created: NOT APPLICABLE (Git prohibited)

## Scope and files

Created:

- `src/safety/request-policy.ts`
- `src/safety/passive-request-guard.ts`
- `src/safety/safety-ledger.ts`
- `src/safety/redact.ts`
- `tests/unit/request-policy.test.ts`
- `tests/unit/redact.test.ts`
- `tests/unit/safety-ledger.test.ts`
- `tests/integration/passive-request-guard.test.ts`
- `fixtures/site/external-script.js`
- `fixtures/site/external-image.svg`

Modified:

- `fixtures/server.ts`

The separate `passive-request-guard.ts` adapter is intentional: `request-policy.ts` remains pure and Playwright-free, while the adapter delegates every passive request decision to it.

## TDD evidence

### RED: pure request policy and redaction

Initial absent-module run:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts
exit 1; 2 failed suites; modules request-policy.js and redact.js absent
```

Typed non-functional scaffolds were then used to obtain behavior-level RED evidence:

```text
Test Files  2 failed (2)
Tests       17 failed | 10 passed (27)
```

Failures included case-insensitive GET/HEAD, non-read blocking, external main-frame blocking, WebSocket blocking, origin authority, and all sensitive header variants.

### GREEN: pure request policy and redaction

```text
Test Files  2 passed (2)
Tests       27 passed (27)
```

### RED: ledger and real browser/server boundary

Ledger behavior-level RED:

```text
Test Files  1 failed
Tests       3 failed
```

The first Chromium attempt inside the restricted sandbox failed with `browserType.launch: spawn EPERM`; the same test was rerun with the existing authorized browser-launch permission.

Authorized real-Chromium RED:

```text
Test Files  1 failed (1)
Tests       5 failed (5)
```

Boundary facts in that RED run:

- fixture `POST`, `PUT`, `PATCH`, and `DELETE` counters were each `1`, not `0`;
- fixture WebSocket upgrade counter was `1`, not `0`;
- external navigation resolved and reached the external fixture;
- guard installation recorded no route registrations and did not reject injected install failures.

### Redirect mutation RED/GREEN

Playwright request-facts diagnostics proved the redirected request was a main-frame navigation, but the documented routing behavior only invoked the route handler for the first URL after `route.continue()`. A new pure-policy delivery expectation failed first:

```text
Test Files  1 failed (1)
Tests       2 failed | 17 passed (19)
```

The policy now marks allowed main-frame traffic for redirect inspection. The adapter preflights with `maxRedirects: 0`, delegates the follow-up URL to the pure classifier, and aborts an external follow-up before delivery. Approved traffic uses fetch/fulfill consistently; this was required because mixed preflight/direct continuation caused Chromium `net::ERR_FAILED` before allowed external subresources reached the fixture.

### Hardening RED/GREEN

Additional mutation-catching RED evidence:

```text
unit: 2 failed | 11 passed (proxy authorization and null-prototype method counts)
integration installation: 1 failed | 2 passed | 3 skipped (late installation resolved instead of rejecting)
```

GREEN evidence:

```text
unit: 2 files passed, 13 tests passed
integration installation: 3 passed | 3 skipped
```

## Final verification

Focused unit tests:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts
Test Files  3 passed (3)
Tests       32 passed (32)
exit 0
```

Real Chromium integration:

```text
npx vitest run tests/integration/passive-request-guard.test.ts
Test Files  1 passed (1)
Tests       6 passed (6)
exit 0
```

Repository checks:

```text
npm run typecheck  -> exit 0
npm run build      -> exit 0
npm test           -> 14 files passed, 149 tests passed, exit 0
```

## Mandatory checkpoint facts

- Only case-insensitive `GET` and `HEAD` are authorized; `OPTIONS`, unknown methods, and all other methods are blocked by the pure classifier.
- The form POST and page-side PUT/PATCH/DELETE attempts all produced browser request failures.
- Fixture server counters after those attempts were exactly `post: 0`, `put: 0`, `patch: 0`, and `delete: 0`.
- Ledger method counts contained `POST: 1`, `PUT: 1`, `PATCH: 1`, and `DELETE: 1`.
- Allowed GET rendered the fixture heading and allowed HEAD returned HTTP 200.
- An allowed-origin 302 toward the external fixture was inspected and blocked before the external server; its GET counter remained `0`.
- In the same guarded context, an external script executed, an external SVG rendered with natural width `1`, and the external fixture GET counter became `2`.
- A passive WebSocket attempt closed in the page, the fixture `webSocketUpgrade` counter remained `0`, and the ledger recorded one blocked WebSocket.
- All checkpoint snapshots reported zero invariant violations.
- Every interception-required real context was created with `serviceWorkers: 'block'`.
- Installation rejects if any page already exists or if either route installation rejects.

## Immutability and redaction evidence

- Every `SafetyLedger.snapshot()` returns a new frozen root, frozen null-prototype method-count copy, frozen event arrays, and frozen copied events.
- Mutating the original event after recording cannot alter later snapshots.
- Blocked request/navigation/WebSocket events and invariant violations are stored in distinct collections.
- Header names are classified case-insensitively; authorization (including proxy authorization), cookie, set-cookie, token, session, and API-key-like names become exactly `[REDACTED]`.
- Sensitive test values do not occur in serialized redacted output; non-sensitive headers such as content type remain visible; inputs are not mutated.

## Fresh safety-owner scans

Method literal scan:

```text
rg -n "GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE" src/safety
src/safety/request-policy.ts:28: return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
```

Decision-owner scan found classifier definitions only in `request-policy.ts`; the adapter contains three calls to `classifyPassiveRequest` (initial HTTP, redirect follow-up, and WebSocket) plus route registration. Origin comparison/canonicalization (`candidate.origin` and allowed-set membership) occurs only in `request-policy.ts`; adapter matches were parameter passing only.

Sensitive-name scan found all sensitive-name matching only in `src/safety/redact.ts`. Ledger-write scan found event method definitions only in `safety-ledger.ts` and adapter calls into that ledger; no second counter authority was added. Service-worker scan found the required context construction at `tests/integration/passive-request-guard.test.ts` with `serviceWorkers: 'block'`.

## Self-review checkpoint

- Route ordering: guard rejects existing pages, installs WebSocket routing first, then HTTP routing, and propagates installation failure.
- Redirects: main-frame reads are preflighted without auto-follow; every observed follow-up is reclassified by the pure owner before browser delivery.
- Navigation/frame detection: adapter supplies Playwright facts; classifier owns the decision. Frame lookup failure fails closed for external navigation and records an invariant violation.
- Abort races: HTTP events are recorded only after `route.abort()` succeeds; abort failure is a separate invariant violation.
- WebSocket semantics: the route never calls `connectToServer()` for the current blocking decision, closes before recording, and the fixture upgrade counter proves zero delivery.
- Ledger accuracy: successful blocks are not invariant violations; copies and counts are immutable and method names are canonicalized safely.
- Cleanup: all test contexts, fixture servers, and Chromium are closed in hooks.
- Single semantic owner: method/origin/navigation/WebSocket allow/block conditions are confined to `request-policy.ts`.

## Concerns

- `BrowserContext` does not expose its `serviceWorkers` creation option for runtime validation. Production callers must continue constructing interception-required contexts with `serviceWorkers: 'block'`; Task 5 tests enforce that construction pattern.
- Approved HTTP traffic is intentionally delivered through Playwright fetch/fulfill rather than mixed with `route.continue()`, because real Chromium diagnostics showed mixed delivery canceled allowed cross-origin subresources before the fixture boundary. This behavior is covered by the rendering and counter assertions.
- No outstanding test, typecheck, build, safety checkpoint, or invariant-violation concern remains.

---

## Fix Round 1

This section supersedes the original redirect-delivery and WebSocket implementation descriptions above. The original `route.fetch()`/`route.fulfill()` adapter was rejected during independent review and is no longer present in production.

### Findings addressed

- Approved ordinary and nested-frame traffic now uses `route.fallback()` and remains a native browser request. Production contains no `route.fetch()` or `route.fulfill()`.
- Main-frame redirect hops are guarded at Chromium CDP `Fetch` Request stage for `Document` requests. Each hop is delegated to `classifyPassiveRequest()` before `Fetch.continueRequest`; rejected hops use `Fetch.failRequest` before server delivery.
- `awaitPassiveRequestGuardReady(page)` is now an explicit production contract. Page owners must await it after `newPage()` and before navigation. A routed navigation that starts before readiness is aborted, ledgers `PASSIVE_GUARD_PAGE_NOT_READY`, and invalidates/closes the context.
- CDP setup, detach, continue, fail, page/frame lookup, native fallback, abort, and allowed main-frame delivery failures have explicit invariant paths. Any interception uncertainty invalidates the context rather than degrading to an unguarded route.
- WebSocket network prevention is independent of page-side closure: the adapter never calls `connectToServer()`. It records the policy block first, attempts page-side close only as best effort, and records close failure separately.
- Installation is fail-closed. It snapshots allowed origins, rejects repeat or late installation, and closes/invalidate the context if either installation stage fails. This is necessary because current Playwright has no `BrowserContext.unrouteWebSocket()` rollback primitive.
- Header matching now redacts `Ocp-Apim-Subscription-Key`, normalized underscore/case variants, `X-Auth-Key`, and `X-API-Secret` without retaining test secret values.
- Fixture observations now prove native request method/path/cookie facts with immutable snapshots.

### Files changed in Fix Round 1

- `src/safety/passive-request-guard.ts`
- `src/safety/redact.ts`
- `fixtures/server.ts`
- `tests/integration/passive-request-guard.test.ts`
- `tests/integration/fixture-server.test.ts`
- `tests/unit/redact.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md`

`src/safety/request-policy.ts` remains the pure classification owner, `passive-request-guard.ts` remains the Playwright/CDP adapter, `SafetyLedger` remains the event/count authority, and `redact.ts` remains the sensitive-header owner.

### TDD RED evidence

Header breadth and immutable fixture request observations:

```text
npx vitest run tests/integration/fixture-server.test.ts tests/unit/redact.test.ts
exit 1; 7 failed tests
failures: missing fixture request observations plus six Ocp/Auth/API-secret normalized header variants
```

Native delivery/readiness defects, authorized real Chromium:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "page readiness|before explicit|multi-hop"
Test Files  1 failed (1)
Tests       3 failed | 18 skipped (21)
exit 1
```

The failures proved that the readiness export was absent, an immediate navigation resolved instead of rejecting, and the maintained multi-hop test could not establish an explicitly guarded page.

Frame-classification uncertainty:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "frame classification fails"
Test Files  1 failed (1)
Tests       1 failed | 22 skipped (23)
exit 1
```

The handler propagated `frame unavailable` without completing the expected fail-closed invalidation path.

Abort and main-frame delivery invalidation:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "abort failure|failed allowed main-frame"
Test Files  1 failed (1)
Tests       2 failed | 1 passed | 22 skipped (25)
exit 1
```

The injected abort failure recorded an invariant but left the context open, and a refused allowed main-frame request recorded its delivery invariant but also left its page/context usable. Both paths now invalidate the context; the focused rerun passed `3 passed | 22 skipped`.

### Browser characterization evidence

Real Chromium rejected both Playwright-only redirect strategies:

- `route.fallback()` preserved native request semantics, including `credentials: 'omit'`, but did not re-intercept a 302 follow-up; the external fixture GET counter became `1`.
- `route.fetch({ maxRedirects: 0, headers: await request.allHeaders() })` plus `route.fulfill()` also failed to re-intercept follow-up hops; primary, middle, and external fixture GET counters each became `1`.

A disposable CDP Request-stage diagnostic then observed all three Document URLs in order, allowed the primary and middle requests, failed the external hop, and kept its fixture GET counter at `0`. The same native path rendered an external script and image, retained a cookie-free `credentials: 'omit'` observation, and allowed an external nested frame. A second diagnostic proved implicit page-event timing is insufficient, which led to the explicit readiness contract.

### GREEN evidence

Focused readiness and redirect boundary:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "page readiness|before explicit|multi-hop"
Test Files  1 passed (1)
Tests       3 passed | 18 skipped (21)
exit 0
```

Full Task 5 verification, including real Chromium:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/fixture-server.test.ts tests/integration/passive-request-guard.test.ts
Test Files  5 passed (5)
Tests       74 passed (74)
exit 0
```

Repository verification:

```text
npm run typecheck
exit 0

npm run build
exit 0

npm test
Test Files  14 passed (14)
Tests       176 passed (176)
exit 0
```

### Mandatory checkpoint and server-boundary facts

- Native fixture reads before mutation reset were exactly `GET: 1` for `/post-form.html` and `HEAD: 1` for `/index.html`; the HEAD response was HTTP 200.
- After deliberate form/page mutation attempts, fixture `POST`, `PUT`, `PATCH`, and `DELETE` counters were all exactly `0`; ledger counts were each exactly `1`.
- The maintained internal -> internal -> external redirect test delivered one GET to the primary and middle fixtures and zero GETs to the external fixture. The ledger recorded exactly one external-main-frame policy block and zero invariants.
- A direct external main-frame navigation was blocked with external GET `0`, even after the caller mutated its original `allowedOrigins` set.
- External GET script/image rendering, external nested-frame rendering, and `credentials: 'omit'` all remained native. The observed omit request had `cookie: null` despite a cookie being present in the context.
- The passive WebSocket fixture upgrade counter remained `0`; the ledger recorded the block without relying on close success.
- An immediate pre-readiness redirect attempt delivered zero GETs to both primary and external fixtures, recorded the dedicated readiness invariant, invalidated the context, and made subsequent readiness reject.
- A deliberately unavailable allowed origin rejected navigation, recorded `HTTP_MAIN_FRAME_DELIVERY_FAILED`, and invalidated/closed the context.
- Injected CDP continue/fail errors each recorded their specific invariant, produced no false blocked-navigation claim, and invalidated the context.

### Fresh ownership and unsafe-adapter scans

The final source scans found:

- zero production matches for `route.fetch`, `route.fulfill`, or `connectToServer`;
- all `GET`/`HEAD`, non-read, origin, main-frame, and WebSocket classification semantics in `src/safety/request-policy.ts`;
- adapter calls to `classifyPassiveRequest()` for Playwright HTTP, CDP Document, request-failure interpretation, and WebSocket handling, with no adapter-side origin parsing or method allowlist;
- all event storage/count mutations in `src/safety/safety-ledger.ts`, with the adapter calling that authority;
- all sensitive-header name matching in `src/safety/redact.ts`.

### Fix Round 1 self-review

- Route ordering and installation: page/request-failure listeners, WebSocket routing, and HTTP routing install before resolution; partial failure closes the context; repeated installation does not add handlers or widen authority.
- Redirects and native semantics: ordinary/subresource requests use fallback; Document redirect hops use CDP continue/fail without APIRequestContext replay or body buffering.
- Navigation/frame detection: the root frame ID is captured before readiness via `Page.getFrameTree`; nested frames remain distinct; lookup uncertainty aborts and invalidates.
- Races: pre-readiness navigation is never awaited into safety; it is aborted immediately. Block events are recorded only after successful route abort/CDP fail. Expected policy-caused `requestfailed` events do not become false delivery invariants.
- WebSocket: no server connection primitive is called; the fixture upgrade counter is authoritative. Close failure is a separate invariant.
- Ledger: successful policy blocks remain distinct from invariants; snapshots and fixture observations are immutable copies.
- Cleanup: page CDP sessions are page-scoped; unexpected detach invalidates the context; contexts, servers, and Chromium are closed by test hooks.
- Single semantic owner: the adapter supplies facts and executes decisions; it does not duplicate method/origin policy.

### Remaining concerns and forward contract

- Task 6 must make `await installPassiveRequestGuard(...); const page = await context.newPage(); await awaitPassiveRequestGuardReady(page);` the only production page lifecycle before navigation. Task 5 deliberately invalidates any context that violates this sequence.
- Redirect-chain enforcement is Chromium-specific because it uses CDP `Fetch`. Unsupported/non-attached runtimes must fail closed; they cannot fall back to Playwright routing alone.
- `BrowserContext` still does not expose its service-worker creation option for runtime inspection. All interception-required contexts must continue to be constructed with `serviceWorkers: 'block'`; Task 6 owns centralizing that construction.
- Deferred minor review items remain unchanged: exact redirect-status classification is not relevant to the CDP request-stage design, and null-prototype/`__proto__`/`constructor` header-map cases remain final security-triage candidates.

Commits created: NOT APPLICABLE (Git prohibited)

---

## Fix Round 2

### Status and scope

PASS — the pending-owner-close ledger race is fixed, every requested CDP lifecycle branch now has focused coverage, and independent re-review is pending.

Files changed in this round:

- `src/safety/passive-request-guard.ts`
- `fixtures/server.ts`
- `tests/integration/passive-request-guard.test.ts`
- `tests/integration/fixture-server.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md`

### Root cause and design decision

Real Chromium confirmed that owner-initiated `page.close()` or `context.close()` during a pending allowed main-frame response emits `requestfailed` with `net::ERR_ABORTED` before the page close marker is observable. The old handler immediately classified that event as `HTTP_MAIN_FRAME_DELIVERY_FAILED`, added a false Safety invariant, and invalidated an otherwise healthy context.

A one-turn deferral was tested and rejected: context close completed in time, but page close still produced the false invariant. The implemented classifier now races the actual page `close` signal against a fixed 100 ms deadline only for allowed main-frame `net::ERR_ABORTED` failures:

- if the page closes inside the bound, the failure is owner cleanup/cancellation and no invariant is recorded;
- if the page remains active at expiry, the abort is genuine delivery uncertainty, `HTTP_MAIN_FRAME_DELIVERY_FAILED` is recorded, and the context is invalidated;
- non-`ERR_ABORTED` failures, including connection refusal, remain immediate invariants and invalidate without delay.

This is bounded and deterministic, and it does not globally ignore `net::ERR_ABORTED`. The request has already failed during the classification window, while all guard routes remain installed.

### TDD RED evidence

Deterministic slow fixture response:

```text
npx vitest run tests/integration/fixture-server.test.ts
Test Files  1 failed (1)
Tests       1 failed | 10 passed (11)
exit 1
```

The configured `/__slow` response incorrectly settled immediately. After the fixture-only implementation, the same command passed `11/11`; client abort also cancels the timer so no long-lived test resource remains.

Real-Chromium owner-close race:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "owner page close|owner context close"
Test Files  1 failed (1)
Tests       2 failed | 33 skipped (35)
exit 1
```

Both failures contained the same false ledger event:

```text
HTTP_MAIN_FRAME_DELIVERY_FAILED: net::ERR_ABORTED
```

The first minimal fix hypothesis used one zero-delay event-loop turn. Its focused result was:

```text
Test Files  1 failed (1)
Tests       1 failed | 3 passed | 31 skipped (35)
exit 1
```

The owner context-close case became clean, but owner page-close still ledgered the false invariant. That observation established that the page close event arrives later than one timer turn and justified waiting on the actual close signal with a finite deadline.

### GREEN lifecycle evidence

The focused close/failure distinction:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "owner page close|owner context close|unexpected allowed-delivery abort|failed allowed main-frame"
Test Files  1 passed (1)
Tests       4 passed | 31 skipped (35)
exit 0
```

The complete requested CDP lifecycle set:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "setup fails|detaches unexpectedly|cannot look up the CDP page|unexpected allowed-delivery abort|owner page close|owner context close|failed allowed main-frame"
Test Files  1 passed (1)
Tests       10 passed | 25 skipped (35)
exit 0
```

This set proves:

- `newCDPSession`, `Page.getFrameTree`, and `Fetch.enable` setup failures each record `CDP_SETUP_FAILED`, invalidate the context, reject initial readiness, and make later readiness reject as invalidated;
- unexpected CDP session detach while the page/context remains active records `CDP_SESSION_DETACHED` and invalidates;
- requestfailed-handler page lookup failure records `CDP_PAGE_LOOKUP_FAILED` and invalidates;
- route-handler page lookup failure aborts the route, records `CDP_PAGE_LOOKUP_FAILED`, and invalidates;
- owner page close during a pending allowed response records zero invariants and leaves the context usable for a newly readied page/navigation;
- owner context close during a pending allowed response records zero invariants;
- an active-page `net::ERR_ABORTED` is not suppressed: after the 100 ms bound it records the delivery invariant and invalidates;
- a refused allowed main-frame connection still records immediately and invalidates;
- expected normal page closure does not become unexpected CDP detachment, while an actual detach on an active page does.

### Final verification

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/fixture-server.test.ts tests/integration/passive-request-guard.test.ts
Test Files  5 passed (5)
Tests       84 passed (84)
exit 0

npm run typecheck
exit 0

npm run build
exit 0

npm test
Test Files  14 passed (14)
Tests       186 passed (186)
exit 0
```

Fresh ownership/unsafe-adapter scans still found zero production `route.fetch`, `route.fulfill`, or `connectToServer` matches. Method/origin classification remains confined to `request-policy.ts`; this round changed only lifecycle interpretation in the adapter.

### Residual concerns

- The 100 ms deadline is a deliberate bounded classification contract. If a future Playwright/host combination takes longer than that to emit `close` after an owner request, the system will conservatively record an invariant and invalidate rather than suppress a potentially genuine abort.
- Task 6 must still centralize `awaitPassiveRequestGuardReady(page)` before navigation and construct contexts with `serviceWorkers: 'block'`.
- Redirect-chain enforcement remains Chromium-CDP-specific and must fail closed on unsupported/non-attached runtimes.

Commits created: NOT APPLICABLE (Git prohibited)

---

## Fix Round 3

### Status and scope

PASS — owner teardown is now explicit and request-failure suppression is request-correlated. Unexpected close and genuine delivery failure remain Safety invariants; independent re-review is pending.

Files changed in this round:

- `src/safety/passive-request-guard.ts`
- `tests/integration/passive-request-guard.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md`

### Design decisions

The adapter now exports `closePassiveGuardedPage(page)` and `closePassiveGuardedContext(context)`. These wrappers mark owner intent before calling Playwright close. Only that explicit intent, or an already-running fail-closed context invalidation, can suppress the resulting expected CDP detach and pending-navigation `net::ERR_ABORTED` event.

- Direct/unmarked `page.close()` and `context.close()` are contract violations. They ledger the observable detach or allowed-delivery failure and invalidate the context.
- Successful guarded page close retains its marker for 100 ms on the already-closed Page only, covering Playwright's late CDP-session close event; the marker is then deleted. It cannot suppress another Page's failure. The guarded context remains reusable after page close.
- A rejected page close records `GUARDED_PAGE_CLOSE_FAILED`, clears owner intent immediately, and invalidates/closes the context. A rejected context close pre-invalidates the guard, records `GUARDED_CONTEXT_CLOSE_FAILED`, clears owner intent, and leaves every later route fail-closed.
- Both wrappers reject unguarded or invalidated inputs. Re-entrant close is rejected while its owner marker is active.

The Page-wide CDP failure count was deleted. Real Chromium showed why no policy-only interpretation can replace correlation for a redirect: when CDP blocks the external final hop, Playwright emits `requestfailed(net::ERR_BLOCKED_BY_CLIENT)` for the preceding allowed middle-hop Request and never creates a Playwright Request for the external hop. CDP supplies `redirectedRequestId`, so the adapter now records a one-shot expected failure for the exact predecessor method, exact predecessor URL, and exact `net::ERR_BLOCKED_BY_CLIENT` reason. It expires after one second and is consumed only on an exact match. A different URL, method, or reason remains a delivery invariant.

### TDD RED evidence

Explicit lifecycle contract before implementation:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "guarded close APIs|page close failure|context close failure|unmarked"
Test Files  1 failed (1)
Tests       7 failed | 36 skipped (43)
exit 1
```

The close APIs were absent, and unmarked idle/pending page/context close produced no required invariant.

Generic CDP suppression defect:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "blocked CDP request suppress"
Test Files  1 failed (1)
Tests       1 failed | 42 skipped (43)
exit 1
```

The unrelated allowed delivery failure was consumed by the Page-wide token, leaving the fake context open (`closeCount` was `0` instead of `1`).

Deleting suppression entirely was also tested before adding correlation:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "direct external main-frame|multi-hop internal redirect"
Test Files  1 failed (1)
Tests       1 failed | 1 passed | 41 skipped (43)
exit 1
```

Direct external navigation stayed clean. The multi-hop boundary still kept the external GET counter at zero and recorded the correct block, but also falsely recorded `HTTP_MAIN_FRAME_DELIVERY_FAILED: net::ERR_BLOCKED_BY_CLIENT`. Instrumentation showed the failed Playwright Request was the allowed middle URL, with the primary URL in `redirectedFrom`; the blocked external URL existed only in CDP. That evidence led to exact `redirectedRequestId` predecessor correlation.

### GREEN evidence

Focused lifecycle and correlation matrix:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "guarded close APIs|close failure|owner page close|owner context close|unmarked|blocked CDP request suppress|direct external main-frame|multi-hop internal redirect"
Test Files  1 passed (1)
Tests       13 passed | 30 skipped (43)
exit 0
```

This includes real Chromium proof that guarded pending page/context close is clean, guarded page close preserves context reuse, unmarked idle/pending close records invariants, direct and multi-hop external delivery counters remain zero, and an unrelated allowed failure cannot consume the exact blocked-redirect record.

Full Task 5 verification, including the fixture boundary and real Chromium:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/fixture-server.test.ts tests/integration/passive-request-guard.test.ts
Test Files  5 passed (5)
Tests       92 passed (92)
exit 0

npm run typecheck
exit 0

npm run build
exit 0

npm test
Test Files  14 passed (14)
Tests       194 passed (194)
exit 0
```

Fresh source scans found zero production `route.fetch`, `route.fulfill`, or `connectToServer` matches. HTTP method/origin/navigation and WebSocket policy remain owned by `request-policy.ts`; the adapter only correlates delivery lifecycle evidence and delegates every policy decision to `classifyPassiveRequest()`.

### Forward contract and residual concerns

- Task 6 must centralize the full lifecycle: install the guard, create a Page, await `awaitPassiveRequestGuardReady(page)`, and use `closePassiveGuardedPage(page)` / `closePassiveGuardedContext(context)` for owner teardown. Direct Playwright close is deliberately fail-closed.
- The 100 ms successful-page marker is bounded and Page-specific. A future Playwright version that emits the CDP close event later will conservatively record an invariant; it will not silently widen the exemption.
- Redirect failure correlation is one-shot, exact method + URL + reason, and expires after one second. An event outside that exact bounded contract becomes an invariant rather than being suppressed.
- Redirect-chain authority remains Chromium-CDP-specific and contexts still must be created with `serviceWorkers: 'block'`.
- The two previously deferred minor security-triage items remain unchanged: exact redirect-status classification and null-prototype/`__proto__`/`constructor` header maps.

Commits created: NOT APPLICABLE (Git prohibited)

---

## Fix Round 4

### Status and scope

PASS — CDP Document pauses now honor invalidated and owner-closing lifecycle state before any native continuation. Independent re-review is pending.

Files changed in this round:

- `src/safety/passive-request-guard.ts`
- `tests/integration/passive-request-guard.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md`

### Root cause and correction

The `Fetch.requestPaused` callback previously delegated normal request facts to policy but never consulted the already-live guard lifecycle state. Consequently, an allowed Document pause after guarded Context close had marked the guard `INVALIDATED` could still call `Fetch.continueRequest`.

The callback now gates lifecycle state before classification and rechecks it at the last safe point before `Fetch.continueRequest`. It never continues when any of these are true:

- the guard or installation is `INVALIDATED`;
- guarded Context close is active;
- guarded Page close is active;
- safety invalidation is active.

The lifecycle branch calls `Fetch.failRequest(BlockedByClient)` and returns without recording a blocked request/navigation, because this is fail-closed lifecycle evidence rather than a `request-policy.ts` decision. If failRequest rejects, it records `CDP_LIFECYCLE_FAIL_REQUEST_FAILED`. It starts invalidation only if the context is not already invalidated/invalidation-active, preventing a rejected guarded Context close from being retried or producing recursive close invariants.

### TDD RED evidence

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest"
Test Files  1 failed (1)
Tests       7 failed | 43 skipped (50)
exit 1
```

All seven cases timed out waiting for `Fetch.failRequest`; the uncorrected callback issued no lifecycle failure command and proceeded toward `Fetch.continueRequest`. The cases covered rejected and pending guarded Context close, rejected and pending guarded Page close, safety invalidation in progress and complete, and failRequest uncertainty after a rejected Context close.

### GREEN evidence

Focused lifecycle races:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest"
Test Files  1 passed (1)
Tests       7 passed | 43 skipped (50)
exit 0
```

Focused lifecycle plus real Chromium redirect/server boundary:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest|direct external main-frame|multi-hop internal redirect|blocked CDP request suppress|allows native GET and HEAD|blocks mutations|WebSocket"
Test Files  1 passed (1)
Tests       14 passed | 36 skipped (50)
exit 0
```

This retained exact redirect-failure correlation, direct/multi-hop external counter protection, native GET/HEAD delivery, mutation counter zeroes, and passive WebSocket server counter zero while exercising every new lifecycle branch.

Full verification:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/fixture-server.test.ts tests/integration/passive-request-guard.test.ts
Test Files  5 passed (5)
Tests       99 passed (99)
exit 0

npm run typecheck
exit 0

npm run build
exit 0

npm test
Test Files  14 passed (14)
Tests       201 passed (201)
exit 0
```

### Self-review and residual concerns

- Both policy and lifecycle CDP failures occur before server delivery. Only policy decisions mutate blocked-event collections; lifecycle fail-close errors mutate invariant evidence only.
- No await separates the final lifecycle recheck from invoking `Fetch.continueRequest`; future refactors that introduce an await must retain this last-safe-point recheck.
- A lifecycle failRequest rejection cannot recursively invalidate an already-invalidated Context. For a pending guarded Page close whose guard is still installed, the same uncertainty correctly invalidates the Context.
- Normal direct/multi-hop policy correlation is unchanged because lifecycle state is checked before the correlation map is mutated.
- Task 6 must continue owning readiness and guarded close APIs. Chromium-CDP and `serviceWorkers: 'block'` requirements remain unchanged.
- The two deferred minor security-triage items remain unchanged.

Commits created: NOT APPLICABLE (Git prohibited)

---

## Fix Round 5

### Status and scope

PASS — successful lifecycle CDP failures are now correlated through their complete Playwright `requestfailed` sequence without false delivery invariants or repeated Context close. This is the final allowed fix round; final independent re-review is pending.

Files changed in this round:

- `src/safety/passive-request-guard.ts`
- `tests/integration/passive-request-guard.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md`

### Root cause and correction

Round 4 correctly failed lifecycle-paused Documents at CDP, but that successful `Fetch.failRequest(BlockedByClient)` later surfaced through Playwright as `requestfailed(net::ERR_BLOCKED_BY_CLIENT)`. Because only policy-caused CDP failures had an expected-failure record, the lifecycle failure fell through as `HTTP_MAIN_FRAME_DELIVERY_FAILED` after owner-close state cleared and could start a second Context close.

Before every lifecycle failRequest, the adapter now registers a bounded, one-shot exact record:

- method normalized to uppercase;
- exact Playwright-visible URL;
- exact `net::ERR_BLOCKED_BY_CLIENT` failure reason;
- one-second suppression expiry.

For a direct/current Document pause, Playwright-visible facts are the current CDP request. For a redirect pause, the adapter resolves `redirectedRequestId` through the same intercepted-Document map used by policy correlation and records the predecessor facts Playwright will report. Exact `requestfailed` consumes the record once and returns. Mismatch and expiry do not consume it. Neither policy nor lifecycle expected-failure consumption creates a blocked-policy event.

If lifecycle failRequest rejects, the adapter removes that exact record by object identity before recording `CDP_LIFECYCLE_FAIL_REQUEST_FAILED`. If event ordering already consumed it, removal is a no-op. `invalidateContext()` also treats an already-`INVALIDATED` installation as non-recursive, so a later genuine mismatched/expired failure remains invariant evidence without retrying an owner close that already started or rejected.

### TDD RED evidence

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest|lifecycle correlation|redirected lifecycle|expired lifecycle|mismatched failure"
Test Files  1 failed (1)
Tests       10 failed | 43 skipped (53)
exit 1
```

The full callback sequences reproduced the review finding: exact lifecycle failures created false `HTTP_MAIN_FRAME_DELIVERY_FAILED` events, pending/rejected Context paths reached `closeCount: 2`, Page close invalidated the otherwise reusable Context, and safety invalidation gained a second false invariant. Redirect predecessor, mismatch, expiry, and failRequest-rejection cases also failed their truthfulness assertions.

### GREEN evidence

Focused full-sequence lifecycle correlation:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest|lifecycle correlation|redirected lifecycle|expired lifecycle|mismatched failure"
Test Files  1 passed (1)
Tests       10 passed | 43 skipped (53)
exit 0
```

This drives pause -> failRequest -> requestfailed for pending/rejected guarded Context close, pending/rejected guarded Page close, safety invalidation in progress/complete, lifecycle failRequest rejection, direct correlation, redirected predecessor correlation, mismatch, expiry, and second-match one-shot consumption. Context close count stays exactly one; guarded Page close leaves the Context ready for a new guarded Page.

Focused lifecycle plus real Chromium/server boundary:

```text
npx vitest run tests/integration/passive-request-guard.test.ts -t "paused Document|lifecycle failRequest|lifecycle correlation|redirected lifecycle|expired lifecycle|mismatched failure|direct external main-frame|multi-hop internal redirect|blocked CDP request suppress|allows native GET and HEAD|blocks mutations|WebSocket"
Test Files  1 passed (1)
Tests       17 passed | 36 skipped (53)
exit 0
```

Direct and multi-hop external counters remain zero, policy redirect correlation remains exact, native GET/HEAD delivery remains allowed, mutation counters remain zero, and passive WebSocket never connects to the fixture server.

Full verification:

```text
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/unit/safety-ledger.test.ts tests/integration/fixture-server.test.ts tests/integration/passive-request-guard.test.ts
Test Files  5 passed (5)
Tests       102 passed (102)
exit 0

npm run typecheck
exit 0

npm run build
exit 0

npm test
Test Files  14 passed (14)
Tests       204 passed (204)
exit 0
```

Fresh scans found zero production `route.fetch`, `route.fulfill`, or `connectToServer` matches. Policy ownership remains in `request-policy.ts`; correlation interprets adapter lifecycle evidence only.

### Final self-review and residual concerns

- Every lifecycle record is registered before failRequest, exact, bounded, and one-shot. Failure to send removes only the record created for that command.
- Direct and redirected Playwright visibility are distinct and tested. A missing CDP predecessor mapping conservatively falls back to current facts; a nonmatching Playwright failure becomes an invariant rather than being suppressed.
- Mismatch does not consume the record; the subsequent exact event does. A second exact event becomes a genuine invariant, proving one-shot behavior. Expired records likewise cannot suppress.
- Expected lifecycle failure consumption never claims a policy block. Lifecycle failRequest uncertainty remains a dedicated invariant.
- Already-invalidated Contexts do not receive repeated invalidation close attempts, while still-installed Page-close uncertainty still invalidates fail-closed.
- No known lifecycle uncertainty remains untested in the requested scope. Task 6 must still centralize readiness and guarded close APIs; Chromium-CDP and `serviceWorkers: 'block'` remain required.
- The two deferred minor security-triage items remain unchanged.

Commits created: NOT APPLICABLE (Git prohibited)
