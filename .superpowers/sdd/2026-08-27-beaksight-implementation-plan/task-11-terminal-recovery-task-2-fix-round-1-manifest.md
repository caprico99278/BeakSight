# Task 11 correction — Task 2 fix round 1 fixed review manifest

Date: 2026-09-20. This is the no-Git fixed package for controller-owned independent re-review. Hash algorithm: SHA-256. The manifest does not self-hash.

## Genuine-RED production baseline

These hashes were rechecked after the accepted test-only RED and before production edits:

| Path | Baseline SHA-256 |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE` |
| `src/interaction/isolated-auditor.ts` | `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B` |
| `src/evidence/interaction-collector.ts` | `5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761` |

The fixed brief itself matched `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E`, and every other frozen entry in that brief matched before edits.

## Final fixed package

| Path | Final SHA-256 | Disposition |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | unchanged approved authority |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | unchanged approved authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-brief.md` | `D010E1B3C77D3ECC3B33EBD540935F62FF3EEC95CA18A9ABF37D142E698FA563` | unchanged original brief |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` | `12D992908C03588D61F3AD3DA7866608A5512595E5BCC0093CA31F52CABB32A2` | unchanged original implementation report |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-review-package.md` | `BDF944A84A5EF298FC620C503A539420EBC8118ACC17557B19EAF5C65C113BEE` | unchanged prior review package |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-review.md` | `BEE091885E1ED3BB2713BD8EDDF36E0F55021E8A112238E46F0BD3C54230AB68` | unchanged FAIL review authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-brief.md` | `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E` | unchanged fix authority |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` | unchanged limit owner |
| `src/interaction/discover-candidates.ts` | `75A7B67AA91AF205CA9AFB379F943F30F72150C05FCFDF6C73DBD626C0D0A9CB` | changed: I1–I5 |
| `src/interaction/isolated-auditor.ts` | `180CB34B2B8A2171E438CCAFC1A8E8272D60AB3E9837D31ABC1D17C5F6854399` | changed: I6 mappings |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` | changed: typed `UNESTABLISHED` identity |
| `tests/integration/isolated-interaction.test.ts` | `DA06A093CDA5CAFA272C04D4862C2F437694A326AECC9FD857A73B345B3A5B61` | changed: correction RED/GREEN and M1–M3 strength |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` | unchanged structured discovery consumer regression |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` | unchanged hostile fixture; exact structure asserted |
| `dist/interaction/discover-candidates.js` | `CA926FE1334B2C37B97B016F31BF90932C97B1A02A14BC6D2BA9CB6911AD61EA` | emitted by successful build |
| `dist/interaction/isolated-auditor.js` | `DA2E8FD2475477F745082436879E17EB2D3C87C5351FCF9E650AA368A8BD8332` | emitted by successful build |
| `dist/evidence/interaction-collector.js` | `4FB4D0823865232946AE7610890AA833FB87DE476AB1656469CDA262817AF11D` | emitted by successful build |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged package authority |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged dependency authority |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged typecheck authority |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged build authority |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged test authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-report.md` | `48C2FCED0D70541138D8066292023BE5155B924E01AD00CF66779C8D77311E46` | new fix evidence report |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `F887635F092BE533414A025D8F3C4CE9E8FF7A5FF2B4B19147393015494AB5B9` | append-only checkpoint ledger |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `0A8480846617A72EDC2810B9024086F30CD101F65312975878B5E99DACDCC6A2` | append-only SDD progress/not-run ledger |

## Review boundary

Review I1–I6 and M1–M3 against the approved design, Task 2 plan, fixed brief, report, current production/tests/fixture, and this manifest. I7 is an explicitly adjudicated historical evidence deviation, not a claim of retroactive TDD. Required implementation gates are reported fresh and passing; independent re-review itself remains NOT RUN/controller-owned. No Git, dependency/package mutation, live-target access, Task 3/4/12+, or implementer-spawned review occurred.
