# Task 9 Fix Round 1 — Git-free review package

Git operations are prohibited. Verify all hashes, then perform a read-only scoped re-review. Do not edit or spawn subagents.

## Entering Important findings

1. Layout visibility ignored ancestors and wrongly used ARIA-hidden as visual suppression.
2. Supplied viewport was reported/used without validating actual browser dimensions.
3. Ordinary vertical flow could exhaust the bounded outside list before horizontal/positioned facts.
4. Fixed/sticky overlap admitted identity/containment and wholly offscreen pairs.
5. Contrast ignored positive partial element/ancestor opacity.
6. Distribution used full rectangles rather than viewport/overflow-ancestor-clipped visible area.
7. Unsupported modern computed foreground serialization aborted the whole collector.

Intended fixes: ancestor-aware visual state while retaining ARIA only as a fact; actual `window.innerWidth/innerHeight` geometry plus caller mismatch rejection; separately bounded priority outside candidates; identity/containment/offscreen overlap exclusion; `PARTIAL_OPACITY` contrast unavailable; clipped visible area retained and used as distribution weight; discriminated supported/unavailable foreground with bounded raw CSS and `INVALID_COLOR`, allowing other samples to continue.

Inspect the seven real-Chromium RED tests and exact source paths. Confirm one read-only evaluation per layout/color collector, bounds/threshold SSOT, finite validation, deep freeze, and no internal APIs/DOM mutation. The two deferred Minors remain out of scope absent escalation. List any new Critical/Important regression.

Implementer reports focused 20/20, adjacent 114/114, typecheck/build PASS, single-worker and standard full 265/265 PASS. Do not rerun broad verification absent concrete suspicion; focused tests/probes are permitted.

## SHA-256 manifest

```text
23C7B637C5587AA97B5B362CFB39794B5FD64AA1322FA4A35F632CFC87803315  src/evidence/layout-collector.ts
7771CB30740C6404647192632BF188F99118F2DE90D7A128F5721BD52A4473F4  src/evidence/accessibility-collector.ts
756455D6343B0B87379D7C8EED52095CF85060E4DB2ACD677C606048F4CB342A  src/evidence/color-collector.ts
7F46E28353E741FAE8F25F790484112DB65015D60AB7EA2A1A1F81EB634C3F71  fixtures/site/overflow.html
6E94BA993EA238CD6C1D3D122D3EC82506EAD13F569B2110016A227CF5D3031F  fixtures/site/clipped-text.html
8CC33D71D8CDF617722DA1E896B518913B329C01FC51B70C5BE2DCBF711AACC1  fixtures/site/bad-contrast.html
D9EB20D1C8BE68024C27DF367F95FB546D63B24A25C2BD1C572A2974C318051C  tests/component/layout-collector.test.ts
7367FE60627357533FC2F2CD4C9628A64402EB9A8272970425681CDE85A6BDAB  tests/integration/layout-accessibility.test.ts
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
F8364EEB4EC72745A358D00871EF0C0B2817A5A3A374E59829D1DE0411455DC7  src/evidence/dom-collector.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

## Required verdict

Mark all seven findings ADDRESSED/OPEN with exact paths/lines, list new Critical/Important, and conclude Task 9 PASS/NEEDS FIXES.
