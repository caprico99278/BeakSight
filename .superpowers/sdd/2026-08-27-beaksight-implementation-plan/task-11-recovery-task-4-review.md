# Task 11 Recovery Task 4 Independent Review

## Fixed package

- Review package SHA-256: `5A24042A94246643B461B1D949194476964EB7ABFA636C08F3622BED2A8D0CA2`
- All authority, BASE/HEAD, config, and package hashes matched.

## Verdict

`FAIL` — Critical: 0; Important: 3; Minor: 1.

## Findings

1. **Important — close rejection value aliases the no-error sentinel.** `Promise.reject(undefined)` is caught into an `undefined` variable and later treated as successful close. Use a boolean or discriminated result independent of the rejected value, and add the any-value regression.
2. **Important — error normalization is not total.** `instanceof`, `.message`, and `String(error)` can each throw for valid hostile JavaScript values, allowing work/dispose/close failures to bypass cleanup or overwrite an established result. Make normalization total and bounded with a fixed non-coercing fallback; test hostile work, dispose, and close rejection values.
3. **Important — final precedence contradicts the approved design.** Design section 8.1 requires final freeze evidence before owner-close failure, but the implementation checks close first. Restore freeze-first and test close that records freeze then rejects.
4. **Minor — exactly-once claims lack direct failure-path assertions.** Add counters/spies and exact matching-invariant counts to representative deadline, click/freeze/observation disposal failures and close-rejection paths.

## Verified areas

Structural single Handle ownership, ordinary Error cleanup preservation, session-factory rejection, ordinary work+close result encoding, immutable evidence/snapshot behavior, fixed discovery configuration, focused 3/3, unscoped and explicit full 405/405, and typecheck are compliant.

No Git, dependency, live-target, delegated, or file-modifying review operation occurred.
