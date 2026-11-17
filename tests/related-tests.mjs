/**
 * TEST-TIME-A: 変えたファイルに関係するテストを選ぶ部品（`node tests/run-suite.mjs related [--list] [ファイル...]` から使う）。依存は足さない。
 * - 変えたファイル: 引数で渡したファイル。渡さなければ、Git の表示（`git diff --name-only HEAD` と、`git status --porcelain` の未追跡 `??`）から読む。
 * - SLIM-1: 台帳（`tests/component-test-ledger.ts`）の部品に入る変えたファイルは、台帳の組だけを選ぶ（import はたどらない）。
 * - ほかの変えたファイル: Vitest の `related`（Vitest がテストのファイルの import をたどる）で選ぶ（ルートの設定と、画面のテストの設定のそれぞれ）。
 * - fork と画面のテスト: ビルドした本番の入口（ワーカー・CLI・画面のサーバ）を子の process で動かすので、テストのファイルの import からは見えない。
 *   一時ビルドを使うテスト（ルート）と、ビルドした画面のサーバを起動するテスト（画面）のうち、通る部品の印（`// covers: …`）があるものは、印の部品に
 *   入る変えたファイルがあるときに選ぶ。印のないものは、変えたファイルが本番の入口から import でたどれる（`tests/architecture/source-scan.ts` の
 *   `reachableFiles`）ときに選ぶ（今までの選び方）。
 * - 選んだテストは、`tests/suites.ts` の `SLOW_TEST_FILES` で速い組と遅い組に分ける。`withSafety` は、安全の一覧（`SAFETY_TEST_FILES`）を必ず足す。
 *   SLIM-GROUP: Chromium の版を上げるときの束（`CHROMIUM_UPGRADE_TEST_FILES`）に入るものは、どちらにも入れず `upgrade` で返す。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { COMPONENT_TEST_LEDGER } from './component-test-ledger.ts';
import { builtProductTestsFor, coversOf, ledgerSelectionOf, splitByGroup } from './related-selection.ts';
import { CHROMIUM_UPGRADE_TEST_FILES, SAFETY_TEST_FILES, SLOW_TEST_FILES } from './suites.ts';
import {
  findRuntimeModuleSpecifiers,
  readTypeScriptFilesUnder,
  reachableFiles,
  resolveImportTarget,
  scanSource,
} from './architecture/source-scan.ts';

/** ビルドした本番の入口（リポジトリの root からのパス）。 */
const PRODUCTION_ENTRIES = Object.freeze(['src/worker/audit-worker.ts', 'src/cli/index.ts']);
/** ビルドした画面のサーバの入口（起動の部品と、ルートの木と Start の設定）。 */
const UI_SERVER_ENTRIES = Object.freeze(['apps/local-ui/launcher/serve.ts', 'apps/local-ui/src/router.tsx', 'apps/local-ui/src/start.ts']);
/** ビルドの出力に写すもの（変えたら、ビルドを使うテストを足す）。 */
const BUILD_COPIED_PREFIXES = Object.freeze(['schemas/', 'package.json']);
/** 一時ビルドの部品（ルートのテストがここへたどれれば、ビルドした本番を子の process で動かすテスト）。 */
const TEMPORARY_BUILD_HELPER = 'tests/helpers/temporary-build.ts';
/** ビルドした画面のサーバを起動する部品（画面のテストがここへたどれれば、サーバを起動するテスト）。 */
const UI_SERVER_HELPER = 'apps/local-ui/tests/helpers/local-server.ts';
/** import をたどるフォルダ。 */
const SCANNED_DIRECTORIES = Object.freeze(['src', 'tests', 'apps/local-ui/src', 'apps/local-ui/launcher', 'apps/local-ui/tests']);

/** Git の表示の 1 つ（`-z` の区切り）。失敗したら止める。 */
function gitLines(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.split('\0').filter((line) => line !== '');
}

/** 変えたファイル（リポジトリの root からの、`/` の区切りのパス）。`files` を渡さなければ、Git の表示から読む。 */
export function changedFilesOf(root, files) {
  if (files.length > 0) {
    return [...new Set(files.map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/')))].sort();
  }
  const changed = gitLines(root, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = gitLines(root, ['status', '--porcelain', '-z', '--untracked-files=all'])
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
  return [...new Set([...changed, ...untracked])].sort();
}

/** 走査したファイルの表（パス → 走査の結果）。 */
function scannedFiles() {
  return new Map(SCANNED_DIRECTORIES.flatMap((directory) => readTypeScriptFilesUnder(directory)).map(({ path, content }) => [path, scanSource(content)]));
}

/** `starts` と、そこから import でたどれるファイル。 */
function closureOf(files, starts) {
  return new Set(starts.flatMap((start) => [start, ...reachableFiles(files, start)]));
}

/** `directory` の下のテストのファイルのうち、`helper` へ import でたどれるもの（逆向きの import の表を 1 回作って、`helper` から戻る）。 */
function testsReaching(files, directory, helper) {
  const importers = new Map();
  for (const [path, source] of files) {
    for (const specifier of findRuntimeModuleSpecifiers(source.code)) {
      const target = resolveImportTarget(files, path, specifier);
      if (target !== undefined) {
        importers.set(target, [...(importers.get(target) ?? []), path]);
      }
    }
  }
  const reaching = new Set([helper]);
  const queue = [helper];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.shift()) ?? []) {
      if (!reaching.has(importer)) {
        reaching.add(importer);
        queue.push(importer);
      }
    }
  }
  return [...reaching].filter((path) => path.startsWith(directory) && path.endsWith('.test.ts')).sort();
}

/** Vitest の `related` が選ぶテストのファイル（実行しない。`config` は設定のファイル、省略はルートの設定）。 */
async function vitestRelated(root, config, related) {
  if (related.length === 0) {
    return [];
  }
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    ...(config === undefined ? {} : { config: resolve(root, config) }),
    related: related.map((file) => resolve(root, file)),
    watch: false,
    run: true,
  });
  try {
    const specifications = await vitest.getRelevantTestSpecifications();
    return [...new Set(specifications.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')))].sort();
  } finally {
    await vitest.close();
  }
}

/** `paths` を、ルートのテストと画面のテスト（`apps/local-ui/`）に分ける。 */
const byConfig = (paths) => ({ root: paths.filter((path) => !path.startsWith('apps/local-ui/')), ui: paths.filter((path) => path.startsWith('apps/local-ui/')) });

/**
 * 変えたファイル `changed` に関係するテストを選ぶ。戻りは、速い組と遅い組のそれぞれの、ルートの設定と画面のテストの設定で流すテストのファイルと、
 * 選んだ経緯（台帳で選んだ部品、印か入口で選んだ fork・画面のテスト）。
 */
export async function selectRelatedTests(root, changed, uiConfig, { withSafety = false } = {}) {
  const files = scannedFiles();
  const ledger = ledgerSelectionOf(changed, COMPONENT_TEST_LEDGER);
  const traced = changed.filter((path) => !ledger.matched.includes(path));
  const production = closureOf(files, PRODUCTION_ENTRIES);
  const uiServer = closureOf(files, [...UI_SERVER_ENTRIES, ...PRODUCTION_ENTRIES]);
  const isBuildCopied = (path) => BUILD_COPIED_PREFIXES.some((prefix) => path.startsWith(prefix));
  const candidatesOf = (directory, helper, closure) => testsReaching(files, directory, helper).map((path) => ({
    path,
    covers: coversOf(readFileSync(resolve(root, path), 'utf8')),
    touchesEntry: traced.some((changedPath) => closure.has(changedPath) || isBuildCopied(changedPath)),
  }));
  const builtProductTests = builtProductTestsFor(traced, [
    ...candidatesOf('tests/', TEMPORARY_BUILD_HELPER, production),
    ...candidatesOf('apps/local-ui/tests/', UI_SERVER_HELPER, uiServer),
  ]);
  const importTraced = [...await vitestRelated(root, undefined, traced), ...await vitestRelated(root, uiConfig, traced)];
  const selected = [...ledger.tests, ...importTraced, ...builtProductTests, ...(withSafety ? SAFETY_TEST_FILES : [])];
  // SLIM-GROUP: Chromium の版を上げるときの束は、速い組にも遅い組にも入れず、別に返す（両方の Chromium に広げる回だけ流す）。
  const isUpgrade = (path) => CHROMIUM_UPGRADE_TEST_FILES.includes(path);
  const groups = splitByGroup(selected.filter((path) => !isUpgrade(path)), SLOW_TEST_FILES);
  const upgrade = [...new Set(selected.filter(isUpgrade))].sort();
  return { ledgerMatched: ledger.matched, builtProductTests, fast: byConfig(groups.fast), slow: byConfig(groups.slow), upgrade };
}
