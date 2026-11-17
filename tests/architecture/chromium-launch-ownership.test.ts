/**
 * Architecture Gate（EL-12。設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.1・4 章）: 本番の Chromium の起動の owner。
 * - (a) `src/` で Chromium を起動する Playwright の呼び出し（`launch`・`launchPersistentContext`・`launchServer`・`connect`・`connectOverCDP`）が
 *   あるのは、起動の部品（`src/browser/chromium-launch.ts`）だけ。ほかの本番のファイルは、外部のアプリの起動を止める設定と自己検査を通らない
 *   起動をしない。
 * - (b) 起動の部品の中の起動の呼び出しは、`launchPersistentContext` の 1 か所だけ（`chromium.launch` は使わない。`--user-data-dir` を使えないため）。
 * - (c) 本番の起動の所（CLI の Run の Browser、ワーカーのログインの段の 2 つの Browser）は、起動の部品の `launchChromium` を呼ぶ。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  findCallSites,
  findNamedImports,
  loadSourceFiles,
  matchingParenthesis,
  MAX_GATE_MS,
  readLfTextFile,
  readLfTypeScriptFilesUnder,
  scanSource,
  sourceFileAt,
  startCpuStopwatch,
  TEST_SOURCE_DIRECTORIES,
  unusedExclusionsOf,
  violationsOf,
  type SourceFile,
} from './source-scan.js';

const LAUNCH_OWNER = 'src/browser/chromium-launch.ts';
/** (a) Chromium を起動する Playwright の呼び出し（`.name(` の形。`bare` に当てる）。 */
const BROWSER_START_CALL = /\.\s*(launch|launchPersistentContext|launchServer|connect|connectOverCDP)\s*\(/gu;
/** (c) 本番の起動の所と、`launchChromium` を呼ぶ数。 */
const PRODUCTION_LAUNCH_SITES: Readonly<Record<string, number>> = Object.freeze({
  'src/cli/audit-run.ts': 1,
  'src/worker/audit-worker-process.ts': 2,
});

/** (b) 起動の部品の中の、Playwright の `chromium` の起動の呼び出し（差し替えの口 `dependencies.launchPersistentContext(` は数えない）。 */
const PLAYWRIGHT_CHROMIUM_START_CALL = /\bchromium\s*\.\s*(launch|launchPersistentContext|launchServer|connect|connectOverCDP)\s*\(/gu;

const browserStartCalls = (file: Pick<SourceFile, 'bare'>): readonly string[] =>
  [...file.bare.matchAll(BROWSER_START_CALL)].map((match) => match[1] ?? '');

const SOURCE_FILES = loadSourceFiles();

describe('EL-12: only the launch component starts Chromium in src/', () => {
  it('(a) detects a direct launch outside the launch component', () => {
    const asFile = (bare: string): Pick<SourceFile, 'bare'> => ({ bare });
    expect(browserStartCalls(asFile('const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));'))).toEqual(['launch']);
    expect(browserStartCalls(asFile('await chromium\n  .launchPersistentContext(dir, options);'))).toEqual(['launchPersistentContext']);
    expect(browserStartCalls(asFile('await chromium.connectOverCDP(endpoint);'))).toEqual(['connectOverCDP']);
    expect(browserStartCalls(asFile('await launchChromium({ headless: true });'))).toEqual([]);
  });

  it('(a)(b)(c) keeps every Chromium start in the launch component, and the production launch sites call launchChromium', () => {
    const stopwatch = startCpuStopwatch();
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== LAUNCH_OWNER), browserStartCalls)).toEqual([]);
    expect([...sourceFileAt(SOURCE_FILES, LAUNCH_OWNER).bare.matchAll(PLAYWRIGHT_CHROMIUM_START_CALL)].map((match) => match[1])).toEqual(['launchPersistentContext']);
    for (const [path, count] of Object.entries(PRODUCTION_LAUNCH_SITES)) {
      expect(findCallSites(sourceFileAt(SOURCE_FILES, path).bare, 'launchChromium'), path).toHaveLength(count);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});

/**
 * RB-4 fix（REV-RB4 の M-1）: テストの起動の道は、テストだけの外へ出ない引数（`tests/helpers/test-chromium-args.ts`）を通る。
 * - テストのワーカーの入口の本文（`runAuditWorkerProcess(process, {…})`）は、Run の Browser の起動 `launchRunBrowser` を渡す（省略すると本番の起動で、テストの
 *   引数が付かない）。
 * - テストの中の生の起動（`chromium.launch(`・`launchChromiumWith(`）は、呼び出しの中にテストの引数の名前を持つ（持たない所は、理由つきの例外）。
 * - ビルドした CLI で Run を流すテスト（`cli.test.ts`）は、テストだけの入口（`tests/helpers/test-cli-entry.ts`。製品に口を作らない）を通す。入口は
 *   本文の `launchBrowser` に `TEST_CLI_CHROMIUM_LAUNCH_SOURCE` を埋める（下の確かめの 3 つ目の項目で見る）。
 * - RB-fix-456（DEF-277）: テストの入口は、ログインの段の 2 つの Browser の起動（`launchLoginBrowser`・`launchAutomatedLoginBrowser`）も渡す（画面のテストの
 *   既定の入口で手動のログインの段に入る場面、手動のログインの入口で自動ログインに切り替わった後の場面がある）。テストは製品のワーカーの入口
 *   （`audit-worker.js`）を fork せず、テストだけの入口（`tests/helpers/test-audit-worker-entry.ts` など）を通す。
 */
/** 入口の本文の中の呼び出し（引用符の文字列の始まりの直後は、入口の本文を探す文字列なので数えない）。 */
const WORKER_ENTRY_CALL = /(?:(?<=\\n)|(?<![\w$'"]))runAuditWorkerProcess\s*\(\s*process\s*,\s*\{/gu;
const RAW_LAUNCH_CALL = /(?:\bchromium\s*\.\s*launch|(?<![\w$.])launchChromiumWith)\s*\(/gu;
const TEST_ARGS_MARK = /\b(?:TEST_ONLY_NO_INTERNET_ARGS\w*|withTestOnlyNoInternetArgs|TEST_DEFAULT_CHROMIUM_ARGS)\b/u;
/** テストの入口が渡す、3 つの Browser の起動の口。 */
const ENTRY_LAUNCH_HOOKS = Object.freeze(['launchRunBrowser', 'launchLoginBrowser', 'launchAutomatedLoginBrowser']);
/** 入口の本文の中で、渡していない起動の口。 */
const missingLaunchHooksOf = (body: string): readonly string[] => ENTRY_LAUNCH_HOOKS.filter((name) => !new RegExp(String.raw`\b${name}\b`, 'u').test(body));
/** 製品のワーカーの入口の名前（文字列の中。`fake-audit-worker.js` は数えない）。 */
const PRODUCT_WORKER_ENTRY = /(?<![\w-])audit-worker\.js\b/gu;
/** 製品のワーカーの入口の名前を書いてよい所（fork しない。ファイルと理由）。 */
const PRODUCT_WORKER_ENTRY_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'apps/local-ui/tests/helpers/local-server.ts': 'ビルドの出力があるかの確かめだけ（fork するのは一時の root のテストだけの入口）',
  'apps/local-ui/tests/local-ui-runtime.test.ts': '画面のサーバの本番の値の単体（fork しない）',
});
/** 呼び出しの中にテストの引数の名前を持たない、生の起動の例外（ファイルと理由）。 */
const RAW_LAUNCH_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tests/helpers/chromium.ts': '起動の値の組み立て（cliLaunchOptionsOf）が withTestOnlyNoInternetArgs で足す',
  'tests/integration/external-launch-block.test.ts': '起動の値の組み立て（cliOptions）が withTestOnlyNoInternetArgs で足す',
  'tests/integration/preloading-disabled.test.ts': '対照の Playwright の既定の起動。feature の値を比べるので足せず、使われない中継と名前の解決の止めで外へ出さない',
  'tests/unit/chromium-launch.test.ts': '偽の起動の依存（Chromium を起こさない）',
});

/** `start` から始まる呼び出しの本文（最初の開き括弧に対応する閉じ括弧まで。文字列の中の括弧も数える近似）。 */
const callTextFrom = (code: string, start: number): string => {
  const close = matchingParenthesis(code, code.indexOf('(', start));
  return close < 0 ? code.slice(start) : code.slice(start, close + 1);
};
const placeOf = (path: string, code: string, index: number): string => `${path}:${code.slice(0, index).split('\n').length}`;
const ALL_TEST_FILES = readLfTypeScriptFilesUnder(TEST_SOURCE_DIRECTORIES);
const TEST_FILES = ALL_TEST_FILES.filter(({ content }) =>
  content.includes('runAuditWorkerProcess') || content.includes('chromium.launch') || content.includes('launchChromiumWith'));

describe('RB-4 fix (M-1): the test launch paths pass the test-only no-internet args', () => {
  it('every test worker entry passes the three launch hooks, and every raw launch in the tests names the test args', () => {
    const stopwatch = startCpuStopwatch();
    const entries: string[] = [];
    const entriesWithoutHooks: string[] = [];
    const rawWithoutArgs = new Set<string>();
    for (const { path, content } of TEST_FILES) {
      const { code } = scanSource(content);
      for (const match of code.matchAll(WORKER_ENTRY_CALL)) {
        entries.push(path);
        const end = code.indexOf('\n});', match.index);
        const missing = missingLaunchHooksOf(code.slice(match.index, end < 0 ? undefined : end));
        if (missing.length > 0) entriesWithoutHooks.push(`${placeOf(path, code, match.index)} ${missing.join(',')}`);
      }
      for (const match of code.matchAll(RAW_LAUNCH_CALL)) {
        if (!TEST_ARGS_MARK.test(callTextFrom(code, match.index))) rawWithoutArgs.add(path);
      }
    }
    // 近似の検査が空回りしないこと（今の入口: 手動のログインの入口、自動ログインの入口、画面のテストの既定の入口と自動ログインの入口）。
    expect(entries).toEqual(expect.arrayContaining([
      'tests/helpers/test-login-worker-entry.ts',
      'tests/helpers/auto-login-worker-entry.ts',
      'apps/local-ui/tests/helpers/local-server.ts',
      'apps/local-ui/tests/helpers/auth-worker.ts',
      'tests/helpers/test-audit-worker-entry.ts',
    ]));
    expect(entriesWithoutHooks).toEqual([]);
    expect([...rawWithoutArgs].filter((path) => RAW_LAUNCH_EXCEPTIONS[path] === undefined)).toEqual([]);
    expect(unusedExclusionsOf(Object.keys(RAW_LAUNCH_EXCEPTIONS), rawWithoutArgs)).toEqual([]);
    // ビルドした CLI の Run は、テストだけの入口を通し、入口は Browser の起動にテストの起動の式を埋める。
    expect(sourceFileAt(TEST_FILES, 'tests/helpers/test-cli-entry.ts').content)
      .toMatch(/launchBrowser: \(\) => \$\{TEST_CLI_CHROMIUM_LAUNCH_SOURCE\}/u);
    expect(scanSource(readLfTextFile('tests/helpers/cli-process.ts')).code).toMatch(/\binstallTestCliEntry\(build\)/u);
    // DEF-277: テストは製品のワーカーの入口を fork しない（名前を書くのは、fork しない例外の所だけ）。
    const productEntries = new Set(ALL_TEST_FILES.filter(({ content }) => content.includes('audit-worker.js'))
      .filter(({ content }) => [...scanSource(content).code.matchAll(PRODUCT_WORKER_ENTRY)].length > 0).map(({ path }) => path));
    expect([...productEntries].filter((path) => PRODUCT_WORKER_ENTRY_EXCEPTIONS[path] === undefined)).toEqual([]);
    expect(unusedExclusionsOf(Object.keys(PRODUCT_WORKER_ENTRY_EXCEPTIONS), productEntries)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });

  it('detects an entry without a launch hook, a fork of the product worker entry, and a raw launch without the test args (control)', () => {
    const entry = "const s = `\\nrunAuditWorkerProcess(process, { hideJobBrowser: true,\\n  launchRunBrowser: () => x,\\n});\\n`;";
    expect([...entry.matchAll(WORKER_ENTRY_CALL)]).toHaveLength(1);
    expect(missingLaunchHooksOf(entry)).toEqual(['launchLoginBrowser', 'launchAutomatedLoginBrowser']);
    expect([..."fork(join(build.distDirectory, 'worker', 'audit-worker.js'));".matchAll(PRODUCT_WORKER_ENTRY)]).toHaveLength(1);
    expect([..."import { writeFakeWorker } from '../helpers/fake-audit-worker.js';".matchAll(PRODUCT_WORKER_ENTRY)]).toHaveLength(0);
    const code = 'await chromium.launch({ headless: true });\nawait chromium.launch({ headless: true, args: [...TEST_ONLY_NO_INTERNET_ARGS] });';
    expect([...code.matchAll(RAW_LAUNCH_CALL)].map((match) => TEST_ARGS_MARK.test(callTextFrom(code, match.index)))).toEqual([false, true]);
  });
});

/**
 * SLIM-GROUP（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4。前の `apps/local-ui/tests/cli-ui-parity.test.ts` の置き換え）: CLI（開発する人の
 * 道）と画面のジョブのワーカー（利用者の道）は、同じ監査の中核（`executeAuditRun`）に、同じ本番の依存（`PRODUCTION_RUN_DEPENDENCIES`。Chromium の起動を
 * 含む）を渡す。どちらの入口も、監査の中核と依存を `src/cli/audit-run.ts` から import し、自分で作り直さない。
 */
const AUDIT_CORE = '../cli/audit-run.js';
const RUN_ENTRY_IMPORTS: Readonly<Record<string, { readonly specifier: string; readonly names: readonly string[] }>> = Object.freeze({
  'src/cli/run-command.ts': { specifier: './audit-run.js', names: ['executeAuditRun', 'PRODUCTION_RUN_DEPENDENCIES'] },
  'src/worker/audit-worker-process.ts': { specifier: AUDIT_CORE, names: ['executeAuditRun', 'PRODUCTION_RUN_DEPENDENCIES'] },
});

/** `code` が `specifier` から import する名前（`as` の別名は元の名前）。 */
const namesImportedFrom = (code: string, specifier: string): readonly string[] => findNamedImports(code)
  .filter((entry) => entry.specifier === specifier)
  .flatMap(({ names }) => names.map((name) => (name.replace(/^type\s+/u, '').split(/\s+as\s+/u)[0] ?? '').trim()));

describe('SLIM-GROUP: the CLI and the job worker hand the same production dependencies to the audit core', () => {
  it('both entries import executeAuditRun and PRODUCTION_RUN_DEPENDENCIES from the audit core and use them', () => {
    for (const [path, { specifier, names }] of Object.entries(RUN_ENTRY_IMPORTS)) {
      const file = sourceFileAt(SOURCE_FILES, path);
      expect(names.filter((name) => !namesImportedFrom(file.code, specifier).includes(name)), path).toEqual([]);
      // import のほかに、少なくとも 1 か所で使う（CLI は既定の引数と再 export、ワーカーは本番の依存の組み立て）。
      expect(file.bare.split('PRODUCTION_RUN_DEPENDENCIES').length - 1, path).toBeGreaterThanOrEqual(2);
    }
    expect(sourceFileAt(SOURCE_FILES, 'src/cli/main.ts').bare).toMatch(/\bresolveRunCommandDependencies\s*\([^)]*\bPRODUCTION_RUN_DEPENDENCIES\b/u);
  });

  it('detects an entry that does not import the production dependencies (control)', () => {
    expect(namesImportedFrom("import { executeAuditRun, type AuditRunDependencies } from '../cli/audit-run.js';", AUDIT_CORE)).toEqual(['executeAuditRun', 'AuditRunDependencies']);
    expect(namesImportedFrom("import { executeAuditRun as run, PRODUCTION_RUN_DEPENDENCIES } from '../cli/audit-run.js';", AUDIT_CORE)).toEqual(['executeAuditRun', 'PRODUCTION_RUN_DEPENDENCIES']);
  });
});
