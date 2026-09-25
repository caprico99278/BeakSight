# Task 4 report: local fixture server and server-side mutation counters

## Outcome

Implemented the canonical `startFixtureServer()` test-infrastructure entry point in `fixtures/server.ts`. It starts a dependency-free Node HTTP server on loopback (`127.0.0.1`) and an ephemeral port, exposes an `origin`, immutable counter snapshots, explicit reset, and idempotent shutdown.

The fixture server provides:

- safe static serving rooted at `fixtures/site`;
- a deliberate `POST`/`PUT`/`PATCH`/`DELETE`-capable `/__mutation` test endpoint;
- `/__download` with attachment disposition;
- `/__counters` debugging JSON;
- per-method `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, WebSocket-upgrade, and download counters.

The pages are deterministic and generic, with no target-specific identity or domain.

## Files changed

- `fixtures/server.ts` — canonical loopback HTTP fixture server, safe static resolver, counters, upgrade handling, and idempotent close.
- `fixtures/site/index.html` — generic fixture home page.
- `fixtures/site/post-form.html` — generic POST-form fixture.
- `fixtures/site/put-request.html` — generic PUT-request fixture.
- `fixtures/site/external-link.html` — generic external-link fixture.
- `fixtures/site/mailto-link.html` — generic mailto-link fixture.
- `fixtures/site/tel-link.html` — generic telephone-link fixture.
- `tests/integration/fixture-server.test.ts` — observable integration coverage for counters, reset, static/HEAD responses, download, encoded traversal, WebSocket upgrade, and shutdown.

## Strict TDD evidence

### RED 1 — new server API absent

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 failed (1)
Tests  no tests
Error: Cannot find module '../../fixtures/server.js'
```

This failed at the intended missing canonical fixture-server module boundary before production implementation existed.

### GREEN 1 — initial implementation

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 passed (1)
Tests  5 passed (5)
```

### RED 2 — encoded dot-segment traversal regression

During path-safety review, a raw HTTP request regression test was added for `/%2e%2e/index.html` (not a normalized `fetch` URL).

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
AssertionError: expected 200 to be 400
```

Root cause: parsing the request target with `new URL()` normalized encoded dot segments before the static resolver inspected them.

### GREEN 2 — raw path validation

The server now separates the raw path from query/fragment before decoded traversal validation.

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 passed (1)
Tests  5 passed (5)
```

## Final verification

All commands were rerun after the final source change.

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

```text
Test Files  1 passed (1)
Tests  5 passed (5)
```

```powershell
npm run typecheck
```

```text
> tsc -p tsconfig.json --noEmit
exit code 0
```

```powershell
npm run build
```

```text
> tsc -p tsconfig.build.json && node --input-type=module ...
exit code 0
```

## Self-review

- **Path safety:** The resolver validates the raw request path before URL normalization, decodes once, rejects malformed encoding, NULs, backslashes, and `..` path segments, then enforces both lexical and real-path containment beneath the real fixture-site directory. The raw encoded-dot regression test proves a normalized traversal form is rejected.
- **GET/HEAD semantics:** Static and download responses set matching `Content-Length`; `HEAD` sends no body. The integration test verifies a static `HEAD` response has an empty body while preserving its content length.
- **Counter correctness:** Every supported HTTP method is counted independently. Download and WebSocket upgrade counters are separate from method counters. `getCounters()` returns a newly allocated frozen copy, and `resetCounters()` resets every key deterministically.
- **Cleanup/idempotence:** `close()` stores and returns one close promise and calls `closeAllConnections()` so idle or persistent connections cannot hold test cleanup open. The integration test calls it concurrently twice and verifies subsequent requests fail.
- **Determinism and scope:** All fixture page contents and the download body are stable and generic. Deliberate mutation requests appear only in `tests/integration/fixture-server.test.ts` and fixture-page test infrastructure.

## Concerns

None. The only non-project output was npm's version-update notice, which does not affect test, typecheck, or build outcomes.

## Commits

Commits created: NOT APPLICABLE (Git prohibited)

## Fix Round 1 / 5

### Findings resolved

1. **Upgrade handling is now fail-closed.** The server recognizes only a case-insensitive `Upgrade: websocket` value as a WebSocket upgrade hit. It responds with `426 Upgrade Required`, `Connection: close`, an `Upgrade: websocket` hint, and no body; it does not attempt a WebSocket handshake. Other upgrade values receive `400 Bad Request` with `Connection: close` and do not increment the WebSocket counter. Every upgraded socket is tracked, removed on socket close, and explicitly destroyed during `FixtureServer.close()` before ordinary connections are closed.
2. **Static resolution and route methods now have distinct HTTP semantics.** Invalid, malformed, traversal, or escaping paths remain `400`; valid paths contained within the fixture root but absent on disk return `404`. Unsupported HTTP methods return `405` with a route-appropriate `Allow` header. Recognized method requests are still counted when they reach the server, including when the addressed route rejects that method; unrecognized methods do not modify supported-method counters.

### Files changed in this round

- `fixtures/server.ts`
- `tests/integration/fixture-server.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-4-report.md`

### Strict TDD evidence

#### RED 1 — upgrade classification, missing path, and unsupported method

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 failed (1)
Tests  4 failed | 4 passed (8)

WebSocket request: expected HTTP/1.1 426 Upgrade Required, received 101 Switching Protocols
Missing in-root fixture: expected 404, received 400
OPTIONS /__mutation: expected 405, received 204
Non-WebSocket h2c upgrade: expected 400 Bad Request, received 101 Switching Protocols
```

#### GREEN 1 — fail-closed upgrade and HTTP distinction changes

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 passed (1)
Tests  8 passed (8)
```

#### RED 2 — rejected recognized methods still count as server hits

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 failed (1)
Tests  1 failed | 8 passed (9)
Expected the POST counter to be 1 after POST /index.html returned 405; received 0.
```

#### GREEN 2 — counter preserves observed recognized method

Command:

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

Output summary:

```text
Test Files  1 passed (1)
Tests  9 passed (9)
```

### Final verification

```powershell
npx vitest run tests/integration/fixture-server.test.ts
```

```text
Test Files  1 passed (1)
Tests  9 passed (9)
```

```powershell
npm run typecheck
```

```text
> tsc -p tsconfig.json --noEmit
exit code 0
```

```powershell
npm run build
```

```text
> tsc -p tsconfig.build.json && node --input-type=module ...
exit code 0
```

### Round self-review and concerns

- A valid WebSocket upgrade is deliberately rejected rather than partially handshaken; the client-side raw socket is never ended or destroyed by the test, observes the server's close, and is followed by a direct successful `server.close()` assertion.
- Non-WebSocket upgrade values are not mislabeled in the counter. Upgrade sockets are tracked even though the handler immediately closes them, providing shutdown defense for any in-flight close.
- The resolver preserves rejection of encoded traversal while distinguishing a valid missing file from an unsafe path.
- `OPTIONS` makes no supported-method counter change; a recognized `POST` that reaches a GET/HEAD-only static route is correctly recorded and receives `405`/`Allow` rather than being handled as GET.
- No concerns. The npm update notice is unrelated to project verification.
