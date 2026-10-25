// 認証の状態の知らせ（`AUTH_STATE`）の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 値の意味の説明と、IPC の名前つきの定数（`WORKER_AUTOMATED_LOGIN_FAILED_STATE` など）は、IPC の契約（`src/control/worker-protocol.ts`）に置く。
//   IPC の契約は、ここの一覧を同じ名前で公開し直す（定義は 1 か所）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、管理データと
//   Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。
// - 値は後ろに足すだけにする（管理データの公開済みの版の CHECK は、公開した時点の写しで固定している。`src/control/store/migrations.ts`）。

/** 認証の状態（閉じた一覧）。意味は `worker-protocol.ts` の `WORKER_AUTH_STATES` の説明。 */
export const WORKER_AUTH_STATES = Object.freeze([
  'AWAITING_LOGIN',
  'AUTHENTICATED',
  'AUTH_SETUP_REQUIRED',
  'UNSUPPORTED_AUTH_STATE',
  'SESSION_LOST',
  'LOGIN_TIMEOUT',
  'LOGIN_ATTEMPTS_EXCEEDED',
  'AUTOMATED_LOGIN_FAILED',
] as const);
export type WorkerAuthState = (typeof WORKER_AUTH_STATES)[number];

/** ログイン用の Browser でログインの画面を開き、人がログインするのを待っている状態（画面のジョブの手動のログインの欄が読む）。 */
export const WORKER_AWAITING_LOGIN_STATE = 'AWAITING_LOGIN' satisfies WorkerAuthState;
