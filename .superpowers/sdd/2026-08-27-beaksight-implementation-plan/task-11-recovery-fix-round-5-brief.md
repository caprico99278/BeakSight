# Task 11 Recovery Fix Round 5/5 — Construction Ownership and Protocol Callback Cutoff

## Status and authorities

Task 11 remains unapproved; Task 12+ are blocked. This is the final correction round. Read these artifacts completely before editing:

- Fix round 4 specification review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-4-spec-review.md`, SHA-256 `F35E38C7137531776EEDE92436E7D51EB1A93611B518B0E449B9DD6646A80B8A`.
- Fix round 4 quality review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-fix-round-4-quality-review.md`, SHA-256 `0F6C699B016A54D50806C89E59453FA1ED018C1964F848035158897F3B179867`.
- Binding lifecycle-priority brief: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-user-lifecycle-priority-brief.md`, SHA-256 `DF86007408C07D0AFCC3704FA38CE77E41951EA4BE26B6F234E1875A05788718`.
- Existing append-only Task 5 report: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md`, SHA-256 `679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA`.

No Git operation is permitted. Do not download/install/update/import dependencies, access a live target, start Task 12, edit `discover-candidates.ts`, or dispatch subagents. Use `apply_patch` for edits.

## Open Important findings

### 1. Construction rejection can strand a non-terminal Context

`createPassiveContext()` registers factory ownership only after Guard installation, and `createInteractionSession()` rethrows Page-readiness failure without returning an owner. When invalidation-time raw close also fails, the Guard remains non-terminal but the caller has no externally reachable Context/session/join path. A private WeakSet entry is not a usable owner.

Required behavioral REDs:

- Guard installation failure plus raw Context-close failure must not strand an unreachable non-terminal Context.
- `createInteractionSession()` Page-readiness failure plus raw Context-close failure must preserve an externally usable owner/join path.

Implement the smallest typed ownership surface that makes the non-terminal owner reachable, or guarantee terminal ownership before construction rejects. Preserve normal construction APIs, original failure information, exactly-one raw close, and terminal-only owner release. Do not add a second lifecycle authority; the Guard phase remains authoritative.

### 2. Failed-request event invalidation leaks rejection

The async Context `requestfailed` listener directly awaits a rejecting invalidation completion. Drain timeout can therefore escape through the listener's returned Promise as `unhandledRejection`, separately from the intentionally rejecting public owner completion.

Required behavioral RED:

- With a pending Guard task and a failed-request-triggered invalidation drain timeout, observe zero process `unhandledRejection`, exactly one raw close, retained non-terminal ownership, and the unchanged public timeout rejection.

Contain fire-and-forget event invalidation at its event boundary without swallowing or replacing the shared public completion. Audit equivalent bare event initiators, including installation-phase `onPage`. Never make a tracked task await the same completion that drains it.

### 3. In-flight HTTP/WebSocket callbacks are outside the stable drain

HTTP and WebSocket route callbacks are asynchronous Guard work but are not in bounded pending ownership. A callback can start while active, remain blocked at the Playwright protocol boundary, then fail after close reports success/CLOSED and after the final Safety Ledger snapshot.

Required behavioral REDs:

- HTTP: start an allowed GET route callback, hold `route.fallback()`, begin/succeed raw close, then reject fallback. Owner close must not report a clean terminal cutoff before `HTTP_FALLBACK_FAILED` and invalidation are accounted for.
- WebSocket: start a route callback, hold the relevant protocol close/handling Promise, begin/succeed raw close, then reject it. The same bounded ownership/evidence-cutoff rule must hold.

Give already-running protocol callbacks bounded ownership through their error/evidence finalization and stop unsafe new admission at the terminal boundary. Preserve delivery safety at admission overflow. The owned callback must settle/remove itself before it initiates invalidation so that it never awaits its own drain. Preserve exactly-one raw close and the existing shared invalidation completion.

## TDD and implementation discipline

Add every RED above before production edits. Run each against unchanged production and record the exact expected failures. Name the production mutation each test kills. Exercise real Guard/factory behavior and restrict fakes/gates to Playwright boundaries.

Implement one coherent ownership correction, not finalizer-only status patches. Preserve all Fix round 4 lifecycle-priority behavior and prior recovery contracts. If the typed construction-owner surface requires a public error/handle, keep it minimal, immutable, and canonical; document why it is not a second close/lifecycle entry point.

## Required verification

After GREEN, run and record:

- all new construction/event/HTTP/WebSocket focus tests;
- the prior Fix round 4 lifecycle-priority focus;
- `tests/integration/passive-request-guard.test.ts`, `tests/component/context-factory.test.ts`, and `tests/integration/isolated-interaction.test.ts` in full;
- the six-file Task 11 regression set;
- adjacent controlled-scroll/performance regression;
- full maintained repository suite once after final production edits;
- `npm run typecheck`;
- `npm run build`;
- forbidden-boundary and production type-escape scans;
- SHA-256 hashes for every changed source, test, report, build output, package/config authority.

Append a complete Fix round 5 section to the existing Task 5 report: root-cause trace, RED/GREEN commands and exact outputs, protocol admission/self-drain analysis, construction-owner API contract, phase/ownership table, all verification counts and retry disclosure, hashes, self-review, and deferred-Minor disposition.

## Dispatch baselines

```text
54B5A1272E21A9508B1305DA8A0A5E93E586BB76EFFA2384DEBE362687B17C28  src/safety/passive-request-guard.ts
F836BA9A3353CC7B70F59060AE3BD1D717F1ED3CC79CE7556DB3D812D1A51CB8  src/browser/context-factory.ts
7D41F62126A4F25EC9F453E78976FC43668039AD4506374D72429AA77A0A2ADE  tests/integration/passive-request-guard.test.ts
350C5E1DF4F5F1E18117C93501D2B73F9C2DDB021FCB77D5A003CF6C3036FA9F  tests/component/context-factory.test.ts
FD255686AD0DDBB09D696EDC64BE0C0465657FEC583C376E62C3FE7A4AE5FD20  tests/integration/isolated-interaction.test.ts
679E28B3BF5496DC490454A0787B4238EEEBEAEB99DCC857C094F63961CC12BA  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```

Three historical Minors remain deferred: lifecycle-phase HTTP abort correlation, asynchronous `emitFailedMainFrameRequest()` return, and Page-readiness task-factory indentation. The pre-existing isolated-auditor BigInt normalization Minor remains outside these three Importants unless the same line must be changed. Report all dispositions; do not silently fix unrelated work.
