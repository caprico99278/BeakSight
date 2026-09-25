# Task 9 — Git-free independent review package

Git operations are prohibited. Verify all SHA-256 hashes first, then perform a read-only independent review. Do not edit or spawn subagents.

## Review scope

Review Task 9 against Task 9 of the implementation plan, the higher-priority tasks/design documents, `task-9-brief.md`, progress rulings, and `task-9-report.md`.

Confirm:

1. Layout evidence is bounded, deeply immutable, finite/nonnegative, and retains truthful absolute facts plus visibility/position/z-index/overflow preconditions. `LAYOUT_THRESHOLDS` must be the one numeric-policy owner. Inspect ancestor visibility/opacity, normal below-fold content versus genuine outside-viewport candidates, mismatches between supplied viewport and actual `window.innerWidth/innerHeight`, zero-size visibility, fixed/sticky self/ancestor containment, and overlap preconditions for false evidence or candidate starvation.
2. `collectStressLayout()` validates the entire width list before side effects, creates a new owner-managed guarded-ready session per width, navigates independently at deterministic height, preserves order, calls owner close exactly once on success/work failure, and truthfully preserves work-plus-close failure. It must not raw-close, install/bypass policy, reuse pages, or reinterpret URL admission. Assess whether lifecycle tests are sufficient given Task 5/6 contracts.
3. Accessibility uses exactly the public `AxeBuilder({page}).analyze()` flow, retains all violations including color-contrast and required help/tags/node targets/failure summary, bounds HTML, freezes arbitrarily shaped public target selector structures safely, and propagates errors without Findings.
4. Color evidence is a bounded single read-only evaluation with finite canonical color/area/ratio facts, effective background ambiguity represented honestly, useful selectors/text, and area-weighted distribution. Pay special attention to element/ancestor opacity, semi-transparent foreground/background compositing, background images, modern computed color forms, viewport visibility, and whether a claimed contrast ratio is actually supportable. No aesthetic/baseline/image analysis may appear.
5. Tests genuinely reproduce overflow, outside viewport, zero-size interactive, clipping, fixed heading overlap, responsive isolation/cleanup/combined errors, axe color contrast, snippet bounds, CSS foreground/background/contrast, ambiguity, limits, deep freeze, and invalid browser geometry. Check fixtures do not make assertions pass accidentally.
6. No Findings, IDs, rules, target-specific logic, raw close/network authority, unbounded retained snippets/text/selectors, duplicate magic-threshold policy, or dependency changes.

Implementer reports focused 13/13, Task 5-9 adjacent 107/107, typecheck/build PASS, single-worker full 258/258 PASS. Standard parallel full ran twice at 257/258 due only the unchanged known Task 6 40 ms assertion; its exact test passed alone. Treat this honestly when judging Task 9, and list any test-determinism concern separately. Do not rerun broad verification absent concrete suspicion; focused probes/tests are permitted.

Return strengths and Critical/Important/Minor findings with exact paths/lines, and overall PASS/NEEDS FIXES.

## SHA-256 manifest

```text
3FC9AC60EB9D24E65996A8C3556C4925F0882C853CFC6A91DF40DB0D47F3B5A8  src/evidence/layout-collector.ts
7771CB30740C6404647192632BF188F99118F2DE90D7A128F5721BD52A4473F4  src/evidence/accessibility-collector.ts
3491DF344F93AD9F9C17256B9ED455F206C5A6DDE1F6EA12A9750DA3D78BBCB1  src/evidence/color-collector.ts
AEB1A423387C562C0EED245789940AC716EE31C79086A7DFD55F3882E7DBCD67  fixtures/site/overflow.html
6E94BA993EA238CD6C1D3D122D3EC82506EAD13F569B2110016A227CF5D3031F  fixtures/site/clipped-text.html
22DF7296093E3D29B41D536479F012AEE82811407CD09697DD112038275B1677  fixtures/site/bad-contrast.html
D9EB20D1C8BE68024C27DF367F95FB546D63B24A25C2BD1C572A2974C318051C  tests/component/layout-collector.test.ts
D3331B5DF562ED3DC1EC52A5FAB78249BAA31099CC67AC50A71170EAF514883A  tests/integration/layout-accessibility.test.ts
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
F8364EEB4EC72745A358D00871EF0C0B2817A5A3A374E59829D1DE0411455DC7  src/evidence/dom-collector.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
D960A4D29680ADB5E55A41B14B41EBBC6884C7467A340377A50B05102B8C1BE7  doc/design/2026-08-27-beaksight-implementation-plan.md
1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B  doc/design/2026-08-27-beaksight-implementation-tasks.md
```
