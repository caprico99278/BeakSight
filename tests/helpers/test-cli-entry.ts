/**
 * RB-4 fix（REV-RB4 の M-1）: ビルドした CLI を、テストだけの外へ出ない引数を付けた Chromium で動かす、テストだけの入口（`tests/integration/cli.test.ts` が
 * `cli-process.ts` を通して使う）。
 * - 一時のビルドの root に置き、ビルドした `dist/cli/main.js` の `runCli` に、`dist/cli/run-command.js` の本番の依存を、Browser の起動だけ替えて渡す
 *   （起動は `TEST_CLI_CHROMIUM_LAUNCH_SOURCE`。本番の起動の部品に、テストだけの引数を足したもの）。返った終了コードで `process.exit` する。
 * - 製品の入口（`dist/cli/index.js`）は写さない。シグナルと出力の誤りの扱いは、`interrupt.ts`・`output-stream.ts` の単体が守る。製品に口は作らない。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_CLI_CHROMIUM_LAUNCH_SOURCE } from './test-chromium-args.js';
import type { TemporaryBuild } from './temporary-build.js';

/** 一時のビルドの root の中の、入口のファイルの名前。 */
const TEST_CLI_ENTRY_FILE = 'test-cli-entry.mjs';

/** 入口の本文（ESM。一時のビルドの root に置き、`./dist/` を読む）。 */
export const TEST_CLI_ENTRY_SOURCE = String.raw`
import { chromiumLaunchOptions, launchChromiumWith } from './dist/browser/chromium-launch.js';
import { runCli } from './dist/cli/main.js';
import { streamOutput } from './dist/cli/output-stream.js';
import { PRODUCTION_RUN_DEPENDENCIES } from './dist/cli/run-command.js';
const run = { ...PRODUCTION_RUN_DEPENDENCIES, launchBrowser: () => ${TEST_CLI_CHROMIUM_LAUNCH_SOURCE} };
const code = await runCli(process.argv.slice(2), { stdout: streamOutput(process.stdout), stderr: streamOutput(process.stderr) }, { run });
process.exit(code);
`;

/** 一時のビルドの root に入口を書き、その path を返す（同じ本文で上書きする）。 */
export const installTestCliEntry = (build: TemporaryBuild): string => {
  const path = join(build.rootDirectory, TEST_CLI_ENTRY_FILE);
  writeFileSync(path, TEST_CLI_ENTRY_SOURCE, 'utf8');
  return path;
};
