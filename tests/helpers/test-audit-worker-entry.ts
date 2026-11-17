/**
 * RB-fix-456（DEF-277）: ビルドした監査のワーカーを、テストだけの外へ出ない引数を付けた Chromium で動かす、テストだけの入口（本物のワーカーを fork する結合テスト
 * `audit-worker.test.ts`・`control-audit-jobs-worker.test.ts`・`worker-finalizing-heartbeat-fork.test.ts` が使う）。
 * - 一時のビルドの root に置き（`buildEntryPath`）、ビルドした `dist/worker/audit-worker-process.js` の `runAuditWorkerProcess` に、Run・手動のログイン・自動ログインの
 *   3 つの Browser の起動だけを替えて渡す（起動は `TEST_CLI_CHROMIUM_LAUNCH_SOURCE`。本番の起動の部品に、テストだけの引数を足したもの。headless）。
 * - 製品の入口（`dist/worker/audit-worker.js`）は fork しない（Gate `chromium-launch-ownership`）。製品に口は作らない。
 */
import { writeFileSync } from 'node:fs';
import { TEST_CLI_CHROMIUM_LAUNCH_SOURCE } from './test-chromium-args.js';
import { buildEntryPath, type TemporaryBuild } from './temporary-build.js';

/** 入口の本文（ESM。一時のビルドの root に置き、`./dist/` を読む）。 */
export const TEST_AUDIT_WORKER_ENTRY_SOURCE = String.raw`
import { chromiumLaunchOptions, launchChromiumWith } from './dist/browser/chromium-launch.js';
import { runAuditWorkerProcess } from './dist/worker/audit-worker-process.js';
runAuditWorkerProcess(process, {
  launchRunBrowser: () => ${TEST_CLI_CHROMIUM_LAUNCH_SOURCE},
  loginStage: { launchLoginBrowser: () => ${TEST_CLI_CHROMIUM_LAUNCH_SOURCE} },
  automatedLoginStage: { launchAutomatedLoginBrowser: () => ${TEST_CLI_CHROMIUM_LAUNCH_SOURCE} },
});
`;

/** 一時のビルドの root に入口を書き、その path を返す。 */
export const installTestAuditWorkerEntry = (build: TemporaryBuild): string => {
  const path = buildEntryPath(build, 'test-audit-worker-entry.mjs');
  writeFileSync(path, TEST_AUDIT_WORKER_ENTRY_SOURCE, 'utf8');
  return path;
};
