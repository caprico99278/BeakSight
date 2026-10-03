# Task 10 fix round 4 independent re-review — Git-free SDD

Status: ready for fresh independent re-review. Git operations are prohibited.

## Scope

Verify all 13 hashes before review, then read the round 4 brief, preceding review packages/results, and current source/tests. Read-only review only: no edit, Git, dependency, live target, or subagent.

Adjudicate the two remaining Important findings:

1. Header projection must treat `Reflect.ownKeys`, each own-property descriptor, and each selected value as separately deadline-gated caller boundaries. No descriptor or value may be read after an earlier operation reaches the deadline, and unselected header values must not be accessed.
2. Known initiators must correlate request identity by exact raw request type. In particular, `fetch` cannot claim an `xhr` request (or vice versa) merely because both share the `fetch-xhr` summary category. With no exact match, request ID/type remain null while summary fallback may still use the initiator category.

Confirm the earlier six findings, overlong raw-type identity correction, fine-grained accessor boundaries, and Task 6 first-render-frame maintenance remain intact. Inspect the two new tests for non-vacuity. Run only narrow reproductions if needed. PASS requires no Critical/Important; list Minors separately.

## Verification evidence

- Focused round 4 tests: 2/2 PASS.
- Task 10 component: 34/34 PASS.
- Task 10 + Task 6 real-browser focused: 16/16 PASS.
- Task 1–10 adjacent: 189/189 PASS across 14 files.
- Typecheck and build: PASS.
- Full repository: 302/302 PASS across 24 files.

## SHA-256 manifest

```text
D3B84BBEEDC5F55C95E07B4FF6C3C0193FE85437AFA638FE4B7A00765CD024FA  src/evidence/performance-collector.ts
5E0259649479B0AE1BE558D677287C07E8EE0525E0545A7B89F9AA6FAD8C3421  tests/component/performance-collector.test.ts
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
