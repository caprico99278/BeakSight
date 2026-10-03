# Task 8 implementation report

## Status

IMPLEMENTATION VERIFIED — INDEPENDENT REVIEW PENDING

Implemented immutable raw DOM and Screenshot evidence collection under the Task 3 Link SSOT ruling. Git operations were not used, `.git-sandbox-backup` was not touched, and no dependency was added or downloaded.

## RED evidence

The focused tests were created before either production module existed:

```text
npx vitest run tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts

Test Files  2 failed (2)
Tests       no tests
exit        1
```

Both suites failed at module loading with the expected missing-feature errors:

```text
Cannot find module '../../src/evidence/dom-collector.js'
Cannot find module '../../src/evidence/screenshot-collector.js'
```

This was a genuine missing-production RED, not a typo or pre-existing failure.

## Implementation

- `collectDomEvidence(page, pageId, links)` requires the caller-supplied canonical `readonly LinkEvidence[]` produced by Task 3. It copies and freezes the links and each nested normalization/admission object without parsing, classifying, normalizing, or reconstructing link semantics.
- Exactly one `page.evaluate()` collects all non-link document facts: normalized title, meta description, canonical URL text, language, heading level/text, semantic-region visible text, images, and forms.
- Semantic text observes visible `header`, `nav`, `main`, `aside`, `footer`, and `form` regions. A normalized `body.innerText` fallback is used only when those regions yield no useful visible text.
- Image observations retain source text, normalized alt text, completion state, and natural dimensions.
- Form observations retain normalized method/action, non-submit field type/name/required/associated visible labels, and submit control type/name/value/text. Collection performs no input, submission, click, navigation, routing, or fetch action.
- Every public DOM object and array is copied and frozen, including headings, visible-text regions, Link evidence and its nested discriminated structures, images, forms, fields, label arrays, and submit controls.
- `captureScreenshots(page, paths)` snapshots caller metadata by value, calls public `page.screenshot()` once for the explicit viewport output and once for the explicit full-page output, and returns only immutable raw page/viewport/relative-path/capture-type facts after both captures succeed.
- Screenshot errors remain rejected to the caller. The collector does not create metadata for a rejected capture, silently recover, create directories, compare pixels, or store baselines.
- Both artifact metadata paths are validated as non-empty relative paths under POSIX and Windows path rules before either screenshot write. Absolute metadata cannot be returned or cause a partial write.
- Neither collector creates canonical Evidence IDs, `EvidenceRecord`s, Findings, rules, or fingerprints; Task 14 retains assembly/ID authority.

## GREEN and verification evidence

The first restricted-process browser run after implementation could not spawn installed Chromium (`spawn EPERM`). The same command was rerun with local execution permission; no external site was contacted.

Self-review then added a boundary test requiring absolute artifact metadata to reject before any PNG write. Before validation, it produced the following genuine RED:

```text
npx vitest run tests/integration/screenshot-collector.test.ts
FAIL — 1 file, 1 failed / 2 passed, exit 1
reason — promise resolved with an absolute relativePath instead of rejecting
```

After the minimal cross-platform relative-path validation, the final evidence was:

```text
npx vitest run tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
PASS — 2 files, 5 tests, 0 failures, exit 0

npm run typecheck
Initial strict compile: FAIL — submit-control browser property remained typed as string.
After the minimal literal narrowing: PASS — TypeScript strict no-emit compile, exit 0

npx vitest run tests/component/discover-links.test.ts tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/request-policy.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
PASS — 11 files, 123 tests, 0 failures, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 20 files, 239 tests, 0 failures, exit 0
```

The screenshot integration coverage used guarded Task 5/6 Context/Page lifecycle, actual Chromium PNG encoding, isolated workspace directories named `.task8-screenshot-*`, exact-directory cleanup, PNG signatures, and decoded IHDR dimensions. It verified 320x240 viewport and 320x700 full-page captures plus relative-only metadata. A real unwritable destination-directory case rejected visibly.

## Changed files

- `src/evidence/dom-collector.ts` — single-evaluation non-link DOM facts and immutable canonical-link snapshot.
- `src/evidence/screenshot-collector.ts` — explicit viewport/full-page PNG output and immutable raw screenshot metadata.
- `tests/component/dom-collector.test.ts` — real-browser DOM facts, semantic fallback, single evaluation, Link reuse, read-only behavior, and deep immutability.
- `tests/integration/screenshot-collector.test.ts` — guarded real-browser PNG files/signatures/dimensions, relative metadata, deep immutability, error propagation, and exact temporary cleanup.

## Architecture and safety scans

- `a[href]` production extraction occurrences: exactly 1, in `src/crawl/discover-links.ts` only.
- URL construction/normalization/admission symbols in `src/evidence/dom-collector.ts`: 0.
- Finding, Evidence ID, fingerprint, or rule authoring in the two Task 8 production files: 0.
- click/fill/press/check/select/upload/goto/route/fetch/form-submit operations in the two Task 8 production files: 0.
- baseline/pixel/diff/comparison logic in `src/evidence/screenshot-collector.ts`: 0.
- target-specific names, domains, and absolute target URLs in the two Task 8 production files: 0.
- Dependency manifests are unchanged from the Task 7 reviewed baseline. No new package import or download occurred.
- `src/crawl/discover-links.ts`, `src/core/ids.ts`, and `src/core/contracts.ts` remained unchanged while Task 8 was implemented.

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

## Concerns / not run

- No required Task 8 command or gate remains unrun.
- Chromium commands require local execution permission outside the restricted process sandbox; all permitted fixture runs passed.
- If the full-page capture rejects after the viewport capture succeeds, the already-written viewport file remains visible while the function rejects and returns no evidence. Cleanup/partial-artifact policy belongs to the artifact writer/coordinator; this collector neither conceals the rejection nor claims successful evidence.
- Task 14 remains responsible for turning these raw observations into canonical `EvidenceRecord`s and assigning canonical Screenshot/Evidence IDs.
- Independent Task 8 review has not yet run; this report does not mark Task 8 complete.

## Fix Round 1/5

### Entering Important findings and root causes

- Screenshot metadata validation rejected only empty and absolute forms. Dot/dot-dot/traversal, empty segments, backslashes, NUL, URI and drive-relative prefixes remained representable; no metadata-target or resolved output-target distinctness check existed before writes.
- The DOM normalization helper converted both missing attributes and normalized empty strings to `null`, erasing presence information needed by later deterministic rules. Image source/alt used a second helper that converted both missing and present-empty to `''`.
- Form fields used browser ownership through `form.elements`, but submitters used descendant selection. That split missed external `form=id` submitters, included descendants assigned to a different form, and read the raw method attribute rather than browser-effective `form.method`.
- Region records and the combined semantic-text source used the same full nested list. An outer landmark's `innerText` already contained its nested landmark text, so joining every record duplicated the nested text.

The independent-review Minor finding remains deferred as directed. This round did not expand direct freeze/mutation coverage or characterize second-write rejection/exact screenshot call counts.

### Fix-round RED evidence

Tests were changed before production fixes and run against the reviewed implementation:

```text
npx vitest run tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
FAIL — 2 files, 5 failed / 5 passed, exit 1
```

The five failures separately showed:

- `.` metadata resolved and produced two success records instead of rejecting; identical metadata targets also resolved and produced duplicate records.
- Missing image `src`/`alt` were returned as `''` instead of `null`.
- Invalid form method remained `not-a-method`; an owned external submitter was omitted and a descendant owned by another form was misattributed.
- Nested form text appeared twice in combined semantic text while both region records were retained.

### Fixes

- Artifact metadata now accepts only non-empty canonical portable POSIX-relative syntax: no absolute form under POSIX or Windows rules, empty/dot/dot-dot segment, repeated/trailing separator, backslash, NUL, URI scheme, or drive prefix.
- Canonicalized viewport/full-page metadata identities must differ. Lexically resolved output identities must also differ before the first `page.screenshot()`; Windows comparison is case-insensitive.
- DOM nullable normalization now preserves missing as `null` and present-empty/whitespace-only as `''` for title, meta description content, canonical href, document language, and image src/alt.
- Submit controls now use the owning form's live `form.elements` collection, matching the field ownership boundary. Browser-effective `form.method` supplies `get` for missing or invalid method values.
- Every useful visible semantic region remains in `visibleText.regions`. Combined semantic text is formed only from observed regions that are not contained by another observed region, so nested text contributes exactly once.
- Task 3 `LinkEvidence[]` remains a required input and is still copied/frozen without selector extraction, URL normalization, admission, or semantic reinterpretation.

### Fix-round GREEN and verification evidence

```text
npx vitest run tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
PASS — 2 files, 10 tests, 0 failures, exit 0

npm run typecheck
PASS — TypeScript strict no-emit compile, exit 0

npx vitest run tests/component/discover-links.test.ts tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/request-policy.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
PASS — 11 files, 128 tests, 0 failures, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 20 files, 244 tests, 0 failures, exit 0
```

No external site was contacted. Browser tests used only installed Playwright Chromium and local/in-memory fixture content. Git operations and dependency additions/downloads remained absent.

### Fix-round architecture and safety scans

- Production `a[href]` extraction: exactly 1 occurrence, still solely in `src/crawl/discover-links.ts`.
- URL construction/normalization/admission symbols in `src/evidence/dom-collector.ts`: 0.
- Finding, canonical Evidence ID, fingerprint, or rule authoring in Task 8 production: 0.
- click/fill/press/check/select/upload/goto/route/fetch/form-submit operations in Task 8 production: 0.
- baseline/pixel/diff/comparison logic in screenshot collection: 0.
- target-specific names/domains/absolute target URLs in Task 8 production: 0.
- `src/crawl/discover-links.ts`, `src/core/ids.ts`, `src/core/contracts.ts`, `package.json`, and `package-lock.json` hashes remain unchanged.

### Fix-round SHA-256 manifest

```text
F36C0FA1699831FAAFEA9299A3031EC2D4E5024B5315C8106FF0970D900C0DB4  src/evidence/dom-collector.ts
5A33FBBB8704E6C25FD129590B1B466279DF3D2E80627FE6A9E73AB95D5A7E37  src/evidence/screenshot-collector.ts
5B129546D232AE919EB3336338E1F202107CF3B8DB7921A61A9B771C6FF83BA4  tests/component/dom-collector.test.ts
452F7F83A4248767BB64DDD4FD5B1BE8892C516A12A363F08472EFE843003B66  tests/integration/screenshot-collector.test.ts
ADF05FFB017EC1AA4C56E03870A88FA662155D7282532B02B384ECC9B4CB2DF8  src/crawl/discover-links.ts
3222551B0AF530ED061A931CF8B2E9F89BD112C4718C2A0AB10C876517A21718  src/core/ids.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

No required Fix Round 1 verification remains unrun. Independent re-review remains pending; Task 8 is not marked complete.

## Fix Round 2/5

### Entering Important finding and root cause

Chromium's `HTMLFormElement.elements` excludes `input[type="image"]`. Although Fix Round 1 corrected ownership for controls present in that collection, the `type === 'image'` evidence branch remained unreachable for internal and external `form=id` image submitters.

The binding ruling requires ownership from the browser's `control.form === form` association over document-order button/input candidates. This preserves HTML form ownership without assuming `form.elements` exhaustively lists every submitter.

### Fix-round RED evidence

A real-Chromium test placed one image submitter before its owning form, one inside the form, one after it, and one inside that form but assigned to a second form. It also retained a normal submit button to make ordering observable.

```text
npx vitest run tests/component/dom-collector.test.ts -t 'collects internal and external image submitters'
FAIL — 1 file, 1 failed / 5 skipped, exit 1
```

The primary form returned only its normal button instead of the expected document-order external-before image, button, internal image, and external-after image. The secondary form also omitted its associated image submitter. This reproduced Chromium's collection behavior and the unreachable image-evidence branch.

### Fix

- Inside the existing sole `page.evaluate()`, submitter candidates are read once from `document.querySelectorAll('button, input')`, which preserves document order.
- Candidates are restricted to browser `HTMLButtonElement`/`HTMLInputElement` submit or image controls.
- Each form retains only candidates whose browser association satisfies `control.form === form`.
- Field collection remains on `form.elements`; only the submitter enumeration gap is changed.
- No second evaluation, anchor selector, Link normalization/admission flow, DOM mutation, or new collector entry point was introduced.

### Fix-round GREEN and verification evidence

```text
npx vitest run tests/component/dom-collector.test.ts -t 'collects internal and external image submitters'
PASS — 1 file, 1 test, 5 skipped, 0 failures, exit 0

npx vitest run tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
PASS — 2 files, 11 tests, 0 failures, exit 0

npm run typecheck
PASS — TypeScript strict no-emit compile, exit 0

npx vitest run tests/component/discover-links.test.ts tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/request-policy.test.ts tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
Fresh rerun PASS — 11 files, 129 tests, 0 failures, exit 0

npm run build
PASS — production TypeScript build and schema copy, exit 0

npm test
PASS — 20 files, 245 tests, 0 failures, exit 0
```

The first adjacent run was 128/129 because the unchanged Task 6 40 ms deadline test returned correct `PARTIAL / DEADLINE_EXCEEDED` before its first geometry observation and therefore had no `finalSnapshot` for that test's non-undefined assertion. The exact Task 6 test passed alone 1/1, and the unchanged fresh adjacent rerun passed 129/129. No Task 6 file was modified.

### Fix-round architecture and safety scans

- Production `a[href]` extraction remains exactly one occurrence in `src/crawl/discover-links.ts`.
- `src/evidence/dom-collector.ts` contains exactly one `page.evaluate()`.
- URL construction/normalization/admission symbols in the DOM collector: 0.
- click/fill/press/check/select/upload/goto/route/fetch/form-submit operations in Task 8 production: 0.
- `src/evidence/screenshot-collector.ts`, `tests/integration/screenshot-collector.test.ts`, Task 3 owner files, core ID/contracts files, and dependency manifests are unchanged in this round.
- Git operations and dependency additions/downloads remained absent. The deferred Minor finding remains out of scope and untouched.

### Fix-round SHA-256 manifest

```text
F8364EEB4EC72745A358D00871EF0C0B2817A5A3A374E59829D1DE0411455DC7  src/evidence/dom-collector.ts
5A33FBBB8704E6C25FD129590B1B466279DF3D2E80627FE6A9E73AB95D5A7E37  src/evidence/screenshot-collector.ts
DF7CE2905EC2F3EE8B47976A3955FF617A69AF602941290CADC17C3827C437CA  tests/component/dom-collector.test.ts
452F7F83A4248767BB64DDD4FD5B1BE8892C516A12A363F08472EFE843003B66  tests/integration/screenshot-collector.test.ts
ADF05FFB017EC1AA4C56E03870A88FA662155D7282532B02B384ECC9B4CB2DF8  src/crawl/discover-links.ts
3222551B0AF530ED061A931CF8B2E9F89BD112C4718C2A0AB10C876517A21718  src/core/ids.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

No required Fix Round 2 verification remains unrun. Independent re-review remains pending; Task 8 is not marked complete.
