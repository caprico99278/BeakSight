# Task 5 Fix Round 3 — Git-free review package

Git operations are prohibited. Verify all SHA-256 values, then perform a read-only scoped re-review.

## Open findings entering this round

1. Important: any Page close could be mistaken for owner teardown, suppressing genuine unexpected-close delivery and CDP-detach invariants.
2. Important: Page-wide CDP failure counts could be consumed by an unrelated allowed main-frame failure.

Intended correction:

- exported guarded page/context close wrappers pre-mark owner intent; only those markers or active safety invalidation may suppress expected abort/detach;
- unmarked close is a contract violation and remains an invariant;
- close rejection clears intent, records its own invariant, and invalidates;
- Page-wide CDP counts are gone;
- multi-hop Chromium correlation is one-shot/bounded and matches the CDP `redirectedRequestId` predecessor's normalized method, exact URL, and exact `net::ERR_BLOCKED_BY_CLIENT`; unrelated failures must not consume it.

Review exact code for marker lifetime, timer/listener cleanup, re-entrant close, unguarded/invalidated wrapper calls, close rejection, normal guarded page close with context reuse, guarded context close, unmarked idle/pending close, unexpected detach, stale correlation records, concurrent/mismatched request failure, and multi-hop block truthfulness. List any new Critical/Important breakage.

Do not edit files, use Git, or spawn subagents. Do not rerun broad verification unless a concrete suspected defect requires it. Implementer reports focused 13/13, Task 5 92/92, full suite 194/194, typecheck/build PASS.

## SHA-256 manifest

```text
27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7  src/safety/request-policy.ts
9A588BC9785B024C202E82AD6E40D4399B7786B90F43426F0AC014E829F579E7  src/safety/passive-request-guard.ts
1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6  src/safety/safety-ledger.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03  tests/unit/safety-ledger.test.ts
494F4C2D4F5709BAE10813E1D17897944B95F1ED5F024F5A750700B51E23DF3B  tests/unit/redact.test.ts
8E9465C09B19737EEAF49FB3FC5F8538A872FCEC93D437FC13ACF0DFC2ADA3C4  tests/integration/passive-request-guard.test.ts
0956BA9755F7238E4BEA2F4EDF93B1814BEA63584D3A308742E3777E1D8D36C7  tests/integration/fixture-server.test.ts
35F6A759A527D9E4175ED42909240014B3174AA6603976FEE797AAD0FC25AFA6  fixtures/server.ts
42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA  fixtures/site/external-script.js
3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52  fixtures/site/external-image.svg
```

## Required verdict

For each entering finding: `ADDRESSED` or `OPEN`, with exact file/line evidence. Then list any new Critical/Important breakage and conclude Task 5 mandatory checkpoint PASS/FAIL.
