# Task 11 fix round 2 independent re-review — Git-free SDD

Status: fixed-scope read-only re-review. Git operations are prohibited.

## Review instructions

Verify all 33 SHA-256 entries. Read both prior reviews, both fix briefs, current report/progress, and manifested source/tests/fixtures.

Adjudicate the entering round 2 findings:

1. Hidden candidates and same-node hide transitions: finite consistent nonnegative geometry is valid; only visible candidates require positive size. Hidden discovery must not throw, policy must reject NOT_VISIBLE, and a connected admitted node may verify its own visibility/layout change.
2. Initial zero/multiple semantic matches: reason and evidence must consistently be MISSING/AMBIGUOUS.
3. Download Minor: a focused frozen-guard handler test directly observes resolved `Download.cancel()` invocation; data URL record and HTTP `/__download` zero-delivery remain separate.

Reconfirm every earlier Critical/Important correction, S03–S08 primitive proofs, Task 5 SSOT/regressions, deadline, exact ElementHandle, ownership, status precedence, bounded immutability, and evidence-only architecture. PASS requires no Critical/Important; list Minors separately. Read-only: no edit, Git, dependency, live target, or subagent.

## Verification evidence

- Task 11 focused: 50/50 PASS.
- Task 5/6/11 adjacent: 162/162 PASS.
- Full repository: 349/349 PASS across 26 files.
- Typecheck/build: PASS.

## SHA-256 manifest

```text
FA9AB5997725FAF130CA22D1B4AACDAA90414B89DC9392E1911459CA3A4D323C  src/safety/interaction-policy.ts
8CE422281F6405144362E0EAD8EA1E84EB0185032A03D1FBF2777A223C71D0F7  src/interaction/discover-candidates.ts
5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761  src/evidence/interaction-collector.ts
722F34903498BAD2B70B8B14D55F62470941A6F7694556CD0D411D676C974EE9  src/interaction/isolated-auditor.ts
A68DB2A52F6F3E9BAD98389B0F8644A93B62887D01E81565844A9CC5721253F8  src/safety/passive-request-guard.ts
C245786F42B5A622B0C27B1B71AE695EAF9D641C7E00862ADD053F46F1CC34D9  src/safety/safety-ledger.ts
359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A  src/browser/context-factory.ts
FEC44B675B31FD44A74DD731ABBE1F432283101A95ED9E12AA86D6E489041570  tests/unit/interaction-policy.test.ts
99DE0172FC25F6497904704A641CF2832D2423DED8728DE03396A0C9658F93E5  tests/unit/safety-ledger.test.ts
277CF80E38BC64B1D6B0FD48A825B339FD1028ACAEDEB5B28FF580797687BF69  tests/integration/isolated-interaction.test.ts
8A1B2B03988217DF43D42A5E8A28EC5B4480DF459D2E51D1BF3B207D00BDD172  tests/integration/passive-request-guard.test.ts
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
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```
