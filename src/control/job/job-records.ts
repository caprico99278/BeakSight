// 監査のジョブの記録の値の閉じた一覧と、ジョブの管理の名前つきの時間（Task 24 の設計書 4.4。T24e）。
// 管理データの版 2 と版 3（T25d）と版 4（T26c）の表の CHECK（`src/control/store/migrations.ts`）と、ジョブの管理（`job-store.ts`、
// `audit-job-manager.ts`、自動ログインの記録 `auto-login-store.ts`）が、ここだけを参照する。SQL を書かない（値の一覧と時間だけ）。
// 表示の語（日本語のラベル）は `src/presentation/`（T24f）が持つ。公開済みの版の CHECK は、公開した時点の写しを使う（`migrations.ts`）ので、
// ここの一覧には値を後ろに足してよい。
import { AUTOMATED_LOGIN_FAILURE_RESULTS, type AutomatedLoginFailureResult } from '../auth/automated-login-results.js';
import { CREDENTIAL_CHANGE_KINDS } from '../credentials/credential-store.js';
import { MINUTE_MS } from '../../core/time-units.js';
import {
  AUDIT_JOB_STATES,
  FAILED_AUDIT_JOB_STATE,
  FINISHED_AUDIT_JOB_STATE,
  STOPPING_AUDIT_JOB_STATE,
  type AuditJobState,
} from '../../core/audit-job-values.js';
import {
  AUDIT_JOB_START_REJECTION_REASONS,
  PROFILE_RETIRED_START_REJECTION_REASON,
  type AuditJobStartRejectionReason,
} from '../../core/audit-job-start-rejection-reasons.js';
import {
  WORKER_FAILURE_REASONS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_JOB_KIND_NOT_SUPPORTED_REASON,
  WORKER_JOB_KINDS,
  type WorkerFailureReason,
  type WorkerJobKind,
} from '../worker-protocol.js';

/**
 * ジョブの種類（`jobs.job_kind`。Task 26 の設計書 4.5。T26c）。どちらも、画面全体で同時に 1 つだけ。
 * - `AUDIT`: 監査（Task 24・25 の監査。自動ログインのプロファイルでは、自動ログインの段の後に監査へ進む）。
 * - `LOGIN_CHECK`: ログインの検証（自動ログインの段だけを行い、結果を記録して終わる。Run を作らない）。
 * - `DISCOVERY`・`READ_CHECK`: 操作の候補の発見と READ の確かめ（Task 27 の設計書 4.6。T27c で一覧に足した。始める口は T27d・T27e で作る）。
 * 既定の値を持たない（作る側が必ず明示する。設計書の変更履歴の「Blocker: T26c」の行の (1)）。
 * T26d-2: ワーカーも同じ一覧を `START` で使うので、定義は IPC の契約（`WORKER_JOB_KINDS`）に移し、ここはその一覧そのものを公開する（定義は 1 か所）。
 */
export const AUDIT_JOB_KINDS = WORKER_JOB_KINDS;
export type AuditJobKind = WorkerJobKind;

/**
 * ジョブの状態（`jobs.state`）。
 * - `STARTING`: 行を作り、ワーカーを起動した（`RUN_STARTED` の前）。
 * - `RUNNING`: ワーカーが Run を始めた（`RUN_STARTED`）。
 * - `STOPPING`: 止める要求（`STOP`）を送った。
 * - `FINISHED`: ワーカーが結果（`FINISHED`）を送った（Run の状態と終了コードは、中核の結果のまま）。
 * - `FAILED`: ワーカーが `FAILED` を送った、ワーカーを起動できなかった、契約に反した。
 * - `INTERRUPTED`: 結果の前にワーカーが終わった、止めた、応答しなくなった、画面のサーバが終わった。
 * PRE42-CC 組 UI-K（N4-8f）: 一覧と名前つきの定数（`FINISHED_AUDIT_JOB_STATE`（PRE42-CC 組 3。N4-8b）・`STOPPING_AUDIT_JOB_STATE`・
 * `FAILED_AUDIT_JOB_STATE`）の定義は、画面のブラウザ側からも読める純粋なファイル `src/core/audit-job-values.ts` に移し、ここは同じ名前で公開し直す
 * （同じ定数を置き直さない。値を文字列で比べない。`tests/architecture/job-kind-constants.test.ts` の (c)）。
 */
export { AUDIT_JOB_STATES, FAILED_AUDIT_JOB_STATE, FINISHED_AUDIT_JOB_STATE, STOPPING_AUDIT_JOB_STATE, type AuditJobState };

/** 終わっていないジョブの状態（同時に 1 つだけ。この状態の行は、全体で 1 行まで）。 */
export const ACTIVE_AUDIT_JOB_STATES = Object.freeze(['STARTING', 'RUNNING', 'STOPPING'] as const satisfies readonly AuditJobState[]);
export type ActiveAuditJobState = (typeof ACTIVE_AUDIT_JOB_STATES)[number];

/** 終わったジョブの状態（`finished_at` と、`FAILED`・`INTERRUPTED` では理由を持つ）。 */
export const FINAL_AUDIT_JOB_STATES = Object.freeze(['FINISHED', 'FAILED', 'INTERRUPTED'] as const satisfies readonly AuditJobState[]);
export type FinalAuditJobState = (typeof FINAL_AUDIT_JOB_STATES)[number];

/** 理由を持つ終わりの状態。 */
export const AUDIT_JOB_STATES_WITH_REASON = Object.freeze(['FAILED', 'INTERRUPTED'] as const satisfies readonly FinalAuditJobState[]);

/**
 * ジョブの失敗と中断の理由（`jobs.failure_reason`）。先頭は、ワーカーが `FAILED` で送る理由（`WORKER_FAILURE_REASONS`。T25d で認証の理由を
 * 足した。管理データの版 2 の CHECK は公開した時点の写しで固定し、版 3 でジョブの表を作り直して今の一覧の CHECK にした）。
 * - `WORKER_START_FAILED`: ワーカーを起動できなかった（ファイルがない、fork の誤り）。`FAILED`。
 * - `WORKER_NOT_READY`: 名前つきの時間の中に `READY` が来なかった。`FAILED`。
 * - `WORKER_EXITED`: ワーカーが結果の前に終わった（強制の止め方の終了コード 5 を含む。終了コードは `exit_code`）。`INTERRUPTED`。
 * - `WORKER_UNRESPONSIVE`: `HEARTBEAT` が名前つきの時間より長く来なかったので、ワーカーを止めた。`INTERRUPTED`。
 * - `STOP_TIMEOUT`: 強制の止め方の後も名前つきの時間の中に終わらなかったので、ワーカーを止めた。`INTERRUPTED`。
 * - `SERVER_RESTARTED`: 画面のサーバの起動のときに、前のサーバの終わっていないジョブを見つけた。`INTERRUPTED`。
 * - `SERVER_SHUTDOWN`: 画面のサーバの終わりのときに、待つ時間の中に終わらなかったので、ワーカーを止めた。`INTERRUPTED`。
 * 親が契約に反するメッセージを受けたときは、`PROTOCOL_VIOLATION`（`FAILED`）。
 * T26c: 後ろに、自動ログインの成功以外の結果（`AUTOMATED_LOGIN_FAILURE_RESULTS`。ジョブがその結果で終わったときの理由）を足した。管理データの
 * 版 3 の CHECK は公開した時点の写しで固定し、版 4 でジョブの表を作り直して今の一覧の CHECK にした。
 */
const AUDIT_JOB_MANAGER_FAILURE_REASONS = Object.freeze([
  'WORKER_START_FAILED',
  'WORKER_NOT_READY',
  'WORKER_EXITED',
  'WORKER_UNRESPONSIVE',
  'STOP_TIMEOUT',
  'SERVER_RESTARTED',
  'SERVER_SHUTDOWN',
] as const);

/** ジョブの失敗と中断の理由（ワーカーの理由、ジョブの管理の理由、自動ログインの成功以外の結果）。 */
export type AuditJobFailureReason =
  | WorkerFailureReason
  | (typeof AUDIT_JOB_MANAGER_FAILURE_REASONS)[number]
  | AutomatedLoginFailureResult
  | (typeof AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_4)[number]
  | (typeof AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_7)[number]
  | (typeof AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_11)[number];

/** 自動ログインの成功以外の結果か（ワーカーの `FAILED` の理由にも入っている。T26d-2）。 */
const isAutomatedLoginFailureResult = (reason: string): boolean => (AUTOMATED_LOGIN_FAILURE_RESULTS as readonly string[]).includes(reason);

/**
 * 管理データの版 4 を公開した後に、ワーカーの `FAILED` の理由に足した値（T27c）。失敗の理由の一覧では、版 4 の値の後ろに置く（名前つきの一覧には、
 * 値を後ろに足すだけにする）。
 */
const WORKER_FAILURE_REASONS_AFTER_VERSION_4 = Object.freeze([WORKER_JOB_KIND_NOT_SUPPORTED_REASON] as const satisfies readonly WorkerFailureReason[]);

/**
 * 管理データの版 4 を公開した後に、ジョブの管理の理由に足した値（T27d。Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）。版 4 の後に足した
 * ワーカーの理由の、さらに後ろに置く。
 * - `DISCOVERY_RESULT_INVALID`: 発見のジョブの終わりに、ワーカーが書いた `discovery.json` を読めない、スキーマに合わない、ジョブの ID・Run の ID・
 *   件数の要約が合わない、または索引に記録できない形だった。索引を変えずに、ジョブを `FAILED` にする。
 * - `READ_CHECK_RESULT_INVALID`（T27e）: READ の確かめのジョブの終わりに、ワーカーが書いた `read-evidence.json` を読めない、スキーマに合わない、
 *   ジョブの ID・Run の ID・Run Status・件数の要約・定義の一覧が合わない、または結果を記録できなかった。結果を記録せずに、ジョブを `FAILED` にする。
 */
const AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_4 = Object.freeze(['DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID'] as const);

/**
 * 管理データの版 7 を公開した後に、ジョブの管理の理由に足した値（T30d。Task 30 の設計書 3 章の「記録」。書き込みのジョブ `WRITE_CREATE`）。
 * 版 4 の後に足したジョブの管理の理由の、さらに後ろに置く。
 * - `WRITE_GRANT_REJECTED`: 書き込みのジョブの始めか送る直前に、実行の許可を消費できない・確かめ直しで外れた（撤回、期限切れ、事実の変化など）。
 *   送らずに、ジョブを `FAILED` にする（予約は送らなかったことの報告で返す。使う口は T30e）。
 * - `WRITE_RESULT_INVALID`: 書き込みのジョブの終わりに、ワーカーが書いた `action-run.json` を読めない、スキーマに合わない、ジョブ・許可・シナリオが
 *   合わない、または結果を記録できなかった。結果は `UNKNOWN` で締め、ジョブを `FAILED` にする（使う口は T30e）。
 */
const AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_7 = Object.freeze(['WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID'] as const);

/**
 * 管理データの版 11 を公開した後に、ジョブの管理の理由に足した値（T43c。Task 43 の設計書 4.3。入口の確かめのジョブ `ENTRY_CHECK`）。版 7 の後に足した
 * ジョブの管理の理由の、さらに後ろに置く（管理データの版 12 でジョブの表を作り直し、今の一覧の CHECK にした）。
 * - `ENTRY_CHECK_RESULT_INVALID`: 入口の確かめのジョブの終わりに、ワーカーが書いた `entry-check.json` を読めない、スキーマに合わない、ジョブの ID・
 *   Run の ID・Run Status・件数の要約が合わない。ジョブを `FAILED` にする（画面は、その案を使わない）。
 */
const AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_11 = Object.freeze(['ENTRY_CHECK_RESULT_INVALID'] as const);

/** 版 4 の後に足したワーカーの理由か。 */
const isWorkerFailureReasonAfterVersion4 = (reason: string): boolean => (WORKER_FAILURE_REASONS_AFTER_VERSION_4 as readonly string[]).includes(reason);

/**
 * ジョブの失敗と中断の理由の一覧（凍結。重複を除く）。並びは、ワーカーの理由（自動ログインの結果と版 4 の後に足した理由を除く）、ジョブの管理の
 * 理由、自動ログインの成功以外の結果、版 4 の後に足したワーカーの理由（T27c）、版 4 の後に足したジョブの管理の理由（T27d）、版 7 の後に足した
 * ジョブの管理の理由（T30d）の順。T26d-2 でワーカーの `FAILED` の理由に自動ログインの結果を
 * 足したが、この並びは T26c と同じに保つ（LG-2: 並びと値は、管理データの基準の版 17 の CHECK と等しい。`tests/integration/control-store-base-schema.test.ts`）。
 */
export const AUDIT_JOB_FAILURE_REASONS: readonly AuditJobFailureReason[] = Object.freeze([
  ...new Set<AuditJobFailureReason>([
    ...WORKER_FAILURE_REASONS.filter((reason) => !isAutomatedLoginFailureResult(reason) && !isWorkerFailureReasonAfterVersion4(reason)),
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS,
    ...AUTOMATED_LOGIN_FAILURE_RESULTS,
    ...WORKER_FAILURE_REASONS_AFTER_VERSION_4,
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_4,
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_7,
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_11,
  ]),
]);

/**
 * 書き込みのジョブの報告の確かめの結果（T32g。Task 32 の設計書 4.1 の「報告の確かめの記録」。管理データの版 10 の `jobs.write_report_check`）。
 * ジョブの管理が、書き込みの結果の締めと同じ時点で 1 回だけ記録し、画面は `VALID` のときだけ報告（`action-evidence.json`・`approval-summary.json`・
 * `action-report.html`・書き込みのバンドル）を配る。報告の不一致は、書き込みの結果（予約・台帳）を変えない。
 * - `VALID`: 報告の 2 つの JSON がスキーマに合い、ジョブ・Run・許可が `action-run.json` と同じで、承認の要約が `START` の承認の要約の事実と同じで、
 *   バンドルの目録の sha256 が中身とディスクのファイルと一致した。
 * - `REPORT_MISSING`: 報告のファイル（2 つの JSON、HTML、バンドル）のどれかがない・読めない。
 * - `REPORT_INVALID`: 報告の JSON が JSON でない・スキーマに合わない、またはバンドルを展開できない。
 * - `REPORT_MISMATCH`: 報告のジョブ・Run・プロファイル・シナリオと版・許可・結果と理由が、`action-run.json` と違う。
 * - `APPROVAL_FACTS_MISMATCH`: 承認の要約が、`START` で送った承認の要約の事実と違う。
 * - `BUNDLE_MISMATCH`: バンドルの目録の sha256 が、中身かディスクのファイルと違う（項目が足りない・多いを含む）。
 * - `RESULT_INVALID`: `action-run.json` を使えなかった（ジョブは `WRITE_RESULT_INVALID`）ので、報告を照らしていない（配らない）。
 */
export const WRITE_REPORT_CHECKS = Object.freeze([
  'VALID',
  'REPORT_MISSING',
  'REPORT_INVALID',
  'REPORT_MISMATCH',
  'APPROVAL_FACTS_MISMATCH',
  'BUNDLE_MISMATCH',
  'RESULT_INVALID',
] as const);
export type WriteReportCheck = (typeof WRITE_REPORT_CHECKS)[number];

/**
 * ジョブのログインの段のまとめ（T34e。管理データの版 11 の `jobs.login_stage_summary`。JSON の object）の最大長（UTF-16 のコード単位。表の CHECK）。
 * 最も大きいまとめ（上限の件数・長さの一覧と、安全な整数の最大の回数）が収まる大きさ（`tests/integration/control-store-job-summaries.test.ts` で確かめる）。
 */
export const MAX_LOGIN_STAGE_SUMMARY_LENGTH = 32_768;

/**
 * DEF-138: ジョブのセッションの切れの証拠（管理データの版 16 の `jobs.session_loss`。JSON の object）の最大長（UTF-16 のコード単位。表の CHECK）。最も大きい
 * 証拠（上限の件数の経路と止めた要求の、最大の長さの path の表記）が収まる大きさ（`tests/integration/control-store-job-summaries.test.ts` で確かめる）。
 */
export const MAX_SESSION_LOSS_RECORD_LENGTH = 65_536;

/**
 * ジョブの開始を拒むときの理由（行を作らず、ワーカーを起動しない）。PRE42-CC 組 UI-K2（CC-113）: 一覧の定義と値の意味は、画面のブラウザ側からも読める
 * 純粋なファイル `src/core/audit-job-start-rejection-reasons.ts` に移し、ここは同じ名前で公開し直す（定義は 1 か所）。
 */
export { AUDIT_JOB_START_REJECTION_REASONS, PROFILE_RETIRED_START_REJECTION_REASON, type AuditJobStartRejectionReason };

/**
 * 保存した資格情報の変更と削除を拒むときの理由（Task 26 の設計書 4.2 の「ジョブが動いているとき」。T26c で置き場所を決めた。使うのは T26e）。
 * - `CREDENTIAL_IN_USE`: そのプロファイルのジョブが終わっていない。
 */
export const CREDENTIAL_CHANGE_REJECTION_REASONS = Object.freeze(['CREDENTIAL_IN_USE'] as const);
export type CredentialChangeRejectionReason = (typeof CREDENTIAL_CHANGE_REJECTION_REASONS)[number];

/**
 * 資格情報の変更の記録の種類（管理データの版 4 の `credential_events.kind`。Task 26 の設計書 4.2、4.5。T26c）。資格情報のファイルの最後の
 * 変更の種類（T26a の `CREDENTIAL_CHANGE_KINDS`）に、削除（`DELETED`）と、自動ログインの停止を解いた（`HOLD_CLEARED`）を足したもの。
 */
export const CREDENTIAL_EVENT_KINDS = Object.freeze([...CREDENTIAL_CHANGE_KINDS, 'DELETED', 'HOLD_CLEARED'] as const);
export type CredentialEventKind = (typeof CREDENTIAL_EVENT_KINDS)[number];

/** 自動ログインの停止を解いたときの記録の種類。 */
export const CREDENTIAL_EVENT_HOLD_CLEARED = 'HOLD_CLEARED' satisfies CredentialEventKind;

/** ジョブの停止を拒むときの理由。 */
export const AUDIT_JOB_STOP_REJECTION_REASONS = Object.freeze([
  /** ジョブがない。 */
  'JOB_NOT_FOUND',
  /** ジョブは終わっている。 */
  'JOB_NOT_ACTIVE',
  /** ジョブは、この画面のサーバが起動したワーカーのものではない（前のサーバの行など）。 */
  'JOB_NOT_OWNED',
] as const);
export type AuditJobStopRejectionReason = (typeof AUDIT_JOB_STOP_REJECTION_REASONS)[number];

/** ワーカーを起動してから `READY` を待つ時間（ms）。ワーカーは Playwright などを読み込んでから `READY` を送る。 */
export const AUDIT_JOB_READY_TIMEOUT_MS = 30_000;

/** 見張りの倍率（`HEARTBEAT` の間隔の何倍の間、合図が来なければ応答しないとみなすか）。CPU の混雑で合図が遅れても止めない余裕。 */
const AUDIT_JOB_HEARTBEAT_TIMEOUT_FACTOR = 10;

/** `HEARTBEAT` が来ない時間の上限（ms）。過ぎたら、ワーカーを止めて `INTERRUPTED`（`WORKER_UNRESPONSIVE`）。 */
export const AUDIT_JOB_HEARTBEAT_TIMEOUT_MS = WORKER_HEARTBEAT_INTERVAL_MS * AUDIT_JOB_HEARTBEAT_TIMEOUT_FACTOR;

/** 見張りが確かめる間隔（ms。合図の間隔と同じ）。 */
export const AUDIT_JOB_WATCHDOG_INTERVAL_MS = WORKER_HEARTBEAT_INTERVAL_MS;

/**
 * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: ワーカーが「Run の終わり」の段の知らせ（`RUN_FINALIZING`）を
 * 送った後の、`HEARTBEAT` が来ない時間の上限（ms。15 分）。その段（集計・成果物の書き出し・止めたときの片付け）は、大きな Run では main thread を長く
 * 占め、その間は合図を送れない（実テスト環境の 139 ページ・168 MB で 20 秒を超えた）。過ぎたら、今と同じく止めて `INTERRUPTED`（`WORKER_UNRESPONSIVE`）。
 * ワーカーの process の終わりは、この上限によらず、すぐ見つける。
 */
export const AUDIT_JOB_FINALIZING_HEARTBEAT_TIMEOUT_MS = 15 * MINUTE_MS;

/**
 * DEF-143: 見張りの回の遅れの上限（ms。途絶えの上限の半分）。見張りの間隔より、この量を超えて遅れた回は、親自身の main thread が止まっていたとみなし、
 * その回は判定しない（止まっている間に届いて溜まった `HEARTBEAT` を受けてから、次の回で判定する）。半分なら、親が止まった時間が上限の内では、ワーカーが
 * 止まる前に受けた最後の合図からの時間が、途絶えの上限に届かない。
 */
export const AUDIT_JOB_WATCHDOG_LAG_LIMIT_MS = AUDIT_JOB_HEARTBEAT_TIMEOUT_MS / 2;

/** 進み具合（`PROGRESS`）を管理データに書く最短の間隔（ms）。間の値は、最後の値だけを後で書く（書き込みの回数を抑える）。 */
export const AUDIT_JOB_PROGRESS_WRITE_INTERVAL_MS = 1_000;

/** 止める要求（`STOP`）の後に、画面が「強制的に止める」を出すまでの時間（ms。T24f が使う）。 */
export const AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS = 30_000;

/** 強制の止め方（`STOP`（`force`））の後も終わらないときに、ワーカーを止める（kill する）までの時間（ms）。 */
export const AUDIT_JOB_FORCE_STOP_KILL_AFTER_MS = 10_000;

/**
 * 結果（`FINISHED`・`FAILED`）を受けてから、ワーカーの process が終わるのを待つ時間（ms。T24h-1 の M2）。ジョブの終わりの記録は、ワーカーが
 * 終わった後に行う（それまで同時に 1 つの枠を空けない）。過ぎても終わらなければ、ワーカーを止める（kill）。
 */
export const AUDIT_JOB_EXIT_WAIT_MS = 10_000;

/**
 * ワーカーの process の終わり（`exit`）を受けてから、IPC が切れる（`disconnect`）のを待つ上限（ms。DEF-084）。Node.js の `fork` では、混雑の
 * 下で、子が最後に送ったメッセージより先に `exit` が来ることがある（`disconnect` は、どの条件でも最後のメッセージより後に来た）。待つ間に届いた
 * メッセージは、今までどおり処理する。過ぎたら、届いていないものとして終わりを決める。値は、`exit` から `close` までの観測の最大（768 ms。
 * 混雑の下の調査）に余裕を持たせたもの。
 */
export const AUDIT_JOB_IPC_DRAIN_WAIT_MS = 3_000;

/** 画面のサーバの終わりのときに、動いているジョブの終わりを待つ時間の既定（ms）。過ぎたら、ワーカーを止める。 */
export const AUDIT_JOB_SHUTDOWN_WAIT_MS = 10_000;

/**
 * 管理のロック（`control_instance` の表。画面のサーバを 1 つだけにする。独立レビュー T24R の C1、DEF-061。T24h-4）の行の番号。表は、この
 * 番号の 1 行だけを持つ（表の CHECK と、行の読み書きの部品 `instance-lock.ts` が使う）。
 */
export const CONTROL_INSTANCE_SLOT = 1;

/** 管理のロックに記録する、持ち主の port の範囲（TCP の port の番号）。 */
export const MIN_CONTROL_INSTANCE_PORT = 1;
export const MAX_CONTROL_INSTANCE_PORT = 65_535;

/**
 * ほかの管理（前の画面のサーバ、またはロックを失った画面のサーバ）の、終わっていないジョブのワーカーが、まだ動いているとみなす時間（ms。
 * T24h-6。再レビュー T24R2 の m1）。ワーカーの process が動いていて（`isProcessRunning`）、最後の合図の記録（なければ行を作った時刻）がこの
 * 時間の中なら、そのジョブを中断に直さず、新しい開始を拒む。process の ID の使い回しは、合図の記録の新しさで見分ける（合図を記録するのは、
 * ワーカーを動かしている画面のサーバだけ。process の起動の時刻は、Node から手軽に読めないので比べない）。過ぎたら、中断に直す。値は見張りの
 * 時間と同じ（合図がこれより長く来なければ、応答しないとみなす）。
 */
export const AUDIT_JOB_UNOWNED_WORKER_STALE_AFTER_MS = AUDIT_JOB_HEARTBEAT_TIMEOUT_MS;

/**
 * 管理のロックを失った（ほかの管理が取り直した）ときに、自分の動いているワーカーに `STOP` を送ってから、終わりを待つ時間（ms。T24h-6）。
 * 今のページを終えて書き出すまでの余裕。過ぎても終わらなければ、ワーカーを止める（`STOP_TIMEOUT`）。
 */
export const AUDIT_JOB_LOCK_LOST_KILL_AFTER_MS = 60_000;
