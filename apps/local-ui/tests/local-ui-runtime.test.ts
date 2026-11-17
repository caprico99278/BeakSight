/**
 * RB-7: 画面のサーバの依存の置き場所（`src/server/local-ui-runtime.ts`）。入れなければ本番の値（リポジトリの root と、そのビルドのワーカー）。テストが入れる
 * 口は、決まる前の 1 回だけで、後から入れ替えられない（fail-closed）。本番のコードが入れないことは Gate `local-ui-runtime-boundary`。
 */
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from './helpers/local-server.ts';

type Runtime = typeof import('../src/server/local-ui-runtime');
const freshRuntime = async (): Promise<Runtime> => import('../src/server/local-ui-runtime');

describe('local-ui-runtime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('decides the production values when nothing is installed, and refuses an install after that', async () => {
    const runtime = await freshRuntime();
    expect(runtime.localUiRuntimeOptions()).toEqual({ dataRoot: REPO_ROOT, workerPath: join(REPO_ROOT, 'dist', 'worker', 'audit-worker.js') });
    expect(() => runtime.installLocalUiRuntime({ dataRoot: join(REPO_ROOT, 'other'), workerPath: join(REPO_ROOT, 'other.mjs') })).toThrow();
    expect(runtime.localUiRuntimeOptions().dataRoot).toBe(REPO_ROOT);
  });

  it('uses the installed values once, and refuses a second install and relative paths', async () => {
    const runtime = await freshRuntime();
    expect(() => runtime.installLocalUiRuntime({ dataRoot: 'relative', workerPath: join(REPO_ROOT, 'w.mjs') })).toThrow();
    runtime.installLocalUiRuntime({ dataRoot: join(REPO_ROOT, 'data'), workerPath: join(REPO_ROOT, 'w.mjs') });
    expect(() => runtime.installLocalUiRuntime({ dataRoot: join(REPO_ROOT, 'again'), workerPath: join(REPO_ROOT, 'w.mjs') })).toThrow();
    expect(runtime.localUiRuntimeOptions()).toEqual({ dataRoot: `${REPO_ROOT}/data`, workerPath: join(REPO_ROOT, 'w.mjs') });
  });
});
