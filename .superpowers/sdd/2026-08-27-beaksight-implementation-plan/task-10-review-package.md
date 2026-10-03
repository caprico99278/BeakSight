# Task 10 independent review package — Git-free SDD

Status: ready for independent review. Git operations are prohibited.

## Review authority

Review Task 10 against, in precedence order:

1. `AGENTS.md` and any repository-local instructions.
2. `doc/design/2026-08-27-beaksight-web-audit-design.md`.
3. `doc/design/2026-08-27-beaksight-implementation-tasks.md`, Task 10.
4. `task-10-brief.md` and the factual progress ledger.

The implementation author must not perform this review. Review is read-only: do not edit files, use Git, download dependencies, access a live target, or spawn another agent.

## Fixed review scope

- Primary production: `src/evidence/performance-collector.ts`
- Focused tests: `tests/component/performance-collector.test.ts`, `tests/integration/performance-evidence.test.ts`
- Canonical network input authority: `src/evidence/network-collector.ts`
- Guarded lifecycle authorities: `src/evidence/collector-handle.ts`, `src/browser/context-factory.ts`
- Core contracts and dependency authorities: `src/core/contracts.ts`, `package.json`, `package-lock.json`, installed attribution IIFE

Verify every manifest entry before reading conclusions. A mismatch is a blocking scope-integrity finding.

## Required review questions

1. Does installation read the already installed attribution IIFE independent of process cwd, call only public `BrowserContext.addInitScript`, install exactly once per context across collector instances and concurrent callers, and remain retryable after read/add failure?
2. Does each document get fresh closure-backed bounded state, all five callback registrations, honest `UNSUPPORTED` versus `NOT_OBSERVED`, and no fabricated INP/CLS values? Can page assignment or mutation replace internal state?
3. Are retained metric and attribution facts bounded primitive allowlists only, with no DOM nodes, raw entries, cycles, callbacks, arbitrary library objects, or outbound telemetry APIs?
4. Does collection use exactly one read-only `page.evaluate`, no network/header/redaction listener or reread, and canonical Task 7 `NetworkEvidence` as its only network truth?
5. Is the absolute deadline authoritative at entry, timer completion/rejection, normalization, and before/after terminal construction? Are late resolve/reject paths handled without unhandled rejection or later mutation? Are evaluation and invalid-data PARTIAL reasons truthful?
6. Are Navigation, Resource, Server-Timing, and all Web Vital numeric values finite and nonnegative? Are missing versus invalid values represented without fabricating numbers? Are bounds enforced before retention?
7. Is duplicate-URL resource correlation deterministic and truthful, with network-resource categorization preferred only when an actual Task 7 request matches and initiator fallback explicitly identified?
8. Are resource summaries correct for script, stylesheet, image, and fetch/xhr without claiming unknown categories?
9. Are selected telemetry headers cloned only from caller evidence, failed header observations preserved, values/names/IDs/URLs bounded, generic hints frozen, matching basis explicit, and candidates never overstated as true telemetry traces? Check mutable caller input, nested immutability, and query/header data minimization.
10. Is every returned object/list deeply immutable, including PARTIAL paths, telemetry records, nested header value maps, attributions, server timing, summaries, and matching arrays?
11. Does real-Chromium coverage prove install-before-navigation through the guarded lifecycle, no extra request/telemetry traffic, available vitals/timing without requiring INP, and local-fixture-only execution?
12. Check for forbidden Findings/Evidence IDs/fingerprints/rules/performance thresholds, bodies/secrets, target identity, CDP/internal APIs, dependency drift, and duplicated lifecycle/network ownership.

Pay special attention to support detection for INP/TTFB, `import.meta.resolve` package-subpath behavior, timer boundary equality, malformed browser arrays/objects, Server-Timing duration validation, exact URL queue correlation, and whether page code can tamper with the public snapshot contract.

## Finding policy

Report Critical and Important findings with exact file/line, a concrete counterexample, design/brief impact, and the smallest safe correction. Report Minor findings separately. If there are no Critical/Important findings, state `PASS` explicitly. Run only focused tests needed to validate a concrete suspicion; do not rerun broad suites merely to duplicate the implementer report.

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
