// ジョブの種類と状態の値の契約（PRE42-CC 組 UI-K。台帳の N4-8f・CC-105 の `$jobId.tsx`）。純粋な定義だけのファイル（import を持たない）。
// - 種類の一覧と名前つきの定数は IPC の契約（`src/control/worker-protocol.ts`）が、状態の一覧と名前つきの定数はジョブの記録
//   （`src/control/job/job-records.ts`）が、ここを公開し直して使う（値の意味の説明は、それぞれのファイルに置く）。画面のブラウザ側
//   （`apps/local-ui/src/` の `server/` の外）も、管理データと Node の部品に触れずに値を読めるように、ここから読む（`scenario-kind.ts` と同じ置き方）。
// - 値を書くのはここだけ（`tests/architecture/job-kind-constants.test.ts`。`'AUDIT' satisfies WorkerJobKind` を書き写さない。値を文字列で比べない）。
// - 値は後ろに足すだけにする（管理データの公開済みの版の CHECK は、公開した時点の写しで固定している。`src/control/store/migrations.ts`）。

/** ジョブの種類（閉じた一覧。`jobs.job_kind` と、ワーカーの `START`）。意味は `worker-protocol.ts` の `WORKER_JOB_KINDS` の説明。 */
export const WORKER_JOB_KINDS = Object.freeze(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK'] as const);
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

/** 監査のジョブの種類（T44g。Task 44 の設計書 P4-8 の CC-105: 画面のサーバの 3 つのファイルにあった同じ定数を、1 つにした）。 */
export const WORKER_AUDIT_JOB_KIND = 'AUDIT' satisfies WorkerJobKind;

/** ログインの検証のジョブの種類。 */
export const WORKER_LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK' satisfies WorkerJobKind;

/** 操作の候補の発見のジョブの種類（T27d。認証つきの `START` だけ）。 */
export const WORKER_DISCOVERY_JOB_KIND = 'DISCOVERY' satisfies WorkerJobKind;

/** READ の確かめのジョブの種類（T27e。認証つきで、定義の一覧を持つ `START` だけ）。 */
export const WORKER_READ_CHECK_JOB_KIND = 'READ_CHECK' satisfies WorkerJobKind;

/** 書き込みのジョブの種類（T30e。認証つきで、書き込みの指定を持つ `START` だけ）。 */
export const WORKER_WRITE_CREATE_JOB_KIND = 'WRITE_CREATE' satisfies WorkerJobKind;

/** 更新の書き込みのジョブの種類（T31f。認証つきで、UPDATE の指定（`write.update`）を持つ書き込みの指定を持つ `START` だけ。ワーカーの流れは T31g-2）。 */
export const WORKER_WRITE_UPDATE_JOB_KIND = 'WRITE_UPDATE' satisfies WorkerJobKind;

/** 入口の確かめのジョブの種類（T43c。認証の指定を持たない `START` だけ）。 */
export const WORKER_ENTRY_CHECK_JOB_KIND = 'ENTRY_CHECK' satisfies WorkerJobKind;

/** ジョブの状態（閉じた一覧。`jobs.state`）。意味は `job-records.ts` の `AUDIT_JOB_STATES` の説明。 */
export const AUDIT_JOB_STATES = Object.freeze(['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED'] as const);
export type AuditJobState = (typeof AUDIT_JOB_STATES)[number];

/**
 * ワーカーが結果を送って終わったジョブの状態（PRE42-CC 組 3。N4-8b）。画面のサーバが、結果の文書を読んでよいジョブかを決めるのに読む。
 * 画面のブラウザ側は、入口の確かめの結果を出してよいかを決めるのに読む（組 UI-K）。
 */
export const FINISHED_AUDIT_JOB_STATE = 'FINISHED' satisfies AuditJobState;

/** 止める要求（`STOP`）を送ったジョブの状態（組 UI-K）。強制の止め方を示すか（画面のサーバ）と、止める要求の知らせ（画面のブラウザ側）に読む。 */
export const STOPPING_AUDIT_JOB_STATE = 'STOPPING' satisfies AuditJobState;

/** 失敗したジョブの状態（組 UI-K）。画面のブラウザ側が、失敗の理由の知らせの強さを決めるのに読む。 */
export const FAILED_AUDIT_JOB_STATE = 'FAILED' satisfies AuditJobState;
