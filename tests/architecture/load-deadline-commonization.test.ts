/**
 * CCX-7（CC-045、CC-047）: 読み込みの終わり方と、期限の計算の共通化が戻らないための Architecture Gate。判定は `fs`、正規表現、
 * 文字列の走査だけ（`source-scan.ts` を共用する）。近似の検査である（実行時に組み立てた式は検出できない）。
 * - (a) CCX-7a: `.goto(` の呼び出しを `status: 'FULFILLED'` の終わり方で包む形（`status: 'FULFILLED'` と `.goto(` が同じ文にある形）は、
 *   読み込みの観測の owner（`src/browser/main-frame-load.ts` の `settleMainFrameLoad`）だけに書く。ほかの場所は、その部品を使う。
 *   - (a′) PRE42-CC の組 7（CC-045 のテストの側）: テスト（`tests/**`、画面のテスト `apps/local-ui/tests/**`）も、`page.goto` を終わり方で
 *     包む補助を書き直さず、`settleMainFrameLoad` を使う（`main-frame-load.test.ts` の `settleGoto` の戻りを止める）。Gate のファイル
 *     （`tests/architecture/**`）は、見本の文字列を持つので見ない。テストのファイルは、文字列 `FULFILLED` と `goto` で絞ってから走査する。
 * - (b) CCX-7b: 引数に `Date.now() +` がある `Math.min(` の呼び出し（「期限と、今から timeout 後の早い方」の計算）は、期限の部品の
 *   owner（`src/core/deadline.ts` の `deadlineWithinTimeoutAtMs`）だけに書く。意味の違うものが残る場合は、理由つきの除外の一覧に載せる
 *   （今は除外はない）。
 * - (c) PRE42-CC 組 G（テストの `wait`・`sleep`）: テスト（`tests/**`、画面のテスト `apps/local-ui/tests/**`。Gate のファイルを除く）は、時間の後に
 *   解決する Promise を返す関数（`const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))`・`function sleep(ms) { return new Promise(…) }`）
 *   を定義し直さず、`src/core/deadline.ts` の `wait` を読む（名前を変えて読むのはよい。`import { wait as sleep }`）。G-F: 1 か所に書いた式の待ち
 *   （`await new Promise((resolve) => setTimeout(resolve, 50))`）も書かない。意味の違うもの（偽の時計で進める `sleep`、別の値で解決する
 *   `setTimeout(() => resolve(x), ms)` など）は、形が違うので当たらない。除外は閉じた一覧（理由つき。使われなくなった除外も誤りにする）。文字列 `setTimeout` で絞って
 *   から走査する。
 * - `src/**` の読み込みと走査は、このファイルの読み込み時に 1 回だけ。ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  findCallSites,
  judgeWithFileExceptions,
  loadSourceFiles,
  readTypeScriptFilesUnder,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  unusedExclusionsOf,
  violationsOf,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** (a′) テストのファイル（Gate の `tests/architecture/**` を除く）。文字列 `FULFILLED` と `goto` を書いたものだけを走査する。 */
const TEST_DIRECTORIES: readonly string[] = ['tests/unit', 'tests/component', 'tests/integration', 'tests/helpers', 'tests/fixtures', 'apps/local-ui/tests'];
const TEST_FILES: readonly SourceFile[] = TEST_DIRECTORIES
  .flatMap((directory) => readTypeScriptFilesUnder(directory))
  .filter(({ content }) => content.includes('FULFILLED') && content.includes('goto'))
  .map((file) => scanFile(file));

const MAIN_FRAME_LOAD_OWNER = 'src/browser/main-frame-load.ts';
const DEADLINE_OWNER = 'src/core/deadline.ts';

/**
 * (a) `status: 'FULFILLED'` と `.goto(` が、同じ文（`;` で区切らない範囲）にある形（`code`。コメントを除き、文字列は残す）。
 * どちらが先に書かれていても検出する。
 */
const FULFILLED_GOTO_PATTERNS: readonly RegExp[] = [
  /\bstatus\s*:\s*(['"])FULFILLED\1[^;]*?\.\s*goto\s*\(/gu,
  /\.\s*goto\s*\([^;]*?\bstatus\s*:\s*(['"])FULFILLED\1/gu,
];
const findFulfilledGotoWrappers = (source: ScannedSource): readonly string[] =>
  FULFILLED_GOTO_PATTERNS.flatMap((pattern) => [...source.code.matchAll(pattern)].map((match) => match[0].replace(/\s+/gu, ' ').trim()));

/** (b) 引数に `Date.now() +` がある `Math.min(` の呼び出しの引数（`bare`。コメントと文字列の中を除く）。 */
const NOW_PLUS = /\bDate\s*\.\s*now\s*\(\s*\)\s*\+/u;
const findMinOfNowPlus = (source: ScannedSource): readonly string[] =>
  findCallSites(source.bare, 'Math.min')
    .filter((site) => NOW_PLUS.test(site.argumentText))
    .map((site) => `Math.min(${site.argumentText.replace(/\s+/gu, ' ').trim()})`);

/** (b) の除外（`<ファイル>: <式>` と理由）。除外の一覧は、このファイルの中の 1 か所だけ。 */
const MIN_OF_NOW_PLUS_EXCLUSIONS: ReadonlyMap<string, string> = new Map();

// `violationsOf`（`<パス>: <見つけたもの>`）と、対照の例のファイル（`sourceFileOf`）は、`source-scan.ts` の共通の補助（PRE42-CC 組 G）。
const sample = sourceFileOf;

/** (c) 時間の後に解決する Promise を返す関数の定義（`bare`。arrow と function。引数の名前と、`resolve` の名前は問わない）。 */
const WAIT_DEFINITION_PATTERNS: readonly RegExp[] = [
  /(?<![\w$.])(?:const|let|var)\s+[\w$]+\s*(?::[^=;]*)?=\s*(?:async\s*)?\(\s*([\w$]+)\s*(?::\s*number)?\s*\)\s*(?::\s*Promise\s*<\s*void\s*>\s*)?=>\s*new\s+Promise\s*(?:<[^<>()]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\2\s*,\s*\1\s*\)/gu,
  /\bfunction\s*[\w$]+\s*\(\s*([\w$]+)\s*(?::\s*number)?\s*\)\s*(?::\s*Promise\s*<\s*void\s*>\s*)?\{\s*return\s+new\s+Promise\s*(?:<[^<>()]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\2\s*,\s*\1\s*\)/gu,
];
/**
 * (c) G-F: 1 か所に書いた、時間の後に解決する Promise の式（`await new Promise((resolve) => setTimeout(resolve, 50))`・
 * `new Promise<void>((resolve) => { setTimeout(resolve, ms); })`。`resolve` をそのまま `setTimeout` に渡し、引数は待つ時間だけ）。
 * `setTimeout(() => resolve(x), ms)` のように、別の値で解決するものは当たらない。
 */
const TIMER_PROMISE_PATTERN =
  /\bnew\s+Promise\s*(?:<[^<>()]*>)?\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,\s*[^,()]+(?:\([^()]*\)[^,()]*)?\)\s*;?\s*\}?\s*\)/gu;
const findWaitDefinitions = (source: ScannedSource): readonly string[] => [
  ...WAIT_DEFINITION_PATTERNS.flatMap((pattern) => [...source.bare.matchAll(pattern)].map((match) => match[0].replace(/\s+/gu, ' ').trim())),
  ...[...source.bare.matchAll(TIMER_PROMISE_PATTERN)].map((match) => `timer promise: ${match[0].replace(/\s+/gu, ' ').trim()}`),
];

/** (c) テストのファイル（文字列 `setTimeout` で絞ってから走査する）。 */
const WAIT_TEST_FILES: readonly SourceFile[] = TEST_DIRECTORIES
  .flatMap((directory) => readTypeScriptFilesUnder(directory))
  .filter(({ content }) => content.includes('setTimeout'))
  .map((file) => scanFile(file));

/**
 * (c) の除外（ファイル → 理由）。寄せたら消す。組 Z（2026-10-24）で、並行の作業の間に残した 8 ファイルを寄せ、除外はなくなった。
 * 新しく除外を足すときは、理由を書き、寄せたら消す（使われない除外は `judgeWithFileExceptions` が落とす）。
 */
const WAIT_DEFINITION_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({});

describe('CCX-7 detectors', () => {
  it('(a) detects page.goto wrapped in a FULFILLED settlement in either order, and ignores comments, types and plain calls', () => {
    const file = sample('src/orchestration/sample.ts', [
      "a = { status: 'FULFILLED', value: await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }) };",
      'b = Object.freeze({',
      "  status: 'FULFILLED',",
      '  value: await session.page.goto(targetUrl, {',
      "    waitUntil: 'load',",
      '  }),',
      '});',
      "c = await page.goto(url).then((value) => ({ status: \"FULFILLED\", value }));",
      "type Settled = Readonly<{ status: 'FULFILLED'; value: T }>;",
      "await page.goto(url, { waitUntil: 'load' });",
      "// { status: 'FULFILLED', value: await page.goto(url) }",
      "const opened = await page.goto(setup.loginStartUrl).catch(() => null);",
    ].join('\n'));

    expect(findFulfilledGotoWrappers(file)).toEqual([
      "status: 'FULFILLED', value: await page.goto(",
      "status: 'FULFILLED', value: await session.page.goto(",
      '.goto(url).then((value) => ({ status: "FULFILLED"',
    ]);
  });

  it('(b) detects Math.min with Date.now() + in its arguments, and ignores other Math.min calls and comments', () => {
    const file = sample('src/interaction/sample.ts', [
      'const a = Math.min(deadlineAtMs, Date.now() + timeoutMs);',
      'const b = Math.min(Date.now() + INTERVAL_MS, windowEndsAtMs);',
      'const c = Math.min(',
      '  deadlineAtMs,',
      '  Date.now()',
      '    + timeoutMs,',
      ');',
      'const d = Math.min(rect.right, viewport.width);',
      'const e = Date.now() + timeoutMs;',
      'const f = Math.max(0, deadlineAtMs - Date.now());',
      '// Math.min(deadlineAtMs, Date.now() + timeoutMs)',
      "const g = 'Math.min(deadlineAtMs, Date.now() + timeoutMs)';",
    ].join('\n'));

    expect(findMinOfNowPlus(file)).toEqual([
      'Math.min(deadlineAtMs, Date.now() + timeoutMs)',
      'Math.min(Date.now() + INTERVAL_MS, windowEndsAtMs)',
      'Math.min(deadlineAtMs, Date.now() + timeoutMs,)',
    ]);
  });

  it('(c) detects a wait helper defined again in a test, and ignores the shared wait, fake sleeps and comments (PRE42-CC group G)', () => {
    const file = sample('tests/integration/sample.test.ts', [
      'const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));',
      'const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => {',
      '  setTimeout(resolvePromise, ms);',
      '});',
      'const pause = (delay) => new Promise<void>((resolve) => setTimeout(resolve, delay));',
      'async function delay(ms: number): Promise<void> {',
      '  return new Promise((resolve) => setTimeout(resolve, ms));',
      '}',
      // 当たらない: 共通の部品を読む形、偽の時計の sleep、その場で待つ式、別の値で解決する Promise、コメント。
      "import { wait as sleepFor } from '../../src/core/deadline.js';",
      'const fakeSleep = async (ms: number): Promise<void> => { clock.nowMs += ms; };',
      'const later = (ms: number) => new Promise((resolve) => setTimeout(() => resolve(ms), ms));',
      'const timer = setTimeout(resolve, 50);',
      '// const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
      "// await new Promise((resolve) => setTimeout(resolve, 50));",
    ].join('\n'));

    expect(findWaitDefinitions(file)).toEqual([
      'const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms)',
      'const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms)',
      'const pause = (delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)',
      'function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)',
      'timer promise: new Promise((resolveWait) => setTimeout(resolveWait, ms))',
      'timer promise: new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); })',
      'timer promise: new Promise<void>((resolve) => setTimeout(resolve, delay))',
      'timer promise: new Promise((resolve) => setTimeout(resolve, ms))',
    ]);
    // G-F: 1 か所に書いた式の待ち（`await` の有無、型引数、波括弧、式の待つ時間）。
    expect(findWaitDefinitions(sample('tests/integration/inline.test.ts', [
      'await new Promise((resolve) => setTimeout(resolve, 50));',
      'await new Promise<void>((resolveWait) => {',
      '  setTimeout(resolveWait, 10);',
      '});',
      'await Promise.race([work, new Promise((r) => setTimeout(r, INTERVAL_MS * 5))]);',
    ].join('\n')))).toEqual([
      'timer promise: new Promise((resolve) => setTimeout(resolve, 50))',
      'timer promise: new Promise<void>((resolveWait) => { setTimeout(resolveWait, 10); })',
      'timer promise: new Promise((r) => setTimeout(r, INTERVAL_MS * 5))',
    ]);
  });
});

describe('PRE42-CC group G Gate: the tests read wait from src/core/deadline.ts', () => {
  it('(c) no test defines its own wait helper, besides the closed exceptions', () => {
    const stopwatch = startCpuStopwatch();
    expect(SOURCE_FILES.find((file) => file.path === DEADLINE_OWNER)?.bare ?? '').toMatch(/\bexport\s+function\s+wait\s*\(/u);
    expect(WAIT_TEST_FILES.length).toBeGreaterThan(0);
    const { found, unusedExceptions } = judgeWithFileExceptions(WAIT_TEST_FILES, findWaitDefinitions, WAIT_DEFINITION_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, WAIT_TEST_FILES.length));
  });
});

describe('CCX-7 Gate: the main frame load settlement and the deadline within a timeout', () => {
  it('reads the source files once', () => {
    expect(SOURCE_FILES.some((file) => file.path === MAIN_FRAME_LOAD_OWNER)).toBe(true);
    expect(SOURCE_FILES.some((file) => file.path === DEADLINE_OWNER)).toBe(true);
  });

  it('(a) page.goto is wrapped in a FULFILLED settlement only in src/browser/main-frame-load.ts (CCX-7a)', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== MAIN_FRAME_LOAD_OWNER);
    const owner = SOURCE_FILES.find((file) => file.path === MAIN_FRAME_LOAD_OWNER);

    expect(violationsOf(others, findFulfilledGotoWrappers)).toEqual([]);
    expect(owner === undefined ? [] : findFulfilledGotoWrappers(owner)).not.toEqual([]);
  });

  it('(a′) the tests do not wrap page.goto in a FULFILLED settlement either; they use settleMainFrameLoad (PRE42-CC group 7, CC-045)', () => {
    const stopwatch = startCpuStopwatch();
    expect(TEST_FILES.some((file) => file.path === 'tests/integration/main-frame-load.test.ts')).toBe(true);

    expect(violationsOf(TEST_FILES, findFulfilledGotoWrappers)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(1, TEST_FILES.length));
  });

  it('(b) Math.min with Date.now() + is written only in src/core/deadline.ts (CCX-7b)', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== DEADLINE_OWNER);
    const found = violationsOf(others, findMinOfNowPlus);
    const owner = SOURCE_FILES.find((file) => file.path === DEADLINE_OWNER);

    expect(found.filter((entry) => !MIN_OF_NOW_PLUS_EXCLUSIONS.has(entry))).toEqual([]);
    expect(owner?.bare ?? '').toMatch(/\bexport\s+function\s+deadlineWithinTimeoutAtMs\s*\(/u);
  });

  it('(b) every exclusion is still used, so that stale exclusions do not hide new calculations', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== DEADLINE_OWNER);
    expect(unusedExclusionsOf(MIN_OF_NOW_PLUS_EXCLUSIONS.keys(), violationsOf(others, findMinOfNowPlus))).toEqual([]);
  });
});
