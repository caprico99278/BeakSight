# Task 6 implementation brief — Git-free SDD

## Authority and constraints

- Binding design: `doc/design/2026-08-27-beaksight-web-audit-design.md`.
- Binding execution plan: Task 6 in `doc/design/2026-08-27-beaksight-implementation-plan.md`, as overridden by `doc/design/2026-08-27-beaksight-implementation-tasks.md` and progress-ledger rulings.
- Git operations are prohibited. Do not touch `.git-sandbox-backup`.
- Use TDD: tests must fail for the missing behavior before production implementation.
- Do not spawn subagents.

## Files

- Create `src/browser/context-factory.ts`.
- Create `src/browser/page-settling.ts`.
- Create `src/browser/controlled-scroll.ts`.
- Create `tests/component/context-factory.test.ts`.
- Create `tests/integration/controlled-scroll.test.ts`.
- Add the minimum lazy-content fixture under `fixtures/site/` and extend `fixtures/server.ts` only if needed.

## Required browser lifecycle

`BrowserContextFactory` receives `Browser`, immutable `AuditConfig`, and a `SafetyLedger` factory by dependency injection. It must not import defaults/global config.

`createPassiveContext(viewport)` must:

- construct a context with injected locale, timezone, viewport, and `serviceWorkers: 'block'`;
- create exactly one ledger from the injected factory;
- install Task 5's passive guard before any Page exists;
- pass a snapshotted/canonical allowed-origin set from injected config;
- close fail-closed if construction/installation fails;
- make its ledger retrievable for later orchestration without adding a second ledger authority.

Add factory-owned page lifecycle methods so later production code never calls raw lifecycle primitives:

- create a Page and await `awaitPassiveRequestGuardReady(page)` before returning it;
- delegate owner Page close to `closePassiveGuardedPage(page)`;
- delegate owner Context close to `closePassiveGuardedContext(context)`;
- reject a Context/Page that was not created/owned by this factory.

Tests must prove readiness occurs before a caller can navigate, service-worker blocking is configured, locale/timezone/viewport are injected, no ledger dependency means no valid factory/context, each Context has isolated ledger state, and guarded close keeps Task 5 ledger truthfulness.

## Settling and controlled scroll

Define narrow immutable policies/results. Required semantics:

- DOM readiness is awaited explicitly; `networkidle` alone is never the ready condition.
- settling observes current document height/DOM readiness over a stable window and returns an explicit settled vs partial result with reason/observations.
- scrolling begins from the document top, uses a bounded fraction of viewport height per step, waits a short deterministic interval, re-reads `scrollY`, viewport height, and `scrollHeight`, tracks height growth, and never assumes a fixed step count.
- completion requires reaching the current bottom and observing a stable-height window; new lazy content must extend the loop.
- the absolute/overall deadline is authoritative. Timeout/closed/evaluation uncertainty returns honest `PARTIAL` metadata and must not hang or claim bottom completion.
- inputs and returned snapshots are not caller-mutable aliases.

Use a real Chromium integration fixture that appends lazy content near the bottom multiple times. Prove final bottom is reached after observed height growth, and add a deadline case proving `PARTIAL` without hanging. Ensure all contexts/pages in tests use the Task 5 guarded lifecycle and `serviceWorkers: 'block'`.

## Verification/report

Run:

```text
npx vitest run tests/component/context-factory.test.ts
npx vitest run tests/integration/controlled-scroll.test.ts
npm run typecheck
npm run build
```

Run the full repository suite if focused checks pass. Write `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-6-report.md` with RED/GREEN evidence, changed files, ownership scans, exact command results, and concerns. No commits.
