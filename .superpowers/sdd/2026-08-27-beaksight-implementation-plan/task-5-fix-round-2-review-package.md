# Task 5 Fix Round 2 — Git-free review package

Git operations are prohibited. Verify the exact SHA-256 manifest, then perform a read-only scoped re-review.

## Open findings entering this round

1. Important: owner-initiated `page.close()` during a pending allowed main-frame request falsely produced `HTTP_MAIN_FRAME_DELIVERY_FAILED: net::ERR_ABORTED`.
2. Important/original finding 8: focused coverage was missing for CDP setup failure, unexpected CDP detach, both CDP page-lookup failure branches, and pending expected page/context closure.

The intended fix distinguishes owner cleanup from unexpected abort without globally ignoring `net::ERR_ABORTED`: for allowed top-level `ERR_ABORTED`, it races the actual page-close signal against a bounded 100 ms deadline. Closure inside the bound is expected teardown; an active page at expiry remains an invariant and invalidates the context. Non-`ERR_ABORTED` failures remain immediate invariants.

Review for both findings being addressed and for new Critical/Important breakage, especially timer races, listener leaks, swallowed/unhandled rejections, false suppression of genuine aborts, context reuse after owner page close, and false CDP detach during normal cleanup. Confirm tests exercise each setup stage (`newCDPSession`, `Page.getFrameTree`, `Fetch.enable`), unexpected detach, both lookup branches, owner page/context close while pending, active-page abort, and connection refusal.

Do not edit files, do not use Git, and do not spawn subagents. Do not rerun broad verification unless a specific suspected defect requires it. The implementer reports Task 5 84/84 PASS, typecheck/build PASS, full suite 186/186 PASS.

## SHA-256 manifest

```text
27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7  src/safety/request-policy.ts
CD2FD99C233AA735A7246D44F23AE49E60CEB94DED035490CC4637E69CEE189D  src/safety/passive-request-guard.ts
1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6  src/safety/safety-ledger.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03  tests/unit/safety-ledger.test.ts
494F4C2D4F5709BAE10813E1D17897944B95F1ED5F024F5A750700B51E23DF3B  tests/unit/redact.test.ts
91289D1D78761447CEB573013E2846BD955D8E6720CAE1B1E69B16CF6DC101DA  tests/integration/passive-request-guard.test.ts
0956BA9755F7238E4BEA2F4EDF93B1814BEA63584D3A308742E3777E1D8D36C7  tests/integration/fixture-server.test.ts
35F6A759A527D9E4175ED42909240014B3174AA6603976FEE797AAD0FC25AFA6  fixtures/server.ts
42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA  fixtures/site/external-script.js
3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52  fixtures/site/external-image.svg
```

## Required verdict

For each of the two open findings, state `ADDRESSED` or `OPEN` with exact file/line evidence. List any new Critical/Important breakage. Conclude whether Task 5's mandatory network-authority/mutation-prevention and ledger-truthfulness checkpoint now passes.
