import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const rootDirectory = process.cwd();

/**
 * 一時ビルドの置き場所。`dist/` とは別の場所にする。
 * コンパイル結果は `ajv` などの依存を bare specifier で import するので、
 * 祖先に `node_modules` を持つ場所（`node_modules/.cache` の直下）に置く。ビルドの後で必ず削除する。
 * 並列に動くほかのテストファイルと競合しないよう、ビルドごとに別の名前のディレクトリを作り、親は削除しない。
 */
const temporaryBuildParent = resolve(rootDirectory, 'node_modules', '.cache');

export interface TemporaryBuild {
  /** 一時ビルドの最上位のディレクトリ（`remove()` で丸ごと削除する）。本番と同じく、`dist/` の1つ上に `package.json` を置く。 */
  readonly rootDirectory: string;
  /** `tsconfig.build.json` の出力先（`<rootDirectory>/dist`）。`dist/` と同じ構成で、`schemas/` も含む。 */
  readonly distDirectory: string;
  remove(): Promise<void>;
}

/**
 * `tsconfig.build.json` を一時ディレクトリへビルドし、`schemas/` を `npm run build` と同じ位置に写す。
 * `package.json` も、本番の配置（`dist/` の1つ上）と同じ位置に写す。BeakSight の版（`readToolVersion`）は、
 * `dist/orchestration/` の2つ上の `package.json` から読むためである（C17a）。
 * リポジトリの `dist/` は読みも書きもしない。
 */
export async function buildIntoTemporaryDirectory(): Promise<TemporaryBuild> {
  await mkdir(temporaryBuildParent, { recursive: true });
  const buildRoot = await mkdtemp(join(temporaryBuildParent, 'beaksight-test-build-'));
  const distDirectory = join(buildRoot, 'dist');
  const remove = async (): Promise<void> => {
    await rm(buildRoot, { force: true, recursive: true });
  };

  try {
    const compilerPath = resolve(rootDirectory, 'node_modules/typescript/bin/tsc');
    const compile = spawnSync(process.execPath, [compilerPath, '-p', 'tsconfig.build.json', '--outDir', distDirectory], {
      cwd: rootDirectory,
      encoding: 'utf8',
    });
    if (compile.status !== 0) {
      throw new Error(`temporary build failed: ${compile.stdout}${compile.stderr}`);
    }
    cpSync(resolve(rootDirectory, 'schemas'), join(distDirectory, 'schemas'), { recursive: true });
    copyFileSync(resolve(rootDirectory, 'package.json'), join(buildRoot, 'package.json'));
  } catch (error) {
    await remove();
    throw error;
  }

  return { rootDirectory: buildRoot, distDirectory, remove };
}

/**
 * TEST-TIME-A: 1 回の vitest で共有する一時ビルドの場所を、`globalSetup`（`shared-temporary-build-setup.ts`）からテストへ渡す名前。
 * 値は、ビルドの場所（`rootDirectory`・`distDirectory`）か、ビルドに失敗したときの文（`error`）。
 */
export const SHARED_TEMPORARY_BUILD_KEY = 'beaksightSharedTemporaryBuild';

/** `SHARED_TEMPORARY_BUILD_KEY` で渡す値（`provide` で渡せる、JSON の形）。 */
export type SharedTemporaryBuildFacts =
  | { readonly rootDirectory: string; readonly distDirectory: string }
  | { readonly error: string };

declare module 'vitest' {
  export interface ProvidedContext {
    [SHARED_TEMPORARY_BUILD_KEY]: SharedTemporaryBuildFacts;
  }
}

/**
 * TEST-TIME-A: 一時ビルドの root に置く、テストだけの入口のファイルのパス（入口は `./dist/` を相対で読むので、root の直下に置く）。
 * ほかのテストのファイルと共有するビルドでも混ざらないよう、名前の前に乱数の id を付ける。入口のパスは、いつもここで作る
 * （Architecture Gate `tests/architecture/test-suites.test.ts`）。
 */
export function buildEntryPath(build: TemporaryBuild, name: string): string {
  return join(build.rootDirectory, `${randomUUID()}-${basename(name)}`);
}

/**
 * ディレクトリの中のファイルの一覧と、それぞれの更新時刻・大きさを返す。ディレクトリがなければ `null`。
 * テストの前後で比べて、そのディレクトリを書き換えていないことを確かめるために使う。
 */
export async function snapshotDirectory(directory: string): Promise<Readonly<Record<string, string>> | null> {
  try {
    await stat(directory);
  } catch {
    return null;
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const fileStat = await stat(path);
    snapshot[relative(directory, path)] = `${entry.isDirectory() ? 'dir' : 'file'}:${fileStat.mtimeMs}:${fileStat.size}`;
  }
  return snapshot;
}
