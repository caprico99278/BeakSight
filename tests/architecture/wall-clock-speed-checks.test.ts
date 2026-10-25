/**
 * 速さの要件を壁時計で測らない Gate（TS-d。設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.4。DEF-153）。判定は `fs`、正規表現、
 * 文字列の走査だけ（`source-scan.ts` の `readLfTypeScriptFilesUnder`・`scanFile`・`judgeWithFileExceptions` を共用する）。近似の検査である。
 * - 見る所: architecture と単体の系のテスト（`tests/architecture/`・`tests/unit/`・`tests/component/` の `.ts`・`.tsx`）。
 * - 壁時計の経過の形: 同じファイルで壁時計の時刻（`performance.now()`・`Date.now()`）を入れた変数を、後で壁時計の時刻から引く形
 *   （`performance.now() - started`）。純粋な計算の速さ（Gate の `MAX_GATE_MS`、単体の名前つきの上限）は、`source-scan.ts` の
 *   `startCpuStopwatch`（CPU の時間）で測る。並行の混雑で壁時計が延び、本当の遅れを見分けられなくなるため（DEF-153）。
 * - 除外（閉じた一覧。ファイル → 件数と理由）: タイマーの待ち（期限の内に返るか、待つ時間の下限）を測るテスト。待つ間は CPU を使わないので、
 *   CPU の時間では測れない。件数が変わったら（新しく書いた、または消した）誤りにする。使われなくなった除外も誤りにする。
 * - 1 ファイル 1 秒以内に終える（CPU の時間）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  judgeWithFileExceptions,
  readLfTypeScriptFilesUnder,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  type FileExceptions,
  type SourceFile,
} from './source-scan.js';

/** 見るフォルダ（architecture と単体の系。`test:fast` の組）。 */
const CHECKED_DIRECTORIES: readonly string[] = Object.freeze(['tests/architecture', 'tests/unit', 'tests/component']);

/** 見るファイル（読み込みと走査は 1 回だけ）。 */
const CHECKED_FILES: readonly SourceFile[] = readLfTypeScriptFilesUnder(CHECKED_DIRECTORIES).map((file) => scanFile(file));

/** 壁時計の時刻を、そのまま変数に入れる形（`const started = performance.now();`。期限の計算 `Date.now() + n` は数えない）。 */
const WALL_CLOCK_START = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=(?![=>])\s*(?:performance|Date)\s*\.\s*now\s*\(\s*\)\s*(?=[;,)\n])/gu;
/** 壁時計の時刻から変数を引く形（`performance.now() - started`）。 */
const WALL_CLOCK_ELAPSED = /(?<![\w$.])(?:performance|Date)\s*\.\s*now\s*\(\s*\)\s*-\s*([A-Za-z_$][\w$]*)(?![\w$(.])/gu;

/** `bare`（コメントと文字列の中身を除いた本文）の中の、壁時計の経過の形（空白は 1 つにそろえる）。 */
const wallClockElapsedIn = (file: Pick<SourceFile, 'bare'>): readonly string[] => {
  const starts = new Set([...file.bare.matchAll(WALL_CLOCK_START)].map((match) => match[1] ?? ''));
  return [...file.bare.matchAll(WALL_CLOCK_ELAPSED)]
    .filter((match) => starts.has(match[1] ?? ''))
    .map((match) => match[0].replace(/\s+/gu, ' ').trim());
};

/** タイマーの待ちを測るテストの理由（期限の内に返るか、待つ時間の下限）。 */
const TIMER_WAIT = '注入した短い期限のタイマーの待ち（期限の内に返るか、待つ時間の下限）を測る。待つ間は CPU を使わないので CPU の時間では測れない';

/** 除外（閉じた一覧。ファイル → 件数と理由）。 */
const WALL_CLOCK_EXCEPTIONS: FileExceptions = Object.freeze({
  'tests/component/layout-collector.test.ts': { count: 2, reason: `観察の開始の期限と、評価の期限（V8）。${TIMER_WAIT}` },
  'tests/unit/discovery-isolated-read.test.ts': { count: 1, reason: `session を開く期限と切り離しの期限。${TIMER_WAIT}` },
  'tests/unit/discovery-settle.test.ts': { count: 1, reason: `落ち着きの待ちの期限の下限。${TIMER_WAIT}` },
  'tests/unit/passive-session-open.test.ts': { count: 5, reason: `session を開く期限と Context を閉じる期限。${TIMER_WAIT}` },
  'tests/unit/run-coordinator.test.ts': { count: 2, reason: `Browser と Context を閉じる期限。${TIMER_WAIT}` },
});

const planted = (content: string): readonly string[] => wallClockElapsedIn(sourceFileOf('tests/unit/planted.test.ts', content));

describe('Gate: the speed checks of the architecture and unit tests do not use the wall clock (TS-d)', () => {
  it('reads the files of the architecture and unit tests', () => {
    expect(CHECKED_FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([
      'tests/architecture/source-scan.ts',
      'tests/unit/recorded-request-url-redaction.test.ts',
      'tests/component/layout-collector.test.ts',
    ]));
  });

  it('writes no wall clock elapsed time outside the closed list of the timer waits', () => {
    const stopwatch = startCpuStopwatch();
    const { found, countMismatches, unusedExceptions } = judgeWithFileExceptions(CHECKED_FILES, wallClockElapsedIn, WALL_CLOCK_EXCEPTIONS);
    expect(found).toEqual([]);
    expect(countMismatches).toEqual([]);
    expect(unusedExceptions, 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * CHECKED_FILES.length);
  });

  it('finds the shapes placed on purpose, and does not count the CPU stopwatch, deadlines, comments and strings (the control)', () => {
    expect(planted([
      'const started = performance.now();',
      'expect(performance.now() - started).toBeLessThan(MAX_GATE_MS);',
      'const STARTED_AT_MS = performance.now();',
      'expect(performance.now()  -  STARTED_AT_MS).toBeLessThan(1_000);',
      'let startedAt: number = Date.now();',
      'const elapsedMs = Date.now() - startedAt;',
    ].join('\n'))).toEqual([
      'performance.now() - started',
      'performance.now() - STARTED_AT_MS',
      'Date.now() - startedAt',
    ]);
    expect(planted([
      // 当たらない: CPU の測り、期限の計算、時刻の値、コメント、文字列の中。
      'const stopwatch = startCpuStopwatch();',
      'expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);',
      'const deadline = Date.now() + 5_000;',
      'const remaining = deadline - Date.now();',
      'const past = Date.now() - 1;',
      'const heartbeatAt = new Date(Date.now() - ageMs);',
      '// const started = performance.now(); performance.now() - started',
      "const text = 'const started = performance.now(); performance.now() - started';",
    ].join('\n'))).toEqual([]);
  });
});
