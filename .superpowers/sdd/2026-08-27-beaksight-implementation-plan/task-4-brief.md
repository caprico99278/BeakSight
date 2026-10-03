### Task 4: Build the local fixture server and server-side mutation counters

**Files:**
- Create: `fixtures/server.ts`
- Create: `fixtures/site/index.html`
- Create: `fixtures/site/post-form.html`
- Create: `fixtures/site/put-request.html`
- Create: `fixtures/site/external-link.html`
- Create: `fixtures/site/mailto-link.html`
- Create: `fixtures/site/tel-link.html`
- Test: `tests/integration/fixture-server.test.ts`

**Interfaces:**
- `startFixtureServer(): Promise<FixtureServer>` where `FixtureServer` exposes `origin`, `resetCounters()`, `getCounters()`, `close()`.
- Counters distinguish `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, WebSocket upgrade, and download hits.

- [ ] **Step 1: Write the failing fixture-server test**

```ts
it('records mutation endpoint hits independently from browser logic', async () => {
  const server = await startFixtureServer();
  const response = await fetch(`${server.origin}/__mutation`, { method: 'POST' });
  expect(response.status).toBe(204);
  expect(server.getCounters().post).toBe(1);
  await server.close();
});
```

- [ ] **Step 2: Implement a dependency-free Node HTTP fixture server**

Use `node:http`, route static fixture files safely under `fixtures/site`, provide `/__mutation` for all methods, `/__download` with `Content-Disposition: attachment`, and `/__counters` for debugging. Resolve paths and reject traversal outside the fixture directory.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/integration/fixture-server.test.ts
```

Commit:

```bash
git add fixtures tests/integration/fixture-server.test.ts
git commit -m "test: add BeakSight fixture server"
```

---

## Authoritative addendum

- This fixture is the independent server-boundary authority used later by Safety Gates. Browser-side “abort called” assertions are insufficient without these counters.
- Counters must distinguish `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, WebSocket upgrade, and download hits. Resetting counters must be explicit and deterministic.
- The fixture server is test infrastructure only. Its deliberate mutation `fetch` calls do not authorize any production network path outside guarded Playwright BrowserContexts.
- Bind only to loopback on an ephemeral port. Expose a canonical `origin` and idempotent `close()` behavior suitable for reliable test cleanup.
- Static path resolution must decode/normalize safely, reject traversal (including encoded traversal), and never escape `fixtures/site`.
- Fixture pages remain generic and deterministic; no initial target identity/domain belongs in them.
- Later tasks extend this same `fixtures/server.ts`; do not create a parallel fixture server entry point.
- Add observable tests for independent method counters, reset, GET/HEAD static serving, download hit, traversal rejection, and reliable close behavior where practical within Task 4 scope.
- Git operations and commits are prohibited. Report `Commits created: NOT APPLICABLE (Git prohibited)`.

---

