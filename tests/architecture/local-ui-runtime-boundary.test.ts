/**
 * RB-7（再構築の設計書 2 章 6、plan の 6 章 C）: 画面のサーバの依存の置き場所（`apps/local-ui/src/server/local-ui-runtime.ts`）の Architecture Gate。
 * テストが入れるデータの根とワーカーの入口（管理データ・資格情報の場所を変える口）を、本番の入口から使えないことを確かめる。判定は `source-scan.ts`
 * の文字列の走査だけ（近似の検査）。
 * - (1) 入れる口 `installLocalUiRuntime` を呼ぶ製品のコードはない（`src/`・`apps/local-ui/src`・`apps/local-ui/launcher`・`vite.config.ts`）。名前が
 *   現れるのは、定義（owner）と、2 つ目の入口の re-export（`launcher-bridge.ts`）だけ。呼ぶのはテストの起動の入口（`ui-test-launcher.ts`）。
 * - (2) 本番の値を作る `productionLocalUiRuntimeOptions` と、場所からリポジトリの root を決める `repositoryRootOf` を使うのは owner だけ（1 か所）。
 * - (3) owner は、環境変数と起動の引数（`process.env`・`process.argv`）を読まない（利用者が触れる口から根を変えられない）。
 * - (4) ワーカーの入口の本番の値（`audit-worker.js` の名前）を画面のコードに書くのは owner だけ。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_ROOT,
  countIdentifier,
  findCallSites,
  loadLocalUiSourceFiles,
  loadSourceFiles,
  loadTypeScriptFilesUnder,
  scanFile,
  scanSource,
  type ScannedSource,
} from './source-scan.js';

const OWNER_PATH = 'apps/local-ui/src/server/local-ui-runtime.ts';
const BRIDGE_PATH = 'apps/local-ui/src/server/launcher-bridge.ts';
const TEST_LAUNCHER_PATH = 'apps/local-ui/tests/helpers/ui-test-launcher.ts';
const VITE_CONFIG_PATH = 'apps/local-ui/vite.config.ts';
const INSTALL_NAME = 'installLocalUiRuntime';
const OWNER_ONLY_NAMES: readonly string[] = ['productionLocalUiRuntimeOptions', 'repositoryRootOf'];
const WORKER_ENTRY_NAME = 'audit-worker.js';
const ARGUMENT_READS = /\bprocess\s*\.\s*(?:env|argv)\b/u;

/** 製品のコード（パスと走査の結果）。読み込みは 1 回だけ。 */
const PRODUCTION_FILES: readonly (ScannedSource & { readonly path: string })[] = [
  ...loadSourceFiles(),
  ...loadLocalUiSourceFiles(),
  ...loadTypeScriptFilesUnder('apps/local-ui/launcher'),
  scanFile({ path: VITE_CONFIG_PATH, content: readFileSync(join(REPOSITORY_ROOT, VITE_CONFIG_PATH), 'utf8') }),
];
const owner = PRODUCTION_FILES.find((file) => file.path === OWNER_PATH);

/** (1) 入れる口の名前が現れるファイル（定義と re-export のほか）。 */
const installMentionsOf = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] =>
  files.filter((file) => file.path !== OWNER_PATH && file.path !== BRIDGE_PATH && countIdentifier(file.bare, INSTALL_NAME) > 0).map((file) => file.path);

/** (2)(4) owner の外で、owner だけの名前・ワーカーの入口の名前を使うファイル（`<パス>: <名前>`）。 */
const ownerOnlyUsesOf = (files: readonly (ScannedSource & { readonly path: string })[]): readonly string[] =>
  files.filter((file) => file.path !== OWNER_PATH).flatMap((file) => [
    ...OWNER_ONLY_NAMES.filter((name) => findCallSites(file.bare, name).length > 0),
    ...(file.path.startsWith('apps/local-ui/src/') && file.literals.some((literal) => literal.includes(WORKER_ENTRY_NAME)) ? [WORKER_ENTRY_NAME] : []),
  ].map((name) => `${file.path}: ${name}`));

const sample = (path: string, content: string): ScannedSource & { readonly path: string } => scanFile({ path, content });

describe('local-ui-runtime-boundary: the data root and the worker entry are installed only by the test launcher', () => {
  it('(1) no production code calls installLocalUiRuntime; the bridge only re-exports it and the test launcher calls it', () => {
    expect(installMentionsOf(PRODUCTION_FILES)).toEqual([]);
    const bridge = PRODUCTION_FILES.find((file) => file.path === BRIDGE_PATH);
    expect(findCallSites(bridge?.bare ?? '', INSTALL_NAME)).toEqual([]);
    expect(findCallSites(scanSource(readFileSync(join(REPOSITORY_ROOT, TEST_LAUNCHER_PATH), 'utf8')).bare, INSTALL_NAME)).toHaveLength(1);
    // 近似の検査が呼び出しを見つけること（launcher の中の呼び出し）。
    expect(installMentionsOf([sample('apps/local-ui/launcher/serve.ts', `bridge.${INSTALL_NAME}({ dataRoot, workerPath });`)])).toEqual(['apps/local-ui/launcher/serve.ts']);
  });

  it('(2)(4) the production values and the worker entry name are in the owner only', () => {
    expect(ownerOnlyUsesOf(PRODUCTION_FILES)).toEqual([]);
    expect(OWNER_ONLY_NAMES.every((name) => findCallSites(owner?.bare ?? '', name).length > 0)).toBe(true);
    expect(owner?.literals.some((literal) => literal.includes(WORKER_ENTRY_NAME))).toBe(true);
    expect(ownerOnlyUsesOf([
      sample('apps/local-ui/src/server/audit-jobs.ts', "const path = join(root, 'dist', 'worker', 'audit-worker.js');"),
      sample('apps/local-ui/src/server/control-store.ts', 'const root = repositoryRootOf(import.meta.url);'),
    ])).toEqual(['apps/local-ui/src/server/audit-jobs.ts: audit-worker.js', 'apps/local-ui/src/server/control-store.ts: repositoryRootOf']);
  });

  it('(3) the owner reads neither the environment variables nor the command arguments', () => {
    expect(ARGUMENT_READS.test(owner?.code ?? 'process.env')).toBe(false);
    expect(ARGUMENT_READS.test(scanSource('const root = process.env.ROOT;').code)).toBe(true);
  });
});
