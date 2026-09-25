# Task 10 fix round 1/5 — Git-free SDD

Status: eight independent-review Important findings must be fixed by the original implementer. Git operations are prohibited.

## Fixed input manifest

Before editing, verify the Task 10 review manifest in `task-10-review-package.md` still matches 10/10. Stop and report any mismatch.

## Entering findings

1. `src/evidence/performance-collector.ts:232-244`: INP and TTFB support predicates do not match the installed `web-vitals` 6.1.0 behavior. INP needs the library's `PerformanceEventTiming.prototype.interactionId` capability guard; TTFB must not require a constructor the library does not require.
2. `src/evidence/performance-collector.ts:417-435,511-521,908-982`: deadline/evaluation failure fabricates `NOT_OBSERVED` metrics without observing capability, and invalid observed data is relabeled `NOT_OBSERVED`.
3. `src/evidence/performance-collector.ts:669-675,796-848,965-1000`: unbounded NetworkEvidence traversal occurs before the first deadline check and again after evaluation.
4. `src/evidence/performance-collector.ts:562-568,603-605,679-684`: malformed non-array navigation/resource/server-timing containers can return COMPLETE.
5. `src/evidence/performance-collector.ts:669-725`: duplicate URL queues can bind Resource Timing to a main-document or incompatible Task 7 request.
6. `src/evidence/performance-collector.ts:655-665`: Resource Timing `initiatorType: 'css'` is falsely classified as a stylesheet resource.
7. `src/evidence/performance-collector.ts:669-675,965-986`: resource correlation rereads mutable caller NetworkEvidence after `page.evaluate`, while telemetry uses earlier values.
8. `src/evidence/performance-collector.ts:735-750`: finite resource sizes can overflow summary totals to Infinity while status remains COMPLETE.

## Binding rulings

### Vital availability

- Change performance facts so `webVitals` may be `null` when browser Vital collection was not obtained or was invalid. `null` means unavailable, not `NOT_OBSERVED`.
- Entry deadline and evaluation failure return `webVitals: null`. They must not speculate about per-metric browser support.
- Validate the complete five-metric browser object as one availability unit. If any metric state/value is malformed, return `PARTIAL / INVALID_BROWSER_DATA` with `webVitals: null`; do not recast an invalid observed metric as `NOT_OBSERVED` or preserve a partly misleading Vital set.
- A validated supported metric with no callback remains `NOT_OBSERVED`; an honestly unsupported metric remains `UNSUPPORTED`; only a valid callback can create `OBSERVED`, including CLS zero.
- Align initialization support checks with the installed local library. Add executable init-script capability-matrix tests, including Event Timing without `interactionId` and navigation-entry support without a global `PerformanceNavigationTiming` constructor.

### Deadline-bounded canonical NetworkEvidence projection

- Check the absolute deadline immediately after option validation, before any NetworkEvidence traversal.
- Before the first await, synchronously clone/freeze one bounded projection containing only request/response fields needed for resource correlation and telemetry. Use this projection everywhere after the await; never reread caller evidence.
- Add explicit request/response projection bounds sized to the Task 10 retention needs. Check the deadline during projection. If the deadline is reached, return immutable `PARTIAL / DEADLINE_EXCEEDED` without evaluation or speculative telemetry facts.
- Do not add listeners, header reads, redaction, bodies, new network models, or dependency changes. The projection is a bounded detached view of canonical Task 7 evidence only.

### Timing validation and correlation

- Actual empty navigation/resource/Server-Timing arrays remain valid. Missing or non-array containers are invalid browser data and must not be treated as valid empty observations.
- Exclude main-document/navigation requests from Resource Timing correlation.
- Correlate exact untruncated URL identity only to unused compatible non-document Task 7 requests. Use deterministic ordering only when compatibility makes the association unambiguous; otherwise leave `requestId`/`networkResourceType` null and use the public initiator fallback truthfully.
- Remove `css -> stylesheet`. CSS is an initiator, not the fetched resource class. Without a compatible Task 7 match, classify it as UNKNOWN.

### Finite summaries

- Checked addition is required for count and every byte total. If any sum would become non-finite/unsafe, return `PARTIAL / INVALID_BROWSER_DATA` and make the affected aggregate unavailable rather than emitting Infinity, clamping, or fabricating a total.
- Therefore `resourceSummaries` may be `null` on invalid aggregate data. Valid and empty summaries retain the current fully frozen shape.

## TDD requirements

Create genuine focused RED tests before production edits for all eight findings, including:

- initialization capability matrices for INP and TTFB;
- entry timeout/evaluation failure yielding `webVitals: null`, and invalid observed Vital invalidating the whole Vital set;
- deadline checked before NetworkEvidence traversal/evaluation, bounded projection, and mutation during pending evaluate unable to affect any result;
- malformed navigation/resource/serverTiming containers;
- document+fetch same-URL correlation, incompatible/ambiguous duplicate URLs, and deterministic compatible duplicates;
- CSS-initiated image remaining UNKNOWN without Task 7 type evidence;
- two finite `Number.MAX_VALUE` resource sizes producing no Infinity/null-on-JSON corruption.

Preserve existing successful coverage. Update integration expectations only where the public nullable contract requires it. Do not weaken the guarded no-extra-traffic proof.

## Verification and handoff

- Run focused Task 10 component/integration tests, Task 5-10 adjacent regressions, typecheck, build, and a fresh standard full suite. Run single-worker full only if the known timing issue recurs.
- Scan for duplicate network/header/redaction paths, unbounded traversal, non-finite output, dependency drift, and prohibited target-specific or internal-browser tokens.
- Append factual results to `task-10-report.md` and `progress.md` and provide a fresh SHA-256 manifest. Do not declare Task 10 complete; independent re-review remains required.
- No Git, package install/update/download, live target access, or subagent use.
