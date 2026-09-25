# Task 11 terminal recovery correction — owner retention/requestfailed fixed review package

Date: 2026-09-22. Root: `C:/Develop/github-repo/BeakSight`. Status: fixed no-Git package for controller-owned fresh independent review. Task 11 is not approved and Task 12+ remains blocked.

## Reviewer rules

Independently recompute every SHA-256 entry before conclusions. Any missing path, mismatch, duplicate path, or drift is a blocking manifest failure. Work read-only: do not use Git; do not edit production/tests/evidence; do not download, install, import, update, or mutate dependencies/packages; do not access a live target; do not delegate or spawn another reviewer/subagent. Reviewer-run evidence must remain separate from implementer/verifier evidence. Report every command run and every omitted gate with reason and impact. PASS requires Critical 0 and Important 0.

## Ancestry and comparison

Prior 89-entry package at this same path had SHA-256 `A35D738CB3807488D5162744BCB3DE306B539092E87AF0474429EB271C115068`. Its complete historical content is retained by the 89 ancestry paths below; this correction adds its fixed brief and implementation report.

- Prior manifest: 89 entries / 89 unique paths.
- Current manifest: **91 entries / 91 unique paths**.
- Comparison: **8 substitutions / 81 unchanged / 2 additions / 0 removals / 0 missing / 0 duplicate paths / 0 mismatches** at creation.
- Substitutions: `src/browser/context-factory.ts`, `src/interaction/isolated-auditor.ts`, `src/safety/passive-request-guard.ts`, `tests/component/context-factory.test.ts`, `tests/integration/isolated-interaction.test.ts`, `tests/integration/passive-request-guard.test.ts`, `task-11-recovery-task-5-report.md`, and `progress.md`.
- Additions: `task-11-owner-retention-requestfailed-brief.md` and `task-11-owner-retention-requestfailed-report.md`.

Historical Task 2 I7 remains an adjudicated irreversible absence of the original Task 2 pre-implementation behavioral RED. This fix-round RED proves only the ordinal-cap repair and must not be represented as retroactive repair.

## Correction and evidence to adjudicate

The current correction addresses the two user-reported Important findings after the previous review package: an audit could return normally while its Context owner remained non-terminal and unreachable, and `requestfailed` async work lived outside the Guard Task Registry. Review the binding two-attempt total cleanup budget, canonical terminal check after each settlement, exact-session structured `InteractionOwnerCleanupError` handoff after exhaustion, frozen independent work/lifecycle/safety axes, arbitrary rejection presence including `undefined`, and successful upper-layer recovery through the same Factory/Guard path.

Also review that the registered `requestfailed` callback is synchronous/void, delegates immediately through the existing `runGuardProtocolTask` and shared `pendingTasks` admission/drain path, calls non-owning `requestInvalidation()`, contains its listener-facing completion, observes callbacks emitted during raw close, and preserves the 256-task cap with one overflow invalidation owner. A second registry, background retry, global owner table, or optional/default terminal state is forbidden.

Fresh implementer evidence, to verify rather than inherit as reviewer execution: accepted unchanged-production RED 8 failed / 2 passed / 250 skipped; correction focus 10/10; exact close retry 1/1; retained-owner recovery 5/5; Task 11 focus 49/49; lifecycle race 44/44; Guard bound 5/5; requestfailed race 6/6; DOM budget 23/23; isolated interaction 124/124; passive Guard 117/117; context factory 19/19; six-file regression 309/309; repository 26 files / 524 tests; typecheck/build exit 0; both forbidden scans clean; package/lock fixed. Full commands, excluded restricted Chromium attempts, test migrations, and not-run ledger are in the new report.

## Fixed 91-entry SHA-256 manifest

| Path | SHA-256 |
| --- | --- |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `src/interaction/discover-candidates.ts` | `3A484C01FBDD8AE722476001040672AE0D70FFAA0D5501D7ED2447BA827614C9` |
| `src/evidence/interaction-collector.ts` | `52F3964790861CC20EB4BF30270504A08AFE3E76B695573E30AE8F7E4AA2E365` |
| `src/interaction/isolated-auditor.ts` | `0A030F675C5CCE748416006A5B2FA1EBD2016EA633C4B27A9C88BDBA11A63059` |
| `src/safety/passive-request-guard.ts` | `49921091F4A92C5C7D9ADBE8CBA3621C6542B657E64217DFA5407B49CB02B7E3` |
| `src/safety/safety-ledger.ts` | `300CADB73A335E872860F9AE2B00325252FAA96A33DA01F36B539A2E584D2C23` |
| `src/browser/context-factory.ts` | `454261DD6964756E9C06C4B9FD1C1CB80E14FDA5D458CCDC06549E6C973B6D6D` |
| `src/safety/request-policy.ts` | `9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788` |
| `src/core/contracts.ts` | `2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4` |
| `tests/unit/interaction-policy.test.ts` | `02B5E4C9936FF6CEFBE1322F0EB9F0946E3A91E2563FB0E5E14D104E7E08AC75` |
| `tests/unit/safety-ledger.test.ts` | `8E94738F15C77E624FD066759E033DFF5FC9570BCB1B0E176AB2406E4A47CD39` |
| `tests/unit/request-policy.test.ts` | `9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD` |
| `tests/component/context-factory.test.ts` | `6C89F85B0A0582C552EFBE4737F3C78B68767F6466B002CBB8BF2BBFE7AB1670` |
| `tests/integration/isolated-interaction.test.ts` | `86B9AACF119734289DABD98EF319AFF00D915E91C40C7184E82FEA241621019E` |
| `tests/integration/passive-request-guard.test.ts` | `9E7617A4A06E15067073FE0287DA7B72205D01A05B2346448889945DEF8D81C6` |
| `fixtures/site/accordion.html` | `236D12FD9122988D419317AAC7B52DD8C934D4C33D8C004DFF5C74D38CCDF166` |
| `fixtures/site/candidate-overflow.html` | `B7CB9767B03384366E70C79EF2D606186546F6F477392C0B0E327C12E9ABA4D4` |
| `fixtures/site/download-button.html` | `1EC78EFD9093E13F7E6E3E2BD89FE2ABBA56B507E21726581C451D2E0607820E` |
| `fixtures/site/external-link.html` | `F390C9B3BFAD25B59120C9D6BD21DED535EDB6F68FC3F39921575386CFA5D203` |
| `fixtures/site/fixture-service-worker.js` | `50CAF1B7BB6E9F9B537B019460C2062F4D9216E34E4273EA88B3C2754B0C7F71` |
| `fixtures/site/mailto-link.html` | `B3169A77082168831C4A307EC50D36A6B827953AF58E0FFBBFF900605026380D` |
| `fixtures/site/mutation-button.html` | `4A92C0ADEEB193F3E0335A15B6269A4B1519D19CFEEBDEF1FF232D3FCF68B8FA` |
| `fixtures/site/navigation-button.html` | `4D2E66829560EAA61E5546B6490D35F66E68BC2B2AE4B876BBCDA858D8956CF8` |
| `fixtures/site/popup-button.html` | `B0CE20B438A309346D969CBBE32B6AD088C91C218515334F63713C9CFD060682` |
| `fixtures/site/service-worker.html` | `6792FE0F791850073EB82BA485D3D9443F16A2616BEB8A2DDCCF7027C8F14559` |
| `fixtures/site/tel-link.html` | `CE2741CF37C4C11AC436D855B5B45EB4DF851F016BDBB875CC093FE6E63D5658` |
| `fixtures/site/websocket.html` | `8E3E8DF77D9A5914722450F0C2B9965502DAD1222E5F160AD455C7EA0FA8E461` |
| `fixtures/site/missing-button.html` | `2DBB955E2E536AC0843534DF00B4D9DEA5E6A0FB0E6E780567C32BB951F59CF4` |
| `fixtures/site/ambiguous-button.html` | `86B69AA6135DE4EC860973A9AE35BAD22055D2A6DF6CD37899A913B2F19C421B` |
| `fixtures/site/replacement-button.html` | `1016436419D4503E997459BB314F862F69C567285FDF7398408B91DA0164165C` |
| `fixtures/site/hidden-candidates.html` | `ABE932AB0B44A08410E82E381355D89D47695858B194B1DC7F46CA4A74949590` |
| `fixtures/site/self-hide-button.html` | `272CB4991C8FAFE785A2D61C0E6D04ABCA94CC1FFC461EC8B5D27747ED7C4305` |
| `fixtures/site/initial-duplicate-button.html` | `66DBE700C707E0373A3D457A7A8192649DAEB55D35A07AD20D273CE574C73F95` |
| `fixtures/site/missing-aria-controls.html` | `A4B58CCAF5F148F2A22342FEB5388E88CE00D4ED5CD074EFD4E64D8F188C44F4` |
| `fixtures/site/hostile-candidates.html` | `755A6F10B14968EF7FF637110625F327D689F98E1A8EC54BEC25873B49B1B79F` |
| `fixtures/site/multi-root-candidates.html` | `9870AECCC9B4830C2C89E778FC7B929A7888F64BCF17238CCB07C430D9FB9919` |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `doc/design/2026-08-27-beaksight-web-audit-design.md` | `7F77E391A13E48E0BE183013DCBC13C3DFCCE392B30592267101BFAB2B3CAE4F` |
| `doc/design/2026-08-27-beaksight-implementation-plan.md` | `D960A4D29680ADB5E55A41B14B41EBBC6884C7467A340377A50B05102B8C1BE7` |
| `doc/design/2026-08-27-beaksight-implementation-tasks.md` | `1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B` |
| `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md` | `E120B2EB31A02C1C1E37F56F5148586AE6322EFE31311BBE327BCA1F8B5820CD` |
| `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` | `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md` | `50A83FDE383F2F6DB69A07D92F8B22C090758911EEDE441D6895D4B8DB955189` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-6-report.md` | `38EBAB7CC7C0D631231706144759BF2477F50A720E8EAC571595F6A95AFABA2A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-report.md` | `035C49DA79741545BCD56B698C200B2AEB567E5EFAC257257D171F7C6B15EB0A` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `CE8308D123583E53B74A3E326D3B884DB864FF1CC43769C3D84845AF655D1AD3` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` |
| `fixtures/site/total-dom-budget.html` | `651718C2D963AF4B2BE8021EC1BB605A1FD8BDF50269CA0DAC7768543AD9326F` |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-review-package.md` | `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `5441F9F2F10D1D47163ACA1DF33587CE35A83A3B2307B0806E411F825E7144F2` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-5-review-package.md` | `419D59126CB6757FBCCB5A502C963229AC1457CA94121F23F9FF07F6DBDC7057` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-5-spec-review.md` | `628C4BE984B538C00A21C5850927CA0BC8918E9A780B9C85EEE7640916E70724` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-5-quality-review.md` | `20689F473672042FA0A163FC34950C979F1BA824C882274661FC8D21FDEC5664` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-brief.md` | `5CD9BE35C8C9E4C6719BB2FE1756A498FFD3139D90FE9A118434820343812D24` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md` | `17028C242B03A28B85A3E3C0980C45C5C7B12269805FF6D49D497253762E70F9` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-manifest.md` | `32597D2FB33DDEB31E564F6AE022232FEFE99DE176BBB3C9019B285E614DEE45` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-review.md` | `9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-brief.md` | `CF5886FCF9BBB2865AB1ECF106B18CCC370EA843D9D05D2D518ACBA36C51B162` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-report.md` | `C8D7C08FD9F94B223A94EE80AF3B32052AFE8E438B161826B01FD5180E396184` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-manifest.md` | `9A4D978BAD4FAE013C450CE5107657D4EC4F118713BCDE1869091A83589C0354` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-fix-round-1-review.md` | `CD05B0D70F5FD1A141396912F505F61119B265EAFD92CFA94C3A02CE8B210D36` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-brief.md` | `D010E1B3C77D3ECC3B33EBD540935F62FF3EEC95CA18A9ABF37D142E698FA563` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-report.md` | `12D992908C03588D61F3AD3DA7866608A5512595E5BCC0093CA31F52CABB32A2` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-manifest.md` | `13670E733034D8E6D06BB466EF527B97060125EAD23B138F2363EAE918B76847` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-review-package.md` | `BDF944A84A5EF298FC620C503A539420EBC8118ACC17557B19EAF5C65C113BEE` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-review.md` | `BEE091885E1ED3BB2713BD8EDDF36E0F55021E8A112238E46F0BD3C54230AB68` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-brief.md` | `84FF150BF67B2858E572D3C0C5EEC6EAAEFAA5E2DA5ACEE2CBAF211FD7D37D4E` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-report.md` | `48C2FCED0D70541138D8066292023BE5155B924E01AD00CF66779C8D77311E46` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-manifest.md` | `EE5F4BC95F6598CED13CDF5C3D1F3A98BE0053A31C41FE109D0919111DC5F306` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-1-review.md` | `C7CF94321CEAEFF01A9670BC9C129DC7C024EFAFCD2EE7E2137CF39803AD21EA` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-brief.md` | `DF0C80E6A150EA335D241BFBDDC5A622F794144CB47D6BF0BFEDF0B507E0A4E1` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-report.md` | `EF121EEB23F87BF8F409B29819C701997D1B4071362D74E118BFB1347B1DBC72` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-manifest.md` | `8249C9AB4E407A0373407685DBA339061D6532B0EC4F888C2FBBACD78BE8B221` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-2-fix-round-2-review.md` | `17F2DC0440F187C03E1221CC2C3942AC0EBBDF1971F03F50F2A00F27180FED91` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-brief.md` | `A9DD67817322532A1B2F749198222CD66DE8BE38E0D520CC09E5E99593247589` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-report.md` | `D0103D00BA27C56B3D1179E1764661607C2F1959280B0C3C09510C0577FB4190` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-manifest.md` | `000F157F0A7B87F67571A0935C0382DC8CE1CD30B068E052027D4B394AA9E066` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-3-review.md` | `FF4984083DC167C1396F800A87B5641D359BD47925ECD6478E87AD4C1873062D` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-4-brief.md` | `C109DE7F7B9832CAB4AB6917FDAC819B74A44B241D17F2A8862B4C98C00246FF` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-4-report.md` | `5465A983CC1B4790C2C63D7D4AD193C472EC29FBAA0DF6E72A044534D215112B` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-spec-review.md` | `B32ECD83D3B614FC6AA9DAC7BE269CEB15A462F5B4B02B8E2918C98B925477E5` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-quality-review.md` | `F84965281C0FDBCCC7EA0216880C86B0AC59B41AA6DDD2F1B36DB1E9B14E1AF4` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-final-quality-fix-round-1-brief.md` | `56055B94A9682947A8933F2411EEFF43A1C118769050A2DD9526D0B7D8ED0E56` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-final-quality-fix-round-1-report.md` | `AECD56176CC39B4A624B59F1134B8FEAB11DE068D0A18B3D31446BB5FD9DA5A0` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-owner-retention-requestfailed-brief.md` | `5191150DAF61DBBE95029286640F3CD7E1639CD8FBF9320C5907F87EF81BF203` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-owner-retention-requestfailed-report.md` | `1F045D678F01BD63F219163777C7AE5973B88FFFDF4BECB1FA706FB14D1AB532` |

## Handoff boundary

The package is intentionally self-nonreferential. Reviewers may create only their controller-authorized review artifact. The controller owns fresh dual re-review, final gate adjudication, and any later fix loop. This package does not approve Task 11 or authorize Task 12+.
