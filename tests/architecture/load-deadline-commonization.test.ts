/**
 * CCX-7（CC-045、CC-047）: 読み込みの終わり方と、期限の計算の共通化が戻らないための Architecture Gate。判定は `fs`、正規表現、
 * 文字列の走査だけ（`source-scan.ts` を共用する）。近似の検査である（実行時に組み立てた式は検出できない）。
 * - (a) CCX-7a: `.goto(` の呼び出しを `status: 'FULFILLED'` の終わり方で包む形（`status: 'FULFILLED'` と `.goto(` が同じ文にある形）は、
 *   読み込みの観測の owner（`src/browser/main-frame-load.ts` の `settleMainFrameLoad`）だけに書く。ほかの場所は、その部品を使う。
 * - (b) CCX-7b: 引数に `Date.now() +` がある `Math.min(` の呼び出し（「期限と、今から timeout 後の早い方」の計算）は、期限の部品の
 *   owner（`src/core/deadline.ts` の `deadlineWithinTimeoutAtMs`）だけに書く。意味の違うものが残る場合は、理由つきの除外の一覧に載せる
 *   （今は除外はない）。
 * - `src/**` の読み込みと走査は、このファイルの読み込み時に 1 回だけ。ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { findCallSites, loadSourceFiles, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

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

const violationsOf = (
  files: readonly SourceFile[],
  find: (file: SourceFile) => readonly string[],
): readonly string[] => files.flatMap((file) => find(file).map((match) => `${file.path}: ${match}`));

const sample = (path: string, content: string): SourceFile => ({ path, content, ...scanSource(content) });

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

  it('(b) Math.min with Date.now() + is written only in src/core/deadline.ts (CCX-7b)', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== DEADLINE_OWNER);
    const found = violationsOf(others, findMinOfNowPlus);
    const owner = SOURCE_FILES.find((file) => file.path === DEADLINE_OWNER);

    expect(found.filter((entry) => !MIN_OF_NOW_PLUS_EXCLUSIONS.has(entry))).toEqual([]);
    expect(owner?.bare ?? '').toMatch(/\bexport\s+function\s+deadlineWithinTimeoutAtMs\s*\(/u);
  });

  it('(b) every exclusion is still used, so that stale exclusions do not hide new calculations', () => {
    const others = SOURCE_FILES.filter((file) => file.path !== DEADLINE_OWNER);
    const found = new Set(violationsOf(others, findMinOfNowPlus));

    expect([...MIN_OF_NOW_PLUS_EXCLUSIONS.keys()].filter((entry) => !found.has(entry))).toEqual([]);
  });
});
