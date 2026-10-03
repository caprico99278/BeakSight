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
- Create: `config/本来の監査対象のサイト.json`
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

`config/本来の監査対象のサイト.json` sets only policy, never selectors:

```json
{
  "site": {
    "startUrl": "本来の監査対象のサイト",
    "allowedOrigins": ["本来の監査対象のサイト"]
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

## Authoritative addendum from the approved execution instructions

These items override conflicting paths/signatures in the older task text above:

- Configuration resolution has one production owner: `src/config/load-config.ts`.
- Canonical API: `loadConfig(path, overrides?) -> Promise<AuditConfig>`.
- Resolution order: generic defaults, target config, CLI overrides, validation, immutable `AuditConfig`.
- `src/**` must remain target-agnostic. It may not contain the initial target name, domain, absolute URL, page paths, selectors, menus, or expected titles.
- Create the initial target file at `config/targets/本来の監査対象のサイト-public.json`, not `config/本来の監査対象のサイト.json`.
- Every target config requires `target.id`; the initial ID is `本来の監査対象のサイト-public`. Duplicate IDs among target JSON files must be rejected/verified.
- `DEFAULT_CONFIG` is generic policy defaults and must not invent target identity. The final `AuditConfig` returned by `loadConfig()` is fully resolved and immutable.
- CLI code may parse flags and construct typed overrides, but must not read target JSON, deep-merge config, or read audit settings directly from environment variables.
- Add or adjust Task 1 tests so these authoritative requirements are covered through observable behavior.
- Git operations and commits are prohibited in this environment. Report `Commits created: NOT APPLICABLE (Git prohibited)`.

---

