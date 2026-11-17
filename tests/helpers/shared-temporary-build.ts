import { inject } from 'vitest';
import { buildIntoTemporaryDirectory, SHARED_TEMPORARY_BUILD_KEY, type SharedTemporaryBuildFacts, type TemporaryBuild } from './temporary-build.js';

/**
 * TEST-TIME-A: 1 回の vitest で共有する一時ビルド（結合の project の `globalSetup`。`shared-temporary-build-setup.ts`）を受け取る。
 * - ビルドの中身は読むだけにする。テストだけの入口のパスは `buildEntryPath` で作り、名前を分ける（ほかのテストのファイルと混ざらない）。
 * - ビルドの中身を書き換えるテスト（ビルドの root の下に管理データを作る、など）と、ビルドのパスでプロセスを見分けるテストは、
 *   共有せずに `buildIntoTemporaryDirectory` で自分のビルドを使う。
 * - 返す `remove()` は何もしない（共有のビルドは、vitest の終わりに `globalSetup` の後片付けが消す）。
 * - `globalSetup` のない設定（画面のテストの設定など）で呼んだときは、自分のビルドを作って返す（`remove()` で消える）。
 */
export async function useSharedTemporaryBuild(): Promise<TemporaryBuild> {
  const facts: SharedTemporaryBuildFacts | undefined = inject(SHARED_TEMPORARY_BUILD_KEY);
  if (facts === undefined) {
    return await buildIntoTemporaryDirectory();
  }
  if ('error' in facts) {
    throw new Error(facts.error);
  }
  return { rootDirectory: facts.rootDirectory, distDirectory: facts.distDirectory, remove: async () => undefined };
}
