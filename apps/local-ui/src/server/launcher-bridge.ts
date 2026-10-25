/**
 * 本番の起動の部品（`launcher/serve.ts`）が読む、ビルドした画面のサーバの入口（T23f）。
 * Vite の SSR のビルドの 2 つ目の入口として、`dist/server/launcher-bridge.js` に出す（`vite.config.ts` の `environments.ssr`）。
 * - 起動の部品は Node の型の除去で動き、`src/` の TypeScript を直接読めない。管理データの準備と、拒否の応答の文言は、ここから受け取る。
 * - 画面のサーバ（`server.js`）と同じ process で読むので、管理データの接続（`control-store`）は 1 つを共有する。
 * - 監査のジョブの管理（`audit-jobs`）の起動のときの準備（中断に直す）と、終わりのときの後始末も、ここから受け取る（T24f）。
 */
export { closeLocalUiStore, prepareLocalUiStore, type LocalUiStorePreparation } from './control-store';
export { prepareLocalUiAuditJobs, runningLocalUiAuditJobCount, shutdownLocalUiAuditJobs } from './audit-jobs';
// T26e（Task 26 の設計書 4.1 の「起動のとき」）: 資格情報のフォルダの一時のファイルの片付けと、暗号化の確かめ（待ち受けの前に 1 回）。
export { prepareLocalUiCredentials } from './credential-runtime';
// DEF-146: 画面のサーバが終わったときの記録（予期しない例外、止める決まり、process の終わり。token は記録に書かない値として渡す）。
export {
  recordLocalUiServerExit,
  recordLocalUiServerShutdown,
  recordLocalUiServerUnexpectedError,
  setLocalUiServerLogSecrets,
} from './ui-server-log-file';
export { AUDIT_JOB_SHUTDOWN_WAIT_MS } from '../../../../src/control/job/job-records.js';
export { formatCount, formatDuration } from '../../../../src/presentation/format.js';
export {
  LOCAL_UI_CONSOLE_TEXT,
  LOCAL_UI_GUARD_REJECTION_TEXT,
  LOCAL_UI_JOB_CONSOLE_TEXT,
  describeLocalUiStartFailure,
} from '../../../../src/presentation/messages.js';
