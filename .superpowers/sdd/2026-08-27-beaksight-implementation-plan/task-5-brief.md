### Task 5: Implement Safety Guard, Safety Ledger, and header redaction

**Files:**
- Create: `src/safety/request-policy.ts`
- Create: `src/safety/safety-ledger.ts`
- Create: `src/safety/redact.ts`
- Test: `tests/unit/request-policy.test.ts`
- Test: `tests/unit/redact.test.ts`
- Test: `tests/integration/passive-request-guard.test.ts`

**Interfaces:**
- `isReadMethod(method: string): boolean`.
- `installPassiveRequestGuard(context: BrowserContext, ledger: SafetyLedger, allowedOrigins: ReadonlySet<string>): Promise<void>`.
- `SafetyLedger.recordBlockedRequest(...)`, `snapshot(): SafetyLedgerSnapshot`.
- `redactHeaders(headers: Record<string,string>): Record<string,string>`.

- [ ] **Step 1: Write failing request-policy tests**

Assert only case-insensitive GET/HEAD are allowed. OPTIONS is blocked because the approved authority is exactly GET/HEAD.

- [ ] **Step 2: Write failing redaction tests**

Assert `authorization`, `cookie`, `set-cookie`, `x-api-key`, and token/session-name candidates become `[REDACTED]`, while `content-type` remains visible.

- [ ] **Step 3: Implement pure request policy and redaction**

Do not put Playwright objects in the pure policy module. This keeps safety classification unit-testable.

- [ ] **Step 4: Write the failing server-side safety integration test**

Navigate to `post-form.html`, invoke the page-side form submission deliberately in the fixture environment, then assert:

```ts
expect(server.getCounters().post).toBe(0);
expect(ledger.snapshot().blockedRequestsByMethod.POST).toBeGreaterThan(0);
```

This proves S01 at the server boundary.

- [ ] **Step 5: Implement BrowserContext route interception**

Use `context.route('**/*', ...)` before any page is created. `GET`/`HEAD` subresources may continue, including CDN resources required to render the page. A main-frame navigation request whose origin is not in `allowedOrigins` is aborted and recorded as a blocked navigation; every non-read method is aborted and recorded. Install a WebSocket route before page creation that records and refuses server connection, because passive WebSocket traffic cannot be proven read-only. Create contexts with `serviceWorkers: 'block'` so required interception cannot be bypassed by a service worker. If blocking a WebSocket or non-read dependency prevents complete rendering, the page must later be marked partially observed rather than silently passed.

- [ ] **Step 6: Verify S01/S02 plus external-navigation/WebSocket blocking primitives and commit**

Extend the integration test for PUT/PATCH/DELETE and assert fixture counters remain zero. Add a fixture redirect toward another origin and assert the main-frame external follow-up is blocked while ordinary external-origin image/script GET subresources remain renderable. Add a passive WebSocket attempt and assert no fixture WebSocket server connection is established.

```bash
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts
npx vitest run tests/integration/passive-request-guard.test.ts
```

Commit:

```bash
git add src/safety tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts
git commit -m "feat: enforce read-only network authority"
```

---

## Authoritative addendum and Task 5 checkpoint

- Passive HTTP safety decisions have one production owner: `src/safety/request-policy.ts`.
- The pure decision API in `request-policy.ts` owns method/origin/navigation/WebSocket classification. `installPassiveRequestGuard()` is a thin Playwright adapter that delegates every decision to that owner; it must not implement a second set of conditions.
- Only `GET` and `HEAD` are read-authorized, case-insensitively. `OPTIONS` and every other method are blocked before server delivery.
- Main-frame external-origin navigation is blocked and ledgered. Ordinary external-origin GET/HEAD subresources may render; this exception must not grant external top-level navigation authority.
- Passive WebSocket connection is blocked before server connection and recorded. Service workers must be blocked by context construction wherever interception guarantees are required; tests in this task create contexts accordingly.
- Install all interception before any page is created or target request can begin. A guard-installation failure must reject explicitly; callers must never continue unguarded.
- `SafetyLedger` is the sole event/count authority for blocked requests, navigations, WebSockets, and invariant violations. Snapshots are immutable copies; a successful block is evidence, not an invariant violation.
- Header redaction is case-insensitive and must redact `Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`, and token/session/API-key-like names without exposing the original value. Preserve non-sensitive headers.
- Safety decisions stay target-agnostic and depend on injected allowed origins. Canonicalize allowed origins without creating a second crawl-admission implementation; this policy is network authority, not crawl scope.
- The mandatory Task 5 checkpoint requires server-boundary proof that POST, PUT, PATCH, and DELETE counters remain zero; external main-frame and passive WebSocket attempts are blocked; allowed GET/HEAD rendering still works; ledger records every block with zero invariant violations.
- Add mutation-catching tests for case variants/unknown methods, guard installation ordering/failure, immutable snapshots, external main-frame vs subresource distinction, redirects, WebSocket server counter, and sensitive-name redaction.
- Git operations and commits are prohibited. Report `Commits created: NOT APPLICABLE (Git prohibited)`.

---

