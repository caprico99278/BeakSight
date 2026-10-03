# Task 11 Architecture Recovery Final Fix Round 1 Re-review

Read-only Git-free re-review. Original fixed package SHA: `41D51A34EE7D93D5373309D68169C20D25C5947136245ED24E278D022FFC1C44`. Verify its 48-entry manifest with exactly these three HEAD substitutions; the other 45 entries must remain identical:

```text
D0E521349C5DB3DF5357CBD7658C8029829831765BA177B34DC9CD29A0487943  src/safety/passive-request-guard.ts
3A3A545FDF5614EF07B36CB23114F61686F7CEAEF7FFD9F8FE6ABF1B8FB903AA  tests/integration/passive-request-guard.test.ts
E5B53A6949B929A4FF89341260211D5B3AF4457EE73C80163ADEC336D33EB851  .superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md
```

Entering reviews:

- specification review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-final-spec-review.md`
- quality review: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-architecture-recovery-final-quality-review.md`

Re-adjudicate these accepted blockers and correction-scope regressions:

1. drain timeout never returns ordinary success/CLOSED with live tasks; owner and invalidation paths retain invalidating phase, record once, reject deterministically, share stable completion, raw-close once, and cannot become clean after late settlement;
2. public close joins an already-published invalidation owner through raw close, stable drain, and evidence cutoff;
3. cleanup ownership is bounded to one Context group plus at most 64 fixed-size live Page/CDP groups, releases groups on page/session terminal lifecycle, clears before callbacks, continues failures, cleans partial setup, and fails closed once before unowned listener admission at cap;
4. guard error normalization is total and bounded for hostile `instanceof`, getters, and coercion across real guard catch/task/cleanup paths.

Preserve all previously clean contracts, the three deferred Minors, packages/config, and `discover-candidates.ts` SHA `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1`.

Controller ruling for quality finding 1: approved recovery design §6 explicitly retains the existing querySelectorAll NodeList and requires bounded indexed access rather than iterator/Array materialization. A replacement DOM-selection/ancestor-budget architecture is outside this approved Task 11 recovery and must be reported as a future design candidate, not a current Critical/Important blocker.

Evidence: per-finding RED/GREEN F1 2→2, F2 1→1, F3 2 failed/1 passed→3 passed, F4 3→3; combined 9/9; focused 207/207; adjacent 47/47; full 422/422 first run; controller full 422/422; typecheck/build PASS; forbidden scan clean; package/config unchanged. PASS requires 0 Critical and 0 Important. Enumerate Minors.
