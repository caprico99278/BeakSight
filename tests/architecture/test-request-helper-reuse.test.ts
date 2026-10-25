/**
 * テストの要求の補助の Gate（PRE42-CC の組 7。台帳の CC-093・CC-094）。判定は `fs`、正規表現、文字列の検索だけ（`source-scan.ts` の
 * `readTypeScriptFilesUnder`・`scanFile`・`findCallSites` を共用する）。近似の検査である。
 * - 見る所: 結合のテスト（`tests/integration/**`）、部品のテスト（`tests/component/**`）、単体のテスト（`tests/unit/**`）、テストの補助
 *   （`tests/helpers/**`）、画面のテスト（`apps/local-ui/tests/**`）。(a) は単体のテストを見ない（方針の表を `it.each` などで独立に書き下すため）。
 * - (a) CC-093: 読み取りの要求の method（GET と HEAD）は、`tests/helpers/leak-places.ts` の `READ_METHODS`・`nonReadRequestsOf` だけに書く。
 *   ほかのファイルは、それを import して読む（写しの `new Set(['GET', 'HEAD'])`、手で書いた判定 `method !== 'GET' && method !== 'HEAD'`・
 *   `method === 'GET' || method === 'HEAD'`、`['GET', 'HEAD'].includes(` の戻りを止める）。HEAD を読み取りに数えない判定
 *   （`method !== 'GET'` だけ）は、意味が違うので数えない。
 *   - fork のテスト（`tests/integration/*-fork.test.ts`）と fork の補助は、組 6a の Gate（`fork-test-helper-reuse.test.ts` の (c)）が見るので、
 *     ここでは見ない（同じファイルを 2 つの Gate の除外の一覧で持たない）。
 * - (b) CC-094: テストの偽の Playwright の要求（`Request`）の口 `isNavigationRequest`（関数の値。`isNavigationRequest: () => …`・
 *   `isNavigationRequest() {`）は、`tests/helpers/fake-playwright-request.ts` の `fakePlaywrightRequest` だけに書く。その呼び出しの引数の中
 *   （形の違う口を `overrides` で上書きする所）は数えない。証跡の値の `isNavigationRequest: true` は関数でないので当たらない。
 * - 除外は閉じた一覧（理由つき）。使われなくなった除外も誤りにする。
 * - 1 ファイル 1 秒以内に終える。本文の文字列で絞ってから走査する（走査は文字ずつで重いため。DEF-107）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  TEST_SOURCE_DIRECTORIES,
  findCallSites,
  judgeWithFileExceptions,
  readLfTypeScriptFilesUnder,
  readMethodCopiesIn,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  type SourceFile,
  type UnscannedFile,
} from './source-scan.js';

const READ_METHODS_OWNER = 'tests/helpers/leak-places.ts';
const FAKE_REQUEST_OWNER = 'tests/helpers/fake-playwright-request.ts';
const FAKE_REQUEST_FUNCTION = 'fakePlaywrightRequest';

/** 見るファイル（読み込みは 1 回だけ。改行は LF にそろえる。`source-scan.ts` の `readLfTypeScriptFilesUnder`）。 */
const FILES: readonly UnscannedFile[] = readLfTypeScriptFilesUnder(TEST_SOURCE_DIRECTORIES);

// ---------------------------------------------------------------------------------------------------------------
// (a) 読み取りの要求の method（CC-093）
// ---------------------------------------------------------------------------------------------------------------

/** 単体のテスト（方針の表を独立に書き下すので (a) では見ない）。 */
const UNIT_TESTS_DIRECTORY = 'tests/unit/';

/** 組 6a の Gate（`fork-test-helper-reuse.test.ts` の (c)）が見るファイル。 */
const isForkGateFile = (path: string): boolean =>
  /^tests\/integration\/[^/]+-fork\.test\.ts$/u.test(path)
  || ['tests/helpers/worker-fork-support.ts', 'tests/helpers/worker-fork.ts', 'tests/helpers/write-job-harness.ts'].includes(path);

// 読み取りの要求の method を書き写した形は、`source-scan.ts` の `READ_METHOD_COPY_SHAPES`・`readMethodCopiesIn`（組 6a の Gate と共用。PRE42-CC 組 G）。

/** (a) の除外（ファイル → 理由）。ほかの組の範囲で、組 7 が触らないファイル。寄せたら消す。 */
const READ_METHOD_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tests/integration/guard-api-write-stage.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/integration/guard-audit-stage.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/integration/guard-login-stage.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/integration/guard-update-payload.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/integration/guard-write-stage.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/integration/passive-request-guard.test.ts': 'Guard のテスト（組 7 の範囲の外。両方の Chromium で確かめる安全の組が寄せる）。寄せたら消す',
  'tests/helpers/authenticated-site-fixture.ts': 'fixture のサーバの側の読み取りの判定（組 8 の範囲の fixture）。寄せたら消す',
  'tests/helpers/discovery-site-fixture.ts': 'fixture のサーバの側の読み取りの判定（組 8 の範囲の fixture）。寄せたら消す',
  'tests/helpers/large-checkpoint-fixture.ts': 'fixture のサーバの側の読み取りの判定（組 8 の範囲の fixture）。寄せたら消す',
  'tests/helpers/submitter-words-fixture.ts': 'fixture のサーバの側の読み取りの判定（組 8 の範囲の fixture）。寄せたら消す',
});

/** 形に当たった所（`<形の名前>: <当たった本文>`。空白は 1 つにそろえる。`code`: コメントを除き、文字列を残した本文に当てる）。 */
const readMethodCopiesOf = (file: Pick<SourceFile, 'code'>): readonly string[] => readMethodCopiesIn(file.code);

/** 文字列 `GET` と `HEAD` の両方を書いたファイル（絞ってから走査する）。 */
const filesWithReadMethodText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => path !== READ_METHODS_OWNER && !path.startsWith(UNIT_TESTS_DIRECTORY) && !isForkGateFile(path)
    && content.includes('GET') && content.includes('HEAD'))
  .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------
// (b) 偽の Playwright の要求（CC-094）
// ---------------------------------------------------------------------------------------------------------------

/** 偽の要求の口 `isNavigationRequest` を関数で書いた形（`bare`: コメントと文字列の中を除いた本文に当てる）。 */
const FAKE_NAVIGATION_PORT = /(?<![.\w$])isNavigationRequest\s*(?::\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>|:\s*(?:async\s+)?function\b|\(\s*\)\s*(?::[^{;]*)?\{)/gu;

/** (b) の除外（ファイル → 理由）。 */
const FAKE_REQUEST_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tests/component/network-collector.test.ts':
    '転送の前後（`redirectedFrom`・`redirectedTo`）、時間（`timing`）、大きさ（`sizes`）、ヘッダを持つ別の形の偽の要求（`fakePlaywrightRequest` の項目にない口を書き換える）',
  'tests/integration/passive-request-guard.test.ts': 'Guard のテスト（組 7 の範囲の外。調べの口が投げる偽の要求）。`overrides` で書き直したら消す',
});

/** `fakePlaywrightRequest(…)` の引数の範囲（その中の口は `overrides` なので数えない）。 */
const fakeRequestCallRangesOf = (bare: string): readonly (readonly [number, number])[] =>
  findCallSites(bare, FAKE_REQUEST_FUNCTION).map(({ index, argumentText }) => {
    const open = bare.indexOf('(', index + FAKE_REQUEST_FUNCTION.length);
    return [open, open + argumentText.length + 1] as const;
  });

/** 偽の要求の口を関数で書いた所（行の番号つき）。`fakePlaywrightRequest(…)` の引数の中は除く。 */
const fakeNavigationPortsOf = (file: Pick<SourceFile, 'bare'>): readonly string[] => {
  const ranges = fakeRequestCallRangesOf(file.bare);
  return [...file.bare.matchAll(FAKE_NAVIGATION_PORT)]
    .filter((match) => !ranges.some(([start, end]) => match.index > start && match.index < end))
    .map((match) => `line ${String(file.bare.slice(0, match.index).split('\n').length)}: ${match[0].replace(/\s+/gu, ' ').trim()}`);
};

/** 文字列 `isNavigationRequest` を書いたファイル（絞ってから走査する）。 */
const filesWithNavigationPortText = (): readonly SourceFile[] => FILES
  .filter(({ path, content }) => path !== FAKE_REQUEST_OWNER && content.includes('isNavigationRequest'))
  .map((file) => scanFile(file));

// ---------------------------------------------------------------------------------------------------------------

/** 当たったファイルを、除外と見つけたものに分ける（`source-scan.ts` の `judgeWithFileExceptions`。PRE42-CC 組 G）。 */
const judge = judgeWithFileExceptions;

const sample = (content: string): SourceFile => sourceFileOf('tests/integration/planted.test.ts', content);

describe('Gate: the tests read the request helpers (PRE42-CC group 7, CC-093 and CC-094)', () => {
  it('reads the files and the owners', () => {
    const paths = FILES.map(({ path }) => path);
    expect(paths).toEqual(expect.arrayContaining([READ_METHODS_OWNER, FAKE_REQUEST_OWNER, 'apps/local-ui/tests/helpers/scenario-marker-flow.ts']));
    const owner = FILES.find(({ path }) => path === READ_METHODS_OWNER)?.content ?? '';
    expect(owner).toMatch(/^export const READ_METHODS: ReadonlySet<string> = new Set\(\['GET', 'HEAD'\]\);$/mu);
    expect(owner).toMatch(/^export const nonReadRequestsOf = /mu);
    expect(FILES.find(({ path }) => path === FAKE_REQUEST_OWNER)?.content ?? '').toMatch(/^export function fakePlaywrightRequest\(/mu);
  });

  it('(a) writes the read request methods only in tests/helpers/leak-places.ts (CC-093)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithReadMethodText();
    const { found, unusedExceptions } = judge(files, readMethodCopiesOf, READ_METHOD_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('(b) writes the fake Playwright request ports only in tests/helpers/fake-playwright-request.ts (CC-094)', () => {
    const stopwatch = startCpuStopwatch();
    const files = filesWithNavigationPortText();
    const { found, unusedExceptions } = judge(files, fakeNavigationPortsOf, FAKE_REQUEST_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, files.length));
  });

  it('finds the shapes placed on purpose, and does not count comments, other meanings and the overrides (the control)', () => {
    expect(readMethodCopiesOf(sample([
      "const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);",
      'const B = new Set<string>(["HEAD", "GET"]);',
      "const c = ['GET', 'HEAD'].includes(method);",
      "a.filter(({ method }) => method !== 'GET' && method !== 'HEAD');",
      "b.filter((request) => request.preflight || (request.method !== 'GET' && request.method !== 'HEAD'));",
      "c.filter((entry) =>\n  entry.method !== 'HEAD'\n  && entry.method !== 'GET');",
      "d.every(({ method }) => method === 'GET' || method === 'HEAD');",
      "if (request.method() != 'GET' && request.method() != 'HEAD') {}",
      // 当たらない: HEAD を読み取りに数えない判定、文の区切りをまたぐ比べ、コメント、ほかの集合。
      "e.filter(({ method }) => method !== 'GET');",
      "const f = method !== 'GET'; const g = method !== 'HEAD';",
      "// a.filter(({ method }) => method !== 'GET' && method !== 'HEAD');",
      "const h = new Set(['GET', 'POST']);",
    ].join('\n')))).toEqual([
      "copied set: new Set(['GET', 'HEAD'])",
      'copied set: new Set<string>(["HEAD", "GET"])',
      "copied list includes: ['GET', 'HEAD'].includes(",
      "not a read by hand: method !== 'GET' && method !== 'HEAD'",
      "not a read by hand: method !== 'GET' && request.method !== 'HEAD'",
      "not a read by hand: method !== 'HEAD' && entry.method !== 'GET'",
      "not a read by hand: method() != 'GET' && request.method() != 'HEAD'",
      "a read by hand: method === 'GET' || method === 'HEAD'",
    ]);

    expect(fakeNavigationPortsOf(sample([
      'const request = { isNavigationRequest: () => true, frame: () => mainFrame };',
      'emit({ url: () => url, isNavigationRequest: () => navigation } as unknown as Request);',
      'const r = { isNavigationRequest(): never { throw new Error(); } };',
      'const s = { isNavigationRequest: async () => false };',
      'const t = { isNavigationRequest: function () { return true; } };',
      // 当たらない: 証跡の値、呼び出し、fakePlaywrightRequest の overrides、コメント、文字列。
      'const u = { url: "/", isNavigationRequest: true };',
      'const v = request.isNavigationRequest();',
      'const w = fakePlaywrightRequest({ url }, { isNavigationRequest: () => { throw new Error(); } });',
      '// const x = { isNavigationRequest: () => true };',
      "const y = 'isNavigationRequest: () => true';",
    ].join('\n')))).toEqual([
      'line 1: isNavigationRequest: () =>',
      'line 2: isNavigationRequest: () =>',
      'line 3: isNavigationRequest(): never {',
      'line 4: isNavigationRequest: async () =>',
      'line 5: isNavigationRequest: function',
    ]);
  });
});
