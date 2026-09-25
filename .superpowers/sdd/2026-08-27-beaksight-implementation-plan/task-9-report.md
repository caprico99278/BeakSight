# Task 9 implementer report — Git-free SDD

Status: implementation verified; independent review not yet performed.

## TDD evidence

### RED

1. Initial focused run after adding only tests and fixtures:
   - Command: `npx vitest run tests/component/layout-collector.test.ts tests/integration/layout-accessibility.test.ts`
   - Result: 2/2 suites failed before collecting tests because the three requested collector modules did not exist. Both failures were the expected `Cannot find module` boundary.
2. Post-GREEN risk tests were added before their fixes:
   - Component run: 1/9 failed because a document narrower than its viewport produced/rejected a negative horizontal-overflow value instead of canonical zero.
   - Real-Chromium integration run: 2/4 failed because fixed-heading candidates omitted computed overflow facts and descendant text under an `opacity: 0` ancestor was incorrectly retained as visible.
3. Specification-completeness tests were added before their fixes:
   - Real-Chromium layout subset: 2/2 failed because outside/zero-size/clipped candidates omitted position/z-index/overflow preconditions and body client dimensions were absent.

### GREEN

- Final focused component: 9/9 PASS.
- Final focused real-Chromium integration: 4/4 PASS.
- Final Task 9 focused total: 13/13 PASS.
- Final Task 5–9 adjacent regression: 107/107 PASS across 9 files.
- Typecheck: PASS.
- Build: PASS.
- Full repository, single worker: 258/258 PASS across 22 files.

## Changed files

- `src/evidence/layout-collector.ts`
- `src/evidence/accessibility-collector.ts`
- `src/evidence/color-collector.ts`
- `fixtures/site/overflow.html`
- `fixtures/site/clipped-text.html`
- `fixtures/site/bad-contrast.html`
- `tests/component/layout-collector.test.ts`
- `tests/integration/layout-accessibility.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-9-report.md`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` (factual append only)

No existing Task 5–8 source, configuration, package manifest, lockfile, or binding design document changed. No Git operation was used.

## Architecture and safety evidence

- `collectLayoutEvidence()` performs one read-only `page.evaluate()` and returns no DOM handles. It preserves bounded selectors, rectangles, visibility, position, z-index, overflow, document/client/scroll dimensions, and intersection geometry as evidence only.
- `LAYOUT_THRESHOLDS` is a single flat, deeply frozen authority for responsive height, geometry/candidate thresholds, selector/text bounds, and retained candidate counts. Node-side validation rejects non-finite geometry and negative dimensions, while horizontal overflow is canonically derived and clamped to zero.
- `collectStressLayout()` validates the complete width list before creating any session, preserves input order, creates one injected guarded-ready owner session per width, navigates only the supplied Page to the supplied URL, and calls only the injected owner `close()` exactly once in `finally`. Work-plus-close failure becomes an `AggregateError` retaining both original errors.
- `collectAccessibilityEvidence()` uses exactly `new AxeBuilder({ page }).analyze()`, retains all axe violations including `color-contrast`, bounds HTML snippets through `ACCESSIBILITY_LIMITS`, recursively freezes target selectors, and propagates analyze rejection.
- `collectColorEvidence()` performs one read-only evaluation, retains bounded visible direct-text samples, walks ancestors for an effective non-transparent CSS background, marks image or transparent ambiguity explicitly, computes contrast-pair facts, and returns a bounded approximate area-weighted foreground distribution.
- All public evidence snapshots, nested arrays, colors, rectangles, visibility/precondition facts, and responsive entries are frozen. Collectors create no Finding, evidence ID, fingerprint, rule, baseline, diff, aesthetic decision, or image/pixel analysis.
- Production scan found no target identity, target-specific hard-coded site selector, raw Page/Context close, Context/Page creation, route/network-policy installation, policy bypass, Finding/fingerprint/evidence-ID creation, baseline, aesthetic, or pixel-analysis token in the three Task 9 sources.
- Dependency hashes exactly match the Task 9 baseline; existing locked `@axe-core/playwright` 4.13.0 was used without install/download.

## Verification commands actually run

- `npx vitest run tests/component/layout-collector.test.ts tests/integration/layout-accessibility.test.ts` — expected initial RED.
- `npm run typecheck` — PASS after final changes.
- `npm run build` — PASS after final changes.
- `npx vitest run tests/component/layout-collector.test.ts` — final 9/9 PASS.
- `npx vitest run tests/integration/layout-accessibility.test.ts` — final 4/4 PASS using installed Chromium.
- `npx vitest run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts tests/component/layout-collector.test.ts tests/integration/layout-accessibility.test.ts` — final 107/107 PASS.
- `npx vitest run tests/integration/controlled-scroll.test.ts -t "returns honest PARTIAL metadata at the absolute deadline without hanging"` — 1/1 PASS, 12 skipped.
- `npx vitest run` — twice produced 257/258, with only the unchanged known Task 6 40 ms `finalSnapshot` timing assertion failing.
- `npx vitest run --maxWorkers=1` — 258/258 PASS across 22 files.
- `rg` boundary/magic-number scans over the three Task 9 sources — no forbidden architecture/safety token; numeric retention and evidence thresholds reside in the exported frozen authorities, while remaining literals are mathematical/color-standard invariants or structural indices.
- `Get-FileHash -Algorithm SHA256` over Task 9 outputs and baseline authorities — manifest below.

## Not run

- No live target audit or external-origin navigation was run; Task 9 verification used only the local fixture server.
- No package install/update/download command was run.
- No Git command was run.

## Concerns / honest gaps

- The default parallel full-suite command remains sensitive to the pre-existing Task 6 test's 40 ms deadline: both fresh runs returned a truthful `PARTIAL / DEADLINE_EXCEEDED` before an initial geometry snapshot, while the unchanged assertion requires `finalSnapshot.atBottom === false`. The exact test passed alone and the entire suite passed 258/258 with one worker. No Task 6 file was modified.
- Responsive owner isolation/cleanup/failure is directly exercised with a narrow deterministic session factory; real guarded BrowserContext/Page lifecycle and real geometry collection are independently exercised by the adjacent Task 5/6 and Task 9 real-Chromium suites.
- Independent review remains required before Task 9 can be declared complete.

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

## Fix Round 1/5 — seven Important review findings

Status: fixes implemented and verified; independent re-review not yet performed. The two review Minors remain deliberately deferred.

### Review validation and focused RED

The seven findings were checked against the real Chromium behavior and current source before changes. One focused integration test was added per finding. The source-targeted RED run produced exactly 7 failed / 4 passed:

1. A child under an `opacity: 0` ancestor remained in layout candidates, while an `aria-hidden` but visually rendered candidate was incorrectly suppressed.
2. A caller-provided 401px width was returned as observed evidence from a real 400px browser viewport instead of rejecting the mismatch.
3. More than the retained limit of ordinary below-fold elements starved later horizontal and fixed offscreen candidates.
4. Fixed/heading identity, both containment directions, and a wholly offscreen pair were emitted as overlaps.
5. Element and ancestor `opacity: 0.5` produced falsely exact contrast ratios.
6. Overflow-ancestor and viewport clipping did not reduce distribution area, and a fully clipped descendant remained sampled.
7. A real Chromium `oklch(...)` computed foreground aborted collection instead of preserving bounded explicit invalid-color evidence and continuing other samples.

An additional expectation in item 7 proved that invalid foreground area must not dilute the proportions of the distribution of successfully parsed observed colors; it failed at 0.8389 before the denominator correction and then passed.

### Implemented fixes

- Layout visual visibility now walks every ancestor for `hidden`, `display`, `visibility`, and non-positive/invalid opacity. It records the element's ARIA-hidden fact but does not use ARIA as a visual suppression condition.
- The sole layout evaluation reads `window.innerWidth`/`window.innerHeight`, uses those actual dimensions for outside and overflow geometry, and the Node boundary rejects caller/actual mismatches through the exported threshold authority.
- Outside candidates use two separately bounded buffers. Horizontal or fixed/sticky offscreen evidence is retained before ordinary vertical-flow evidence, then the combined immutable snapshot is capped.
- Fixed-heading pairing excludes element identity and both containment directions, and requires both rectangles to have positive intersection with the actual viewport before overlap evaluation.
- Color visual-state traversal records any positive partial opacity on the element or an ancestor and makes contrast explicitly `UNAVAILABLE / PARTIAL_OPACITY`.
- Each color sample now preserves both full bounding area and viewport/overflow-ancestor-clipped visible area. Fully clipped descendants are omitted; visible area is the weight and denominator authority for the approximate distribution.
- Foreground is now an immutable discriminated observation. Supported values retain a canonical parsed color; unsupported modern serialization retains bounded `UNAVAILABLE / INVALID_COLOR` evidence and makes only that sample's contrast unavailable. Other samples and supported-color distribution continue.

All fixes preserve one read-only browser evaluation per layout/color collection, existing bounds, exported threshold/limit SSOT, deep freezing, and the absence of DOM mutation or internal browser APIs in production.

### Fix Round 1 verification actually run

- Source-targeted real-Chromium RED: 7 failed / 4 passed, exactly matching the seven Important findings.
- Each finding's targeted test after its corresponding fix: 1/1 PASS.
- `npm run typecheck`: PASS.
- Task 9 focused: 20/20 PASS (component 9/9, real-Chromium integration 11/11).
- Task 5–9 adjacent regression: 114/114 PASS across 9 files.
- `npm run build`: PASS.
- `npx vitest run --maxWorkers=1`: 265/265 PASS across 22 files.
- `npx vitest run`: 265/265 PASS across 22 files. The known Task 6 40ms timing assertion did not fail on this Fix Round 1 standard run; its earlier results remain recorded above as historical evidence.
- Forbidden-boundary scan over Task 9 sources: no target identity, Finding/fingerprint/evidence-ID creation, baseline/aesthetic/pixel analysis, raw Page/Context close/create, route hook, or network-policy installation/bypass.
- Package manifest, lockfile, Task 5/6 lifecycle owner, Task 8 DOM owner, and binding design hashes remain equal to the Task 9 baseline.

### Fix Round 1 concerns / deferred scope

- The review Minor concerning `Promise.reject(undefined)` presence tracking remains deferred; no responsive lifecycle code changed in this round.
- The review Minor requesting a direct real Task 5/6-to-stress binding plus malformed-geometry/nested-axe coverage remains deferred.
- No live target run, dependency install/update/download, or Git operation was performed.
- Independent re-review remains required; this report does not claim Task 9 completion.

### Fix Round 1 SHA-256 manifest

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
D960A4D29680ADB5E55A41B14B41EBBC6884C7467A340377A50B05102B8C1BE7  doc/design/2026-08-27-beaksight-implementation-plan.md
1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B  doc/design/2026-08-27-beaksight-implementation-tasks.md
```
