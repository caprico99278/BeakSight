# Task 8 Fix Round 2 — Git-free review package

Git operations are prohibited. Verify SHA-256 hashes, then conduct a read-only scoped re-review. Do not edit or spawn subagents.

## Entering finding

Important remainder/new finding: Chromium excludes `input[type=image]` from `HTMLFormElement.elements`, so the reviewed image-submit branch was unreachable for both internally nested and external `form=id` controls; form ownership remained partially open.

The intended fix remains inside the sole existing `page.evaluate()`: enumerate document-order `button,input` candidates, restrict to submit/image types, then use browser `control.form === form` as ownership authority. Confirm internal and external image submitters are captured, controls owned by another form are excluded even when nested, ordering is deterministic, regular submit buttons and effective form method remain correct, and no second evaluation or Link extraction/URL semantics were introduced.

Only assess the entering Important and any new Critical/Important regression. Earlier three findings are closed unless concrete regression evidence exists. The deferred Minor remains out of scope.

Implementer reports targeted 1/1, Task 8 focused 11/11, fresh adjacent 129/129, full 245/245, typecheck/build PASS. Do not rerun broad verification absent concrete suspicion.

## SHA-256 manifest

```text
F8364EEB4EC72745A358D00871EF0C0B2817A5A3A374E59829D1DE0411455DC7  src/evidence/dom-collector.ts
5A33FBBB8704E6C25FD129590B1B466279DF3D2E80627FE6A9E73AB95D5A7E37  src/evidence/screenshot-collector.ts
DF7CE2905EC2F3EE8B47976A3955FF617A69AF602941290CADC17C3827C437CA  tests/component/dom-collector.test.ts
452F7F83A4248767BB64DDD4FD5B1BE8892C516A12A363F08472EFE843003B66  tests/integration/screenshot-collector.test.ts
ADF05FFB017EC1AA4C56E03870A88FA662155D7282532B02B384ECC9B4CB2DF8  src/crawl/discover-links.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```

## Required verdict

Mark the entering finding ADDRESSED/OPEN with exact lines, list any new Critical/Important, and conclude Task 8 PASS/NEEDS FIXES.
