# Task 5 review package (Git-free)

Git operations are prohibited. `fixtures/server.ts` is modified from Task 4; all other files are new.

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `src/safety/request-policy.ts` | new | `27E9FCC9CCEC0E933F9F03ADD3C8A8F17751D745C3E858AF9F2D444C2C4BCFE7` |
| `src/safety/passive-request-guard.ts` | new | `27D014FAEEA77820FB91792DDE9A4BE5C6E167CD604D489B4B52A117B3E04B48` |
| `src/safety/safety-ledger.ts` | new | `1E1FB7E161D84B68E7C2034B3B5656E1CDF7C16505E27C35F0ED9AAAC68FBFC6` |
| `src/safety/redact.ts` | new | `F859EBEFADA2D6B90CA3EC7369E0CD5A50462B06E1F7B05EE75308C25FD80BB1` |
| `tests/unit/request-policy.test.ts` | new | `9557484EEA947F408CAA727834B6603A7BDBB864C7EDE45703EF92B7D4E433CD` |
| `tests/unit/safety-ledger.test.ts` | new | `45E0B0F98B0DA5217A42E42A43EB3C55A2A450B169BCF9B6DA86896E10110C03` |
| `tests/unit/redact.test.ts` | new | `AB548AAB490DA3BFAA6454CCFB313B10815626E9419818F7A823564E074AC50F` |
| `tests/integration/passive-request-guard.test.ts` | new | `399EB98F29663D3558C3F75DE8263BE7009DCA817233229C38B1DEECE8D24B5C` |
| `fixtures/server.ts` | `D136138572F5C8DF3182158C41EAC594181B6ABB4C3FD7046C1DF7E5A25F56C4` | `39F725CFB18D11EF0DA20C268B67950FA0134347EA85C16E211787FD5889367B` |
| `fixtures/site/external-script.js` | new | `42C019242D0596368E249ADED1EF4CFA8E349D0ED0CEBD2CE32F08695A26C5BA` |
| `fixtures/site/external-image.svg` | new | `3039219D6A6010E54C81C59F4B217752D347614C726166FB34AB843CA37CAC52` |

The report records focused unit 32/32, real Chromium integration 6/6, full suite 149/149, typecheck PASS, build PASS, server mutation counters POST/PUT/PATCH/DELETE all zero, WebSocket upgrade zero, and invariant violations zero.
