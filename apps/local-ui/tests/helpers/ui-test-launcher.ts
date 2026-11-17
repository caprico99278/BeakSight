/**
 * RB-7: 画面のテストの、画面のサーバの起動の入口（子の process で `node <このファイル> --port <番号> …` と動かす。Node の型の除去で実行する）。
 * - データの根は、この process の cwd（テストの一時のフォルダ）。監査のワーカーの入口は、その中の `TEST_WORKER_ENTRY`（`local-server.ts` が書く）。
 * - リポジトリのビルドの出力（`apps/local-ui/dist`、`dist`）を、写さずにそのまま使う。2 つ目の入口（`launcher-bridge.js`）に根と入口を入れてから、
 *   本番と同じ起動の部品の本体（`runLocalUiLauncher`）を呼ぶ（同じ URL の module なので、本体が読む 2 つ目の入口と同じ状態を共有する）。
 * - 製品の入口ではない（利用者の起動の手順にない。本番の起動の部品は根を入れない。Gate `local-ui-runtime-boundary`）。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as LauncherBridge from '../../src/server/launcher-bridge.ts';
import { LAUNCHER_BRIDGE_PATH, runLocalUiLauncher } from '../../launcher/serve.ts';
import { TEST_WORKER_ENTRY } from './test-worker-entry.ts';

const bridge = (await import(pathToFileURL(LAUNCHER_BRIDGE_PATH).href)) as Pick<typeof LauncherBridge, 'installLocalUiRuntime'>;
const dataRoot = process.cwd();
bridge.installLocalUiRuntime({ dataRoot, workerPath: join(dataRoot, TEST_WORKER_ENTRY) });
await runLocalUiLauncher(process.argv.slice(2));
