/**
 * ローカルの管理画面（`apps/local-ui/`）の境界の Architecture Gate（Task 23 の設計書 4.2、4.4、7 章「Architecture Gate」。T23e）。
 * - (f) 画面のコード（`apps/local-ui/` の中の `tests/` 以外の `.ts`・`.tsx`）が import してよい `src/` の範囲は、`src/control/`、
 *   `src/presentation/`、`src/config/`、`src/core/` だけ（型だけの import を含む）。`playwright`（`playwright-core`、`@playwright/*`、
 *   `@axe-core/playwright` を含む）も import しない。
 * - (g) 画面のコードが実行時に読み込むものを（`apps/local-ui/` の中と `src/` の中の相対の import をたどって）間接にたどった先にも、
 *   Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`、`src/audit/`、`src/interaction/`、`src/evidence/`、
 *   `src/report/`、`src/cli/`）が現れない。型だけの import はたどらない（実行時に消えるため。`control-boundary.test.ts` と同じ扱い）。
 * - (g) の例外は `src/safety/interaction-policy.ts` の 1 ファイルだけ（Task 23 の設計書 11 章の最後の行。画面のサーバが設定の検証の結果を出すために
 *   `src/config/load-config.ts` を使うと、`validate-config.ts` を通して届く。`src/core` だけを import する純粋な決まりの一覧）。例外のファイルは
 *   違反として数えないが、その先は今までどおりたどり、禁止の範囲に届けば違反にする。`src/safety/` のほかのファイルは今のまま禁止。
 * - (h) 画面のコード（`apps/local-ui/` の中の `tests/` 以外）で `node:sqlite` を参照しない。`0.0.0.0`、`::`（`[::]`）の待ち受けのアドレスを書かない。
 *   T23h: `apps/local-ui/tests/` は (h) の対象から外した（(f)(g) と同じ）。テストは、これらの待ち受けのアドレスで起動しないこと、
 *   ほかのアドレスで受けた要求を拒否することを確かめるために、値として書く必要があるため。製品のコードは今までどおり対象にする。
 * - (i)（DEF-066。T26g-3）: ブラウザ側のコード（`apps/local-ui/src/` の中の `server/` の外）が値を import する `apps/local-ui/src/server/` の
 *   ファイルは、公開する関数を、Server Function（`createServerFn`）か `createServerOnlyFn` で包んだものだけにする（公開した普通の関数は
 *   ブラウザの組み立てで残り、その中で使うサーバの部品までブラウザに入って、読み込みで落ちうるため）。型と、関数でない値は公開してよい。
 *   例外は 2 つ: `auth-setup-errors.ts`（ブラウザと共用の純粋な関数。たどった先も含めて `node:` の部品を読み込まないことを確かめる）と、
 *   `artifact-files.ts` の成果物の Server Route の受け手（`routes/artifacts/$jobId/$.tsx` のサーバの受け手 `server: { … }` の中だけで使い、
 *   ほかのブラウザ側のコードは import しないことを確かめる）。import の文の解析と値の種類の判定は近似（`export { … }` の一覧は数える）。
 * - (j)（T28e。Task 28 の設計書 4.6）: 画面のコード（`apps/local-ui/` の中の `tests/` 以外）は、`src/control/approval/` を直接 import しない
 *   （型だけの import を含む）。画面が使う型と閉じた一覧と読み出し・書き込みの口は、`src/control/approval-view.ts` から読む。
 * - (k)（T29e。Task 29 の設計書 4.4）: 画面のコード（`apps/local-ui/` の中の `tests/` 以外）は、`src/control/data-rules/` を直接 import しない
 *   （型だけの import を含む）。画面が使う型と閉じた一覧と判定・生成・保存の口は、`src/control/data-rules-view.ts` から読む。
 * - `apps/local-ui/tests/` は (f)(g)(j)(k) の対象外: 画面のテストは Playwright の headless の Chromium を使うため（`tests/helpers/chromium.ts`）。
 *   テストは画面のサーバの process には読み込まれない。`dist/` と生成物の置き場所以外の、すべての `.ts`・`.tsx` を読む。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（AST・子 process を使わない。`source-scan.ts` の走査を共用する）。近似の検査である
 *   （指定子を実行時に組み立てる import は、相対パスの文字列リテラルの検出で補う）。
 * - CCX-9（台帳の CC-054、CC-056）: 指定子の取り出し（`findModuleSpecifiers`・`findRuntimeModuleSpecifiers`）、import のたどり
 *   （`findImportChains`）、相対の指定子の解決と拡張子の補い（`resolveRelativeSpecifier`・`resolveImportTarget`）、import の文の範囲
 *   （`findImportStatementRanges`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す正規表現は、このファイルに書かない）。
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_UI_APP_DIRECTORY,
  PLAYWRIGHT_PACKAGE_PATTERN,
  findImportChains,
  findImportStatementRanges,
  findModuleSpecifiers,
  findRuntimeModuleSpecifiers,
  isNodeBuiltinSpecifier,
  isPathUnder,
  isPathUnderAny,
  loadLocalUiAppFiles,
  loadSourceFiles,
  matchingBracket,
  modulePattern,
  pathReferenceCandidatesOf,
  referencedPathsOf,
  refersUnderAny,
  resolveImportTarget,
  resolveRelativeSpecifier,
  scanSource,
  unusedExclusionsOf,
  type ScannedSource,
} from './source-scan.js';

const APP_TESTS_DIRECTORY = `${LOCAL_UI_APP_DIRECTORY}tests/`;
/** `src/` の全体（(f) の判定で、`src/` の中を指す参照だけを見る）。 */
const SRC_DIRECTORY = 'src/';

/** (f): 画面のコードが import してよい `src/` の範囲。 */
const ALLOWED_SRC_DIRECTORIES: readonly string[] = ['src/control/', 'src/presentation/', 'src/config/', 'src/core/'];
/** (g): 間接にも読み込まない監査エンジンのフォルダ。 */
const FORBIDDEN_ENGINE_DIRECTORIES: readonly string[] = [
  'src/browser/', 'src/safety/', 'src/orchestration/', 'src/audit/', 'src/interaction/', 'src/evidence/', 'src/report/', 'src/cli/',
];
/** (g) の例外（たどった先で許す、ただ 1 つのファイル。拡張子は `.ts`）。 */
const TRANSITIVE_EXCEPTION_FILES: ReadonlySet<string> = new Set(['src/safety/interaction-policy.ts']);
/** `node:sqlite`（`source-scan.ts` の `modulePattern`。文字列の中の `node:sqlite` と、`node:` のない形、下位のパスも当てる。PRE42-CC 組 G）。 */
const NODE_SQLITE_PATTERN = modulePattern(['sqlite']);
/** すべてのアドレスで待ち受けるアドレスの文字列（`0.0.0.0`、`::`、`[::]`）。 */
const WILDCARD_ADDRESS_LITERALS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);
const WILDCARD_ADDRESS_IN_TEXT = /(?<![\w.:])0\.0\.0\.0(?![\w.])/u;

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/**
 * (f): 参照（指定子と、相対パス・`src/` のパスの文字列リテラル）の違反（`<参照>` の形）: Playwright の名前か、指す先（相対なら解決したパス、
 * 相対でなければ文字列の中の `src/` からのパスのすべて。`source-scan.ts` の `referencedPathsOf`。PRE42-CC 組 G）が、`src/` の中の許す範囲の外。
 */
const findDirectViolations = (path: string, source: ScannedSource): readonly string[] =>
  pathReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN]).filter((text) => PLAYWRIGHT_PACKAGE_PATTERN.test(text)
    || referencedPathsOf(path, text).some((target) => isPathUnder(target, SRC_DIRECTORY) && !isPathUnderAny(target, ALLOWED_SRC_DIRECTORIES)));

/**
 * (f) PRE42-CC 組 G（新 Gate の 2）で、相対でない `src/` のパスの文字列リテラルも見るようにして、新しく当たった所（`<ファイル>: <参照>`）。
 * 直さずに記録し、扱いは設計者が決める。画面の Vite の設定の module id（`/src/server/…`、`${APP_ROOT}src/server/…`）で、リポジトリの `src/`
 * ではなく `apps/local-ui/src/server/` を指すと見られる。使われなくなったら誤りにする。
 */
const NEWLY_FOUND_SOURCE_PATH_LITERALS: readonly string[] = Object.freeze([
  'apps/local-ui/vite.config.ts: /src/server/control-store.ts',
  'apps/local-ui/vite.config.ts: /src/server/audit-jobs.ts',
  'apps/local-ui/vite.config.ts: src/server/launcher-bridge.ts',
]);

/** (j): 画面が直接 import しない、承認の部品のフォルダ（T28e）。 */
const APPROVAL_INTERNAL_DIRECTORY = 'src/control/approval/';

/** (j): `src/control/approval/` を指す参照（指定子のすべて（型だけの import を含む）と、相対パス・`src/` のパスの文字列リテラル）。 */
const findApprovalInternalReferences = (path: string, source: ScannedSource): readonly string[] =>
  pathReferenceCandidatesOf(source).filter((text) => refersUnderAny(path, text, [APPROVAL_INTERNAL_DIRECTORY]));

/** (k): 画面が直接 import しない、入力の規則の部品のフォルダ（T29e）。 */
const DATA_RULES_INTERNAL_DIRECTORY = 'src/control/data-rules/';

/** (k): `src/control/data-rules/` を指す参照（指定子のすべて（型だけの import を含む）と、相対パス・`src/` のパスの文字列リテラル）。 */
const findDataRulesInternalReferences = (path: string, source: ScannedSource): readonly string[] =>
  pathReferenceCandidatesOf(source).filter((text) => refersUnderAny(path, text, [DATA_RULES_INTERNAL_DIRECTORY]));

/** (h): `node:sqlite` の参照と、すべてのアドレスの待ち受けのアドレスの文字列。 */
const findForbiddenLiterals = (source: ScannedSource): readonly string[] =>
  source.literals.filter((literal) => NODE_SQLITE_PATTERN.test(literal) || WILDCARD_ADDRESS_LITERALS.has(literal.trim())
    || WILDCARD_ADDRESS_IN_TEXT.test(literal));

/**
 * (g): `starts` から、実行時に読み込む相対の import を、`source-scan.ts` の `findImportChains`（CCX-9）でたどり、Playwright か監査エンジンに
 * 届いたら `<始まり> -> … -> <先>` の形で返す。`files` にないファイル（`node_modules` のパッケージなど）はたどらない。
 */
const findTransitiveViolations = (
  files: ReadonlyMap<string, ScannedSource>,
  starts: readonly string[],
  forbiddenDirectories: readonly string[] = FORBIDDEN_ENGINE_DIRECTORIES,
): readonly string[] => findImportChains(files, starts, ({ specifier, resolved, target }) => {
  if (PLAYWRIGHT_PACKAGE_PATTERN.test(specifier)) {
    return specifier;
  }
  if (resolved === null) {
    return undefined;
  }
  const allowedException = target !== undefined && TRANSITIVE_EXCEPTION_FILES.has(target);
  return isPathUnderAny(resolved, forbiddenDirectories) && !allowedException ? resolved : undefined;
});

// ---------------------------------------------------------------------------------------------------------------
// (i) 画面のサーバの関数のファイルの公開の形（DEF-066。T26g-3）
// ---------------------------------------------------------------------------------------------------------------

/** 画面のブラウザ側のコード（`apps/local-ui/src/` の中の、`server/` の外）と、画面のサーバのコード（`server/`）。 */
const APP_BROWSER_DIRECTORY = 'apps/local-ui/src/';
const APP_SERVER_DIRECTORY = 'apps/local-ui/src/server/';
/** (i) の例外 1: ブラウザと共用の純粋な関数（入力の誤りの項目の対応）。中で Node の部品を読み込まないこと（たどった先も）を確かめる。 */
const SHARED_PURE_SERVER_FILE = 'apps/local-ui/src/server/auth-setup-errors.ts';
/** (i) の例外 2: 成果物の Server Route の受け手。`routes/artifacts/$jobId/$.tsx` のサーバの受け手（`server: { … }`）の中だけで使う。 */
const ARTIFACT_FILES_PATH = 'apps/local-ui/src/server/artifact-files.ts';
const ARTIFACT_ROUTE_PATH = 'apps/local-ui/src/routes/artifacts/$jobId/$.tsx';
const ARTIFACT_ROUTE_HANDLERS: readonly string[] = ['rejectArtifactMethod', 'serveJobArtifact'];

/** 公開の宣言（`bare`。文字列の中身とコメントを除いた本文）。 */
const EXPORTED_FUNCTION_DECLARATION = /\bexport\s+(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([\w$]*)/gu;
const EXPORTED_VARIABLE = /\bexport\s+(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=\s*/gu;
const EXPORTED_LIST = /\bexport\s+(?!type\b)\{([^}]*)\}/gu;
/** Server Function と、サーバだけの関数（ブラウザの組み立てで中身が消える）。 */
const SERVER_ONLY_WRAPPER = /^(?:createServerFn|createServerOnlyFn)\s*[(<]/u;
/** 関数の値の書き出し（`async`、`function`、`(`・`<` で始まる arrow、`x =>`）。 */
const FUNCTION_VALUE_START = /^(?:async\b|function\b|\(|<|[\w$]+\s*=>)/u;

/**
 * (i): 公開する関数のうち、Server Function でも `createServerOnlyFn` で包んだものでもないものの名前（近似）。`export { … }` の一覧は、型（`type`）
 * のほかは、値の種類が分からないので数える（公開の一覧で関数を出すと、ブラウザの組み立てで残るため）。
 */
const findPlainFunctionExports = (source: ScannedSource): readonly string[] => [
  ...[...source.bare.matchAll(EXPORTED_FUNCTION_DECLARATION)].map((match) => match[1] || 'default'),
  ...[...source.bare.matchAll(EXPORTED_VARIABLE)]
    .filter((match) => {
      const value = source.bare.slice(match.index + match[0].length);
      return !SERVER_ONLY_WRAPPER.test(value) && FUNCTION_VALUE_START.test(value);
    })
    .map((match) => match[1] ?? ''),
  ...[...source.bare.matchAll(EXPORTED_LIST)].flatMap((match) => (match[1] ?? '').split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !/^type\s/u.test(entry))),
];

/** (i): ブラウザ側のコードが、値を import する `server/` のファイルと、その import 元（型だけの import は数えない）。 */
const findServerFilesImportedByBrowser = (
  files: ReadonlyMap<string, ScannedSource>,
  browserPaths: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const importers = new Map<string, string[]>();
  for (const path of browserPaths) {
    const source = files.get(path);
    for (const specifier of source === undefined ? [] : findRuntimeModuleSpecifiers(source.code)) {
      const target = resolveImportTarget(files, path, specifier);
      if (target !== undefined && target.startsWith(APP_SERVER_DIRECTORY)) {
        importers.set(target, [...(importers.get(target) ?? []), path]);
      }
    }
  }
  return importers;
};

/**
 * (i) の例外 1: `start` から実行時の相対の import をたどり、Node の部品（`node:` の付いた指定子と、付けない組み込みの名前。`source-scan.ts` の
 * `isNodeBuiltinSpecifier`。PRE42-CC 組 G）に届いた道（`<始まり> -> … -> <指定子>`）。
 */
const findNodeModuleChains = (files: ReadonlyMap<string, ScannedSource>, start: string): readonly string[] =>
  findImportChains(files, [start], ({ specifier }) => (isNodeBuiltinSpecifier(specifier) ? specifier : undefined));

const SERVER_BLOCK_START = /\bserver\s*:\s*\{/u;

/** (i) の例外 2: route の中で、`names` を、import の文とサーバの受け手（`server: { … }`）の外で使っている箇所（`<名前>@<位置>`）。 */
const findUsesOutsideServerHandlers = (route: ScannedSource, names: readonly string[]): readonly string[] => {
  const block = SERVER_BLOCK_START.exec(route.bare);
  const open = block === null ? -1 : block.index + block[0].length - 1;
  const close = open < 0 ? -1 : matchingBracket(route.bare, open);
  const imports = findImportStatementRanges(route.bare);
  return names.flatMap((name) => [...route.bare.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'gu'))]
    .map((match) => match.index)
    .filter((index) => !(open >= 0 && index > open && index < close) && !imports.some(([from, to]) => index >= from && index < to))
    .map((index) => `${name}@${index}`));
};

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

describe('Local UI boundary detectors', () => {
  it('(f) detects imports of src/ outside the allowed directories and of Playwright', () => {
    const path = 'apps/local-ui/src/routes/index.tsx';
    for (const line of [
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import { guard } from '../../../../src/safety/passive-request-guard.js';",
      "import type { Run } from '../../../../src/orchestration/run.js';",
      "import { crawl } from '../../../../src/crawl/normalize-url.js';",
      "export * from '../../../../src/report/html.js';",
      "const m = await import('../../../../src/cli/main.js');",
      'const m = await import(`../../../../src/browser/${name}.js`);',
      "const m = require('../../../../src/evidence/x.js');",
      "const dir = '../../../../src/interaction/';",
      "import { x } from 'beaksight/src/audit/x.js';",
      // PRE42-CC 組 G（新 Gate の 2）: 相対でない `src/` のパスの文字列リテラル（`\` の区切りを含む）も見る。
      "const entry = 'beaksight/src/safety/passive-request-guard.js';",
      "const entry = 'src\\\\browser\\\\context-factory.ts';",
    ]) {
      expect(findDirectViolations(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { formatDateTime } from '../../../../src/presentation/format.js';",
      "import type { SiteProfile } from '../../../../src/control/contracts.js';",
      "import { loadConfig } from '../../../../src/config/load-config.js';",
      "import { deepFreeze } from '../../../../src/core/immutable.js';",
      "import { echoServerFn } from '../server/echo';",
      "import { createServerFn } from '@tanstack/react-start';",
      "import { readFile } from 'node:fs/promises';",
      "// import { chromium } from 'playwright';",
      "const label = 'playwright を使わない';",
    ]) {
      expect(findDirectViolations(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(g) follows runtime imports through apps/local-ui and src/, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['apps/local-ui/src/routes/a.tsx', scanSource("import { b } from '../server/b';\nimport type { T } from '../../../../src/config/types.js';")],
      ['apps/local-ui/src/server/b.ts', scanSource("import { c } from '../../../../src/config/load-config.js';")],
      ['src/config/load-config.ts', scanSource("import { v } from './validate-config.js';")],
      ['src/config/validate-config.ts', scanSource("import { g } from '../safety/guard.js';")],
      ['src/config/types.ts', scanSource("import { chromium } from 'playwright';")],
      ['apps/local-ui/src/routes/clean.tsx', scanSource([
        "import { f } from '../../../../src/presentation/format.js';",
        "import type { T } from '../../../../src/config/types.js';",
      ].join('\n'))],
      ['src/presentation/format.ts', scanSource("import { m } from './messages.js';\nimport type { R } from '../core/contracts.js';")],
      ['src/presentation/messages.ts', scanSource("import { deepFreeze } from '../core/immutable.js';")],
      ['src/core/immutable.ts', scanSource('export const deepFreeze = 1;')],
      ['src/core/contracts.ts', scanSource("import { x } from '../browser/x.js';")],
      ['apps/local-ui/launcher/serve.ts', scanSource("import { g } from './request-guard.ts';")],
      ['apps/local-ui/launcher/request-guard.ts', scanSource("import { s } from '../../../src/report/x.js';")],
    ]);
    expect(findTransitiveViolations(files, ['apps/local-ui/src/routes/a.tsx'])).toEqual([
      'apps/local-ui/src/routes/a.tsx -> apps/local-ui/src/server/b.ts -> src/config/load-config.ts -> src/config/validate-config.ts -> src/safety/guard.js',
    ]);
    expect(findTransitiveViolations(files, ['apps/local-ui/src/routes/clean.tsx'])).toEqual([]);
    expect(findTransitiveViolations(files, ['apps/local-ui/launcher/serve.ts'])).toEqual([
      'apps/local-ui/launcher/serve.ts -> apps/local-ui/launcher/request-guard.ts -> src/report/x.js',
    ]);
  });

  it('(g) allows only src/safety/interaction-policy.ts on the way, and keeps following beyond it', () => {
    const files = new Map<string, ScannedSource>([
      ['apps/local-ui/src/server/a.ts', scanSource("import { c } from '../../../../src/config/load-config.js';")],
      ['src/config/load-config.ts', scanSource("import { v } from './validate-config.js';")],
      ['src/config/validate-config.ts', scanSource("import { p } from '../safety/interaction-policy.js';")],
      ['src/safety/interaction-policy.ts', scanSource("import { g } from '../core/guards.js';")],
      ['src/core/guards.ts', scanSource('export const g = 1;')],
      ['apps/local-ui/src/server/beyond.ts', scanSource("import { p } from '../../../../src/safety/interaction-policy.js';")],
      ['apps/local-ui/src/server/other.ts', scanSource("import { r } from '../../../../src/safety/request-policy.js';")],
      ['src/safety/request-policy.ts', scanSource('export const r = 1;')],
    ]);
    expect(findTransitiveViolations(files, ['apps/local-ui/src/server/a.ts'])).toEqual([]);
    expect(findTransitiveViolations(files, ['apps/local-ui/src/server/other.ts'])).toEqual([
      'apps/local-ui/src/server/other.ts -> src/safety/request-policy.js',
    ]);
    // 例外のファイルの先に禁止の範囲があれば、違反にする。
    const beyond = new Map(files);
    beyond.set('src/safety/interaction-policy.ts', scanSource("import { x } from '../browser/x.js';"));
    expect(findTransitiveViolations(beyond, ['apps/local-ui/src/server/beyond.ts'])).toEqual([
      'apps/local-ui/src/server/beyond.ts -> src/safety/interaction-policy.ts -> src/browser/x.js',
    ]);
  });

  it('(i) detects plain functions exported by a server file, and follows the browser imports and the exceptions (DEF-066)', () => {
    // 違反の例（DEF-066 で起きた形を含む）。
    expect(findPlainFunctionExports(scanSource([
      'export const localUiCredentialServiceDependencies = (): Deps => ({ store: localUiCredentialStore() });',
      'export async function readStore(): Promise<void> {}',
      'export function closeStore(): void {}',
      'export const load = async (path: string) => readFile(path);',
      'export const pick = <T>(value: T): T => value;',
      'export const single = value => value;',
      "export { helper, type HelperType } from './helper';",
    ].join('\n')))).toEqual(['readStore', 'closeStore', 'localUiCredentialServiceDependencies', 'load', 'pick', 'single', 'helper']);
    // 違反でない例（Server Function、サーバだけの関数、型、定数の値）。
    expect(findPlainFunctionExports(scanSource([
      "export const getThingFn = createServerFn({ method: 'GET' }).handler(() => null);",
      'export const deps = createServerOnlyFn((): Deps => ({ store: store() }));',
      'export type View = { readonly ok: boolean };',
      'export interface Request { readonly id: string }',
      "export const STATUS = Object.freeze(['A', 'B'] as const);",
      'export const LIMIT = 400;',
      "export type { View as OtherView } from './view';",
    ].join('\n')))).toEqual([]);

    const files = new Map<string, ScannedSource>([
      ['apps/local-ui/src/routes/a.tsx', scanSource([
        "import { getThingFn } from '../server/thing-functions';",
        "import type { View } from '../server/view-only';",
        "import { pure } from '../server/pure';",
      ].join('\n'))],
      ['apps/local-ui/src/server/thing-functions.ts', scanSource("import { store } from './store';")],
      ['apps/local-ui/src/server/view-only.ts', scanSource('export type View = string;')],
      ['apps/local-ui/src/server/pure.ts', scanSource("import { x } from '../../../../src/core/x.js';")],
      ['apps/local-ui/src/server/store.ts', scanSource("import { readFile } from 'node:fs/promises';")],
      ['src/core/x.ts', scanSource("import { constants } from 'node:fs';")],
    ]);
    expect([...findServerFilesImportedByBrowser(files, ['apps/local-ui/src/routes/a.tsx']).keys()])
      .toEqual(['apps/local-ui/src/server/thing-functions.ts', 'apps/local-ui/src/server/pure.ts']);
    // 例外 1 の確かめ: たどった先の Node の部品も見つける。
    expect(findNodeModuleChains(files, 'apps/local-ui/src/server/pure.ts'))
      .toEqual(['apps/local-ui/src/server/pure.ts -> src/core/x.ts -> node:fs']);
    expect(findNodeModuleChains(files, 'apps/local-ui/src/server/view-only.ts')).toEqual([]);
    // 例外 2 の確かめ: サーバの受け手の外で使えば見つける。
    const route = (body: string): ScannedSource => scanSource([
      "import { serveJobArtifact } from '../../../server/artifact-files';",
      `export const Route = createFileRoute('/x')({ ${body} });`,
    ].join('\n'));
    expect(findUsesOutsideServerHandlers(route('server: { handlers: { GET: ({ request }) => serveJobArtifact(request) } }'), ['serveJobArtifact']))
      .toEqual([]);
    expect(findUsesOutsideServerHandlers(route('loader: () => serveJobArtifact(request), server: { handlers: {} }'), ['serveJobArtifact']))
      .toHaveLength(1);
    expect(findUsesOutsideServerHandlers(route('component: () => serveJobArtifact'), ['serveJobArtifact'])).toHaveLength(1);
  });

  it('(j) detects direct imports of src/control/approval/ from the UI code, and allows the screen re-export (T28e)', () => {
    const path = 'apps/local-ui/src/server/scenario-functions.ts';
    for (const line of [
      "import { approveScenario } from '../../../../src/control/approval/scenario-store.js';",
      "import type { ScenarioRevision } from '../../../../src/control/approval/scenario-contracts.js';",
      "export { computeApprovalDigest } from '../../../../src/control/approval/approval-digest.js';",
      "const m = await import('../../../../src/control/approval/approval-validity.js');",
      "const directory = '../../../../src/control/approval/';",
      // PRE42-CC 組 G（新 Gate の 2）: 相対でない `src/` のパスの文字列リテラルも見る。
      "const entry = 'beaksight/src/control/approval/scenario-store.js';",
    ]) {
      expect(findApprovalInternalReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { approveScenario, type ScenarioView } from '../../../../src/control/approval-view.js';",
      "import { usesDiscovery } from '../display/labels';",
      "// import { approveScenario } from '../../../../src/control/approval/scenario-store.js';",
      "const label = 'src/control/approval の部品は使わない';",
    ]) {
      expect(findApprovalInternalReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(h) detects node:sqlite and wildcard listen addresses', () => {
    for (const line of [
      "import { DatabaseSync } from 'node:sqlite';",
      "import type { DatabaseSync } from 'node:sqlite';",
      "const sqlite = process.getBuiltinModule('node:sqlite');",
      "server.listen({ host: '0.0.0.0', port });",
      "server.listen({ host: '::', port });",
      "server.listen(port, '[::]');",
      'const url = `http://0.0.0.0:${port}/`;',
    ]) {
      expect(findForbiddenLiterals(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "server.listen({ host: '127.0.0.1', port });",
      "const loopback = '::1';",
      "const time = '10.0.0.01';",
      "// server.listen({ host: '0.0.0.0' });",
      "const label = 'SQLite を使わない';",
      "const sqliteModule = 'node:sqlite-extra';",
    ]) {
      expect(findForbiddenLiterals(scanSource(line)), line).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

/** `apps/local-ui/` の TypeScript を、1 回だけ列挙して読み込み、走査する（`dist/` と `node_modules/` を除く。`source-scan.ts` の `loadLocalUiAppFiles`）。 */
const APP_FILES = loadLocalUiAppFiles();
const APP_CODE_FILES = APP_FILES.filter((file) => !file.path.startsWith(APP_TESTS_DIRECTORY));
const SOURCE_FILES = loadSourceFiles();

describe('Local UI boundary (Task 23 design 4.2, 4.4)', () => {
  it('reads apps/local-ui/ once, including the launcher, the routes and the tests', () => {
    expect(APP_CODE_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([
      'apps/local-ui/launcher/serve.ts',
      'apps/local-ui/launcher/request-guard.ts',
      'apps/local-ui/src/routes/index.tsx',
      'apps/local-ui/src/start.ts',
      'apps/local-ui/vite.config.ts',
    ]));
    expect(APP_FILES.length).toBeGreaterThan(APP_CODE_FILES.length);
    expect(APP_FILES.some((file) => file.path.startsWith('apps/local-ui/dist/'))).toBe(false);
  });

  it('(f) the UI code imports only src/control, src/presentation, src/config and src/core, and never Playwright', () => {
    // 検出の関数が、実際の import を解決できていることの確かめ（許す import が見えている）。
    const index = APP_CODE_FILES.find((file) => file.path === 'apps/local-ui/src/routes/index.tsx');
    expect(findModuleSpecifiers((index ?? scanSource('')).code).map((specifier) => resolveRelativeSpecifier('apps/local-ui/src/routes/index.tsx', specifier)))
      .toContain('src/presentation/format.js');
    const violations = APP_CODE_FILES.flatMap((file) => findDirectViolations(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations.filter((violation) => !NEWLY_FOUND_SOURCE_PATH_LITERALS.includes(violation))).toEqual([]);
    expect(unusedExclusionsOf(NEWLY_FOUND_SOURCE_PATH_LITERALS, violations), 'exclusions that are no longer used').toEqual([]);
  });

  it('(g) nothing the UI code loads at run time reaches Playwright or the audit engine', () => {
    const files = new Map<string, ScannedSource>([...SOURCE_FILES.map((file) => [file.path, file] as const), ...APP_FILES.map((file) => [file.path, file] as const)]);
    expect(findTransitiveViolations(files, APP_CODE_FILES.map((file) => file.path))).toEqual([]);
    // 例外のファイルから先に、禁止の範囲がない（例外のファイルを始まりにしてたどる）。
    expect(findTransitiveViolations(files, [...TRANSITIVE_EXCEPTION_FILES])).toEqual([]);
    expect([...TRANSITIVE_EXCEPTION_FILES].every((path) => files.has(path))).toBe(true);
    // たどり方が実際のファイルで働いていることの確かめ（画面 → src/presentation → src/core/immutable まで届く）。
    // T23f: 画面が import するものが増えたので、届いた道のどれかが src/presentation を通って src/core/immutable に届くことを確かめる。
    const reached = findTransitiveViolations(files, ['apps/local-ui/src/routes/index.tsx'], ['src/core/']);
    expect(reached.some((chain) => chain.startsWith('apps/local-ui/src/routes/index.tsx -> ')
      && chain.includes(' -> src/presentation/') && chain.endsWith(' -> src/core/immutable.js'))).toBe(true);
  });

  it('(k) detects direct imports of src/control/data-rules/ from the UI code, and allows the screen re-export (T29e)', () => {
    const path = 'apps/local-ui/src/server/data-rule-functions.ts';
    for (const line of [
      "import { saveRuleSetAndAttach } from '../../../../src/control/data-rules/rule-store.js';",
      "import type { FieldRule } from '../../../../src/control/data-rules/rule-contracts.js';",
      "export { evaluateRuleSet } from '../../../../src/control/data-rules/field-evaluation.js';",
      "const m = await import('../../../../src/control/data-rules/scenario-data.js');",
      "const directory = '../../../../src/control/data-rules/';",
    ]) {
      expect(findDataRulesInternalReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { saveRuleSetAndAttach, type FieldRule } from '../../../../src/control/data-rules-view.js';",
      "// import { saveRuleSetAndAttach } from '../../../../src/control/data-rules/rule-store.js';",
      "const label = 'src/control/data-rules の部品は使わない';",
    ]) {
      expect(findDataRulesInternalReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(k) the UI code imports the data rule parts only through src/control/data-rules-view.ts (T29e)', () => {
    // 読み方が実際のファイルで働いていることの確かめ（画面が公開し直しを読んでいる）。
    expect(APP_CODE_FILES.some((file) => findModuleSpecifiers(file.code)
      .some((specifier) => resolveRelativeSpecifier(file.path, specifier) === 'src/control/data-rules-view.js'))).toBe(true);
    const violations = APP_CODE_FILES.flatMap((file) => findDataRulesInternalReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(j) the UI code imports the approval parts only through src/control/approval-view.ts (T28e)', () => {
    // 読み方が実際のファイルで働いていることの確かめ（画面が公開し直しを読んでいる）。
    expect(APP_CODE_FILES.some((file) => findModuleSpecifiers(file.code)
      .some((specifier) => resolveRelativeSpecifier(file.path, specifier) === 'src/control/approval-view.js'))).toBe(true);
    const violations = APP_CODE_FILES.flatMap((file) => findApprovalInternalReferences(file.path, file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(h) the UI code (not the tests) never refers to node:sqlite or a wildcard listen address', () => {
    const violations = APP_CODE_FILES.flatMap((file) => findForbiddenLiterals(file).map((text) => `${file.path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it('(i) the server files imported by the browser code export only Server Functions and server-only functions (DEF-066)', () => {
    const files = new Map<string, ScannedSource>([...SOURCE_FILES.map((file) => [file.path, file] as const), ...APP_FILES.map((file) => [file.path, file] as const)]);
    const browserPaths = APP_CODE_FILES.map((file) => file.path)
      .filter((path) => path.startsWith(APP_BROWSER_DIRECTORY) && !path.startsWith(APP_SERVER_DIRECTORY));
    const imported = findServerFilesImportedByBrowser(files, browserPaths);
    // たどり方が実際のファイルで働いていることと、例外が古くなっていないことの確かめ。
    expect([...imported.keys()]).toEqual(expect.arrayContaining([
      'apps/local-ui/src/server/profile-functions.ts',
      'apps/local-ui/src/server/credential-functions.ts',
      SHARED_PURE_SERVER_FILE,
      ARTIFACT_FILES_PATH,
    ]));
    const violations = [...imported.keys()]
      .filter((path) => path !== SHARED_PURE_SERVER_FILE)
      .flatMap((path) => findPlainFunctionExports(files.get(path) ?? scanSource(''))
        .filter((name) => !(path === ARTIFACT_FILES_PATH && ARTIFACT_ROUTE_HANDLERS.includes(name)))
        .map((name) => `${path}: ${name}`));
    expect(violations).toEqual([]);
    // 例外 1: ブラウザと共用の純粋な関数のファイルは、たどった先も含めて Node の部品を読み込まない。
    expect(findNodeModuleChains(files, SHARED_PURE_SERVER_FILE)).toEqual([]);
    // 例外 2: 成果物の受け手は、成果物の route のサーバの受け手の中だけで使う（ほかのブラウザ側のコードは import しない）。
    expect(imported.get(ARTIFACT_FILES_PATH)).toEqual([ARTIFACT_ROUTE_PATH]);
    expect(findPlainFunctionExports(files.get(ARTIFACT_FILES_PATH) ?? scanSource(''))).toEqual(expect.arrayContaining([...ARTIFACT_ROUTE_HANDLERS]));
    expect(findUsesOutsideServerHandlers(files.get(ARTIFACT_ROUTE_PATH) ?? scanSource(''), ARTIFACT_ROUTE_HANDLERS)).toEqual([]);
  });
});
