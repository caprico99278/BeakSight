/**
 * CCX-11（CC-063、CC-059、CC-062、CC-058）: core などの 1 か所にまとめた小さな部品が、ほかの場所で作り直されないための Architecture Gate。
 * 判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` の `scanSource` と `loadSourceFiles` を共用する）。近似の検査である。
 * - (a) CC-063: 14 桁の UTC の時刻の読み戻し（`parseCompactUtcTimestamp`、`dateOfCompactUtcTimestamp` の定義と、`Date.UTC(` の呼び出し）は、
 *   `src/core/utc-timestamp.ts` だけに書く。
 * - (b) CC-059: SHA-256 の 16 進（`sha256HexOfBytes`、`sha256HexOfText`）の定義は、`src/core/ids.ts` だけに書く。
 * - (c) CC-062: rename のやり直しの決まり（`renameWithRetry` と、`RENAME_RETRY`・`RENAME_MAX_ATTEMPTS` を含む名前の定数の定義、失敗のコードの一覧の
 *   `['EPERM', 'EBUSY', 'EACCES']`）は `src/core/rename-retry.ts` だけに、誤りのコードの取り出し（`errorCodeOf` の定義）は
 *   `src/core/errors.ts` だけに書く。
 *   CCX-12（CC-073）: 誤りのコードのインラインの取り出しの形も、`src/core/errors.ts` の外に書かない（`isRecord(x) && x.code`、
 *   `isRecord(x) && typeof x.code`、`(x as …).code`、`'code' in x`、`Reflect.get(x, 'code')`、`.code` か `['code']` と `'E…'` の文字列
 *   （`ENOENT` など）との比べ）。型の付いた引数の `error.code` と、定数との比べは数えない（近似）。文字列を残す本文（`code`）で探す形は、
 *   文字列の中も数える（厳しい側の近似）。
 * - (d) CC-058: `--headless` に当たる設定の上書き（`browser: { headed: false }` の形）は、`src/config/config-overrides.ts` だけに書く。
 *   PRE42-CC 組 5a: `--headed` に当たる上書き（`browser: { headed: true }` の形）も同じ owner だけに書く（`HEADED_CONFIG_OVERRIDES`）。
 * - (e) CCX-12（CC-078 の後半）: 鍵を並べる処理（`withSortedKeys`・`sortedKeysJsonOf` の定義と、`Object.keys(…).sort(`・
 *   `Object.entries(…).sort(`・`Object.getOwnPropertyNames(…).sort(` の形。`toSorted` も）は、`src/core/sorted-keys-json.ts` だけに書く。
 * - (f) CCX-12（CC-076）: `_method` の欄の名前の判定（`isMethodOverrideFieldName` の定義と、`METHOD_OVERRIDE_FIELD_NAME` か `'_method'` の
 *   文字列との比べ）と、実際の method の式（`effectiveFormMethodOf` の定義と、`methodOverride !== null ? …methodOverride :`・
 *   `methodOverride === null ? …formMethod : …methodOverride`・`methodOverride ?? …formMethod` の形）は、`src/discovery/candidate-contracts.ts`
 *   だけに書く。ブラウザの中で動く probe の関数（引数で受けた名前と比べる）は、この形に当たらない。
 * - (g) CCX-25（CC-087 の前半）: JSON Pointer（RFC 6901）の区切りの書き方と戻し方（`escapeJsonPointerSegment`・`unescapeJsonPointerSegment`・
 *   `jsonPointerOf`・`jsonPointerSegmentsOf` の定義と、書き方の文字列 `'~0'`・`'~1'`）は、`src/core/json-pointer.ts` だけに書く。
 *   再 export と呼び出しは数えない。文字列は、それだけの文字列（`'~0'` など）を数える（文字列を残す本文 `code` で探す）。
 * - (h) PRE42-CC 組 5a（CC-048）: 実行の記録の「最後の実行」を選ぶ形（`…executions.at(-1)`・`…executions[….length - 1]`。名前に
 *   `executions` を含む値。大文字小文字を問わない）は、表示用モデルの `executionsView`（`src/report/view-model.ts`）の 1 か所だけに書く。
 *   表示用モデルを読めない所の、別の記録の読み取りは、ファイルと形の組で、理由を付けて除外する（同じファイルでも、新しい所は検出する）。
 *   CLI の古い補助 `lastExecutionFinishedAt` の定義も数える（CLI は表示用モデルの `executions.lastFinishedAt` を読む）。
 *   PRE42-CC 組 UI-K（CC-048 の画面の側）: 選び方を純粋な `lastRunExecutionOf`（`src/core/run-executions.ts`）の 1 か所に移した。表示用モデルの
 *   `executionsView`、画面のサーバ（`run.json` の読み取り）、再開の判定（チェックポイントの読み取り）は、どれもそれを使う（除外は 0 件）。
 * - (i) PRE42-CC 組 5a（台帳の N1 の B）: 誤りの値を「`Error` なら `message`、そうでなければ `String(…)`」にする式
 *   （`x instanceof Error ? x.message : String(x)`）と `errorMessageOrString` の定義は、`src/core/errors.ts` だけに書く。
 *   画面の起動の部品（`apps/local-ui/launcher/`）は、実行時に core を読めないので、対象の外（設計者の判断。launcher の中に補助を 1 つ置く）。
 *   PRE42-CC 組 R: launcher の中では、同じ式と `errorMessageOrString` の定義を、launcher の補助（`apps/local-ui/launcher/error-message.ts`）
 *   だけに書く（`serve.ts`・`vite-guard-plugin.ts` は、それを読む）。
 * - 対象は `src/**` と、画面の `apps/local-ui/src/**`（`.ts`、`.tsx`）。読み込みと走査は、このファイルの読み込み時に 1 回だけ。
 *   ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_UI_SOURCE_DIRECTORY,
  MAX_GATE_MS,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  loadTypeScriptFilesUnder,
  sourceFileOf,
  startCpuStopwatch,
  unusedExclusionsOf,
  violationsOf,
  type SourceFile,
} from './source-scan.js';

/** 画面のソース（`apps/local-ui/src/**` の `.ts` と `.tsx`）は、`source-scan.ts` の `loadLocalUiSourceFiles` で 1 回だけ読み込み、走査する。 */
const SOURCE_FILES: readonly SourceFile[] = [...loadSourceFiles(), ...loadLocalUiSourceFiles()];

const UTC_TIMESTAMP_OWNER = 'src/core/utc-timestamp.ts';
const SHA256_OWNER = 'src/core/ids.ts';
const RENAME_RETRY_OWNER = 'src/core/rename-retry.ts';
const ERROR_CODE_OWNER = 'src/core/errors.ts';
const CONFIG_OVERRIDES_OWNER = 'src/config/config-overrides.ts';
const SORTED_KEYS_OWNER = 'src/core/sorted-keys-json.ts';
const METHOD_OVERRIDE_OWNER = 'src/discovery/candidate-contracts.ts';
const JSON_POINTER_OWNER = 'src/core/json-pointer.ts';

/** `bare`（コメントと文字列の中身を除いた本文）の中の、`name` の定義（`const`・`let`・`var`・`function`・`class`）。 */
const definitionsOf = (bare: string, names: readonly string[]): readonly string[] =>
  names.flatMap((name) =>
    [...bare.matchAll(new RegExp(`\\b(?:const|let|var|function\\*?|class)\\s+${name}\\b`, 'gu'))].map((match) => match[0].replace(/\s+/gu, ' ')));

/** (a) 14 桁の UTC の時刻の読み戻し。 */
const findCompactTimestampReaders = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['parseCompactUtcTimestamp', 'dateOfCompactUtcTimestamp']),
  ...[...file.bare.matchAll(/\bDate\s*\.\s*UTC\s*\(/gu)].map(() => 'Date.UTC('),
];

/** (b) SHA-256 の 16 進。 */
const findSha256HexDefinitions = (file: SourceFile): readonly string[] => definitionsOf(file.bare, ['sha256HexOfBytes', 'sha256HexOfText']);

/** (c) rename のやり直しの決まり（名前の定義と、失敗のコードの一覧）。 */
const RENAME_RETRY_CODE_LIST = /\[\s*(['"])EPERM\1\s*,\s*(['"])EBUSY\2\s*,\s*(['"])EACCES\3\s*\]/gu;
const findRenameRetryRules = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['renameWithRetry']),
  ...[...file.bare.matchAll(/\b(?:const|let|var)\s+(\w*RENAME_(?:RETRY|MAX_ATTEMPTS)\w*)\b/gu)].map((match) => `const ${match[1] ?? ''}`),
  ...[...file.code.matchAll(RENAME_RETRY_CODE_LIST)].map(() => "['EPERM', 'EBUSY', 'EACCES']"),
];

/** 本文の中の、`shapes` のどれかに当たる所（空白を 1 つにまとめた形）。 */
const matchesOf = (text: string, shapes: readonly RegExp[]): readonly string[] =>
  shapes.flatMap((shape) => [...text.matchAll(shape)].map((match) => match[0].replace(/\s+/gu, ' ')));

/** (c) 誤りのコードのインラインの取り出しの形（CCX-12。CC-073）。`bare` の形はコメントと文字列の中身を除き、`code` の形は文字列を残す。 */
const INLINE_ERROR_CODE_BARE_SHAPES: readonly RegExp[] = [
  /\bisRecord\s*\(\s*([\w$]+)\s*\)\s*&&\s*(?:typeof\s+)?\1\s*\.\s*code\b/gu,
  /\(\s*[\w$.]+\s+as\s+[^()]*\)\s*\.\s*code\b/gu,
];
const INLINE_ERROR_CODE_CODE_SHAPES: readonly RegExp[] = [
  /(['"`])code\1\s+in\s+[\w$]/gu,
  /\bReflect\s*\.\s*get\s*\(\s*[\w$.]+\s*,\s*(['"`])code\1/gu,
  /(?:\.\s*code\b|\[\s*(['"`])code\1\s*\])\s*[!=]==?\s*(['"`])E[A-Z0-9]+\2/gu,
];

/** (c) 誤りのコードの取り出し（`errorCodeOf` の定義と、インラインの取り出しの形）。 */
const findErrorCodeReaders = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['errorCodeOf']),
  ...matchesOf(file.bare, INLINE_ERROR_CODE_BARE_SHAPES),
  ...matchesOf(file.code, INLINE_ERROR_CODE_CODE_SHAPES),
];

/** (d) `--headless`・`--headed` に当たる設定の上書きの形（`code`。コメントを除く）。 */
const HEADLESS_OVERRIDE_SHAPE = /\bbrowser\s*:\s*\{\s*headed\s*:\s*(?:true|false)\s*,?\s*\}/gu;
const findHeadlessOverrides = (file: SourceFile): readonly string[] =>
  [...file.code.matchAll(HEADLESS_OVERRIDE_SHAPE)].map((match) => match[0].replace(/\s+/gu, ' '));

/** (e) 鍵を並べる処理（定義と、`Object.keys(…).sort(` の形。`bare`）。 */
const KEY_SORT_SHAPE = /\bObject\s*\.\s*(?:keys|entries|getOwnPropertyNames)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.\s*(?:sort|toSorted)\s*\(/gu;
const findKeySorters = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['withSortedKeys', 'sortedKeysJsonOf']),
  ...matchesOf(file.bare, [KEY_SORT_SHAPE]),
];

/** (f) `_method` の欄の名前の判定と、実際の method の式（定義と式の形）。 */
const METHOD_OVERRIDE_BARE_SHAPES: readonly RegExp[] = [
  /[!=]==?\s*METHOD_OVERRIDE_FIELD_NAME\b|\bMETHOD_OVERRIDE_FIELD_NAME\s*[!=]==?/gu,
  /\bmethodOverride\s*!==?\s*null\s*\?\s*(?:[\w$]+\s*\.\s*)?methodOverride\s*:/gu,
  /\bmethodOverride\s*===?\s*null\s*\?\s*(?:[\w$]+\s*\.\s*)?formMethod\s*:\s*(?:[\w$]+\s*\.\s*)?methodOverride\b(?!\s*\()/gu,
  /\bmethodOverride\s*\?\?\s*(?:[\w$]+\s*\.\s*)?formMethod\b/gu,
];
const METHOD_OVERRIDE_CODE_SHAPES: readonly RegExp[] = [/[!=]==?\s*(['"`])_method\1|(['"`])_method\2\s*[!=]==?/giu];
const findMethodOverrideRules = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['isMethodOverrideFieldName', 'effectiveFormMethodOf']),
  ...matchesOf(file.bare, METHOD_OVERRIDE_BARE_SHAPES),
  ...matchesOf(file.code, METHOD_OVERRIDE_CODE_SHAPES),
];

/** (g) JSON Pointer の区切りの書き方と戻し方（定義と、書き方の文字列 `'~0'`・`'~1'`）。 */
const JSON_POINTER_ESCAPE_LITERAL = /(['"`])~[01]\1/gu;
const findJsonPointerEscapes = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['escapeJsonPointerSegment', 'unescapeJsonPointerSegment', 'jsonPointerOf', 'jsonPointerSegmentsOf']),
  ...matchesOf(file.code, [JSON_POINTER_ESCAPE_LITERAL]),
];

/** (h) 「最後の実行」を選ぶ形（`bare`）と、CLI の古い補助の定義。 */
const LAST_EXECUTION_SHAPES: readonly RegExp[] = [
  /(?:[\w$]+\s*\??\.\s*)*[\w$]*executions\s*\??\.\s*at\s*\(\s*-\s*1\s*\)/giu,
  /(?:[\w$]+\s*\??\.\s*)*[\w$]*executions\s*(?:\?\.\s*)?\[\s*(?:[\w$]+\s*\??\.\s*)*[\w$]*executions\s*\??\.\s*length\s*-\s*1\s*\]/giu,
];
/** 前の段で、`executions` を含まない本文を除く（形の正規表現は前に名前の連なりを読むので、すべての本文に当てると遅い）。 */
const MENTIONS_EXECUTIONS = /executions/iu;
const findLastExecutionSelections = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['lastExecutionFinishedAt']),
  ...(MENTIONS_EXECUTIONS.test(file.bare) ? matchesOf(file.bare, LAST_EXECUTION_SHAPES) : []),
];
const LAST_EXECUTION_OWNER = 'src/core/run-executions.ts';
/** (h) owner の中の、ただ 1 つの選び方（`lastRunExecutionOf`。組 UI-K）。 */
const LAST_EXECUTION_OWNER_SELECTIONS: readonly string[] = ['executions.at(-1)'];
/**
 * (h) の除外（`<ファイル>: <形>` と理由）。除外の一覧は、このファイルの中の 1 か所だけ。組 UI-K: 再開の判定（`run-coordinator.ts`）と画面のサーバ
 * （`audit-job-functions.ts`）の 2 件は、owner の `lastRunExecutionOf` を使うようにしたので消した。
 */
const LAST_EXECUTION_EXCLUSIONS: ReadonlyMap<string, string> = new Map([]);

/** (i) 誤りの値を「`Error` なら `message`、そうでなければ `String(…)`」にする式（`bare`）と、`errorMessageOrString` の定義。 */
const ERROR_MESSAGE_OR_STRING_SHAPE = /\binstanceof\s+Error\s*\?\s*([\w$]+)\s*\.\s*message\s*:\s*String\s*\(\s*\1\s*\)/gu;
const findErrorMessageOrStrings = (file: SourceFile): readonly string[] => [
  ...definitionsOf(file.bare, ['errorMessageOrString']),
  ...matchesOf(file.bare, [ERROR_MESSAGE_OR_STRING_SHAPE]),
];

/** (i) 画面の起動の部品（実行時に core を読めない）と、その中の補助の owner（PRE42-CC 組 R）。読み込みと走査は 1 回だけ。 */
const LAUNCHER_DIRECTORY = 'apps/local-ui/launcher';
const LAUNCHER_ERROR_MESSAGE_OWNER = `${LAUNCHER_DIRECTORY}/error-message.ts`;
const LAUNCHER_FILES: readonly SourceFile[] = loadTypeScriptFilesUnder(LAUNCHER_DIRECTORY);

const violationsOutside = (owner: string, find: (file: SourceFile) => readonly string[]): readonly string[] =>
  violationsOf(SOURCE_FILES.filter((file) => file.path !== owner), find);

const ownerFile = (owner: string): SourceFile | undefined => SOURCE_FILES.find((file) => file.path === owner);

/** 対照の例のファイル（`source-scan.ts` の `sourceFileOf`。PRE42-CC 組 G）。 */
const sample = sourceFileOf;

describe('CCX-11 detectors', () => {
  it('(a) detects definitions of the compact timestamp readers and Date.UTC calls, and ignores comments, strings and uses', () => {
    const file = sample('src/control/sample.ts', [
      'export const dateOfCompactUtcTimestamp = (value: string): Date => new Date(value);',
      'function parseCompactUtcTimestamp(value: string) { return null; }',
      'const time = Date . UTC(2026, 0, 1);',
      'const used = dateOfCompactUtcTimestamp(value);',
      '// const parseCompactUtcTimestamp = Date.UTC(1);',
      "const text = 'const dateOfCompactUtcTimestamp = Date.UTC(';",
    ].join('\n'));
    expect(findCompactTimestampReaders(file)).toEqual([
      'function parseCompactUtcTimestamp',
      'const dateOfCompactUtcTimestamp',
      'Date.UTC(',
    ]);
  });

  it('(b) detects definitions of the SHA-256 hex helpers', () => {
    const file = sample('src/control/sample.ts', [
      'export const sha256HexOfBytes = (bytes: Uint8Array): string => bytes.join();',
      'function sha256HexOfText(value: string): string { return value; }',
      'const digest = sha256HexOfBytes(bytes);',
    ].join('\n'));
    expect(findSha256HexDefinitions(file)).toEqual(['const sha256HexOfBytes', 'function sha256HexOfText']);
  });

  it('(c) detects the rename retry rule and the error code readers', () => {
    const file = sample('src/report/sample.ts', [
      "export const CREDENTIAL_RENAME_RETRY_ERROR_CODES = Object.freeze(['EPERM', 'EBUSY', 'EACCES'] as const);",
      'export const RENAME_MAX_ATTEMPTS = 5;',
      "export const CONTROL_RENAME_TO_RECREATE_TEXT = 'rename';",
      'async function renameWithRetry(from: string, to: string) {}',
      'const codes = ["EPERM","EBUSY","EACCES"];',
      'const errorCodeOf = (error: unknown): string | null => null;',
      'const used = errorCodeOf(error) ?? RENAME_MAX_ATTEMPTS;',
      "// ['EPERM', 'EBUSY', 'EACCES']",
    ].join('\n'));
    expect(findRenameRetryRules(file)).toEqual([
      'function renameWithRetry',
      'const CREDENTIAL_RENAME_RETRY_ERROR_CODES',
      'const RENAME_MAX_ATTEMPTS',
      "['EPERM', 'EBUSY', 'EACCES']",
      "['EPERM', 'EBUSY', 'EACCES']",
    ]);
    expect(findErrorCodeReaders(file)).toEqual(['const errorCodeOf']);
  });

  it('(c) detects the inline error code readers (CCX-12), and ignores comments, strings, typed parameters and other records', () => {
    const file = sample('src/cli/sample.ts', [
      "if (isRecord(error) && error.code === 'ENOENT') {}",
      "const found = isRecord(cause) && typeof cause.code === 'string';",
      'const code = (error as NodeJS.ErrnoException).code;',
      'const other = (error as { code?: unknown }).code;',
      "const has = 'code' in error;",
      "const read = Reflect.get(error, 'code');",
      `const missing = failure.code !== 'ENOTDIR' || failure['code'] === "EPERM";`,
      "// if (isRecord(error) && error.code === 'ENOENT') {}",
      // 文字列の中身を残す形（`'code' in`、`Reflect.get`、`'E…'` との比べ）は、文字列の中も数える（厳しい側の近似）。ほかの形は数えない。
      `const text = "isRecord(error) && error.code; (error as Error).code";`,
      'const typed = (error: NodeJS.ErrnoException) => error.code === UPSTREAM_RESET_ERROR_CODE;',
      'const reason = isRecord(value) && isIncompleteReasonCode(value.code);',
      "const severity = rule.severity === 'ERROR';",
      'const used = errorCodeOf(error) === FILE_NOT_FOUND;',
    ].join('\n'));
    expect(findErrorCodeReaders(file)).toEqual([
      'isRecord(error) && error.code',
      'isRecord(cause) && typeof cause.code',
      '(error as NodeJS.ErrnoException).code',
      '(error as { code?: unknown }).code',
      "'code' in e",
      "Reflect.get(error, 'code'",
      ".code === 'ENOENT'",
      ".code !== 'ENOTDIR'",
      `['code'] === "EPERM"`,
    ]);
  });

  it('(d) detects the headless and headed override shapes, and ignores comments and other browser settings', () => {
    const file = sample('src/worker/sample.ts', [
      'export const OVERRIDES = deepFreeze({ browser: { headed: false } });',
      'const b = { browser: {',
      '  headed: false,',
      '} };',
      'const c = { browser: { headed: true } };',
      "const d = { browser: { headed: false, locale: 'ja-JP' } };",
      'const e = { browser: { headed: values.headed } };',
      '// { browser: { headed: true } }',
    ].join('\n'));
    expect(findHeadlessOverrides(file)).toEqual(['browser: { headed: false }', 'browser: { headed: false, }', 'browser: { headed: true }']);
  });

  it('(e) detects the key sorting (CCX-12), and ignores comments, strings and other sorts', () => {
    const file = sample('src/control/sample.ts', [
      'const withSortedKeys = (value: unknown): unknown => value;',
      'Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));',
      'const keys = Object . keys(record(value)).sort(compareCodeUnits);',
      'const entries = Object.entries(value).toSorted(([left], [right]) => compareCodeUnits(left, right));',
      'const names = Object.getOwnPropertyNames(value).sort();',
      'const json = sortedKeysJsonOf(value);',
      'const sorted = [...Object.keys(value)].sort();',
      'const values = Object.values(value).sort();',
      '// Object.keys(value).sort()',
      "const text = 'Object.keys(value).sort()';",
    ].join('\n'));
    expect(findKeySorters(file)).toEqual([
      'const withSortedKeys',
      'Object.keys(value).sort(',
      'Object . keys(record(value)).sort(',
      'Object.entries(value).toSorted(',
      'Object.getOwnPropertyNames(value).sort(',
    ]);
  });

  it('(f) detects the _method field name rule and the effective method expression (CCX-12), and ignores the probe and the display', () => {
    const file = sample('src/control/sample.ts', [
      'const isOverride = foldNfkcCase(fieldName) === METHOD_OVERRIDE_FIELD_NAME;',
      'const reversed = METHOD_OVERRIDE_FIELD_NAME !== name;',
      `const literal = name.toLowerCase() === '_method' || "_METHOD" == name;`,
      "const method = formMethod === 'POST' && methodOverride !== null ? methodOverride : formMethod;",
      'const method2 = candidate.methodOverride === null ? candidate.formMethod : candidate.methodOverride;',
      'const method3 = candidate.methodOverride ?? candidate.formMethod;',
      'function isMethodOverrideFieldName(name: string) { return false; }',
      'const effective = effectiveFormMethodOf(candidate);',
      'const field = { methodOverrideFieldName: METHOD_OVERRIDE_FIELD_NAME };',
      "if (tag === 'input' && name.toLowerCase() === input.methodOverrideFieldName) {}",
      'const shown = candidate.methodOverride === null ? candidate.formMethod : text.methodOverride(candidate.formMethod, candidate.methodOverride);',
      'const override = methodOverride === null ? null : SCENARIO_METHOD_OVERRIDES.find((value) => value === methodOverride);',
      "// foldNfkcCase(name) === METHOD_OVERRIDE_FIELD_NAME, name === '_method'",
      "const message = 'the method override field _method';",
    ].join('\n'));
    expect(findMethodOverrideRules(file)).toEqual([
      'function isMethodOverrideFieldName',
      '=== METHOD_OVERRIDE_FIELD_NAME',
      'METHOD_OVERRIDE_FIELD_NAME !==',
      'methodOverride !== null ? methodOverride :',
      'methodOverride === null ? candidate.formMethod : candidate.methodOverride',
      'methodOverride ?? candidate.formMethod',
      "=== '_method'",
      '"_METHOD" ==',
    ]);
  });

  it('(g) detects the JSON Pointer escaping (CCX-25), and ignores comments, uses, re-exports and longer strings', () => {
    const file = sample('apps/local-ui/src/server/sample.ts', [
      "const escapeJsonPointerSegment = (segment: string): string => segment.split('~').join('~0').split('/').join(\"~1\");",
      'function jsonPointerSegmentsOf(pointer: string) { return pointer.split(`~1`); }',
      'const pointer = jsonPointerOf([name]);',
      'const segments = jsonPointerSegmentsOf(pointer).map(unescapeJsonPointerSegment);',
      "export { escapeJsonPointerSegment } from './json-pointer.js';",
      "// segment.split('~1').join('/').split('~0').join('~')",
      "const text = 'a~0b';",
      "const tilde = '~';",
    ].join('\n'));
    expect(findJsonPointerEscapes(file)).toEqual([
      'const escapeJsonPointerSegment',
      'function jsonPointerSegmentsOf',
      "'~0'",
      '"~1"',
      '`~1`',
    ]);
  });

  it('(h) detects the last execution selections and the old CLI helper (CC-048), and ignores comments, strings and other lists', () => {
    const file = sample('src/cli/sample.ts', [
      "const ended = run.executions.at(-1)?.endReason === 'STOPPED_BY_SITE_UNAVAILABLE';",
      'const last = summary.run.executions?.at( - 1 );',
      'const last2 = run.executions[run.executions.length - 1];',
      'const last3 = resumedExecutions.at(-1) ?? first;',
      'const lastExecutionFinishedAt = (executions: readonly RunExecution[]): string => executions[0].finishedAt;',
      'const first = run.executions.at(0);',
      'const page = pages.at(-1);',
      'const finished = viewModel.summary.executions.lastFinishedAt;',
      '// run.executions.at(-1)',
      "const text = 'executions.at(-1)';",
    ].join('\n'));
    expect(findLastExecutionSelections(file)).toEqual([
      'const lastExecutionFinishedAt',
      'run.executions.at(-1)',
      'summary.run.executions?.at( - 1 )',
      'resumedExecutions.at(-1)',
      'run.executions[run.executions.length - 1]',
    ]);
  });

  it('(i) detects the error message or string expression (N1), and ignores comments, strings and other fallbacks', () => {
    const file = sample('apps/local-ui/src/server/sample.ts', [
      'const a = error instanceof Error ? error.message : String(error);',
      'const b = cause instanceof Error ? cause . message : String( cause );',
      'export const errorMessageOrString = (error: unknown): string => String(error);',
      'const c = error instanceof Error ? error.message : String(other);',
      "const d = error instanceof Error ? error.message : 'unknown';",
      'const e = errorMessageOrString(error);',
      '// error instanceof Error ? error.message : String(error)',
      "const text = 'error instanceof Error ? error.message : String(error)';",
    ].join('\n'));
    expect(findErrorMessageOrStrings(file)).toEqual([
      'const errorMessageOrString',
      'instanceof Error ? error.message : String(error)',
      'instanceof Error ? cause . message : String( cause )',
    ]);
  });
});

describe('CCX-11 Gate: small parts have one owner each', () => {
  it('reads the owners once', () => {
    for (const owner of [
      UTC_TIMESTAMP_OWNER, SHA256_OWNER, RENAME_RETRY_OWNER, ERROR_CODE_OWNER, CONFIG_OVERRIDES_OWNER, SORTED_KEYS_OWNER, METHOD_OVERRIDE_OWNER,
      JSON_POINTER_OWNER, LAST_EXECUTION_OWNER,
    ]) {
      expect(ownerFile(owner), owner).toBeDefined();
    }
    expect(SOURCE_FILES.some((file) => file.path.startsWith(`${LOCAL_UI_SOURCE_DIRECTORY}/`))).toBe(true);
  });

  it('(a) the compact UTC timestamp is read back only in src/core/utc-timestamp.ts (CC-063)', () => {
    expect(violationsOutside(UTC_TIMESTAMP_OWNER, findCompactTimestampReaders)).toEqual([]);
    expect(findCompactTimestampReaders(ownerFile(UTC_TIMESTAMP_OWNER) ?? sample(UTC_TIMESTAMP_OWNER, ''))).not.toEqual([]);
  });

  it('(b) the SHA-256 hex helpers are defined only in src/core/ids.ts (CC-059)', () => {
    expect(violationsOutside(SHA256_OWNER, findSha256HexDefinitions)).toEqual([]);
    expect(findSha256HexDefinitions(ownerFile(SHA256_OWNER) ?? sample(SHA256_OWNER, ''))).not.toEqual([]);
  });

  it('(c) the rename retry rule is written only in src/core/rename-retry.ts, and errorCodeOf only in src/core/errors.ts (CC-062)', () => {
    expect(violationsOutside(RENAME_RETRY_OWNER, findRenameRetryRules)).toEqual([]);
    expect(findRenameRetryRules(ownerFile(RENAME_RETRY_OWNER) ?? sample(RENAME_RETRY_OWNER, ''))).not.toEqual([]);
    expect(violationsOutside(ERROR_CODE_OWNER, findErrorCodeReaders)).toEqual([]);
    expect(findErrorCodeReaders(ownerFile(ERROR_CODE_OWNER) ?? sample(ERROR_CODE_OWNER, ''))).not.toEqual([]);
  });

  it('(d) the headless and headed overrides are written only in src/config/config-overrides.ts (CC-058)', () => {
    expect(violationsOutside(CONFIG_OVERRIDES_OWNER, findHeadlessOverrides)).toEqual([]);
    expect(findHeadlessOverrides(ownerFile(CONFIG_OVERRIDES_OWNER) ?? sample(CONFIG_OVERRIDES_OWNER, ''))).toEqual([
      'browser: { headed: false }',
      'browser: { headed: true }',
    ]);
  });

  it('(e) the keys are sorted only in src/core/sorted-keys-json.ts (CC-078)', () => {
    expect(violationsOutside(SORTED_KEYS_OWNER, findKeySorters)).toEqual([]);
    expect(findKeySorters(ownerFile(SORTED_KEYS_OWNER) ?? sample(SORTED_KEYS_OWNER, ''))).not.toEqual([]);
  });

  it('(f) the _method field name and the effective method are decided only in src/discovery/candidate-contracts.ts (CC-076)', () => {
    expect(violationsOutside(METHOD_OVERRIDE_OWNER, findMethodOverrideRules)).toEqual([]);
    expect(findMethodOverrideRules(ownerFile(METHOD_OVERRIDE_OWNER) ?? sample(METHOD_OVERRIDE_OWNER, ''))).not.toEqual([]);
  });

  it('(g) the JSON Pointer segments are escaped and unescaped only in src/core/json-pointer.ts (CC-087)', () => {
    expect(violationsOutside(JSON_POINTER_OWNER, findJsonPointerEscapes)).toEqual([]);
    expect(findJsonPointerEscapes(ownerFile(JSON_POINTER_OWNER) ?? sample(JSON_POINTER_OWNER, ''))).not.toEqual([]);
  });

  it('(h) the last execution is chosen only in lastRunExecutionOf of src/core/run-executions.ts (CC-048, PRE42-CC group UI-K)', () => {
    const found = violationsOutside(LAST_EXECUTION_OWNER, findLastExecutionSelections);
    expect(found.filter((entry) => !LAST_EXECUTION_EXCLUSIONS.has(entry))).toEqual([]);
    expect(findLastExecutionSelections(ownerFile(LAST_EXECUTION_OWNER) ?? sample(LAST_EXECUTION_OWNER, ''))).toEqual(LAST_EXECUTION_OWNER_SELECTIONS);
  });

  it('(h) every exclusion of the last execution selections is still used, so that stale exclusions do not hide new ones', () => {
    expect(unusedExclusionsOf(LAST_EXECUTION_EXCLUSIONS.keys(), violationsOutside(LAST_EXECUTION_OWNER, findLastExecutionSelections))).toEqual([]);
  });

  it('(i) the error message or string expression is written only in src/core/errors.ts (N1)', () => {
    expect(violationsOutside(ERROR_CODE_OWNER, findErrorMessageOrStrings)).toEqual([]);
    expect(findErrorMessageOrStrings(ownerFile(ERROR_CODE_OWNER) ?? sample(ERROR_CODE_OWNER, ''))).toEqual([
      'const errorMessageOrString',
      'instanceof Error ? error.message : String(error)',
    ]);
  });

  it('(i) in the launcher, the error message or string expression is written only in launcher/error-message.ts (N1, PRE42-CC group R)', () => {
    const stopwatch = startCpuStopwatch();
    // 空の走査で PASS しない（起動の部品の 2 つの入口が見えている）。
    expect(LAUNCHER_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([
      `${LAUNCHER_DIRECTORY}/serve.ts`,
      `${LAUNCHER_DIRECTORY}/vite-guard-plugin.ts`,
    ]));
    expect(violationsOf(LAUNCHER_FILES.filter((file) => file.path !== LAUNCHER_ERROR_MESSAGE_OWNER), findErrorMessageOrStrings)).toEqual([]);
    const owner = LAUNCHER_FILES.find((file) => file.path === LAUNCHER_ERROR_MESSAGE_OWNER) ?? sample(LAUNCHER_ERROR_MESSAGE_OWNER, '');
    expect(findErrorMessageOrStrings(owner)).toEqual([
      'const errorMessageOrString',
      'instanceof Error ? error.message : String(error)',
    ]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * Math.max(LAUNCHER_FILES.length, 1));
  });
});
