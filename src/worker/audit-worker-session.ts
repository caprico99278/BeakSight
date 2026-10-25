/**
 * 監査のワーカーの流れ（Task 24 の設計書 4.2、4.3。T24d）。入口（`audit-worker.ts`）が、本物の IPC の口と本番の依存を渡して呼ぶ。テストは、偽の口と
 * 偽の中核を渡して確かめる。
 *
 * 起動から終わりまで:
 * 1. `READY` を送り、`START` を待つ。名前つきの時間（`WORKER_START_TIMEOUT_MS`）の中に来なければ、`FAILED`（`START_TIMEOUT`）を送って、
 *    終了コード 1 で終える。生きている合図（`HEARTBEAT`）を、名前つきの間隔（`WORKER_HEARTBEAT_INTERVAL_MS`）で送る（タイマーは unref）。
 * 2. 親のメッセージは、どれも `validateParentToWorkerMessage` で検証してから使う。形の違う値、2 回目の `START` を受けたら、その親を信用しない:
 *    `FAILED`（`PROTOCOL_VIOLATION`）を送り、`START` の前なら終了コード 1 で終える。Run の途中なら、止める印を付け（CLI の Ctrl+C の 1 回目と
 *    同じ止まり方）、以後の親のメッセージを受けず、`FINISHED` を送らずに、Run の終了コードで終える。
 * 3. `START` を受けたら、設定を `loadConfig` で読む（上書きは、CLI の `--headless` に当たる `WORKER_CONFIG_OVERRIDES` だけ。ほかの上書きを
 *    受けない）。監査の中核（`executeAuditRun`）に、止める印と `startNew` を渡す。観測の口の値を `RUN_STARTED`・`PROGRESS`・`NOTICE` で送る。
 *    結果を `FINISHED`（画面に要る項目だけ）で送り、結果の `exitCode` で終える。
 * 4. 設定の誤りと予期しない例外は、`classifyCliFailure` で分けて `FAILED` を送り、同じ終了コードで終える。
 * 5. 設定を読む前と読んだ後に、ターゲット JSON の SHA-256 を求め、`START` の `targetConfigSha256`（親が開始の直前の検証で読んだもの）と
 *    比べる。どちらかが違えば（読めない場合を含む）、監査を始めずに `FAILED`（`CONFIG_CHANGED`）を送り、設定の誤りと同じ終了コード 4 で
 *    終える（T24h-1 の M3。親の検証とワーカーの読み込みの間の TOCTOU）。
 *
 * 6. 認証つきの `START`（`authentication` あり。T25d。Task 25 の設計書 4.4）: 設定を読んだ後、ログインの段の前に、認証つきの Run の指定を
 *    `assertRunAuthentication` で確かめる（T25f round 2。設定の誤りなら `FAILED`（`CONFIG_ERROR`）で、ログイン用の Browser を起動しない）。
 *    監査の前に（再開のときも）ログインの段（`runLoginStage`。`authenticated-login.ts`）を行う。受けた認証の設定と許可 Origin から SHA-256 を求め直し、違えば `FAILED`
 *    （`AUTH_SETUP_CHANGED`）。ログインの段の知らせは `AUTH_STATE`（`AWAITING_LOGIN`、`AUTHENTICATED`、失敗の状態）で送り、失敗なら同じ値の
 *    `FAILED` を送る。成功したら、状態（メモリだけ）と認証の設定から作った認証の指定（`RunAuthentication`）を、監査の中核に渡す。Run Coordinator
 *    のセッションの切れの知らせ（`AUTH_SESSION_LOST`）は、止まったページの URL つきの `AUTH_STATE`（`SESSION_LOST`）で送る。
 * 7. 自動ログイン（`authentication.automatedLogin` あり。T26d-2。Task 26 の設計書 3 章、4.4、4.5）: 手動のログインの段の代わりに、自動ログインの段
 *    （`runAutomatedLoginStage`。`automated-login.ts`）を行う。**手動の方式へ切り替えない**（自動ログインが失敗しても、手動のログインの段を呼ばず、
 *    headed のブラウザを開かない）。SHA-256 は、ジョブの種類と `automatedLogin` も含めて求め直す。結果は、`AUTH_STATE` の `automatedLogin`
 *    （閉じた一覧の結果、送信したか、`Retry-After` の期限、フォームの確かめの理由のコード。値・誤りの文・URL を含まない）で送る。
 *    - 成功: `AUTHENTICATED`（成功の結果）を送る。`AUDIT` は、状態（メモリだけ）を監査に渡す（Task 25 と同じ）。`LOGIN_CHECK` は、状態を捨てて、
 *      Run を作らず、成果物を書かず、監査の Browser を起動せずに、終了コード 0 で終える（`FINISHED` を送らない。親は `AUTH_STATE` で終わりを知る）。
 *    - 成功以外: `AUTOMATED_LOGIN_FAILED`（結果つき）と、結果を理由にした `FAILED` を送り、監査を始めずに終了コード 1 で終える。ログインは成功したが
 *      許可 Origin の状態がない場合は、`UNSUPPORTED_AUTH_STATE`（成功の結果つき）と `FAILED`（`UNSUPPORTED_AUTH_STATE`）。
 *    - 止める要求: `AUTOMATED_LOGIN_FAILED`（`AUTH_RESULT_UNKNOWN` と、観測した送信）を送り、`FAILED` を送らずに終了コード 5 で終える。
 *    `LOGIN_CHECK` は、認証つきの Run の確かめ（`assertRunAuthentication`）をしない（Run を作らない）。
 * 8. 発見のジョブ（`DISCOVERY`。T27d。Task 27 の設計書 4.6）: 認証つきの `START` だけ（契約で確かめる）。ログインの段（手動か自動。上の 6・7 の
 *    まま）の後に、監査の中核の代わりに、発見の流れ（`executeDiscovery`。`discovery-run.ts`）を行う。`RUN_STARTED`（新しい Run）、セッションの
 *    切れの `AUTH_STATE`（`SESSION_LOST`）、`FINISHED`（Run のディレクトリと件数の要約だけ。候補は載せない）を送る。発見の流れが渡されて
 *    いなければ、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む。発見のジョブは再開しない。
 * 9. READ の確かめのジョブ（`READ_CHECK`。T27e。Task 27 の設計書 4.5）: 認証つきで、定義の一覧（`readChecks`）を持つ `START` だけ（契約で
 *    確かめる）。ログインの段の後に、READ の確かめの流れ（`executeReadCheck`。`read-check-run.ts`）を行う。送るメッセージは発見のジョブと同じ
 *    （`RUN_STARTED`、`SESSION_LOST` の `AUTH_STATE`、`FINISHED`）。`FINISHED` は、Run のディレクトリと件数の要約（`readCheck`）だけ（結果は
 *    載せない）。流れが渡されていなければ、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む。再開しない。
 * 10. 書き込みのジョブ（`WRITE_CREATE`。T30f。Task 30 の設計書 3 章）: 認証つきで、書き込みの指定（`write`）を持つ `START` だけ（契約で確かめる）。
 *    ログインの段の後に、書き込みの流れ（`executeWriteCreate`。`write-create-run.ts`）を行い、IPC の部品（`createWorkerWriteIpc`）の確かめ直しの往復と
 *    送信の報告を渡す。送るメッセージは READ の確かめと同じ（`RUN_STARTED`、`SESSION_LOST` の `AUTH_STATE`、`FINISHED`。結果は `action-run.json`）に、
 *    `WRITE_RECHECK_REQUEST` と `WRITE_SUBMISSION`（1 回）が加わる。流れが渡されていなければ、設定を読まずに `JOB_KIND_NOT_SUPPORTED` で拒む。
 *    再開しない。T31g-2: 更新の書き込みのジョブ（`WRITE_UPDATE`。UPDATE の指定 `write.update` を持つ）も、同じ流れと同じ送り方。
 * 11. 入口の確かめのジョブ（`ENTRY_CHECK`。T43c。Task 43 の設計書 4.3）: 認証の指定を持たない `START` だけ（契約で確かめる）。設定を読んだ後、ログインの
 *    段を通さずに、入口の確かめの流れ（`executeEntryCheck`。`entry-check-run.ts`）を行う。`RUN_STARTED`（新しい Run）と `FINISHED`（Run のディレクトリと
 *    件数の要約 `entryCheck` だけ）を送る。流れが渡されていなければ、設定を読まずに `JOB_KIND_NOT_SUPPORTED` で拒む。再開しない。`FAILED` の詳細の
 *    URL の秘密は、認証つきの Run と同じく伏せる。
 * 12. まとめて実行（`START` の `chain`。FM2d。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: ログインの段を 1 回だけ行い、段（監査・発見・
 *    READ の確かめ）を並びの順に行う（`runChain`）。段ごとに `RUN_STARTED` と `FINISHED`（未完了の理由のコード `incompleteReasonCodes` つき）を送り、途中の段の後は
 *    親の `NEXT_STAGE`（次の段のジョブの ID・種類・READ の定義）か `CHAIN_END` を待つ（上限 `WORKER_NEXT_STAGE_TIMEOUT_MS`）。factory の最新のログインの状態・
 *    pacer・サービスの Origin への要求の 1 分の窓を、メモリの中だけで次の段へ渡す（`RunStageCarry`。IPC・成果物・ログに出さない）。止める要求・`FAILED`・
 *    `CHAIN_END`・待つ上限では、次の段を始めずに、終えた段の終了コードで終える。待っていないときの `NEXT_STAGE`・`CHAIN_END` は契約の違反。
 *
 * 止め方（CLI のシグナルの受け方 `createInterruptHandler` を共用し、受けた回数を `STOP`・Ctrl+C・切断で共通に数える）:
 * - `STOP`: 1 回目は止める印（今のページを終えてから止まる。Run の終了コード）。`force` の `STOP` と 2 回目は、終了コード 5 ですぐに終える。
 * - コンソールの Ctrl+C（同じコンソールの子も受ける）: 入口が `INTERRUPT_SIGNALS` に登録する。数え方は `STOP` と同じ。
 * - 親との IPC の切断: 止める印を付けて、Run を終えてから終える。
 * - `START` の前の `STOP`・Ctrl+C・切断: Run を始めずに、終了コード 5 で終える。
 *
 * 送るメッセージも、送る前に `validateWorkerToParentMessage` で確かめる。形が違えば（自分の誤り）、送らずに `FAILED`（`PROTOCOL_VIOLATION`）を
 * 送り、止める印を付ける（`FINISHED` を送らない）。`FAILED` は 1 回だけ送る。
 * 標準出力には何も書かない（画面は標準出力を読まない）。止め方の文言（CLI と同じ）は標準エラーに書く。cwd は変えない。
 */
import { relative, resolve, sep } from 'node:path';
import type {
  AuditRunDependencies,
  AuditRunObserver,
  AuditRunOptions,
  AuditRunOutcome,
  AuditRunOutcomeKind,
  AuditRunResumeDecision,
  AuditRunResumeDecisionKind,
} from '../cli/audit-run.js';
import { CONFIG_ERROR_EXIT_CODE, EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../cli/exit-codes.js';
import { classifyCliFailure, type CliFailureKind } from '../cli/failure.js';
import { createInterruptHandler, type InterruptHandler } from '../cli/interrupt.js';
import type { CliOutput } from '../cli/output-stream.js';
import { HEADED_CONFIG_OVERRIDES, HEADLESS_CONFIG_OVERRIDES, withAuditSendPolicyOverride } from '../config/config-overrides.js';
import type { AuditConfig, AuditConfigOverrides } from '../config/types.js';
import type { AuthSetup } from '../control/auth/auth-setup-contracts.js';
import { sessionLostPathPrefixOf } from '../control/auth/auth-setup-policy.js';
import { filterAuthenticatedState } from '../control/auth/authenticated-state.js';
import {
  AUTOMATED_LOGIN_SUBMISSION_NONE,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUCCEEDED,
  AUTOMATED_LOGIN_UNKNOWN_RESULT,
  type AutomatedLoginFailureResult,
  type AutomatedLoginSubmission,
} from '../control/auth/automated-login-results.js';
import {
  MAX_WORKER_FAILURE_DETAIL_LENGTH,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_AUTOMATED_LOGIN_FAILED_STATE,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_JOB_KIND_NOT_SUPPORTED_REASON,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_PROTOCOL_VERSION,
  WORKER_READ_CHECK_JOB_KIND,
  WORKER_SESSION_LOST_STATE,
  WORKER_STOPPED_LOGIN_STAGE_STATE,
  WORKER_WRITE_CREATE_JOB_KIND,
  WORKER_WRITE_UPDATE_JOB_KIND,
  WORKER_START_TIMEOUT_MS,
  WORKER_NEXT_STAGE_TIMEOUT_MS,
  WORKER_AUDIT_JOB_KIND,
  targetConfigDigestOf,
  toWorkerFailureDetail,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerAuthState,
  type WorkerAutomatedLoginReport,
  type WorkerDiscoverySummary,
  type WorkerEntryCheckSummary,
  type WorkerFailureReason,
  type WorkerJobKind,
  type WorkerLoginFormInvalidReason,
  type WorkerOutcomeKind,
  type WorkerReadCheckSummary,
  type WorkerResumeDecision,
  type WorkerResumeDecisionKind,
  type WorkerRunNotice,
  type WorkerRunOutcome,
  type WorkerLoginObservation,
  type WorkerLoginStateNames,
  type WorkerLoginStageBlockedRequests,
  type WorkerScriptLoginCounts,
  type WorkerStartAuthentication,
  type WorkerStartAutomatedLogin,
  type WorkerStartMessage,
  type WorkerStartApiWrite,
  type WorkerStartReadCheck,
  type WorkerStartWrite,
  type WorkerToParentMessage,
  type WorkerChainStageKind,
  type WorkerChainStageSequence,
  type WorkerNextStageJobKind,
  type WorkerNextStageMessage,
} from '../control/worker-protocol.js';
import type { IncompleteReasonCode } from '../core/contracts.js';
import type { DiscoveryEndReason } from '../discovery/discovery-result.js';
import type { ReadCheckEndReason } from '../discovery/read-check-evaluation.js';
import { nextStageNavigationPacerOf, type RunStageCarried, type RunStageCarry } from '../orchestration/audit-stage-run.js';
import { AUDIT_SEND_READ_ONLY } from '../core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';
import type { RunProgressReport } from '../core/contracts.js';
import type { SessionLossEvidence } from '../core/evidence-types.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { safeErrorMessage } from '../core/errors.js';
import { wait } from '../core/deadline.js';
import { deepFreeze } from '../core/immutable.js';
import { truncateWellFormed } from '../core/text.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';
import { assertRunAuthentication, type RunAuthentication } from '../orchestration/authenticated-run.js';
import type { RunNotice } from '../orchestration/run-coordinator.js';
import { redactRecordedRequestUrl, redactUrlSecretsInText } from '../safety/redact.js';
import { auditStageItemOf } from './audit-stage-requests.js';
import type { LoginStageRequest, LoginStageResult } from './authenticated-login.js';
import type { AutomatedLoginStageResult } from './automated-login.js';
import { LOGIN_BROWSER_LAUNCH_REFUSED, type LoginBrowserLaunchRefusal } from './login-stage-checks.js';
import type { DiscoveryRunObserver, DiscoveryRunOutcome, DiscoveryRunRequest } from './discovery-run.js';
import type { EntryCheckRunObserver, EntryCheckRunOutcome, EntryCheckRunRequest } from './entry-check-run.js';
import type { ReadCheckRunObserver, ReadCheckRunOutcome, ReadCheckRunRequest } from './read-check-run.js';
import type { WriteCreateRunObserver, WriteCreateRunOutcome, WriteCreateRunRequest } from './write-create-run.js';
import { createWorkerWriteIpc } from './write-ipc.js';

/**
 * このワーカーが対応しているジョブの種類（T27c。Task 27 の設計書の変更履歴「Blocker: T27c」の行の (2)）。契約の一覧（`WORKER_JOB_KINDS`）にあっても、
 * ここにない種類の `START` は、監査として扱わず、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（fail-closed。`DISCOVERY` は T27d、
 * `READ_CHECK` は T27e で足した）。
 */
export const WORKER_IMPLEMENTED_JOB_KINDS = Object.freeze(
  [
    'AUDIT',
    WORKER_LOGIN_CHECK_JOB_KIND,
    WORKER_DISCOVERY_JOB_KIND,
    WORKER_READ_CHECK_JOB_KIND,
    WORKER_WRITE_CREATE_JOB_KIND,
    // T31g-2: 更新の書き込みのジョブ（書き込みの流れ `executeWriteCreate` が、`write.update` を持つ指定で UPDATE を行う）。
    WORKER_WRITE_UPDATE_JOB_KIND,
    // T43c: 入口の確かめのジョブ（入口の確かめの流れ `executeEntryCheck`。ログインの段を通さない）。
    WORKER_ENTRY_CHECK_JOB_KIND,
  ] as const satisfies readonly WorkerJobKind[],
);

/** 書き込みのジョブの種類か（`WRITE_CREATE` と、T31g-2 から `WRITE_UPDATE`）。 */
const isWriteJobKind = (jobKind: WorkerJobKind): boolean => jobKind === WORKER_WRITE_CREATE_JOB_KIND || jobKind === WORKER_WRITE_UPDATE_JOB_KIND;

/** このワーカーが対応している種類か。 */
const isImplementedJobKind = (jobKind: WorkerJobKind): boolean => (WORKER_IMPLEMENTED_JOB_KINDS as readonly WorkerJobKind[]).includes(jobKind);

/**
 * 設定の上書き（CLI の `--headless` に当たるものだけ。画面のサーバからブラウザのウィンドウを開かない。Task 24 の設計書 3 章）。値は、設定の
 * owner の `HEADLESS_CONFIG_OVERRIDES`（`src/config/config-overrides.ts`。CLI の `--headless` と共用。CC-058。CCX-11）。
 */
export const WORKER_CONFIG_OVERRIDES: AuditConfigOverrides = HEADLESS_CONFIG_OVERRIDES;

/**
 * FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: `START` の `showJobBrowser` が真のときの設定の上書き（ジョブのブラウザを表示する）。
 * 値は、設定の owner の `HEADED_CONFIG_OVERRIDES`。Guard・Context・中継・上限は変えない（起動の headless だけが変わる）。偽か省略は `WORKER_CONFIG_OVERRIDES`。
 */
export const WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES: AuditConfigOverrides = HEADED_CONFIG_OVERRIDES;

/**
 * `START` から、監査の中核の指定を作る（`--new` に当たる `startNew` と、PRE42-BN のプロファイルの名前 `profileName`）。プロファイルの名前は、ChatGPT 用
 * バンドルのファイル名だけに使う。項目のない `START` は、指定に項目を入れない（名前の部分のない今の形）。
 */
const auditRunOptionsOf = (start: WorkerStartMessage): AuditRunOptions => ({
  startNew: start.startNew,
  ...(start.profileName === undefined ? {} : { profileName: start.profileName }),
});

/**
 * 終える前に、送ったメッセージが送り終わるのを待つ上限（ms）。親が読まなくても、ワーカーが終われないままにしない。
 */
const WORKER_EXIT_FLUSH_LIMIT_MS = 2_000;

/** 設定が変わって監査を始めなかったときの終了コード（設定の誤りと同じ。Run を行わずに終えた）。認証の設定が変わったときも同じ（T25d）。 */
const WORKER_CONFIG_CHANGED_EXIT_CODE = CONFIG_ERROR_EXIT_CODE;

/** ログインの段で終わった（監査を始めなかった）ときの終了コード（T25d。`LOGIN_TIMEOUT` など。T26d-2 の自動ログインの成功以外も同じ）。 */
const WORKER_LOGIN_FAILED_EXIT_CODE = FAILURE_EXIT_CODE;
/** EL-3: ログイン用の Browser の起動を、起動の部品が閉じた理由で断ったときの `FAILED` の理由（今のワーカーの理由から選んだもの）。 */
export const LOGIN_BROWSER_LAUNCH_REFUSED_FAILURE_REASON = 'UNEXPECTED_FAILURE' satisfies WorkerFailureReason;

/** ログインの検証が成功したときの終了コード（T26d-2。Run を作らずに、成功で終えた）。 */
const WORKER_LOGIN_CHECK_SUCCEEDED_EXIT_CODE = EXIT_CODES.COMPLETE;

/**
 * 自動ログインの段の入力（T26d-2。ワーカーの流れが渡す。資格情報のファイルの読み方は、process の組み立て（`audit-worker-process.ts`）が、
 * `automatedLogin.credentialRoot` から決める）。秘密を含まない。
 */
export interface WorkerAutomatedLoginStageRequest {
  readonly config: AuditConfig;
  /** 親が検証し、SHA-256 を確かめた認証の設定（`automatedLogin` を持つ）。 */
  readonly setup: AuthSetup;
  readonly approvedTestOrigins: readonly string[];
  /** T36c: プロファイルの承認したサービスの Origin（スクリプトで送るログインの口に渡す。`START` の項目がなければ空）。 */
  readonly approvedServiceOrigins: readonly string[];
  /** `START` の自動ログインの指定（資格情報の改訂の番号と、資格情報のフォルダを決める根）。 */
  readonly automatedLogin: WorkerStartAutomatedLogin;
  readonly signal: AbortSignal;
  /**
   * 読み込みの間隔を守る部品（DEF-102 fix）。ワーカーの流れが `START` ごとに 1 つ作り、自動ログインの段と、その後のジョブ（発見・READ の確かめ・
   * 書き込み）に同じものを渡す（ログインの段の最後の要求から、ジョブの最初の読み込みまで、設定の間隔以上空ける）。
   */
  readonly navigationPacer: NavigationPacer;
}

/** フォームの確かめの理由のコード（自動ログインの段の結果の型。入力の部品を、このファイルから参照しない）。 */
type StageFormInvalidReason = Extract<AutomatedLoginStageResult, { readonly kind: 'LOGIN_FORM_INVALID' }>['formInvalidReason'];

/** 理由のコードの対応（入力の部品の一覧に値が増え、契約の写しにないと、型のエラーになる）。 */
const FORM_INVALID_REASON: { readonly [Reason in StageFormInvalidReason]: Reason & WorkerLoginFormInvalidReason } = Object.freeze({
  SELECTOR_NOT_UNIQUE: 'SELECTOR_NOT_UNIQUE',
  USERNAME_FIELD_INVALID: 'USERNAME_FIELD_INVALID',
  PASSWORD_FIELD_INVALID: 'PASSWORD_FIELD_INVALID',
  SUBMIT_BUTTON_INVALID: 'SUBMIT_BUTTON_INVALID',
  NOT_SAME_FORM: 'NOT_SAME_FORM',
  METHOD_NOT_POST: 'METHOD_NOT_POST',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  FORM_TARGET_NOT_SELF: 'FORM_TARGET_NOT_SELF',
  FORM_UNREADABLE: 'FORM_UNREADABLE',
});

/** 自動ログインの成功の結果（送信 `YES`）。 */
const SUCCEEDED_REPORT: WorkerAutomatedLoginReport = deepFreeze({
  result: AUTOMATED_LOGIN_SUCCEEDED,
  submitted: AUTOMATED_LOGIN_SUBMISSION_SENT,
  retryAfterUntil: null,
  formInvalidReason: null,
});

/**
 * 成功以外の結果（`Retry-After` の期限と理由のコードを持たないもの）。DEF-099 fix round 1: 送った後に応答がなかった（`responseAfterSubmission:
 * false`）回は、送信 `YES` のときだけ、同じ印を載せる。
 */
const failureReportOf = (
  result: AutomatedLoginFailureResult,
  submitted: AutomatedLoginSubmission,
  responseAfterSubmission?: false,
): WorkerAutomatedLoginReport => ({
  result,
  submitted,
  retryAfterUntil: null,
  formInvalidReason: null,
  ...(responseAfterSubmission === false && submitted === AUTOMATED_LOGIN_SUBMISSION_SENT ? { responseAfterSubmission } : {}),
});

/** 自動ログインの段がない（依存が渡されていない）ときの結果（送信していない。ログインの段を始めていない）。 */
const NO_AUTOMATED_LOGIN_STAGE: AutomatedLoginStageResult = deepFreeze({
  kind: AUTOMATED_LOGIN_UNKNOWN_RESULT,
  submitted: AUTOMATED_LOGIN_SUBMISSION_NONE,
  retryAfterUntil: null,
});

/** 親との IPC の口（本番は `process`。`audit-worker.ts` の `processWorkerChannel`）。 */
export interface WorkerChannel {
  /** メッセージを送る。送り終わったら真、送れなかったら（切れていたら）偽で解決する。reject しない。 */
  readonly send: (message: WorkerToParentMessage) => Promise<boolean>;
  /** 親のメッセージの受け手を登録する（受けた値は、まだ検証していない）。 */
  readonly onMessage: (listener: (value: unknown) => void) => void;
  /** 親との IPC が切れたときの受け手を登録する。 */
  readonly onDisconnect: (listener: () => void) => void;
}

/** ワーカーに渡すもの（本番の値は入口が渡す）。 */
export interface AuditWorkerDependencies {
  readonly channel: WorkerChannel;
  /** 止め方の文言（CLI と同じ）を書く標準エラー。 */
  readonly stderr: CliOutput;
  /** プロセスを終える関数（本番は `process.exit`）。 */
  readonly exit: (code: number) => void;
  /** 設定を読む関数（本番は `loadConfig`）。 */
  readonly loadConfig: (path: string, overrides: AuditConfigOverrides) => Promise<AuditConfig>;
  /** ターゲット JSON の内容を読む関数（本番は cwd からの `readFile`。SHA-256 の確かめに使う。T24h-1 の M3）。 */
  readonly readTargetConfig: (path: string) => Promise<Uint8Array>;
  /** 監査の中核（本番は `executeAuditRun`）。 */
  readonly executeAuditRun: (
    config: AuditConfig,
    dependencies: AuditRunDependencies,
    options: AuditRunOptions,
    observer: AuditRunObserver,
  ) => Promise<AuditRunOutcome>;
  /** 中核の依存（本番は `PRODUCTION_RUN_DEPENDENCIES`。CLI と同じ Chromium の起動）。止める印と認証の指定は、ワーカーが加える。 */
  readonly runDependencies: AuditRunDependencies;
  /**
   * ログインの段（認証つきの `START` だけ。T25d。本番は入口が、headed のログイン用の Browser の起動を包んだ `runLoginStage` を渡す）。省略すると、
   * 認証つきの `START` は、ログインせずに `AUTH_SETUP_REQUIRED` で終える。
   */
  readonly runLoginStage?: (request: LoginStageRequest) => Promise<LoginStageResult>;
  /**
   * 自動ログインの段（`authentication.automatedLogin` のある `START` だけ。T26d-2。本番は入口が、headless のログイン用の Browser の起動と、資格情報の
   * ファイルの読み方を包んだ `runAutomatedLoginStage` を渡す）。省略すると、自動ログインの `START` は、送信せずに `AUTH_RESULT_UNKNOWN` で終える
   * （手動のログインの段は使わない）。
   */
  readonly runAutomatedLoginStage?: (request: WorkerAutomatedLoginStageRequest) => Promise<AutomatedLoginStageResult>;
  /**
   * 発見のジョブの流れ（`DISCOVERY` の `START` だけ。T27d。本番は入口が `executeDiscoveryRun`（`discovery-run.ts`）を渡す）。省略すると、発見の
   * `START` は、ログインの後に `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で終える（発見を行わない。fail-closed）。
   */
  readonly executeDiscovery?: (request: DiscoveryRunRequest, observer: DiscoveryRunObserver) => Promise<DiscoveryRunOutcome>;
  /**
   * READ の確かめのジョブの流れ（`READ_CHECK` の `START` だけ。T27e。本番は入口が `executeReadCheckRun`（`read-check-run.ts`）を渡す）。省略すると、
   * READ の確かめの `START` は、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（fail-closed）。
   */
  readonly executeReadCheck?: (request: ReadCheckRunRequest, observer: ReadCheckRunObserver) => Promise<ReadCheckRunOutcome>;
  /**
   * 書き込みのジョブの流れ（`WRITE_CREATE` と、T31g-2 から `WRITE_UPDATE` の `START` だけ。T30f。本番は入口が `executeWriteCreateRun`（`write-create-run.ts`）を渡す）。省略すると、
   * 書き込みの `START` は、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（fail-closed）。
   */
  readonly executeWriteCreate?: (request: WriteCreateRunRequest, observer: WriteCreateRunObserver) => Promise<WriteCreateRunOutcome>;
  /**
   * 入口の確かめのジョブの流れ（`ENTRY_CHECK` の `START` だけ。T43c。本番は入口が `executeEntryCheckRun`（`entry-check-run.ts`）を渡す）。省略すると、
   * 入口の確かめの `START` は、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む（fail-closed）。
   */
  readonly executeEntryCheck?: (request: EntryCheckRunRequest, observer: EntryCheckRunObserver) => Promise<EntryCheckRunOutcome>;
  /** `START` を待つ時間（ms。省略すると `WORKER_START_TIMEOUT_MS`）。 */
  readonly startTimeoutMs?: number;
  /** 生きている合図の間隔（ms。省略すると `WORKER_HEARTBEAT_INTERVAL_MS`）。 */
  readonly heartbeatIntervalMs?: number;
  /** FM2d: まとめて実行の途中の段の後に、親の `NEXT_STAGE`・`CHAIN_END` を待つ時間（ms。省略すると `WORKER_NEXT_STAGE_TIMEOUT_MS`）。 */
  readonly nextStageTimeoutMs?: number;
}

/** 動いているワーカー。 */
export interface AuditWorker {
  /** シグナル（`INTERRUPT_SIGNALS`）の受け手。入口が `registerInterruptHandlers` で登録する。 */
  readonly interrupt: InterruptHandler;
  /** 扱われない例外と reject の受け手。`FAILED`（`UNEXPECTED_FAILURE`）を送って、終了コード 1 で終える。 */
  readonly failUnexpectedly: (error: unknown) => void;
  /** `exit` に渡す終了コード（`exit` を呼ぶ直前に解決する）。 */
  readonly exited: Promise<number>;
  /** タイマーを止める（テストの後片付け。本番では `exit` で終わる）。 */
  readonly dispose: () => void;
}

/** ワーカーの段。 */
type WorkerStage = 'WAITING' | 'RUNNING' | 'EXITING';

/** 結果の種類の対応（`AUDIT_RUN_OUTCOME_KINDS` に種類が増え、契約の一覧にないと、型のエラーになる）。 */
const OUTCOME_KIND: { readonly [Kind in AuditRunOutcomeKind]: Kind & WorkerOutcomeKind } = Object.freeze({
  RAN: 'RAN',
  RUN_ACTIVE: 'RUN_ACTIVE',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  RUN_DIRECTORY_UNAVAILABLE: 'RUN_DIRECTORY_UNAVAILABLE',
  RESUME_UNAVAILABLE: 'RESUME_UNAVAILABLE',
});

/** 再開の判断の対応（`AUDIT_RUN_RESUME_DECISION_KINDS` に種類が増え、契約の一覧にないと、型のエラーになる）。 */
const RESUME_DECISION_KIND: { readonly [Kind in AuditRunResumeDecisionKind]: Kind & WorkerResumeDecisionKind } = Object.freeze({
  NEW_RUN: 'NEW_RUN',
  RESUME: 'RESUME',
  FINALIZE_ONLY: 'FINALIZE_ONLY',
});

/** 監査の外の失敗の種類と `FAILED` の理由の対応（`CLI_FAILURE_KINDS` に種類が増え、契約の一覧にないと、型のエラーになる）。 */
const FAILURE_REASON: { readonly [Kind in CliFailureKind]: Kind & WorkerFailureReason } = Object.freeze({
  CONFIG_ERROR: 'CONFIG_ERROR',
  ARTIFACT_WRITE_FAILED: 'ARTIFACT_WRITE_FAILED',
  UNEXPECTED_FAILURE: 'UNEXPECTED_FAILURE',
});

/**
 * FM2d: 発見の終わり方から、まとめて実行の `FINISHED` に載せる未完了の理由のコードへの対応（成果物の一覧に値が増え、ここにないと型のエラーになる）。止める理由
 * の判定は親の決まり（`stage-chain-policy.ts`）。
 */
const DISCOVERY_END_REASON_CODES: { readonly [Reason in DiscoveryEndReason]: readonly IncompleteReasonCode[] } = Object.freeze({
  COMPLETED: [],
  MAX_PAGES_REACHED: ['MAX_PAGES_REACHED'],
  MAX_RUNTIME_REACHED: ['MAX_RUNTIME_REACHED'],
  STOPPED: ['RUN_INTERRUPTED'],
  AUTH_SESSION_LOST: ['AUTH_SESSION_LOST'],
  SERVICE_REQUEST_LIMIT_REACHED: ['SERVICE_REQUEST_LIMIT_REACHED'],
  SITE_UNAVAILABLE: ['SITE_UNAVAILABLE'],
  SAFETY_VIOLATION: ['SAFETY_INVARIANT_VIOLATION'],
  PREFLIGHT_FAILED: ['PREFLIGHT_FAILED'],
});

/** FM2d: READ の確かめの終わり方から、未完了の理由のコードへの対応（発見と同じ決まり）。 */
const READ_CHECK_END_REASON_CODES: { readonly [Reason in ReadCheckEndReason]: readonly IncompleteReasonCode[] } = Object.freeze({
  COMPLETED: [],
  MAX_RUNTIME_REACHED: ['MAX_RUNTIME_REACHED'],
  STOPPED: ['RUN_INTERRUPTED'],
  AUTH_SESSION_LOST: ['AUTH_SESSION_LOST'],
  SERVICE_REQUEST_LIMIT_REACHED: ['SERVICE_REQUEST_LIMIT_REACHED'],
  SITE_UNAVAILABLE: ['SITE_UNAVAILABLE'],
  SAFETY_VIOLATION: ['SAFETY_INVARIANT_VIOLATION'],
  PREFLIGHT_FAILED: ['PREFLIGHT_FAILED'],
});

/**
 * FM2d: まとめて実行の段の `FINISHED` に載せる、重なりのない理由のコード（連鎖でない・Run を実行しなかった（`codesOf` が `null`）なら載せない）。コードは
 * 連鎖のときだけ求める（連鎖でないジョブの振る舞いを変えない）。
 */
const chainReasonCodesPart = (
  chained: boolean,
  codesOf: () => readonly IncompleteReasonCode[] | null,
): { readonly incompleteReasonCodes?: readonly IncompleteReasonCode[] } => {
  const codes = chained ? codesOf() : null;
  return codes === null ? {} : { incompleteReasonCodes: [...new Set(codes)] };
};

/** 出力先の中の Run のディレクトリの相対パス（区切りは `/`）。出力先の外なら、`..` から始まる値になり、契約の検証で拒まれる。 */
const relativeRunDirectory = (outputDirectory: string, runDirectory: string): string =>
  relative(outputDirectory, runDirectory).split(sep).join('/');

const toWorkerResumeDecision = (decision: AuditRunResumeDecision): WorkerResumeDecision =>
  decision.kind === 'RESUME'
    ? { kind: RESUME_DECISION_KIND[decision.kind], completedPages: decision.completedPages }
    : { kind: RESUME_DECISION_KIND[decision.kind], completedPages: null };

/** 知らせの URL を、契約の上限で切る（表示のためだけの値。切った後に対になっていないサロゲートを残さない）。 */
const noticeUrlOf = (url: string): string => truncateWellFormed(url, MAX_WORKER_NOTICE_URL_LENGTH);

/**
 * T44g（Task 44 の設計書 P4-1。設計の変更の履歴の「T44g の Blocker」の行）: セッションの切れの URL（`AUTH_STATE` の `sessionLostUrl`。IPC と管理データに残る）。
 * 記録した要求の URL と同じ規則（`redactRecordedRequestUrl`。query のすべての値・値に見える path の区切り・fragment の値・userinfo を伏せる）を当ててから、
 * 契約の上限で切る。
 */
const reportedSessionLostUrlOf = (url: string): string => noticeUrlOf(redactRecordedRequestUrl(url));

/** `NOTICE` で送る知らせ（セッションの切れは `AUTH_STATE` で送る。T25d）。 */
type WorkerForwardedNotice = Exclude<RunNotice, { readonly kind: 'AUTH_SESSION_LOST' }>;

/** 知らせの写し。URL は、契約の上限で切る。 */
const toWorkerNotice = (notice: WorkerForwardedNotice): WorkerRunNotice => {
  switch (notice.kind) {
    case 'SITE_UNAVAILABLE_RECHECK':
      return {
        kind: notice.kind,
        url: noticeUrlOf(notice.url),
        delayMs: notice.delayMs,
        attempt: notice.attempt,
        maxAttempts: notice.maxAttempts,
      };
    case 'SITE_UNAVAILABLE_SLOWDOWN':
      return { kind: notice.kind, minIntervalMs: notice.minIntervalMs };
    case 'SERVICE_REQUEST_PACING_WAIT':
      // DEF-141: 1 分あたりの上限で次の読み込みの前に待つ（監査・発見・READ の確かめ。値は数だけ）。
      return { kind: notice.kind, waitMs: notice.waitMs, waitCount: notice.waitCount, totalWaitMs: notice.totalWaitMs };
  }
};

/** 進み具合の写し（`RunProgressReport` の項目だけを、名前で取り出す）。 */
const toWorkerProgress = (report: RunProgressReport): RunProgressReport => ({
  pagesFinished: report.pagesFinished,
  pagesDiscovered: report.pagesDiscovered,
  maxPages: report.maxPages,
  elapsedMs: report.elapsedMs,
  navigationCount: report.navigationCount,
  pacingWaitMs: report.pacingWaitMs,
  requests: {
    allowedOrigins: { count: report.requests.allowedOrigins.count, peakPerMinute: report.requests.allowedOrigins.peakPerMinute },
    otherOrigins: { count: report.requests.otherOrigins.count, peakPerMinute: report.requests.otherOrigins.peakPerMinute },
    servedFromCache: report.requests.servedFromCache,
    withheldOtherOrigins: report.requests.withheldOtherOrigins,
  },
  recentPerMinute: { allowedOrigins: report.recentPerMinute.allowedOrigins, otherOrigins: report.recentPerMinute.otherOrigins },
});

/** 結果の、画面に要る項目だけ（例外の `cause`、要約、知らせ、警告は送らない）。 */
const toWorkerOutcome = (outcome: AuditRunOutcome, outputDirectory: string): WorkerRunOutcome => {
  switch (outcome.kind) {
    case 'RAN':
    case 'RUN_DIRECTORY_UNAVAILABLE':
      return {
        kind: OUTCOME_KIND[outcome.kind],
        exitCode: outcome.exitCode,
        runId: outcome.runId,
        runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
        runStatus: outcome.runStatus,
      };
    case 'RUN_ACTIVE':
      return { kind: OUTCOME_KIND[outcome.kind], exitCode: outcome.exitCode, runId: outcome.activeRunId, runDirectory: null, runStatus: null };
    case 'VERSION_MISMATCH':
    case 'RESUME_UNAVAILABLE':
      return {
        kind: OUTCOME_KIND[outcome.kind],
        exitCode: outcome.exitCode,
        runId: outcome.runId,
        runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
        runStatus: null,
      };
  }
};

/**
 * 発見の流れの結果の、`FINISHED` に載せる値（T27d）。Run を実行した結果（`RAN`）だけ、件数の要約（`discovery`）を付ける。候補・URL は載せない。
 */
export const toDiscoveryFinished = (
  outcome: DiscoveryRunOutcome,
  outputDirectory: string,
): { readonly outcome: WorkerRunOutcome; readonly discovery?: WorkerDiscoverySummary } => {
  switch (outcome.kind) {
    case 'RAN':
      return {
        outcome: {
          kind: OUTCOME_KIND.RAN,
          exitCode: outcome.exitCode,
          runId: outcome.runId,
          runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
          runStatus: outcome.runStatus,
        },
        discovery: {
          pagesRead: outcome.summary.pagesRead,
          pagesNotRead: outcome.summary.pagesNotRead,
          candidates: outcome.summary.candidates,
          // T37a: 監査の段の数（成果物にあるときだけ。成果物と同じ値）。
          ...(outcome.summary.authentication === undefined ? {} : { authentication: outcome.summary.authentication }),
          // DEF-144: 違反の中身（成果物にあるときだけ。成果物と同じ値）。
          ...(outcome.summary.safetyViolation === undefined ? {} : { safetyViolation: outcome.summary.safetyViolation }),
        },
      };
    case 'RUN_DIRECTORY_UNAVAILABLE':
      return {
        outcome: {
          kind: OUTCOME_KIND.RUN_DIRECTORY_UNAVAILABLE,
          exitCode: outcome.exitCode,
          runId: outcome.runId,
          runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
          runStatus: outcome.runStatus,
        },
      };
    case 'RUN_ACTIVE':
      return {
        outcome: { kind: OUTCOME_KIND.RUN_ACTIVE, exitCode: outcome.exitCode, runId: outcome.activeRunId, runDirectory: null, runStatus: null },
      };
  }
};

/**
 * READ の確かめの流れの結果の、`FINISHED` に載せる値（T27e）。Run を実行した結果（`RAN`）だけ、件数の要約（`readCheck`）を付ける。結果・URL は
 * 載せない。Run を実行しなかった結果は、発見と同じ形（`toDiscoveryFinished`）。
 */
export const toReadCheckFinished = (
  outcome: ReadCheckRunOutcome,
  outputDirectory: string,
): { readonly outcome: WorkerRunOutcome; readonly readCheck?: WorkerReadCheckSummary } => {
  if (outcome.kind !== 'RAN') {
    return { outcome: toDiscoveryFinished(outcome, outputDirectory).outcome };
  }
  return {
    outcome: {
      kind: OUTCOME_KIND.RAN,
      exitCode: outcome.exitCode,
      runId: outcome.runId,
      runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
      runStatus: outcome.runStatus,
    },
    readCheck: {
      checks: outcome.summary.checks,
      executed: outcome.summary.executed,
      // T37a: 監査の段の数（成果物にあるときだけ。成果物と同じ値）。
      ...(outcome.summary.authentication === undefined ? {} : { authentication: outcome.summary.authentication }),
      // DEF-144: 違反の中身（成果物にあるときだけ。成果物と同じ値）。
      ...(outcome.summary.safetyViolation === undefined ? {} : { safetyViolation: outcome.summary.safetyViolation }),
    },
  };
};

/**
 * 入口の確かめの流れの結果の、`FINISHED` に載せる値（T43c）。Run を実行した結果（`RAN`）だけ、件数の要約（`entryCheck`）を付ける。読んだ事実・案・
 * URL は載せない。Run を実行しなかった結果は、発見と同じ形（`toDiscoveryFinished`）。
 */
const toEntryCheckFinished = (
  outcome: EntryCheckRunOutcome,
  outputDirectory: string,
): { readonly outcome: WorkerRunOutcome; readonly entryCheck?: WorkerEntryCheckSummary } => {
  if (outcome.kind !== 'RAN') {
    return { outcome: toDiscoveryFinished(outcome, outputDirectory).outcome };
  }
  return {
    outcome: {
      kind: OUTCOME_KIND.RAN,
      exitCode: outcome.exitCode,
      runId: outcome.runId,
      runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
      runStatus: outcome.runStatus,
    },
    entryCheck: {
      endReason: outcome.summary.endReason,
      loginPage: outcome.summary.loginPage,
      proposedSelectors: outcome.summary.proposedSelectors,
    },
  };
};

/** 書き込みのジョブの結果を `FINISHED` の項目にする（T30f。結果は載せない。`action-run.json` の場所は Run のディレクトリ）。 */
const toWriteFinished = (outcome: WriteCreateRunOutcome, outputDirectory: string): { readonly outcome: WorkerRunOutcome } => {
  if (outcome.kind !== 'RAN') {
    return { outcome: toDiscoveryFinished(outcome, outputDirectory).outcome };
  }
  return {
    outcome: {
      kind: OUTCOME_KIND.RAN,
      exitCode: outcome.exitCode,
      runId: outcome.runId,
      runDirectory: relativeRunDirectory(outputDirectory, outcome.runDirectory),
      runStatus: outcome.runStatus,
    },
  };
};

/**
 * ログインの段の前の確かめ（T25f round 2）に置く、空の認証済みの状態（`assertRunAuthentication` の状態の形の確かめを通すためだけの値。監査には
 * 渡さない）。
 */
const PRE_LOGIN_STATE: Extract<LoginStageResult, { readonly kind: 'AUTHENTICATED' }>['state'] = Object.freeze({
  cookies: Object.freeze([]),
  origins: Object.freeze([]),
});

/** 例外の、利用者に見せない英語の短い詳細。 */
const failureDetailOf = (error: unknown): string => toWorkerFailureDetail(safeErrorMessage(error, MAX_WORKER_FAILURE_DETAIL_LENGTH));

/**
 * ログインの段の後の、認証つきの Run の指定（T25d。Task 25 の設計書 4.3、4.4）。状態はメモリのまま渡す。監査の段の除外は、認証の設定の
 * `excludedPaths`・`auditPathPrefixes` と、既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`）。セッションの切れの path は
 * `sessionLostPathPrefixOf`。状態の絞り込みは、認証の設定の owner の `filterAuthenticatedState`。
 */
const runAuthenticationOf = (
  authentication: WorkerStartAuthentication,
  state: Extract<LoginStageResult, { readonly kind: 'AUTHENTICATED' }>['state'],
  maxPages: number,
): RunAuthentication => ({
  initialState: state,
  approvedTestOrigins: authentication.approvedTestOrigins,
  auditExclusions: {
    excludedPathPrefixes: authentication.setup.excludedPaths,
    auditPathPrefixes: authentication.setup.auditPathPrefixes,
    dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  },
  sessionLostPathPrefix: sessionLostPathPrefixOf(authentication.setup),
  filterState: filterAuthenticatedState,
  // T35a（Task 35 の設計書 3.2）: スクリプトで送るログインの監査の段の口（スクリプトで送るログインの設定だけ）。T44f: 要求の上限の既定は、設定のページの上限に
  // 比べた値。
  ...auditStageItemOf(authentication, maxPages),
});

/** ワーカーを始める（`READY` を送り、`START` を待つ）。 */
export function startAuditWorker(dependencies: AuditWorkerDependencies): AuditWorker {
  const { channel } = dependencies;
  const controller = new AbortController();
  let stage: WorkerStage = 'WAITING';
  /** 親を信用しない（形の違うメッセージを受けた、または切れた）。以後の親のメッセージを受けない。 */
  let parentDistrusted = false;
  /** `FAILED` を送った。以後、`FAILED` と `FINISHED` を送らない。 */
  let failureReported = false;
  /** ML-a: 親から「ログインを終えた」（`LOGIN_CONFIRMED`）を受けた（手動のログインの段が成功として進む）。 */
  let manualLoginConfirmed = false;
  /** 認証つきの `START` を受けた（T25f round 1。`FAILED` の詳細の URL の秘密を伏せる）。 */
  let authenticatedRun = false;
  /** 契約の違反で、止める印を付けた。 */
  let stoppedByViolation = false;
  /** 送ったメッセージの送り終わり（終える前に待つ）。 */
  let pendingSends: Promise<unknown> = Promise.resolve();
  /**
   * FM2d: まとめて実行の次の段の指定（`NEXT_STAGE`・`CHAIN_END`）を待つ受け手（途中の段の `FINISHED` を送った後だけ。ほかは `null`）。`expected` は次の段の種類。
   */
  let nextStageWaiter: { readonly expected: WorkerNextStageJobKind; readonly settle: (message: WorkerNextStageMessage | null) => void } | null = null;
  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolvePromise) => {
    resolveExited = resolvePromise;
  });

  /** 終わり始めたか（FM2d: 待った後に読み直す。型の絞り込みを残さない）。 */
  const isExiting = (): boolean => stage === 'EXITING';

  /** 送る。終わり始めた後（`exit` を待つ間）は、何も送らない（強制の止め方の後に、`FINISHED` を送らない）。 */
  const transmit = (message: WorkerToParentMessage): void => {
    if (stage === 'EXITING') {
      return;
    }
    const sent = channel.send(message).catch(() => false);
    pendingSends = Promise.all([pendingSends, sent]);
  };

  const stopTimers = (): void => {
    clearTimeout(startTimer);
    clearInterval(heartbeat);
  };

  /** 送ったメッセージが送り終わるのを（上限まで）待ってから、`exit` を呼ぶ。2 回目からは何もしない。 */
  const exitWith = (code: number): void => {
    if (stage === 'EXITING') {
      return;
    }
    stage = 'EXITING';
    stopTimers();
    let flushTimer: NodeJS.Timeout | undefined;
    // 上限のタイマーは unref しない（待つ間にプロセスが終了コード 0 で終わらないようにする）。
    const flushLimit = new Promise<void>((resolvePromise) => {
      flushTimer = setTimeout(resolvePromise, WORKER_EXIT_FLUSH_LIMIT_MS);
    });
    void Promise.race([pendingSends, flushLimit]).then(() => {
      clearTimeout(flushTimer);
      resolveExited(code);
      dependencies.exit(code);
    });
  };

  /**
   * `FAILED` を 1 回だけ送る。認証つきの Run（T25f round 1。Task 25 の設計書 4.6）では、詳細（英語の誤りの文）の URL の秘密を、伏せ字の owner の
   * `redactUrlSecretsInText` で伏せてから送る（ここが `FAILED` を送る唯一の場所）。公開監査の詳細は、今のまま送る。
   */
  const reportFailure = (reason: WorkerFailureReason, detail: string): void => {
    if (failureReported) {
      return;
    }
    failureReported = true;
    const shown = authenticatedRun ? redactUrlSecretsInText(detail) : detail;
    transmit({ protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason, detail: toWorkerFailureDetail(shown) });
  };

  /**
   * EL-3（設計者の判断 2026-10-24）: ログインの段（手動と自動）のログイン用の Browser の起動を、起動の部品が閉じた理由（外部のアプリを開かせない設定が
   * 効かない）で断った。管理データの版と IPC の閉じた一覧は変えず、`FAILED` の今の理由 `UNEXPECTED_FAILURE`（Browser を起動できなかった、に当たる
   * ワーカーの理由）で終える。理由のコードは、詳細の文（利用者に見せない英語の短い詳細）に書く。`AUTH_STATE` は送らない（ログインの画面を開いていない）。
   */
  const reportLoginBrowserLaunchRefused = (refusal: LoginBrowserLaunchRefusal): void => {
    reportFailure(LOGIN_BROWSER_LAUNCH_REFUSED_FAILURE_REASON, `the login browser was not launched (${refusal})`);
    exitWith(WORKER_LOGIN_FAILED_EXIT_CODE);
  };

  const interruptHandler = createInterruptHandler({ controller, stderr: dependencies.stderr, exit: exitWith });

  /** 止める要求（`STOP`・Ctrl+C・切断）。`START` の前なら、Run を始めずに終了コード 5 で終える。 */
  const interrupt: InterruptHandler = () => {
    if (stage === 'WAITING') {
      exitWith(INTERRUPTED_EXIT_CODE);
      return;
    }
    // FM2d: 次の段の指定を待っている間の止める要求は、次の段を始めずに終える（連鎖の全体を止める）。
    nextStageWaiter?.settle(null);
    interruptHandler();
  };

  /**
   * 契約に反した（受けた値か、自分が作った値）。`FAILED` を送り、`START` の前なら終える。Run の途中なら、止める印を 1 回だけ付ける
   * （違反が続いても、強制の止め方として数えない）。
   */
  const violate = (detail: string): void => {
    reportFailure('PROTOCOL_VIOLATION', detail);
    if (stage === 'WAITING') {
      exitWith(FAILURE_EXIT_CODE);
    } else if (stage === 'RUNNING' && !stoppedByViolation) {
      stoppedByViolation = true;
      interrupt();
    }
  };

  /** 送る前に契約で確かめてから送る。形が違えば送らずに、契約の違反として扱う。 */
  const sendChecked = (message: WorkerToParentMessage): void => {
    const checked = validateWorkerToParentMessage(message);
    if (!checked.ok) {
      violate(`the worker built an invalid ${message.type} message: ${checked.errors.join('; ')}`);
      return;
    }
    transmit(checked.message);
  };

  /**
   * T30e: 書き込みのジョブの IPC の部品（確かめ直しの往復と送信の報告。T30f の書き込みの流れ `executeWriteCreate` に渡す）。依頼していない
   * `WRITE_RECHECK_RESULT` は、契約の違反として扱う。
   */
  const writeIpc = createWorkerWriteIpc({ send: sendChecked });

  /**
   * DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 流れが「Run の終わり」の段（集計・成果物の書き出し・
   * 止めたときの片付け）に入る知らせを、親へ `RUN_FINALIZING` で送る（監査・発見・READ の確かめの流れが同じ口を使う）。
   */
  const sendRunFinalizing = (): void => {
    sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_FINALIZING' });
  };

  const observerFor = (outputDirectory: string): AuditRunObserver => ({
    onRunStarted: ({ runId, runDirectory, resumeDecision }) => {
      sendChecked({
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'RUN_STARTED',
        runId,
        runDirectory: relativeRunDirectory(outputDirectory, runDirectory),
        resumeDecision: toWorkerResumeDecision(resumeDecision),
      });
    },
    onProgress: (report) => {
      sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'PROGRESS', report: toWorkerProgress(report) });
    },
    onNotice: (notice) => {
      // T25d: セッションの切れは、止まったページの URL つきの `AUTH_STATE`（`SESSION_LOST`）で送る（ほかの知らせは `NOTICE`）。
      if (notice.kind === 'AUTH_SESSION_LOST') {
        // DEF-138: セッションの切れの証拠も載せる（組み立てられたときだけ）。
        sendSessionLost(notice.url, notice.sessionLoss);
        return;
      }
      sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'NOTICE', notice: toWorkerNotice(notice) });
    },
    // DEF-143: 「Run の終わり」の段に入る知らせ（親は、その段の間だけ途絶えの上限を延ばす）。
    onFinalizing: sendRunFinalizing,
  });

  /**
   * 認証の状態の知らせ（値と秘密を含まない。T25d）。自動ログインの段の結果（T26d-2）は `automatedLogin` で、スクリプトで送るログインの段の結果の数
   * （T34c）は `scriptLogin` で、ログインの段で止めた読み取りでない要求の一覧（T34e）は `blockedRequests` で送る。
   */
  const sendAuthState = (
    state: WorkerAuthState,
    sessionLostUrl: string | null = null,
    automatedLogin: WorkerAutomatedLoginReport | null = null,
    scriptLogin: WorkerScriptLoginCounts | undefined = undefined,
    blockedRequests: WorkerLoginStageBlockedRequests | undefined = undefined,
    loginObservation: WorkerLoginObservation | undefined = undefined,
    passedRequests: WorkerLoginStageBlockedRequests | undefined = undefined,
    loginStateNames: WorkerLoginStateNames | undefined = undefined,
  ): void => {
    sendChecked({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'AUTH_STATE',
      state,
      sessionLostUrl,
      ...(automatedLogin === null ? {} : { automatedLogin }),
      ...(scriptLogin === undefined ? {} : { scriptLogin }),
      ...(blockedRequests === undefined ? {} : { blockedRequests }),
      // T43d: ログインの段で観察したこと（成功の鍵の名前の案と、成功の画面のセレクタの案）。
      ...(loginObservation === undefined ? {} : { loginObservation }),
      // ML-a: 手動のログインの段で通した読み取りでない要求の一覧（形だけ）。
      ...(passedRequests === undefined ? {} : { passedRequests }),
      // DEF-139: ログインの後のブラウザの状態の名前の記録（値を持たない。状態を読んだときだけ）。
      ...(loginStateNames === undefined ? {} : { loginStateNames }),
    });
  };

  /**
   * DEF-138: セッションの切れの知らせ（止まったページの URL と、組み立てられたときはセッションの切れの証拠。値を持たない）。監査・発見・READ の確かめの
   * 流れが共通に使う。
   */
  const sendSessionLost = (url: string, sessionLoss: SessionLossEvidence | null | undefined): void => {
    sendChecked({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'AUTH_STATE',
      state: WORKER_SESSION_LOST_STATE,
      sessionLostUrl: reportedSessionLostUrlOf(url),
      ...(sessionLoss === null || sessionLoss === undefined ? {} : { sessionLoss }),
    });
  };

  /**
   * 自動ログインの段（T26d-2。流れはファイルの先頭の 7）。認証の指定（`RunAuthentication`）を返すのは、`AUDIT` の成功だけ。ほかは、知らせと
   * （成功以外なら）`FAILED` を送って終わり始め、`null` を返す。手動のログインの段を呼ばない。
   */
  const automatedLoginStage = async (
    jobKind: WorkerJobKind,
    authentication: WorkerStartAuthentication,
    automatedLogin: WorkerStartAutomatedLogin,
    config: AuditConfig,
    navigationPacer: NavigationPacer,
  ): Promise<RunAuthentication | null> => {
    const result: AutomatedLoginStageResult = dependencies.runAutomatedLoginStage === undefined
      ? NO_AUTOMATED_LOGIN_STAGE
      : await dependencies.runAutomatedLoginStage({
        config,
        setup: authentication.setup,
        approvedTestOrigins: authentication.approvedTestOrigins,
        approvedServiceOrigins: authentication.approvedServiceOrigins ?? [],
        automatedLogin,
        signal: controller.signal,
        navigationPacer,
      });
    // T36c: スクリプトで送るログインの自動ログインの段の数と止めた一覧（あるときだけ。自動ログインの結果と一緒に送る）。
    // T43d: ログインの段で観察したこと（あるときだけ）も一緒に送る。
    // DEF-139: 状態の名前の記録（状態を読んだときだけ）も一緒に送る。
    const { scriptLogin, blockedRequests, loginObservation, stateNames } = result;
    switch (result.kind) {
      case 'AUTHENTICATED':
        sendAuthState('AUTHENTICATED', null, SUCCEEDED_REPORT, scriptLogin, blockedRequests, loginObservation, undefined, stateNames);
        if (jobKind === WORKER_LOGIN_CHECK_JOB_KIND) {
          // ログインの検証: 状態は捨てる（監査に渡さない。保存しない）。Run を作らずに終える。
          exitWith(WORKER_LOGIN_CHECK_SUCCEEDED_EXIT_CODE);
          return null;
        }
        return runAuthenticationOf(authentication, result.state, config.crawl.maxPages);
      case 'STOPPED':
        sendAuthState(
          WORKER_AUTOMATED_LOGIN_FAILED_STATE,
          null,
          failureReportOf(AUTOMATED_LOGIN_UNKNOWN_RESULT, result.submitted, result.responseAfterSubmission),
          scriptLogin,
          blockedRequests,
          loginObservation,
        );
        exitWith(INTERRUPTED_EXIT_CODE);
        return null;
      case 'UNSUPPORTED_AUTH_STATE':
        if (result.submitted === AUTOMATED_LOGIN_SUBMISSION_SENT) {
          // ログインは成功した（成功の条件に当たった）が、許可 Origin の状態がなかった。
          sendAuthState('UNSUPPORTED_AUTH_STATE', null, SUCCEEDED_REPORT, scriptLogin, blockedRequests, loginObservation, undefined, stateNames);
          reportFailure('UNSUPPORTED_AUTH_STATE', 'the automated login ended without an authenticated state (UNSUPPORTED_AUTH_STATE)');
        } else {
          sendAuthState(
            WORKER_AUTOMATED_LOGIN_FAILED_STATE,
            null,
            failureReportOf(AUTOMATED_LOGIN_UNKNOWN_RESULT, result.submitted, result.responseAfterSubmission),
            scriptLogin,
            blockedRequests,
            loginObservation,
            undefined,
            stateNames,
          );
          reportFailure(AUTOMATED_LOGIN_UNKNOWN_RESULT, `the automated login ended with ${AUTOMATED_LOGIN_UNKNOWN_RESULT}`);
        }
        exitWith(WORKER_LOGIN_FAILED_EXIT_CODE);
        return null;
      case LOGIN_BROWSER_LAUNCH_REFUSED:
        // EL-3: ログイン用の Browser の起動を、起動の部品が閉じた理由で断った（ログインの画面を開いていない。送信していない）。
        reportLoginBrowserLaunchRefused(result.refusal);
        return null;
      case 'LOGIN_FORM_INVALID':
        sendAuthState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, null, {
          ...failureReportOf(result.kind, result.submitted),
          formInvalidReason: FORM_INVALID_REASON[result.formInvalidReason],
        }, scriptLogin, blockedRequests, loginObservation);
        reportFailure(result.kind, `the automated login ended with ${result.kind}`);
        exitWith(WORKER_LOGIN_FAILED_EXIT_CODE);
        return null;
      default:
        sendAuthState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, null, {
          ...failureReportOf(result.kind, result.submitted, result.responseAfterSubmission),
          retryAfterUntil: result.retryAfterUntil === null ? null : formatCompactUtcTimestamp(result.retryAfterUntil, 'retry after deadline'),
        }, scriptLogin, blockedRequests, loginObservation, undefined, stateNames);
        reportFailure(result.kind, `the automated login ended with ${result.kind}`);
        exitWith(WORKER_LOGIN_FAILED_EXIT_CODE);
        return null;
    }
  };

  /**
   * 認証つきの `START` のログインの段（T25d。Task 25 の設計書 4.4）。認証の指定（`RunAuthentication`）を返す。監査を始めずに終えるとき（設定の
   * SHA-256 の違い、ログインの段の失敗、止める要求）は、知らせと `FAILED` を送って終わり始め、`null` を返す。
   * - 同じメッセージ（`START`）の中の設定（認証の設定の文書と許可 Origin）と SHA-256 が食い違わないことを確かめる（設定から SHA-256 を求め直して
   *   比べる）。食い違えば `FAILED`（`AUTH_SETUP_CHANGED`）、終了コード 4（ログインしない）。
   * - ログインの段の失敗は、同じ値の `AUTH_STATE` と `FAILED` を送り、終了コード 1。止める要求なら、終了コード 5（`FINISHED` も `FAILED` も
   *   送らない。CLI の Ctrl+C と同じく、Run を始めずに終える）。
   * - 成功したら（ログイン用の Browser を閉じた後）`AUTHENTICATED` を送る。
   */
  const login = async (
    jobKind: WorkerJobKind,
    authentication: WorkerStartAuthentication,
    config: AuditConfig,
    navigationPacer: NavigationPacer,
  ): Promise<RunAuthentication | null> => {
    const { setup, approvedTestOrigins, authenticationSha256 } = authentication;
    const automatedLogin = authentication.automatedLogin ?? null;
    // T34c: プロファイルの承認したサービスの Origin も、あるときだけ SHA-256 に入れて求め直す（親と同じ求め方）。
    const approvedServiceOrigins = authentication.approvedServiceOrigins ?? [];
    if (workerAuthenticationDigestOf(setup, approvedTestOrigins, { jobKind, automatedLogin, approvedServiceOrigins }) !== authenticationSha256) {
      reportFailure('AUTH_SETUP_CHANGED', 'the auth setup differs from the one the parent checked');
      exitWith(WORKER_CONFIG_CHANGED_EXIT_CODE);
      return null;
    }
    // T26d-2: 自動ログインの指定があれば、自動ログインの段だけを行う（手動のログインの段へ切り替えない）。契約は、自動ログインの設定のときだけ
    // 指定があり、ログインの検証は必ず指定を持つことを確かめてある。
    if (automatedLogin !== null) {
      return automatedLoginStage(jobKind, authentication, automatedLogin, config, navigationPacer);
    }
    const result: LoginStageResult = dependencies.runLoginStage === undefined
      ? { kind: 'AUTH_SETUP_REQUIRED' }
      : await dependencies.runLoginStage({
        config,
        setup,
        approvedTestOrigins,
        approvedServiceOrigins,
        signal: controller.signal,
        onAwaitingLogin: () => sendAuthState('AWAITING_LOGIN'),
        // ML-a: 親の「ログインを終えた」（`LOGIN_CONFIRMED`）を受けたか。
        loginConfirmed: () => manualLoginConfirmed,
      });
    switch (result.kind) {
      case 'AUTHENTICATED':
        // DEF-139: 状態の名前の記録（値を持たない）も一緒に送る。
        sendAuthState('AUTHENTICATED', null, null, result.scriptLogin, result.blockedRequests, result.loginObservation, result.passedRequests, result.stateNames);
        return runAuthenticationOf(authentication, result.state, config.crawl.maxPages);
      case 'STOPPED':
        // T34R-fix-a（T34R の I-1）: 止めたときも、それまでの数と止めた送信の一覧があれば、最後の状態（ログインを待っていた）に付けて親に渡してから
        // 終わる（利用者が「まず空で試し、止めた記録を見る」ための材料を残す）。ML-a: 通した送信の一覧も同じ。
        if (result.scriptLogin !== undefined || result.blockedRequests !== undefined || result.passedRequests !== undefined) {
          sendAuthState(WORKER_STOPPED_LOGIN_STAGE_STATE, null, null, result.scriptLogin, result.blockedRequests, undefined, result.passedRequests);
        }
        exitWith(INTERRUPTED_EXIT_CODE);
        return null;
      case LOGIN_BROWSER_LAUNCH_REFUSED:
        // EL-3: ログイン用の Browser の起動を、起動の部品が閉じた理由で断った（ログインの画面を開いていない）。
        reportLoginBrowserLaunchRefused(result.refusal);
        return null;
      default:
        sendAuthState(result.kind, null, null, result.scriptLogin, result.blockedRequests, result.loginObservation, result.passedRequests, result.stateNames);
        reportFailure(result.kind, `the login stage ended without an authenticated state (${result.kind})`);
        exitWith(WORKER_LOGIN_FAILED_EXIT_CODE);
        return null;
    }
  };

  /**
   * 発見のジョブ（T27d。Task 27 の設計書 4.6）。発見の流れ（`executeDiscovery`）に、ログインの段の後の認証の指定と止める印を渡す。Run のディレクトリと
   * ロックを作ったら `RUN_STARTED`（新しい Run）、セッションの切れは止まった画面の URL つきの `AUTH_STATE`（`SESSION_LOST`）で送る。終わりは
   * `FINISHED`（`discovery.json` の場所は Run のディレクトリ。Run を実行した結果だけ、件数の要約を付ける。候補は載せない）を送り、結果の終了コードで
   * 終える。発見のジョブは再開しない（中断したら、もう一度始める）。
   */
  const discover = async (
    jobId: string,
    config: AuditConfig,
    authentication: RunAuthentication,
    executeDiscovery: NonNullable<AuditWorkerDependencies['executeDiscovery']>,
    navigationPacer: NavigationPacer | undefined,
    stageCarry: RunStageCarry | undefined = undefined,
  ): Promise<number> => {
    const outputDirectory = resolve(config.output.directory);
    const outcome = await executeDiscovery({
      config,
      jobId,
      authentication,
      launchBrowser: dependencies.runDependencies.launchBrowser,
      clock: dependencies.runDependencies.clock,
      now: dependencies.runDependencies.now,
      stopSignal: controller.signal,
      ...(navigationPacer === undefined ? {} : { navigationPacer }),
      // FM2d: まとめて実行の段の持ち越し（連鎖のときだけ）。
      ...(stageCarry === undefined ? {} : { stageCarry }),
    }, {
      onRunStarted: ({ runId, runDirectory }) => {
        sendChecked({
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'RUN_STARTED',
          runId,
          runDirectory: relativeRunDirectory(outputDirectory, runDirectory),
          resumeDecision: { kind: RESUME_DECISION_KIND.NEW_RUN, completedPages: null },
        });
      },
      // DEF-138: セッションの切れの証拠も載せる（組み立てられたときだけ）。
      onSessionLost: (url, sessionLoss) => sendSessionLost(url, sessionLoss),
      // DEF-136: サイトの不調の確かめ直しの待ちと減速を、監査と同じ `NOTICE` で送る（ジョブの画面に出る）。
      onNotice: (notice) => sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'NOTICE', notice: toWorkerNotice(notice) }),
      // DEF-143: 成果物を組み立てて書く段に入る知らせ（監査と同じ口）。
      onFinalizing: sendRunFinalizing,
    });
    if (!failureReported) {
      sendChecked({
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'FINISHED',
        ...toDiscoveryFinished(outcome, outputDirectory),
        // FM2d: まとめて実行の段は、未完了の理由のコードを載せる（Run を実行した結果だけ）。
        ...chainReasonCodesPart(stageCarry !== undefined, () => (outcome.kind === 'RAN' ? DISCOVERY_END_REASON_CODES[outcome.endReason] : null)),
      });
    }
    return outcome.exitCode;
  };

  /**
   * READ の確かめのジョブ（T27e。Task 27 の設計書 4.5）。発見のジョブと同じ送り方で、READ の確かめの流れ（`executeReadCheck`）に、ログインの段の後の
   * 認証の指定と、`START` の定義の一覧と、止める印を渡す。`FINISHED` は件数の要約だけ（結果は載せない）。再開しない。
   */
  const readCheck = async (
    jobId: string,
    readChecks: readonly WorkerStartReadCheck[],
    config: AuditConfig,
    authentication: RunAuthentication,
    executeReadCheck: NonNullable<AuditWorkerDependencies['executeReadCheck']>,
    navigationPacer: NavigationPacer | undefined,
    stageCarry: RunStageCarry | undefined = undefined,
  ): Promise<number> => {
    const outputDirectory = resolve(config.output.directory);
    const outcome = await executeReadCheck({
      config,
      jobId,
      authentication,
      readChecks,
      launchBrowser: dependencies.runDependencies.launchBrowser,
      clock: dependencies.runDependencies.clock,
      now: dependencies.runDependencies.now,
      stopSignal: controller.signal,
      ...(navigationPacer === undefined ? {} : { navigationPacer }),
      // FM2d: まとめて実行の段の持ち越し（連鎖のときだけ）。
      ...(stageCarry === undefined ? {} : { stageCarry }),
    }, {
      onRunStarted: ({ runId, runDirectory }) => {
        sendChecked({
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'RUN_STARTED',
          runId,
          runDirectory: relativeRunDirectory(outputDirectory, runDirectory),
          resumeDecision: { kind: RESUME_DECISION_KIND.NEW_RUN, completedPages: null },
        });
      },
      // DEF-138: セッションの切れの証拠も載せる（組み立てられたときだけ）。
      onSessionLost: (url, sessionLoss) => sendSessionLost(url, sessionLoss),
      // DEF-136: サイトの不調の確かめ直しの待ちと減速を、監査と同じ `NOTICE` で送る（ジョブの画面に出る）。
      onNotice: (notice) => sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'NOTICE', notice: toWorkerNotice(notice) }),
      // DEF-143: 成果物を組み立てて書く段に入る知らせ（監査と同じ口）。
      onFinalizing: sendRunFinalizing,
    });
    if (!failureReported) {
      sendChecked({
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'FINISHED',
        ...toReadCheckFinished(outcome, outputDirectory),
        ...chainReasonCodesPart(stageCarry !== undefined, () => (outcome.kind === 'RAN' ? READ_CHECK_END_REASON_CODES[outcome.endReason] : null)),
      });
    }
    return outcome.exitCode;
  };

  /**
   * 監査のジョブ（監査の中核 `executeAuditRun`。FM2d で関数に分けた。振る舞いは変えない）。結果の終了コードを返す（終えない）。FM2d: まとめて実行の段
   * （`stageCarry` あり）では、外の pacer をいつも渡し（ログインの方式によらない）、持ち越しの口を渡し、`FINISHED` に未完了の理由のコードを載せる。
   */
  const audit = async (
    runOptions: AuditRunOptions,
    config: AuditConfig,
    authentication: RunAuthentication | undefined,
    navigationPacer: NavigationPacer | undefined,
    automatedLogin: boolean,
    stageCarry: RunStageCarry | undefined = undefined,
  ): Promise<number> => {
    const outputDirectory = resolve(config.output.directory);
    const passPacer = navigationPacer !== undefined && (automatedLogin || stageCarry !== undefined);
    const outcome = await dependencies.executeAuditRun(
      config,
      {
        ...dependencies.runDependencies,
        stopSignal: controller.signal,
        ...(authentication === undefined ? {} : { authentication }),
        // CCX-22（DEF-102 の続き）: 自動ログインの段と同じ pacer を、Run Coordinator に渡す（ログインの段の最後の要求から、Run の最初の読み込みまで、
        // 設定の間隔以上空ける。再開のときは、Run Coordinator が保存の記録から自分で作る）。FM2d: まとめて実行の段は、方式によらず渡す。
        ...(passPacer ? { navigationPacer } : {}),
        ...(stageCarry === undefined ? {} : { stageCarry }),
      },
      runOptions,
      observerFor(outputDirectory),
    );
    if (!failureReported) {
      sendChecked({
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'FINISHED',
        outcome: toWorkerOutcome(outcome, outputDirectory),
        ...chainReasonCodesPart(stageCarry !== undefined, () => (outcome.kind === 'RAN' ? outcome.summary.incompleteReasons.map(({ code }) => code) : null)),
      });
    }
    return outcome.exitCode;
  };

  /** FM2d: まとめて実行の次の段の指定を待つ（`CHAIN_END`・止める要求・待つ上限なら `null`）。 */
  const awaitNextStage = (expected: WorkerNextStageJobKind): Promise<WorkerNextStageMessage | null> =>
    new Promise((resolvePromise) => {
      // 待つ上限のタイマーは unref しない（待つ間にプロセスが終わらないようにする）。
      const timer = setTimeout(() => settle(null), dependencies.nextStageTimeoutMs ?? WORKER_NEXT_STAGE_TIMEOUT_MS);
      const settle = (message: WorkerNextStageMessage | null): void => {
        clearTimeout(timer);
        nextStageWaiter = null;
        resolvePromise(message);
      };
      nextStageWaiter = { expected, settle };
    });

  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行。ログイン 1 回の後に、段を `chain.stages` の順に行う。
   * - 段ごとに、今のジョブの流れ（監査・発見・READ の確かめ）を行い、`RUN_STARTED`・`FINISHED` を送る（ジョブの ID は段ごと。最初の段は `START` のもの）。
   * - 持ち越すもの（メモリの中だけ。IPC・成果物・ログに出さない）: factory の最新のログインの状態（次の段の認証の指定の初めの状態）、pacer（同じものを渡す）、
   *   サービスの Origin への要求の 1 分の窓。1 回の Run あたりの上限は段ごと。
   * - 途中の段の `FINISHED` の後に、親の `NEXT_STAGE`（次の段のジョブの ID・種類・READ の定義）か `CHAIN_END` を待つ。`CHAIN_END`・止める要求・待つ上限・
   *   `FAILED` の後・止める印のある段の後は、次の段を始めずに、終えた段の終了コードで終える。
   * - 前の段の最新の状態が持ち越されていなければ（factory を作らなかったなど）、次の段を始めずに `FAILED`（`UNEXPECTED_FAILURE`）で終える（fail-closed）。
   */
  const runChain = async (
    start: WorkerStartMessage,
    stages: WorkerChainStageSequence,
    config: AuditConfig,
    firstAuthentication: RunAuthentication,
    navigationPacer: NavigationPacer,
  ): Promise<void> => {
    const carried: { value: RunStageCarried | null } = { value: null };
    const stageCarry = (): RunStageCarry => Object.freeze({
      serviceRequestWindowMs: carried.value?.serviceRequestWindowMs ?? [],
      record: (value: RunStageCarried): void => {
        carried.value = value;
      },
    });
    const automatedLogin = start.authentication?.automatedLogin !== undefined;
    let authentication = firstAuthentication;
    // 段の読み込みの間隔の部品（最初の段は、ログインの段と同じもの。次の段からは、前の段の持ち越しから作る。FM2R の C-1）。
    let stagePacer = navigationPacer;
    let current: { readonly kind: WorkerChainStageKind; readonly jobId: string; readonly readChecks: readonly WorkerStartReadCheck[] | undefined } = {
      kind: stages[0], jobId: start.jobId, readChecks: undefined,
    };
    for (let index = 0; ; index += 1) {
      const exitCode = await runChainStage(current, auditRunOptionsOf(start), config, authentication, stagePacer, automatedLogin, stageCarry());
      const nextKind = stages[index + 1] as WorkerNextStageJobKind | undefined;
      if (nextKind === undefined || failureReported || isExiting() || controller.signal.aborted) {
        exitWith(exitCode);
        return;
      }
      const next = await awaitNextStage(nextKind);
      if (next === null || failureReported || isExiting()) {
        exitWith(exitCode);
        return;
      }
      const latestState = carried.value?.latestState ?? null;
      if (latestState === null) {
        reportFailure('UNEXPECTED_FAILURE', 'the login state of the previous stage was not carried over');
        exitWith(FAILURE_EXIT_CODE);
        return;
      }
      authentication = { ...authentication, initialState: latestState };
      // FM2R の C-1: 次の段の読み込みの間隔は、前の段の持ち越し（最後の読み込み・段の終わり・上げた間隔）から待つ（再開した監査の段は外の pacer を
      // 使わないので、共有の pacer では足りない）。
      const carriedNavigation = carried.value?.navigation;
      if (carriedNavigation !== undefined) {
        stagePacer = nextStageNavigationPacerOf(carriedNavigation, config.crawl.minNavigationIntervalMs, dependencies.runDependencies.now, wait);
      }
      current = { kind: next.jobKind, jobId: next.jobId, readChecks: next.readChecks };
    }
  };

  /** FM2d: まとめて実行の段 1 つ（段の種類に対応する流れ。流れが渡されていない・定義がないなら `FAILED`（`JOB_KIND_NOT_SUPPORTED`））。 */
  const runChainStage = async (
    current: { readonly kind: WorkerChainStageKind; readonly jobId: string; readonly readChecks: readonly WorkerStartReadCheck[] | undefined },
    runOptions: AuditRunOptions,
    config: AuditConfig,
    authentication: RunAuthentication,
    navigationPacer: NavigationPacer,
    automatedLogin: boolean,
    stageCarry: RunStageCarry,
  ): Promise<number> => {
    switch (current.kind) {
      case WORKER_AUDIT_JOB_KIND:
        return audit(runOptions, config, authentication, navigationPacer, automatedLogin, stageCarry);
      case WORKER_DISCOVERY_JOB_KIND:
        if (dependencies.executeDiscovery !== undefined) {
          return discover(current.jobId, config, authentication, dependencies.executeDiscovery, navigationPacer, stageCarry);
        }
        break;
      case WORKER_READ_CHECK_JOB_KIND:
        if (dependencies.executeReadCheck !== undefined && current.readChecks !== undefined) {
          return readCheck(current.jobId, current.readChecks, config, authentication, dependencies.executeReadCheck, navigationPacer, stageCarry);
        }
        break;
    }
    reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, `the worker cannot run the chained stage ${current.kind}`);
    return FAILURE_EXIT_CODE;
  };

  /**
   * 書き込みのジョブ（T30f。Task 30 の設計書 3 章）。READ の確かめと同じ送り方で、書き込みの流れ（`executeWriteCreate`）に、ログインの段の後の認証の
   * 指定と、`START` の書き込みの指定と、止める印と、IPC の部品の 2 つの口（確かめ直しの往復、送信の報告）を渡す。`FINISHED` は結果を載せない。
   */
  const writeCreate = async (
    start: WorkerStartMessage,
    write: WorkerStartWrite | WorkerStartApiWrite,
    config: AuditConfig,
    authentication: RunAuthentication,
    executeWriteCreate: NonNullable<AuditWorkerDependencies['executeWriteCreate']>,
    navigationPacer: NavigationPacer | undefined,
  ): Promise<void> => {
    const outputDirectory = resolve(config.output.directory);
    const outcome = await executeWriteCreate({
      config,
      jobId: start.jobId,
      authentication,
      write,
      launchBrowser: dependencies.runDependencies.launchBrowser,
      clock: dependencies.runDependencies.clock,
      now: dependencies.runDependencies.now,
      stopSignal: controller.signal,
      ...(navigationPacer === undefined ? {} : { navigationPacer }),
      recheck: () => writeIpc.requestRecheck(),
      reportSubmission: (report) => {
        writeIpc.reportSubmission(report);
      },
    }, {
      onRunStarted: ({ runId, runDirectory }) => {
        sendChecked({
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'RUN_STARTED',
          runId,
          runDirectory: relativeRunDirectory(outputDirectory, runDirectory),
          resumeDecision: { kind: RESUME_DECISION_KIND.NEW_RUN, completedPages: null },
        });
      },
      onSessionLost: (url) => sendAuthState(WORKER_SESSION_LOST_STATE, reportedSessionLostUrlOf(url)),
    });
    if (!failureReported) {
      sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...toWriteFinished(outcome, outputDirectory) });
    }
    exitWith(outcome.exitCode);
  };

  /**
   * 入口の確かめのジョブ（T43c。Task 43 の設計書 4.3）。ログインの段を通さずに、入口の確かめの流れ（`executeEntryCheck`）に、設定と止める印を渡す。
   * 送るメッセージは発見のジョブと同じ（`RUN_STARTED`、`FINISHED`。セッションの切れはない）。`FINISHED` は件数の要約だけ（事実と案は
   * `entry-check.json`）。再開しない。
   */
  const entryCheck = async (
    start: WorkerStartMessage,
    config: AuditConfig,
    executeEntryCheck: NonNullable<AuditWorkerDependencies['executeEntryCheck']>,
  ): Promise<void> => {
    const outputDirectory = resolve(config.output.directory);
    const outcome = await executeEntryCheck({
      config,
      jobId: start.jobId,
      launchBrowser: dependencies.runDependencies.launchBrowser,
      clock: dependencies.runDependencies.clock,
      now: dependencies.runDependencies.now,
      stopSignal: controller.signal,
    }, {
      onRunStarted: ({ runId, runDirectory }) => {
        sendChecked({
          protocol: WORKER_PROTOCOL_VERSION,
          type: 'RUN_STARTED',
          runId,
          runDirectory: relativeRunDirectory(outputDirectory, runDirectory),
          resumeDecision: { kind: RESUME_DECISION_KIND.NEW_RUN, completedPages: null },
        });
      },
      // T44g（Task 44 の設計書 P4-5。DEF-143 の残り）: 成果物を書く段に入る知らせ（監査・発見・READ の確かめと同じ口）。
      onFinalizing: sendRunFinalizing,
    });
    if (!failureReported) {
      sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', ...toEntryCheckFinished(outcome, outputDirectory) });
    }
    exitWith(outcome.exitCode);
  };

  /** ターゲット JSON の今の内容の SHA-256 が、`START` の値と同じか（読めなければ偽）。 */
  const targetConfigUnchanged = async (start: WorkerStartMessage): Promise<boolean> => {
    try {
      return targetConfigDigestOf(await dependencies.readTargetConfig(start.targetConfigPath)) === start.targetConfigSha256;
    } catch {
      return false;
    }
  };

  /** 設定が変わったので、監査を始めずに終える。 */
  const reportConfigChanged = (): void => {
    reportFailure('CONFIG_CHANGED', 'the target configuration changed after the parent checked it');
    exitWith(WORKER_CONFIG_CHANGED_EXIT_CODE);
  };

  const run = async (start: WorkerStartMessage): Promise<void> => {
    stage = 'RUNNING';
    // T43c: 入口の確かめも、`FAILED` の詳細の URL の秘密を伏せる（認証の指定は持たないが、対象のサイトの URL を扱う）。
    authenticatedRun = start.authentication !== undefined || start.jobKind === WORKER_ENTRY_CHECK_JOB_KIND;
    clearTimeout(startTimer);
    // T27c: 対応していない種類は、設定を読む前に拒む（ログインも監査もしない）。T27d: 発見の流れが渡されていなければ、発見も同じく拒む。
    // T27e: READ の確かめの流れが渡されていなければ、READ の確かめも同じく拒む。
    if (
      !isImplementedJobKind(start.jobKind)
      || (start.jobKind === WORKER_DISCOVERY_JOB_KIND && dependencies.executeDiscovery === undefined)
      || (start.jobKind === WORKER_READ_CHECK_JOB_KIND && dependencies.executeReadCheck === undefined)
      || (isWriteJobKind(start.jobKind) && dependencies.executeWriteCreate === undefined)
      // T43c: 入口の確かめの流れが渡されていなければ、入口の確かめも同じく拒む。
      || (start.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && dependencies.executeEntryCheck === undefined)
      // FM2d: まとめて実行は、どの段の流れも渡されているときだけ（ログインの前に拒む）。
      || (start.chain?.stages.some((kind) => (kind === WORKER_DISCOVERY_JOB_KIND && dependencies.executeDiscovery === undefined)
        || (kind === WORKER_READ_CHECK_JOB_KIND && dependencies.executeReadCheck === undefined)) ?? false)
    ) {
      reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, `the worker does not implement the job kind ${start.jobKind} yet`);
      exitWith(FAILURE_EXIT_CODE);
      return;
    }
    // T40b-1（Task 40 の設計書 3.3）: 送り方 API の書き込み（T40a で早く拒んでいた）も、form と同じ口（設定の読み込み、ログイン、書き込みの流れ、
    // 送信の報告、確かめ直しの往復）で行う。
    try {
      if (!(await targetConfigUnchanged(start))) {
        reportConfigChanged();
        return;
      }
      // FM-2: プロファイルの表示の設定（`START` の `showJobBrowser`）が真なら、ジョブのブラウザを表示する上書きで読む。
      // AS-b: プロファイルの監査の段の送信の扱い（`START` の `auditSendPolicy`）を、実効の設定の上書きとして当てる。項目のない `START`（書き込み・ログインの
      // 確かめ・入口の確かめを含む）は、ターゲット JSON の値によらず読み取りだけ（fail-closed）。
      const config = await dependencies.loadConfig(
        start.targetConfigPath,
        withAuditSendPolicyOverride(
          start.showJobBrowser === true ? WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES : WORKER_CONFIG_OVERRIDES,
          start.auditSendPolicy ?? AUDIT_SEND_READ_ONLY,
        ),
      );
      if (!(await targetConfigUnchanged(start))) {
        reportConfigChanged();
        return;
      }
      // T43c: 入口の確かめは、ログインの段を通さずに入口の確かめの流れを行う（契約が、認証の指定を持たないことを確かめてある）。
      if (start.jobKind === WORKER_ENTRY_CHECK_JOB_KIND) {
        if (start.authentication !== undefined || dependencies.executeEntryCheck === undefined) {
          // 契約で起きない（fail-closed。監査として扱わない）。
          reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, `the worker cannot run ${WORKER_ENTRY_CHECK_JOB_KIND} with an authentication`);
          exitWith(FAILURE_EXIT_CODE);
          return;
        }
        await entryCheck(start, config, dependencies.executeEntryCheck);
        return;
      }
      // T25d: 認証つきなら、監査の前に（再開のときも）ログインする。状態は保存しない。
      let authentication: RunAuthentication | undefined;
      // DEF-102 fix: 認証つきの `START` だけ、読み込みの間隔を守る部品を 1 つ作り、自動ログインの段と、その後のジョブに同じものを渡す。
      let navigationPacer: NavigationPacer | undefined;
      if (start.authentication !== undefined) {
        // T25f round 2: ログインの段（ログイン用の Browser の起動）の前に、認証つきの Run の指定を、監査の本体の確かめ（`assertRunAuthentication`。
        // Run Coordinator のコンストラクタも、守りの二重として同じ確かめをする）で確かめる。状態はログインの前なので空の状態を置く（状態の形の
        // 確かめだけに使い、状態の中身は確かめない）。`crawl.allowedQueryParameters` に伏せ字の一覧の名前があれば `ConfigError` を投げ、下の
        // `catch` が今と同じ `FAILED`（`CONFIG_ERROR`）で終える（`AWAITING_LOGIN` を送らない）。
        // T26d-2: ログインの検証は Run を作らないので、認証つきの Run の確かめをしない。
        if (start.jobKind !== WORKER_LOGIN_CHECK_JOB_KIND) {
          assertRunAuthentication(runAuthenticationOf(start.authentication, PRE_LOGIN_STATE, config.crawl.maxPages), config);
        }
        navigationPacer = createNavigationPacer({
          minIntervalMs: config.crawl.minNavigationIntervalMs,
          now: dependencies.runDependencies.now,
          sleep: wait,
        });
        const prepared = await login(start.jobKind, start.authentication, config, navigationPacer);
        if (prepared === null) {
          return;
        }
        authentication = prepared;
      }
      // FM2d: まとめて実行は、ログイン 1 回の後に段を続ける（契約が、認証つきで、閉じた一覧の並びであることを確かめてある）。
      if (start.chain !== undefined) {
        if (authentication === undefined || navigationPacer === undefined) {
          // 契約で起きない（fail-closed）。
          reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, 'the worker cannot run the chained run without its authentication');
          exitWith(FAILURE_EXIT_CODE);
          return;
        }
        await runChain(start, start.chain.stages, config, authentication, navigationPacer);
        return;
      }
      // T27d: 発見のジョブは、ログインの後に発見の流れを行う（監査の中核は呼ばない）。契約が、発見の `START` に認証の指定を求めている。
      if (start.jobKind === WORKER_DISCOVERY_JOB_KIND && authentication !== undefined && dependencies.executeDiscovery !== undefined) {
        exitWith(await discover(start.jobId, config, authentication, dependencies.executeDiscovery, navigationPacer));
        return;
      }
      // T27e: READ の確かめのジョブは、ログインの後に READ の確かめの流れを行う（監査の中核は呼ばない）。契約が、認証の指定と定義の一覧を求めている。
      if (start.jobKind === WORKER_READ_CHECK_JOB_KIND) {
        if (authentication === undefined || start.readChecks === undefined || dependencies.executeReadCheck === undefined) {
          // 契約で起きない（fail-closed。監査として扱わない）。
          reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, `the worker cannot run ${WORKER_READ_CHECK_JOB_KIND} without its authentication and definitions`);
          exitWith(FAILURE_EXIT_CODE);
          return;
        }
        exitWith(await readCheck(start.jobId, start.readChecks, config, authentication, dependencies.executeReadCheck, navigationPacer));
        return;
      }
      // T30f: 書き込みのジョブは、ログインの後に書き込みの流れを行う（監査の中核は呼ばない）。契約が、認証の指定と書き込みの指定を求めている。
      // T31g-2: 更新の書き込みのジョブ（`WRITE_UPDATE`）も、同じ書き込みの流れ（契約が、UPDATE の指定を求めている）。
      // T40b-1: 送り方 API の登録の書き込みの指定も、同じ書き込みの流れに渡す（流れが送り方で分ける）。
      if (isWriteJobKind(start.jobKind)) {
        if (authentication === undefined || start.write === undefined || dependencies.executeWriteCreate === undefined) {
          // 契約で起きない（fail-closed。監査として扱わない）。
          reportFailure(WORKER_JOB_KIND_NOT_SUPPORTED_REASON, `the worker cannot run ${start.jobKind} without its authentication and write specification`);
          exitWith(FAILURE_EXIT_CODE);
          return;
        }
        await writeCreate(start, start.write, config, authentication, dependencies.executeWriteCreate, navigationPacer);
        return;
      }
      exitWith(await audit(auditRunOptionsOf(start), config, authentication, navigationPacer, (start.authentication?.automatedLogin ?? null) !== null));
    } catch (error) {
      const failure = classifyCliFailure(error);
      reportFailure(FAILURE_REASON[failure.kind], failureDetailOf(error));
      exitWith(failure.exitCode);
    }
  };

  const receive = (value: unknown): void => {
    if (stage === 'EXITING' || parentDistrusted) {
      return;
    }
    const parsed = validateParentToWorkerMessage(value);
    if (!parsed.ok) {
      parentDistrusted = true;
      violate(`invalid message from the parent: ${parsed.errors.join('; ')}`);
      return;
    }
    const message = parsed.message;
    if (message.type === 'STOP') {
      interrupt();
      if (message.force) {
        // 強制は、CLI の 2 回目の Ctrl+C と同じ（1 回目がまだなら、1 回目と 2 回目を続けて数える）。
        interrupt();
      }
      return;
    }
    if (message.type === 'LOGIN_CONFIRMED') {
      // ML-a: 「ログインを終えた」。手動のログインの段が次の確かめで成功として進む（段の外では何もしない。`START` の前は信用しない）。
      if (stage === 'WAITING') {
        parentDistrusted = true;
        violate('LOGIN_CONFIRMED was received before START');
        return;
      }
      manualLoginConfirmed = true;
      return;
    }
    if (message.type === 'WRITE_RECHECK_RESULT') {
      // T30e: 待っている確かめ直しの依頼がなければ（依頼していない、上限の後、2 回目）、親を信用しない。
      if (!writeIpc.receiveRecheckResult(message)) {
        parentDistrusted = true;
        violate('a WRITE_RECHECK_RESULT was received without a pending recheck request');
      }
      return;
    }
    if (message.type === 'NEXT_STAGE' || message.type === 'CHAIN_END') {
      // FM2d: 次の段の指定は、途中の段の `FINISHED` の後に 1 回だけ。種類は `START` の並びの次の段。違えば親を信用しない。
      const waiter = nextStageWaiter;
      if (waiter === null || (message.type === 'NEXT_STAGE' && message.jobKind !== waiter.expected)) {
        parentDistrusted = true;
        violate(`${message.type} was received while the worker did not wait for the next stage`);
        return;
      }
      waiter.settle(message.type === 'NEXT_STAGE' ? message : null);
      return;
    }
    if (stage !== 'WAITING') {
      parentDistrusted = true;
      violate('START was received after the worker had started');
      return;
    }
    void run(message);
  };

  const startTimeoutMs = dependencies.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
  // `START` を待つタイマーは unref しない（待つ間にプロセスが終わらないようにする）。
  const startTimer = setTimeout(() => {
    if (stage === 'WAITING') {
      reportFailure('START_TIMEOUT', `START was not received within ${startTimeoutMs} ms`);
      exitWith(FAILURE_EXIT_CODE);
    }
  }, startTimeoutMs);
  const heartbeat = setInterval(() => {
    if (stage !== 'EXITING') {
      sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'HEARTBEAT' });
    }
  }, dependencies.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  channel.onMessage(receive);
  channel.onDisconnect(() => {
    if (stage === 'EXITING') {
      return;
    }
    parentDistrusted = true;
    interrupt();
  });
  sendChecked({ protocol: WORKER_PROTOCOL_VERSION, type: 'READY' });

  return {
    interrupt,
    failUnexpectedly: (error) => {
      reportFailure('UNEXPECTED_FAILURE', failureDetailOf(error));
      exitWith(FAILURE_EXIT_CODE);
    },
    exited,
    dispose: stopTimers,
  };
}
