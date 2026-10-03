# Task 7 baseline — Git-free

Git operations are prohibited. This SHA-256 baseline replaces diff/status assumptions.

```text
2D7C20136BCFFD9994DD0E4816D96DA5D3B137FABD74BA3FDEACFFEFD41EF5C4  src/core/contracts.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
35F6A759A527D9E4175ED42909240014B3174AA6603976FEE797AAD0FC25AFA6  fixtures/server.ts
75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233  package.json
D960A4D29680ADB5E55A41B14B41EBBC6884C7467A340377A50B05102B8C1BE7  doc/design/2026-08-27-beaksight-implementation-plan.md
1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B  doc/design/2026-08-27-beaksight-implementation-tasks.md
```

- `src/evidence/` is absent before Task 7.
- Production target-isolation scan: no target name/domain/absolute-URL matches in `src/**`.
- Task 6 closing verification: 228/228 repository tests, typecheck, and build PASS.
- Existing dependencies are sufficient; Task 7 must not add/download a dependency without returning for approval.

