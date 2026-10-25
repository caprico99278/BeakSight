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
  CLI_CHROMIUM_RUN_ENVIRONMENT,
  CLI_CHROMIUM_SELECTION,
  FULL_TEST_TIER,
  FULL_TEST_TIER_RUN_ENVIRONMENT,
  isFullTestTier,
  TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE,
  TEST_TIER_ENVIRONMENT_VARIABLE,
} from '../helpers/test-run-environment.js';
import { findNamedImports, readLfTextFile, readLfTypeScriptFilesUnder, scanSource } from './source-scan.js';
import {
  CLI_CHROMIUM_TEST_FILES,
  HEAVY_PROJECT_NAME,
  HEAVY_TEST_FILES,
  INTEGRATION_PROJECT_INCLUDE,
  INTEGRATION_PROJECT_NAME,
  SAFETY_TEST_FILES,
  UNIT_PROJECT_NAME,
} from '../suites.js';

/** project の名前・読むファイル・除くファイル・並列の数・組の順。 */
interface ProjectShape {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxWorkers: number | string | undefined;
  readonly groupOrder: number | undefined;
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
  const names = [TEST_DEFAULT_CHROMIUM_ENVIRONMENT_VARIABLE, TEST_TIER_ENVIRONMENT_VARIABLE];
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
  staleLockTakeoverPerScenario: 20,
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
  'tests/integration/stale-lock-takeover-processes.test.ts': ['staleLockTakeoverPerScenario'],
  'tests/integration/guard-popup-close-race.test.ts': ['popupCloseRaceBurst', 'popupCloseRaceStorm'],
  'tests/integration/isolated-interaction-cases.ts': ['frozenPopupSelfClose', 'frozenCloseRace'],
  'tests/integration/safety-gates.test.ts': ['frozenPopupAudit', 'gateS04PopupSelfClose'],
  'tests/helpers/gate-harness.ts': ['unloadBeaconClose', 'unloadBeaconSelfNavigation'],
  'tests/integration/control-profile-processes.test.ts': ['profileConcurrentUpdate', 'profileHeldTransactionKill', 'profileLoopKill'],
  'tests/integration/passive-request-guard.test.ts': ['iframeSrcChurnClose'],
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
