# Task 11 independent specification review — Git-free SDD

Status: fixed-scope read-only review. Git operations are prohibited.

## Review instructions

Verify all 27 SHA-256 entries before review. Read the Task 11 plan, web-audit design interaction/S03–S08/Safety Ledger sections, `task-11-implementation-brief.md`, `task-11-report.md`, and all manifested source/tests/fixtures.

Perform specification-compliance review only. Determine whether every Task 11 requirement is implemented and non-vacuously tested:

- generic site-selector-free candidate discovery and bounded immutable descriptive facts;
- mechanical fail-closed rejection of submission/form/navigation/download/special/external candidates;
- owner-managed disposable context, initial passive load, then one-way all-new-activity freeze;
- HTTP/navigation/popup/download/WebSocket blocking and Service Worker interception protection;
- safe accordion VERIFIED only on observable evidence; unsafe/blocked/not-verifiable states truthful;
- S03–S08 fixture server boundary delivery counters/observations remain zero where applicable;
- exactly-once owner close and failure preservation;
- Task 5 authority is extended, not duplicated, and earlier passive behavior remains compatible;
- collectors return evidence only and never Findings.

Report Critical/Important/Minor separately with file/line evidence and smallest correction. PASS requires 0 Critical and 0 Important. Do not edit files, use Git, obtain dependencies, access a live target, or use a subagent. Narrow tests/reproductions are allowed.

## SHA-256 manifest

```text
C639A9E2F1FFAE8D2300C3D0F5BBA6A4C0C9CFD06B696471652C9A73F7053D6A  src/safety/interaction-policy.ts
D51387758DBFA02BFDB1DB52EC4CFC74C517F121B70AB1D6D6B6676E18EB14D1  src/interaction/discover-candidates.ts
97919CDF34485A8360BBAE1E76296AA719CB9E7343EDC723C353FA74D356EC8E  src/evidence/interaction-collector.ts
597237A056664A816FC5AF6CC3B792F83D9BB667160F3137366CBB0468E442DF  src/interaction/isolated-auditor.ts
A68DB2A52F6F3E9BAD98389B0F8644A93B62887D01E81565844A9CC5721253F8  src/safety/passive-request-guard.ts
C245786F42B5A622B0C27B1B71AE695EAF9D641C7E00862ADD053F46F1CC34D9  src/safety/safety-ledger.ts
359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A  src/browser/context-factory.ts
FEC44B675B31FD44A74DD731ABBE1F432283101A95ED9E12AA86D6E489041570  tests/unit/interaction-policy.test.ts
99DE0172FC25F6497904704A641CF2832D2423DED8728DE03396A0C9658F93E5  tests/unit/safety-ledger.test.ts
876C3C60B0D832A697CBC09AB0BB0105FF0C364F892D3A209594BF2B95F67089  tests/integration/isolated-interaction.test.ts
7C34FBE85EF7F9AE8C35166B873B5DE6F2FC99C98774863DBB2199B461787528  tests/integration/passive-request-guard.test.ts
236D12FD9122988D419317AAC7B52DD8C934D4C33D8C004DFF5C74D38CCDF166  fixtures/site/accordion.html
B7CB9767B03384366E70C79EF2D606186546F6F477392C0B0E327C12E9ABA4D4  fixtures/site/candidate-overflow.html
2321ACB3B172C2DA1B01C83171C9D3CE51368C1E6B0EF9A92F0A9F80FA0E1918  fixtures/site/download-button.html
F390C9B3BFAD25B59120C9D6BD21DED535EDB6F68FC3F39921575386CFA5D203  fixtures/site/external-link.html
50CAF1B7BB6E9F9B537B019460C2062F4D9216E34E4273EA88B3C2754B0C7F71  fixtures/site/fixture-service-worker.js
B3169A77082168831C4A307EC50D36A6B827953AF58E0FFBBFF900605026380D  fixtures/site/mailto-link.html
4A92C0ADEEB193F3E0335A15B6269A4B1519D19CFEEBDEF1FF232D3FCF68B8FA  fixtures/site/mutation-button.html
4D2E66829560EAA61E5546B6490D35F66E68BC2B2AE4B876BBCDA858D8956CF8  fixtures/site/navigation-button.html
B0CE20B438A309346D969CBBE32B6AD088C91C218515334F63713C9CFD060682  fixtures/site/popup-button.html
6792FE0F791850073EB82BA485D3D9443F16A2616BEB8A2DDCCF7027C8F14559  fixtures/site/service-worker.html
CE2741CF37C4C11AC436D855B5B45EB4DF851F016BDBB875CC093FE6E63D5658  fixtures/site/tel-link.html
8E3E8DF77D9A5914722450F0C2B9965502DAD1222E5F160AD455C7EA0FA8E461  fixtures/site/websocket.html
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
```
