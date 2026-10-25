/**
 * 監査のジョブの Server Functions（Task 24 の設計書 4.4、4.8。T24f）。
 * - 書き込み（開始、停止）は POST だけ。読むだけのもの（一覧、詳細、開始の画面の要点）は GET。
 * - 入力は、サーバで `schemas/control/` のスキーマ（`ui-audit-job-*`、`ui-profile-key`）で確かめてから使う（`requestOf`）。開始の判断
 *   （プロファイル、改訂、今実行できるモード、ターゲット設定の読み直し、同時に 1 つ）は、ジョブの管理（`src/control/job/`）が開始の直前に
 *   行う（I08）。画面の表示の確かめは補助だけ。
 * - 返す値は、表示に要るものだけ（管理データの生の誤りの文や、内部のパスの全体を返さない）。日時は ISO 8601（表示は `formatDateTime`）。
 * - 開始の画面の要点（開始の URL、ページの上限、時間の上限、ページの読み込みの間隔）は、ターゲット設定の値を読むだけで、画面からは変えない。
 * - T25e（Task 25 の設計書 4.5）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）では、開始の画面の要点に、認証の設定の要点（ログインの画面の
 *   URL、読む範囲、新しさ）と、開始できない理由（認証の方式、認証の設定がない・古い・誤りがある）と、その検証の誤り（コードと項目）を足す。
 *   判断の順は、ジョブの管理の開始の直前の確かめ（`startAuditJob`）と同じ。ジョブの詳細には、最後の認証の状態と、セッションが切れて止まった
 *   ページの URL を足す（値と秘密を含まない。Cookie などは画面のサーバに届かない）。
 * - T26e（Task 26 の設計書 4.5、4.6）: ジョブの行に種類（監査、ログインの確かめ）を、詳細に自動ログインの試しの結果（結果、送信、`Retry-After` の
 *   期限、フォームの確かめの理由のコード）を足す。開始の画面の要点に、認証の方式と、自動ログインのプロファイルの開始の前の確かめ（資格情報の
 *   メタデータ、暗号化の状態（起動のときの準備の結果）、上限。読むだけ。判定は `audit-start-check.ts`）と、ログインの確かめの画面の確かめの結果を
 *   足す。ログインの確かめの開始（`startLoginCheckFn`。POST だけ）は、ジョブの管理の `startLoginCheck` を呼ぶ。
 */
import { createServerFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { PrecheckFailureDetail } from '../../../../src/control/actions/action-contracts.js';
import type { AutomatedLoginResult, AutomatedLoginSubmission } from '../../../../src/control/auth/automated-login-results.js';
import type { AuditMode, AuthStrategy, ProfileValidationErrorCode } from '../../../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS,
  FINISHED_AUDIT_JOB_STATE,
  // PRE42-CC 組 UI-K（組 3 の発見）: 止める要求を送ったジョブの状態は、owner の名前つきの定数から読む（文字列で比べない）。
  STOPPING_AUDIT_JOB_STATE,
  type AuditJobFailureReason,
  type AuditJobKind,
  type AuditJobStartRejectionReason,
  type AuditJobState,
  type AuditJobStopRejectionReason,
} from '../../../../src/control/job/job-records.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import {
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
} from '../../../../src/control/worker-protocol.js';
import type { AuditJobLoginConfirmResult } from '../../../../src/control/job/audit-job-manager.js';
import { chainStagesOfMode, type StageChainView } from '../../../../src/control/job/stage-chain-policy.js';
import type { WorkerChainStageKind } from '../../../../src/control/worker-protocol.js';
import type { AuditJobLoginStageSummary, AuditJobView } from '../../../../src/control/job/job-store.js';
import type { AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
import { getProfile, readProfileDisplaySettings } from '../../../../src/control/store/profile-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import {
  WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY,
  type WorkerAuthState,
  type WorkerLoginFormInvalidReason,
  type WorkerOutcomeKind,
  type WorkerRunNotice,
} from '../../../../src/control/worker-protocol.js';
import { DEFAULT_AUDIT_SEND_POLICY, hasAuditSendWebSocketCaution, type AuditSendPolicyName } from '../../../../src/core/audit-send-policy.js';
import type {
  IncompleteReasonCode,
  JobSafetyViolation,
  PageIncompleteReasonCount,
  RunAuditSendSummary,
  RunAuthenticationSummary,
  RunExecutionEndReason,
  RunProgressReport,
  RunStatus,
} from '../../../../src/core/contracts.js';
// PRE42-CC 組 UI-K（CC-048 の画面の側）: `run.json` の実行の記録の最後の実行は、core の唯一の選び方で選ぶ。
import { lastRunExecutionOf } from '../../../../src/core/run-executions.js';
import type {
  DiscoveryEndReason,
  DiscoveryExternalSchemeProbes,
  DiscoveryPressLimitProbes,
  ReadCheckEndReason,
} from '../../../../src/control/discovery-view.js';
import type { SessionLossEvidence } from '../../../../src/core/evidence-types.js';
import { listJobArtifacts, readJobResultDocument, type JobArtifactView, type JobResultDocumentKind } from './artifact-files';
import type { AuthSetupErrorView } from './auth-setup-errors';
import { auditStartCheckOf, startRejectionViewOf, type AuditStartBlocker } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import { entryCheckResultOfJob, type EntryCheckResultView } from './entry-check-functions';
import { requestOf } from './request-validation';
import { readProfileStart, type AuditAutoLoginSummaryView } from './start-check-inputs';
import { compactTimestampMs, isoTimestampOf, isoTimestampOrNull } from './timestamps';
import { isWriteJobKind } from './write-kinds';
import { writeResultSummaryOfJob, type WriteResultSummaryView } from './write-results';
import { writeChainOfCreateJob, type WriteChainView } from './write-chain';
import { loginSetupViewOf, type LoginSetupView } from './login-setup-view';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 実行履歴の 1 行。 */
export interface AuditJobRowView {
  readonly jobId: string;
  /** ジョブの種類（監査、ログインの確かめ。T26e）。 */
  readonly jobKind: AuditJobKind;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly state: AuditJobState;
  readonly startNew: boolean;
  readonly runId: string | null;
  /** 監査の中核の結果の Run の状態のまま（書き換えない）。 */
  readonly runStatus: RunStatus | null;
  readonly endKind: WorkerOutcomeKind | null;
  readonly exitCode: number | null;
  readonly failureReason: AuditJobFailureReason | null;
  /** 日時は ISO 8601。 */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stopRequestedAt: string | null;
}

/** ジョブの詳細と進み具合。 */
export interface AuditJobDetailView extends AuditJobRowView {
  readonly lastProgress: RunProgressReport | null;
  readonly lastNotice: WorkerRunNotice | null;
  /** 終わっていない（`STARTING`、`RUNNING`、`STOPPING`）。画面は、この間だけ読み直す。 */
  readonly active: boolean;
  /** 止める要求の後、名前つきの時間（`AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS`）を過ぎても止まっていない（「強制的に止める」を出す）。 */
  readonly forceStopAvailable: boolean;
  /** 止める要求から「強制的に止める」を出すまでの時間（ms。`AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS`。画面の説明の文に使う）。 */
  readonly forceStopOfferAfterMs: number;
  /** あるものだけ。 */
  readonly artifacts: readonly JobArtifactView[];
  /** 最後の認証の状態（認証つきの監査だけ。ほかは `null`。T25e）。 */
  readonly lastAuthState: WorkerAuthState | null;
  /** セッションが切れて止まったページの URL（`SESSION_LOST` のときだけ。Ledger と同じ伏せ字の後の値。T25e）。 */
  readonly sessionLostUrl: string | null;
  /**
   * DEF-138: セッションの切れの証拠（`SESSION_LOST` の知らせが持ったときだけ。ジョブの記録の写し。path と query の名前と数だけで、値を持たない）。
   */
  readonly sessionLoss: SessionLossEvidence | null;
  /** 自動ログインの試しの結果（自動ログインのジョブだけ。ほかは `null`。値を含まない。T26e）。 */
  readonly autoLogin: AuditJobAutoLoginView | null;
  /** 書き込みの結果（T30g。書き込みのジョブで、記録があるときだけ。ほかは `null`）。 */
  readonly write: WriteResultSummaryView | null;
  /** T41g（Task 41 の設計書 3.5.1）: 登録のジョブの、続けて更新する予定と状態（「登録してから更新する」で始めた登録のジョブだけ。メモリの中）。 */
  readonly writeChain: WriteChainView | null;
  /** FM2d: まとめて実行の段の一覧と状態（まとめて実行の段のジョブだけ。ジョブの管理のメモリの中。ほかは `null`）。 */
  readonly stageChain: StageChainView | null;
  /**
   * ML-b（手動のログインの設計書 2.3）: 手動のログインの成功から自動で登録した設定（認証つきのジョブで、プロファイルにスクリプトで送るログインの設定が
   * あるときだけ。値を持たない）。
   */
  readonly loginSetup: LoginSetupView | null;
  /**
   * FM-1（手動の操作を減らす設計書 2.2）: プロファイルの表示の設定で、ジョブのブラウザを表示するか（今の設定。動いているジョブの画面に「見るだけ。操作
   * しない」の注意を出すため）。
   */
  readonly jobBrowserShown: boolean;
  /**
   * ログインの段のまとめ（T34e。手動のログインの段の結果が、数のまとめか、止めた読み取りでない要求の一覧を持ったときだけ。ほかは `null`）。Origin と
   * path と種類と理由と回数だけで、query・本文・値を持たない。
   */
  readonly loginStage: AuditJobLoginStageSummary | null;
  /**
   * 監査の段の数（T37a。Task 37 の設計書 3.1。終わった（`FINISHED`）発見と READ の確かめのジョブで、成果物 `discovery.json`・`read-evidence.json` が
   * 持つときだけ。ほかは `null`）。成果物は、スキーマとジョブの ID を確かめる読み出し（`readJobResultDocument`）で読む（管理データには保存しない）。
   * 数だけで、URL・値を持たない。
   */
  readonly auditStage: RunAuthenticationSummary | null;
  /**
   * DEF-144: 安全の違反の中身（終わった（`FINISHED`）発見と READ の確かめのジョブで、成果物 `discovery.json`・`read-evidence.json` が持つときだけ。ほかは
   * `null`）。成果物は `auditStage` と同じ読み出しで読む（管理データには保存しない）。値（本文、query の値、Cookie、token）を持たない。
   */
  readonly safetyViolation: JobSafetyViolation | null;
  /**
   * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: 終わった発見のジョブの、外部スキームで押さなかった候補の数と、読み込み直した
   * 画面の数（成果物 `discovery.json` が持つときだけ。ほかは `null`）。数だけ。
   */
  readonly externalSchemeProbes: DiscoveryExternalSchemeProbes | null;
  /**
   * T44c（Task 44 の設計書 P1-3）: 終わった発見のジョブの、押す数の上限で押せなかった登録・更新の語の候補の数（成果物 `discovery.json` が持つときだけ。ほかは
   * `null`）。数だけ。
   */
  readonly pressLimitProbes: DiscoveryPressLimitProbes | null;
  /**
   * T44c（Task 44 の設計書 P1-4。設計者の判断）: 終わった監査のジョブの、ページの未完了の理由ごとのページ数（`run.json` の `pageIncompleteReasonCounts`。持つときだけ。
   * ほかは `null`）。数と理由のコードだけ。
   */
  readonly pageIncompleteReasons: readonly PageIncompleteReasonCount[] | null;
  /**
   * AS-b（監査の段の送信の扱いの設計書 2.3）: 監査・発見・READ の確かめのジョブの、結果の記録の監査の段の送信の扱いと、通した数（監査は `run.json` の
   * `safety.auditSend`、発見と READ の確かめは成果物の `auditSendPolicy`。通した数は監査だけで、ほかは `null`）。記録がないジョブは `null`。項目のない古い
   * 記録は `READ_ONLY`。目立つ形で出すかは画面が表示カタログ（`AUDIT_SEND_POLICY_CATALOG`）で決める。数だけで、URL・値を持たない。
   */
  readonly auditSend: AuditJobAuditSendView | null;
  /**
   * 今のプロファイルのモードと認証の方式（T43a。ログインの確かめの成功の後の次の手順のリンクを選ぶ。判定は `display/next-steps.ts` の
   * `nextStepAfter`）。プロファイルがなければ `null`。
   */
  readonly currentProfile: { readonly mode: AuditMode; readonly auth: AuthStrategy } | null;
  /**
   * 入口の確かめの結果（T43c。Task 43 の設計書 4.3。終わった（`FINISHED`）入口の確かめのジョブで、成果物 `entry-check.json` を読めたときだけ。ほかは
   * `null`）。読んだ事実と案だけで、欄の値は持たない（成果物にもない）。
   */
  readonly entryCheck: EntryCheckResultView | null;
  /**
   * T44e（Task 44 の設計書 P2-7）: 監査のジョブの Run の終わり方と理由（`run.json` を読めたときだけ。ほかは `null`）。最後の実行の終わり方、Run の全体の
   * 理由のコード（重なりを除いた、記録の順）、ページの数（一部未完了・失敗・監査しなかった）。理由の `detail`（英語の技術的な詳細）は写さない。
   */
  readonly runEnd: AuditJobRunEndView | null;
  /** T44e: 終わった発見と READ の確かめのジョブの終わり方（成果物を読めたときだけ。ほかは `null`）。 */
  readonly profileJobEnd: AuditJobProfileJobEndView | null;
  /**
   * T44e（Task 44 の設計書 P2-4）: 書き込みのジョブが送る前の確かめで送らずに止めたときの具体的な理由（`action-run.json` の `precheckDetail`。スキーマと
   * ジョブの ID を確かめて読む。項目のない記録・ほかの止め方・書き込みでないジョブは `null`）。
   */
  readonly writePrecheckDetail: PrecheckFailureDetail | null;
}

/** T44e: 監査のジョブの Run の終わり方と理由。 */
export interface AuditJobRunEndView {
  readonly lastExecutionEndReason: RunExecutionEndReason | null;
  readonly reasons: readonly IncompleteReasonCode[];
  readonly partialPageCount: number;
  readonly failedPageCount: number;
  readonly skippedPageCount: number;
}

/** T44e: 発見と READ の確かめのジョブの終わり方。 */
export type AuditJobProfileJobEndView =
  | { readonly kind: 'DISCOVERY'; readonly endReason: DiscoveryEndReason }
  | { readonly kind: 'READ_CHECK'; readonly endReason: ReadCheckEndReason };

/** ジョブの自動ログインの試しの結果（T26e。日時は ISO 8601）。 */
export interface AuditJobAutoLoginView {
  /** 結果（まだ決まっていなければ `null`）。 */
  readonly result: AutomatedLoginResult | null;
  readonly submitted: AutomatedLoginSubmission | null;
  /** 429 のときだけ、サーバが示した次に試してよい日時。 */
  readonly retryAfterUntil: string | null;
  /** フォームの確かめで止まったときだけ、理由のコード。 */
  readonly formInvalidReason: WorkerLoginFormInvalidReason | null;
}

/** 開始の結果。 */
export type AuditJobStartView =
  | { readonly ok: true; readonly jobId: string }
  | {
    readonly ok: false;
    readonly reason: AuditJobStartRejectionReason;
    readonly errorCodes: readonly ProfileValidationErrorCode[];
    /** 認証の設定の検証の誤り（`AUTH_SETUP_INVALID` のときだけ。ほかは空。T25e）。 */
    readonly authSetupErrors: readonly AuthSetupErrorView[];
    /** 次に始められる日時（ISO 8601。自動ログインの上限で拒んだときだけ持つ。止めているときは `null`。T26e）。 */
    readonly nextAllowedAt?: string | null;
  };

/** 停止の結果。 */
export type AuditJobStopView =
  | { readonly ok: true; readonly job: AuditJobRowView }
  | { readonly ok: false; readonly reason: AuditJobStopRejectionReason };

/** 開始の画面の、ターゲット設定の要点（読むだけ）。 */
export interface AuditTargetSummaryView {
  readonly startUrl: string;
  readonly maxPages: number;
  readonly maxRuntimeMs: number;
  readonly minNavigationIntervalMs: number;
}

/** 開始の画面に出す、開始できない理由（判定は `audit-start-check.ts`）。 */
export type { AuditStartBlocker };

/** 開始の画面の、認証の設定の要点（読むだけ。T25e）。 */
export interface AuditAuthSetupSummaryView {
  readonly loginStartUrl: string;
  /** 読む範囲のパスの前方一致（空なら制限なし）。 */
  readonly auditPathPrefixes: readonly string[];
  readonly freshness: AuthSetupFreshness;
}

/** 自動ログインのプロファイルの、開始の前の状態（T26e。値を含まない。日時は ISO 8601。T27f で読む部品と一緒に `start-check-inputs.ts` へ移した）。 */
export type { AuditAutoLoginSummaryView };

/** ある種類のジョブの、開始できない理由（T26e。ログインの確かめの画面で使う）。 */
export interface AuditStartCheckView {
  readonly blocker: AuditStartBlocker | null;
  readonly errorCodes: readonly ProfileValidationErrorCode[];
  readonly authSetupErrors: readonly AuthSetupErrorView[];
  /** 次に始められる日時（`AUTO_LOGIN_RATE_LIMITED` のときだけ。ISO 8601）。 */
  readonly nextAllowedAt: string | null;
}

/** 開始の画面の値。 */
export interface AuditStartSummaryView {
  readonly profileId: string;
  readonly revision: number;
  readonly mode: AuditMode;
  readonly status: ProfileStatus;
  readonly targetConfigPath: string;
  /** 読めたターゲット設定の要点（読めなければ `null`）。 */
  readonly target: AuditTargetSummaryView | null;
  /** 開始できない理由（なければ `null`）。 */
  readonly blocker: AuditStartBlocker | null;
  readonly errorCodes: readonly ProfileValidationErrorCode[];
  readonly configError: ConfigErrorKind | null;
  /**
   * この開始に認証の設定が要るか（T25e。開始の画面に、ログインの案内を出す。T28b: `execution-policy.ts` の `operationRequiresAuthSetup`。監査を
   * 始められない書き込みのモードでは偽）。
   */
  readonly authRequired: boolean;
  /** 保存してある認証の設定の要点（認証の設定が要るモードで、保存してあるときだけ。ほかは `null`）。 */
  readonly authSetup: AuditAuthSetupSummaryView | null;
  /** 認証の設定の検証の誤り（`AUTH_SETUP_INVALID` のときだけ。ほかは空）。 */
  readonly authSetupErrors: readonly AuthSetupErrorView[];
  /** 次に始められる日時（監査の開始が `AUTO_LOGIN_RATE_LIMITED` のときだけ。ISO 8601。T26e）。 */
  readonly nextAllowedAt: string | null;
  /** 認証の方式（T26e。自動ログインのプロファイルの案内に使う）。 */
  readonly auth: AuthStrategy;
  /** 自動ログインのプロファイルの開始の前の状態（自動ログインのプロファイルだけ。ほかは `null`。T26e）。 */
  readonly autoLogin: AuditAutoLoginSummaryView | null;
  /** ログインの確かめ（`LOGIN_CHECK`）を始められない理由（T26e。ログインの確かめの画面）。 */
  readonly loginCheck: AuditStartCheckView;
  /**
   * FM2d: まとめて実行（`stage-chain-policy.ts` の `chainStagesOfMode`。連鎖しないモードは `null`）。段の並びと、始められない理由（どの段の確かめも、ジョブの
   * 管理と同じ順。最初に当たった段の理由）。
   */
  readonly chain: AuditStageChainStartView | null;
}

/** FM2d: 開始の画面の、まとめて実行の欄の値。 */
export interface AuditStageChainStartView extends AuditStartCheckView {
  readonly stages: readonly WorkerChainStageKind[];
}

const ACTIVE_STATES: ReadonlySet<AuditJobState> = new Set(ACTIVE_AUDIT_JOB_STATES);


const rowOf = (job: AuditJobView): AuditJobRowView => ({
  jobId: job.jobId,
  jobKind: job.jobKind,
  profileId: job.profileId,
  profileRevision: job.profileRevision,
  state: job.state,
  startNew: job.startNew,
  runId: job.runId,
  runStatus: job.resultRunStatus,
  endKind: job.endKind,
  exitCode: job.exitCode,
  failureReason: job.failureReason,
  createdAt: isoTimestampOf(job.createdAt),
  startedAt: isoTimestampOrNull(job.startedAt),
  finishedAt: isoTimestampOrNull(job.finishedAt),
  stopRequestedAt: isoTimestampOrNull(job.stopRequestedAt),
});

/** 止める要求から、名前つきの時間を過ぎても止まっていないか（サーバの時計で決める）。 */
const isForceStopAvailable = (job: AuditJobView): boolean => {
  if (job.state !== STOPPING_AUDIT_JOB_STATE || job.stopRequestedAt === null) {
    return false;
  }
  const requestedAtMs = compactTimestampMs(job.stopRequestedAt);
  return requestedAtMs !== null && Date.now() - requestedAtMs >= AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS;
};

const detailOf = async (job: AuditJobView): Promise<AuditJobDetailView> => ({
  ...rowOf(job),
  lastProgress: job.lastProgress === null ? null : structuredClone(job.lastProgress),
  lastNotice: job.lastNotice === null ? null : structuredClone(job.lastNotice),
  active: ACTIVE_STATES.has(job.state),
  forceStopAvailable: isForceStopAvailable(job),
  forceStopOfferAfterMs: AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS,
  artifacts: [...(await listJobArtifacts(job))],
  lastAuthState: job.lastAuthState,
  sessionLostUrl: job.sessionLostUrl,
  sessionLoss: job.sessionLoss === null ? null : structuredClone(job.sessionLoss),
  autoLogin: job.autoLoginAttempt === null
    ? null
    : {
      result: job.autoLoginAttempt.result,
      submitted: job.autoLoginAttempt.submitted,
      retryAfterUntil: isoTimestampOrNull(job.autoLoginAttempt.retryAfterUntil),
      formInvalidReason: job.autoLoginAttempt.formInvalidReason,
    },
  // T31h-2: 登録と更新の書き込みのジョブ（`write-kinds.ts`）。
  write: isWriteJobKind(job.jobKind) ? await writeResultSummaryOfJob(job.jobId) : null,
  writeChain: writeChainOfCreateJob(job.jobId),
  stageChain: localUiAuditJobs().getStageChainOfJob(job.jobId),
  loginSetup: job.lastAuthState === null ? null : loginSetupViewOf(job.profileId),
  jobBrowserShown: readProfileDisplaySettings(localUiStore(), job.profileId).showJobBrowser,
  loginStage: job.loginStage === null ? null : structuredClone(job.loginStage),
  auditStage: await auditStageOf(job),
  safetyViolation: await safetyViolationOf(job),
  externalSchemeProbes: await externalSchemeProbesOfJob(job),
  pressLimitProbes: await pressLimitProbesOfJob(job),
  pageIncompleteReasons: await pageIncompleteReasonsOfJob(job),
  auditSend: await auditSendOf(job),
  currentProfile: currentProfileOf(job.profileId),
  entryCheck: await entryCheckResultOfJob(job),
  runEnd: await runEndOf(job),
  profileJobEnd: await profileJobEndOf(job),
  writePrecheckDetail: await writePrecheckDetailOf(job),
});

/** T44e（P2-4）: 書き込みのジョブの `action-run.json` の、送らずに止めた具体的な理由（`PRECHECK_FAILED` のときだけ。なければ `null`）。 */
const writePrecheckDetailOf = async (job: AuditJobView): Promise<PrecheckFailureDetail | null> => {
  if (!isWriteJobKind(job.jobKind) || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, 'action-run') as { readonly blockReason?: string | null; readonly precheckDetail?: PrecheckFailureDetail } | null;
  return document?.blockReason === 'PRECHECK_FAILED' ? document.precheckDetail ?? null : null;
};

/** T37a: 監査の段の数を持つ成果物の種類（ジョブの種類 → 成果物）。 */
const AUDIT_STAGE_DOCUMENTS: Readonly<Partial<Record<AuditJobKind, JobResultDocumentKind>>> = Object.freeze({
  DISCOVERY: 'discovery',
  READ_CHECK: 'read-evidence',
});
/**
 * T37a: 監査の段の数を出す、ジョブの状態（終わったジョブ。ジョブの管理が成果物を確かめた後）。PRE42-CC 組 3（N4-8b）: 値は owner の
 * `job-records.ts` の名前つきの定数から読む。
 */
const AUDIT_STAGE_JOB_STATE = FINISHED_AUDIT_JOB_STATE;

/**
 * T37a: 終わった発見と READ の確かめのジョブの、成果物の監査の段の数（なければ `null`）。成果物はスキーマとジョブの ID を確かめて読む（形はスキーマが
 * `run.json` の `authentication` と同じ閉じた形に限る）。項目を選んで写す。
 */
const auditStageOf = async (job: AuditJobView): Promise<RunAuthenticationSummary | null> => {
  const kind = AUDIT_STAGE_DOCUMENTS[job.jobKind];
  if (kind === undefined || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, kind) as { readonly authentication?: RunAuthenticationSummary } | null;
  const summary = document?.authentication;
  return summary === undefined
    ? null
    : {
      registeredReadRequestsAllowed: summary.registeredReadRequestsAllowed,
      tokenRefreshBlocked: summary.tokenRefreshBlocked,
      otherNonReadBlocked: summary.otherNonReadBlocked,
      serviceUnauthorizedResponses: summary.serviceUnauthorizedResponses,
      serviceRequestLimitReached: summary.serviceRequestLimitReached,
      // DEF-141: 1 分あたりの上限で待った回数と時間（前の版の成果物にはない）。
      ...(summary.serviceRequestPacingWaits === undefined ? {} : { serviceRequestPacingWaits: summary.serviceRequestPacingWaits }),
      ...(summary.serviceRequestPacingWaitMs === undefined ? {} : { serviceRequestPacingWaitMs: summary.serviceRequestPacingWaitMs }),
    };
};

/**
 * DEF-144: 終わった発見と READ の確かめのジョブの、成果物の安全の違反の中身（なければ `null`）。成果物はスキーマとジョブの ID を確かめて読む（形はスキーマが
 * `run.json` の `$defs/jobSafetyViolation` の閉じた形に限る）。写しを返す。
 */
const safetyViolationOf = async (job: AuditJobView): Promise<JobSafetyViolation | null> => {
  const kind = AUDIT_STAGE_DOCUMENTS[job.jobKind];
  if (kind === undefined || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, kind) as { readonly safetyViolation?: JobSafetyViolation } | null;
  const violation = document?.safetyViolation;
  return violation === undefined ? null : structuredClone(violation);
};

/** DEF-144: 終わった発見のジョブの、成果物の外部スキームで押さなかった数と読み込み直した画面の数（なければ `null`）。項目を選んで写す。 */
const externalSchemeProbesOfJob = async (job: AuditJobView): Promise<DiscoveryExternalSchemeProbes | null> => {
  if (job.jobKind !== WORKER_DISCOVERY_JOB_KIND || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, 'discovery') as { readonly externalSchemeProbes?: DiscoveryExternalSchemeProbes } | null;
  const counts = document?.externalSchemeProbes;
  return counts === undefined ? null : { notPressed: counts.notPressed, reloadedPages: counts.reloadedPages };
};

/** T44c: 終わった発見のジョブの、成果物の押す数の上限で押せなかった登録・更新の語の候補の数（なければ `null`）。項目を選んで写す。 */
/**
 * T44c: 終わった監査のジョブの、`run.json` のページの未完了の理由ごとのページ数（なければ `null`）。`run.json` はスキーマと Run の ID を確かめる読み出し
 * （`readJobResultDocument`）で読む。項目を選んで写す。
 */
const pageIncompleteReasonsOfJob = async (job: AuditJobView): Promise<readonly PageIncompleteReasonCount[] | null> => {
  if (job.jobKind !== WORKER_AUDIT_JOB_KIND || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const run = await readJobResultDocument(job, 'run') as { readonly pageIncompleteReasonCounts?: readonly PageIncompleteReasonCount[] } | null;
  const counts = run?.pageIncompleteReasonCounts;
  return counts === undefined ? null : counts.map(({ code, pages }) => ({ code, pages }));
};

const pressLimitProbesOfJob = async (job: AuditJobView): Promise<DiscoveryPressLimitProbes | null> => {
  if (job.jobKind !== WORKER_DISCOVERY_JOB_KIND || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, 'discovery') as { readonly pressLimitProbes?: DiscoveryPressLimitProbes } | null;
  const counts = document?.pressLimitProbes;
  return counts === undefined ? null : { priorityNotPressed: counts.priorityNotPressed };
};

/**
 * T44e（Task 44 の設計書 P2-7）: 監査のジョブの `run.json`（スキーマと Run の ID を確かめる読み出し `readJobResultDocument`）から、終わり方と理由を読む。
 * 監査でないジョブ、記録がない・読めないときは `null`。項目を選んで写す（理由の `detail` は写さない）。
 */
const runEndOf = async (job: AuditJobView): Promise<AuditJobRunEndView | null> => {
  if (job.jobKind !== WORKER_AUDIT_JOB_KIND) {
    return null;
  }
  const run = await readJobResultDocument(job, 'run') as {
    readonly executions?: readonly { readonly endReason: RunExecutionEndReason }[];
    readonly incompleteReasons?: readonly { readonly code: IncompleteReasonCode }[];
    readonly partialPageCount?: number;
    readonly failedPageCount?: number;
    readonly skippedPageCount?: number;
  } | null;
  if (run === null) {
    return null;
  }
  return {
    lastExecutionEndReason: lastRunExecutionOf(run.executions ?? [])?.endReason ?? null,
    reasons: [...new Set((run.incompleteReasons ?? []).map(({ code }) => code))],
    partialPageCount: run.partialPageCount ?? 0,
    failedPageCount: run.failedPageCount ?? 0,
    skippedPageCount: run.skippedPageCount ?? 0,
  };
};

/** T44e: 終わった発見と READ の確かめのジョブの、成果物の終わり方（なければ `null`）。 */
const profileJobEndOf = async (job: AuditJobView): Promise<AuditJobProfileJobEndView | null> => {
  const kind = AUDIT_STAGE_DOCUMENTS[job.jobKind];
  if (kind === undefined || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, kind) as { readonly endReason?: string } | null;
  if (document === null || document.endReason === undefined) {
    return null;
  }
  return job.jobKind === WORKER_DISCOVERY_JOB_KIND
    ? { kind: WORKER_DISCOVERY_JOB_KIND, endReason: document.endReason as DiscoveryEndReason }
    : { kind: WORKER_READ_CHECK_JOB_KIND, endReason: document.endReason as ReadCheckEndReason };
};

/** AS-b: ジョブの画面の、監査の段の送信の扱いと通した数（通した数を持たない記録は `null`）。 */
export interface AuditJobAuditSendView {
  readonly policy: AuditSendPolicyName;
  readonly passedRequests: number | null;
  /** AS-c: ほかの Origin へ通した数と、通した WebSocket の接続の数（監査だけ。持たない Run は 0。ほかの記録は `null`）。 */
  readonly passedOtherOriginRequests: number | null;
  readonly passedWebSockets: number | null;
  /**
   * AS-c fix round 1（C-1・C-2）: そのうち Guard の判定を通らずに開いた接続と、危険な語の接続の数（監査だけ。持たない Run は 0。ほかの記録は `null`）と、
   * その知らせを出すか（`hasAuditSendWebSocketCaution` の 1 か所で決める。ほかの記録は偽）。
   */
  readonly passedWebSocketsOutsideGuard: number | null;
  readonly passedDangerousWebSockets: number | null;
  readonly webSocketCaution: boolean;
}

/**
 * AS-b: ジョブの結果の記録から、監査の段の送信の扱いを読む（監査は `run.json`。Run の ID がこのジョブの Run の ID であることを確かめる。発見と READ の確かめは
 * 成果物。どれもスキーマを確かめる読み出し `readJobResultDocument`）。ほかの種類のジョブ、記録がない・読めないときは `null`。項目を選んで写す。
 */
const auditSendOf = async (job: AuditJobView): Promise<AuditJobAuditSendView | null> => {
  if (!WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY.includes(job.jobKind)) {
    return null;
  }
  if (job.jobKind === WORKER_AUDIT_JOB_KIND) {
    const run = await readJobResultDocument(job, 'run') as { readonly safety?: { readonly auditSend?: RunAuditSendSummary } } | null;
    if (run === null) {
      return null;
    }
    const auditSend = run.safety?.auditSend;
    return auditSend === undefined
      ? {
        policy: DEFAULT_AUDIT_SEND_POLICY,
        passedRequests: 0,
        passedOtherOriginRequests: 0,
        passedWebSockets: 0,
        passedWebSocketsOutsideGuard: 0,
        passedDangerousWebSockets: 0,
        webSocketCaution: false,
      }
      : {
        policy: auditSend.policy,
        passedRequests: auditSend.passedRequests,
        passedOtherOriginRequests: auditSend.passedOtherOriginRequests ?? 0,
        passedWebSockets: auditSend.passedWebSockets ?? 0,
        passedWebSocketsOutsideGuard: auditSend.passedWebSocketsOutsideGuard ?? 0,
        passedDangerousWebSockets: auditSend.passedDangerousWebSockets ?? 0,
        webSocketCaution: hasAuditSendWebSocketCaution(auditSend),
      };
  }
  const kind = AUDIT_STAGE_DOCUMENTS[job.jobKind];
  const document = kind === undefined ? null : await readJobResultDocument(job, kind) as { readonly auditSendPolicy?: AuditSendPolicyName } | null;
  return document === null
    ? null
    : {
      policy: document.auditSendPolicy ?? DEFAULT_AUDIT_SEND_POLICY,
      passedRequests: null,
      passedOtherOriginRequests: null,
      passedWebSockets: null,
      passedWebSocketsOutsideGuard: null,
      passedDangerousWebSockets: null,
      webSocketCaution: false,
    };
};

/** 今のプロファイルのモードと認証の方式（T43a。なければ `null`）。 */
const currentProfileOf = (profileId: string): AuditJobDetailView['currentProfile'] => {
  const stored = getProfile(localUiStore(), profileId);
  return stored === null ? null : { mode: stored.profile.mode, auth: stored.profile.auth };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface AuditJobStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly startNew: boolean;
}
interface AuditJobStopRequest {
  readonly jobId: string;
  readonly force: boolean;
}
interface AuditJobKeyRequest {
  readonly jobId: string;
}
interface ProfileKeyRequest {
  readonly profileId: string;
}
interface LoginCheckStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 実行履歴（新しい順）。 */
export const listAuditJobsFn = createServerFn({ method: 'GET' }).handler((): readonly AuditJobRowView[] =>
  localUiAuditJobs().listAuditJobs().map(rowOf));

/** 1 つのジョブの詳細と進み具合。なければ `null`。 */
export const getAuditJobFn = createServerFn({ method: 'GET' })
  .validator(requestOf<AuditJobKeyRequest>('ui-audit-job-key'))
  .handler(async ({ data }): Promise<AuditJobDetailView | null> => {
    const job = localUiAuditJobs().getAuditJob(data.jobId);
    return job === null ? null : detailOf(job);
  });

/** 監査を始める（開始の判断はジョブの管理が開始の直前に行う）。 */
export const startAuditJobFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuditJobStartRequest>('ui-audit-job-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    const result = await localUiAuditJobs().startAuditJob({
      profileId: data.profileId,
      expectedRevision: data.expectedRevision,
      startNew: data.startNew,
    });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });

/** ログインの確かめを始める（T26e。自動ログインのプロファイルだけ。開始の判断はジョブの管理が開始の直前に行う）。 */
export const startLoginCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<LoginCheckStartRequest>('ui-login-check-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    const result = await localUiAuditJobs().startLoginCheck({ profileId: data.profileId, expectedRevision: data.expectedRevision });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });

/** 監査を止める（`force` は、2 回目の強制の止め方）。 */
export const stopAuditJobFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuditJobStopRequest>('ui-audit-job-stop'))
  .handler(({ data }): AuditJobStopView => {
    const result = localUiAuditJobs().stopAuditJob(data.jobId, { force: data.force });
    return result.ok ? { ok: true, job: rowOf(result.job) } : { ok: false, reason: result.reason };
  });

/**
 * ML-b（手動のログインの設計書 2.2）: 「ログインを終えた」の結果。拒んだ理由は、ジョブの管理の口（`confirmManualLogin`。ML-a）の閉じた一覧の理由
 * （`AUDIT_JOB_LOGIN_CONFIRM_REJECTION_REASONS`。説明はカタログ `LOCAL_UI_MANUAL_LOGIN_TEXT.rejectionReasons`）。
 */
export type ManualLoginConfirmView = AuditJobLoginConfirmResult;

/**
 * ML-b: 「ログインを終えた」（手動のログインを待っているジョブだけ。POST だけ。CSRF は画面のサーバの middleware が確かめる）。入力の形はジョブの鍵の
 * スキーマ `ui-audit-job-key` で確かめ、ジョブの管理の口（`confirmManualLogin`）を呼ぶ。受け付けるかは、ジョブの管理が決める（`AWAITING_LOGIN` のときだけ。
 * ML-b-2）。
 */
export const confirmManualLoginFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuditJobKeyRequest>('ui-audit-job-key'))
  .handler(async ({ data }): Promise<ManualLoginConfirmView> => {
    const result = await localUiAuditJobs().confirmManualLogin(data.jobId);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });

/** 開始の画面の値（プロファイルと、ターゲット設定の要点。読むだけ）。プロファイルがなければ `null`。 */
export const auditStartSummaryFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<AuditStartSummaryView | null> => {
    // T27f: 読み方（プロファイル、ターゲット設定、認証の設定、自動ログインの開始の前の確かめの値）は `start-check-inputs.ts` と共用する（振る舞いは同じ）。
    const reading = await readProfileStart(data.profileId);
    if (reading === null) {
      return null;
    }
    const { stored, context, configError, storedSetup, checkInput } = reading;
    const { profile } = stored;
    const base = {
      profileId: profile.profileId,
      revision: profile.revision,
      mode: profile.mode,
      status: stored.status,
      targetConfigPath: profile.targetConfigPath,
    };
    const target: AuditTargetSummaryView | null = context === undefined
      ? null
      : {
        startUrl: context.targetConfig.site.startUrl,
        maxPages: context.targetConfig.crawl.maxPages,
        maxRuntimeMs: context.targetConfig.crawl.maxRuntimeMs,
        minNavigationIntervalMs: context.targetConfig.crawl.minNavigationIntervalMs,
      };
    // T25e: 認証の設定が要るモードでは、保存してある設定の新しさと、今のプロファイルとターゲット設定での検証の結果も見る（ジョブの管理と同じ順）。
    // T26e: 自動ログインのプロファイルは、ジョブの管理と同じ開始の前の確かめも行う（読むだけ）。
    const check = auditStartCheckOf(checkInput);
    const loginCheck = auditStartCheckOf({ ...checkInput, jobKind: WORKER_LOGIN_CHECK_JOB_KIND });
    return {
      ...base,
      target,
      blocker: check.blocker,
      errorCodes: check.errorCodes,
      configError,
      authRequired: check.authRequired,
      authSetup: storedSetup === null
        ? null
        : {
          loginStartUrl: storedSetup.setup.loginStartUrl,
          auditPathPrefixes: [...storedSetup.setup.auditPathPrefixes],
          freshness: storedSetup.freshness,
        },
      authSetupErrors: check.authSetupErrors,
      nextAllowedAt: check.nextAllowedAt,
      auth: profile.auth,
      autoLogin: reading.autoLoginSummary,
      loginCheck: {
        blocker: loginCheck.blocker,
        errorCodes: loginCheck.errorCodes,
        authSetupErrors: loginCheck.authSetupErrors,
        nextAllowedAt: loginCheck.nextAllowedAt,
      },
      chain: stageChainStartOf(profile.mode, checkInput),
    };
  });

/**
 * FM2d: まとめて実行の欄の値（連鎖しないモードは `null`）。どの段も、ジョブの管理と同じ開始の確かめ（`auditStartCheckOf`）を段の種類で行い、最初に当たった
 * 理由を出す（読むだけ。判断はジョブの管理が開始の直前に行う）。
 */
const stageChainStartOf = (mode: AuditMode, checkInput: Parameters<typeof auditStartCheckOf>[0]): AuditStageChainStartView | null => {
  const stages = chainStagesOfMode(mode);
  if (stages === null) {
    return null;
  }
  // FM2R の I-1: 連鎖の READ の段は、定義の件数を確かめない（0 件は「行わなかった」）。
  const checks = stages.map((jobKind) => auditStartCheckOf({ ...checkInput, jobKind, readCheckDefinitionsRequired: false }));
  const blocked = checks.find((check) => check.blocker !== null) ?? checks[0];
  return {
    stages: [...stages],
    blocker: blocked?.blocker ?? null,
    errorCodes: blocked?.errorCodes ?? [],
    authSetupErrors: blocked?.authSetupErrors ?? [],
    nextAllowedAt: blocked?.nextAllowedAt ?? null,
  };
};

/**
 * FM2d: まとめて実行を始める（開始の判断はジョブの管理が開始の直前に行う。入力は監査の開始と同じ形）。返すジョブは最初の段のもの（ジョブの詳細に連鎖の欄が
 * 出る）。
 */
export const startStageChainFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuditJobStartRequest>('ui-audit-job-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    const result = await localUiAuditJobs().startStageChain({
      profileId: data.profileId,
      expectedRevision: data.expectedRevision,
      startNew: data.startNew,
    });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
