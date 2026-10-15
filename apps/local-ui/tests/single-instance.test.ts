/**
 * 画面のサーバは同時に 1 つだけ（独立レビュー T24R の C1、DEF-061。T24h-4）。
 * - 本番の起動の部品が動いている間に、`--port` の違う 2 つ目の本番の起動の部品を起動すると、2 つ目は待ち受けずに、日本語の説明（持ち主の
 *   プロセスの ID と port）と終了コード 1 で止まる。1 つ目は動き続ける。
 * - 本番の起動の部品と開発のサーバの組み合わせ（どちらが先でも）: 2 つ目は、説明と終了コード 1 で止まる（token の URL を出さない）。
 * - 1 つ目を強制終了した後（ロックの持ち主の process が死んでいる）は、次の画面のサーバが古いロックを取り直して起動する。
 * - どれも一時の root（同じ管理データ）で行い、リポジトリの `local-data/` を作らない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_UI_START_FAILURE_TEXT } from '../../../src/presentation/messages.js';
import {
  createTemporaryUiRoot,
  findFreePort,
  rawRequest,
  runDevServerUntilExit,
  runLauncherUntilExit,
  startDevServer,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';

/** 起動できないときの終了コード。 */
const START_FAILED_EXIT_CODE = 1;
/** 本番と開発のサーバを起動するテストの上限（ms）。 */
const TEST_TIMEOUT_MS = 240_000;

const text = LOCAL_UI_START_FAILURE_TEXT;

let builtRoot: TemporaryUiRoot | undefined;
let combinedRoot: TemporaryUiRoot | undefined;
const servers: StartedServer[] = [];

const rootOf = (root: TemporaryUiRoot | undefined): TemporaryUiRoot => {
  if (root === undefined) {
    throw new Error('一時の root がない');
  }
  return root;
};

beforeAll(() => {
  builtRoot = createTemporaryUiRoot('built');
  combinedRoot = createTemporaryUiRoot('combined');
});

afterAll(async () => {
  await Promise.all(servers.map(async (server) => stopServer(server)));
  builtRoot?.remove();
  combinedRoot?.remove();
});

/** 2 つ目の画面のサーバが、1 つ目（`holder`）を示して、待ち受けずに止まった。 */
const expectRefused = (result: { readonly status: number | null; readonly output: string }, holder: StartedServer): void => {
  expect(result.status, result.output).toBe(START_FAILED_EXIT_CODE);
  expect(result.output).toContain(text.heading);
  expect(result.output).toContain(text.alreadyRunning(holder.child.pid ?? 0, text.alreadyRunningPort(holder.port)));
  expect(result.output).toContain(text.alreadyRunningAction);
  expect(result.output).not.toMatch(/token=/u);
  expect(result.output).not.toMatch(/\n\s+at /u);
};

/** 1 つ目は動き続けている（応答を返す）。 */
const expectStillServing = async (server: StartedServer): Promise<void> => {
  expect(server.child.exitCode).toBeNull();
  const response = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  expect(response.status).toBeLessThan(500);
};

describe('only one local UI server runs at a time (DEF-061)', () => {
  it('refuses a second production launcher with another --port, and keeps the first one serving', async () => {
    const first = await startLauncher(rootOf(builtRoot), await findFreePort());
    servers.push(first);

    expectRefused(runLauncherUntilExit(rootOf(builtRoot), await findFreePort()), first);
    await expectStillServing(first);

    // 1 つ目を強制終了した後は、古いロック（死んだ持ち主）を取り直して起動する。
    await stopServer(first);
    const next = await startLauncher(rootOf(builtRoot), await findFreePort());
    servers.push(next);
    await expectStillServing(next);
    await stopServer(next);
  }, TEST_TIMEOUT_MS);

  it('refuses the dev server while a production launcher runs, and the launcher while the dev server runs', async () => {
    const launcher = await startLauncher(rootOf(combinedRoot), await findFreePort());
    servers.push(launcher);
    expectRefused(runDevServerUntilExit(rootOf(combinedRoot), ['--port', String(await findFreePort())]), launcher);
    await expectStillServing(launcher);
    await stopServer(launcher);

    const dev = await startDevServer(rootOf(combinedRoot), await findFreePort());
    servers.push(dev);
    expectRefused(runLauncherUntilExit(rootOf(combinedRoot), await findFreePort()), dev);
    await expectStillServing(dev);
    await stopServer(dev);
  }, TEST_TIMEOUT_MS);
});
