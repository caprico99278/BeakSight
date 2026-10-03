# Task 7 implementation report

## Status

IMPLEMENTATION VERIFIED — INDEPENDENT REVIEW PENDING

Implemented passive network/resource and console/JavaScript evidence collectors, collector-owned listener lifecycle, and deterministic real-Chromium fixture coverage. Git operations were not used, `.git-sandbox-backup` was not touched, and no dependency was added or downloaded.

## RED evidence

Initial command before production collector modules existed:

```text
npx vitest run tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts
```

Result:

```text
Test Files  2 failed (2)
Tests       no tests
exit        1
```

Both suites failed to load because `src/evidence/network-collector.ts` and `src/evidence/console-collector.ts` did not exist. This was the expected missing-feature RED, not a pre-existing failure or typo.

After the initial GREEN, a source-targeted timing boundary test was added. It changes a request's public `Request.timing()` value before emitting `requestfinished` and requires both request and associated response observations to contain that final copied timing. It also requires that listener to be detached with the handle.

```text
npx vitest run tests/component/network-collector.test.ts
FAIL — 1 file, 2 failed / 1 passed, exit 1
```

The failures showed the request/response observations retained the earlier timing and no `requestfinished` listener was installed. After the minimal listener/update implementation, the same command passed 3/3.

## Implementation

- `CollectorHandle<T>` exposes repeatable `snapshot()` and idempotent `detach()`. Each handle removes only the exact listener functions it installed.
- `NetworkCollector.attach(page)` observes `request`, `response`, `requestfailed`, and `requestfinished` without navigating, routing, fetching, retrying, or reading response bodies.
- Requests receive collector-local correlation IDs. Redirect predecessor/successor IDs and the full predecessor chain are preserved without creating a global Evidence ID or alternate `EvidenceRecord` path.
- Request and response status observations remain separate from request failures. Redirect and 4xx responses are retained as raw facts and never converted to Findings.
- Resource type, method, URL, status text/code, failure text, final public `Request.timing()`, content-length header, and selected request/response headers are normalized at event boundaries.
- Header selection is a deliberate case-insensitive allowlist. Selected values pass through the existing `src/safety/redact.ts` `redactHeaders()` owner before storage; unselected headers never enter collector state.
- `ConsoleCollector.attach(page)` retains every `console.error`, `console.warn` (`warning` in Playwright), and uncaught `pageerror` as separate entries, including duplicates. Console location and page-error name/message/stack are copied where Playwright exposes them.
- Snapshots copy and freeze the top-level object, every array, every observation, headers, timing objects, redirect chains, and console locations. Playwright Request/Response/ConsoleMessage/Error handles are not retained in public or internal observation records.
- State is allocated per `attach()` call; multiple handles and Pages do not share arrays or sequence counters. Late events cannot enter a detached handle.
- `js-error.html` deterministically emits one warning, two identical errors, one uncaught exception, and one broken image. The fixture server provides an internal redirect and a 404 image response with selected, sensitive, and unselected headers.

## Public API check and withdrawn false lead

During self-review, `APIResponse.timing()` was briefly mistaken for browser `Response.timing()`. Strict typecheck proved browser `Response` has no such public method. The invalid test/implementation attempt was fully removed; no cast or internal Playwright API remains. Timing collection uses only public browser `Request.timing()`, refreshed at the public `requestfinished` event where final values are exposed.

## GREEN and verification evidence

```text
npx vitest run tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts
PASS — 2 files, 4 tests, 0 failures, exit 0

npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts
PASS — 7 files, 115 tests, 0 failures, exit 0

npm run typecheck
PASS — TypeScript strict no-emit compile, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 18 files, 232 tests, 0 failures, exit 0
```

The first restricted-process integration attempt after implementation could not launch Chromium (`spawn EPERM`). The same focused command was rerun with the required local execution permission and passed 4/4. No external site was contacted.

## Changed files

- `src/evidence/collector-handle.ts` — shared idempotent collector listener lifecycle contract.
- `src/evidence/network-collector.ts` — normalized immutable request/response/failure/redirect/resource/header/timing evidence.
- `src/evidence/console-collector.ts` — normalized immutable console warning/error and uncaught page-error evidence.
- `tests/component/network-collector.test.ts` — normalization, timing finalization, status/failure separation, redaction/selection, deep immutability, detach, and isolated-handle coverage.
- `tests/integration/technical-evidence.test.ts` — guarded real-Chromium redirect/404/duplicate-console/warning/pageerror coverage.
- `fixtures/site/js-error.html` — deterministic technical-evidence page.
- `fixtures/server.ts` — internal redirect and broken-image response routes.

## Architecture and safety scans

- Target-specific name/domain/absolute-URL occurrences in `src/**`: 0.
- Absolute URL literals in `src/evidence/**`: 0.
- Finding/fingerprint/rule/severity authoring in `src/evidence/**`: 0.
- navigation/retry/fetch/route/click/evaluate operations in `src/evidence/**`: 0.
- raw response body/text/JSON retention in the network collector: 0. The only `.text()` call under `src/evidence/**` is Playwright `ConsoleMessage.text()`, which is the required console fact.
- Installed Page listeners are symmetric: network installs/removes request, response, requestfailed, and requestfinished; console installs/removes console and pageerror.
- Sensitive header names occur only in the selected-header allowlists. Redaction logic and `[REDACTED]` substitution remain solely in `src/safety/redact.ts` and are consumed through `redactHeaders()`.
- `src/core/contracts.ts` and `src/safety/redact.ts` hashes match the Task 7 baseline. `package.json` and `package-lock.json` hashes are unchanged.

## SHA-256 manifest

```text
7FA24FA1DABCB727BC48E0DD0C1FE6C4D860BE8CA6294CEB4D1F5AB2FF77AAFC  src/evidence/collector-handle.ts
1073B589089A2F782DB67F97A7D7BE43A954A290A71C2DA96AFFF482B8EB94A8  src/evidence/network-collector.ts
0FD132571F8CA06FBCA8A35FE619B38E138CF6DDD594EAD7AA188C17C7C6BD8D  src/evidence/console-collector.ts
544519180041EC28F1A928739703C913727B2B427AE57A18EC8CEF1C5DE431F0  tests/component/network-collector.test.ts
8F2362A2011AE3E5BB42B7F74129FF268355928003CC2CBC88C0A578DA801DD1  tests/integration/technical-evidence.test.ts
E3DE45943B1AC76528C7F89878C224ED5993C45644DD3EE0E7D98204EC3FCDD5  fixtures/site/js-error.html
65A189298F22CD9592FF8BE58C0EBCE48C7972B854CE22D078EC1F9C9941BED9  fixtures/server.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

## Concerns / not run

- No required Task 7 command or gate remains unrun.
- Chromium commands require permission outside the restricted process sandbox; permitted local fixture runs passed.
- Task 14 remains responsible for assembling these raw normalized observations into canonical page Evidence records and assigning canonical Evidence IDs. Task 7 intentionally does not create a parallel `EvidenceRecord` or Finding entry point.
- Independent Task 7 review has not yet run; this report does not mark Task 7 complete.

## Fix Round 1/5

### Entering Important findings and verification

- Synchronous browser `Request.headers()` / `Response.headers()` do not guarantee security/cookie headers. The original mock supplied values the real synchronous API could omit, while the integration test accepted raw-secret absence as proof of redaction. The collector therefore could not truthfully distinguish “observed then redacted” from “not exposed by this API.”
- The selected subset omitted `traceparent`, `tracestate`, and request/correlation ID style headers that Task 10 must consume from canonical Network Evidence. Leaving them out would pressure Task 10 to add a second network-header collection path.

Installed Playwright 1.62.1 exposes public async `Request.allHeaders()` and `Response.allHeaders()`. The fix uses those public APIs only; it does not call browser `Response.timing()`, response-body APIs, or internal Playwright APIs.

### Fix-round RED evidence

After changing only tests/fixtures to put security and telemetry values exclusively in `allHeaders()`, delay header reads out of order, reject header reads, and prove actual server receipt:

```text
npx vitest run tests/component/network-collector.test.ts
FAIL — 1 file, 4 failed / 1 passed, exit 1

npx vitest run tests/integration/technical-evidence.test.ts
FAIL — 1 file, 1 failed / 0 passed, exit 1
```

The component failures separately exposed the synchronous header subset, non-async snapshot, missing explicit failure state, and absent invocation-boundary/in-flight semantics. The real-Chromium failure proved the fixture server received the sensitive and telemetry headers while the collector result still had only the synchronous subset.

### Fixes

- `CollectorHandle<T>.snapshot()` is now explicitly asynchronous for every collector. Console snapshots resolve immediately from a synchronous invocation boundary; Network snapshots await header reads.
- Network event handlers synchronously allocate request IDs, redirect relationships, array positions, status/failure facts, timing, and one immediately-started `allHeaders()` observation per Request/Response.
- A Network snapshot synchronously captures the exact request/response/failure record boundary present at invocation, then awaits all header reads belonging to that boundary. Events observed later cannot enter that snapshot; inverse promise completion cannot reorder or cross-contaminate records.
- `detach()` still removes only the handle's exact listeners and prevents new records. Header reads already started for observed records remain owned by the handle and are awaited consistently by snapshot after detach.
- Public header evidence is discriminated: `{status:'OBSERVED', values}` or `{status:'FAILED', errorText}`. Rejected or synchronously thrown `allHeaders()` cannot masquerade as a successful empty header set. Response `contentLengthHeader` becomes `null` when header observation failed.
- Selected request/response headers now include `traceparent`, `tracestate`, `request-id`, `correlation-id`, `x-request-id`, and `x-correlation-id`. Sensitive values still pass exclusively through the existing `redactHeaders()` SSOT; unselected headers never enter the evidence.
- The real-browser fixture records the actual incoming Authorization, Cookie, trace, request ID, correlation ID, and unselected header values for the technical route. Tests then prove the corresponding collector evidence contains `[REDACTED]` for Authorization/Cookie/Set-Cookie/X-Api-Key, retains telemetry IDs, and omits the unselected secret.

### Fix-round GREEN and regression evidence

```text
npx vitest run tests/component/network-collector.test.ts
PASS — 1 file, 5 tests, 0 failures, exit 0

npx vitest run tests/integration/technical-evidence.test.ts
PASS — 1 file, 1 test, 0 failures, exit 0

npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts
PASS — 7 files, 117 tests, 0 failures, exit 0

npm run typecheck
PASS — TypeScript strict no-emit compile, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 18 files, 234 tests, 0 failures, exit 0
```

The first full-suite run produced 233/234: the pre-existing Task 6 test with a 40 ms absolute deadline returned the correct `PARTIAL / DEADLINE_EXCEEDED` result before any geometry observation, so its assertion requiring `finalSnapshot.atBottom === false` received `undefined`. The exact Task 6 test passed alone (1 passed / 12 skipped), and a fresh unchanged full-suite rerun passed 234/234. No Task 6 source or test was modified.

### Fix-round architecture and safety scans

- Synchronous `.headers()` calls in `src/evidence/**`: 0.
- Public `.allHeaders()` calls: exactly 2, one Request and one Response observation in `network-collector.ts`.
- Finding/fingerprint/rule authoring, response-body access, navigation/routing/fetching/clicking, target identity, and absolute URL literals in `src/evidence/**`: 0.
- Redaction remains delegated to `src/safety/redact.ts`; no duplicate sensitive-value classifier was introduced.
- The two independent-review Minor findings remain deferred as directed: response-first/failure-first ordering characterization and console-specific lifecycle expansion.

### Fix-round SHA-256 manifest

```text
5513CD0424738A8389B22A41209BA7A6B85B89812A0062E0E2CF31DDE506DFF2  src/evidence/collector-handle.ts
242003C5C0FE24C2F2562966229781C52252F4BAAB1222270FC4EF6575EE5604  src/evidence/network-collector.ts
5C00692E780CF75F4E57653A6ADAE172DAE839FB7AD1BF1AAB5793EE57852EAC  src/evidence/console-collector.ts
913EE371ED772292AFEE44762FC08DAB233BBDD719EB7BFC68130FEE38EB4FDA  tests/component/network-collector.test.ts
9331A4DC20EFD2847D4C993FD11B300C46E03B9F1B9E460361CE1D8280C05D92  tests/integration/technical-evidence.test.ts
89704E58A307001AC3AD4DA5384D17E083F41872B5548C826EF10C2943F75242  fixtures/server.ts
E3DE45943B1AC76528C7F89878C224ED5993C45644DD3EE0E7D98204EC3FCDD5  fixtures/site/js-error.html
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

No required Fix Round 1 verification remains unrun. Independent re-review remains pending; Task 7 is not marked complete.
