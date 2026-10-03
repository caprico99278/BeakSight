# Task 11 correction — Task 2 fix round 2 fixed review manifest

Date: 2026-09-20. This is the no-Git fixed package for controller-owned independent re-review. Hash algorithm: SHA-256. This manifest intentionally does not self-hash.

## Genuine-RED production baseline

All 17 fixed-brief hashes matched before test edits. After the accepted test-only behavioral RED and before production edits, these hashes were rechecked unchanged:

| Path | Baseline SHA-256 |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `75A7B67AA91AF205CA9AFB379F943F30F72150C05FCFDF6C73DBD626C0D0A9CB` |
| `src/interaction/isolated-auditor.ts` | `180CB34B2B8A2171E438CCAFC1A8E8272D60AB3E9837D31ABC1D17C5F6854399` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Final fixed package

| Path | Final SHA-256 | Disposition |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | unchanged approved authority |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | unchanged approved authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-brief.md` | `DF0C80E6A150EA335D241BFBDDC5A622F794144CB47D6BF0BFEDF0B507E0A4E1` | unchanged fix authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-brief.md` | `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E` | unchanged prior fix authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-report.md` | `48C2FCED0D70541138D8066292023BE5155B924E01AD00CF66779C8D77311E46` | unchanged prior evidence |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-manifest.md` | `EE5F4BC95F6598CED13CDF5C3D1F3A98BE0053A31C41FE109D0919111DC5F306` | unchanged prior package |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-review.md` | `C7CF94321CEAEFF01A9670BC9C129DC7C024EFAFCD2EE7E2137CF39803AD21EA` | unchanged failed-review authority |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` | unchanged limit owner |
| `src/interaction/discover-candidates.ts` | `3552F8CA91F75B5B835BFE7EE4B2DE202CBF35041F688740D56DC5327F2DE3A6` | changed: invocation text owner and primary presence |
| `src/interaction/isolated-auditor.ts` | `9EDBFF6B7ADFE79053F2507A012262092C6AA874D849C9FCDC2C77C044BBCCCD` | changed: neutral/default and complete-absence evidence mappings |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` | unchanged typed evidence authority |
| `tests/integration/isolated-interaction.test.ts` | `F5A889FF7F52682CD810CB3DAB3569D8116BD303CEAAA0CA0EFE860E1F70E894` | changed: RED/GREEN and migrated secondary-cap contract |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` | unchanged Guard discovery-consumer regression |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` | unchanged hostile fixture |
| `dist/interaction/discover-candidates.js` | `824F4AA98B8B7D5B84836B1C61F7E03B9A3C21A7B2F760AB3E06CD22ABAC7909` | emitted by successful build |
| `dist/interaction/isolated-auditor.js` | `F43E36297575B4AD11A395FAAC7303B08E5BC19B15B9835C06EDD2CEB728A318` | emitted by successful build |
| `dist/evidence/interaction-collector.js` | `4FB4D0823865232946AE7610890AA833FB87DE476AB1656469CDA262817AF11D` | unchanged emitted evidence authority |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged package authority |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged dependency authority |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged typecheck authority |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged build authority |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged test authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-report.md` | `EF121EEB23F87BF8F409B29819C701997D1B4071362D74E118BFB1347B1DBC72` | new correction evidence report |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `61D54731C4B6E690942C1481DB8FB64427F3C55107725B81ACAD361B56F9F0EA` | append-only checkpoint ledger |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `3D53570100E1E51EB0FC70536017CC4C7C413D7D9368101CA99B07F62CE50302` | append-only SDD progress/not-run ledger |

## Review boundary

Review the three fix-round-1 Importants against the approved design, Task 2 plan, fix-round-2 brief/report, current production/tests, and this manifest. Verify the invocation-wide secondary text owner and no-partial behavior, `undefined` primary-presence preservation with and without cleanup errors, and exhaustive neutral-versus-complete-absence evidence semantics. Reconfirm all prior I1–I6/M1–M3 fixes remain intact. Historical I7 is an explicitly adjudicated temporal evidence deviation, not a claim of retroactive TDD.

All required implementation gates are fresh and passing. Independent re-review itself is NOT RUN/controller-owned. No Git, dependency/library download/install/update/new import/package mutation, live-target access, correction Task 3/4, product Task 12+, or implementer-spawned review occurred.
