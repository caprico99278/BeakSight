### Manifest

- all hashes match

### Finding Verdicts

- Finding 1 — ADDRESSED — installation transitions to `PASSIVE_ACTIVE` only while still `INSTALLING`.
- Finding 2 — NOT ADDRESSED — the implementation launches an unowned `void` async drain, so invalidation returns successfully before owned tasks drain and before `CLOSED` is reached.
- Finding 3 — ADDRESSED — frozen HTTP and CDP evidence is recorded before abort/`Fetch.failRequest`.

### New Breakage in the Fix

#### Critical

- None.

#### Important

- Invalidation completion is detached; callers cannot await the eventual drain/terminal transition.

#### Minor

- None.

### Out-of-Scope Observations

- None.

### Verdict

- `Fix round: FAIL`
- `Open Critical: 0; Open Important: 1; New Minor: 0`
