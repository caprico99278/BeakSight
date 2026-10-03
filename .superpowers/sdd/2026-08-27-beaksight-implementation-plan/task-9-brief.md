# Task 9 implementation brief — Git-free SDD

Execute Task 9 from the implementation plan under the higher-priority tasks/design documents and progress ledger. Git operations are prohibited.

## Scope

- Create `src/evidence/layout-collector.ts`, `src/evidence/accessibility-collector.ts`, `src/evidence/color-collector.ts`.
- Create `fixtures/site/overflow.html`, `fixtures/site/clipped-text.html`, `fixtures/site/bad-contrast.html`, `tests/component/layout-collector.test.ts`, and `tests/integration/layout-accessibility.test.ts`.
- Use the already installed/locked `@axe-core/playwright`; do not add or download any dependency.

## Layout evidence

- `collectLayoutEvidence(page, viewport)` observes absolute geometry facts in one read-only browser evaluation: document/client/scroll dimensions, horizontal overflow, visible element boxes outside the viewport, visible interactive zero-size candidates, clipped visible text, and fixed/sticky candidates overlapping a visible heading. Preserve selectors, rectangles, computed precondition facts (visibility/position/z-index/overflow), and overlap geometry as Evidence only.
- Do not report every rectangle intersection. Fixed-occlusion candidates require both elements visible, fixed/sticky positioning, positive intersection above the exported threshold, and a visible heading target. Rule Engine later decides Findings.
- Export one deeply frozen `LAYOUT_THRESHOLDS` object as the sole owner of all layout numeric thresholds and maximum retained candidate counts. Validate browser-derived geometry as finite/nonnegative; represent or reject invalid observations truthfully rather than allowing NaN/Infinity into evidence.
- Return deeply immutable bounded snapshots without DOM handles, Findings, IDs, fingerprints, or target-specific selectors.

## Responsive stress lifecycle

- `collectStressLayout(pageFactory, url, widths)` uses a narrow injected session factory returning a guarded ready Page plus one owner `close()` method. For every supplied width, create a fresh isolated passive session with the one exported deterministic stress height, navigate that Page independently, collect layout evidence, and close the session exactly once in `finally`; never reuse Page/Context state across widths or call raw Playwright close.
- Validate every width as a positive finite integer before creating any session. Preserve input order. On navigation/collection failure, still close and propagate truthfully; do not return partial success as complete. If work and close both fail, preserve both errors rather than hiding either.
- Production stress code may navigate only the injected guarded ready Page to the caller-provided URL; it must not install/bypass network policy or reinterpret URL admission.

## Accessibility evidence

- `collectAccessibilityEvidence(page)` must use exactly `new AxeBuilder({ page }).analyze()` from the existing library. Preserve every violation as immutable evidence: rule ID, impact, help/helpUrl, tags, and nodes with target selectors, failure summary, and HTML snippet bounded by one exported maximum length.
- Keep color-contrast violations. Do not filter by severity, turn violations into Findings, or retain axe/DOM handles. Propagate analysis failure visibly.

## CSS color evidence

- `collectColorEvidence(page)` uses one read-only evaluation. For bounded visible text samples, preserve normalized text, stable selector, computed foreground, effective non-transparent background candidate found by walking ancestors, bounding area, and the foreground/background contrast pair facts. If a usable background cannot be observed (including image/transparent ambiguity), represent it explicitly rather than inventing a color/ratio.
- Return a bounded approximate area-weighted distribution of observed computed foreground colors and export one frozen limits object as its authority. Preserve observation facts only: no aesthetic balance decision, image analysis, contrast Finding, baseline, or pixel comparison.
- Validate numeric/color outputs and deeply freeze all nested evidence.

## TDD and verification

1. Add genuine focused failing tests/fixtures first and record RED.
2. Implement minimum behavior. Test overflow, outside viewport, zero-size interactive, fixed heading occlusion, clipped text, responsive isolation/cleanup/failure, axe violations including color-contrast, bounded snippets, color/background samples, and bounded distribution.
3. Run Task 5/6 lifecycle, Task 7/8 evidence, focused Task 9, typecheck, build, and full suite.
4. Scan for target identity, Finding/ID/rule creation, duplicate thresholds/magic numbers outside exported ledgers, raw close/network-policy bypass, unbounded HTML/text retention, baseline/diff/aesthetic classification, and dependency changes.
5. Write `task-9-report.md` with RED/GREEN, changed files, architecture/safety evidence, actual/not-run commands, concerns, and SHA-256 manifest. Append factual progress only; independent review decides completion.
