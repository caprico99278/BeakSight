# Task 10 implementation brief — Git-free SDD

Execute Task 10 from the implementation plan under the higher-priority tasks/design documents and progress ledger. Git operations are prohibited.

## Scope and API ruling

- Create `src/evidence/performance-collector.ts`, `tests/component/performance-collector.test.ts`, and `tests/integration/performance-evidence.test.ts`.
- Use the already installed local `web-vitals` 6.1.0 attribution IIFE. Do not add/download a dependency.
- To preserve Task 7 as the sole Network observer, use an explicit API equivalent to `PerformanceCollector.collect(page, networkEvidence, options)`. Task 10 must consume the canonical Task 7 `NetworkEvidence`; it must not attach listeners, reread browser headers, or create a parallel network model.

## Before-navigation installation

- `PerformanceCollector.installBeforeNavigation(context)` resolves and reads `web-vitals/dist/web-vitals.attribution.iife.js` from the installed package in Node (independent of process cwd), then passes script content to public `context.addInitScript()` before Page navigation.
- Installation is idempotent per BrowserContext across collector instances, but a failed add/read is not marked installed and remains retryable. Do not create a Page, navigate, route, fetch, send telemetry, or modify Task 5 policy.
- The init script creates a fresh bounded page-global state for each document and registers `onCLS`, `onFCP`, `onINP`, `onLCP`, and `onTTFB`. It stores only the latest bounded normalized metric facts. Initial state distinguishes browser/library `UNSUPPORTED` from supported-but-not-yet-observed `NOT_OBSERVED`; INP without an interaction stays `NOT_OBSERVED` and never becomes zero.
- Retain bounded primitive attribution only for CLS/LCP/INP using explicit field allowlists. Never retain DOM nodes, raw performance entries, cycles, callbacks, or arbitrary library objects. The init script must make no outbound request/beacon and must tolerate page code attempting to replace the public global without silently losing the internal state.

## Collection and completion

- Collect after page settling/scroll in one read-only `page.evaluate()`. Use a required absolute deadline (same authority style as Task 6) with entry, timer, and post-completion adjudication; attach late rejection handling. A timeout returns immutable `PARTIAL / DEADLINE_EXCEEDED` evidence and never fails the Run by itself. Evaluation failure returns explicit PARTIAL reason; never synthesize numeric values.
- Web Vital entries have `OBSERVED | NOT_OBSERVED | UNSUPPORTED` plus `value: number | null`. Validate observed values as finite/nonnegative (CLS may be zero only when truly observed). Copy bounded IDs/ratings/navigation type and allowed attribution.
- Preserve bounded Navigation Timing and Resource Timing fields, including DOMContentLoaded/load, transfer/encoded/decoded sizes, and bounded Server-Timing name/description/duration. Validate all browser numbers as finite/nonnegative and never retain raw entry handles.
- Produce resource summaries for script, stylesheet, image, and fetch/xhr. Use Task 7 request IDs/URLs/resource types to categorize when available, with transparent fallback to public initiator type; do not pretend a category is known when it is not.

## Telemetry evidence from Task 7

- Clone/freeze only caller-supplied Task 7 facts. Extract browser-visible `traceparent`, `tracestate`, request-id, correlation-id and x-prefixed variants from already-redacted request/response `HeaderEvidence`; preserve `FAILED` header observation truthfully. Never reread or re-redact headers.
- Record bounded telemetry/analytics *candidate* request metadata using a frozen generic hint authority and/or the presence of trace/correlation headers. Store the matching basis explicitly and never call these candidates true RUM/APM traces or infer server-private spans. Do not retain bodies or secrets.
- The performance result and every nested list/object must be deeply immutable and bounded. No Findings, Evidence IDs, fingerprinting, rules, thresholds-based performance judgment, or cross-page aggregation.

## TDD and verification

1. Add focused tests before production and capture genuine RED.
2. Cover idempotent/retryable init installation and local-bundle resolution, all five vital states including missing INP, bounded attribution, navigation/resource/server timing mapping, resource summaries, canonical NetworkEvidence telemetry extraction, header failure, deadline/evaluation PARTIAL behavior, late completion isolation, finite validation, and deep freeze.
3. Real Chromium integration must install before navigation through the guarded Task 5/6 lifecycle, verify the page-global emits no network traffic, observe available vitals/timing without requiring INP, and use only local fixtures.
4. Run Task 5–10 adjacent regression, typecheck, build, standard full, and single-worker full if a known timing issue recurs.
5. Scan for duplicate network listeners/header reads/redaction, telemetry send APIs, bodies/secrets, unbounded state, Findings/IDs/rules, target identity, internal browser APIs, and dependency drift. Write `task-10-report.md`, append factual progress, and leave completion to independent review.
