# Task 8 Fix Round 1 — Git-free review package

Git operations are prohibited. Verify all hashes, then conduct a read-only scoped re-review. Do not edit or spawn subagents.

## Entering Important findings

1. Screenshot metadata accepted traversal/dot/drive-relative forms and viewport/full-page output or metadata targets could alias, allowing overwrite followed by two success records.
2. DOM normalization collapsed missing and present-empty title/meta/canonical/lang plus image src/alt, losing facts required by downstream rules.
3. Submitters were selected by DOM descendants instead of form ownership; external `form=id` submitters were missed, descendants owned elsewhere were misattributed, and invalid raw method was reported instead of effective `get`.
4. Joining every nested landmark's `innerText` duplicated combined visible text.

Intended fixes enforce canonical portable POSIX-relative metadata with no traversal/dot/empty segments/backslash/NUL/URI-or-drive prefix and require distinct metadata/resolved output identities before first write; preserve missing=`null` versus present-empty=`''`; use `form.elements` and browser-effective `form.method`; retain every semantic region record but compose combined text from outermost observed landmarks only.

Review focused RED tests for the exact five failures, verify all four findings with exact lines, and list any new Critical/Important regressions. Ensure Task 3 Link SSOT and single `page.evaluate()` remain intact. The one deferred Minor remains out of scope absent escalation.

Implementer reports focused 10/10, adjacent 128/128, full 244/244, typecheck/build PASS. Do not rerun broad verification absent concrete suspicion; focused tests are permitted if warranted.

## SHA-256 manifest

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

## Required verdict

Mark all four findings ADDRESSED/OPEN with exact paths/lines, list any new Critical/Important, and conclude Task 8 PASS/NEEDS FIXES.
