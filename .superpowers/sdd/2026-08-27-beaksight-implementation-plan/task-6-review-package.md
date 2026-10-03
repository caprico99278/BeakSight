# Task 6 — Git-free independent review package

Git operations are prohibited. Verify the exact SHA-256 manifest before reviewing.

## Scope and required checks

Review Task 6 against the binding plan/design, Task 5 contracts, progress-ledger rulings, and `task-6-report.md`.

Critical boundaries:

- factory receives Browser, immutable AuditConfig, and required ledger factory by dependency injection; no global/default config import;
- `serviceWorkers: 'block'`, locale, timezone, viewport, canonical allowed origins, and one isolated ledger per Context;
- guard installs before Context exposure/Page creation;
- factory-created Page is not returned before `awaitPassiveRequestGuardReady()`;
- owner Page/Context teardown delegates to Task 5 guarded wrappers; foreign/inactive ownership is rejected; failure cleanup cannot bypass or double-close Task 5 state;
- Context-to-ledger lookup remains available for final safety accounting without becoming a second ledger authority;
- request-policy change only exports/reuses its canonical origin owner and does not weaken Task 5 behavior;
- settling explicitly observes DOM readiness and height stability, never relies on networkidle alone, honors the absolute deadline, and returns immutable honest PARTIAL on timeout/evaluation/closed-page uncertainty;
- controlled scroll starts at top, uses bounded viewport-relative steps, repeatedly remeasures scroll geometry, follows multiple height growths, requires bottom plus stable-height window, respects the absolute deadline, cannot spin/hang, and returns immutable truthful observations/final state;
- real Chromium tests use guarded lifecycle and prove lazy growth/final bottom plus deadline PARTIAL.

Review for aliasing, deadline races, unhandled promises/timers, invalid numeric inputs, zero-height/no-scroll pages, disappearing/growing documents, ownership leaks, and fake COMPLETE/PARTIAL states. List Critical/Important/Minor separately. Do not edit, use Git, or spawn subagents. Do not rerun broad verification absent a concrete defect; implementer reports focused 10/10, full suite 214/214, typecheck/build PASS.

## SHA-256 manifest

```text
5747226E04681F1857B1B8BE163206DDC452C815BBF0654ADBCEDB8F59736E8E  src/browser/context-factory.ts
6C6AA0CDB0A38340D8DD0CB39C4DE237DFC7A0940852AB145691637894883F07  src/browser/page-settling.ts
4C3540664896AE952C99AD1FF98280C697844E7A81F05637F97F48368AE399F7  src/browser/controlled-scroll.ts
9E6EB5F403E45B52FD1585C0924357AE857A5843CF524DF7BC13A61A894B0788  src/safety/request-policy.ts
23797AE5CF3EAD89834EAA4175DFDD6020C8B91EDDB85C6D367DA3BDE21B89B3  tests/component/context-factory.test.ts
FF041987114FFA9487CBBC9E7ADFCB96FBD02537D63ED0B12485E281CE49F1C6  tests/integration/controlled-scroll.test.ts
91B80876EDF24A46C494215E0CC59D23F1632750852AF7F7DAFDF1304B5E1768  fixtures/site/lazy-content.html
```

## Required response

Return spec compliance, strengths, Critical/Important/Minor findings with exact file/line evidence, and overall Task 6 PASS/NEEDS FIXES. State manifest result and commands run.
