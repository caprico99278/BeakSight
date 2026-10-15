/**
 * CCX-2（CC-035、CC-042、CC-055 の前半、CC-067 の前半）: Guard の周りの共通化が戻らないための Architecture Gate。判定は `fs`、正規表現、
 * 文字列の走査だけ（`source-scan.ts` を共用する）。近似の検査である（実行時に組み立てた指定子・文字列は検出できない）。
 * - (a) `src/safety/` は `src/audit/` を import しない（HTTP の status の範囲は `src/core/http-status.ts` から取る。CC-042）。
 * - (b) `Number.MAX_SAFE_INTEGER` で止める件数の足し算（飽和の加算）と、`saturating…` の名前の関数の定義は、`src/core/saturating-count.ts`
 *   だけに書く（CC-055、CC-067）。
 * - (c) `net::ERR_` を含む文字列リテラル（Chromium のネットワークの失敗の理由）は、Playwright の失敗の一覧（`src/browser/playwright-errors.ts`）
 *   と、ネットワークの失敗の分類の owner（`src/safety/network-layer-failure.ts`）だけに書く（CC-035）。既存の正当な使い方は、
 *   ファイルと文字列の組で、理由を付けて除外する（同じファイルでも、新しい文字列は検出する）。コメントは数えない。
 * - (d) CCX-15（CC-064）: 認証の設定の送信先への POST かの判定（`isLoginEndpointPost`）と、それが使う定数（`LOGIN_POST_METHOD`、
 *   `ONE_REMAINING_POST`）の定義（`const …`・`let …`・`var …`・`function …`）は、要求の判定の owner（`src/safety/request-policy.ts`）だけに書く。
 *   ログインの段の部品（`src/worker/login-stage-checks.ts`、`src/worker/automated-login.ts`）は、owner から import する。
 * - `src/**` の読み込みと走査は、このファイルの読み込み時に 1 回だけ。ファイル全体を 1 秒以内に終える。
 * - CCX-9（台帳の CC-054）: 指定子の取り出し（`findModuleSpecifiers`。(a)）、名前つきの import の一覧（`findNamedImports`。(d)）、相対の
 *   指定子の解決（`resolveRelativeSpecifier`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す正規表現は、このファイルに書かない）。
 */
import { describe, expect, it } from 'vitest';
import {
  findModuleSpecifiers,
  findNamedImports,
  loadSourceFiles,
  resolveRelativeSpecifier,
  scanSource,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const SAFETY_DIRECTORY = 'src/safety/';
const AUDIT_DIRECTORY = 'src/audit/';
const SATURATING_COUNT_OWNER = 'src/core/saturating-count.ts';
const NET_ERROR_TEXT_OWNERS: ReadonlySet<string> = new Set([
  'src/browser/playwright-errors.ts',
  'src/safety/network-layer-failure.ts',
]);

/** (c) の除外（`<ファイル>: <文字列>` と理由）。除外の一覧は、このファイルの中の 1 か所だけ。 */
const NET_ERROR_TEXT_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    'src/safety/passive-request-guard.ts: net::ERR_ABORTED',
    'Guard の `NAVIGATION_ABORTED_ERROR_TEXT`（ブラウザが文書の要求を取り消したときの理由）の、Guard の中のただ 1 つの定義。'
      + 'ネットワークの層の失敗の分類ではない（分類の一覧は、この理由を意図して載せない）',
  ],
  ...[
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_NETWORK_CHANGED',
  ].map((text): [string, string] => [
    `src/orchestration/run-coordinator.ts: ${text}`,
    'Run Coordinator の再試行の方針（`RETRYABLE_NAVIGATION_FAILURE_DETAILS`）。どの失敗を再試行するかは Run Coordinator が決める',
  ]),
]);

/** (a) `src/audit/` を指す指定子（import・`export … from`・動的 import・`require` など。`findModuleSpecifiers`）。 */
const findAuditImports = (filePath: string, source: ScannedSource): readonly string[] =>
  findModuleSpecifiers(source.code).filter((specifier) =>
    (resolveRelativeSpecifier(filePath, specifier) ?? '').startsWith(AUDIT_DIRECTORY));

/**
 * (b) 飽和の加算と、その定義にあたる式（`bare`。コメントと文字列の中を除く）。
 * - `Math.min(… + …, Number.MAX_SAFE_INTEGER)` の形
 * - `… MAX_SAFE_INTEGER ? … + …` の形（`value < Number.MAX_SAFE_INTEGER ? value + 1 : value` など）
 * - `saturating…` の名前の関数の定義（`function saturating…`、`const saturating… =`）
 */
const SATURATING_ADDITION_PATTERNS: readonly RegExp[] = [
  /\bMath\s*\.\s*min\s*\([^;()]*\+[^;()]*\bMAX_SAFE_INTEGER\b/gu,
  /\bMath\s*\.\s*min\s*\([^;()]*\bMAX_SAFE_INTEGER\b[^;()]*\+/gu,
  /\bMAX_SAFE_INTEGER\b\s*\?[^;]*\+/gu,
  /\bfunction\s+saturating\w*/giu,
  /\b(?:const|let|var)\s+saturating\w*\s*=/giu,
];
const findSaturatingAdditions = (source: ScannedSource): readonly string[] =>
  SATURATING_ADDITION_PATTERNS.flatMap((pattern) => [...source.bare.matchAll(pattern)].map((match) => match[0].replace(/\s+/gu, ' ').trim()));

/** (c) `net::ERR_` を含む文字列リテラル（テンプレートは固定の部分ごと）。 */
const NET_ERROR_TEXT = /net::ERR_/u;
const findNetErrorTexts = (source: ScannedSource): readonly string[] => source.literals.filter((literal) => NET_ERROR_TEXT.test(literal));

/** (d) 送信先の判定の owner と、owner から import するログインの段の部品。 */
const LOGIN_ENDPOINT_OWNER = 'src/safety/request-policy.ts';
/** (d) owner から import するログインの段の部品と、import する名前。 */
const LOGIN_ENDPOINT_USERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['src/worker/login-stage-checks.ts', ['isLoginEndpointPost', 'LOGIN_POST_METHOD']],
  ['src/worker/automated-login.ts', ['isLoginEndpointPost', 'LOGIN_POST_METHOD']],
]);
/** (d) owner からの、名前つきの import の一覧（`{ … }` の中身。`findNamedImports`）。 */
const LOGIN_ENDPOINT_OWNER_SPECIFIER = '../safety/request-policy.js';
const namesImportedFromOwner = (code: string): readonly string[] => findNamedImports(code)
  .filter(({ specifier }) => specifier === LOGIN_ENDPOINT_OWNER_SPECIFIER)
  .flatMap(({ names }) => names);
/** (d) owner だけが定義する名前。 */
const LOGIN_ENDPOINT_OWNED_NAMES: readonly string[] = ['isLoginEndpointPost', 'LOGIN_POST_METHOD', 'ONE_REMAINING_POST'];
const LOGIN_ENDPOINT_DEFINITION = new RegExp(
  `\\b(?:(?:const|let|var)\\s+(?:${LOGIN_ENDPOINT_OWNED_NAMES.join('|')})\\s*[=:]|function\\s*\\*?\\s*(?:${LOGIN_ENDPOINT_OWNED_NAMES.join('|')})\\b)`,
  'gu',
);
/** (d) 送信先の判定と、その定数の定義（`bare`。コメントと文字列の中を除く）。 */
const findLoginEndpointDefinitions = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(LOGIN_ENDPOINT_DEFINITION)].map((match) => match[0].replace(/\s+/gu, ' ').trim());

const violationsOf = (
  files: readonly SourceFile[],
  find: (file: SourceFile) => readonly string[],
): readonly string[] => files.flatMap((file) => find(file).map((match) => `${file.path}: ${match}`));

const sample = (path: string, content: string): SourceFile => ({ path, content, ...scanSource(content) });

describe('CCX-2 detectors', () => {
  it('(a) detects imports of src/audit/ from src/safety/, and ignores other imports and comments', () => {
    const file = sample('src/safety/sample.ts', [
      "import { ERROR_HTTP_STATUS_RANGE } from '../audit/rule-helpers.js';",
      "export { isHttpStatusInRange } from '../audit/rule-helpers.js';",
      "const lazy = await import('../audit/rules.js');",
      "import { isHttpStatusInRange } from '../core/http-status.js';",
      "import { audit } from './audit.js';",
      "// import { x } from '../audit/rule-helpers.js';",
    ].join('\n'));

    expect(findAuditImports(file.path, file)).toEqual(['../audit/rule-helpers.js', '../audit/rule-helpers.js', '../audit/rules.js']);
  });

  it('(b) detects saturating additions with MAX_SAFE_INTEGER and saturating function definitions', () => {
    const file = sample('src/safety/sample.ts', [
      'const a = Math.min(count + 1, Number.MAX_SAFE_INTEGER);',
      'const b = Math.min(Number.MAX_SAFE_INTEGER, count + increment);',
      'const c = value < Number.MAX_SAFE_INTEGER ? value + 1 : value;',
      'function saturatingIncrement(count: number): number { return count; }',
      'const saturatingCount = (value: number): number => value;',
      'const message = safeErrorMessage(error, Number.MAX_SAFE_INTEGER);',
      'const d = saturatingIncrement(count);',
      '// Math.min(count + 1, Number.MAX_SAFE_INTEGER)',
    ].join('\n'));

    expect(findSaturatingAdditions(file)).toEqual([
      'Math.min(count + 1, Number.MAX_SAFE_INTEGER',
      'Math.min(Number.MAX_SAFE_INTEGER, count +',
      'MAX_SAFE_INTEGER ? value +',
      'function saturatingIncrement',
      'const saturatingCount =',
    ]);
  });

  it('(c) detects string literals with net::ERR_, and ignores comments and regular expressions', () => {
    const file = sample('src/safety/sample.ts', [
      "const blocked = 'net::ERR_BLOCKED_BY_CLIENT';",
      'const aborted = "net::ERR_ABORTED";',
      'const detail = `FAILED:net::ERR_FAILED:${code}`;',
      '// `net::ERR_ABORTED` in a comment',
      '/** `net::ERR_BLOCKED_BY_CLIENT` in a document comment */',
      'const pattern = /\\bnet::ERR_[A-Z0-9]+/u;',
    ].join('\n'));

    expect(findNetErrorTexts(file)).toEqual(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_ABORTED', 'FAILED:net::ERR_FAILED:']);
  });

  it('(d) detects definitions of the login endpoint check and its constants, and ignores uses and comments (CCX-15)', () => {
    const file = sample('src/worker/sample.ts', [
      'export const isLoginEndpointPost = (url: string): boolean => true;',
      'export function isLoginEndpointPost(url: string): boolean { return true; }',
      'const isLoginEndpointPost: (url: string) => boolean = check;',
      "export const LOGIN_POST_METHOD = 'POST';",
      'const ONE_REMAINING_POST = 1;',
      "import { isLoginEndpointPost, LOGIN_POST_METHOD } from '../safety/request-policy.js';",
      'const ok = isLoginEndpointPost(url, origins, endpoints);',
      'const same = method === LOGIN_POST_METHOD;',
      '// const isLoginEndpointPost = () => true;',
      "const label = 'const ONE_REMAINING_POST = 1';",
    ].join('\n'));

    expect(findLoginEndpointDefinitions(file)).toEqual([
      'const isLoginEndpointPost =',
      'function isLoginEndpointPost',
      'const isLoginEndpointPost:',
      'const LOGIN_POST_METHOD =',
      'const ONE_REMAINING_POST =',
    ]);
    expect(namesImportedFromOwner(file.code)).toEqual(['isLoginEndpointPost', 'LOGIN_POST_METHOD']);
    expect(namesImportedFromOwner(scanSource([
      "import { canonicalPassiveAllowedOrigins } from '../safety/request-policy.js';",
      "import { isLoginEndpointPost, LOGIN_POST_METHOD } from './login-stage-checks.js';",
    ].join('\n')).code)).toEqual(['canonicalPassiveAllowedOrigins']);
  });
});

describe('CCX-2 Gate: Guard commonization', () => {
  it('reads the source files once', () => {
    expect(SOURCE_FILES.some((file) => file.path === SATURATING_COUNT_OWNER)).toBe(true);
  });

  it('(a) src/safety/ does not import src/audit/', () => {
    const safetyFiles = SOURCE_FILES.filter((file) => file.path.startsWith(SAFETY_DIRECTORY));
    expect(violationsOf(safetyFiles, (file) => findAuditImports(file.path, file))).toEqual([]);
  });

  it('(b) saturating additions with MAX_SAFE_INTEGER are defined only in src/core/saturating-count.ts', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== SATURATING_COUNT_OWNER);
    const owner = SOURCE_FILES.find((file) => file.path === SATURATING_COUNT_OWNER);

    expect(violationsOf(others, findSaturatingAdditions)).toEqual([]);
    expect(owner === undefined ? [] : findSaturatingAdditions(owner)).not.toEqual([]);
  });

  it('(c) net::ERR_ string literals are written only in the Playwright error list and the network failure classification', () => {
    const others = SOURCE_FILES.filter((file) => !NET_ERROR_TEXT_OWNERS.has(file.path));
    const found = violationsOf(others, findNetErrorTexts);

    expect(found.filter((entry) => !NET_ERROR_TEXT_EXCLUSIONS.has(entry))).toEqual([]);
  });

  it('(c) every exclusion is still used, so that stale exclusions do not hide new texts', () => {
    const others = SOURCE_FILES.filter((file) => !NET_ERROR_TEXT_OWNERS.has(file.path));
    const found = new Set(violationsOf(others, findNetErrorTexts));

    expect([...NET_ERROR_TEXT_EXCLUSIONS.keys()].filter((entry) => !found.has(entry))).toEqual([]);
  });

  it('(d) the login endpoint check and its constants are defined only in src/safety/request-policy.ts (CCX-15)', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== LOGIN_ENDPOINT_OWNER);
    const owner = SOURCE_FILES.find((file) => file.path === LOGIN_ENDPOINT_OWNER);

    expect(violationsOf(others, findLoginEndpointDefinitions)).toEqual([]);
    expect(owner === undefined ? [] : findLoginEndpointDefinitions(owner)).toEqual([
      'const LOGIN_POST_METHOD =',
      'const ONE_REMAINING_POST =',
      'const isLoginEndpointPost =',
    ]);
  });

  it('(d) the login stage parts import the login endpoint check from the owner (CCX-15)', () => {
    for (const [path, names] of LOGIN_ENDPOINT_USERS) {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      expect(file, path).toBeDefined();
      expect(namesImportedFromOwner(file?.code ?? ''), path).toEqual(expect.arrayContaining([...names]));
    }
  });
});
