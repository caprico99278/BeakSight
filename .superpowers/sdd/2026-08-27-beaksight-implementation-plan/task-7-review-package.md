# Task 7 — Git-free independent review package

Git operations are prohibited. Verify all hashes before reviewing. This is a read-only independent review; do not edit or spawn subagents.

## Review scope

Review Task 7 against Task 7 of `doc/design/2026-08-27-beaksight-implementation-plan.md`, the binding Evidence-before-Finding/data-minimization rules in `doc/design/2026-08-27-beaksight-implementation-tasks.md` and `doc/design/2026-08-27-beaksight-web-audit-design.md`, `task-7-brief.md`, the progress-ledger rulings, and `task-7-report.md`.

Confirm:

1. `NetworkCollector.attach(page)` passively preserves request, response, requestfailed, redirects/chain, resource type, public timing where exposed, size headers, and a deliberately selected/redacted header subset without response bodies, navigation/routing/retry, or Findings.
2. `ConsoleCollector.attach(page)` separately preserves duplicate error/warn observations and uncaught page errors, with source/location/stack facts where public Playwright APIs expose them; it does not aggregate/fingerprint or create Findings.
3. Handles remove exactly their own listeners, detach idempotently, stop late collection, isolate per-page/per-attach state, and return repeatable deeply immutable snapshots without retaining Playwright handles.
4. Redirect correlation and `requestfinished` timing refresh are correct for event ordering, requests first discovered from response/failure, and separate request/response/failure facts.
5. Header selection/redaction genuinely uses the existing `redactHeaders()` SSOT, avoids retaining unselected headers, and does not make claims unsupported by the public browser Request/Response APIs. Pay particular attention to Playwright's synchronous `headers()` completeness versus `allHeaders()` and whether the chosen contract/tests truthfully match what is collected.
6. Fixture/test coverage genuinely demonstrates one uncaught exception, warn, duplicate console errors, 404 image, redirect evidence, redaction/selection, immutable snapshots, detach, isolation, and final timing. Confirm no unsafe bypass of Task 5/6 lifecycle.
7. `src/**` stays target-agnostic and Task 14 remains the sole future assembler of canonical `EvidenceRecord`/IDs.

Implementer reports focused 4/4, Task 5-7 adjacent 115/115, full 232/232, typecheck/build PASS. Do not rerun broad verification absent concrete suspicion; focused tests may be run when needed. Classify findings Critical/Important/Minor with exact file/line evidence and conclude PASS/NEEDS FIXES.

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
