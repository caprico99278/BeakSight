### Task 2: Define core contracts, stable IDs, run status, and JSON Schema validation

**Files:**
- Create: `src/core/contracts.ts`
- Create: `src/core/ids.ts`
- Create: `src/core/status.ts`
- Create: `src/core/schema-validator.ts`
- Modify: `package.json`
- Create: `schemas/run.schema.json`
- Create: `schemas/audit.schema.json`
- Create: `schemas/page.schema.json`
- Create: `schemas/finding.schema.json`
- Test: `tests/unit/core-contracts.test.ts`
- Test: `tests/unit/status.test.ts`
- Test: `tests/unit/schema-validator.test.ts`

**Interfaces:**
- Produces branded string aliases `RunId`, `PageId`, `EvidenceId`, `FindingId`.
- Produces `RunStatus`, `PageAuditStatus`, `InteractionStatus`, `Severity`, `EvidenceRecord`, `Finding`, `PageAuditResult`, `RunSummary`.
- Produces `deriveRunStatus(input: RunStatusInput): RunStatus`.
- Produces `validateArtifact(schemaName, value): ArtifactValidationResult`.

- [ ] **Step 1: Write failing ID and status tests**

```ts
import { describe, expect, it } from 'vitest';
import { createEvidenceId, createFindingId } from '../../src/core/ids.js';
import { deriveRunStatus } from '../../src/core/status.js';

describe('stable identifiers', () => {
  it('uses explicit evidence and finding prefixes', () => {
    expect(createEvidenceId('network', 12)).toBe('EV-NET-000012');
    expect(createFindingId(42)).toBe('FIND-000042');
  });
});

describe('run status', () => {
  it('never reports COMPLETE when a required artifact is invalid', () => {
    expect(deriveRunStatus({
      preflightFailed: false,
      safetyInvariantViolations: 0,
      incompleteReasons: [],
      unhandledFailures: 0,
      crawlLimitReached: false,
      requiredArtifactsValid: false,
    })).toBe('PARTIAL');
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts
```

Expected: FAIL because the core modules do not exist.

- [ ] **Step 3: Implement immutable contracts and status aggregation**

Use string unions, not numeric enums:

```ts
export type RunStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'ABORTED_BY_SAFETY';
export type PageAuditStatus = 'AUDITED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
export type Severity = 'ERROR' | 'WARN' | 'INFO' | 'SAFETY';
export type InteractionStatus =
  | 'VERIFIED'
  | 'REJECTED_UNSAFE'
  | 'BLOCKED_BY_SAFETY'
  | 'NOT_VERIFIABLE'
  | 'EXECUTION_FAILED';

export interface EvidenceRecord<T = unknown> {
  readonly evidenceId: string;
  readonly type: string;
  readonly pageId: string;
  readonly viewport: string;
  readonly observedAt: string;
  readonly payload: T;
}

export interface Finding {
  readonly findingId: string;
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly category: string;
  readonly severity: Severity;
  readonly pageId: string | null;
  readonly pageUrl: string | null;
  readonly viewport: string | null;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}
```

`deriveRunStatus` rules are ordered: preflight failure => `FAILED`; safety invariant violation => `ABORTED_BY_SAFETY`; any incompleteness, unhandled failure, crawl limit, or invalid required artifact => `PARTIAL`; otherwise `COMPLETE`.

- [ ] **Step 4: Add failing schema tests**

Test that a valid Finding passes and one missing `evidenceRefs` fails. Test that run status accepts only the four approved strings.

- [ ] **Step 5: Implement Ajv validation against source-controlled schemas**

`src/core/schema-validator.ts` loads schemas via `readFile(new URL(..., import.meta.url))` from the repository path in source and via the copied `schemas/` directory in distribution. The public API returns `{ok: true}` or `{ok: false, errors: string[]}`; it never throws on ordinary validation failure.

- [ ] **Step 6: Copy source-controlled schemas into the distribution build**

After the schema files exist, change the `build` script to:

```json
"build": "tsc -p tsconfig.build.json && node --input-type=module -e \"import { cpSync } from 'node:fs'; cpSync('schemas', 'dist/schemas', { recursive: true });\""
```

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck
npx vitest run tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
npm run build
```

Commit:

```bash
git add package.json src/core schemas tests/unit/core-contracts.test.ts tests/unit/status.test.ts tests/unit/schema-validator.test.ts
git commit -m "feat: define audit contracts and schemas"
```

---

## Authoritative addendum from the approved execution instructions

- IDs and Finding fingerprint semantics have one production owner: `src/core/ids.ts`.
- In addition to the older interfaces above, Task 2 must expose `createFindingFingerprint(...)` as the canonical deterministic fingerprint API. Later rule code must delegate to it and must not hash/fingerprint locally.
- Final Run status has one production owner: `src/core/status.ts`; only `deriveRunStatus()` decides `COMPLETE | PARTIAL | FAILED | ABORTED_BY_SAFETY`.
- Finding counts never determine Run status. Skipped, blocked, timed out, not observed, not verified, failed, budget reached, schema invalid, and collector incomplete facts must prevent fake completion where applicable.
- JSON Schema validation has one production owner: `src/core/schema-validator.ts`; canonical API is `validateArtifact(schemaName, value)`.
- Later modules must not implement alternate validators or load schemas independently. Keep the Task 2 API extensible enough for final artifact validation without a second entry point.
- All normalized contracts are readonly. Avoid unbounded generic-object escape hatches in consumer-facing contracts: Evidence payloads should be explicitly typed/narrowable rather than allowing arbitrary mutable objects to flow unchecked.
- `src/**` remains completely target-agnostic.
- Add tests for deterministic Finding fingerprints, status independence from Finding counts/execution completeness, invalid schema behavior, and the canonical validator API.
- Git operations and commits are prohibited in this environment. Report `Commits created: NOT APPLICABLE (Git prohibited)`.

---

