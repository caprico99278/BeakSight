/**
 * Control の境界の Architecture Gate（Task 22 の設計書 4.5 の Architecture Gate、T22c）。
 * - (a) `src/` の `control/` 以外のファイルは、`src/control/` を import しない（型だけの import、`export … from`、動的 import、`require` を含む）。
 *   例外は、監査のワーカー（`src/worker/`）から、許すファイル（`worker-boundary-policy.ts` の `WORKER_ALLOWED_CONTROL_FILES`: IPC の契約、
 *   Control のスキーマの検証、契約の型、パスの確かめ）への相対の import だけ（Task 24 の設計書 4.3 の「Gate の例外」。T24d）。ほかの
 *   `src/control/` のファイルへの参照と、`src/worker/` の外からの参照は、今までどおり違反にする。間接の確かめは `worker-boundary.test.ts`。
 * - (b) `src/control/` は、`playwright`（`playwright-core`、`@playwright/*`、Playwright に依存する `@axe-core/playwright` を含む）、
 *   `src/browser/`、`src/safety/`、`src/orchestration/`、
 *   `src/config/validate-config`（`src/safety/` を間接に読み込む）を import しない。`src/config/types` の型、`src/core/`、
 *   `src/crawl/normalize-url` は許す。加えて、実行時に読み込む import（`import type` と `export type` を除く）をたどった先にも、
 *   (b) の禁止の対象が現れないことを確かめる（「間接に読み込む」ことの検査）。指定子は、import・`require`・動的 import と、
 *   `createRequire(…)('…')`・`createRequire(…)` を入れた変数の呼び出しの文字列リテラル（T22d）から取る。
 * - CCX-9（台帳の CC-054、CC-056）: 指定子の取り出し（`findModuleSpecifiers`）と import のたどり（`findImportChains`）、相対の指定子の
 *   解決（`resolveRelativeSpecifier`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す正規表現は、このファイルに書かない）。
 * - `src/**` の読み込みは、このファイルの読み込み時に1回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない。`semantic-ownership.test.ts` と同じ方式）。
 * - 近似の検査である。指定子を実行時に組み立てる import は、相対パスの文字列リテラル（`'../control/'` など）の検出で補う。
 *   除外の一覧は持たない（今は除外がない。必要になったら、理由を付けてこのファイルの中の1か所に置く）。
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  findModuleSpecifiers,
  findTransitiveForbiddenReferences,
  isPathUnderAny,
  loadSourceFiles,
  pathReferenceCandidatesOf,
  referencedPathsOf,
  refersUnderAny,
  resolveRelativeSpecifier,
  scanSource,
  withoutModuleExtension,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';
import { isAllowedWorkerControlReference } from './worker-boundary-policy.js';

const SOURCE_FILES = loadSourceFiles();

const CONTROL_DIRECTORY = 'src/control/';

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ファイルが参照するモジュールの候補（指定子のすべてと、相対パス・`src/` のパスの文字列リテラル。同じ文字列は1つにまとめる）。指定子は、
 * `source-scan.ts` の `findModuleSpecifiers`（CCX-9。import・`export … from`・動的 import・`require`・`createRequire`・テンプレート・
 * `getBuiltinModule`・`new URL(…, import.meta.url)`）から取る（`pathReferenceCandidatesOf`。PRE42-CC 組 G）。
 */
const moduleReferencesOf = (source: ScannedSource): readonly string[] => pathReferenceCandidatesOf(source);

/**
 * (a): `text` が `src/control/` を指すか（相対でない参照は、文字列の中の `src/` からのパス。区切りの `\` を含む。`source-scan.ts` の
 * `refersUnderAny`）。
 */
const pointsIntoControl = (fromPath: string, text: string): boolean => refersUnderAny(fromPath, text, [CONTROL_DIRECTORY]);

/** (a): `src/control/` を指す参照（`<参照>` の形）。監査のワーカーから許すファイルへの相対の参照（T24d）は除く。 */
const findControlReferences = (path: string, source: ScannedSource): readonly string[] =>
  moduleReferencesOf(source).filter((text) => pointsIntoControl(path, text) && !isAllowedWorkerControlReference(path, text));

/** (b): `src/control/` から読み込まない監査エンジンのディレクトリ。 */
const FORBIDDEN_DIRECTORIES: readonly string[] = ['src/browser/', 'src/safety/', 'src/orchestration/'];
/** (b): `src/control/` から読み込まないファイル（拡張子なし）。`src/safety/` を間接に読み込む。 */
const FORBIDDEN_FILES: readonly string[] = ['src/config/validate-config'];

/** (b): リポジトリの根からのパスが、禁止の対象か。 */
const isForbiddenPath = (path: string): boolean =>
  isPathUnderAny(path, FORBIDDEN_DIRECTORIES) || FORBIDDEN_FILES.includes(withoutModuleExtension(path));

/**
 * (b): `text`（指定子かリテラル）が禁止の対象を指すか。Playwright のパッケージ（`playwright`、`playwright-core`、`@playwright/*` とその下の
 * パス、`@axe-core/playwright`。T22d、T22R の M3）の名前は、`source-scan.ts` の `PLAYWRIGHT_PACKAGE_PATTERN`（CCX-27）。指す先は、相対なら
 * 解決したパス、相対でなければ文字列の中の `src/` からのパス（`referencedPathsOf`。PRE42-CC 組 G で最も広い形にそろえた）。
 */
const pointsToForbidden = (fromPath: string, text: string): boolean =>
  PLAYWRIGHT_PACKAGE_PATTERN.test(text) || referencedPathsOf(fromPath, text).some(isForbiddenPath);

/** (b): 禁止の対象を指す参照（`<参照>` の形）。文字列リテラルは、相対パスと、`src/` のパスと、Playwright のパッケージの名前を数える。 */
const findForbiddenReferences = (path: string, source: ScannedSource): readonly string[] =>
  pathReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN]).filter((text) => pointsToForbidden(path, text));

/**
 * (b) の間接の検査: `starts` から、実行時に読み込む相対の import を、`source-scan.ts` の `findImportChains`（CCX-9）でたどり、
 * 禁止の対象のパッケージ（Playwright）を読み込む指定子か、禁止の対象のファイル（`.js` などは `.ts` に読み替えたパス。たどった先の
 * ファイルが禁止の対象でも同じ）に届いたら、`<始まり> -> … -> <先>` の形で返す。
 */
const findTransitiveForbidden = (
  files: ReadonlyMap<string, ScannedSource>,
  starts: readonly string[],
): readonly string[] => findTransitiveForbiddenReferences(files, starts, isForbiddenPath, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier));

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('Control boundary detectors', () => {
  it('(a) detects every form of reference to src/control/ from outside', () => {
    for (const [path, line] of [
      ['src/cli/main.ts', "import { validateSiteProfile } from '../control/profile-policy.js';"],
      ['src/cli/main.ts', "import type { SiteProfile } from '../control/contracts.js';"],
      ['src/cli/main.ts', "import { type SiteProfile } from '../control/contracts.js';"],
      ['src/index.ts', "export { AUDIT_MODES } from './control/contracts.js';"],
      ['src/index.ts', "export * from './control/contracts.js';"],
      ['src/index.ts', "import './control/contracts.js';"],
      ['src/cli/main.ts', "const policy = await import('../control/profile-policy.js');"],
      ['src/cli/main.ts', 'const policy = await import(`../control/${name}.js`);'],
      ['src/cli/main.ts', "const policy = require('../control/profile-policy.js');"],
      ['src/cli/main.ts', "const path = '../control/profile-policy.js'; const policy = await import(path);"],
      ['src/cli/main.ts', "import { AUDIT_MODES } from '../../src/control/contracts.js';"],
      ['src/cli/main.ts', "import { AUDIT_MODES } from '../control';"],
      ['src/cli/main.ts', "import { AUDIT_MODES } from 'beaksight/src/control/contracts.js';"],
    ] as const) {
      expect(findControlReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const [path, line] of [
      ['src/cli/main.ts', "// import { validateSiteProfile } from '../control/profile-policy.js';"],
      ['src/cli/main.ts', "/* const policy = await import('../control/profile-policy.js'); */"],
      ['src/browser/page.ts', "import { scroll } from './controlled-scroll.js';"],
      ['src/cli/main.ts', "import { scroll } from '../browser/controlled-scroll.js';"],
      ['src/cli/main.ts', "import { AUDIT_STATUSES } from '../core/contracts.js';"],
      ['src/cli/main.ts', 'const controller = new AbortController();'],
      ['src/cli/main.ts', "const label = 'control';"],
    ] as const) {
      expect(findControlReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  // T24d（Task 24 の設計書 4.3 の「Gate の例外」）: 監査のワーカーから、許すファイルへの相対の import だけを除く。
  it('(a) allows only the listed src/control/ files from src/worker/, and nothing from elsewhere', () => {
    for (const [path, line] of [
      ['src/worker/audit-worker.ts', "import { openControlDatabase } from '../control/store/control-database.js';"],
      ['src/worker/audit-worker.ts', "import { startAuditJob } from '../control/job/job-manager.js';"],
      ['src/worker/audit-worker.ts', "import { checkControlEnvironment } from '../control/environment/control-environment.js';"],
      ['src/worker/audit-worker.ts', "import { setupLocal } from '../control/setup-local.js';"],
      ['src/worker/audit-worker.ts', "const m = await import('../control/store/sqlite-module.js');"],
      ['src/worker/audit-worker.ts', "import { validateWorkerToParentMessage } from 'beaksight/src/control/worker-protocol.js';"],
      ['src/worker/nested/a.ts', "import { openControlDatabase } from '../../control/store/control-database.js';"],
      ['src/cli/main.ts', "import { validateWorkerToParentMessage } from '../control/worker-protocol.js';"],
      ['src/report/x.ts', "import { validateWorkerToParentMessage } from '../control/worker-protocol.js';"],
    ] as const) {
      expect(findControlReferences(path, scanSource(line)), `${path}: ${line}`).toHaveLength(1);
    }
    for (const [path, line] of [
      ['src/worker/audit-worker.ts', "import { validateWorkerToParentMessage } from '../control/worker-protocol.js';"],
      ['src/worker/audit-worker.ts', "import type { WorkerToParentMessage } from '../control/worker-protocol.js';"],
      ['src/worker/audit-worker.ts', "import { validateControlDocument } from '../control/control-schema-validator.js';"],
      ['src/worker/audit-worker.ts', "import type { SiteProfile } from '../control/contracts.js';"],
      ['src/worker/audit-worker.ts', "import { isAcceptedTargetConfigPath } from '../control/profile-policy.js';"],
      ['src/worker/nested/a.ts', "import { isAcceptedTargetConfigPath } from '../../control/profile-policy.js';"],
    ] as const) {
      expect(findControlReferences(path, scanSource(line)), `${path}: ${line}`).toHaveLength(0);
    }
  });

  it('(b) detects imports of Playwright and of the audit engine from src/control/', () => {
    const path = 'src/control/profile-policy.ts';
    for (const line of [
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { test } from '@playwright/test';",
      "import { chromium } from 'playwright/index.mjs';",
      "import { createContext } from '../browser/context-factory.js';",
      "import { classifyPassiveRequest } from '../safety/request-policy.js';",
      "import type { PassiveRequestDecision } from '../safety/request-policy.js';",
      "import { runAudit } from '../orchestration/run-coordinator.js';",
      "import { validateConfig } from '../config/validate-config.js';",
      "export { validateConfig } from '../config/validate-config.js';",
      "const policy = await import('../safety/request-policy.js');",
      'const factory = await import(`../browser/${name}.js`);',
      "const playwright = createRequire(import.meta.url)('playwright');",
      "const directory = '../orchestration/';",
      // T22d（T22R の M3）: Playwright に依存するパッケージ。
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import type { AxeBuilder } from '@axe-core/playwright';",
      "const axe = await import('@axe-core/playwright');",
      // PRE42-CC 組 G（新 Gate の 2）: 相対でない `src/` のパスの文字列リテラル（`\` の区切りを含む）も見る。
      "const entry = 'beaksight/src/safety/request-policy.js';",
      "const entry = 'src\\\\config\\\\validate-config.ts';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import type { AuditConfig } from '../config/types.js';",
      "import { deepFreeze } from '../core/immutable.js';",
      "import { createSchemaValidatorRegistry } from '../core/schema-validator.js';",
      "import { isLoopbackUrl } from '../crawl/normalize-url.js';",
      "import { AUDIT_MODES } from './contracts.js';",
      "import { readFileSync } from 'node:fs';",
      "// import { chromium } from 'playwright';",
      "const report = 'playwright-report';",
      "const note = 'Playwright を使わない';",
      "const schemaDirectory = '../../schemas/control/';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(b) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/control/a.ts', scanSource([
        "import { b } from '../core/b.js';",
        "import type { T } from '../config/types.js';",
        "export type { U } from '../core/u.js';",
      ].join('\n'))],
      ['src/core/b.ts', scanSource("import { c } from '../config/load-config.js';")],
      ['src/config/load-config.ts', scanSource("import { validateConfig } from './validate-config.js';")],
      ['src/config/types.ts', scanSource("import { chromium } from 'playwright';")],
      ['src/core/u.ts', scanSource("import { guard } from '../safety/guard.js';")],
      ['src/control/clean.ts', scanSource("import { b2 } from '../core/b2.js';\nimport type { T } from '../config/types.js';")],
      ['src/core/b2.ts', scanSource("import { readFileSync } from 'node:fs';\nimport { t } from './text.js';")],
      ['src/control/inline-type.ts', scanSource("import { type T } from '../config/types.js';")],
    ]);
    expect(findTransitiveForbidden(files, ['src/control/a.ts'])).toEqual([
      'src/control/a.ts -> src/core/b.ts -> src/config/load-config.ts -> src/config/validate-config.ts',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/clean.ts'])).toEqual([]);
    // `import { type T }` は、`verbatimModuleSyntax` の下では実行時の import として残るので、たどる。
    expect(findTransitiveForbidden(files, ['src/control/inline-type.ts'])).toEqual([
      'src/control/inline-type.ts -> src/config/types.ts -> playwright',
    ]);
  });

  // T22d（T22R の M3）: 途中のファイルの `createRequire(…)(…)` と、`createRequire(…)` を入れた変数の呼び出しの、文字列リテラルの指定子。
  // Playwright に依存するパッケージ（`@axe-core/playwright`）。
  it('(b) follows createRequire(...)(...) with a string literal, and stops at @axe-core/playwright', () => {
    const files = new Map<string, ScannedSource>([
      ['src/control/direct.ts', scanSource("import { b } from '../core/direct-b.js';")],
      ['src/core/direct-b.ts', scanSource("const guard = createRequire(import.meta.url)('../safety/guard.js');")],
      ['src/control/variable.ts', scanSource("import { b } from '../core/variable-b.js';")],
      ['src/core/variable-b.ts', scanSource([
        "import { createRequire } from 'node:module';",
        'const load = createRequire(import.meta.url);',
        "const guard = load('../safety/guard.js');",
      ].join('\n'))],
      ['src/control/namespace.ts', scanSource("import { b } from '../core/namespace-b.js';")],
      ['src/core/namespace-b.ts', scanSource([
        "import * as nodeModule from 'node:module';",
        "const direct = nodeModule.createRequire(import.meta.url)('../browser/direct.js');",
        'const load = nodeModule.createRequire(import.meta.url);',
        "const guard = load.resolve('../safety/guard.js');",
      ].join('\n'))],
      ['src/control/through.ts', scanSource("import { b } from '../core/through-b.js';")],
      ['src/core/through-b.ts', scanSource("const c = createRequire(import.meta.url)('../crawl/through-c.js');")],
      ['src/crawl/through-c.ts', scanSource("import { chromium } from 'playwright';")],
      ['src/control/axe.ts', scanSource("export * from '../core/axe-b.js';")],
      ['src/core/axe-b.ts', scanSource("import '../evidence/axe-c.js';")],
      ['src/evidence/axe-c.ts', scanSource("import { AxeBuilder } from '@axe-core/playwright';")],
      ['src/control/clean.ts', scanSource("import { b } from '../core/clean-b.js';")],
      ['src/core/clean-b.ts', scanSource([
        'const load = createRequire(import.meta.url);',
        'const manifest = load(MANIFEST_PATH);',
        "const label = 'createRequire(import.meta.url)(../safety/guard.js)';",
      ].join('\n'))],
    ]);
    expect(findTransitiveForbidden(files, ['src/control/direct.ts'])).toEqual([
      'src/control/direct.ts -> src/core/direct-b.ts -> src/safety/guard.ts',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/variable.ts'])).toEqual([
      'src/control/variable.ts -> src/core/variable-b.ts -> src/safety/guard.ts',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/namespace.ts'])).toEqual([
      'src/control/namespace.ts -> src/core/namespace-b.ts -> src/browser/direct.ts',
      'src/control/namespace.ts -> src/core/namespace-b.ts -> src/safety/guard.ts',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/through.ts'])).toEqual([
      'src/control/through.ts -> src/core/through-b.ts -> src/crawl/through-c.ts -> playwright',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/axe.ts'])).toEqual([
      'src/control/axe.ts -> src/core/axe-b.ts -> src/evidence/axe-c.ts -> @axe-core/playwright',
    ]);
    expect(findTransitiveForbidden(files, ['src/control/clean.ts'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

const isControlFile = (file: SourceFile): boolean => file.path.startsWith(CONTROL_DIRECTORY);
const CONTROL_FILES = SOURCE_FILES.filter(isControlFile);

describe('Control boundary (Task 22 design 4.5)', () => {
  it('reads the source files once, and src/control/ exists', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(CONTROL_FILES.length);
    expect(CONTROL_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([
      'src/control/contracts.ts',
      'src/control/control-schema-validator.ts',
      'src/control/profile-policy.ts',
    ]));
  });

  it('(a) no file in src/ outside src/control/ imports src/control/ (except the listed files from src/worker/)', () => {
    const violations = SOURCE_FILES
      .filter((file) => !isControlFile(file))
      .flatMap((file) => findControlReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(b) src/control/ does not import Playwright, src/browser/, src/safety/, src/orchestration/ or src/config/validate-config', () => {
    // 検出の関数が、実際のファイルの import を解決できていることの確かめ（許す import が見えている）。
    const policy = CONTROL_FILES.find((file) => file.path === 'src/control/profile-policy.ts');
    expect(policy).toBeDefined();
    const resolved = findModuleSpecifiers((policy ?? scanSource('')).code)
      .map((specifier) => resolveRelativeSpecifier('src/control/profile-policy.ts', specifier));
    expect(resolved).toEqual(expect.arrayContaining(['src/config/types.js', 'src/crawl/normalize-url.js']));

    const violations = CONTROL_FILES.flatMap((file) => findForbiddenReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(b) nothing that src/control/ loads at run time reaches Playwright or the forbidden audit engine modules', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveForbidden(files, CONTROL_FILES.map((file) => file.path))).toEqual([]);
  });
});
