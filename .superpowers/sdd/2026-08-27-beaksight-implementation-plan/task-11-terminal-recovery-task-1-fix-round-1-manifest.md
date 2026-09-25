# Task 11 terminal recovery — fixed Task 1 round-1 review package

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. No-Git fixed-content index for I1/I2 independent re-review. This new package preserves the failed review and historical manifest. Task 1 approval is pending; Task 2+ and Task 12 must not start.

| Path | SHA-256 |
| --- | --- |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md | 1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E |
| doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md | A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D |
| src/safety/passive-request-guard.ts | E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB |
| src/browser/context-factory.ts | 6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508 |
| tests/integration/passive-request-guard.test.ts | F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF |
| tests/component/context-factory.test.ts | F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9 |
| package.json | 75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233 |
| package-lock.json | A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md | 17028C242B03A28B85A3E3C0980C45C5C7B12269805FF6D49D497253762E70F9 |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md | 58192365F35F91C2727A7B6C1418294F93971BA2C570303CF63D05FA803BB72E |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md | 66E0B6642EF7C5E7CAEA04A9C660BAC910148A82AE56DD476A5CE2E56A8BB62C |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-review.md | 9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-manifest.md | 32597D2FB33DDEB31E564F6AE022232FEFE99DE176BBB3C9019B285E614DEE45 |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-brief.md | CF5886FCF9BBB2865AB1ECF106B18CCC370EA843D9D05D2D518ACBA36C51B162 |
| .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-report.md | C8D7C08FD9F94B223A94EE80AF3B32052AFE8E438B161826B01FD5180E396184 |

Re-review must adjudicate one attempt per protocol callback for synchronous/direct rejection; original raw failure identity; explicit owner-only retry after that failed event; total hostile-value containment; bounded raw/owner failure ledgers; and preservation of overlap, publication, invalidation priority, drain-only retry, terminal release, and primary causes. Fresh evidence: RED 5 failed with production frozen; GREEN focus 5, expanded 28, scoped 133, repository 454; typecheck exit 0. Build and independent review were intentionally NOT RUN by the implementer. The report records exact commands, failure accounting, self-review, unchanged historical items, and all constraints. This manifest's own hash is supplied at handoff to avoid self-reference.
