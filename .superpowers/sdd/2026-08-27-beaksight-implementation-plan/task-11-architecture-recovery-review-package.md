# Task 11 Architecture Recovery Final Fixed Review Package

Status: fixed-scope Git-free mandatory checkpoint review. Implementation is not complete until both fresh reviews PASS.

## Non-negotiable review rules

Verify all 48 SHA-256 entries before reading/reviewing them. Any mismatch is a blocking manifest failure. Work read-only. Do not edit files, use Git, download/import/update dependencies, access a live target, save review artifacts, or delegate/subagent.

Both reviews require zero Critical and zero Important findings. Enumerate every Minor. Tests may use installed dependencies and the existing local Chromium only.

## Shared contract

Review the full Task 11/Task 5 recovery result, not just Task 5's last diff:

1. one Guard phase authority and one published Context invalidation/close owner; final freeze evidence is authoritative;
2. bounded pending tasks, expected-failure/redirect registries, correlation strings, and stable drain without self-await;
3. candidate NodeLists and descendant traversal are bounded before materialization, with identical SHOW_ALL algorithms and one aggregate 512-node/1,024-character budget;
4. every non-null ElementHandle has one disposal owner; dispose failure cannot overwrite work evidence;
5. once a session exists, work/close failures become one immutable result; arbitrary hostile rejection values cannot escape; final precedence is freeze, close failure, work outcome;
6. Context/CDP/Page listeners have named exact inverse cleanup, attempted once after successful Context close, before final stable drain/CLOSED; cleanup failure is ledgered and does not stop later cleanup; close rejection retains fail-closed listeners and invalidating phase;
7. Safety Ledger bounds/immutability, request policy ownership, deadline authority, exact retained-node identity, S03-S08 zero-delivery proofs, and no second interaction entry point remain intact;
8. no target identity, string-evaluated callbacks, DOM marker mutation, dependency drift, or package drift.

The five architecture-recovery entering blockers to explicitly adjudicate are: total DOM traversal work; frozen-versus-closing authority; pre-owner Handle disposal; encoded work outcome plus close failure; bounded guard correlation bookkeeping. Also adjudicate all recovery Tasks 1-5 completion criteria and the three documented deferred Minors.

## Reviewer roles

### Fresh specification review

Trace the approved web-audit design, original implementation tasks/plan, Task 5/6 reports, Task 11 historical report, recovery design/plan, and current code/tests. Adjudicate requirement coverage, S03-S08, Task 5 policy ownership, exact Handle identity, absolute deadline, immutable evidence, no second entry point, all five recovery blockers, and Task 5 listener lifecycle. Report any missing/contradictory requirement or vacuous proof.

### Fresh code-quality review

Independently inspect lifecycle/re-entry races, task/registry bounds, listener installation partial-failure cleanup, listener removal failures, successful/failed owner and invalidation close, late events, hostile error values, traversal bounds, Handle/result ownership, status precedence, Safety Ledger bounds/immutability, test strength, maintainability, and scope/package drift. Do not rely on the specification review.

## Fixed verification evidence

- Task 5 genuine teardown RED: 1 failed, 84 skipped; arbitrary undefined Context-close RED also genuine.
- Task 5 final focused: 6 files, 199/199.
- Adjacent: 2 files, 47/47.
- Full repository: 26 files, 414/414 on first run; no worker retry.
- Controller listener focus: 5/5; controller full repository: 414/414.
- Typecheck/build: PASS for implementer and controller.
- Forbidden-boundary scan: exit 1/no matches.
- Package hashes unchanged. No Git, dependency, or live-target operation.

## Fixed 48-entry SHA-256 manifest

```text
D63A211007C97368FA46EAD8D65CDFCC750AFDCA4B144175404495C6DCC8A9DF  src/safety/interaction-policy.ts
E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1  src/interaction/discover-candidates.ts
5A3C94CF9D16BF245948AF4009A563B2FF6719C9610BB5C3A37D3476B99B4761  src/evidence/interaction-collector.ts
DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814  src/interaction/isolated-auditor.ts
5B51E854FD09165BB21CDA5FAAAE10F7587E7B179C31157C426D459D76A9CCDF  src/safety/passive-request-guard.ts
300CADB73A335E872860F9AE2B00325252FAA96A33DA01F36B539A2E584D2C23  src/safety/safety-ledger.ts
359EC0B050930F1A27747E8137AE1308510D8D3B83E16A099F20F5FCE487499A  src/browser/context-factory.ts
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
02B5E4C9936FF6CEFBE1322F0EB9F0946E3A91E2563FB0E5E14D104E7E08AC75  tests/unit/interaction-policy.test.ts
8E94738F15C77E624FD066759E033DFF5FC9570BCB1B0E176AB2406E4A47CD39  tests/unit/safety-ledger.test.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
8BE9A65549A1EC73CB2EEA7A40F4F6E9A0C33E18A9E987DF3CBA826FC28B94D0  tests/component/context-factory.test.ts
E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B  tests/integration/isolated-interaction.test.ts
5780BDE5F3A00EAF51E16A92AE6B67A1FF054A35E1EA2AAFFC60C6B76513998F  tests/integration/passive-request-guard.test.ts
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
755A6F10B14968EF7FF637110625F327D689F98E1A8EC54BEC25873B49B1B79F  fixtures/site/hostile-candidates.html
9870AECCC9B4830C2C89E778FC7B929A7888F64BCF17238CCB07C430D9FB9919  fixtures/site/multi-root-candidates.html
095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184  vitest.config.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A  package-lock.json
7F77E391A13E48E0BE183013DCBC13C3DFCCE392B30592267101BFAB2B3CAE4F  doc/design/2026-08-27-beaksight-web-audit-design.md
D960A4D29680ADB5E55A41B14B41EBBC6884C7467A340377A50B05102B8C1BE7  doc/design/2026-08-27-beaksight-implementation-plan.md
1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B  doc/design/2026-08-27-beaksight-implementation-tasks.md
D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18  doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md
994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25  doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md
50A83FDE383F2F6DB69A07D92F8B22C090758911EEDE441D6895D4B8DB955189  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-5-report.md
38EBAB7CC7C0D631231706144759BF2477F50A720E8EAC571595F6A95AFABA2A  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-6-report.md
035C49DA79741545BCD56B698C200B2AEB567E5EFAC257257D171F7C6B15EB0A  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-report.md
DF2276DC918059C1507FA3D4410242D5F83799CF1E93B03B99E3693AD4B2DEDD  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```
