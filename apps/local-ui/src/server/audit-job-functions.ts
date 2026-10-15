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
import type { AutomatedLoginResult, AutomatedLoginSubmission } from '../../../../src/control/auth/automated-login-results.js';
import type { AuditMode, AuthStrategy, ProfileValidationErrorCode } from '../../../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FORCE_STOP_OFFER_AFTER_MS,
  type AuditJobFailureReason,
  type AuditJobKind,
  type AuditJobStartRejectionReason,
  type AuditJobState,
  type AuditJobStopRejectionReason,
} from '../../../../src/control/job/job-records.js';
import type { AuditJobView } from '../../../../src/control/job/job-store.js';
import type { AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import type {
  WorkerAuthState,
  WorkerLoginFormInvalidReason,
  WorkerOutcomeKind,
  WorkerRunNotice,
} from '../../../../src/control/worker-protocol.js';
import type { RunProgressReport, RunStatus } from '../../../../src/core/contracts.js';
import { listJobArtifacts, type JobArtifactView } from './artifact-files';
import type { AuthSetupErrorView } from './auth-setup-errors';
import { auditStartCheckOf, startRejectionViewOf, type AuditStartBlocker } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { requestOf } from './request-validation';
import { readProfileStart, type AuditAutoLoginSummaryView } from './start-check-inputs';
import { compactTimestampMs, isoTimestampOf, isoTimestampOrNull } from './timestamps';
import { isWriteJobKind } from './write-kinds';
import { writeResultSummaryOfJob, type WriteResultSummaryView } from './write-results';

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
  /** 自動ログインの試しの結果（自動ログインのジョブだけ。ほかは `null`。値を含まない。T26e）。 */
  readonly autoLogin: AuditJobAutoLoginView | null;
  /** 書き込みの結果（T30g。書き込みのジョブで、記録があるときだけ。ほかは `null`）。 */
  readonly write: WriteResultSummaryView | null;
}

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
  if (job.state !== 'STOPPING' || job.stopRequestedAt === null) {
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
});

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
    const loginCheck = auditStartCheckOf({ ...checkInput, jobKind: 'LOGIN_CHECK' });
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
    };
  });
