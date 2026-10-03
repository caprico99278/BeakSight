# Task 11 correction — Task 4 checkpoint verifier brief

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`.

## Scope

Execute approved correction-plan Task 4 Steps 1–10 only: fresh verification, honest not-run ledger, and a fixed no-Git review package. Do not review your own package, edit production/tests/specs/plans, start Task 12+, or authorize Task 11. Dual reviews are controller-owned after this handoff.

Read the complete approved design, complete Task 4 plan section, and final Task 1–3 implementation/review artifacts before acting.

## Frozen starting hashes

Verify all entries before any command or artifact edit; stop on mismatch.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/browser/context-factory.ts` | `26C34D95FF4B104BC5950329B9AECA4B291B75C41F0D51CEA1AC983F51F488A4` |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `3552F8CA91F75B5B835BFE7EE4B2DE202CBF35041F688740D56DC5327F2DE3A6` |
| `src/interaction/isolated-auditor.ts` | `A33F0F5F2F38335C558BEA81B5F5EF806E5D2E577F2493680ADCC4B1E121399A` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `tests/unit/request-policy.test.ts` | `9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD` |
| `tests/unit/safety-ledger.test.ts` | `8E94738F15C77E624FD066759E033DFF5FC9570BCB1B0E176AB2406E4A47CD39` |
| `tests/unit/interaction-policy.test.ts` | `02B5E4C9936FF6CEFBE1322F0EB9F0946E3A91E2563FB0E5E14D104E7E08AC75` |
| `tests/component/context-factory.test.ts` | `88E51355C9AF77ABC346AC2CE13BA77DBFA44E809BAA11ABC2BA9F67C74C388D` |
| `tests/integration/passive-request-guard.test.ts` | `55FC9C0498312FA8A3A21A79AD26408F7A942970B5F834E87B4B05FF42757396` |
| `tests/integration/isolated-interaction.test.ts` | `A3AB1C3FBBD544CF57393D3E67A94E2B0CFDE8A352F78C5450B949A336413D3C` |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-report.md` | `D0103D00BA27C56B3D1179E1764661607C2F1959280B0C3C09510C0577FB4190` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-manifest.md` | `000F157F0A7B87F67571A0935C0382DC8CE1CD30B068E052027D4B394AA9E066` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-review.md` | `FF4984083DC167C1396F800A87B5641D359BD47925ECD6478E87AD4C1873062D` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `8FB0413F4AF54A308D4DAB1F0490CBB4805DEC29CC582317DA1BA8FB7E1CFE9A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `FFEA29486358A6542CF58343E3A2AFF5B21694E78A6EDE24200EC674EC301DB7` |

## Mandatory commands

Run Task 4 Steps 1–8 exactly as written in the approved plan, as separate fresh commands:

1. exact user-required three-file focus;
2. full isolated-interaction;
3. exact lifecycle race suite;
4. exact DOM budget suite;
5. exact six-file Task 11 regression;
6. separate typecheck and build;
7. exact adjacent regression and then `npm test` full repository regression;
8. exact two forbidden-boundary scans and package/lock hash check.

Record command, exit code, file/pass/fail/skip counts, duration when available, and any environment-only attempt. If Chromium `spawn EPERM` occurs before tests, exclude it as product evidence and rerun the identical command with existing approved process-launch permission. If and only if the full Vitest command reports a worker-process exit with no named test failure, rerun it once and record both attempts. Never rerun or reclassify a named failure as environment-only.

Do not modify production/tests to make a gate pass. Any product/test failure blocks the package and must be returned to the controller.

## Ledger and fixed review package

- Append fresh results and exact NOT RUN blocks to the established Task 5 and progress ledgers; do not rewrite prior history.
- Create `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md`.
- Use fresh SHA-256 hashes and include at least every category in Task 4 Step 10: correction design/plan, original recovery authorities, all Task 1–3 production, all changed tests/fixtures, package/lock/configs, all implementation/fix/review artifacts needed to adjudicate the three user findings, current Task 5 report/progress, and unchanged policy/evidence owners.
- Locate and compare against the prior 48-entry Task 11 package without Git. Record total entries, unique paths, substitutions/additions/removals, missing paths, mismatches, and duplicate paths. All final entries must exist and hash-match.
- The package must explicitly prohibit reviewer Git, edits, dependencies, live target access, and reviewer delegation; require independent recomputation and honest reviewer-run/not-run separation.
- Also create `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-4-report.md` summarizing the fresh checkpoint evidence and not-run ledger.

## Constraints

- Allowed edits: Task 4 report, fixed review package, append-only Task 5/progress ledger entries only.
- Use `apply_patch` for edits.
- No Git operation.
- No dependency/library download/install/update/new import/package mutation.
- No live target, no Task 12+, no production/test/spec/plan edits, no subagents/reviewers.
- Historical Task 2 I7 remains an adjudicated irreversible evidence deviation and must stay explicit.
- Task 4 does not authorize Task 12 or user approval by itself.

Stop after the fixed package and report. Return all gate results, package entry/match counts, artifact hashes, and any blocker. Dual independent reviews are controller-owned.
