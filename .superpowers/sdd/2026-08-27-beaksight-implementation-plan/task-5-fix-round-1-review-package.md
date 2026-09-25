# Task 5 Fix Round 1 — Git-free review package

Git operations are prohibited. Review the exact filesystem state below read-only and verify SHA-256 before drawing conclusions.

## Scope

Re-review only the original Task 5 Critical/Important findings and new Critical/Important breakage introduced by the fix. The binding plan/spec, updated progress-ledger rulings, and `task-5-report.md` Fix Round 1 section are authoritative context.

Original open findings:

1. `route.fetch()`/`route.fulfill()` replaced native browser credentials, CORS/CSP, referrer, redirects, and response semantics.
2. main-frame delivery uncertainty escaped Safety Ledger invariant recording.
3. WebSocket close uncertainty was conflated with the network-block proof.
4. guard installation was not transactional/fail-closed.
5. `route.fetch()` responses were undisposed.
6. caller mutation of `allowedOrigins` could widen authority.
7. API-key-like header names were under-redacted.
8. risky adapter paths lacked real-boundary coverage.

Mandatory re-review gates:

- production has no `route.fetch()`, `route.fulfill()`, or `connectToServer()` delivery path;
- ordinary/subresource/nested-frame requests preserve native browser behavior;
- internal -> internal -> external top-level redirects are blocked before the external fixture;
- `awaitPassiveRequestGuardReady(page)` is enforceable, and pre-readiness navigation is fail-closed before delivery;
- CDP setup/detach/continue/fail, Playwright route abort/fallback, frame/page lookup, and allowed main-frame delivery uncertainties invalidate the context and ledger invariants without false clean-block claims;
- partial/repeat/late installation cannot leave a usable unguarded context;
- allowed-origin authority is snapshotted;
- WebSocket blocking relies on never connecting to the server and server counter proof, not successful page-side close;
- GET/HEAD, `credentials: 'omit'`, nested external frame, direct external main-frame, multi-hop redirect, mutation methods, and installation/lifecycle tests support the claims;
- redaction covers `Ocp-Apim-Subscription-Key`, `X-Auth-Key`, `X-API-Secret`, and normalized variants.

Task 6 has not yet been implemented. Treat the exported page-readiness function as the Task 5 contract; verify that Task 5 fails closed if a consumer violates it. Task 6 wiring is forward work, not an automatic Task 5 finding unless the Task 5 contract itself can be bypassed.

Do not rerun commands unless needed to inspect a specific suspected defect; the implementer reports focused 74/74 PASS, typecheck/build PASS, and full suite 176/176 PASS. Do not edit files and do not use Git.

## SHA-256 manifest

```text
27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7  src/safety/request-policy.ts
F65AF218C3283CCF037377B16CE0D2EC041FF583FCDE3EA6979F64BC85778BEC  src/safety/passive-request-guard.ts
1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6  src/safety/safety-ledger.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03  tests/unit/safety-ledger.test.ts
494F4C2D4F5709BAE10813E1D17897944B95F1ED5F024F5A750700B51E23DF3B  tests/unit/redact.test.ts
D99688D1888137517E4F2713F361BD34C56E5A13645B4DDBC28DE4628D7910E6  tests/integration/passive-request-guard.test.ts
83F2D999766CCB08F15791CDCAF1572FCF12752FEB6CE869362956B33EA7CDB3  tests/integration/fixture-server.test.ts
9F127BCC3AD24A9197BAFD6BE8041D99A1FBF06278DAABCC3B8F7FE39D589181  fixtures/server.ts
42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA  fixtures/site/external-script.js
3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52  fixtures/site/external-image.svg
```

## Required verdict format

For each of the eight original findings: `ADDRESSED` or `OPEN`, with exact file/line evidence. Then list any new Critical/Important breakage. Conclude whether the mandatory Task 5 checkpoint passes. Ignore the two explicitly deferred minor items unless they became Critical/Important.
