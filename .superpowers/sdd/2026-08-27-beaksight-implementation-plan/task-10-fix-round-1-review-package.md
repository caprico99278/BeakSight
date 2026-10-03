# Task 10 fix round 1 independent re-review — Git-free SDD

Status: ready for fresh independent re-review. Git operations are prohibited.

## Scope integrity

Verify all 13 SHA-256 entries before review. Any mismatch is blocking. Review is read-only: no edits, Git, downloads, live targets, or subagents.

Review the eight entering findings and binding rulings in `task-10-fix-round-1-brief.md` against the design, implementation plan, Task 10 brief, and current code/tests. Also independently review the narrowly scoped Task 6 first-render-frame maintenance described below.

## Required Task 10 adjudication

For each of the eight entering Important findings, state `ADDRESSED`, `PARTIAL`, or `OPEN` with exact source/test lines and a concrete counterexample if not addressed. In particular verify:

- INP needs Event Timing plus `PerformanceEventTiming.prototype.interactionId`; TTFB does not falsely require its constructor.
- entry/evaluation unavailable and any malformed Vital set yield `webVitals: null`; valid missing INP alone remains `NOT_OBSERVED`.
- deadline precedes all caller traversal; one bounded detached projection is made before await and the original caller is never reread.
- missing/non-array navigation/resource/server-timing containers become invalid while actual empty arrays stay valid.
- resource correlation excludes document requests; known initiators require compatible network category; unknown initiators do not claim heterogeneous duplicate URL candidates; compatible duplicates are consumed deterministically.
- CSS initiator alone remains UNKNOWN.
- all sums remain finite and safe; invalid aggregate has `resourceSummaries: null` and PARTIAL, never Infinity/clamping/fabrication.
- all outputs stay deeply immutable and no duplicate network/header/redaction/telemetry path or new dependency exists.

Inspect bounds and exact URL correlation for truncation/alias risks. Check late rejection/deadline behavior was not weakened by the new projection.

## Required Task 6 maintenance adjudication

`controlledScroll` now awaits one first `requestAnimationFrame` inside its existing reset evaluation. Verify that:

- it solves the real lazy-content failure at the cause rather than weakening assertions;
- it uses no arbitrary wait and adds no extra browser evaluation;
- outer deadline racing still handles a missing/late frame;
- the callback rechecks the absolute page deadline after the frame and cannot scroll after a timeout result;
- evaluation failure/page close classification and existing exactly bounded mutation semantics remain correct.

## Verification policy

Run only focused tests needed for a concrete suspicion. Browser launch permission may be requested for the focused Task 10/Task 6 tests. Do not duplicate broad reported suites without cause. PASS requires no Critical/Important finding in either the Task 10 fix or Task 6 maintenance. List Minors separately.

## SHA-256 manifest

```text
56A7E29099B5E95A9A1CF6059229E6170BDA5EEE456BBF2D49467EAE66A7CD20  src/evidence/performance-collector.ts
60530593F649429317C241D38F8B2A91BDBB6D95B70A2AE6DD4B816F5E68DC86  tests/component/performance-collector.test.ts
B19B3909C5856A3A4572166F8D96C77AA4A253F068E15046B26752D7E30701F9  tests/integration/performance-evidence.test.ts
0DBF72975C5A34DE842BB52C724739EE478015B2A638CDFE682CC1BD2986ABEF  src/browser/controlled-scroll.ts
8E4778202AC122AC5F701BF624A4D21F4B2F0154268BD475DA129DB4C5A6C1B1  tests/integration/controlled-scroll.test.ts
91B80876EDF24A46C494215E0CC59D23F1632750852AF7F7DAFDF1304B5E1768  fixtures/site/lazy-content.html
242003C5C0FE24C2F2562966229781C52252F4BAAB1222270FC4EF6575EE5604  src/evidence/network-collector.ts
5513CD0424738A8389B22A41209BA7A6B85B89812A0062E0E2CF31DDE506DFF2  src/evidence/collector-handle.ts
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
11F421FBCDD358C510FF808F539A208B292ADA13AD6E0C22A9356F51945BE35C  node_modules/web-vitals/dist/web-vitals.attribution.iife.js
```
