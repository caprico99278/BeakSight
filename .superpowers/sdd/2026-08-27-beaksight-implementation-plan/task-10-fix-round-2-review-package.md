# Task 10 fix round 2 independent re-review — Git-free SDD

Status: ready for fresh independent re-review. Git operations are prohibited.

## Entering scope

Read `task-10-fix-round-1-review-package.md`, the round 1 reviewer result in `progress.md`, and the current implementation/tests. Verify all 13 hashes below before review. Review is read-only: no edits, Git, dependencies, live targets, or subagents.

Two Important remainders must be adjudicated:

1. Deadline-bounded detached projection: no NetworkEvidence top-level/scalar/header field may be read after the absolute deadline is observed. Every retained scalar must be bounded. Exact resource correlation must not retain an overlong URL and must not create a false match by truncation alias.
2. Duplicate URL correlation: with unknown initiator and multiple candidates, aggregate category equality is insufficient. `fetch` versus `xhr`, or any differing raw resource types, must leave request ID/type null. Deterministic consumption is allowed only for identical normalized raw resource types; known initiators still require compatible categories and document requests remain excluded.

Also confirm the round 1 Minor `emptyWebVitals()` is gone and no regression was introduced into the six previously ADDRESSED findings or the Task 6 maintenance. Inspect exact lines and focused tests; run only a narrow reproduction if needed. PASS requires no Critical/Important finding.

## SHA-256 manifest

```text
E9D760D73DFF15AD95FB50EF70ECCA40DDF0AE1DE237DDF713163976267CED72  src/evidence/performance-collector.ts
F1B61436693E070C30DB9F1FE85A3FBEC8C574957148843CDC2985A4E7275527  tests/component/performance-collector.test.ts
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
