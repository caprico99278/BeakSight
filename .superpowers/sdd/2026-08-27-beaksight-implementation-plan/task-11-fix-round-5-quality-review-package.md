# Task 11 fix round 5 final code-quality re-review — Git-free SDD

Status: fixed-scope, read-only, final quality re-review. Git operations are prohibited.

## Review instructions

Verify all 35 SHA-256 entries before review. Read the Task 11 implementation brief/report, all review and fix-round briefs/packages, the plan/progress ledger, and every manifested source, test, and fixture.

Adjudicate all five entering Important findings and the rectangle Minor from the prior code-quality review:

1. every guard-owned asynchronous listener task is tracked and bounded-drained before the owner close/final audit snapshot, including deferred download/popup cleanup failure and close-time task creation;
2. candidate NodeLists, retained ordinal lookup, candidate text, and referenced label text are bounded before enumeration/materialization, including hostile iterator/text access;
3. every Safety Ledger category, string, method-key map, and counter is bounded/saturating with one nonrecursive overflow signal and immutable bounded snapshots;
4. every late freeze event is authoritative, including an initially `REJECTED_UNSAFE` candidate;
5. ElementHandle disposal failure cannot overwrite prior click/safety/work status, reason, or evidence, and both failures remain observable when applicable;
6. rectangle consistency includes `x === left` and `y === top` within tolerance.

Also perform an independent code-quality pass for correctness, lifecycle races, hidden authority, deadline behavior, fail-closed semantics, bounded hostile inputs, immutable evidence, exact-handle identity, deterministic error/status precedence, non-vacuous tests, and dependency/package drift. Browser fact-extraction duplication may remain Minor only if safe consolidation would require page-visible mutable state or string evaluation; verify both paths enforce the same bounds.

PASS requires 0 Critical and 0 Important. Report Minors separately. Read-only only: no edits, Git, dependency/download/import operation, live target, or subagent. Narrow tests and typecheck are allowed; use only the existing locked Chromium if browser verification is needed.

Existing evidence: genuine RED across all entering groups; implementer focused 167/167, adjacent 191/191, typecheck/build PASS, repeated full repository 378/378 PASS after one worker-process exit with no test failure; root fresh unit 30/30, browser integration 103/103, Task 5/11 focused 163/163, typecheck/build PASS.

## SHA-256 manifest

```text
D63A211007C97368FA46EAD8D65CDFCC750AFDCA4B144175404495C6DCC8A9DF  src/safety/interaction-policy.ts
1546FF3482EA43A374E4EF4E60147B9735D95D262C715DA49B0DA0F4366BB9E2  src/interaction/discover-candidates.ts
5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761  src/evidence/interaction-collector.ts
BD8FCB49BB765D27BBB18E8CC4562185B87BDDC326F96549A9C626558291BED0  src/interaction/isolated-auditor.ts
1C0E00688A903895D265CAADCFB13D142752918BD7CEAA99EA4CBC197ACA8A3B  src/safety/passive-request-guard.ts
300CADB73A335E872860F9AE2B00325252FAA96A33DA01F36B539A2E584D2C23  src/safety/safety-ledger.ts
359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A  src/browser/context-factory.ts
02B5E4C9936FF6CEFBE1322F0EB9F0946E3A91E2563FB0E5E14D104E7E08AC75  tests/unit/interaction-policy.test.ts
8E94738F15C77E624FD066759E033DFF5FC9570BCB1B0E176AB2406E4A47CD39  tests/unit/safety-ledger.test.ts
FD07D0DC94E7388CF8BC0EFBB196AC11E83AFF0E2F148CB258FFD798E6E0146D  tests/integration/isolated-interaction.test.ts
3D4C7694B763C6B0824F0204555DFCD7808F13F0292898910A3E7D2D5C9EB636  tests/integration/passive-request-guard.test.ts
236D12FD9122988D419317AAC7B52DD8C934D4C33D8C004DFF5C74D38CCDF166  fixtures/site/accordion.html
B7CB9767B03384366E70C79EF2D606186546F6F477392C0B0E327C12E9ABA4D4  fixtures/site/candidate-overflow.html
1EC78EFD9093E13F7E6E3E2BD89FE2ABBA56B507E21726581C451D2E0607820E  fixtures/site/download-button.html
F390C9B3BFAD25B59120C9D6BD21DED535EDB6F68FC3F39921575386CFA5D203  fixtures/site/external-link.html
50CAF1B7BB6E9F9B537B019460C2062F4D9216E34E4273EA88B3C2754B0C7F71  fixtures/site/fixture-service-worker.js
B3169A77082168831C4A307EC50D36A6B827953AF58E0FFBBFF900605026380D  fixtures/site/mailto-link.html
4A92C0ADEEB193F3E0335A15B6269A4B1519D19CFEEBDEF1FF232D3FCF68B8FA  fixtures/site/mutation-button.html
4D2E66829560EAA61E5546B6490D35F66E68BC2B2AE4B876BBCDA858D8956CF8  fixtures/site/navigation-button.html
B0CE20B438A309346D969CBBE32B6AD088C91C218515334F63713C9CFD060682  fixtures/site/popup-button.html
6792FE0F791850073EB82BA485D3D9443F16A2616BEB8A2DDCCF7027C8F14559  fixtures/site/service-worker.html
CE2741CF37C4C11AC436D855B5B45EB4DF851F016BDBB875CC093FE6E63D5658  fixtures/site/tel-link.html
8E3E8DF77D9A5914722450F0C2B9965502DAD1222E5F160AD455C7EA0FA8E461  fixtures/site/websocket.html
2DBB955E2E536AC0843534DF00B4D9DEA5E6A0FB0E6E780567C32BB951F59CF4  fixtures/site/missing-button.html
86B69AA6135DE4EC860973A9AE35BAD22055D2A6DF6CD37899A913B2F19C421B  fixtures/site/ambiguous-button.html
1016436419D4503E997459BB314F862F69C567285FDF7398408B91DA0164165C  fixtures/site/replacement-button.html
ABE932AB0B44A08410E82E381355D89D47695858B194B1DC7F46CA4A74949590  fixtures/site/hidden-candidates.html
272CB4991C8FAFE785A2D61C0E6D04ABCA94CC1FFC461EC8B5D27747ED7C4305  fixtures/site/self-hide-button.html
66DBE700C707E0373A3D457A7A8192649DAEB55D35A07AD20D273CE574C73F95  fixtures/site/initial-duplicate-button.html
A4B58CCAF5F148F2A22342FEB5388E88CE00D4ED5CD074EFD4E64D8F188C44F4  fixtures/site/missing-aria-controls.html
57E90F400E219C1F8D5D51E5A7B536AD06ABEC9CA38095DE38A9889116B1BBF1  fixtures/site/hostile-candidates.html
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```
