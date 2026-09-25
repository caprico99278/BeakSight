# Task 7 implementation brief — Git-free SDD

Execute Task 7 from `doc/design/2026-08-27-beaksight-implementation-plan.md`, subject to the higher-priority implementation tasks document and the progress ledger. Git operations are prohibited.

## Scope

- Create `src/evidence/network-collector.ts` and `src/evidence/console-collector.ts`; a narrowly shared evidence type/handle module is permitted when it avoids duplicate lifecycle semantics.
- Create `tests/component/network-collector.test.ts`, `tests/integration/technical-evidence.test.ts`, and `fixtures/site/js-error.html`.
- Extend `fixtures/server.ts` only as needed for the broken-image and redirect evidence scenarios.
- Existing libraries are sufficient. Do not download/import a new package; if genuinely necessary, stop and return for approval.

## Binding behavior

- `NetworkCollector.attach(page): CollectorHandle<NetworkEvidence>` and `ConsoleCollector.attach(page): CollectorHandle<ConsoleEvidence>` attach before navigation.
- A handle owns exactly its installed listeners, has an idempotent detach/stop operation, and returns repeatable immutable snapshots that cannot mutate internal state. Late events after detach must not enter the snapshot. Multiple collectors/pages must not share state.
- Network observations preserve requests, responses, failures, redirect relationships/chain, resource type, Playwright timing where exposed, size headers, and a deliberately selected header subset after passing through the existing `redactHeaders()` SSOT. Never store response bodies or unselected headers. Keep status/failure distinct; do not turn redirects, 4xx/5xx, or failures into Findings.
- Console observations preserve every `console.error`, every `console.warn`, and every uncaught `pageerror` separately, including duplicates and source/stack/location facts where Playwright exposes them. Do not fingerprint, aggregate, or create Findings.
- Public evidence and every nested structure exposed from snapshots are immutable. Normalize data at the collector boundary; do not retain caller-owned mutable objects.
- Observation must not navigate, retry, fetch, route, alter Task 5 policy, or use Task 6 lifecycle operations. Collectors consume a ready Page and are passive event observers.
- Keep `src/**` target-agnostic and avoid a parallel `EvidenceRecord`/Finding authoring path. Collector evidence is raw normalized input for later Task 14 assembly and rules.

## TDD and verification

1. Write focused failing tests first and record exact RED evidence.
2. Implement the minimum behavior, then run focused component/integration tests.
3. Run request-policy/redaction and Task 5/6 collector-adjacent regressions, `npm run typecheck`, `npm run build`, and full `npm test`.
4. Scan `src/**` for target-specific identifiers, collector-created Findings, raw response-body retention, duplicate redaction logic, and listener leaks.
5. Write `task-7-report.md` with changed files, RED/GREEN evidence, architecture/safety checks, commands actually run, not-run ledger, concerns, and SHA-256 hashes.

Do not edit the progress ledger beyond appending factual Task 7 implementation status. Do not claim Task 7 complete; independent review follows.
