# Task 11 correction — fixed Task 2 independent-review package

Date: 2026-09-20. Root: `C:/Develop/github-repo/BeakSight`. This controller-frozen no-Git package supersedes the implementer's draft manifest only for review provenance; it does not alter implementation evidence. Task 3+ and Task 12 remain blocked pending this review.

| Path | SHA-256 |
| --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `4350AD955A4E8528D65FBEAACFCC52DDE30F0DBD8DADECAA9E6C4C165C68B5BE` |
| `src/interaction/isolated-auditor.ts` | `14F35D47269506973BAB889A419643200ED42479C3833E93434625996494670B` |
| `tests/integration/isolated-interaction.test.ts` | `E32E31412EBBD6DE8B589641D3F8151E3ED0F8E197426FD0D0F51FE66BF1DFD4` |
| `tests/integration/passive-request-guard.test.ts` | `3074ED672099A3353694C44273E99423D8784218C841E00CB5DCA27568E4ABE6` |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-brief.md` | `D010E1B3C77D3ECC3B33EBD540935F62FF3EEC95CA18A9ABF37D142E698FA563` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` | `12D992908C03588D61F3AD3DA7866608A5512595E5BCC0093CA31F52CABB32A2` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `58192365F35F91C2727A7B6C1418294F93971BA2C570303CF63D05FA803BB72E` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `EDBE57474AC3011A7D8EBB97CF27B40D74765D5CFE59A5897407E7542C5D8175` |

The reviewer must verify every hash before reading conclusions. Required adjudication: one shared budget per each of the three serialized callbacks; all charged paths in the approved specification; no whole-DOM `querySelectorAll`, locator/nth, or equivalent escape hatch; no partial candidate; exact exhaustion versus missing/disconnected semantics; candidate-limit completeness; Node-side validation/deep freeze; exact-handle envelope/property disposal and child-handle lifetime; retained exact identity; auditor mapping; preservation of maxTextNodes/order/replacement/S03-S08 behavior; and fidelity of the hidden-host renderer workaround to the 20,000 and 8,000/9,000 hostile cases.

Implementer evidence recorded in the pinned report: staged API RED; exact-stub behavioral RED; crash diagnostics excluded from RED; Task 2 focus 11/11; isolated interaction 68/68; Guard file 114/114; repository 465/465; typecheck/build exit 0. Independent review must inspect code/tests rather than assume these claims.
