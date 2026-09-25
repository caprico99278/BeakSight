### Manifest

- all hashes match

### Spec Compliance

- ❌ Issues found
- Installation can make the illegal transition `PASSIVE_INVALIDATING -> PASSIVE_ACTIVE`: activity observed during installation starts invalidation at `src/safety/passive-request-guard.ts:666`, but installation completion unconditionally assigns `PASSIVE_ACTIVE` at `src/safety/passive-request-guard.ts:932`.
- Successful safety invalidation never drains owned tasks or transitions to `CLOSED`; it remains `*_INVALIDATING` after `context.close()` at `src/safety/passive-request-guard.ts:138`.
- Frozen HTTP and CDP activity is recorded only after enforcement succeeds, contrary to record-first precedence. HTTP records after `route.abort()` at `src/safety/passive-request-guard.ts:241`; CDP records after `Fetch.failRequest` at `src/safety/passive-request-guard.ts:514`. An enforcement rejection therefore loses the observed interaction evidence.

### Strengths

- `GuardPhase` contains exactly the eight required values, and `GuardState.phase` replaces all former Context lifecycle/mode authorities. `ownerClosingPages` remains Page-scoped correlation only.
- Guard state registration is synchronous before the first installation `await`; repeated or concurrent installation sees `INSTALLING` and is rejected.
- All six event classes consult frozen phase before closing/invalidation, and passive classification is limited to `PASSIVE_ACTIVE`.
- Owner close follows closing -> close -> matching invalidation on failure -> drain -> rethrow or `CLOSED` ordering.
- Public exports are unchanged. The Task 2/5 structural fields are present without bounds, registry, or listener-teardown scope creep.
- Each added test has behavioral value. The successful enforcement stubs leave the record-before-enforcement failure path uncovered.

### Issues

#### Critical

- None.

#### Important

- Illegal reactivation after installation-time invalidation.
- Invalidation never drains or reaches legal `CLOSED` state after successful close.
- HTTP/CDP frozen evidence is lost when fail-closed enforcement itself rejects.

#### Minor

- None.

### Assessment

- `Specification gate: FAIL`
- `Critical: 0; Important: 3; Minor: 0`
