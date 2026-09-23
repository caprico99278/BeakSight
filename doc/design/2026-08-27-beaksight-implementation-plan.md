# BeakSight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build BeakSight, a read-only, evidence-first Playwright web-audit CLI that recursively audits public websites, blocks non-read side effects, produces deterministic findings, and exports JSON/HTML/ChatGPT handoff artifacts.

**Architecture:** BeakSight is a Node.js/TypeScript CLI built on Playwright Library. The implementation separates crawl policy, browser contexts, safety enforcement, evidence collection, deterministic rule evaluation, orchestration, and reporting so no single module can silently broaden authority or mark incomplete work complete. Passive auditing and isolated interaction auditing use separate BrowserContexts; Evidence is collected before Findings are derived.

**Tech Stack:** Node.js 24.x LTS, TypeScript 7.0.2, Playwright 1.62.1, `@axe-core/playwright` 4.13.0, `web-vitals` 6.1.0, Ajv 8.20.0, fflate 0.8.3, Vitest 4.1.10, npm 11.x.

**Spec:** `docs/superpowers/specs/2026-08-27-beaksight-web-audit-design.md`

## Global Constraints

- Product name: `BeakSight`; CLI executable: `beaksight`.
- Initial operational target: `https://www.example.com/`, but no site-specific DOM selector, page list, menu definition, or expected-title list may enter production code.
- Runtime: Node.js 24.x LTS; ESM; TypeScript `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Playwright Library is the browser-control layer; do not structure production execution as Playwright Test cases.
- Browser default: Playwright Chromium; locale `ja-JP`; timezone `Asia/Tokyo`; primary Desktop `1440x900`; primary Mobile `390x844`; crawl concurrency `1`.
- Passive network authority is `GET`/`HEAD` only. `POST`, `PUT`, `PATCH`, `DELETE`, and every other non-read method must be aborted before server delivery and recorded in the Safety Ledger.
- `tel:`, `mailto:`, `sms:`, `intent:`, `javascript:`, external-app launch, download, external-origin navigation, form submission, and mutating user actions are never executed.
- Interaction auditing uses a disposable isolated context. Once interaction mode begins, new navigation, popup, download, WebSocket, and network activity are fail-closed.
- Service workers must be blocked where required for interception guarantees.
- Evidence and Finding are separate contracts. No semantic or aesthetic conclusion may be emitted as a deterministic Finding.
- Baseline/visual-regression comparison, LLM API calls, GUI, DB, authentication, scheduler, CI integration, and distributed crawling are out of scope.
- Run status is `COMPLETE | PARTIAL | FAILED | ABORTED_BY_SAFETY`; site Findings do not determine process success.
- No hidden skip. Any skipped, blocked, timed-out, not-observed, or not-verifiable item must carry a reason.
- All major JSON artifacts must include a schema version and pass JSON Schema validation before `COMPLETE` is possible.
- Persist no raw response bodies by default. Redact `Authorization`, `Cookie`, `Set-Cookie`, token-like, and session-like header values.
- Source text files use UTF-8 and LF. `.gitattributes` and `.editorconfig` enforce LF.
- TDD is mandatory: each implementation task begins with a failing test, then minimal implementation, then verification.
- Safety Gates S01-S10 and Auditor Gates A01-A10 must pass before the initial target-site smoke test.
- Target-site smoke begins with `maxPages=5`, `headed=true`, concurrency `1`; full crawl is not allowed before smoke passes.

---

## Planned File Structure

```text
beaksight/
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ .editorconfig
├─ .gitattributes
├─ README.md
├─ config/
│  └─ example.json
├─ schemas/
│  ├─ run.schema.json
│  ├─ audit.schema.json
│  ├─ page.schema.json
│  └─ finding.schema.json
├─ src/
│  ├─ cli/
│  │  └─ index.ts
│  ├─ config/
│  │  ├─ defaults.ts
│  │  ├─ types.ts
│  │  ├─ validate-config.ts
│  │  └─ load-config.ts
│  ├─ core/
│  │  ├─ ids.ts
│  │  ├─ status.ts
│  │  ├─ contracts.ts
│  │  └─ schema-validator.ts
│  ├─ crawl/
│  │  ├─ normalize-url.ts
│  │  ├─ admission-policy.ts
│  │  ├─ crawl-queue.ts
│  │  ├─ discover-links.ts
│  │  └─ site-metadata.ts
│  ├─ safety/
│  │  ├─ request-policy.ts
│  │  ├─ safety-ledger.ts
│  │  ├─ redact.ts
│  │  └─ interaction-policy.ts
│  ├─ browser/
│  │  ├─ context-factory.ts
│  │  ├─ page-settling.ts
│  │  └─ controlled-scroll.ts
│  ├─ evidence/
│  │  ├─ network-collector.ts
│  │  ├─ console-collector.ts
│  │  ├─ dom-collector.ts
│  │  ├─ layout-collector.ts
│  │  ├─ accessibility-collector.ts
│  │  ├─ color-collector.ts
│  │  ├─ performance-collector.ts
│  │  ├─ interaction-collector.ts
│  │  └─ screenshot-collector.ts
│  ├─ audit/
│  │  ├─ rule.ts
│  │  ├─ rule-engine.ts
│  │  ├─ technical-rules.ts
│  │  ├─ layout-rules.ts
│  │  ├─ accessibility-rules.ts
│  │  ├─ performance-rules.ts
│  │  └─ cross-page-rules.ts
│  ├─ interaction/
│  │  ├─ discover-candidates.ts
│  │  └─ isolated-auditor.ts
│  ├─ orchestration/
│  │  ├─ page-auditor.ts
│  │  └─ run-coordinator.ts
│  └─ report/
│     ├─ artifact-writer.ts
│     ├─ html-report.ts
│     └─ chatgpt-bundle.ts
├─ fixtures/
│  ├─ server.ts
│  └─ site/
│     ├─ index.html
│     ├─ js-error.html
│     ├─ overflow.html
│     ├─ clipped-text.html
│     ├─ bad-contrast.html
│     ├─ accordion.html
│     ├─ popup-button.html
│     ├─ download-button.html
│     ├─ external-link.html
│     ├─ mailto-link.html
│     ├─ tel-link.html
│     ├─ post-form.html
│     ├─ put-request.html
│     ├─ websocket.html
│     └─ service-worker.html
└─ tests/
   ├─ unit/
   ├─ component/
   └─ integration/
```

The file tree is intentionally split by responsibility. Do not collapse collectors, rules, crawl control, and safety into one crawler file.

---

### Task 1: Bootstrap the strict TypeScript CLI and configuration contract

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.editorconfig`
- Create: `.gitattributes`
- Create: `src/config/types.ts`
- Create: `src/config/defaults.ts`
- Create: `src/config/validate-config.ts`
- Create: `src/config/load-config.ts`
- Create: `src/cli/index.ts`
- Create: `config/targets/example.json`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `AuditConfig`, `DEFAULT_CONFIG`, `validateConfig(input: unknown): ConfigValidationResult`, `loadConfig(path?: string): Promise<AuditConfig>`.
- Produces CLI commands: `beaksight validate-config` and a stub `beaksight run` that exits with an explicit “not implemented by coordinator yet” code path only inside this task; Task 17 replaces the stub.

- [ ] **Step 1: Initialize the package with exact dependency versions**

Run:

```bash
npm init -y
npm install --save-exact playwright@1.62.1 @axe-core/playwright@4.13.0 web-vitals@6.1.0 ajv@8.20.0 fflate@0.8.3
npm install --save-dev --save-exact typescript@7.0.2 vitest@4.1.10 @types/node@24.13.3
```

Then set `package.json` to:

```json
{
  "name": "beaksight",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "bin": { "beaksight": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit tests/component",
    "test:integration": "vitest run tests/integration",
    "verify": "npm run typecheck && npm run test && npm run build"
  },
  "dependencies": {
    "@axe-core/playwright": "4.13.0",
    "ajv": "8.20.0",
    "fflate": "0.8.3",
    "playwright": "1.62.1",
    "web-vitals": "6.1.0"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Add strict compiler and LF settings**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "fixtures/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests", "fixtures"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
```

`.editorconfig`:

```text
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

`.gitattributes`:

```text
* text=auto eol=lf
```

- [ ] **Step 3: Write the failing configuration tests**

`tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { validateConfig } from '../../src/config/validate-config.js';

describe('configuration', () => {
  it('uses the approved browser and viewport defaults', () => {
    expect(DEFAULT_CONFIG.browser.locale).toBe('ja-JP');
    expect(DEFAULT_CONFIG.browser.timezone).toBe('Asia/Tokyo');
    expect(DEFAULT_CONFIG.viewports.primaryDesktop).toEqual({ width: 1440, height: 900 });
    expect(DEFAULT_CONFIG.viewports.primaryMobile).toEqual({ width: 390, height: 844 });
  });

  it('rejects an empty allowedOrigins list', () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      site: { startUrl: 'https://example.test/', allowedOrigins: [] },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests and verify failure**

Run:

```bash
npx vitest run tests/unit/config.test.ts
```

Expected: FAIL because configuration modules do not exist.

- [ ] **Step 5: Implement typed configuration and validation**

`src/config/types.ts` defines exact contracts:

```ts
export interface Viewport { readonly width: number; readonly height: number }

export interface AuditConfig {
  readonly site: {
    readonly startUrl: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly crawl: {
    readonly maxPages: number;
    readonly maxDepth: number;
    readonly maxRuntimeMs: number;
    readonly navigationTimeoutMs: number;
    readonly overallPageTimeoutMs: number;
    readonly resourceSettlingTimeoutMs: number;
    readonly interactionTimeoutMs: number;
    readonly allowedQueryParameters: readonly string[];
  };
  readonly browser: {
    readonly headed: boolean;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly viewports: {
    readonly primaryDesktop: Viewport;
    readonly primaryMobile: Viewport;
    readonly stressWidths: readonly number[];
  };
  readonly audit: {
    readonly performance: boolean;
    readonly accessibility: boolean;
    readonly interactions: boolean;
    readonly screenshots: boolean;
  };
  readonly output: { readonly directory: string };
}

export type ConfigValidationResult =
  | { readonly ok: true; readonly value: AuditConfig }
  | { readonly ok: false; readonly errors: readonly string[] };
```

Use defaults of `500` pages, depth `20`, run limit `3_600_000 ms`, navigation timeout `30_000 ms`, resource settling timeout `5_000 ms`, interaction timeout `3_000 ms`, overall page timeout `60_000 ms`, and stress widths `[320, 390, 768, 1024, 1440]`. `validateConfig` must parse URLs with `new URL`, require HTTP(S), require `startUrl` origin in `allowedOrigins`, require positive finite budgets, and reject unknown non-array shapes rather than coercing them.

- [ ] **Step 6: Implement config loading and CLI parsing with Node `parseArgs`**

`src/cli/index.ts` begins with:

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load-config.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    headed: { type: 'boolean' },
    headless: { type: 'boolean' },
    output: { type: 'string' },
  },
});

const command = positionals[0];
if (command === 'validate-config') {
  await loadConfig(values.config);
  process.stdout.write('configuration valid\n');
  process.exitCode = 0;
} else if (command === 'run') {
  process.stderr.write('run coordinator is not wired yet\n');
  process.exitCode = 1;
} else {
  process.stderr.write('usage: beaksight <run|validate-config> [options]\n');
  process.exitCode = 4;
}
```

- [ ] **Step 7: Add the initial operational config**

`config/targets/example.json` sets only policy, never selectors:

```json
{
  "site": {
    "startUrl": "https://www.example.com/",
    "allowedOrigins": ["https://www.example.com"]
  }
}
```

`loadConfig` deep-merges this partial file onto defaults and validates the merged result.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npm run typecheck
npx vitest run tests/unit/config.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .editorconfig .gitattributes src/config src/cli config tests/unit/config.test.ts
git commit -m "feat: bootstrap BeakSight CLI and config"
```

---

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

### Task 3: Implement URL normalization, admission policy, deterministic queue, and link discovery

**Files:**
- Create: `src/crawl/normalize-url.ts`
- Create: `src/crawl/admission-policy.ts`
- Create: `src/crawl/crawl-queue.ts`
- Create: `src/crawl/discover-links.ts`
- Test: `tests/unit/normalize-url.test.ts`
- Test: `tests/unit/admission-policy.test.ts`
- Test: `tests/unit/crawl-queue.test.ts`
- Test: `tests/component/discover-links.test.ts`

**Interfaces:**
- `normalizeUrl(rawUrl: string, baseUrl: string, allowedQueryParameters: ReadonlySet<string>): NormalizedUrlResult`.
- `classifyUrl(url: URL, policy: AdmissionPolicy): UrlAdmission`.
- `CrawlQueue.enqueue(candidate: CrawlCandidate): boolean`, `dequeue(): CrawlCandidate | undefined`.
- `discoverLinks(page: Page, sourcePageId: PageId): Promise<readonly LinkEvidence[]>`.

- [ ] **Step 1: Write failing normalization tests**

Cover fragment removal, `utm_*`, `gclid`, `fbclid`, sorted allowed query keys, default-port normalization, duplicate slash preservation rules, and rejection of `mailto:` / `tel:` as navigable URLs.

```ts
it('drops tracking parameters and fragments', () => {
  const result = normalizeUrl(
    '/pricing?utm_source=x&page=2#top',
    'https://example.test/',
    new Set(['page']),
  );
  expect(result).toEqual({ ok: true, url: 'https://example.test/pricing?page=2' });
});
```

- [ ] **Step 2: Implement normalization and admission**

Admission categories are:

```ts
export type UrlAdmission =
  | { readonly kind: 'INTERNAL_NAVIGABLE'; readonly url: string }
  | { readonly kind: 'EXTERNAL_RECORD_ONLY'; readonly url: string }
  | { readonly kind: 'SPECIAL_SCHEME_RECORD_ONLY'; readonly rawUrl: string; readonly scheme: string }
  | { readonly kind: 'REJECTED_INVALID'; readonly rawUrl: string; readonly reason: string };
```

Only HTTP(S) same-origin URLs can become `INTERNAL_NAVIGABLE`.

- [ ] **Step 3: Write failing BFS queue tests**

Verify insertion order, visited de-duplication, depth preservation, and no re-enqueue after dequeue.

- [ ] **Step 4: Implement `CrawlQueue` as a deterministic FIFO**

Do not use concurrency inside the queue. The coordinator is the only owner of dequeue sequencing.

- [ ] **Step 5: Write and implement DOM link discovery tests**

Use a tiny Playwright page with `page.setContent()` and assert extraction of `anchorText`, `ariaLabel`, `title`, `rawHref`, and source page ID. Discovery records special/external links but queues none of them.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
```

Commit:

```bash
git add src/crawl tests/unit/normalize-url.test.ts tests/unit/admission-policy.test.ts tests/unit/crawl-queue.test.ts tests/component/discover-links.test.ts
git commit -m "feat: add deterministic crawl policy"
```

---

### Task 4: Build the local fixture server and server-side mutation counters

**Files:**
- Create: `fixtures/server.ts`
- Create: `fixtures/site/index.html`
- Create: `fixtures/site/post-form.html`
- Create: `fixtures/site/put-request.html`
- Create: `fixtures/site/external-link.html`
- Create: `fixtures/site/mailto-link.html`
- Create: `fixtures/site/tel-link.html`
- Test: `tests/integration/fixture-server.test.ts`

**Interfaces:**
- `startFixtureServer(): Promise<FixtureServer>` where `FixtureServer` exposes `origin`, `resetCounters()`, `getCounters()`, `close()`.
- Counters distinguish `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, WebSocket upgrade, and download hits.

- [ ] **Step 1: Write the failing fixture-server test**

```ts
it('records mutation endpoint hits independently from browser logic', async () => {
  const server = await startFixtureServer();
  const response = await fetch(`${server.origin}/__mutation`, { method: 'POST' });
  expect(response.status).toBe(204);
  expect(server.getCounters().post).toBe(1);
  await server.close();
});
```

- [ ] **Step 2: Implement a dependency-free Node HTTP fixture server**

Use `node:http`, route static fixture files safely under `fixtures/site`, provide `/__mutation` for all methods, `/__download` with `Content-Disposition: attachment`, and `/__counters` for debugging. Resolve paths and reject traversal outside the fixture directory.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/integration/fixture-server.test.ts
```

Commit:

```bash
git add fixtures tests/integration/fixture-server.test.ts
git commit -m "test: add BeakSight fixture server"
```

---

### Task 5: Implement Safety Guard, Safety Ledger, and header redaction

**Files:**
- Create: `src/safety/request-policy.ts`
- Create: `src/safety/safety-ledger.ts`
- Create: `src/safety/redact.ts`
- Test: `tests/unit/request-policy.test.ts`
- Test: `tests/unit/redact.test.ts`
- Test: `tests/integration/passive-request-guard.test.ts`

**Interfaces:**
- `isReadMethod(method: string): boolean`.
- `installPassiveRequestGuard(context: BrowserContext, ledger: SafetyLedger, allowedOrigins: ReadonlySet<string>): Promise<void>`.
- `SafetyLedger.recordBlockedRequest(...)`, `snapshot(): SafetyLedgerSnapshot`.
- `redactHeaders(headers: Record<string,string>): Record<string,string>`.

- [ ] **Step 1: Write failing request-policy tests**

Assert only case-insensitive GET/HEAD are allowed. OPTIONS is blocked because the approved authority is exactly GET/HEAD.

- [ ] **Step 2: Write failing redaction tests**

Assert `authorization`, `cookie`, `set-cookie`, `x-api-key`, and token/session-name candidates become `[REDACTED]`, while `content-type` remains visible.

- [ ] **Step 3: Implement pure request policy and redaction**

Do not put Playwright objects in the pure policy module. This keeps safety classification unit-testable.

- [ ] **Step 4: Write the failing server-side safety integration test**

Navigate to `post-form.html`, invoke the page-side form submission deliberately in the fixture environment, then assert:

```ts
expect(server.getCounters().post).toBe(0);
expect(ledger.snapshot().blockedRequestsByMethod.POST).toBeGreaterThan(0);
```

This proves S01 at the server boundary.

- [ ] **Step 5: Implement BrowserContext route interception**

Use `context.route('**/*', ...)` before any page is created. `GET`/`HEAD` subresources may continue, including CDN resources required to render the page. A main-frame navigation request whose origin is not in `allowedOrigins` is aborted and recorded as a blocked navigation; every non-read method is aborted and recorded. Install a WebSocket route before page creation that records and refuses server connection, because passive WebSocket traffic cannot be proven read-only. Create contexts with `serviceWorkers: 'block'` so required interception cannot be bypassed by a service worker. If blocking a WebSocket or non-read dependency prevents complete rendering, the page must later be marked partially observed rather than silently passed.

- [ ] **Step 6: Verify S01/S02 plus external-navigation/WebSocket blocking primitives and commit**

Extend the integration test for PUT/PATCH/DELETE and assert fixture counters remain zero. Add a fixture redirect toward another origin and assert the main-frame external follow-up is blocked while ordinary external-origin image/script GET subresources remain renderable. Add a passive WebSocket attempt and assert no fixture WebSocket server connection is established.

```bash
npx vitest run tests/unit/request-policy.test.ts tests/unit/redact.test.ts
npx vitest run tests/integration/passive-request-guard.test.ts
```

Commit:

```bash
git add src/safety tests/unit/request-policy.test.ts tests/unit/redact.test.ts tests/integration/passive-request-guard.test.ts
git commit -m "feat: enforce read-only network authority"
```

---

### Task 6: Create browser contexts, page settling, and controlled scrolling

**Files:**
- Create: `src/browser/context-factory.ts`
- Create: `src/browser/page-settling.ts`
- Create: `src/browser/controlled-scroll.ts`
- Test: `tests/component/context-factory.test.ts`
- Test: `tests/integration/controlled-scroll.test.ts`

**Interfaces:**
- `BrowserContextFactory.createPassiveContext(viewport): Promise<BrowserContext>`.
- `waitForPageSettled(page, policy): Promise<PageSettlingResult>`.
- `controlledScroll(page, options): Promise<ScrollResult>`.

- [ ] **Step 1: Write failing context tests**

Verify locale/timezone/viewport and that a passive context blocks service workers. Verify no production context can be created without a Safety Ledger dependency.

- [ ] **Step 2: Implement `BrowserContextFactory` with dependency injection**

Constructor dependencies are `Browser`, `AuditConfig`, and a ledger factory. Do not import global config inside the factory.

- [ ] **Step 3: Write failing scroll test using lazy content**

Add lazy DOM content when scroll approaches the bottom. Assert controlled scroll observes the increased `scrollHeight` and reaches the final document bottom without a fixed number of steps.

- [ ] **Step 4: Implement settling and scroll**

The scroll loop reads `scrollY`, viewport height, and current `scrollHeight`, moves by a bounded fraction of viewport height, waits a short deterministic interval, detects height growth, and terminates only after bottom plus a stable-height window. Return `PARTIAL` metadata rather than hanging when the overall page deadline expires.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/component/context-factory.test.ts
npx vitest run tests/integration/controlled-scroll.test.ts
```

Commit:

```bash
git add src/browser tests/component/context-factory.test.ts tests/integration/controlled-scroll.test.ts
git commit -m "feat: add passive browser lifecycle"
```

---

### Task 7: Collect network, resource, console, and JavaScript evidence

**Files:**
- Create: `src/evidence/network-collector.ts`
- Create: `src/evidence/console-collector.ts`
- Test: `tests/component/network-collector.test.ts`
- Test: `tests/integration/technical-evidence.test.ts`
- Create: `fixtures/site/js-error.html`
- Add fixture: broken image route in `fixtures/server.ts`

**Interfaces:**
- `NetworkCollector.attach(page): CollectorHandle<NetworkEvidence>`.
- `ConsoleCollector.attach(page): CollectorHandle<ConsoleEvidence>`.
- Collect request, response, requestfailed, console error/warn, pageerror, redirect chain, resource type, timing where exposed, size headers, and redacted selected headers.

- [ ] **Step 1: Write failing collector tests**

Use fixture pages to produce one uncaught exception, one `console.error`, one `console.warn`, one 404 image, and one redirected navigation. Assert evidence is preserved separately and duplicate console errors can later be fingerprinted.

- [ ] **Step 2: Implement attach/detach collector handles**

Collectors own event listeners and return immutable snapshots. They do not create Findings.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/integration/technical-evidence.test.ts
```

Commit:

```bash
git add src/evidence/network-collector.ts src/evidence/console-collector.ts fixtures tests/component/network-collector.test.ts tests/integration/technical-evidence.test.ts
git commit -m "feat: collect network and JavaScript evidence"
```

---

### Task 8: Collect DOM, visible text, links, forms, images, and screenshot evidence

**Files:**
- Create: `src/evidence/dom-collector.ts`
- Create: `src/evidence/screenshot-collector.ts`
- Test: `tests/component/dom-collector.test.ts`
- Test: `tests/integration/screenshot-collector.test.ts`

**Interfaces:**
- `collectDomEvidence(page, pageId): Promise<DomEvidence>`.
- `captureScreenshots(page, paths): Promise<readonly ScreenshotEvidence[]>`.

- [ ] **Step 1: Write failing DOM evidence test**

Assert collection of title, meta description, canonical, lang, heading levels/text, semantic-region visible text, internal/external/special links, image src/alt/complete/natural size, form method/action, fields, required state, labels, and submit controls.

- [ ] **Step 2: Implement DOM collection in one browser evaluation**

Prefer semantic landmarks (`header`, `nav`, `main`, `aside`, `footer`, form regions) and fall back to `body.innerText`. Never fill or submit fields.

- [ ] **Step 3: Write failing screenshot test**

Assert viewport and full-page PNGs are written and the evidence records relative artifact paths, page ID, viewport name, and capture type.

- [ ] **Step 4: Implement screenshots without baseline comparison**

Do not implement pixel diffing or baseline storage.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/component/dom-collector.test.ts
npx vitest run tests/integration/screenshot-collector.test.ts
```

Commit:

```bash
git add src/evidence/dom-collector.ts src/evidence/screenshot-collector.ts tests/component/dom-collector.test.ts tests/integration/screenshot-collector.test.ts
git commit -m "feat: collect page content evidence"
```

---

### Task 9: Implement layout, responsive stress, accessibility, and contrast evidence

**Files:**
- Create: `src/evidence/layout-collector.ts`
- Create: `src/evidence/accessibility-collector.ts`
- Create: `src/evidence/color-collector.ts`
- Create: `fixtures/site/overflow.html`
- Create: `fixtures/site/clipped-text.html`
- Create: `fixtures/site/bad-contrast.html`
- Test: `tests/component/layout-collector.test.ts`
- Test: `tests/integration/layout-accessibility.test.ts`

**Interfaces:**
- `collectLayoutEvidence(page, viewport): Promise<LayoutEvidence>`.
- `collectStressLayout(pageFactory, url, widths): Promise<readonly StressLayoutEvidence[]>`.
- `collectAccessibilityEvidence(page): Promise<AccessibilityEvidence>`.
- `collectColorEvidence(page): Promise<ColorEvidence>`.

- [ ] **Step 1: Write failing layout tests**

Test absolute facts: document horizontal overflow, interactive zero-size elements, fixed element covering a visible heading, clipped overflow text, and element boxes outside viewport. Do not treat every geometric overlap as an error: only collect overlap evidence when both elements are visible and the combination matches a deterministic rule precondition.

- [ ] **Step 2: Implement layout collection with `getBoundingClientRect()`**

Return geometry evidence and candidate conditions. Keep threshold constants in one exported `LAYOUT_THRESHOLDS` object so rule versions can later reference them.

- [ ] **Step 3: Implement responsive stress sweep**

For each configured width, create an isolated passive page with a deterministic height, navigate independently, collect geometry, and close it. Do not reuse mutated page state across widths.

- [ ] **Step 4: Write failing axe test and implement accessibility collection**

Use:

```ts
const result = await new AxeBuilder({ page }).analyze();
```

Store violations with rule ID, impact, help text, target selectors as evidence only, and HTML snippets constrained to a small bounded length. Ensure contrast violations are retained.

- [ ] **Step 5: Add CSS color evidence without image analysis**

Collect visible text computed foreground colors, effective background-color candidates by walking ancestors until a non-transparent color is found, the contrast pair used for accessibility evaluation, and an approximate area-weighted distribution of visible computed CSS colors. Bound the number of retained samples and do not classify aesthetic balance.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/integration/layout-accessibility.test.ts
```

Commit:

```bash
git add src/evidence/layout-collector.ts src/evidence/accessibility-collector.ts src/evidence/color-collector.ts fixtures/site/overflow.html fixtures/site/clipped-text.html fixtures/site/bad-contrast.html tests/component/layout-collector.test.ts tests/integration/layout-accessibility.test.ts
git commit -m "feat: audit layout and accessibility evidence"
```

---

### Task 10: Collect synthetic Web Vitals, Navigation/Resource Timing, Server-Timing, and telemetry evidence

**Files:**
- Create: `src/evidence/performance-collector.ts`
- Test: `tests/component/performance-collector.test.ts`
- Test: `tests/integration/performance-evidence.test.ts`

**Interfaces:**
- `PerformanceCollector.installBeforeNavigation(context): Promise<void>`.
- `PerformanceCollector.collect(page): Promise<PerformanceEvidence>`.
- Web Vital state is `OBSERVED | NOT_OBSERVED | UNSUPPORTED`; never synthesize a missing numeric value.

- [ ] **Step 1: Write failing performance state tests**

Verify missing INP becomes `{status:'NOT_OBSERVED', value:null}` and does not become zero. Verify Navigation Timing and Resource Timing entries map into typed evidence.

- [ ] **Step 2: Inject the `web-vitals` IIFE before navigation**

Resolve the installed `web-vitals` attribution IIFE bundle from local `node_modules`, read its script content in Node, and pass it to `context.addInitScript`. In the init script, register `onLCP`, `onCLS`, `onINP`, `onFCP`, and `onTTFB` callbacks into a page-global bounded result object, retaining attribution fields for CLS/LCP/INP only when the library exposes them. Do not send telemetry from the injected code.

- [ ] **Step 3: Collect timing evidence after scroll/settling**

Read `performance.getEntriesByType('navigation')`, `resource`, and Server-Timing data exposed through navigation/resource entries. Summarize transfer sizes by script/style/image/fetch-xhr. Preserve publicly exposed `traceparent`, `tracestate`, request-id, and correlation-id style headers from the redacted Network Evidence, and record analytics/telemetry request metadata without claiming they are true RUM/APM traces.

- [ ] **Step 4: Verify performance timeout behavior**

A collector timeout returns partial performance evidence and a reason; it never fails the whole Run by itself.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/component/performance-collector.test.ts
npx vitest run tests/integration/performance-evidence.test.ts
```

Commit:

```bash
git add src/evidence/performance-collector.ts tests/component/performance-collector.test.ts tests/integration/performance-evidence.test.ts
git commit -m "feat: collect synthetic performance evidence"
```

---

### Task 11: Implement dynamic interaction discovery and isolated fail-closed interaction auditing

**Files:**
- Create: `src/safety/interaction-policy.ts`
- Create: `src/interaction/discover-candidates.ts`
- Create: `src/interaction/isolated-auditor.ts`
- Create: `src/evidence/interaction-collector.ts`
- Create: `fixtures/site/accordion.html`
- Create: `fixtures/site/popup-button.html`
- Create: `fixtures/site/download-button.html`
- Create: `fixtures/site/websocket.html`
- Create: `fixtures/site/service-worker.html`
- Test: `tests/unit/interaction-policy.test.ts`
- Test: `tests/integration/isolated-interaction.test.ts`

**Interfaces:**
- `discoverInteractionCandidates(page): Promise<readonly InteractionCandidate[]>`.
- `classifyInteractionCandidate(candidate): InteractionAdmission`.
- `auditInteraction(input): Promise<InteractionAuditResult>`.

- [ ] **Step 1: Write failing candidate classification tests**

Candidate sources include `button`, `[role=button]`, `[role=tab]`, `[aria-expanded]`, `[aria-controls]`, and `summary`. Reject controls that are submit/reset, belong to a form with submission semantics, carry navigation `href`, download behavior, or special/external schemes.

- [ ] **Step 2: Implement dynamic discovery without site selectors**

Capture stable descriptive properties: tag, role, accessible name, text fingerprint, aria-expanded, aria-controls, form association, href, type, and bounding box.

- [ ] **Step 3: Write failing isolated safety tests**

For safe accordion: expect `VERIFIED` and changed ARIA/visibility state with zero network hits after freeze.
For popup/download/navigation/WebSocket attempts: expect blocked/not-verifiable and zero fixture target hits.

- [ ] **Step 4: Implement interaction Network Freeze**

After the page’s initial passive load, install route abort for all new requests, popup handler that immediately closes/records, download handler that cancels/records, frame navigation observation that rejects unexpected navigation, and WebSocket routing that prevents connection during interaction. Destroy the context after each candidate or candidate group.

- [ ] **Step 5: Verify Safety Gates S03-S08**

```bash
npx vitest run tests/integration/isolated-interaction.test.ts
```

The assertions must prove fixture-side launch/download/mutation/upgrade counters stay zero where applicable.

- [ ] **Step 6: Commit**

```bash
git add src/safety/interaction-policy.ts src/interaction src/evidence/interaction-collector.ts fixtures/site tests/unit/interaction-policy.test.ts tests/integration/isolated-interaction.test.ts
git commit -m "feat: add isolated safe interaction audit"
```

---

### Task 12: Implement the deterministic Rule Engine and technical rule catalog

**Files:**
- Create: `src/audit/rule.ts`
- Create: `src/audit/rule-engine.ts`
- Create: `src/audit/technical-rules.ts`
- Create: `src/audit/layout-rules.ts`
- Create: `src/audit/accessibility-rules.ts`
- Create: `src/audit/performance-rules.ts`
- Test: `tests/component/rule-engine.test.ts`
- Test: `tests/component/technical-rules.test.ts`

**Interfaces:**
- `AuditRule<T>.evaluate(evidence: T): readonly FindingDraft[]`.
- `RuleEngine.evaluate(pageEvidence): readonly Finding[]`.
- Stable fingerprint function based on rule ID plus relevant normalized identity fields.

- [ ] **Step 1: Write failing Rule Engine tests**

Create artificial Evidence and assert exact rule IDs for:

```text
HTTP_4XX
HTTP_5XX
NAVIGATION_TIMEOUT
BROKEN_INTERNAL_LINK
RESOURCE_4XX
RESOURCE_5XX
IMAGE_LOAD_FAILED
PAGE_ERROR
MISSING_TITLE
EMPTY_TITLE
MISSING_HTML_LANG
DUPLICATE_ELEMENT_ID
INVALID_CANONICAL_URL
DOCUMENT_HORIZONTAL_OVERFLOW
ZERO_SIZE_INTERACTIVE_ELEMENT
COLOR_CONTRAST_VIOLATION
```

Also cover `REDIRECT_LOOP`, `UNEXPECTED_ORIGIN_REDIRECT`, `EMPTY_HTTP_RESPONSE`, `INVALID_INTERNAL_URL`, `UNSUPPORTED_URL_SCHEME`, `TARGET_NAVIGATION_FAILED`, `SCRIPT_LOAD_FAILED`, `STYLESHEET_LOAD_FAILED`, `EMPTY_VISIBLE_CONTENT`, `FORM_WITHOUT_ACTION`, `UNLABELED_REQUIRED_CONTROL`, `ELEMENT_OUTSIDE_VIEWPORT`, `ELEMENT_OVERLAP`, `TEXT_CLIPPING`, `FIXED_ELEMENT_OCCLUSION`, `CONTENT_COLLISION`, `OVERSIZED_FIXED_ELEMENT`, `DYNAMIC_LAYOUT_SHIFT`, and `POOR_CLS`.

Assert that anchor text “交通事故” pointing to `/symptoms` does **not** become a semantic Finding.

- [ ] **Step 2: Implement rule contracts and fingerprinting**

Rules have explicit `ruleId`, integer `version`, category, severity, and `evaluate`. The engine assigns Finding IDs after all drafts are normalized and sorted deterministically.

- [ ] **Step 3: Implement performance WARN rules**

Use absolute current-state ratings only. Do not create regression rules. When a Web Vital is not observed, emit INFO evidence state if useful but never “good” or “zero”.

- [ ] **Step 4: Implement accessibility mapping**

Map axe contrast violations to `COLOR_CONTRAST_VIOLATION`; other axe violations remain accessibility Findings with stable rule IDs and severities based on deterministic impact mapping. Do not infer aesthetic balance.

- [ ] **Step 5: Verify Auditor Gates A01-A06 primitives and commit**

```bash
npx vitest run tests/component/rule-engine.test.ts tests/component/technical-rules.test.ts
```

Commit:

```bash
git add src/audit tests/component/rule-engine.test.ts tests/component/technical-rules.test.ts
git commit -m "feat: add deterministic audit rule engine"
```

---

### Task 13: Implement cross-page structural auditing

**Files:**
- Create: `src/audit/cross-page-rules.ts`
- Test: `tests/component/cross-page-rules.test.ts`

**Interfaces:**
- `evaluateCrossPageRules(pages: readonly PageAuditResult[]): readonly Finding[]`.

- [ ] **Step 1: Write failing cross-page tests**

Cover duplicate title, duplicate canonical, multiple URLs pointing to the same canonical, canonical target not discovered, and inconsistent origin. Store all headings/link text so ChatGPT can later assess semantic duplication, but do not automatically flag “6つの理由” vs “7つの理由” as contradictory.

- [ ] **Step 2: Implement deterministic cross-page indexing**

Build maps by normalized title/canonical/origin. Accept optional sitemap Evidence and expose `SITEMAP_URL_NOT_DISCOVERED` / `DISCOVERED_URL_NOT_IN_SITEMAP` as INFO/WARN-level structural observations only; never ERROR solely from sitemap disagreement. Ensure input order does not change output order or fingerprints.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/component/cross-page-rules.test.ts
```

Commit:

```bash
git add src/audit/cross-page-rules.ts tests/component/cross-page-rules.test.ts
git commit -m "feat: add cross-page structural audit"
```

---

### Task 14: Compose a single-page audit pipeline

**Files:**
- Create: `src/orchestration/page-auditor.ts`
- Test: `tests/integration/page-auditor.test.ts`

**Interfaces:**
- `PageAuditor.audit(url, pageId, viewportProfile): Promise<PageAuditResult>`.
- Dependencies are injected: context factory, collectors, rule engine, screenshot writer, clock/deadline policy.

- [ ] **Step 1: Write the failing integration test**

Audit a fixture page containing a broken image plus console error. Assert the result contains Evidence first, Findings reference valid Evidence IDs, screenshots exist, and status is `AUDITED` when all required collectors complete.

- [ ] **Step 2: Implement the ordered page pipeline**

Order:

```text
create passive context
attach collectors
navigate
wait for DOM readiness
controlled scroll / lazy settling
collect DOM/layout/accessibility/performance
capture screenshots
discover links
apply page rules
optionally run isolated interactions
close context
return immutable PageAuditResult
```

Ensure `finally` closes contexts. Collector failures become explicit partial reasons where the specification allows partial observation.

- [ ] **Step 3: Add Desktop/Mobile independence test**

Simulate mobile-only overflow and prove Desktop result stays `AUDITED`, Mobile records the layout Finding, and page-level aggregation never hides the viewport-specific condition.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/integration/page-auditor.test.ts
```

Commit:

```bash
git add src/orchestration/page-auditor.ts tests/integration/page-auditor.test.ts
git commit -m "feat: compose page audit pipeline"
```

---

### Task 15: Implement Run Coordinator, BFS crawl budgets, retry policy, and honest completion state

**Files:**
- Create: `src/orchestration/run-coordinator.ts`
- Create: `src/crawl/site-metadata.ts`
- Test: `tests/unit/run-coordinator.test.ts`
- Test: `tests/integration/crawl-run.test.ts`

**Interfaces:**
- `RunCoordinator.run(config): Promise<AuditRun>`.
- `collectSiteMetadata(contextFactory, origin): Promise<SiteMetadataEvidence>` reads `/robots.txt` and `/sitemap.xml` through a guarded passive BrowserContext and treats sitemap URLs as Evidence, not automatic queue authority.
- Retry only transient navigation failure, maximum 2 attempts total; never retry 4xx/5xx, safety blocks, or mutation attempts.

- [ ] **Step 1: Write failing budget/status tests**

Assert page limit, depth limit, and runtime limit each produce `PARTIAL` plus a concrete reason; 50/50 audited pages with Findings can still be `COMPLETE`; 49/50 silently omitted can never be `COMPLETE`.

- [ ] **Step 2: Implement PREFLIGHT**

Validate config, output writability, Chromium launch, Safety Guard construction, schema loader, and start URL. Generate `runId`/start timestamp and capture execution environment facts: Node version, platform, architecture, Playwright package version, Chromium version, headed/headless mode, viewport profiles, locale, timezone, and effective user agent. If safety initialization fails, do not access the target site.

- [ ] **Step 3: Collect robots.txt and sitemap.xml as bounded Evidence**

Use a guarded passive context and ordinary GET navigation for `/robots.txt` and `/sitemap.xml`; never introduce a second unguarded Node `fetch` path. Parse sitemap `<loc>` values into normalized Evidence. A sitemap-only URL is not automatically crawled in v1, and sitemap disagreement is not an ERROR by itself.

- [ ] **Step 4: Implement BFS run loop**

At concurrency `1`, dequeue, audit Desktop/Mobile, discover/normalize/admit links, enqueue unseen candidates, check budgets before each next page, and maintain explicit URL states `DISCOVERED | QUEUED | AUDITING | AUDITED | SKIPPED | FAILED`.

- [ ] **Step 5: Implement retry ledger**

Store both initial transient failure Evidence and retry result. Never erase the first failure merely because retry succeeds.

- [ ] **Step 6: Run cross-page rules and derive final status**

Cross-page evaluation runs after crawl ends. Completion status is derived from execution facts, not Finding counts.

- [ ] **Step 7: Verify A09 and commit**

```bash
npx vitest run tests/unit/run-coordinator.test.ts
npx vitest run tests/integration/crawl-run.test.ts
```

Commit:

```bash
git add src/orchestration/run-coordinator.ts src/crawl/site-metadata.ts tests/unit/run-coordinator.test.ts tests/integration/crawl-run.test.ts
git commit -m "feat: orchestrate bounded recursive audits"
```

---

### Task 16: Generate validated JSON artifacts, safe HTML report, and ChatGPT handoff ZIP

**Files:**
- Create: `src/report/artifact-writer.ts`
- Create: `src/report/html-report.ts`
- Create: `src/report/chatgpt-bundle.ts`
- Test: `tests/unit/artifact-writer.test.ts`
- Test: `tests/integration/report-generation.test.ts`

**Interfaces:**
- `ArtifactWriter.writeRun(run): Promise<ArtifactWriteResult>`.
- `renderHtmlReport(run): string`.
- `createChatGptBundle(run, outputPath): Promise<void>`.

- [ ] **Step 1: Write failing artifact-layout test**

Assert exact root structure:

```text
beaksight-output/<run-id>/
  run.json
  audit.json
  report.html
  pages/<page-id>/page.json
  pages/<page-id>/visible-text.txt
  pages/<page-id>/desktop/viewport.png
  pages/<page-id>/desktop/full.png
  pages/<page-id>/mobile/viewport.png
  pages/<page-id>/mobile/full.png
  evidence/network.json
  evidence/console.json
  evidence/performance.json
  evidence/accessibility.json
  evidence/interactions.json
  chatgpt/manifest.json
  chatgpt/summary.json
  chatgpt/findings.json
  chatgpt/pages.json
  chatgpt/evidence-index.json
  beaksight-audit-bundle.zip
```

- [ ] **Step 2: Implement write-then-validate semantics**

Construct JSON in memory, validate against schema first, write atomically via temporary file plus rename, and only then mark the artifact valid. Write textual artifacts explicitly as UTF-8 and normalize generated text to LF before writing. Invalid required schema forces final status away from `COMPLETE` (A10). After Findings exist, derive screenshot `relatedFindingIds` by joining Finding `evidenceRefs` to screenshot Evidence; do not require the screenshot collector to predict future Findings.

- [ ] **Step 3: Write failing HTML safety test**

Input a `mailto:` and `tel:` evidence URL. Assert generated HTML contains escaped text but no clickable `href="mailto:` or `href="tel:`. Also HTML-escape all Evidence strings to prevent report injection.

- [ ] **Step 4: Implement static HTML report**

No SPA framework. Render Run Status, page coverage, ERROR/WARN/INFO/SAFETY counts, category sections, page list, evidence IDs, viewport, rule ID/version, and screenshot references. Internal report navigation can use safe fragment anchors.

- [ ] **Step 5: Implement ChatGPT bundle with fflate**

Include logical JSON views and issue-related screenshots without duplicating raw response bodies. Bundle paths are deterministic and use UTF-8 file names.

- [ ] **Step 6: Verify A10 and commit**

```bash
npx vitest run tests/unit/artifact-writer.test.ts
npx vitest run tests/integration/report-generation.test.ts
```

Commit:

```bash
git add src/report tests/unit/artifact-writer.test.ts tests/integration/report-generation.test.ts
git commit -m "feat: generate audit reports and handoff bundle"
```

---

### Task 17: Wire the production CLI, exit codes, and full configuration overrides

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Exit codes: COMPLETE `0`, FAILED `1`, PARTIAL `2`, ABORTED_BY_SAFETY `3`, CONFIG_ERROR `4`.

- [ ] **Step 1: Write failing CLI tests**

Spawn the built CLI against fixture config and assert `validate-config`, headed/headless mutual exclusion, output override, and exit-code mapping. Assert a complete audit with site ERROR Findings still exits `0`.

- [ ] **Step 2: Replace the Task 1 run stub**

The CLI loads config, applies explicit CLI overrides, constructs the dependency graph, runs the coordinator, writes reports, prints the output directory and concise counts, and sets the process exit code from Run Status.

- [ ] **Step 3: Reject ambiguous CLI flags**

Passing both `--headed` and `--headless` is CONFIG_ERROR. Invalid config paths or invalid JSON are CONFIG_ERROR with concise user-facing error messages and no stack trace unless an explicit future debug flag is added.

- [ ] **Step 4: Verify and commit**

```bash
npm run build
npx vitest run tests/integration/cli.test.ts
```

Commit:

```bash
git add src/cli/index.ts tests/integration/cli.test.ts
git commit -m "feat: wire BeakSight production CLI"
```

---

### Task 18: Complete fixture coverage and codify Safety/Auditor Acceptance Gates

**Files:**
- Extend: `fixtures/server.ts`
- Extend/Create: `fixtures/site/*`
- Create: `tests/integration/safety-gates.test.ts`
- Create: `tests/integration/auditor-gates.test.ts`

**Interfaces:**
- Safety test names include `GATE-S01` through `GATE-S10` exactly.
- Auditor test names include `GATE-A01` through `GATE-A10` exactly.

- [ ] **Step 1: Add missing deterministic fixture cases**

Create fixtures for 404 internal link, broken image, JS exception, horizontal overflow, bad contrast, safe accordion, unsafe interaction, crawl-limit graph, service worker attempted request, popup, download, and WebSocket.

- [ ] **Step 2: Implement S01-S10 as server-boundary assertions**

Required assertions:

```text
S01 POST never reaches fixture server
S02 PUT/PATCH/DELETE never reach fixture server
S03 mailto/tel/external app actions are never launched
S04 popup is blocked during isolated interaction
S05 download is blocked during isolated interaction
S06 interaction-time navigation is blocked
S07 WebSocket is blocked during isolated interaction
S08 Service Worker cannot bypass interception policy
S09 sensitive headers are redacted in artifacts
S10 Safety Guard initialization failure prevents target-site access
```

S10 uses a deliberately throwing guard factory and asserts fixture GET count is zero.

- [ ] **Step 3: Implement A01-A10**

Required assertions:

```text
A01 404 -> HTTP_4XX
A02 broken internal link -> BROKEN_INTERNAL_LINK
A03 uncaught JS exception -> page error Finding
A04 broken image -> IMAGE_LOAD_FAILED
A05 horizontal overflow -> DOCUMENT_HORIZONTAL_OVERFLOW
A06 poor contrast -> accessibility Finding
A07 safe accordion -> VERIFIED
A08 unsafe interaction -> blocked/not verified
A09 crawl limit -> PARTIAL
A10 invalid output schema -> COMPLETE prohibited
```

- [ ] **Step 4: Run all gates**

```bash
npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts
```

Expected: every named Gate PASS.

- [ ] **Step 5: Commit**

```bash
git add fixtures tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts
git commit -m "test: enforce BeakSight acceptance gates"
```

---

### Task 19: Run full local verification and fixture full crawl

**Files:**
- Modify only if verification exposes a defect in files owned by Tasks 1-18.
- Create: `README.md`

**Interfaces:**
- Produces a documented local verification command sequence and fixture full-crawl result.

- [ ] **Step 1: Run strict verification**

```bash
npm run verify
```

Expected: typecheck PASS, all unit/component/integration tests PASS, build PASS.

- [ ] **Step 2: Install the Playwright Chromium binary if the environment does not already have it**

```bash
npx playwright install chromium
```

Do not install browsers not used by the initial implementation.

- [ ] **Step 3: Run a fixture full crawl through the real CLI**

Start the fixture server, point a temporary config at its origin, and run:

```bash
node dist/cli/index.js run --config ./tmp/fixture-audit.json --headless --output ./tmp/beaksight-output
```

Expected: Run Status `COMPLETE`; the deliberately broken site produces expected Findings; no Safety invariant violation exists.

- [ ] **Step 4: Write README operational guidance**

Document installation, `beaksight validate-config`, `beaksight run`, the initial target config, output structure, read-only guarantee boundaries, Safety Ledger interpretation, and that RUM/APM values are synthetic/telemetry evidence rather than private backend traces.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document BeakSight operation"
```

---

### Task 20: Execute the initial target-site smoke only after all gates pass

**Files:**
- No production code change is expected.
- Generated artifact: `beaksight-output/<smoke-run-id>/...`
- Optionally create: `docs/verification/2026-08-27-example-smoke.md` containing only factual execution evidence.

**Interfaces:**
- Uses `config/targets/example.json` with runtime overrides `maxPages=5`, headed mode, concurrency fixed at 1.

- [ ] **Step 1: Re-run the mandatory pre-smoke gate**

```bash
npm run verify
npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts
```

If any command fails, do not access `https://www.example.com/`.

- [ ] **Step 2: Create a smoke-only config without changing the standard config**

Copy the approved target config into a temporary file and set:

```json
{
  "crawl": { "maxPages": 5 },
  "browser": { "headed": true }
}
```

The merge retains all other defaults and the initial target origin.

- [ ] **Step 3: Run headed smoke**

```bash
node dist/cli/index.js run --config ./tmp/example-smoke.json --headed
```

Observe only; do not manually interact with the browser in ways outside BeakSight policy.

- [ ] **Step 4: Inspect generated Safety Ledger and coverage**

Required facts:

```text
guardEnabled = true
invariantViolations = 0
no non-read request reached the target by tool authority
no form input or submission was performed
no tel/mail/LINE/external application launch occurred
artifacts are schema-valid
```

If `blockedRequestsByMethod.POST > 0`, this is not itself failure; confirm they were blocked and the Run correctly reports any resulting partial observation.

- [ ] **Step 5: Decide smoke result from evidence**

PASS requires the CLI to complete or honestly report PARTIAL for site-dependent blocked content, while preserving safety invariants and required artifacts. Any Safety invariant violation is an immediate stop; do not proceed to full crawl.

- [ ] **Step 6: Commit only source documentation, never generated audit artifacts unless repository policy explicitly requires them**

```bash
git add docs/verification/2026-08-27-example-smoke.md
git commit -m "docs: record initial BeakSight smoke evidence"
```

Skip this commit if the repository intentionally does not version verification logs.

---

### Task 21: Run the initial full audit and verify the Completion Gate

**Files:**
- No new production files expected.
- Generated artifact: `beaksight-output/<full-run-id>/...`

**Interfaces:**
- Full execution uses standard `config/targets/example.json` and current default `maxPages=500`, `maxDepth=20`, `maxRuntimeMs=3_600_000`, concurrency `1`.

- [ ] **Step 1: Run the full target audit only after Task 20 smoke PASS**

```bash
node dist/cli/index.js run --config ./config/targets/example.json --headless
```

- [ ] **Step 2: Verify required artifacts**

Confirm `run.json`, `audit.json`, `report.html`, page evidence, Desktop/Mobile screenshots, ChatGPT logical view files, and `beaksight-audit-bundle.zip` exist and validate.

- [ ] **Step 3: Verify completion semantics**

A Run with site ERROR Findings may still be `COMPLETE`. A Run hitting max pages/depth/runtime, failing required viewport audits, or producing invalid required artifacts must be `PARTIAL` or worse. Confirm there is no hidden skip.

- [ ] **Step 4: Verify handoff usability**

Open `report.html` locally, ensure Findings navigate to Evidence/Screenshots, and confirm dangerous schemes are not clickable. Inspect the ChatGPT ZIP contents without uploading it automatically.

- [ ] **Step 5: Final verification command**

```bash
npm run verify
```

Expected: PASS after the full audit; no production source was mutated by the audit itself.

---

## Implementation Review Checkpoints

After Tasks 5, 11, 15, 18, and 21, pause for explicit review because these boundaries carry disproportionate risk:

- Task 5: network authority and mutation prevention.
- Task 11: dynamic interaction and browser capability blocking.
- Task 15: crawl completeness and fake-completion prevention.
- Task 18: objective acceptance-gate proof.
- Task 21: production-target full audit evidence.

Do not combine these checkpoints into one large merge without review.

## Final Verification Criteria

The implementation is complete only when all of the following are evidenced:

```text
TypeScript strict compile PASS
Unit tests PASS
Component tests PASS
Integration tests PASS
Safety Gates S01-S10 PASS
Auditor Gates A01-A10 PASS
JSON Schema validation PASS
fixture full crawl COMPLETE
initial target-site smoke PASS
full audit executable
required JSON/HTML/screenshots/ChatGPT bundle generated
Safety Ledger records zero invariant violations
non-read target operations are not sent by BeakSight authority
```

Site Findings are outputs, not implementation failures. An incomplete audit is not a successful complete audit.
