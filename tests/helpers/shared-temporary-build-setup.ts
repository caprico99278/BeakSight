import type { TestProject } from 'vitest/node';
import { buildIntoTemporaryDirectory, SHARED_TEMPORARY_BUILD_KEY, type SharedTemporaryBuildFacts, type TemporaryBuild } from './temporary-build.js';

/**
 * TEST-TIME-A: 結合の project（integration・heavy）の `globalSetup`。1 回の vitest で、一時ビルド（`buildIntoTemporaryDirectory`）を 1 回だけ作り、
 * その場所をテストへ渡す（`provide`。テストは `useSharedTemporaryBuild` で受け取る）。
 * - 2 つの project が同じ vitest で流れても、ビルドは 1 回にする（vitest の本体の process の `globalThis` に置いて、project の数を数える）。
 * - 最後の project の後片付けで、ビルドを消す。
 * - ビルドに失敗しても、ビルドを使わないテストは流す（失敗の文を渡し、`useSharedTemporaryBuild` を呼んだテストだけが失敗する）。
 * - ビルドは vitest の始めの 1 回だけ。watch で流しているときに `src/` を変えたら、vitest を起こし直す（流し直しでは作り直さない）。
 */
interface SharedBuildState {
  users: number;
  readonly build: Promise<TemporaryBuild | Error>;
}

const STATE_KEY = Symbol.for('beaksight.sharedTemporaryBuild');
const holder = globalThis as { [STATE_KEY]?: SharedBuildState };

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const state = holder[STATE_KEY] ?? (holder[STATE_KEY] = {
    users: 0,
    build: buildIntoTemporaryDirectory().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
  });
  state.users += 1;
  const build = await state.build;
  const facts: SharedTemporaryBuildFacts = build instanceof Error
    ? { error: `the shared temporary build failed: ${build.message}` }
    : { rootDirectory: build.rootDirectory, distDirectory: build.distDirectory };
  project.provide(SHARED_TEMPORARY_BUILD_KEY, facts);
  return async () => {
    state.users -= 1;
    if (state.users === 0) {
      delete holder[STATE_KEY];
      if (!(build instanceof Error)) {
        await build.remove();
      }
    }
  };
}
