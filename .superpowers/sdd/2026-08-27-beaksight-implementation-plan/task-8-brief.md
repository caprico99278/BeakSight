# Task 8 implementation brief — Git-free SDD

Execute Task 8 from the implementation plan under the higher-priority tasks document and progress-ledger rulings. Git operations are prohibited.

## Scope

- Create `src/evidence/dom-collector.ts`, `src/evidence/screenshot-collector.ts`, `tests/component/dom-collector.test.ts`, and `tests/integration/screenshot-collector.test.ts`.
- Reuse existing fixtures where sufficient; add a target-agnostic fixture only when it materially improves real-browser coverage.
- Do not add/download a dependency; stop for approval if one becomes genuinely necessary.

## DOM contract and Link SSOT

- The planned two-argument DOM interface conflicts with the binding Task 3 SSOT ruling. Use `collectDomEvidence(page, pageId, links)` (or an equivalently explicit required input) so the result reuses caller-supplied canonical `readonly LinkEvidence[]` from `discoverLinks()`.
- `src/evidence/dom-collector.ts` must contain no `a[href]` selector, href parsing, URL normalization, URL admission, or reconstruction of Link evidence. Preserve the supplied canonical link objects/semantics in an immutable snapshot without mutating or semantically reinterpreting them.
- Collect every non-link DOM fact in exactly one `page.evaluate()` call: title, meta description, canonical URL text, document language, heading levels/text, semantic-landmark visible text (`header`, `nav`, `main`, `aside`, `footer`, and form regions) with `body.innerText` fallback only when semantic regions provide no useful visible text, images (`src`, `alt`, `complete`, `naturalWidth`, `naturalHeight`), and forms (`method`, `action`, fields, types/names/required state/labels, submit controls).
- Normalize whitespace consistently and copy/freeze every returned object/array, including the supplied Link evidence and nested normalization/admission structures. Collect observations only; never create Finding, rule outcomes, Evidence IDs, or canonical `EvidenceRecord`s.
- Do not fill, submit, click, navigate, route, fetch, or mutate the page. Browser evaluation is read-only.

## Screenshot contract

- `captureScreenshots(page, paths)` receives explicit output paths plus explicit relative artifact paths, `pageId`, and viewport name. It writes exactly one viewport PNG and one full-page PNG using public `page.screenshot()` and returns immutable raw Screenshot evidence containing page ID, viewport, relative path, and `VIEWPORT`/`FULL_PAGE` capture type.
- Do not generate canonical Evidence IDs; Task 14 owns assembly/IDs. Do not create baseline files, pixel diffs, image analysis, or comparison logic.
- Preserve caller metadata by value. Do not claim evidence for a capture that rejected. Keep path/write failures visible to the caller; do not silently recover.
- The integration test must verify actual PNG files/signatures/dimensions are written at the requested paths and evidence contains relative rather than absolute artifact paths. Use an isolated temporary directory inside the workspace/test temp facility and clean up only that exact directory.

## TDD and verification

1. Add focused failing tests first and record exact RED evidence.
2. Implement minimum behavior; run DOM component and screenshot integration tests.
3. Run Task 3 link tests, Task 5/6 guarded browser lifecycle regression, Task 7 evidence regression, typecheck, build, and full suite.
4. Scan production for exactly one `a[href]` extraction, target-specific data, Finding/ID creation, DOM mutation, screenshot baselines/diffs, and new dependencies.
5. Write `task-8-report.md` with RED/GREEN, changed files, architecture/safety checks, actual commands/not-run ledger, concerns, and SHA-256 hashes. Append factual progress only; do not claim Task 8 complete before review.
