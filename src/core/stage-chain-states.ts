// まとめて実行の連鎖と段の状態の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - まとめて実行の決まり（`src/control/job/stage-chain-policy.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所）。画面のブラウザ側（`apps/local-ui/src/` の
//   `server/` の外）は、ジョブの管理と Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。値を文字列で比べない。
//   Gate `tests/architecture/browser-list-values.test.ts`）。

/** 連鎖の状態（閉じた一覧）。`RUNNING`: 段を行っている。`FINISHED`: 最後の段まで行った（READ の確かめを行わなかったときを含む）。`STOPPED`: 途中で止めた。 */
export const CHAIN_STATES = Object.freeze(['RUNNING', 'FINISHED', 'STOPPED'] as const);
export type ChainState = (typeof CHAIN_STATES)[number];

/** 段を行っている連鎖の状態（画面は、この間はジョブの詳細を読み直し、連鎖を止めるボタンを出す）。 */
export const RUNNING_CHAIN_STATE = 'RUNNING' satisfies ChainState;

/** 最後の段まで行った連鎖の状態（PRE42-CC 組 Z。ジョブの管理が、止める理由なしに連鎖を終えるときに付ける）。 */
export const FINISHED_CHAIN_STATE = 'FINISHED' satisfies ChainState;

/** 途中で止めた連鎖の状態（PRE42-CC 組 Z。ジョブの管理が、止める理由つきで連鎖を終えるときに付ける）。 */
export const STOPPED_CHAIN_STATE = 'STOPPED' satisfies ChainState;

/**
 * 段の状態（閉じた一覧）。`PENDING`: まだ始めていない。`RUNNING`: 行っている。`DONE`: 終えた（結果はジョブの行）。`NOT_STARTED`: 連鎖を止めたので始めなかった。
 * `NOT_NEEDED`: READ の確かめの定義がないので行わなかった。`STOPPED`（FM2R の I-5）: 連鎖がこの段で止まった（止める要求・止める理由・失敗。結果はジョブの行）。
 */
export const CHAIN_STAGE_STATES = Object.freeze(['PENDING', 'RUNNING', 'DONE', 'NOT_STARTED', 'NOT_NEEDED', 'STOPPED'] as const);
export type ChainStageState = (typeof CHAIN_STAGE_STATES)[number];

/** 連鎖が止まった段の状態（画面は、そのジョブの画面で、止まった理由と次にできることを出す）。 */
export const STOPPED_CHAIN_STAGE_STATE = 'STOPPED' satisfies ChainStageState;

/** 行っている段の状態（PRE42-CC 組 UI-K3。ジョブの管理が、連鎖を止めるときに今の段を見分ける）。 */
export const RUNNING_CHAIN_STAGE_STATE = 'RUNNING' satisfies ChainStageState;

/** まだ始めていない段の状態（PRE42-CC 組 UI-K3。ジョブの管理が、連鎖を止めるときに始めなかった段にする）。 */
export const PENDING_CHAIN_STAGE_STATE = 'PENDING' satisfies ChainStageState;

/** 終えた段の状態（PRE42-CC 組 Z。ジョブの管理が、次の段へ進むときと、止める理由なしに連鎖を終えるときに、行っていた段に付ける）。 */
export const DONE_CHAIN_STAGE_STATE = 'DONE' satisfies ChainStageState;

/** 連鎖を止めたので始めなかった段の状態（PRE42-CC 組 Z。ジョブの管理が、連鎖を止めるときに、まだ始めていない段に付ける）。 */
export const NOT_STARTED_CHAIN_STAGE_STATE = 'NOT_STARTED' satisfies ChainStageState;

/** READ の確かめの定義がないので行わなかった段の状態（PRE42-CC 組 Z。ジョブの管理が、READ の確かめの段に付ける）。 */
export const NOT_NEEDED_CHAIN_STAGE_STATE = 'NOT_NEEDED' satisfies ChainStageState;
