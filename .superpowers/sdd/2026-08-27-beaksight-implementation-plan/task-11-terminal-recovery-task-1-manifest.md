# Task 11 terminal recovery — fixed Task 1 review package

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. This is a no-Git fixed-content review index; each relative path below is pinned by SHA-256. Independent review remains pending. Task 2+ must not start before approval-blocking Task 1 findings are resolved.

| Path | SHA-256 |
| --- | --- |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md | 1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md | A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D |
| src/safety/passive-request-guard.ts | 0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2 |
| src/browser/context-factory.ts | 6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508 |
| tests/integration/passive-request-guard.test.ts | A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1 |
| tests/component/context-factory.test.ts | F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9 |
| package.json | 75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233 |
| package-lock.json | A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md | 1C98AE6F5B2CAB890948E312BD3108039AF6AE1984555DFA627D488FD12C219C |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md | 1F3642997763868C8558395051E3178B63F92ACA0FF6F9E6974FBF0B3FEDFCC1 |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md | C13547F9C355DC4B141EBE2799A882FDD14A73554B0715BF0E0D703B73C9FB6E |

Review must independently adjudicate retry liveness, overlapping normal/retry callers, publication before synchronous re-entry, drain-only retry, terminal-only owner release, invalidation priority, original-cause preservation, and construction handoff without implicit retry. The implementation report records controller rulings, genuine REDs, supplemental already-green checks, all intermediate failures/interrupted runs, and final verification (focus 23, two-file 128, repository 449; typecheck exit 0). Build and independent reviews are explicitly NOT RUN by this implementer. No Git, dependency, live-target, or Task 2+ work is included.
