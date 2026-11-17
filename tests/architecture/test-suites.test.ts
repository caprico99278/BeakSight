/**
 * テストの組の一覧の Architecture Gate（TS-a。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.1）。
 * - 組の一覧（`tests/suites.ts` の安全の一覧・CLI の回の一覧・重い組の一覧）のファイルが実在し、一覧の中で重ならない。
 * - CLI の回の一覧は安全の一覧の内にあり、安全の一覧と重い組の一覧は重ならない。重い組は結合のファイルだけ。
 * - `tests/` のテストのファイルは、どれもルートの Vitest の設定の project のちょうど 1 つに入る（どの組にも入らずに流れないファイルがない）。
 *   結合のファイルは、重い組の一覧にあれば `heavy`、なければ `integration` に入る。
 * - npm の scripts は、テストのファイルの一覧と、CLI の回の環境変数を書き写さない（一覧と環境変数は起動の部品が `tests/suites.ts` から読む）。
 * - CLI の回の環境変数は、テストの既定の Chromium の切り替えの口（`tests/helpers/chromium.ts`）と同じ名前と値。
 * - TS-a の発見事項 2・TS-b: テストの回を切り替える環境変数（CLI の回と全部の組）の名前は、`tests/helpers/test-run-environment.ts` にだけ書く
 *   （テストのファイル、起動の部品、Vitest の設定、npm の scripts に書き写さない）。
 * - TS-b: 回数を重ねるテストの回数は `tests/helpers/test-rounds.ts` にだけ書き、テストのファイルは `roundsOf` で読む。全部の組の値は、TS-b の前の
 *   回数と同じ（安全の確かめの強さを落とさない）。ふだんの組の値は 1 以上で、全部の組の値以下。全部の組（`test:full`）は、どの回にも全部の組の
 *   環境変数を渡す。
 * - SLIM-B0: 2 つの Chromium の組は、入口（`tests/helpers/chromium.ts` の `chromiumRunsOf`）を通し、既定は CLI の起動の設定の 1 つだけ。両方に広げるのは
 *   `safety` と `related --with-safety`・`--both-chromium` だけ。漏れの確かめの一覧は「両方に広げる一覧」で、遅い組の一覧の和には入れない。
 * - 判定は、`fs` とパスの照合と、`source-scan.ts` の文字列の走査だけ。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestProjectConfiguration } from 'vitest/config';
import vitestConfig from '../../vitest.config.js';
import * as chromiumHelpers from '../helpers/chromium.js';
import { roundsOf, TEST_ROUNDS, type TestRoundsName } from '../helpers/test-rounds.js';
import {
  BOTH_CHROMIUM_ENVIRONMENT_VARIABLE,
  BOTH_CHROMIUM_RUN_ENVIRONMENT,
  BOTH_CHROMIUM_SELECTION,
  CLI_CHROMIUM_RUN_ENVIRONMENT,
  CLI_CHROMIUM_SELECTION,
  FULL_TEST_TIER,
  FULL_TEST_TIER_RUN_ENVIRONMENT,
  isBothChromiumSelected,
  isFullTestTier,
  TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE,
  TEST_TIER_ENVIRONMENT_VARIABLE,
} from '../helpers/test-run-environment.js';
import { findNamedImports, readLfTextFile, readLfTypeScriptFilesUnder, scanSource } from './source-scan.js';
import {
  analyzeTestSide,
  cliChromiumMembersOf,
  readTestSideCode,
  twoChromiumListsOutsideEntry,
  usesTwoChromiumList,
  type SlowCriterion,
} from './test-group-criteria.js';
import { COMPONENT_TEST_LEDGER } from '../component-test-ledger.js';
import { coversOf } from '../related-selection.js';
import {
  BOTH_CHROMIUM_LEAK_CHECK_FILES,
  CHROMIUM_UPGRADE_TEST_FILES,
  CLI_CHROMIUM_TEST_FILES,
  CONTRACT_PATH_TEST_FILES,
  CONTRACT_PORT_TEST_FILES,
  HEAVY_PROJECT_NAME,
  HEAVY_TEST_FILES,
  INTEGRATION_PROJECT_INCLUDE,
  INTEGRATION_PROJECT_NAME,
  SAFETY_TEST_FILES,
  SLOW_BUILT_PRODUCT_TEST_FILES,
  SLOW_CLI_CHROMIUM_LAUNCH_TEST_FILES,
  SLOW_LONG_TEST_FILES,
  SLOW_TEST_FILES,
  SLOW_UI_SERVER_TEST_FILES,
  UNIT_PROJECT_NAME,
} from '../suites.js';

/** project の名前・読むファイル・除くファイル・並列の数・組の順。 */
interface ProjectShape {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxWorkers: number | string | undefined;
  readonly groupOrder: number | undefined;
  readonly globalSetup: readonly string[];
}

function projectShapeOf(project: TestProjectConfiguration): ProjectShape {
  if (typeof project !== 'object' || project instanceof Promise) {
    throw new Error('the root Vitest projects must be inline objects (not a glob, a function or a promise)');
  }
  const test = project.test ?? {};
  if (typeof test.name !== 'string') {
    throw new Error('each root Vitest project must have a string name');
  }
  return {
    name: test.name,
    include: test.include ?? [],
    exclude: test.exclude ?? [],
    maxWorkers: test.maxWorkers,
    groupOrder: test.sequence?.groupOrder,
    globalSetup: test.globalSetup === undefined ? [] : [test.globalSetup].flat(),
  };
}

const PROJECTS: readonly ProjectShape[] = (vitestConfig.test?.projects ?? []).map(projectShapeOf);

/** `tests/` の下のテストのファイル（`/` の区切りの、リポジトリの root からの相対のパス）。 */
const TEST_FILES: readonly string[] = (readdirSync('tests', { recursive: true, encoding: 'utf8' }) as string[])
  .map((path) => posix.join('tests', path.replaceAll('\\', '/')))
  .filter((path) => path.endsWith('.test.ts'))
  .sort();

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => posix.matchesGlob(file, pattern));
}

function projectsOf(file: string): string[] {
  return PROJECTS.filter((project) => matchesAny(file, project.include) && !matchesAny(file, project.exclude)).map((project) => project.name);
}

function duplicatesOf(list: readonly string[]): string[] {
  return list.filter((item, index) => list.indexOf(item) !== index);
}

const LISTS: readonly (readonly [string, readonly string[]])[] = [
  ['SAFETY_TEST_FILES', SAFETY_TEST_FILES],
  ['CLI_CHROMIUM_TEST_FILES', CLI_CHROMIUM_TEST_FILES],
  ['HEAVY_TEST_FILES', HEAVY_TEST_FILES],
];

describe('TS-a: the test suite lists in tests/suites.ts', () => {
  it.each(LISTS)('%s names existing test files without duplicates', (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((file) => !existsSync(file) || !file.endsWith('.test.ts'))).toEqual([]);
    expect(duplicatesOf(list)).toEqual([]);
  });

  it('the CLI run list is a part of the safety list', () => {
    expect(CLI_CHROMIUM_TEST_FILES.filter((file) => !SAFETY_TEST_FILES.includes(file))).toEqual([]);
  });

  it('the safety list and the heavy list do not overlap, and the heavy list has only integration files', () => {
    expect(HEAVY_TEST_FILES.filter((file) => SAFETY_TEST_FILES.includes(file))).toEqual([]);
    expect(HEAVY_TEST_FILES.filter((file) => !matchesAny(file, INTEGRATION_PROJECT_INCLUDE))).toEqual([]);
  });

  it('the CLI run environment is the switch of the test default Chromium', () => {
    expect(CLI_CHROMIUM_RUN_ENVIRONMENT).toEqual({ [TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE]: CLI_CHROMIUM_SELECTION });
    // テストの既定の Chromium の切り替えの口は、同じ 1 か所の名前と値を読む（書き写さない）。
    expect(chromiumHelpers.TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE).toBe(TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE);
    expect(chromiumHelpers.CLI_CHROMIUM_SELECTION).toBe(CLI_CHROMIUM_SELECTION);
  });
});

/** テストの回を切り替える環境変数の名前の、ただ 1 つの置き場所。 */
const TEST_RUN_ENVIRONMENT_FILE = 'tests/helpers/test-run-environment.ts';
/** 組を流す起動の部品。 */
const RUN_SUITE_FILE = 'tests/run-suite.mjs';

/** 本文（改行は LF。読み込みは `source-scan.ts` の `readLfTypeScriptFilesUnder`・`readLfTextFile`）の、文字列リテラルの中身。 */
const literalsOf = (content: string): readonly string[] => scanSource(content).literals;

describe('TS-b: the environment variables of the test runs are written in one place', () => {
  const names = [TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE, TEST_TIER_ENVIRONMENT_VARIABLE, BOTH_CHROMIUM_ENVIRONMENT_VARIABLE];
  const copiesIn = (files: readonly { readonly path: string; readonly content: string }[]): string[] => files
    .filter(({ path }) => path !== TEST_RUN_ENVIRONMENT_FILE)
    .flatMap(({ path, content }) => names.filter((name) => literalsOf(content).some((literal) => literal.includes(name))).map((name) => `${path}: ${name}`));

  it('no test file, helper, launcher, config or script writes the names outside tests/helpers/test-run-environment.ts', () => {
    const files = [
      ...readLfTypeScriptFilesUnder(['tests', 'apps/local-ui/tests']),
      { path: RUN_SUITE_FILE, content: readLfTextFile(RUN_SUITE_FILE) },
      { path: 'vitest.config.ts', content: readLfTextFile('vitest.config.ts') },
      { path: 'package.json', content: readLfTextFile('package.json') },
    ];
    expect(files.some(({ path }) => path === TEST_RUN_ENVIRONMENT_FILE)).toBe(true);
    expect(copiesIn(files)).toEqual([]);
  });

  it('detects a copied name (control)', () => {
    expect(copiesIn([
      { path: 'tests/integration/a.test.ts', content: `const tier = process.env['${TEST_TIER_ENVIRONMENT_VARIABLE}'];` },
      { path: 'tests/integration/b.test.ts', content: `// ${TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE} is read in the helper` },
      { path: TEST_RUN_ENVIRONMENT_FILE, content: `export const NAME = '${TEST_TIER_ENVIRONMENT_VARIABLE}';` },
    ])).toEqual([`tests/integration/a.test.ts: ${TEST_TIER_ENVIRONMENT_VARIABLE}`]);
  });

  it('the full suite passes the full tier to every step', () => {
    expect(FULL_TEST_TIER_RUN_ENVIRONMENT).toEqual({ [TEST_TIER_ENVIRONMENT_VARIABLE]: FULL_TEST_TIER });
    const launcher = scanSource(readLfTextFile(RUN_SUITE_FILE)).code;
    expect(findNamedImports(launcher).filter(({ names }) => names.includes('FULL_TEST_TIER_RUN_ENVIRONMENT')).map(({ specifier }) => specifier))
      .toEqual(['./helpers/test-run-environment.ts']);
    expect(launcher).toMatch(/\bfull\s*:\s*withEnvironment\(\s*FULL_TEST_TIER_RUN_ENVIRONMENT\s*,/u);
  });
});

/**
 * TS-b: 回数を重ねるテストの、TS-b の前の回数（全部の組の値。設計書 5 章の受け入れ条件 3「全部の組の回数が、今の回数と同じ」）。
 * 値を下げるときは、設計を改めてから、ここも改める。
 */
const FULL_ROUNDS_BEFORE_TS_B: Readonly<Record<TestRoundsName, number>> = Object.freeze({
  popupCloseRaceBurst: 20,
  popupCloseRaceStorm: 40,
  frozenPopupAudit: 10,
  frozenPopupSelfClose: 5,
  frozenCloseRace: 10,
  // TS-f: `gateS04PopupFormPost`（5）は、同じ確かめの `frozenPopupAudit`（10。多い側）にまとめて捨てた。
  gateS04PopupSelfClose: 3,
  unloadBeaconClose: 5,
  unloadBeaconSelfNavigation: 3,
  profileConcurrentUpdate: 5,
  profileHeldTransactionKill: 3,
  profileLoopKill: 3,
  iframeSrcChurnClose: 20,
  isolatedElementSwap: 300,
});

/** 回数を重ねるテストのファイルと、そこが `roundsOf` で読む場面の名前（場面ごとに、読むファイルはちょうど 1 つ）。 */
const ROUND_READERS: Readonly<Record<string, readonly TestRoundsName[]>> = Object.freeze({
  'tests/integration/guard-popup-close-race.test.ts': ['popupCloseRaceBurst', 'popupCloseRaceStorm'],
  'tests/integration/isolated-interaction-cases.ts': ['frozenPopupSelfClose', 'frozenCloseRace'],
  'tests/integration/safety-gates.test.ts': ['frozenPopupAudit', 'gateS04PopupSelfClose'],
  'tests/helpers/gate-harness.ts': ['unloadBeaconClose', 'unloadBeaconSelfNavigation'],
  'tests/integration/control-profile-processes.test.ts': ['profileConcurrentUpdate', 'profileHeldTransactionKill', 'profileLoopKill'],
  'tests/integration/passive-request-guard-browser.test.ts': ['iframeSrcChurnClose'],
  'tests/integration/isolated-element-bridge.test.ts': ['isolatedElementSwap'],
});

/** 回数を数で書いた定数（`const X_ROUNDS = 5` の形。型の注釈を挟む形を含む）。 */
const LITERAL_ROUNDS_PATTERN = /\bconst\s+[A-Z0-9_]*ROUNDS[A-Z0-9_]*\s*(?::\s*number\s*)?=\s*\d/u;

/** `code`（コメントを除いた本文）が `roundsOf('<name>')` で読む場面の名前。 */
const roundNamesReadIn = (code: string): string[] => [...code.matchAll(/\broundsOf\(\s*'([A-Za-z0-9]+)'/gu)].map((match) => match[1] ?? '');

describe('TS-b: the rounds of the repeating tests are in tests/helpers/test-rounds.ts', () => {
  it('every scene has 1 <= regular <= full, and the full values are the rounds before TS-b', () => {
    const entries = Object.entries(TEST_ROUNDS);
    expect(entries.filter(([, { regular, full }]) => !Number.isInteger(regular) || !Number.isInteger(full) || regular < 1 || regular > full)).toEqual([]);
    expect(Object.fromEntries(entries.map(([name, { full }]) => [name, full]))).toEqual(FULL_ROUNDS_BEFORE_TS_B);
  });

  it('roundsOf picks the full value only in the full tier', () => {
    expect(isFullTestTier({ [TEST_TIER_ENVIRONMENT_VARIABLE]: FULL_TEST_TIER })).toBe(true);
    expect(isFullTestTier({})).toBe(false);
    expect(isFullTestTier({ [TEST_TIER_ENVIRONMENT_VARIABLE]: 'FULL' })).toBe(false);
    for (const [name, { regular, full }] of Object.entries(TEST_ROUNDS) as [TestRoundsName, { readonly regular: number; readonly full: number }][]) {
      expect(roundsOf(name, FULL_TEST_TIER_RUN_ENVIRONMENT), name).toBe(full);
      expect(roundsOf(name, {}), name).toBe(regular);
      expect(roundsOf(name, { [TEST_TIER_ENVIRONMENT_VARIABLE]: 'regular' }), name).toBe(regular);
    }
  });

  it('the repeating tests read their rounds with roundsOf and write no round count as a number', () => {
    const problems: string[] = [];
    for (const [path, expected] of Object.entries(ROUND_READERS)) {
      if (!existsSync(path)) {
        problems.push(`${path}: missing`);
        continue;
      }
      const { code } = scanSource(readLfTextFile(path));
      if (LITERAL_ROUNDS_PATTERN.test(code)) {
        problems.push(`${path}: a round count written as a number`);
      }
      const read = [...new Set(roundNamesReadIn(code))].sort();
      if (JSON.stringify(read) !== JSON.stringify([...expected].sort())) {
        problems.push(`${path}: reads ${JSON.stringify(read)} (expected ${JSON.stringify([...expected].sort())})`);
      }
    }
    expect(problems).toEqual([]);
    expect(Object.values(ROUND_READERS).flat().sort()).toEqual(Object.keys(TEST_ROUNDS).sort());
  });

  it('detects a round count written as a number and a scene read by name (control)', () => {
    expect(LITERAL_ROUNDS_PATTERN.test('const BURST_ROUNDS = 20;')).toBe(true);
    expect(LITERAL_ROUNDS_PATTERN.test('const ROUNDS_PER_SCENARIO = 20;')).toBe(true);
    expect(LITERAL_ROUNDS_PATTERN.test('export const UNLOAD_BEACON_CLOSE_ROUNDS: number = 5;')).toBe(true);
    expect(LITERAL_ROUNDS_PATTERN.test("const BURST_ROUNDS = roundsOf('popupCloseRaceBurst');")).toBe(false);
    expect(LITERAL_ROUNDS_PATTERN.test('const WORKER_WEBSOCKET_ROUNDS = UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS;')).toBe(false);
    expect(roundNamesReadIn("const A = roundsOf('popupCloseRaceBurst');\nconst B = roundsOf( 'popupCloseRaceStorm' );"))
      .toEqual(['popupCloseRaceBurst', 'popupCloseRaceStorm']);
  });
});

/** 走査したテストのファイル（`code` はコメントを除いた本文）。 */
interface ScannedTestFile {
  readonly path: string;
  readonly code: string;
}

/** テストの側のファイル（対照の文字列を持つ Gate は除く。部品を含む）を、1 回だけ走査する（SLIM-1 の組の検査と共有）。 */
const TEST_SIDE_CODE = readTestSideCode();
const TEST_SIDE_ANALYSIS = analyzeTestSide(TEST_SIDE_CODE);

/** テストのファイル（helpers は除く）。 */
const scannedTestFiles = (): readonly ScannedTestFile[] => [...TEST_SIDE_CODE]
  .filter(([path]) => path.endsWith('.test.ts') && !path.startsWith('tests/helpers/'))
  .map(([path, code]) => ({ path, code }));

/** `tests/helpers/chromium.ts` から、名前 `name` を import しているテストのファイル。 */
const testFilesImportingChromiumHelper = (files: readonly ScannedTestFile[], name: string): string[] => files
  .filter(({ code }) => importsChromiumHelper(code, name))
  .map(({ path }) => path)
  .sort();

const importsChromiumHelper = (code: string, name: string): boolean =>
  findNamedImports(code).some(({ specifier, names }) => /(?:^|\/)helpers\/chromium\.js$/u.test(specifier) && names.includes(name));

/**
 * TEST-SLIM H0: CLI の Chromium をファイルの中で直接起動するテストのファイルの数の上限（第 4 波の後の数。151 → 79 → 28）。2 つの Chromium の組は、新しいファイルでは
 * `BOTH_CHROMIUM_LAUNCHERS` を使う。第 2 波（W2・L2・M4）で、安全の漏れの確かめでないファイルを既定の Chromium だけにしたら、この値を下げる。
 */
const DIRECT_CLI_CHROMIUM_FILES_CEILING = 28;

// TEST-TIME-A の 2 つの Chromium の組の見分け（`usesTwoChromiumList`）は、SLIM-1 で `test-group-criteria.ts` に移した（遅い組の条件と共有）。
describe('TEST-SLIM H0: the two Chromium runs are only for the safety leak checks', () => {
  const files = scannedTestFiles();
  const allowed = new Set([...SAFETY_TEST_FILES, ...BOTH_CHROMIUM_LEAK_CHECK_FILES]);

  it('BOTH_CHROMIUM_LAUNCHERS and chromiumRunsOf are used only by the safety list and the leak check list', () => {
    expect(testFilesImportingChromiumHelper(files, 'BOTH_CHROMIUM_LAUNCHERS').filter((path) => !allowed.has(path))).toEqual([]);
    // CLI の Chromium を直接 import するファイル（数の上限の検査が見る）は、`.each` の組の検査と同じく除く。
    const directCli = new Set(testFilesImportingChromiumHelper(files, 'launchCliChromium'));
    expect(testFilesImportingChromiumHelper(files, 'chromiumRunsOf').filter((path) => !allowed.has(path) && !directCli.has(path))).toEqual([]);
    expect(BOTH_CHROMIUM_LEAK_CHECK_FILES.filter((file) => !existsSync(file) || SAFETY_TEST_FILES.includes(file))).toEqual([]);
  });

  // TEST-TIME-A: CLI の Chromium を直接 import するファイル（数の上限の検査が見る）は除く。
  it('a two Chromium list in .each (the launch settings of a child entry included) is used only by the safety list and the leak check list', () => {
    const directCli = new Set(testFilesImportingChromiumHelper(files, 'launchCliChromium'));
    const twoChromium = files.filter(({ path, code }) => !directCli.has(path) && usesTwoChromiumList(code)).map(({ path }) => path);
    expect(twoChromium.filter((path) => !allowed.has(path))).toEqual([]);
  });

  // SLIM-1（X3）: 部品（テストでないモジュール）の export を通して CLI の Chromium を使うファイルも見る（`PROBE_SCENE_LAUNCHERS` の形）。
  it('a two Chromium list or launch exported by a helper module is used only by the safety list and the leak check list', () => {
    expect(TEST_SIDE_ANALYSIS.cliChromiumThroughModules.length).toBeGreaterThan(0);
    expect(TEST_SIDE_ANALYSIS.cliChromiumThroughModules.filter((path) => !allowed.has(path))).toEqual([]);
  });

  it('finds the exports of a helper module that use the CLI Chromium (control)', () => {
    const helper = [
      "export const LAUNCHERS = [['default', () => launchHeadlessChromium()], ['cli', () => launchCliChromium()]] as const;",
      'export const CASES = LAUNCHERS.flatMap(([name, launch]) => [[name, launch, 1]]);',
      'export const WAIT_MS = 800;',
      'export function registerCases(): void {\n  describe.each(CASES)("x", () => {});\n}',
    ].join('\n');
    expect([...cliChromiumMembersOf(helper, ['launchCliChromium'])].sort()).toEqual(['CASES', 'LAUNCHERS', 'registerCases']);
    expect([...cliChromiumMembersOf(helper, [])]).toEqual([]);
  });

  it('detects the two Chromium lists (control)', () => {
    expect(usesTwoChromiumList("describe.each<WriteJobRunBrowser>(['CLI', 'TEST_DEFAULT'])('x (%s)', (runBrowser) => {});")).toBe(true);
    expect(usesTwoChromiumList("const RUN_BROWSERS = [\n  ['the default test Chromium', `() => ${TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE}`],\n  ['the CLI launch settings', 'undefined'],\n] as const;\ndescribe.each(RUN_BROWSERS)('x', () => {});")).toBe(true);
    expect(usesTwoChromiumList("const LOGIN_LAUNCHES: readonly (readonly [string, TestLoginWorkerLaunch])[] = [\n  ['the default test Chromium', 'TEST_DEFAULT'],\n  ['the CLI Chromium', 'CLI'],\n];\ndescribe.each(LOGIN_LAUNCHES)('x', () => {});")).toBe(true);
    expect(usesTwoChromiumList("describe.each(BOTH_CHROMIUM_LAUNCHERS)('x', () => {});")).toBe(true);
    expect(usesTwoChromiumList("const RUN_BROWSER: WriteJobRunBrowser = 'TEST_DEFAULT';\ndescribe.each(['READ_ONLY', 'PASS_EXCEPT_DELETE'])('x', () => {});")).toBe(false);
    expect(usesTwoChromiumList("const LOGIN_LAUNCHES = [['the default test Chromium', 'TEST_DEFAULT']] as const;\ndescribe.each(LOGIN_LAUNCHES)('x', () => {});")).toBe(false);
  });

  it('the files that launch the CLI Chromium directly do not increase', () => {
    expect(testFilesImportingChromiumHelper(files, 'launchCliChromium').length).toBeLessThanOrEqual(DIRECT_CLI_CHROMIUM_FILES_CEILING);
  });

  // SLIM-B0: 2 つの Chromium の組は、入口（`chromiumRunsOf`・`BOTH_CHROMIUM_LAUNCHERS`）を通す（遅い組と区切りでは CLI の起動の設定の 1 つだけになる）。
  it('every two Chromium list (in a test file or exported by a helper module) goes through the entry', () => {
    const outside = [...TEST_SIDE_CODE]
      .filter(([path]) => path !== 'tests/helpers/chromium.ts')
      .filter(([, code]) => twoChromiumListsOutsideEntry(code).length > 0)
      .map(([path]) => path);
    expect(outside).toEqual([]);
  });

  it('detects a two Chromium list outside the entry (control)', () => {
    expect(twoChromiumListsOutsideEntry("const LAUNCHERS = [\n  ['the default test Chromium', () => launchHeadlessChromium()],\n  ['the CLI Chromium', () => launchCliChromium()],\n] as const;\ndescribe.each(LAUNCHERS)('x', () => {});")).toHaveLength(1);
    expect(twoChromiumListsOutsideEntry("describe.each<WriteJobRunBrowser>(['CLI', 'TEST_DEFAULT'])('x (%s)', (runBrowser) => {});")).toHaveLength(1);
    expect(twoChromiumListsOutsideEntry("export const PROBE_LAUNCHERS = [\n  ['a', () => launchHeadlessChromium()],\n  ['b', () => launchCliChromium()],\n] as const;")).toHaveLength(1);
    expect(twoChromiumListsOutsideEntry("const LAUNCHERS = chromiumRunsOf([\n  ['the default test Chromium', () => launchHeadlessChromium()],\n  ['the CLI Chromium', () => launchCliChromium()],\n]);\ndescribe.each(LAUNCHERS)('x', () => {});")).toEqual([]);
    expect(twoChromiumListsOutsideEntry("describe.each<WriteJobRunBrowser>(chromiumRunsOf(['TEST_DEFAULT', 'CLI']))('x (%s)', (runBrowser) => {});")).toEqual([]);
    expect(twoChromiumListsOutsideEntry("describe.each(BOTH_CHROMIUM_LAUNCHERS)('x', () => {});")).toEqual([]);
  });

  it('the entry runs the CLI launch settings only, and both Chromium only in the run that spreads them', () => {
    expect(BOTH_CHROMIUM_RUN_ENVIRONMENT).toEqual({ [BOTH_CHROMIUM_ENVIRONMENT_VARIABLE]: BOTH_CHROMIUM_SELECTION });
    expect(isBothChromiumSelected(BOTH_CHROMIUM_RUN_ENVIRONMENT)).toBe(true);
    expect(isBothChromiumSelected({})).toBe(false);
    expect(isBothChromiumSelected({ [BOTH_CHROMIUM_ENVIRONMENT_VARIABLE]: 'BOTH' })).toBe(false);
    expect(chromiumHelpers.chromiumRunsOf(['default', 'cli'] as const)).toEqual(isBothChromiumSelected() ? ['default', 'cli'] : ['cli']);
    expect(chromiumHelpers.BOTH_CHROMIUM_LAUNCHERS.map(([label]) => label))
      .toEqual(isBothChromiumSelected() ? ['the default test Chromium', chromiumHelpers.CLI_CHROMIUM_RUN_LABEL] : [chromiumHelpers.CLI_CHROMIUM_RUN_LABEL]);
  });

  it('the launcher spreads both Chromium only in the safety suite and in related --with-safety and --both-chromium', () => {
    const launcher = scanSource(readLfTextFile(RUN_SUITE_FILE)).code;
    expect(launcher).toMatch(/\bsafety\s*:\s*withEnvironment\(\s*BOTH_CHROMIUM_RUN_ENVIRONMENT\s*,/u);
    expect(launcher).not.toMatch(/\bfull\s*:\s*withEnvironment\(\s*BOTH_CHROMIUM_RUN_ENVIRONMENT\b/u);
    expect(launcher).toMatch(/\bconst\s+bothChromium\s*=\s*withSafety\s*\|\|\s*args\.includes\('--both-chromium'\)/u);
    expect(launcher).toMatch(/\bbothChromium\s*\?\s*withEnvironment\(\s*BOTH_CHROMIUM_RUN_ENVIRONMENT\s*,\s*slowSteps\s*\)\s*:\s*slowSteps\b/u);
  });

  it('detects an import of the helper (control)', () => {
    expect(importsChromiumHelper("import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';", 'BOTH_CHROMIUM_LAUNCHERS')).toBe(true);
    expect(importsChromiumHelper("import { launchCliChromium, launchHeadlessChromium } from '../../../tests/helpers/chromium.js';", 'launchCliChromium')).toBe(true);
    expect(importsChromiumHelper("import { launchHeadlessChromium } from '../helpers/chromium.js';", 'launchCliChromium')).toBe(false);
  });
});

/** SLIM-1: 遅い組の構造の一覧と、その条件（先の一覧に載るものは、後の一覧に載せない。SLIM-B0: 漏れの確かめの一覧は遅い組の一覧でない）。 */
const SLOW_STRUCTURE_LISTS: readonly (readonly [string, readonly string[], SlowCriterion])[] = [
  ['SLOW_BUILT_PRODUCT_TEST_FILES', SLOW_BUILT_PRODUCT_TEST_FILES, 'BUILT_PRODUCT'],
  ['SLOW_UI_SERVER_TEST_FILES', SLOW_UI_SERVER_TEST_FILES, 'UI_SERVER'],
  ['SLOW_CLI_CHROMIUM_LAUNCH_TEST_FILES', SLOW_CLI_CHROMIUM_LAUNCH_TEST_FILES, 'CLI_CHROMIUM'],
];

/** テストのファイルのパスか（結合・画面・単体の系のどれか）。 */
const isTestFilePath = (path: string): boolean => existsSync(path) && path.endsWith('.test.ts') && /^(?:tests|apps\/local-ui\/tests)\//u.test(path);

describe('SLIM-1: the fast and slow groups in tests/suites.ts', () => {
  const sublists = [...SLOW_STRUCTURE_LISTS.map(([, list]) => list), SLOW_LONG_TEST_FILES];

  it('the slow lists name existing integration or screen test files, each in one list only', () => {
    expect(SLOW_TEST_FILES.filter((file) => !isTestFilePath(file) || !/^(?:tests\/integration|tests\/contract|apps\/local-ui\/tests)\//u.test(file))).toEqual([]);
    expect(duplicatesOf(SLOW_TEST_FILES)).toEqual([]);
    // SLIM-GROUP: Chromium の版を上げるときの束は、構造の一覧に載るが、遅い組の和から除く。
    expect(SLOW_TEST_FILES.length).toBe(sublists.reduce((sum, list) => sum + list.length, 0) - CHROMIUM_UPGRADE_TEST_FILES.length);
  });

  // SLIM-GROUP: 版を上げるときの束は、実在する結合のファイルで、構造の一覧のどれかに載り（条件は変わらない）、安全の一覧・漏れの確かめの一覧には
  // 入れない（安全の漏れの確かめは、区切りで流す）。起動の部品は、`chromium-upgrade` でこの束を両方の Chromium に広げて流す。
  it('the Chromium upgrade list names slow structural files outside the safety and leak check lists, and the launcher runs it on both Chromium', () => {
    expect(CHROMIUM_UPGRADE_TEST_FILES.length).toBeGreaterThan(0);
    expect(duplicatesOf(CHROMIUM_UPGRADE_TEST_FILES)).toEqual([]);
    expect(CHROMIUM_UPGRADE_TEST_FILES.filter((file) => !isTestFilePath(file) || !sublists.some((list) => list.includes(file)))).toEqual([]);
    expect(CHROMIUM_UPGRADE_TEST_FILES.filter((file) => SLOW_TEST_FILES.includes(file) || SAFETY_TEST_FILES.includes(file) || BOTH_CHROMIUM_LEAK_CHECK_FILES.includes(file)))
      .toEqual([]);
    const launcher = scanSource(readLfTextFile(RUN_SUITE_FILE)).code;
    expect(launcher).toMatch(/'chromium-upgrade'\s*:\s*withEnvironment\(\s*BOTH_CHROMIUM_RUN_ENVIRONMENT\s*,\s*\[[\s\S]*?args:\s*\[\.\.\.CHROMIUM_UPGRADE_TEST_FILES\]/u);
  });

  // RB-3: ずれの確かめ（`tests/contract/`）のファイルは、どれも口の操作ごとか通り道ごとの一覧に載り、版を上げるときの回は、口の操作ごとを
  // 2 つの Chromium（既定の回と CLI の回）で、通り道ごとを両方に広げて流す。通り道ごとは漏れの確かめの一覧で、口の操作ごとは速い組。
  it('the contract lists name every file under tests/contract, and the Chromium upgrade run starts with them on both Chromium', () => {
    expect([...CONTRACT_PORT_TEST_FILES, ...CONTRACT_PATH_TEST_FILES].sort()).toEqual(TEST_FILES.filter((file) => file.startsWith('tests/contract/')));
    expect(CONTRACT_PATH_TEST_FILES.filter((file) => !BOTH_CHROMIUM_LEAK_CHECK_FILES.includes(file))).toEqual([]);
    expect(CONTRACT_PORT_TEST_FILES.filter((file) => SLOW_TEST_FILES.includes(file) || CHROMIUM_UPGRADE_TEST_FILES.includes(file))).toEqual([]);
    const launcher = scanSource(readLfTextFile(RUN_SUITE_FILE)).code.replace(/\s+/gu, ' ');
    const upgradeRuns = launcher.slice(launcher.indexOf("'chromium-upgrade': withEnvironment(BOTH_CHROMIUM_RUN_ENVIRONMENT, ["), launcher.indexOf('...CHROMIUM_UPGRADE_TEST_FILES'));
    expect(upgradeRuns).toContain('args: [...CONTRACT_PORT_TEST_FILES, ...CONTRACT_PATH_TEST_FILES], environment: {} }');
    expect(upgradeRuns).toContain('args: [...CONTRACT_PORT_TEST_FILES], environment: CLI_CHROMIUM_RUN_ENVIRONMENT }');
  });

  it.each(SLOW_STRUCTURE_LISTS)('%s is exactly the test files that meet its condition and no earlier list', (_name, list, criterion) => {
    const earlier = new Set(SLOW_STRUCTURE_LISTS.slice(0, SLOW_STRUCTURE_LISTS.findIndex(([, other]) => other === list)).flatMap(([, other]) => other));
    const expected = [...TEST_SIDE_ANALYSIS.criteria].filter(([path, criteria]) => criteria.has(criterion) && !earlier.has(path)).map(([path]) => path).sort();
    expect([...list].sort()).toEqual(expected);
  });

  it('the long list has only the files that meet no structural condition', () => {
    expect(SLOW_LONG_TEST_FILES.filter((file) => TEST_SIDE_ANALYSIS.criteria.has(file))).toEqual([]);
  });

  // SLIM-B0: 漏れの確かめの一覧（両方の Chromium に広げる一覧）のファイルは、入口を import するので、構造の条件で遅い組に入る（遅い組では 1 つの Chromium）。
  it('the files of the leak check list are in the slow group by a structural list', () => {
    expect(BOTH_CHROMIUM_LEAK_CHECK_FILES.filter((file) => !SLOW_TEST_FILES.includes(file) || SLOW_LONG_TEST_FILES.includes(file))).toEqual([]);
  });
});

describe('SLIM-1: the component test ledger and the covers marks', () => {
  it('names existing components and test files, without duplicates', () => {
    const components = COMPONENT_TEST_LEDGER.map(({ component }) => component);
    expect(duplicatesOf(components)).toEqual([]);
    expect(components.filter((component) => !existsSync(component) || !/^(?:src|apps\/local-ui\/src|schemas)\//u.test(component))).toEqual([]);
    expect(COMPONENT_TEST_LEDGER.filter(({ tests }) => tests.length === 0 || duplicatesOf(tests).length > 0 || tests.some((test) => !isTestFilePath(test))))
      .toEqual([]);
  });

  it('a covers mark names existing components, only in the files that run the built product or the screen server', () => {
    // 印はコメントなので、走査した本文（コメントを除いた）でなく、ファイルのままの本文を読む。
    const problems = [...TEST_SIDE_CODE.keys()]
      .filter((path) => path.endsWith('.test.ts'))
      .flatMap((path) => {
        const covers = coversOf(readLfTextFile(path));
        if (covers === undefined) {
          return [];
        }
        const criteria = TEST_SIDE_ANALYSIS.criteria.get(path);
        const runsBuilt = criteria?.has('BUILT_PRODUCT') === true || criteria?.has('UI_SERVER') === true;
        return [...(runsBuilt && covers.length > 0 ? [] : [`${path}: covers in a file that does not run the built product`]), ...covers.filter((item) => !existsSync(item)).map((item) => `${path}: ${item}`)];
      });
    expect(problems).toEqual([]);
  });
});

describe('TS-a: the Vitest projects of the root config', () => {
  it('has the unit, integration and heavy projects', () => {
    expect(PROJECTS.map((project) => project.name).sort()).toEqual([HEAVY_PROJECT_NAME, INTEGRATION_PROJECT_NAME, UNIT_PROJECT_NAME].sort());
  });

  it('puts every test file under tests/ in exactly one project', () => {
    expect(TEST_FILES.length).toBeGreaterThan(0);
    const outside = TEST_FILES.map((file) => ({ file, projects: projectsOf(file) })).filter(({ projects }) => projects.length !== 1);
    expect(outside).toEqual([]);
  });

  it('puts the heavy files in the heavy project and the other integration files in the integration project', () => {
    const integrationFiles = TEST_FILES.filter((file) => matchesAny(file, INTEGRATION_PROJECT_INCLUDE));
    expect(integrationFiles.filter((file) => projectsOf(file)[0] !== (HEAVY_TEST_FILES.includes(file) ? HEAVY_PROJECT_NAME : INTEGRATION_PROJECT_NAME))).toEqual([]);
  });

  it('runs the integration and heavy projects together with the same parallelism, after the unit project', () => {
    const byName = new Map(PROJECTS.map((project) => [project.name, project]));
    const unit = byName.get(UNIT_PROJECT_NAME);
    const integration = byName.get(INTEGRATION_PROJECT_NAME);
    const heavy = byName.get(HEAVY_PROJECT_NAME);
    expect(integration?.maxWorkers).toBe(heavy?.maxWorkers);
    expect(integration?.groupOrder).toBe(heavy?.groupOrder);
    expect(unit?.groupOrder ?? 0).toBeLessThan(integration?.groupOrder ?? 0);
  });

  // TEST-TIME-A: 結合の project は、一時ビルドを 1 回の vitest で共有する（`globalSetup`）。単体の系は、流すだけでビルドしない。
  it('shares the temporary build in the integration and heavy projects only', () => {
    const setupsOf = (name: string): readonly string[] => PROJECTS.find((project) => project.name === name)?.globalSetup ?? [];
    expect(setupsOf(INTEGRATION_PROJECT_NAME).some((path) => path.endsWith('shared-temporary-build-setup.ts'))).toBe(true);
    expect(setupsOf(HEAVY_PROJECT_NAME)).toEqual(setupsOf(INTEGRATION_PROJECT_NAME));
    expect(setupsOf(UNIT_PROJECT_NAME)).toEqual([]);
  });
});

/**
 * TEST-TIME-A: 共有の一時ビルド（`useSharedTemporaryBuild`）を使うファイルは、ビルドの root の下のパスを自分で作らない（テストだけの入口は
 * `buildEntryPath` で名前を分ける。ほかのテストのファイルの入口と混ざらない）。
 */
const BUILD_ROOT_PATH_SHAPE = /\bjoin\s*\(\s*[\w$]*build[\w$]*[?!]?\.rootDirectory\s*,/u;

describe('TEST-TIME-A: the files on the shared temporary build', () => {
  const files = readLfTypeScriptFilesUnder(['tests'])
    .filter(({ content }) => content.includes('useSharedTemporaryBuild'))
    .map(({ path, content }) => ({ path, code: scanSource(content).code }));

  it('write the test entries only by buildEntryPath', () => {
    const shared = files.filter(({ code }) => /\buseSharedTemporaryBuild\s*\(/u.test(code));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.filter(({ code }) => BUILD_ROOT_PATH_SHAPE.test(code)).map(({ path }) => path)).toEqual([]);
  });

  it('detects a path made under the build root (control)', () => {
    expect(BUILD_ROOT_PATH_SHAPE.test('const entry = join(build.rootDirectory, `${Date.now()}-entry.mjs`);')).toBe(true);
    expect(BUILD_ROOT_PATH_SHAPE.test("const entry = buildEntryPath(build, 'entry.mjs');")).toBe(false);
  });
});

describe('TS-a: the npm scripts do not copy the suite lists', () => {
  const scripts: Readonly<Record<string, string>> = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

  it('no script names a test file or the CLI run environment variable', () => {
    const copied = Object.entries(scripts).filter(([, command]) => command.includes('.test.ts') || command.includes(TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE));
    expect(copied).toEqual([]);
  });

  it('the suite scripts read the projects or the launcher', () => {
    expect(scripts['test:fast']).toBe(`vitest run --project ${UNIT_PROJECT_NAME}`);
    expect(scripts['test:integration']).toBe(`vitest run --project ${INTEGRATION_PROJECT_NAME}`);
    expect(scripts['test:heavy']).toBe(`vitest run --project ${HEAVY_PROJECT_NAME}`);
    expect(scripts['test:safety']).toBe('node tests/run-suite.mjs safety');
    expect(scripts['test:full']).toBe('node tests/run-suite.mjs full');
    expect(scripts['verify']).toContain('npm run test:full');
    expect(scripts['verify:all']).toContain('npm run verify');
  });
});
