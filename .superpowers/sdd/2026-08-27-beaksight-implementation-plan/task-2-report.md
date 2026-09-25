# Task 2 report: Core contracts, stable IDs, run status, and schema validation

## Implementation summary

- Added readonly normalized core contracts, including branded `RunId`, `PageId`, `EvidenceId`, and `FindingId` aliases; run/page/interaction/severity unions; and readonly Evidence, Finding, Page, and Run summary contracts.
- Added `src/core/ids.ts` as the single production owner of formatted IDs and `createFindingFingerprint()`. Fingerprints include the target identity, rule/version, normalized URL, and sorted identity fields in a SHA-256 digest.
- Added `src/core/status.ts` as the single production owner of `deriveRunStatus()`. Its ordered result is `FAILED`, then `ABORTED_BY_SAFETY`, then `PARTIAL`, otherwise `COMPLETE`; Finding counts are accepted as an execution fact but never affect the result.
- Added the single `validateArtifact()` entry point. It loads source schemas through `readFile(new URL(..., import.meta.url))` and selects the copied `dist/schemas` location in the compiled build. Ordinary validation failures return `{ ok: false, errors }` rather than throw.
- Added four source-controlled JSON Schemas and updated `npm run build` to copy them to `dist/schemas`.

## Files changed

- `package.json` — copies schemas after TypeScript compilation.
- `src/core/contracts.ts` — immutable normalized contracts and ID brands.
- `src/core/ids.ts` — canonical stable IDs and Finding fingerprinting.
- `src/core/status.ts` — canonical final Run status derivation.
- `src/core/schema-validator.ts` — canonical Ajv validation entry point.
- `schemas/run.schema.json`, `schemas/audit.schema.json`, `schemas/page.schema.json`, `schemas/finding.schema.json` — versioned artifact schemas.
- `tests/unit/core-contracts.test.ts`, `tests/unit/status.test.ts`, `tests/unit/schema-validator.test.ts` — observable contract tests.

## TDD red evidence

Command:

```text
npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts
```

Output (exit code 1):

```text
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/unit/status.test.ts (0 test)
 ❯ tests/unit/core-contracts.test.ts (0 test)

 FAIL  tests/unit/core-contracts.test.ts
Error: Cannot find module '../../src/core/ids.js'

 FAIL  tests/unit/status.test.ts
Error: Cannot find module '../../src/core/status.js'

 Test Files  2 failed (2)
      Tests  no tests
```

Expected reason: the ID and status production modules had not been created.

Command:

```text
npx vitest run tests/unit/schema-validator.test.ts
```

Output (exit code 1):

```text
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/unit/schema-validator.test.ts (0 test)

 FAIL  tests/unit/schema-validator.test.ts
Error: Cannot find module '../../src/core/schema-validator.js'

 Test Files  1 failed (1)
      Tests  no tests
```

Expected reason: the canonical schema validator module had not been created.

## Green verification

```text
$ npm run typecheck
> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Exit code: 0.

```text
$ npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 Test Files  3 passed (3)
      Tests  9 passed (9)
```

Exit code: 0. Test count: 9 passed, 0 failed.

```text
$ npm run build
> beaksight@0.1.0 build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
```

Exit code: 0. The copied files are `audit.schema.json`, `finding.schema.json`, `page.schema.json`, and `run.schema.json` under `dist/schemas`.

Compiled-distribution check:

```text
$ node --input-type=module -e "import { validateArtifact } from './dist/core/schema-validator.js'; ..."
{"ok":true}
```

Exit code: 0; this confirms the built validator uses the copied distribution schemas.

## Self-review

- Read every Task 2 source, schema, test, and package file after implementation.
- Confirmed every field in normalized contracts is readonly, and Evidence payloads are recursively readonly/narrowable with a required bounded generic payload type rather than `unknown`.
- Confirmed `createHash` and `createFindingFingerprint` occur only in `src/core/ids.ts`; no alternate Finding fingerprint owner exists.
- Confirmed `deriveRunStatus` occurs only in `src/core/status.ts`; all four final status literals are only defined there and in the shared union.
- Confirmed `new Ajv`, schema `readFile`, and `validateArtifact` occur only in `src/core/schema-validator.ts`.
- Confirmed `src/**` has no target-specific identity, domain, or absolute URL occurrence.
- Confirmed status tests exercise preflight and safety precedence, artifact invalidity, execution incompleteness, and Finding-count independence. Schema tests exercise valid Finding validation, missing `evidenceRefs`, invalid status values, and the canonical public API.
- Resolved the observed TypeScript 7/Ajv CommonJS typing error by importing Ajv's verified named export. Fresh typecheck, focused tests, and build all passed afterward.

## Concerns

None. npm emitted an informational newer-major-version notice; it did not affect dependency versions or validation results.

## Commit status

Commits created: NOT APPLICABLE (Git prohibited)

## Fix Round 2

### Implementation summary

- `deriveRunStatus()` now validates every runtime-required fact before it can return `COMPLETE`: booleans must be booleans, `incompleteReasons` must be a string array, and each counter must be a non-negative safe integer.
- The final-status owner fails closed with `PARTIAL` for missing, negative, fractional, non-finite, or incorrectly typed facts. Explicit preflight failure and a valid positive safety-invariant count retain their higher-priority `FAILED` and `ABORTED_BY_SAFETY` outcomes.
- Added focused regression coverage for every independently omitted execution fact, every required counter with negative/fractional/infinite values, invalid fact types, and caller-owned fingerprint identity-array immutability.
- `createFindingFingerprint()` already clones before its explicit code-unit sort, so the new mutation test passed without a production change to `ids.ts`.

### Files changed

- `src/core/status.ts`
- `tests/unit/status.test.ts`
- `tests/unit/core-contracts.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-2-report.md`

### TDD red evidence

Command:

```text
npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
```

Output (exit code 1):

```text
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/unit/status.test.ts (45 tests | 23 failed)
     × fails closed when required execution fact preflightFailed is omitted at runtime
     × fails closed when required execution fact safetyInvariantViolations is omitted at runtime
     × fails closed when required execution fact incompleteReasons is omitted at runtime
     × fails closed when required execution fact unhandledFailures is omitted at runtime
     × fails closed when required execution fact crawlLimitReached is omitted at runtime
     × fails closed when required execution fact skippedRequiredWork is omitted at runtime
     × fails closed when required execution fact blockedRequiredWork is omitted at runtime
     × fails closed when required execution fact timedOutRequiredWork is omitted at runtime
     × fails closed when required execution fact notObservedRequiredWork is omitted at runtime
     × fails closed when required execution fact notVerifiedRequiredWork is omitted at runtime
     × fails closed when required execution fact failedRequiredWork is omitted at runtime
     × fails closed when required execution fact incompleteCollectorCount is omitted at runtime
     × fails closed when counter safetyInvariantViolations is invalid at runtime
     × fails closed when counter unhandledFailures is invalid at runtime
     × fails closed when counter skippedRequiredWork is invalid at runtime
     × fails closed when counter blockedRequiredWork is invalid at runtime
     × fails closed when counter timedOutRequiredWork is invalid at runtime
     × fails closed when counter notObservedRequiredWork is invalid at runtime
     × fails closed when counter notVerifiedRequiredWork is invalid at runtime
     × fails closed when counter failedRequiredWork is invalid at runtime
     × fails closed when counter incompleteCollectorCount is invalid at runtime
     × fails closed when required fact preflightFailed has an invalid runtime type
     × fails closed when required fact requiredArtifactsValid has an invalid runtime type

 Test Files  1 failed | 2 passed (3)
      Tests  23 failed | 39 passed (62)
```

Expected reason: before validation, omitted counters compared as false in `> 0` expressions and invalid counters/types could reach `COMPLETE`; omitted `incompleteReasons` threw on `.length`. The new fingerprint input-mutation test passed against the pre-existing clone-and-sort implementation and therefore required no `ids.ts` modification.

### Green verification

```text
$ npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 Test Files  3 passed (3)
      Tests  62 passed (62)
```

Exit code: 0. Test count: 62 passed, 0 failed.

```text
$ npm run typecheck
> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Exit code: 0.

```text
$ npm run build
> beaksight@0.1.0 build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
```

Exit code: 0.

### Self-review

- Read the final `src/core/status.ts` and both changed focused test files.
- Confirmed `deriveRunStatus()` remains the sole final-status owner and that its internal validators remain private helpers, not a second public status entry point.
- Confirmed preflight and valid positive safety facts are evaluated before structural validation, preserving the mandated higher-priority outcomes; invalid/missing facts otherwise return `PARTIAL` without throwing.
- Confirmed `createFindingFingerprint()` remains the sole fingerprint owner and clones identity fields before explicit code-unit sorting; the caller-owned array's content and order remain unchanged.
- No unrelated source, schema, package, or distribution artifacts were edited for this round.

### Concerns

None. npm emitted its informational newer-major-version notice only.

### Commit status

Commits created: NOT APPLICABLE (Git prohibited)

## Fix Round 1

### Implementation summary

- Replaced fallback Evidence-ID normalization with a closed `EvidenceType` set. Unknown aliases such as `net`, `a11y`, `perf`, and `shot` now fail rather than collide with canonical IDs.
- Replaced broad recursive Evidence payloads with a readonly, discriminated `EvidenceRecord` union for the planned network, console, DOM, layout, performance, accessibility, interaction, screenshot, and metadata domains.
- Made all required execution-completeness facts explicit in `RunStatusInput`; `executionComplete` is required and must be affirmatively `true`. Skipped, blocked, timed-out, unobserved, unverified, failed, and collector-incomplete required work now independently produces `PARTIAL`; Finding counts remain ignored.
- Added version fields to Finding, PageAuditResult, and RunSummary contracts, and aligned RunSummary's four page counts with the run schema.
- Registered all schemas in the one canonical Ajv validator and linked audit/page nested content through URN schema IDs. Audit, Page, nested Evidence, nested Finding, and nested Run artifacts now validate recursively.
- Replaced locale-sensitive fingerprint sorting with explicit code-unit ordering.

### Files changed

- `src/core/contracts.ts`
- `src/core/ids.ts`
- `src/core/status.ts`
- `src/core/schema-validator.ts`
- `schemas/run.schema.json`
- `schemas/audit.schema.json`
- `schemas/page.schema.json`
- `schemas/finding.schema.json`
- `tests/unit/core-contracts.test.ts`
- `tests/unit/status.test.ts`
- `tests/unit/schema-validator.test.ts`
- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-2-report.md`

### TDD red evidence

Command:

```text
npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
```

Output (exit code 1):

```text
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 ❯ tests/unit/core-contracts.test.ts (9 tests | 2 failed)
     × rejects evidence types outside the closed canonical set instead of aliasing prefixes
     × sorts identity fields with explicit code-unit order before hashing
 ❯ tests/unit/status.test.ts (17 tests | 8 failed)
     × fails closed when runtime input omits execution completeness facts
     × makes non-zero skippedRequiredWork prevent completion
     × makes non-zero blockedRequiredWork prevent completion
     × makes non-zero timedOutRequiredWork prevent completion
     × makes non-zero notObservedRequiredWork prevent completion
     × makes non-zero notVerifiedRequiredWork prevent completion
     × makes non-zero failedRequiredWork prevent completion
     × makes non-zero incompleteCollectorCount prevent completion
 ❯ tests/unit/schema-validator.test.ts (7 tests | 4 failed)
     × accepts aligned versioned Finding, Page, Run, and Audit artifacts
     × rejects malformed nested Evidence and Findings in Page and Audit artifacts
     × rejects an audit with a malformed nested Run summary
     × validates through the canonical distribution module after the schemas are copied

 Test Files  3 failed (3)
      Tests  14 failed | 19 passed (33)
```

Expected reasons: fallback Evidence prefixes allowed aliases to collide; locale collation did not match explicit code-unit order; the status owner failed open for omitted execution facts and ignored required-work counters; run/schema contracts were misaligned; and schemas accepted unvalidated nested artifacts. The distribution-test harness's initial local-npm path was corrected before green verification; it was unrelated to the production validator behavior.

### Green verification

```text
$ npm run typecheck
> beaksight@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Exit code: 0.

```text
$ npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
 RUN  v4.1.10 C:/Develop/github-repo/BeakSight

 Test Files  3 passed (3)
      Tests  33 passed (33)
```

Exit code: 0. Test count: 33 passed, 0 failed.

```text
$ npm run build
> beaksight@0.1.0 build
> tsc -p tsconfig.build.json && node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });"
```

Exit code: 0. The focused distribution test also compiles TypeScript, copies the schemas, dynamically imports `dist/core/schema-validator.js`, and validates a complete Audit artifact successfully.

### Self-review

- Read every Task 2 source, schema, and focused test after the fix.
- `createHash` and `createFindingFingerprint` occur only in `src/core/ids.ts`; `localeCompare` no longer occurs in source.
- `deriveRunStatus` occurs only in `src/core/status.ts`, requires affirmative completeness, and does not inspect `findingCount`.
- `new Ajv` and `validateArtifact` occur only in `src/core/schema-validator.ts`; it loads and registers every source/distribution schema before returning the selected canonical validator.
- Evidence records are a readonly discriminated union; the type selects the payload and no `unknown`/mutable-object default remains in normalized Evidence contracts.
- Audit schema references Run, Page, and Finding schemas; Page references Finding and validates a closed Evidence payload union.
- Source scan found no target-specific identity, domain, or HTTP(S) URL literal under `src/**`.
- Fresh verification: typecheck exit 0; focused tests 33 passed/0 failed; build exit 0.

### Concerns

None. npm emitted its informational newer-major-version notice only.

### Commit status

Commits created: NOT APPLICABLE (Git prohibited)
