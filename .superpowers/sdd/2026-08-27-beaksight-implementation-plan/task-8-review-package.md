# Task 8 — Git-free independent review package

Git operations are prohibited. Verify all SHA-256 hashes first, then perform a read-only review. Do not edit or spawn subagents.

## Review scope

Review Task 8 against Task 8 of the implementation plan, the higher-priority tasks/design documents, `task-8-brief.md`, progress rulings, and `task-8-report.md`.

Confirm:

1. `collectDomEvidence(page, pageId, links)` reuses caller-supplied canonical Task 3 `LinkEvidence[]` without any `a[href]`, href parsing, URL normalization/admission, or reconstructed link semantics. Canonical nested structures must be safely copied/frozen.
2. Exactly one read-only `page.evaluate()` collects every non-link fact: title/meta/canonical/lang, headings, semantic region visible text with truthful body fallback, images, and forms/fields/labels/submit controls. Check real DOM semantics/defaults, missing/empty attributes, hidden content, nested landmarks, label association, and no mutation.
3. Every returned object/array is deeply immutable; no Playwright/DOM handles or caller-owned mutable structures survive. Collectors create no Findings, rules, fingerprints, canonical IDs, or `EvidenceRecord`s.
4. Screenshot capture writes exactly the requested viewport and full-page PNGs, rejects before claiming evidence on invalid metadata, returns immutable relative-path/page/viewport/capture-type facts only after both writes succeed, and performs no baseline/diff/analysis.
5. Inspect path safety/truthfulness carefully: relative artifact metadata must not be absolute or traversal-capable, the viewport/full-page output and metadata targets must not alias/overwrite each other, and rejected captures must not yield false evidence. Distinguish this collector's scope from later coordinator cleanup without concealing a real Task 8 defect.
6. Tests genuinely prove Link SSOT, one evaluate, deep immutability, semantic fallback, form/image details, no read-side mutation, actual PNG signatures/dimensions, relative-only metadata, guarded lifecycle, exact output count, and error propagation.
7. Production `a[href]` remains exactly one occurrence in `discover-links.ts`; target isolation and dependency invariants remain intact.

Implementer reports focused 5/5, Task 3/5/6/7/8 adjacent 123/123, full 239/239, typecheck/build PASS. Do not rerun broad verification absent concrete suspicion; focused tests are permitted when warranted. Return strengths and Critical/Important/Minor findings with exact paths/lines, then PASS/NEEDS FIXES.

## SHA-256 manifest

```text
24C8FC9AD66BD629986A3EA81A2ED956E1C5B14A03D662537AB144CCB0441877  src/evidence/dom-collector.ts
3AE191FEC3804887062B8860E6D32E4F53DFC84AB00A843E0379D2EC9C8F57C1  src/evidence/screenshot-collector.ts
71306D015AA6F7E80F9C8E32032C56BBF2AECC7CFD0AE7CA0E74BBBF5364EC46  tests/component/dom-collector.test.ts
678A07661D75A85FED6EFB05075B7DDB8C2874CEB4CF99798308C44B78785D93  tests/integration/screenshot-collector.test.ts
ADF05FFB017EC1AA4C56E03870A88FA662155D7282532B02B384ECC9B4CB2DF8  src/crawl/discover-links.ts
3222551B0AF530ED061A931CF8B2E9F89BD112C4718C2A0AB10C876517A21718  src/core/ids.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```
