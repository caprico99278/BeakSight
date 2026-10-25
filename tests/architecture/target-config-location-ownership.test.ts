/**
 * T43b fix round 1（共通化）: 対象の設定のファイルの置き場所と、画面の「1 行に 1 つ」の欄の読み方の owner の Gate。
 * - (a) 対象の設定のファイルの置き場所の文字列（`config/targets`・`local/targets`）を、コードの文字列リテラルに書くのは owner
 *   `src/control/target-config-locations.ts` だけ（`src/**` と `apps/local-ui/src/**`。利用者に見せる文の `src/presentation/` は除く）。
 *   CLI の既定の置き場所（`src/config/load-config.ts` の `resolve(cwd, 'config', 'targets')`）は、CLI が `src/control/` を読み込まない決まり
 *   （`cli-control-boundary`）のため、別の意味として owner の外に残す（区切りの `/` を含まないので、この検査には当たらない）。
 * - (b) 画面の「1 行に 1 つ」の欄の読み方（`linesOf`）と書き方（`textOfLines`）を定義するのは `apps/local-ui/src/display/form-lines.ts` だけ。
 *   行の区切りの正規表現（`\r?\n`）も、ほかの画面のコードに書かない。
 * - 判定は、`fs`、正規表現、文字列の検索だけで行う（`source-scan.ts` の走査を共用する）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { MAX_GATE_MS, loadLocalUiSourceFiles, loadSourceFiles, startCpuStopwatch, type SourceFile } from './source-scan.js';

const LOCATION_OWNER = 'src/control/target-config-locations.ts';
const FORM_LINES_OWNER = 'apps/local-ui/src/display/form-lines.ts';
/** 利用者に見せる文（置き場所を文で案内する）。 */
const PRESENTATION_DIRECTORY = 'src/presentation/';
/** 置き場所の文字列。 */
const LOCATION_LITERAL = /(?:^|[^\w])(?:config|local)\/targets(?:\/|$|[^\w])/u;
/** 「1 行に 1 つ」の関数の定義。 */
const FORM_LINES_DEFINITION = /\b(?:const|function)\s+(?:linesOf|textOfLines)\b/u;
/** 行の区切りの正規表現（`/\r?\n/`）。 */
const LINE_BREAK_REGEX = /\/\\r\?\\n\//u;

const SRC_FILES = loadSourceFiles();
const UI_FILES = loadLocalUiSourceFiles();

/** (a) 置き場所の文字列を書いた、owner の外のファイル。 */
const locationLiteralViolations = (files: readonly SourceFile[]): readonly string[] => files
  .filter((file) => file.path !== LOCATION_OWNER && !file.path.startsWith(PRESENTATION_DIRECTORY))
  .flatMap((file) => file.literals.filter((literal) => LOCATION_LITERAL.test(literal)).map((literal) => `${file.path}: ${literal}`));

/** (b) 「1 行に 1 つ」の関数か行の区切りの正規表現を書いた、owner の外のファイル。 */
const formLinesViolations = (files: readonly SourceFile[]): readonly string[] => files
  .filter((file) => file.path !== FORM_LINES_OWNER)
  .filter((file) => FORM_LINES_DEFINITION.test(file.code) || LINE_BREAK_REGEX.test(file.code))
  .map((file) => file.path);

describe('T43b fix round 1: the owners of the target configuration places and of the one-per-line fields', () => {
  it('detects the literals and the definitions (the detection works)', () => {
    const scanned = (path: string, literals: readonly string[], code = ''): SourceFile =>
      ({ path, content: code, code, bare: code, literals, wholeLiterals: [] });
    expect(locationLiteralViolations([
      scanned('src/control/a.ts', ['local/targets/']),
      scanned('src/control/b.ts', ['config/targets']),
      scanned('src/presentation/messages.ts', ['local/targets/ の中']),
      scanned(LOCATION_OWNER, ['local/targets/']),
      scanned('src/control/c.ts', ['mylocal/targetsx']),
    ])).toEqual(['src/control/a.ts: local/targets/', 'src/control/b.ts: config/targets']);
    expect(formLinesViolations([
      scanned('apps/local-ui/src/a.tsx', [], 'const linesOf = (text) => text;'),
      scanned('apps/local-ui/src/b.tsx', [], 'const x = text.split(/\\r?\\n/u);'),
      scanned(FORM_LINES_OWNER, [], 'export const linesOf = (text) => text.split(/\\r?\\n/u);'),
    ])).toEqual(['apps/local-ui/src/a.tsx', 'apps/local-ui/src/b.tsx']);
  });

  it('(a) writes the target configuration places only in src/control/target-config-locations.ts', () => {
    const stopwatch = startCpuStopwatch();
    expect(SRC_FILES.some((file) => file.path === LOCATION_OWNER)).toBe(true);
    expect(locationLiteralViolations([...SRC_FILES, ...UI_FILES])).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('(b) defines the one-per-line field reading only in apps/local-ui/src/display/form-lines.ts', () => {
    const stopwatch = startCpuStopwatch();
    expect(UI_FILES.some((file) => file.path === FORM_LINES_OWNER)).toBe(true);
    expect(formLinesViolations(UI_FILES)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
