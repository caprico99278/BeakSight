# Task 5 Fix Round 4 — Git-free review package

Git operations are prohibited. Verify the SHA-256 manifest, then perform a read-only scoped re-review.

## Entering finding

Important: CDP `Fetch.requestPaused` ignored invalidated/owner-closing lifecycle state and could call `Fetch.continueRequest` after guarded Context close started or rejected.

Intended correction: lifecycle state is checked before policy handling and again immediately before native continuation. Invalidated, safety-invalidating, owner-Context-closing, or owner-Page-closing pauses must never continue. They use `Fetch.failRequest(BlockedByClient)` without recording a policy block. Failure of this lifecycle failRequest is invariant evidence and must not recursively retry an already-invalidated close.

Review pending/rejected guarded Context and Page close, safety invalidation in progress/complete, lifecycle failRequest rejection, exact policy redirect correlation, absence of policy-block false claims, and the no-await last-safe-point before continue. List new Critical/Important breakage only.

Do not edit, use Git, or spawn subagents. Broad verification should not be rerun absent a concrete suspected defect. Implementer reports focused 7/7, Task 5 99/99, full suite 201/201, typecheck/build PASS.

## SHA-256 manifest

```text
27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7  src/safety/request-policy.ts
55F743BD7CA62A74BD16EE52D97BA20F47E50A63B113D8FDD59E2328DFEA71DA  src/safety/passive-request-guard.ts
1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6  src/safety/safety-ledger.ts
07A7F626CDA1643BA44FAB6B44467E0F7B83035DB12367BAC9E0327F901E3610  src/safety/redact.ts
9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD  tests/unit/request-policy.test.ts
45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03  tests/unit/safety-ledger.test.ts
494F4C2D4F5709BAE10813E1D17897944B95F1ED5F024F5A750700B51E23DF3B  tests/unit/redact.test.ts
3DC525A8CAFE590EA011A13EA8C19B80E5C022880DB92F129FB936B227A6E705  tests/integration/passive-request-guard.test.ts
0956BA9755F7238E4BEA2F4EDF93B1814BEA63584D3A308742E3777E1D8D36C7  tests/integration/fixture-server.test.ts
35F6A759A527D9E4175ED42909240014B3174AA6603976FEE797AAD0FC25AFA6  fixtures/server.ts
42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA  fixtures/site/external-script.js
3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52  fixtures/site/external-image.svg
```

## Required verdict

State `ADDRESSED` or `OPEN` for the entering finding with exact line evidence; list new Critical/Important breakage; conclude Task 5 mandatory checkpoint PASS/FAIL.
