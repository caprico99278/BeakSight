/**
 * SLIM-1: 遅い組（`tests/suites.ts` の `SLOW_TEST_FILES`）に入れる構造の条件を、テストの側のファイル（`tests/`・`apps/local-ui/tests/`）の
 * import と文字列の走査だけで求める（Architecture Gate `tests/architecture/test-suites.test.ts` が、一覧と条件が合うかを確かめる）。
 * - `BUILT_PRODUCT`: 一時ビルドの本番（CLI・ワーカー）を子の process で動かす（`tests/helpers/temporary-build.ts` か `tests/helpers/cli-process.ts` へ、
 *   実行時の import でたどれる）。
 * - `UI_SERVER`: 画面のサーバを起こす（たどれるファイルが `startLauncher*`・`startDevServer`・`run*UntilExit` を呼ぶ。定義の置き場 `local-server.ts` は除く）。
 * - `CLI_CHROMIUM`: CLI の Chromium を起こす（`tests/helpers/chromium.ts` から `launchCliChromium*`・`BOTH_CHROMIUM_LAUNCHERS`・`chromiumRunsOf`（SLIM-B0。
 *   2 つの Chromium の組の入口。既定は CLI の起動の設定の 1 つ）を import する、`.each` に
 *   2 つの Chromium の組を書く、または部品（テストでないモジュール）が export する、CLI の Chromium を使う値や関数を import する。最後は X3 の抜け道）。
 * 条件を見るのは結合（`tests/integration/`）、ずれの確かめ（`tests/contract/`。RB-3）と画面（`apps/local-ui/tests/`）のテストだけ。`tests/architecture/` は対照の文字列を持つので、読みもしない。
 */
import { escapeRegExp, findNamedImports, findRuntimeModuleSpecifiers, readLfTypeScriptFilesUnder, resolveImportTarget, scanSource } from './source-scan.js';

export type SlowCriterion = 'BUILT_PRODUCT' | 'UI_SERVER' | 'CLI_CHROMIUM';

/** テストの側のフォルダ。 */
export const TEST_SIDE_DIRECTORIES: readonly string[] = Object.freeze(['tests', 'apps/local-ui/tests']);
/** 構造の条件を見るテストのフォルダ（単体・部品・architecture は、条件によらず速い組）。 */
const GROUPED_TEST_DIRECTORIES: readonly string[] = Object.freeze(['tests/integration/', 'tests/contract/', 'apps/local-ui/tests/']);
const CHROMIUM_HELPER = 'tests/helpers/chromium.ts';
const BUILT_PRODUCT_HELPERS: readonly string[] = Object.freeze(['tests/helpers/temporary-build.ts', 'tests/helpers/cli-process.ts']);
const UI_SERVER_DEFINITIONS = 'apps/local-ui/tests/helpers/local-server.ts';
const UI_SERVER_START_CALL = /\b(?:startLauncher\w*|startDevServer|run\w*UntilExit)\s*\(/u;
const CLI_CHROMIUM_NAME = /^(?:launchCliChromium\w*|BOTH_CHROMIUM_LAUNCHERS|chromiumRunsOf)$/u;

/**
 * TEST-TIME-A: `BOTH_CHROMIUM_LAUNCHERS` を import しない 2 つの Chromium の組（子のプロセスの入口に埋める起動の組 `['CLI', 'TEST_DEFAULT']`・
 * `RUN_BROWSERS`・`LOGIN_LAUNCHES` など）。`.each` に渡す一覧（その場の配列か、同じファイルの `const` の初期値）に、CLI の側の目印と、テストの
 * 既定の側の目印の両方があれば、2 つの Chromium の組とみなす（近似。正規表現だけ）。
 */
export const CLI_CHROMIUM_MARK = /'CLI'|"CLI"|\bthe CLI\b|\blaunchCliChromium\b/u;
export const DEFAULT_CHROMIUM_MARK = /'TEST_DEFAULT'|"TEST_DEFAULT"|\bTEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE\b|\bthe default test Chromium\b|\blaunchTestDefaultChromium\b|\blaunchHeadlessChromium\b/u;
const INLINE_EACH_LIST = /\.each\s*(?:<[^>]*>)?\(\s*(\[[\s\S]*?\])\s*(?:as\s+const\s*)?\)\s*\(/gu;
const NAMED_EACH_LIST = /\.each\s*(?:<[^>]*>)?\(\s*([A-Za-z_$][\w$]*)\s*\)/gu;

/** 同じファイルの `const`（`let`）の宣言の本文（行の終わりの `;` まで）。無ければ空。 */
const declarationTextOf = (code: string, name: string): string =>
  new RegExp(String.raw`(?:const|let)\s+${escapeRegExp(name)}(?![\w$])[\s\S]*?;[ \t]*$`, 'mu').exec(code)?.[0] ?? '';

/** `code`（コメントを除いた本文）が、`.each` で 2 つの Chromium の組を流すか。 */
export const usesTwoChromiumList = (code: string): boolean => [
  ...[...code.matchAll(INLINE_EACH_LIST)].map((match) => match[1] ?? ''),
  ...[...code.matchAll(NAMED_EACH_LIST)].map((match) => (match[1] === 'BOTH_CHROMIUM_LAUNCHERS' ? "'CLI' 'TEST_DEFAULT'" : declarationTextOf(code, match[1] ?? ''))),
].some((text) => CLI_CHROMIUM_MARK.test(text) && DEFAULT_CHROMIUM_MARK.test(text));

/** SLIM-B0: 2 つの Chromium の組の入口（`tests/helpers/chromium.ts`）の呼び出し。 */
const CHROMIUM_RUNS_ENTRY_CALL = /\bchromiumRunsOf\s*(?:<[^>]*>)?\(/u;
const EXPORTED_CONST_NAME = /^export\s+const\s+([A-Za-z_$][\w$]*)/gmu;

/**
 * SLIM-B0: 入口（`chromiumRunsOf`・`BOTH_CHROMIUM_LAUNCHERS`）を通らずに、2 つの Chromium の組を書いた所（`.each` に渡すその場の配列、`.each` に渡す
 * 同じファイルの宣言、部品が export する宣言の本文）。入口を通らない組は、遅い組で両方の Chromium を流してしまう（近似。正規表現だけ）。
 */
export const twoChromiumListsOutsideEntry = (code: string): string[] => [
  ...[...code.matchAll(INLINE_EACH_LIST)].map((match) => match[1] ?? ''),
  ...[...code.matchAll(NAMED_EACH_LIST)].filter((match) => match[1] !== 'BOTH_CHROMIUM_LAUNCHERS').map((match) => declarationTextOf(code, match[1] ?? '')),
  ...[...code.matchAll(EXPORTED_CONST_NAME)].map((match) => declarationTextOf(code, match[1] ?? '')),
].filter((text) => CLI_CHROMIUM_MARK.test(text) && DEFAULT_CHROMIUM_MARK.test(text) && !CHROMIUM_RUNS_ENTRY_CALL.test(text));

const EXPORT_START =/^export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/gmu;
const mentions = (text: string, name: string): boolean => new RegExp(String.raw`(?<![\w$])${escapeRegExp(name)}(?![\w$])`, 'u').test(text);

/**
 * X3: 部品（テストでないモジュール）の export のうち、CLI の Chromium を使うもの。export の宣言から次の export の宣言までを、その export の本文と
 * みなし（近似）、`cliNames`（そのモジュールが `chromium.ts` から import した CLI の Chromium の名前）か、同じモジュールの CLI を使う export を
 * 書いていれば、CLI を使う（`PROBE_SCENE_SEND_POLICY_CASES` が `PROBE_SCENE_LAUNCHERS` を使う形）。
 */
export const cliChromiumMembersOf = (code: string, cliNames: readonly string[]): ReadonlySet<string> => {
  const starts = [...code.matchAll(EXPORT_START)].map((match) => ({ name: match[1] ?? '', index: match.index }));
  const segments = starts.map((start, index) => ({ name: start.name, text: code.slice(start.index, starts[index + 1]?.index ?? code.length) }));
  const members = new Set<string>();
  for (let grew = cliNames.length > 0; grew;) {
    grew = false;
    for (const { name, text } of segments) {
      if (!members.has(name) && [...cliNames, ...members].some((used) => mentions(text, used))) {
        members.add(name);
        grew = true;
      }
    }
  }
  return members;
};

/** 走査したテストの側のファイル（パス → コメントを除いた本文）。 */
export const readTestSideCode = (): ReadonlyMap<string, string> => new Map(readLfTypeScriptFilesUnder(TEST_SIDE_DIRECTORIES)
  .filter(({ path }) => !path.startsWith('tests/architecture/'))
  .map(({ path, content }) => [path, scanSource(content).code]));

/** `path` の名前つきの import のうち、`files` の中のファイル `target` から読む名前。 */
const namesImportedFrom = (files: ReadonlyMap<string, string>, path: string, code: string): readonly (readonly [string, string])[] =>
  findNamedImports(code).flatMap(({ specifier, names }) => {
    const target = resolveImportTarget(files, path, specifier);
    return target === undefined ? [] : names.map((name) => [target, name.split(/\s+as\s+/u)[0] ?? name] as const);
  });

/** テストの側の走査の結果。 */
export interface TestSideAnalysis {
  /** テストのファイル（`*.test.ts`）ごとの、遅い組の構造の条件（当たらないファイルは載せない）。 */
  readonly criteria: ReadonlyMap<string, ReadonlySet<SlowCriterion>>;
  /** 部品の export を通して CLI の Chromium を使うテストのファイル（X3。`chromium.ts` を直に import するものは含まない）。 */
  readonly cliChromiumThroughModules: readonly string[];
}

export const analyzeTestSide = (files: ReadonlyMap<string, string>): TestSideAnalysis => {
  const imports = new Map([...files].map(([path, code]) => [path, namesImportedFrom(files, path, code)]));
  const edges = new Map([...files].map(([path, code]) => [path, findRuntimeModuleSpecifiers(code)
    .map((specifier) => resolveImportTarget(files, path, specifier))
    .filter((target): target is string => target !== undefined)]));
  const cliNamesOf = (path: string): string[] => (imports.get(path) ?? []).filter(([target, name]) => target === CHROMIUM_HELPER && CLI_CHROMIUM_NAME.test(name)).map(([, name]) => name);
  const cliMembers = new Map([...files]
    .filter(([path]) => path !== CHROMIUM_HELPER && !path.endsWith('.test.ts'))
    .map(([path, code]) => [path, cliChromiumMembersOf(code, cliNamesOf(path))] as const)
    .filter(([, members]) => members.size > 0));
  const usesCliMember = (test: string): boolean => (imports.get(test) ?? []).some(([target, name]) => cliMembers.get(target)?.has(name) === true);
  const result = new Map<string, ReadonlySet<SlowCriterion>>();
  for (const [test, code] of files) {
    if (!test.endsWith('.test.ts') || !GROUPED_TEST_DIRECTORIES.some((directory) => test.startsWith(directory))) {
      continue;
    }
    const reached = new Set([test]);
    for (const queue = [test]; queue.length > 0;) {
      for (const next of edges.get(queue.shift() ?? '') ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    const criteria = new Set<SlowCriterion>();
    if (BUILT_PRODUCT_HELPERS.some((helper) => reached.has(helper))) {
      criteria.add('BUILT_PRODUCT');
    }
    if ([...reached].some((path) => path !== UI_SERVER_DEFINITIONS && UI_SERVER_START_CALL.test(files.get(path) ?? ''))) {
      criteria.add('UI_SERVER');
    }
    if (cliNamesOf(test).length > 0 || usesTwoChromiumList(code) || usesCliMember(test)) {
      criteria.add('CLI_CHROMIUM');
    }
    if (criteria.size > 0) {
      result.set(test, criteria);
    }
  }
  return {
    criteria: result,
    cliChromiumThroughModules: [...files.keys()].filter((path) => path.endsWith('.test.ts') && usesCliMember(path)).sort(),
  };
};
