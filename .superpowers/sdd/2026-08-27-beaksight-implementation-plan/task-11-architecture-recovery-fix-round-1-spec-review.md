# Task 11 Recovery Fix Round 1 Specification Re-review

`NEEDS FIXES` — 0 Critical, 1 Important, 4 Minor. Package `EF2BD29AAA782A81A2E7E0006358E6F1EA181C30C327E85127C3A526C83B8FE4`; substituted manifest 48/48.

Important: overflow invalidation stores `invalidateContext(...).finally(...)` without rejection containment. Newly possible drain-timeout rejection becomes unhandled when 256 admitted tasks never settle. Existing overflow test resolves all gates and masks the combination.

Original drain/join/listener/error findings otherwise addressed; full 422/422 and typecheck pass.
