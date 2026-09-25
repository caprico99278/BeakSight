# Task 7 Fix Round 1 — Git-free review package

Git operations are prohibited. Verify every SHA-256 hash, then perform a read-only scoped re-review. Do not edit or spawn subagents.

## Entering Important findings

1. Synchronous browser `Request.headers()` / `Response.headers()` omit security/cookie headers, so the original allowlist and mocked redaction test did not reflect real public Playwright behavior; real-browser absence was incorrectly accepted as successful redaction.
2. The selected subset omitted `traceparent`, `tracestate`, and request/correlation-ID headers required by Task 10 from canonical Network Evidence.

The intended fix uses public async `Request.allHeaders()` / `Response.allHeaders()`, changes all collector handles to `snapshot(): Promise<T>`, synchronously fixes the snapshot record boundary, awaits header work already registered for that boundary, preserves record ordering/correlation, allows already-observed in-flight work to settle after detach while excluding new events, and exposes `{status:'OBSERVED', values}` versus `{status:'FAILED', errorText}` instead of silently reporting empty headers. It adds the telemetry header names and must continue delegating sensitive-name redaction exclusively to `redactHeaders()`.

Confirm real Chromium proves the server actually receives selected sensitive/telemetry values and collector evidence contains `[REDACTED]` for sensitive values, retained telemetry, and no unselected header. Inspect async tests for inverse completion/no cross-contamination, invocation boundary, in-flight detach, and thrown/rejected `allHeaders()` truthfulness. Ensure no internal API/cast, response-body read, Finding, navigation, route/fetch, or new dependency. Deferred Minor coverage findings remain out of scope absent escalation.

Implementer reports focused 6/6, Task 5-7 adjacent 117/117, fresh full 234/234, typecheck/build PASS. One unchanged Task 6 40 ms test flaked in the first full run, passed alone, then the unchanged fresh full suite passed. Do not rerun broad verification absent concrete suspicion; a focused real-browser rerun is permitted if needed.

## SHA-256 manifest

```text
5513CD0424738A8389B22A41209BA7A6B85B89812A0062E0E2CF31DDE506DFF2  src/evidence/collector-handle.ts
242003C5C0FE24C2F2562966229781C52252F4BAAB1222270FC4EF6575EE5604  src/evidence/network-collector.ts
5C00692E780CF75F4E57653A6ADAE172DAE839FB7AD1BF1AAB5793EE57852EAC  src/evidence/console-collector.ts
913EE371ED772292AFEE44762FC08DAB233BBDD719EB7BFC68130FEE38EB4FDA  tests/component/network-collector.test.ts
9331A4DC20EFD2847D4C993FD11B300C46E03B9F1B9E460361CE1D8280C05D92  tests/integration/technical-evidence.test.ts
89704E58A307001AC3AD4DA5384D17E083F41872B5548C826EF10C2943F75242  fixtures/server.ts
E3DE45943B1AC76528C7F89878C224ED5993C45644DD3EE0E7D98204EC3FCDD5  fixtures/site/js-error.html
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

## Required verdict

Mark each entering Important ADDRESSED/OPEN with exact lines. List any new Critical/Important and conclude Task 7 PASS/NEEDS FIXES.
