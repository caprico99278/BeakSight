# Task 11 Architecture Recovery Final Fix Round 2 Re-review

Read-only, Git-free re-review. The original fixed review package SHA is `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`; the round-1 re-review package SHA is `EF2BD29AAA782A81A2E7E0006358E6F1EA181C30C327E85127C3A526C83B8FE4`.

Verify the original package's 48-entry manifest with exactly these five substitutions. The other 43 entries must remain byte-for-byte identical to the original manifest:

```text
9DB463B3EC0282A4CD76E720178A67C3E5B27DB0F2321A56A2C8C2CB24D5FF55  src/safety/passive-request-guard.ts
ED97E9EA64E4EFE736B4BFC2C43EA2DC729A6EB33D97D832EFAD28D1A778C632  src/browser/context-factory.ts
8E7A30BF0EAF4DA1CE1DBFD1F46055BAE47C79C9D3D19148DE85E22CCA00F941  tests/integration/passive-request-guard.test.ts
8E5F4426F6A562C34AB0CFA1D02DF126C23A53B15E2AE6DAFCD6975540939813  tests/component/context-factory.test.ts
24A79D5C0B71A30DA7F1F325294DD1D4805B4052FA20D0110F04F6B587D6F680  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```

Entering round-1 reviews:

- specification review SHA `0A7A7BAF23E40FDCD84A12BE0407B11A5E11BFBF0D9743B0F2D19AA147321BD0`: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-1-spec-review.md`
- quality review SHA `BDD536772F31DA48D734DB877E03CC3FF2010B514451DFD5ABB4BF12749B8802`: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-1-quality-review.md`

Re-adjudicate every previously accepted blocker and the two round-1 Minor findings, with special attention to these five corrections:

1. the real `BrowserContextFactory` → `InteractionGuardedSession` public-close path retains invalidation ownership and joins the already-published low-level invalidation through raw close, stable drain, and evidence cutoff;
2. the bounded overflow invalidation path consumes only the promise created by `.finally()`, preventing unhandled rejection while preserving the shared rejecting `invalidationCompletion` contract;
3. admission denial rolls back the partially installed Page listener group before starting overflow invalidation, so no unowned listener remains;
4. an abort whose rejection value is `undefined` is still recorded as a failure and cannot resolve successfully;
5. hostile huge `BigInt` normalization remains total and bounded, producing a fixed fallback without unbounded decimal conversion.

Also preserve the earlier corrections and all previously clean contracts: drain timeout cannot report success/CLOSED with live tasks; stable owner/invalidation completion; raw-close-once semantics; bounded Context/Page/CDP cleanup ownership; total bounded guard error normalization; packages/config; and `discover-candidates.ts` SHA `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1`.

Controller ruling: approved recovery design §6 explicitly retains the existing `querySelectorAll` NodeList and requires bounded indexed access rather than iterator/Array materialization. Replacing DOM selection or ancestor traversal is a future design candidate, not a Critical/Important blocker for this Task 11 recovery. Preserve the three historical deferred Minors: lifecycle-phase HTTP abort correlation, asynchronous failed-request helper return, and page-task factory indentation.

Evidence:

- five correction-focused tests: 5/5;
- six-file focused suite: 211/211;
- adjacent suite: 47/47;
- implementer full suite: 426/426, first run and no retry;
- controller fresh full suite: 426/426;
- controller fresh typecheck/build: PASS;
- forbidden production import/escape-hatch scan: clean;
- package, lockfile, Vitest config, and isolated-auditor test unchanged.

PASS requires zero Critical and zero Important findings. Enumerate any Minor findings separately and state whether each is newly introduced, historical/deferred, or a future design candidate.
