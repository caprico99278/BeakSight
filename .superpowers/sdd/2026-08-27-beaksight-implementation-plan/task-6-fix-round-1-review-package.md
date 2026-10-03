# Task 6 Fix Round 1 — Git-free review package

Git operations are prohibited. Verify all hashes, then perform a read-only scoped re-review.

## Entering findings

1. Critical: post-deadline SETTLED/COMPLETE and late mutating evaluate after PARTIAL.
2. Important: raw/double Context close after Task 5 install/readiness failure.
3. Important: stale factory-active ownership after Task 5 invalidation/Page-close failure.
4. Important: document shrink did not reset bottom stability.
5. Important: repeated SafetyLedger identity could be shared across Contexts/factories.

Intended fixes include strict post-operation/observation deadline checks, browser-side pre-mutation deadline guards, Task 5 read-only `assertPassiveRequestGuardActive()` SSOT before `newPage`, guarded/no-double cleanup, ownership retirement, any-height-change stability reset, and module-wide WeakSet ledger identity rejection.

Inspect tests for genuine reproduction of exact deadline crossing, late callback release after PARTIAL, shrink stability, install/readiness exact close count, Page close failure and async invalidation before Page creation, same-factory and cross-factory ledger reuse. Review Task 5 assertion addition for semantic duplication or regression. List new Critical/Important; deferred minors remain out of scope unless escalated.

Do not edit, use Git, or spawn subagents. Do not rerun broad verification absent concrete suspicion. Implementer reports focused 18/18, Task5+6 109/109, full suite 222/222, typecheck/build PASS.

## SHA-256 manifest

```text
5E9A0A679145949AA37B2A7D1C432E68F04A9F52568D1F173C8CE2B5F0BC16E4  src/browser/context-factory.ts
CE5A59071A1F509F69E85E11D2869EF337502AAC4B2D6200118C47DFA0AA8276  src/browser/page-settling.ts
3A217FB3C179933351B31970F134A4F7C9587E55C8C1BDB2A3E3A82243AA7808  src/browser/controlled-scroll.ts
B8AB932D3665FC036D2B20C7F902AFBB0ABA17417F66CB9B4808F3A5E203AD09  src/safety/passive-request-guard.ts
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
8BE9A65549A1EC73CB2EEA7A40F4F6E9A0C33E18A9E987DF3CBA826FC28B94D0  tests/component/context-factory.test.ts
103E25447615BD96DE37CEE3C30444BA2713213209ADE8F50B2DB6F36BB2151A  tests/integration/controlled-scroll.test.ts
7ED8E62115FC19805602EED64C59FFF73C22762C68CF84862B59733D17460914  tests/integration/passive-request-guard.test.ts
91B80876EDF24A46C494215E0CC59D23F1632750852AF7F7DAFDF1304B5E1768  fixtures/site/lazy-content.html
```

## Required verdict

For each of five findings: ADDRESSED/OPEN with exact lines. List new Critical/Important and conclude Task 6 PASS/NEEDS FIXES.
