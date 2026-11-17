/**
 * 場面ごとの時間の見張りの Gate（RB-0。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 8）。判定は `fs`、正規表現、
 * `source-scan.ts` の文字列の走査だけ（近似の検査）。
 * - (1) 上限の表（`tests/test-time-limits.json`）の形が正しく、例外のファイルが実在し、名前つきの例外の場面の名前がそのファイルに書いてある。
 * - (2) 名前つきの例外（端から端・ずれの確かめの両方の Chromium・Windows の本物の機能）は、区切りに流す組（`SLOW_TEST_FILES`）に属する。
 * - (3) テストのファイルに、場面の時間の上限（`it`・`test`・`describe` の options の `timeout`、関数の後の引数、`vi.setConfig`）を書かない。
 *   移る途中の例外は、表の `migratingTimeoutOptions`（ファイル → 件数の閉じた一覧）。件数が変わったら誤り、使われなくなった行も誤り。
 * - (4) ルートと画面の Vitest の設定は、見張り（`tests/helpers/test-time-limit-setup.ts`）を setupFiles に持ち、`testTimeout` を表の最大の
 *   上限から導く（数を書かない）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import uiVitestConfig from '../../apps/local-ui/vitest.config.js';
import vitestConfig from '../../vitest.config.js';
import { maxLimitMsOf, TEST_TIME_LIMITS, testTimeLimitsShapeErrorsOf, type TestTimeLimits } from '../helpers/test-time-limits.js';
import { SLOW_TEST_FILES } from '../suites.js';
import {
  judgeWithFileExceptions,
  matchingParenthesis,
  readLfTextFile,
  readLfTypeScriptFilesUnder,
  REPOSITORY_ROOT,
  scanFile,
  scanSource,
  sourceFileOf,
  splitTopLevelArguments,
  type FileExceptions,
  type SourceFile,
} from './source-scan.js';
import TIME_LIMITS_DATA from '../test-time-limits.json' with { type: 'json' };

const TIME_LIMITS_FILE = 'tests/test-time-limits.json';
const SETUP_FILE_NAME = 'test-time-limit-setup.ts';
/** テストのファイル（`.test.ts`）を探すフォルダ。 */
const TEST_DIRECTORIES: readonly string[] = Object.freeze(['tests/unit', 'tests/component', 'tests/architecture', 'tests/integration', 'tests/contract', 'apps/local-ui/tests']);
const TEST_FILES: readonly SourceFile[] = readLfTypeScriptFilesUnder(TEST_DIRECTORIES)
  .filter(({ path }) => path.endsWith('.test.ts'))
  .map((file) => scanFile(file));

/** 場面の API の呼び出しの頭（修飾 `.skip`・`.each(…)` などを含む。括弧の中は後でたどる）。 */
const SCENE_CALL = /(?<![\w$.])(?:it|test|describe)(?:\s*\.\s*[A-Za-z]+)*\s*\(/gu;
/** 関数の引数（`async`・矢印・`function`）。 */
const FUNCTION_ARGUMENT = /^(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)/u;
/** options の `timeout`（最上位の鍵）。 */
const TIMEOUT_OPTION = /^\{[^]*?(?<![\w$])timeout\s*:/u;
/** `vi.setConfig` の時間の上限。 */
const SET_CONFIG_TIMEOUT = /(?<![\w$])vi\s*\.\s*setConfig\s*\(\s*\{[^}]*\b(?:testTimeout|hookTimeout)\s*:/gu;

/** `bare`（コメントと文字列の中身を除いた本文）の中の、場面の時間の上限を書いた所（`<行>: <形>`）。 */
const explicitTimeoutsIn = (bare: string): readonly string[] => {
  const lineOf = (index: number): number => bare.slice(0, index).split('\n').length;
  const found: string[] = [];
  for (const match of bare.matchAll(SCENE_CALL)) {
    let open = match.index + match[0].length - 1;
    let close = matchingParenthesis(bare, open);
    // `it.each(表)(名前, 関数, 上限)` などは、続く括弧が場面の引数。
    while (close >= 0 && bare[close + 1] === '(') {
      open = close + 1;
      close = matchingParenthesis(bare, open);
    }
    if (close < 0) {
      continue;
    }
    const argumentsOf = splitTopLevelArguments(bare.slice(open + 1, close));
    const functionIndex = argumentsOf.findIndex((argument) => FUNCTION_ARGUMENT.test(argument));
    if (functionIndex < 0) {
      continue;
    }
    argumentsOf.forEach((argument, index) => {
      if (index > functionIndex) {
        found.push(`${String(lineOf(match.index))}: trailing ${argument.replace(/\s+/gu, ' ')}`);
      } else if (index !== functionIndex && TIMEOUT_OPTION.test(argument)) {
        found.push(`${String(lineOf(match.index))}: options timeout`);
      }
    });
  }
  for (const match of bare.matchAll(SET_CONFIG_TIMEOUT)) {
    found.push(`${String(lineOf(match.index))}: vi.setConfig`);
  }
  return found;
};

/** 表の `migratingTimeoutOptions` を、ファイルごとの件数の除外にする。 */
const timeoutOptionExceptionsOf = (limits: TestTimeLimits): FileExceptions => Object.fromEntries(
  Object.entries(limits.migratingTimeoutOptions.files).map(([path, count]) => [path, { count, reason: limits.migratingTimeoutOptions.reason }]),
);

const isInRepository = (path: string): boolean => existsSync(join(REPOSITORY_ROOT, path));

describe('RB-0 (1): the time limit table', () => {
  it('has the documented shape (the setup refuses to start otherwise)', () => {
    expect(testTimeLimitsShapeErrorsOf(TIME_LIMITS_DATA)).toEqual([]);
  });

  it('names only test files that exist, and each named scene is written in its file', () => {
    const files = [
      ...TEST_TIME_LIMITS.exceptions.map(({ file }) => file),
      ...TEST_TIME_LIMITS.migrating.map(({ file }) => file),
      ...Object.keys(TEST_TIME_LIMITS.migratingTimeoutOptions.files),
    ];
    expect(files.filter((file) => !file.endsWith('.test.ts') || !isInRepository(file))).toEqual([]);
    const missingScenes = TEST_TIME_LIMITS.exceptions
      .filter(({ file, test }) => !readLfTextFile(file).includes(test.split(' > ').at(-1) ?? test))
      .map(({ file, test }) => `${file}: ${test}`);
    expect(missingScenes).toEqual([]);
  });
});

describe('RB-0 (2): the named exceptions run in the slow suite', () => {
  it('every named exception is in a file of the slow suite (the suites run at the milestones)', () => {
    expect(TEST_TIME_LIMITS.exceptions.filter(({ file }) => !SLOW_TEST_FILES.includes(file)).map(({ file, test }) => `${file}: ${test}`)).toEqual([]);
  });
});

describe('RB-0 (3): no test file writes the time limit of a scene', () => {
  it('the explicit limits are only the counted migrating rows of the table', () => {
    const judgement = judgeWithFileExceptions(TEST_FILES, ({ bare }) => explicitTimeoutsIn(bare), timeoutOptionExceptionsOf(TEST_TIME_LIMITS));
    expect(judgement.found).toEqual([]);
    expect(judgement.countMismatches).toEqual([]);
    expect(judgement.unusedExceptions).toEqual([]);
  });

  it('detects the trailing argument, the options and vi.setConfig, and not the waits inside a scene (control)', () => {
    const detected = explicitTimeoutsIn(sourceFileOf('tests/unit/a.test.ts', [
      "it('a', async () => { await expect.poll(read, { timeout: WAIT_MS }).toBe(1); });",
      "it('b', async () => {}, LIMIT_MS);",
      "it.each([1, 2])('c %s', (value) => {}, 1_000);",
      "test('d', { timeout: LIMIT_MS }, () => {});",
      "describe('e', () => { it('f', () => {}); });",
      'vi.setConfig({ testTimeout: LIMIT_MS });',
    ].join('\n')).bare);
    expect(detected).toEqual(['2: trailing LIMIT_MS', '3: trailing 1_000', '4: options timeout', '6: vi.setConfig']);
  });
});

describe('RB-0 (4): the Vitest settings take the watch and the largest limit from the table', () => {
  const configs = [
    { path: 'vitest.config.ts', test: vitestConfig.test },
    { path: 'apps/local-ui/vitest.config.ts', test: uiVitestConfig.test },
  ];

  it.each(configs)('$path runs the shared setup and derives testTimeout from the table', ({ path, test }) => {
    expect(test?.testTimeout).toBe(maxLimitMsOf(TEST_TIME_LIMITS));
    const setupFiles = [test?.setupFiles ?? []].flat();
    expect(setupFiles.filter((file) => file.replaceAll('\\', '/').endsWith(`tests/helpers/${SETUP_FILE_NAME}`))).toHaveLength(1);
    expect(scanSource(readLfTextFile(path)).bare).not.toMatch(/\btestTimeout\s*:\s*\d/u);
  });

  it('the table is the one file of the limits', () => {
    expect(isInRepository(TIME_LIMITS_FILE)).toBe(true);
  });
});
