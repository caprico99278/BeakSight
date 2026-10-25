/**
 * 時間の単位の定数の Gate（CCX-19。CC-046・CC-075）。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` の `loadSourceFiles`・
 * `loadLocalUiSourceFiles` を共用する）。近似の検査である。
 * - (a) 時間の単位の定数（`MILLISECONDS_PER_SECOND`・`MS_PER_SECOND`・`SECOND_MS`・`MINUTE_MS`・`HOUR_MS`・`DAY_MS`・`MS_PER_DAY`・
 *   `SECONDS_PER_MINUTE`・`SECONDS_PER_HOUR`・`SECONDS_PER_DAY`・`MINUTES_PER_HOUR`・`HOURS_PER_DAY`）の定義は、`src/core/time-units.ts`
 *   だけに書く。
 * - (b) 時間の単位の掛け算と割り算の形（`* 1000`・`* 1_000`・`1000 *`・`/ 1000`、`60 * 60`・`24 * 60`・`60 * 1000`、`* 60_000`・
 *   `60_000 *`・`* 3_600_000`・`* 86_400…`）を、`src/core/time-units.ts` の外のコード（コメントと文字列を除いた本文）に書かない。
 *   名前つきの長さの値そのもの（`const X_MS = 60_000;` など。掛け算でない）は数えない（誤検出が多いため。CCX-19 の報告）。
 * - 除外（閉じた一覧。使われなくなった除外も誤りにする）: 今はない。T30g の画面のサーバのファイル（`write-job-functions.ts`）の単位の定数は、
 *   T31h-2 の後に `src/core/time-units.ts` の `MINUTE_MS` に置き換えて、除外から外した。`src/control/approval/execution-grant.ts` と
 *   `src/worker/` は、今は当たる形がない（並行の作業の後で確かめ直す所）。
 * - 対象は `src/**` と、画面の `apps/local-ui/src/**`（`.ts`、`.tsx`）。1 ファイル 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, loadLocalUiSourceFiles, loadSourceFiles, scanSource, startCpuStopwatch, type SourceFile } from './source-scan.js';

const SOURCE_FILES: readonly SourceFile[] = [...loadSourceFiles(), ...loadLocalUiSourceFiles()];
const TIME_UNITS_OWNER = 'src/core/time-units.ts';

/** 置き換えを見送る定義（`<path>:<行> <本文>` の頭。理由つき）。今はない（T31h-2 の後に、画面のサーバの 1 つを置き換えた）。 */
const DEFERRED_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({});

/** (a) 時間の単位の定数の定義。 */
const UNIT_CONSTANT_DEFINITION =
  /\b(?:const|let|var)\s+(?:MILLISECONDS_PER_SECOND|MS_PER_SECOND|SECOND_MS|MINUTE_MS|HOUR_MS|DAY_MS|MS_PER_DAY|SECONDS_PER_MINUTE|SECONDS_PER_HOUR|SECONDS_PER_DAY|MINUTES_PER_HOUR|HOURS_PER_DAY)\s*[:=]/u;

/** (b) 時間の単位の掛け算と割り算の形。 */
const UNIT_ARITHMETIC_SHAPES: readonly RegExp[] = [
  /[*/]\s*1_?000\b(?![._\d])/u,
  /\b1_?000\s*\*/u,
  /\b60\s*\*\s*(?:60|1_?000)\b/u,
  /\b24\s*\*\s*60\b/u,
  /[*/]\s*60_?000\b/u,
  /\b60_?000\s*\*/u,
  /[*/]\s*3_?600_?000\b/u,
  /[*/]\s*86_?400(?:_?000)?\b/u,
];

/** 本文（コメントと文字列の中身を除いた形）の行のうち、形に当たる行（`<path>:<行> <行の本文>`）。 */
const matchingLines = (file: Pick<SourceFile, 'path' | 'bare'>, shapes: readonly RegExp[]): readonly string[] =>
  file.bare.split('\n').flatMap((line, index) =>
    (shapes.some((shape) => shape.test(line)) ? [`${file.path}:${String(index + 1)} ${line.trim()}`] : []));

describe('Gate: the time units have one owner (CCX-19)', () => {
  it('defines the time unit constants only in src/core/time-units.ts', () => {
    const stopwatch = startCpuStopwatch();
    const matched = SOURCE_FILES.filter(({ path }) => path !== TIME_UNITS_OWNER).flatMap((file) => matchingLines(file, [UNIT_CONSTANT_DEFINITION]));
    const pathOf = (line: string): string => line.slice(0, line.indexOf(':'));
    expect(matched.filter((line) => DEFERRED_DEFINITIONS[pathOf(line)] === undefined)).toEqual([]);
    // 使われなくなった除外を残さない。
    expect(Object.keys(DEFERRED_DEFINITIONS).filter((path) => !matched.some((line) => pathOf(line) === path))).toEqual([]);
    expect(SOURCE_FILES.find(({ path }) => path === TIME_UNITS_OWNER)?.bare).toMatch(/export const MINUTE_MS = /u);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * SOURCE_FILES.length);
  });

  it('writes no time unit arithmetic outside src/core/time-units.ts', () => {
    const stopwatch = startCpuStopwatch();
    const found = SOURCE_FILES.filter(({ path }) => path !== TIME_UNITS_OWNER).flatMap((file) => matchingLines(file, UNIT_ARITHMETIC_SHAPES));
    expect(found).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * SOURCE_FILES.length);
  });

  it('finds the shapes placed on purpose, and does not count named values, comments and strings (the control)', () => {
    const shapesOf = (source: string): readonly string[] => matchingLines({ path: 'control.ts', ...scanSource(source) }, UNIT_ARITHMETIC_SHAPES);
    for (const source of [
      'const a = seconds * 1000;', 'const b = seconds * 1_000;', 'const c = 1_000 * seconds;', 'const d = ms / 1000;',
      'const e = 60 * 60 * x;', 'const f = 24 * 60 * 60;', 'const g = minutes * 60_000;', 'const h = 60 * 1000;', 'const i = days * 86_400_000;',
    ]) {
      expect(shapesOf(source), source).toHaveLength(1);
    }
    for (const source of [
      'const LIMIT_MS = 60_000;', 'const MAX_ITEMS = 1_000;', '// seconds * 1000', "const text = 'x * 1000';", 'const big = n * 10_000;',
      'const ratio = n * 1000.5;', 'const step = 5 * MINUTE_MS;',
    ]) {
      expect(shapesOf(source), source).toEqual([]);
    }
    const definitions = (source: string): readonly string[] => matchingLines({ path: 'control.ts', ...scanSource(source) }, [UNIT_CONSTANT_DEFINITION]);
    expect(definitions('const SECOND_MS = 1_000;')).toHaveLength(1);
    expect(definitions('import { SECOND_MS } from "../core/time-units.js";')).toEqual([]);
  });
});
