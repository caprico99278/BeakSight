/**
 * 安全のテストの補助の Gate（PRE42-CC の組 S2。台帳の CC-041・CC-098・CC-067 の後半）。判定は `fs`、正規表現、文字列の検索だけ
 * （`source-scan.ts` の `readTypeScriptFilesUnder`・`scanFile` を共用する）。近似の検査である（実行時に組み立てた名前や文字列は検出できない）。
 * - 見る所: 結合のテスト（`tests/integration/**`）、部品のテスト（`tests/component/**`）、単体のテスト（`tests/unit/**`）、テストの補助
 *   （`tests/helpers/**`）、画面のテスト（`apps/local-ui/tests/**`）。(c) は単体のテストを見ない（方針の表を独立に書き下すため）。
 * - (a) CC-041: 何も待ち受けていない 127.0.0.1 のポート（閉じたポート）は、`tests/helpers/loopback-server.ts` の `closedLoopbackOrigin` で作る。
 *   ほかのファイルは、閉じたポートを作る補助を定義しない（名前が `closed`・`unused`・`free`・`unreachable` で始まり `Port`・`Origin` で終わる
 *   関数の定義）。サーバを閉じてそのポートを返す形（`.close(() => resolve(port))`）も数える。
 * - (b) CC-098: 初期化のスクリプトを 1 つだけ捨てる Browser の Proxy（`browserWithoutInitScript`）を呼ぶのは、テストの補助
 *   （`tests/helpers/browser-proxies.ts` の `browserWithoutWebRtcBlock`、`tests/helpers/chromium.ts` の
 *   `browserWithoutServiceWorkerRegistrationBlock`）だけ。テストは、その補助を import して使う（同じ Proxy の写しを止める）。
 * - (c) CC-067 の後半: ブラウザ自身の favicon の path（`/favicon.ico`）は、製品の `BROWSER_DEFAULT_FAVICON_PATH`
 *   （`src/safety/request-policy.ts`。テストは `tests/helpers/chromium.ts` から読める）を使う。テストとテストの補助に、ちょうど `/favicon.ico` の
 *   文字列リテラル（テンプレートは固定の部分ごと）を書かない。コメントと、ほかの文字を含む文字列（URL など）は数えない。
 * - 除外は閉じた一覧（理由つき）。使われなくなった除外も誤りにする。
 * - 1 ファイル 1 秒以内に終える。本文の文字列で絞ってから走査する（走査は文字ずつで重いため。DEF-107）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  TEST_SOURCE_DIRECTORIES,
  judgeWithFileExceptions,
  readLfTypeScriptFilesUnder,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  type SourceFile,
  type UnscannedFile,
} from './source-scan.js';

const CLOSED_PORT_OWNER = 'tests/helpers/loopback-server.ts';
const INIT_SCRIPT_PROXY_OWNERS: ReadonlySet<string> = new Set(['tests/helpers/browser-proxies.ts', 'tests/helpers/chromium.ts']);
const BROWSER_FAVICON_PATH_TEXT = '/favicon.ico';
const UNIT_TESTS_DIRECTORY = 'tests/unit/';

/** 見るファイル（読み込みは 1 回だけ。改行は LF にそろえる。`source-scan.ts` の `readLfTypeScriptFilesUnder`）。 */
const FILES: readonly UnscannedFile[] = readLfTypeScriptFilesUnder(TEST_SOURCE_DIRECTORIES);

/** 当たった本文を 1 行にそろえる。 */
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

// ---------------------------------------------------------------------------------------------------------------
// (a) 閉じたポート（CC-041）
// ---------------------------------------------------------------------------------------------------------------

/** 閉じたポートを作る形（名前と形。`bare`: コメントと文字列の中を除いた本文に当てる）。 */
const CLOSED_PORT_SHAPES: readonly (readonly [string, RegExp])[] = Object.freeze([
  [
    'closed port helper',
    /\b(?:function\s*\*?\s*(?:closed|unused|free|unreachable)[\w$]*(?:Port|Origin)\s*\(|(?:const|let|var)\s+(?:closed|unused|free|unreachable)[\w$]*(?:Port|Origin)\s*(?::(?:[^=;]|=>)*?)?=\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>))/gu,
  ],
  ['close and resolve the port', /\.\s*close\s*\(\s*\(\s*\)\s*=>\s*[\w$]+\s*\(\s*port\s*\)\s*\)/gu],
]);

/** (a) の除外（ファイル → 理由）。寄せたら消す。 */
const CLOSED_PORT_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'apps/local-ui/tests/helpers/local-server.ts':
    '画面のテストの補助の `findFreePort`（起動する子の process に渡す空きの port。作りは `closedLoopbackOrigin` と同じ。組 S2 の範囲の外。寄せる組が消す）',
});

const closedPortShapesOf = (file: Pick<SourceFile, 'bare'>): readonly string[] =>
  CLOSED_PORT_SHAPES.flatMap(([name, shape]) => [...file.bare.matchAll(shape)].map((match) => `${name}: ${oneLine(match[0])}`));

/** 閉じたポートの形の文字列を含むファイル（絞ってから走査する）。 */
const filesWithClosedPortText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => path !== CLOSED_PORT_OWNER && /\.close\s*\(|(?:closed|unused|free|unreachable)[\w$]*(?:Port|Origin)/u.test(content))
  .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (b) 初期化のスクリプトを捨てる Browser の Proxy（CC-098）
// ---------------------------------------------------------------------------------------------------------------

const INIT_SCRIPT_PROXY_CALL = /(?<![.\w$])browserWithoutInitScript\s*\(/gu;

const initScriptProxyCallsOf = (file: Pick<SourceFile, 'bare'>): readonly string[] =>
  [...file.bare.matchAll(INIT_SCRIPT_PROXY_CALL)].map((match) => oneLine(match[0]));

const filesWithInitScriptProxyText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => !INIT_SCRIPT_PROXY_OWNERS.has(path) && content.includes('browserWithoutInitScript'))
  .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (c) ブラウザ自身の favicon の path（CC-067 の後半）
// ---------------------------------------------------------------------------------------------------------------

/** (c) の除外（ファイル → 理由）。寄せたら消す。 */
const FAVICON_PATH_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tests/helpers/automated-login-fixture.ts':
    'fixture のページが読み込む img の src（ブラウザ自身の要求と同じ形を作る。組 8 の範囲の fixture。組 S2 は触らない）。寄せたら消す',
  'tests/integration/audit-send-worker-fork.test.ts':
    'fork のテストのサイトの記録から除く path（組 6a の範囲の fork のテスト。組 S2 は触らない）。寄せたら消す',
});

const faviconPathLiteralsOf = (file: Pick<SourceFile, 'literals'>): readonly string[] =>
  file.literals.filter((literal) => literal === BROWSER_FAVICON_PATH_TEXT);

const filesWithFaviconPathText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => !path.startsWith(UNIT_TESTS_DIRECTORY) && content.includes(BROWSER_FAVICON_PATH_TEXT))
  .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------

/** 当たったファイルを、除外と見つけたものに分ける（`source-scan.ts` の `judgeWithFileExceptions`。PRE42-CC 組 G）。 */
const judge = judgeWithFileExceptions;

const sample = (content: string): SourceFile => sourceFileOf('tests/integration/planted.test.ts', content);

describe('Gate: the safety tests read the shared test helpers (PRE42-CC group S2, CC-041, CC-098 and CC-067)', () => {
  it('reads the files and the owners', () => {
    const contentOf = (path: string): string => FILES.find((file) => file.path === path)?.content ?? '';
    expect(contentOf(CLOSED_PORT_OWNER)).toMatch(/^export async function closedLoopbackOrigin\(\): Promise<string> \{$/mu);
    expect(contentOf('tests/helpers/browser-proxies.ts')).toMatch(/^export function browserWithoutInitScript\(/mu);
    expect(contentOf('tests/helpers/browser-proxies.ts')).toMatch(/^export const browserWithoutWebRtcBlock = /mu);
    expect(contentOf('tests/helpers/chromium.ts')).toMatch(/^export function browserWithoutServiceWorkerRegistrationBlock\(/mu);
    expect(contentOf('tests/helpers/chromium.ts')).toMatch(/^export \{ BROWSER_DEFAULT_FAVICON_PATH \} from '\.\.\/\.\.\/src\/safety\/request-policy\.js';$/mu);
  });

  it('(a) makes the closed loopback ports only in tests/helpers/loopback-server.ts (CC-041)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithClosedPortText();
    const { found, unusedExceptions } = judge(files, closedPortShapesOf, CLOSED_PORT_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('(b) calls browserWithoutInitScript only in the test helpers (CC-098)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithInitScriptProxyText();
    const { found } = judge(files, initScriptProxyCallsOf, {});
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('(c) does not write the browser favicon path by hand outside the unit tests (CC-067)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithFaviconPathText();
    const { found, unusedExceptions } = judge(files, faviconPathLiteralsOf, FAVICON_PATH_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('finds the shapes placed on purpose, and does not count comments, uses and other strings (the control)', () => {
    expect(closedPortShapesOf(sample([
      'const closedPort = (): Promise<number> => new Promise((resolve) => {',
      '  const probe = createNetServer();',
      "  probe.listen(0, '127.0.0.1', () => {",
      '    const { port } = probe.address() as AddressInfo;',
      '    probe.close(() => resolve(port));',
      '  });',
      '});',
      'async function unusedLoopbackOrigin(): Promise<string> { return origin; }',
      'const freePort = async () => 0;',
      'let unreachableOrigin: () => Promise<string> = async () => origin;',
      'server.close(() => resolvePort(port));',
      // 当たらない: 補助の結果を受ける変数、補助の呼び出し、コメント、ほかの値を返す close。
      'const closedOrigin = await closedLoopbackOrigin();',
      'const unreachable = await closedLoopbackOrigin();',
      '// const closedPort = () => 0;',
      'server.close(() => resolveClose());',
    ].join('\n')))).toEqual([
      'closed port helper: const closedPort = (',
      'closed port helper: function unusedLoopbackOrigin(',
      'closed port helper: const freePort = async (',
      'closed port helper: let unreachableOrigin: () => Promise<string> = async (',
      'close and resolve the port: .close(() => resolve(port))',
      'close and resolve the port: .close(() => resolvePort(port))',
    ]);

    expect(initScriptProxyCallsOf(sample([
      "import { browserWithoutInitScript } from '../helpers/browser-proxies.js';",
      'const browserWithoutWebRtcBlock = (real: Browser): Browser => browserWithoutInitScript(real, WEBRTC_BLOCK_INIT_SCRIPT);',
      // 当たらない: コメント、文字列、補助の呼び出し。
      '// browserWithoutInitScript(real, content)',
      "const label = 'browserWithoutInitScript(real)';",
      'const browser = browserWithoutWebRtcBlock(real);',
    ].join('\n')))).toEqual(['browserWithoutInitScript(']);

    expect(faviconPathLiteralsOf(sample([
      "const BROWSER_FAVICON_PATH = '/favicon.ico';",
      'if (path !== "/favicon.ico") {}',
      'const url = `${ORIGIN}/favicon.ico`;',
      // 当たらない: コメント、ほかの文字を含む文字列、定数の使い。
      '// `/favicon.ico` in a comment',
      "const other = 'https://example.com/favicon.ico';",
      'const query = `${ORIGIN}/favicon.ico?u=1`;',
      'const same = path === BROWSER_DEFAULT_FAVICON_PATH;',
    ].join('\n')))).toEqual(['/favicon.ico', '/favicon.ico', '/favicon.ico']);
  });
});
