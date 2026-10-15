/**
 * 監査のワーカーの入口（Task 24 の設計書 3 章、4.2。T24d）。本番は `dist/worker/audit-worker.js` を、画面のサーバ（`src/control/job/`、T24e）が
 * `child_process.fork`（IPC つき、detached にしない、cwd はリポジトリの root）で起動する。process の組み立ては `audit-worker-process.ts`、流れは
 * `audit-worker-session.ts`。
 * T25d: 入口は、本番の依存だけで始める（テストだけの口の指定を渡さない。ログイン用の Browser は headed で、資格情報を自動で入れる処理はない）。
 */
import { runAuditWorkerProcess } from './audit-worker-process.js';

runAuditWorkerProcess(process);
