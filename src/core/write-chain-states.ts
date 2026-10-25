// 「登録してから更新する」の続けて始める状態の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 決まり（`apps/local-ui/src/server/write-chain-policy.ts`。T41g）が、ここを同じ名前で公開し直す（定義は 1 か所）。画面のブラウザ側（`apps/local-ui/src/` の
//   `server/` の外）は、画面のサーバの部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。
//   Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 続けて始める状態（閉じた一覧）。`CREATING`: 登録のジョブを始め、終わるのを待っている。`UPDATE_STARTED`: 更新のジョブを始めた。`NOT_STARTED`: 更新を
 * 始めなかった（理由は `WRITE_CHAIN_STOP_REASONS`）。
 */
// T41g-3: `WAITING_LOGIN_INTERVAL`: 登録の後の更新が自動ログインの最小の間隔で止まったので、次に始められる時刻まで待っている（待った後に 1 回だけやり直す）。
export const WRITE_CHAIN_STATES = Object.freeze(['CREATING', 'WAITING_LOGIN_INTERVAL', 'UPDATE_STARTED', 'NOT_STARTED'] as const);
export type WriteChainState = (typeof WRITE_CHAIN_STATES)[number];

/**
 * T41g-2・T41g-3: 続けて更新する予定が、まだ決まっていない状態（登録のジョブの終わりを待っている間と、自動ログインの間隔を待っている間）。画面のジョブの
 * 詳細は、この間はジョブが終わった後も読み直しを続ける。
 */
export const PENDING_WRITE_CHAIN_STATES = Object.freeze(['CREATING', 'WAITING_LOGIN_INTERVAL'] as const satisfies readonly WriteChainState[]);
