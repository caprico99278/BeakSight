// 監査のジョブの記録の値の閉じた一覧と、ジョブの管理の名前つきの時間（Task 24 の設計書 4.4。T24e）。
// 管理データの版 2 と版 3（T25d）と版 4（T26c）の表の CHECK（`src/control/store/migrations.ts`）と、ジョブの管理（`job-store.ts`、
// `audit-job-manager.ts`、自動ログインの記録 `auto-login-store.ts`）が、ここだけを参照する。SQL を書かない（値の一覧と時間だけ）。
// 表示の語（日本語のラベル）は `src/presentation/`（T24f）が持つ。公開済みの版の CHECK は、公開した時点の写しを使う（`migrations.ts`）ので、
// ここの一覧には値を後ろに足してよい。
import { AUTOMATED_LOGIN_FAILURE_RESULTS, type AutomatedLoginFailureResult } from '../auth/automated-login-results.js';
import { CREDENTIAL_CHANGE_KINDS } from '../credentials/credential-store.js';
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
 */
export const AUDIT_JOB_STATES = Object.freeze(['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED'] as const);
export type AuditJobState = (typeof AUDIT_JOB_STATES)[number];

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
  | (typeof AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_7)[number];

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

/** 版 4 の後に足したワーカーの理由か。 */
const isWorkerFailureReasonAfterVersion4 = (reason: string): boolean => (WORKER_FAILURE_REASONS_AFTER_VERSION_4 as readonly string[]).includes(reason);

/**
 * ジョブの失敗と中断の理由の一覧（凍結。重複を除く）。並びは、ワーカーの理由（自動ログインの結果と版 4 の後に足した理由を除く）、ジョブの管理の
 * 理由、自動ログインの成功以外の結果、版 4 の後に足したワーカーの理由（T27c）、版 4 の後に足したジョブの管理の理由（T27d）、版 7 の後に足した
 * ジョブの管理の理由（T30d）の順。T26d-2 でワーカーの `FAILED` の理由に自動ログインの結果を
 * 足したが、この並びは T26c と同じに保つ（名前つきの一覧には、値を後ろに足すだけにする。`control-store-v4.test.ts`、`control-store-v5.test.ts`）。
 */
export const AUDIT_JOB_FAILURE_REASONS: readonly AuditJobFailureReason[] = Object.freeze([
  ...new Set<AuditJobFailureReason>([
    ...WORKER_FAILURE_REASONS.filter((reason) => !isAutomatedLoginFailureResult(reason) && !isWorkerFailureReasonAfterVersion4(reason)),
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS,
    ...AUTOMATED_LOGIN_FAILURE_RESULTS,
    ...WORKER_FAILURE_REASONS_AFTER_VERSION_4,
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_4,
    ...AUDIT_JOB_MANAGER_FAILURE_REASONS_AFTER_VERSION_7,
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

/** ジョブの開始を拒むときの理由（行を作らず、ワーカーを起動しない）。 */
export const AUDIT_JOB_START_REJECTION_REASONS = Object.freeze([
  /** 依頼の形が違う（プロファイルの ID、改訂、`startNew`）。 */
  'INVALID_REQUEST',
  /** プロファイルがない。 */
  'PROFILE_NOT_FOUND',
  /** 取り消したプロファイル。 */
  'PROFILE_RETIRED',
  /** 画面が読んだ改訂と、保存されている改訂が違う（開始の直前に変わった）。 */
  'PROFILE_REVISION_CONFLICT',
  /** そのジョブの種類を、このモードでは実行できない（`execution-policy.ts` の `PROFILE_OPERATION_POLICY` の行にない。T28b）。 */
  'MODE_NOT_EXECUTABLE',
  /**
   * 今は実行できない認証の方式（T25d。`EXECUTABLE_AUTH_STRATEGIES`）。T26d-2: ログインの検証を、自動ログインでないプロファイルで始めようとした
   * ときも、この理由（Windows 以外の自動ログインは、資格情報の暗号化の確かめで `CREDENTIAL_PROTECTION_UNAVAILABLE`）。
   */
  'AUTH_STRATEGY_NOT_EXECUTABLE',
  /** 認証の設定が要るモードで、認証の設定が保存されていない（T25d）。ターゲット設定を読まない。 */
  'AUTH_SETUP_MISSING',
  /** 保存した認証の設定が古い（プロファイルの改訂が変わった。`STALE`。T25d）。ターゲット設定を読まない。 */
  'AUTH_SETUP_STALE',
  /** 保存した認証の設定が、開始の直前の `validateAuthSetup` を通らない（T25d）。 */
  'AUTH_SETUP_INVALID',
  /** ターゲット JSON のパスを受けない（`isAcceptedTargetConfigPath`）。ファイルを読まない。 */
  'TARGET_PATH_INVALID',
  /** ターゲット JSON を読めない、検証を通らない（検証の文脈を用意できない）。 */
  'TARGET_CONFIG_UNAVAILABLE',
  /** 今のターゲット設定で、プロファイルが `validateSiteProfile` を通らない。 */
  'PROFILE_INVALID',
  /** 終わっていないジョブがある（同時に 1 つだけ）。 */
  'JOB_ALREADY_ACTIVE',
  /** 自動ログインのプロファイルで、資格情報のファイルがない（Task 26 の設計書 4.5。T26c）。 */
  'CREDENTIAL_MISSING',
  /** 保存した資格情報のログインの Origin が、今の認証の設定の `loginStartUrl` の Origin と違う（T26c）。 */
  'CREDENTIAL_STALE',
  /** 資格情報の暗号化（DPAPI）が使えない（T26c）。 */
  'CREDENTIAL_PROTECTION_UNAVAILABLE',
  /** 前の自動ログインが成功以外で終わったので、人が画面で解くまで、そのプロファイルの自動ログインを止めている（T26c）。 */
  'AUTO_LOGIN_HELD',
  /** 自動ログインの最小の間隔、24 時間の上限、`Retry-After` の待ちの中（次に始められる時刻がある。T26c）。 */
  'AUTO_LOGIN_RATE_LIMITED',
  /**
   * この管理が、管理のロック（画面のサーバを 1 つだけにする。DEF-061）を失った（ハートビートの間に、ほかの管理が古いと判定して取り直した）。
   * 新しいジョブを始めない（T24h-4）。
   */
  'CONTROL_INSTANCE_LOCK_LOST',
  /** READ の確かめを始めようとしたが、そのプロファイルに、取り消していない READ の確かめの定義が 1 件もない（T27e）。 */
  'READ_CHECK_DEFINITIONS_MISSING',
  /**
   * 書き込みのジョブ（T30e）: 実行の許可を使えない（ない、別のシナリオ・プロファイル、消費済み、無効、期限切れ、消費で拒まれた）。消費で拒まれたときは、
   * ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）で残し、予約を返す（消費していない、そのジョブの許可を無効にする）。
   */
  'WRITE_GRANT_REJECTED',
  /**
   * 書き込みのジョブ（T30e）: 送る値を生成できない（規則が決まらない、一意にする欄の組を使い切った、照合の READ に結び付ける値がない、書き込みの
   * 指定を作れない）。許可は消費済みのまま、結果を `BLOCKED`・`RELEASED` で締め、ジョブの行を `FAILED`（`WRITE_GRANT_REJECTED`）で残す。
   */
  'WRITE_DATA_NOT_GENERATED',
] as const);
export type AuditJobStartRejectionReason = (typeof AUDIT_JOB_START_REJECTION_REASONS)[number];

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
