# Task 5 Fix Round 5 — final Git-free review package

Git operations are prohibited. Verify the manifest, then perform the final read-only scoped re-review.

## Entering finding

Important: successful lifecycle `Fetch.failRequest(BlockedByClient)` was not correlated to the later Playwright `requestfailed`, causing false `HTTP_MAIN_FRAME_DELIVERY_FAILED` and a second Context close.

Intended correction: register a bounded, exact, one-shot lifecycle expected-failure record before the CDP fail command. Direct pauses use current normalized method/exact URL; redirected pauses use `redirectedRequestId` predecessor facts; reason must be exact `net::ERR_BLOCKED_BY_CLIENT`. CDP fail rejection removes the record by identity. Exact match consumes once with no policy block; mismatch, expiry, and a second event remain genuine failures. Already-invalidated Context invalidation is non-recursive.

Review the complete pause -> failRequest -> requestfailed sequences for pending/rejected owner Context/Page close, safety invalidation, direct and redirect predecessor correlation, mismatch, expiry, one-shot second event, failRequest rejection record removal, policy/lifecycle separation, and Context close count/reuse. List new Critical/Important only.

This is fix round 5/5. Do not edit, use Git, or spawn subagents. Do not rerun broad verification absent a concrete suspected defect. Implementer reports sequence 10/10, Task 5 102/102, full suite 204/204, typecheck/build PASS.

## SHA-256 manifest

```text
27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7  src/safety/request-policy.ts
49CC0C11E8ACD9776B416BAD3B4679F75B3A4EC0EDB78C76A9C50458444132E3  src/safety/passive-request-guard.ts
1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6  src/safety/safety-ledger.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03  tests/unit/safety-ledger.test.ts
494F4C2D4F5709BAE10813E1D17897944B95F1ED5F024F5A750700B51E23DF3B  tests/unit/redact.test.ts
7ED8E62115FC19805602EED64C59FFF73C22762C68CF84862B59733D17460914  tests/integration/passive-request-guard.test.ts
0956BA9755F7238E4BEA2F4EDF93B1814BEA63584D3A308742E3777E1D8D36C7  tests/integration/fixture-server.test.ts
35F6A759A527D9E4175ED42909240014B3174AA6603976FEE797AAD0FC25AFA6  fixtures/server.ts
42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA  fixtures/site/external-script.js
3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52  fixtures/site/external-image.svg
```

## Required verdict

State `ADDRESSED` or `OPEN` for the entering finding with exact lines; list any new Critical/Important breakage; conclude Task 5 mandatory checkpoint PASS/FAIL. If FAIL, clearly state that the 5-round limit is exhausted.
