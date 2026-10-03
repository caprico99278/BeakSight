# Task 11 correction — Task 3 fixed review manifest

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. Git provenance is prohibited; this manifest is the fixed SHA-256 review package. Independent review must recompute every hash before conclusions.

## TDD production baselines

These hashes were rechecked unchanged after the accepted behavioral RED and before production edits:

| Path | SHA-256 |
| --- | --- |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` |
| `src/interaction/isolated-auditor.ts` | `9EDBFF6B7ADFE79053F2507A012262092C6AA874D849C9FCDC2C77C044BBCCCD` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |

## Final fixed package

| Path | SHA-256 | Disposition |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | unchanged authority |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | unchanged authority |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-brief.md` | `A9DD67817322532A1B2F749198222CD66DE8BE38E0D520CC09E5E99593247589` | unchanged fixed brief |
| `src/browser/context-factory.ts` | `26C34D95FF4B104BC5950329B9AECA4B291B75C41F0D51CEA1AC983F51F488A4` | changed production |
| `src/interaction/isolated-auditor.ts` | `A33F0F5F2F38335C558BEA81B5F5EF806E5D2E577F2493680ADCC4B1E121399A` | changed production |
| `src/interaction/discover-candidates.ts` | `3552F8CA91F75B5B835BFE7EE4B2DE202CBF35041F688740D56DC5327F2DE3A6` | unchanged Task 2 prerequisite |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` | unchanged evidence owner |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` | unchanged Task 1 prerequisite |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` | unchanged policy owner |
| `tests/component/context-factory.test.ts` | `88E51355C9AF77ABC346AC2CE13BA77DBFA44E809BAA11ABC2BA9F67C74C388D` | changed test |
| `tests/integration/isolated-interaction.test.ts` | `A3AB1C3FBBD544CF57393D3E67A94E2B0CFDE8A352F78C5450B949A336413D3C` | changed test |
| `tests/integration/passive-request-guard.test.ts` | `55FC9C0498312FA8A3A21A79AD26408F7A942970B5F834E87B4B05FF42757396` | changed compile-time session fake |
| `dist/browser/context-factory.js` | `F5535A1DEF8F297C635F84DE133007CD6D50D9F721846EE0F03C883B121E2BC0` | current build output |
| `dist/interaction/isolated-auditor.js` | `5E5A745A0ED3B6898DDCF1023FACF4F241FA85338516057DEC0651DCF44A4D5E` | current build output |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged package |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged lockfile |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` | unchanged config |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` | unchanged config |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` | unchanged config |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-report.md` | `C8D7C08FD9F94B223A94EE80AF3B32052AFE8E438B161826B01FD5180E396184` | unchanged prerequisite evidence |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-review.md` | `CD05B0D70F5FD1A141396912F505F61119B265EAFD92CFA94C3A02CE8B210D36` | unchanged prerequisite review |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-report.md` | `EF121EEB23F87BF8F409B29819C701997D1B4071362D74E118BFB1347B1DBC72` | unchanged prerequisite evidence |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-review.md` | `17F2DC0440F187C03E1221CC2C3942AC0EBBDF1971F03F50F2A00F27180FED91` | unchanged prerequisite review |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-report.md` | `D0103D00BA27C56B3D1179E1764661607C2F1959280B0C3C09510C0577FB4190` | implementation report |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `8FB0413F4AF54A308D4DAB1F0490CBB4805DEC29CC582317DA1BA8FB7E1CFE9A` | append-only Task 5 ledger |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `FFEA29486358A6542CF58343E3A2AFF5B21694E78A6EDE24200EC674EC301DB7` | append-only progress ledger |

## Review focus

Trace every finalizer branch and verify: arbitrary rejection values including `undefined`; canonical terminal truth after close settles; terminal invalidation is `CLOSED` despite semantic close rejection; fulfilled non-terminal close is ledgered before snapshot; freeze outranks every lifecycle/work combination; final safety reasons contain no encoded work facts; `result.evidence === result.work.evidence`; result/work/lifecycle/evidence/changedFields/safety arrays and events are immutable; exactly-once close/finalization remains intact; every session fake has explicit terminal ownership; Task 1 retry/terminal release and Task 2 total-DOM-budget behavior did not regress.

Implementation-reported gates are pinned in the report. The reviewer should inspect this fixed package and may run diagnostics for concrete doubts. No Git operation, dependency/library operation, live target, correction Task 4, or product Task 12+ is permitted.
