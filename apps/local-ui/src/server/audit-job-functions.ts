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
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { PrecheckFailureDetail } from '../../../../src/control/actions/action-contracts.js';
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
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、名前つきの定数から読む（画面のサーバに同じ定数を置かない）。PL-2: ジョブの種類と状態の値は、
// 管理データと Node の部品に触れない純粋な owner（`src/core/audit-job-values.ts`。`job-records.ts`・`worker-protocol.ts` はここを公開し直す）から読む
// （要点を決める関数は、画面のブラウザ側の束にも残る。`job-records.ts` を読むと、資格情報の部品の束がブラウザ側に入り、読み込みで誤りになる）。
import {
  FAILED_AUDIT_JOB_STATE,
  FINISHED_AUDIT_JOB_STATE,
  // PRE42-CC 組 UI-K（組 3 の発見）: 止める要求を送ったジョブの状態は、owner の名前つきの定数から読む（文字列で比べない）。
  STOPPING_AUDIT_JOB_STATE,
  WORKER_AUDIT_JOB_KIND,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
} from '../../../../src/core/audit-job-values.js';
import type { AuditJobLoginConfirmResult, EntryCheckFollowUp } from '../../../../src/control/job/audit-job-manager.js';
import { chainStagesOfMode, type StageChainView } from '../../../../src/control/job/stage-chain-policy.js';
import { FINISHED_CHAIN_STATE, RUNNING_CHAIN_STAGE_STATE, RUNNING_CHAIN_STATE } from '../../../../src/core/stage-chain-states.js';
import { WORKER_AWAITING_LOGIN_STATE } from '../../../../src/core/worker-auth-states.js';
import { loginStageRegistrationOf } from '../../../../src/control/login-observation-draft.js';
import { awaitsAutoRegistration } from '../display/job-polling';
import type { JobSummaryChainStage } from '../display/job-summary-values';
import { inspectionWriteOutcomeOf, type InspectionWriteOutcome } from '../display/write-screen-values';
import type { WorkerChainStageKind } from '../../../../src/control/worker-protocol.js';
import type { AuditJobLoginStageSummary, AuditJobView } from '../../../../src/control/job/job-store.js';
import { isAutomatedLoginSource, loginStageRowSourceOf } from '../../../../src/control/manual-login-registration.js';
import type { AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
import { getProfile, readProfileDisplaySettings } from '../../../../src/control/store/profile-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import {
  WORKER_JOB_KINDS_WITH_AUDIT_SEND_POLICY,
  type WorkerAuthState,
  type WorkerLoginFormInvalidReason,
  type WorkerOutcomeKind,
  type WorkerRunNotice,
  type WorkerWriteJobKind,
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
import { entryCheckAuthSetupStateOf, entryCheckResultOfJob, type EntryCheckResultView } from './entry-check-functions';
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
import { requestOf } from './request-validation';
import { readProfileStart, type AuditAutoLoginSummaryView } from './start-check-inputs';
import { approvedScenarioCountOf } from './scenario-facts';
import { compactTimestampMs, isoTimestampOf, isoTimestampOrNull } from './timestamps';
import { isWriteJobKind } from './write-kinds';
import { writeResultSummaryOfJob, type WriteResultSummaryView } from './write-results';
import { writeChainOfCreateJob, type WriteChainView } from './write-chain';
import { redraftCheckedScreensOnChainStart } from './write-screen-functions';
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
   * OP-G2（OP-G の指示書の 6）: まとめて実行の連鎖が動いている間の、動いている書き込みの段の作業の種類（最後に始めた書き込みの段の作業が動いているときだけ。
   * ほかは `null`）。点検の画面の要点の 1 行目（`summary.chainStage`）に使う。
   */
  readonly stageChainWriteKind: WorkerWriteJobKind | null;
  /**
   * OP-G（指示書の 3。完了の正直さ）: 点検（まとめて実行）の要点の書き込みの 1 行の種類（実際に行った書き込みの段と、その結果から決める。決め方は
   * `display/write-screen-values.ts` の `inspectionWriteOutcomeOf`）。まとめて実行でない作業と、書き込みと関係のない点検は `null`。
   */
  readonly inspectionWrite: InspectionWriteOutcome | null;
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
   * 記録は `READ_ONLY`。数だけで、URL・値を持たない。OP-U から、作業の画面には出さず、自動の移り先にも使わない（通した数は成果物と報告に残す）。
   */
  readonly auditSend: AuditJobAuditSendView | null;
  /**
   * 今のプロファイルのモードと認証の方式（T43a。ログインの確かめの成功の後の次の手順のリンクを選ぶ。判定は `display/next-steps.ts` の
   * `nextStepAfter`）。プロファイルがなければ `null`。
   */
  readonly currentProfile: { readonly mode: AuditMode; readonly auth: AuthStrategy } | null;
  /**
   * MI-C 項目 12（安全）: このジョブのログインの段の行が、自動ログインの文脈か（判定は MI-G の `isAutomatedLoginSource` の 1 か所。自動ログインの試しのある
   * ジョブ、ログインの確かめのジョブ、自動ログインのプロファイル。プロファイルがなければ真）。真なら、画面は行に認証の設定の画面を下書きつきで開くリンクを
   * 出さない（表の行の「登録する」の拒否と同じ文脈）。
   */
  readonly automatedLoginContext: boolean;
  /**
   * 入口の確かめの結果（T43c。Task 43 の設計書 4.3。終わった（`FINISHED`）入口の確かめのジョブで、成果物 `entry-check.json` を読めたときだけ。ほかは
   * `null`）。読んだ事実と案だけで、欄の値は持たない（成果物にもない）。
   */
  readonly entryCheck: EntryCheckResultView | null;
  /**
   * MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後の、プロファイルの認証の設定の状態（終わった入口の確かめの
   * ジョブだけ。ほかは `null`。求め方は `entry-check-functions.ts` の `entryCheckAuthSetupStateOf` の 1 か所）。
   */
  readonly entryCheckAuthSetup: EntryCheckAuthSetupState | null;
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
  /**
   * PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、13 章の 13。PL-2 の持ち越し）: 終わった（`FINISHED`）監査のジョブの、報告を作る時に書いた
   * 小さなまとめ（`report-summary.json`。スキーマと Run の ID を確かめる読み出し `readJobResultDocument`）の件数。読めないとき・ほかのジョブは `null`。
   * 大きな `audit.json` は読まない。数だけ。
   */
  readonly reportSummary: AuditJobReportSummaryView | null;
  /**
   * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3、4.1.3 の 4）: 手でのログインを待つ間、BeakSight がログインの終わりを判定できるか（ジョブの
   * 管理のメモリの中。知らせを受けていなければ `null`）。判定できるときは「ログインを終えた」を出さない。
   */
  readonly loginEndDetection: boolean | null;
  /** OP-1（D11、4.1.3 の 3）: 印つきの下調べの、続けて始める点検の状態（ジョブの管理のメモリの中。印のない下調べと、ほかの作業は `null`）。 */
  readonly entryCheckFollowUp: EntryCheckFollowUp | null;
  /**
   * PL-2（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、13 章の 11・13）: 作業の画面の要点（結果の 1 行の種類、主のボタン、
   * 成功のときに自動で移す先、待つ間の見積もり、ログインの段の登録の状態）。判定はこのファイルの `jobSummaryOf` の 1 か所で、画面は描くだけ。
   */
  readonly summary: AuditJobSummaryView;
}

/**
 * PL-2: 作業の画面の要点の、結果の 1 行の種類（閉じた一覧。並びは判定の順ではない）。文言はカタログ `LOCAL_UI_JOB_SUMMARY_TEXT`（動いている間は `active`、
 * 終わった後は `finished`。止めている間は種類ごとの `AUDIT_JOB_STOP_REQUESTED_TEXTS`）。書き漏れと余分は `display/catalog-coverage.ts` で確かめる。
 */
export const JOB_SUMMARY_ACTIVE_RESULTS = Object.freeze(['STARTING', 'RUNNING', 'AWAITING_LOGIN', 'STOPPING'] as const);
export type JobSummaryActiveResult = (typeof JOB_SUMMARY_ACTIVE_RESULTS)[number];
export const JOB_SUMMARY_FINISHED_RESULTS = Object.freeze([
  'AUDIT_COMPLETE',
  'AUDIT_PARTIAL',
  'ENTRY_CHECK_LOGIN_PAGE',
  'ENTRY_CHECK_READ',
  'ENTRY_CHECK_NEEDS_SETUP',
  'ENTRY_CHECK_NOT_READ',
  'LOGIN_CHECK_SUCCEEDED',
  'DISCOVERY_FINISHED',
  'READ_CHECK_FINISHED',
  'WRITE_VERIFIED',
  'WRITE_PARTIAL',
  'WRITE_UNKNOWN',
  'WRITE_NOT_SENT',
  'WRITE_PENDING',
  'SAFETY_VIOLATION',
  'SESSION_LOST',
  'FAILED',
  'INTERRUPTED',
] as const);
export type JobSummaryFinishedResult = (typeof JOB_SUMMARY_FINISHED_RESULTS)[number];
export type JobSummaryResult = JobSummaryActiveResult | JobSummaryFinishedResult;

/**
 * PL-2: 要点の主のボタン（閉じた一覧。1 つの画面に 1 つまで。押せないときは出さない）。`CONFIRM_LOGIN`: 手でのログインの「ログインを終えた」。`OPEN_REPORT`:
 * 点検の HTML の報告（結果を見る）。`OPEN_WRITE_REPORT`: 書き込みの報告（結果を見る）。`START_AUDIT`: 入口の確かめの後の「点検を始める」。`OPEN_DISCOVERY`・
 * `OPEN_READ_CHECKS`: 操作さがし・見るだけの確かめの結果の画面。
 */
export const JOB_SUMMARY_PRIMARY_ACTIONS = Object.freeze([
  'CONFIRM_LOGIN',
  'OPEN_REPORT',
  'OPEN_WRITE_REPORT',
  'START_AUDIT',
  'OPEN_DISCOVERY',
  'OPEN_READ_CHECKS',
] as const);
export type JobSummaryPrimaryAction = (typeof JOB_SUMMARY_PRIMARY_ACTIONS)[number];

/**
 * PL-2（3 章の 5）: 作業が成功で終わったときに、自動で移す先。`SITE`: サイトの詳細。`SCENARIO`: 書き込みの手順の詳細。`JOB`: 続けて始まった作業（下調べの後に
 * 始めた点検、登録の後に続けて始めた更新）の画面（OP-G2: まとめて実行の次のステップへは移さない）。失敗・安全の違反・結果が分からない・送信を通した点検のときは `null`（移さない）。
 */
export type JobSummaryAdvance =
  | { readonly kind: 'SITE' }
  | { readonly kind: 'SCENARIO'; readonly scenarioId: string }
  | { readonly kind: 'JOB'; readonly jobId: string };

/**
 * PL-2（13 章の 11）: 点検を待つ間の進み具合と、終わるまでの上限の見積もり（`auditRemainingUpperBoundMs`）。点検の作業が動いている間で、上限を読めたときだけ。
 */
export interface JobProgressEstimateView {
  readonly pagesFinished: number;
  readonly maxPages: number;
  readonly remainingUpperBoundMs: number;
}

/**
 * PL-2（4 章の 2）: ログインの段の行の登録の状態。`DONE`: 自動の登録が済んだ（または足すものがない）ので、行の「登録する」と下書きのリンクと案の取り込みを
 * 出さない。`NEEDED`: 登録できる行が残り、人が行を選んで登録する（画面は詳しい内容を開いて出す）。`NONE`: 登録できる行がない、または自動の登録を待っている。
 */
export type JobLoginStageRegistrationState = 'DONE' | 'NEEDED' | 'NONE';

/** PL-2: 作業の画面の要点。 */
export interface AuditJobSummaryView {
  readonly result: JobSummaryResult;
  readonly primary: JobSummaryPrimaryAction | null;
  readonly advance: JobSummaryAdvance | null;
  readonly estimate: JobProgressEstimateView | null;
  readonly loginStageRegistration: JobLoginStageRegistrationState;
  /** 確かめきれなかった所がある（押す数の上限、サイトへの要求の上限、読みきれなかったページ）。要点に 1 行を出す。 */
  readonly incomplete: boolean;
  /**
   * PL-R（設計書 14 章、13 章の 13）: 点検が最後まで終わった（結果が `AUDIT_COMPLETE`）ときの、問題の数（報告の小さなまとめの `problemCount`。サイトの問題の数で、
   * 安全の記録は入れない）。途中で終わった点検、まとめがない・読めないとき、ほかの作業は `null`（結果の 1 行は今の文のまま）。
   */
  readonly problemCount: number | null;
  /**
   * 終わった作業の後に、手でのログインからの自動の登録の結果を待っている（`awaitsAutoRegistration`。管理データの日時で決める）。画面は、この間も読み直す
   * （書かれたら、移す先が決まる）。
   */
  readonly awaitingRegistration: boolean;
  /**
   * OP-G2（OP-G の指示書の 6）: まとめて実行の連鎖が動いている間に、見ている作業（終えた段の作業）の画面にとどまって出す、今の段（`JOB_SUMMARY_CHAIN_STAGES`）。
   * 見ている作業が動いている間と、連鎖のない作業・連鎖が終わった後は `null`。
   */
  readonly chainStage: JobSummaryChainStage | null;
}

// OP-G2 の今の段の閉じた一覧（`JOB_SUMMARY_CHAIN_STAGES`）は、ブラウザ側からも読める `display/job-summary-values.ts` に移した（OP-H。DEF-066 の境界）。

/** PL-R: 監査のジョブの、報告の小さなまとめの件数（`report-summary.json` から選んで写す）。 */
export interface AuditJobReportSummaryView {
  readonly problemCount: number;
  readonly notFullyCheckedPageCount: number;
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
  /**
   * MI-3 の C: 読まないパス（開始の画面の欄の初めの値）。MI-F3（MI-R の Minor 5）: 変えたときは、読まないパスだけを、読まないパスの保存の Server Function
   * （`saveExcludedPathsFn`。サーバが今保存してある設定の読まないパスだけを替える）へ送る（設定の文書の全体を画面に渡さない）。
   */
  readonly excludedPaths: readonly string[];
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
   * この開始に認証の設定が要るか（T25e。開始の画面に、ログインの案内を出す。T28b: `execution-policy.ts` の `operationRequiresAuthSetup`。MI-5 から、
   * 書き込みのモードでも、認証つきの読み取りの監査と同じく真）。
   */
  readonly authRequired: boolean;
  /**
   * MI-C 項目 9: 今承認が有効なシナリオの数（読まないパスを変えると認証の設定の digest が変わり、承認が外れる。開始の画面の欄の説明に出す。求め方は
   * 「書き込みにも使う」・FM2e と同じ部品 `approvedScenarioCountOf`）。
   */
  readonly approvedScenarioCount: number;
  /**
   * OP-G（指示書の 5）: この点検で、チェックした画面の登録・更新も行うか（チェックした画面が 1 つ以上ある書き込みのモードのサイト。数え方はジョブの管理の
   * `checkedWriteScreenCountOf`。連鎖の書き込みの段の対象と同じ 1 か所）。真なら、開始の画面は「チェックした画面では登録・更新します」の文を出す。
   */
  readonly writesOnCheckedScreens: boolean;
  /** OP-G（設計書 4.1.4 の E3）: 表示の設定で、作業中のブラウザを画面に出すか（自動ログインの案内の文を、これに合わせる）。 */
  readonly jobBrowserShown: boolean;
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
  /**
   * FM2d: まとめて実行（`stage-chain-policy.ts` の `chainStagesOfMode`。連鎖しないモードは `null`）。段の並びと、始められない理由（どの段の確かめも、ジョブの
   * 管理と同じ順。最初に当たった段の理由）。
   */
  readonly chain: AuditStageChainStartView | null;
  /**
   * PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3、3 章の 1）: 開始の画面の主のボタン「点検を始める」が始めるものと、その始められない理由
   * （決めるのはここの 1 か所。画面は描くだけ）。まとめて実行のできるモードは、まとめて実行（点検 → 操作さがし → 見るだけの確かめ。並びは `chainStagesOfMode`）。
   * 公開の画面だけのサイトは、まとめて実行の段がないので点検だけ。
   */
  readonly primaryStart: AuditPrimaryStartView;
  /**
   * PL-3（4 章の 4）: 始め方（前回の続きから・新しく）を選ばせるか。このサイトの最後の点検（監査のジョブ。まとめて実行の最初の段を含む）が、最後まで終わら
   * なかったとき（終わり方の記録が読めない、または最後の実行が `COMPLETED` でない）だけ真（続きを選べる見込みがある。続きから再開できるかの判定は、今どおり
   * ワーカーが開始の時に行う）。画面は、真のときだけ選択を詳しい内容に出す（既定は続きから）。
   */
  readonly resumeChoiceOffered: boolean;
}

/** FM2d: 開始の画面の、まとめて実行の欄の値。 */
export interface AuditStageChainStartView extends AuditStartCheckView {
  readonly stages: readonly WorkerChainStageKind[];
}

/** PL-3: 開始の画面の主のボタンが始めるものの閉じた一覧（まとめて実行か、点検だけか）。 */
export const AUDIT_PRIMARY_START_KINDS = Object.freeze(['STAGE_CHAIN', 'AUDIT_ONLY'] as const);
export type AuditPrimaryStartKind = (typeof AUDIT_PRIMARY_START_KINDS)[number];

/** PL-3: 開始の画面の主のボタンが始めるものと、その始められない理由。 */
export interface AuditPrimaryStartView extends AuditStartCheckView {
  readonly kind: AuditPrimaryStartKind;
}

/** PL-3: 最後まで終えた実行の終わり方（これで終わった点検には、続きがない）。 */
const COMPLETED_RUN_EXECUTION_END_REASON = 'COMPLETED' satisfies RunExecutionEndReason;

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

const detailOf = async (job: AuditJobView): Promise<AuditJobDetailView> => {
  const detail = await detailWithoutSummaryOf(job);
  // 自動の登録を待つかは、管理データの日時（UTC の 14 桁）を読んだ時刻で決める（PL-3: 判定は時刻の値を受ける。画面に返す ISO 8601 の文字列では決めない）。
  const finishedAtMs = job.finishedAt === null ? null : compactTimestampMs(job.finishedAt);
  const awaitingRegistration = awaitsAutoRegistration({ active: detail.active, loginStage: detail.loginStage, finishedAtMs }, Date.now());
  return { ...detail, summary: jobSummaryOf(detail, { estimateLimits: await estimateLimitsOf(detail), awaitingRegistration }) };
};

/** OP-G（指示書の 3）: 点検の要点の書き込みの 1 行の種類（行った書き込みの段の、締めた結果から）。 */
const inspectionWriteOf = async (chain: StageChainView | null): Promise<InspectionWriteOutcome | null> => (chain === null ? null : inspectionWriteOutcomeOf({
  stopReason: chain.stopReason,
  writes: await Promise.all(chain.writeStageJobIds.map(async (jobId) => {
    const write = await writeResultSummaryOfJob(jobId);
    return { kind: write?.writeKind ?? null, result: write?.result ?? null };
  })),
}));

/**
 * OP-G2: 動いている連鎖の、最後に始めた書き込みの段の作業が動いていれば、その種類（書き込みの段は行った順に並ぶ。動いていなければ `null`）。
 */
const runningWriteStageKindOf = (chain: StageChainView | null): WorkerWriteJobKind | null => {
  const lastWriteJobId = chain === null || chain.state !== RUNNING_CHAIN_STATE ? undefined : chain.writeStageJobIds.at(-1);
  const writeJob = lastWriteJobId === undefined ? null : localUiAuditJobs().getAuditJob(lastWriteJobId);
  return writeJob !== null && ACTIVE_STATES.has(writeJob.state) && isWriteJobKind(writeJob.jobKind) ? writeJob.jobKind : null;
};

const detailWithoutSummaryOf = async (job: AuditJobView): Promise<Omit<AuditJobDetailView, 'summary'>> => ({
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
  stageChainWriteKind: runningWriteStageKindOf(localUiAuditJobs().getStageChainOfJob(job.jobId)),
  inspectionWrite: await inspectionWriteOf(localUiAuditJobs().getStageChainOfJob(job.jobId)),
  loginEndDetection: localUiAuditJobs().loginEndDetectionOf(job.jobId),
  entryCheckFollowUp: localUiAuditJobs().entryCheckFollowUpOf(job.jobId),
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
  automatedLoginContext: automatedLoginContextOf(job),
  entryCheck: await entryCheckResultOfJob(job),
  entryCheckAuthSetup: await entryCheckAuthSetupOfJob(job),
  runEnd: await runEndOf(job),
  profileJobEnd: await profileJobEndOf(job),
  writePrecheckDetail: await writePrecheckDetailOf(job),
  reportSummary: await reportSummaryOfJob(job),
});

/** MI-3: 終わった入口の確かめのジョブの、認証の設定の状態（ほかのジョブは `null`。成果物を読めなければ、結果なしとして求める）。 */
const entryCheckAuthSetupOfJob = async (job: AuditJobView): Promise<EntryCheckAuthSetupState | null> =>
  (job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && job.state === FINISHED_AUDIT_JOB_STATE
    ? entryCheckAuthSetupStateOf(job.profileId, await entryCheckResultOfJob(job))
    : null);

/** T44e（P2-4）: 書き込みのジョブの `action-run.json` の、送らずに止めた具体的な理由（`PRECHECK_FAILED` のときだけ。なければ `null`）。 */
const writePrecheckDetailOf = async (job: AuditJobView): Promise<PrecheckFailureDetail | null> => {
  if (!isWriteJobKind(job.jobKind) || job.state !== AUDIT_STAGE_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, 'action-run') as { readonly blockReason?: string | null; readonly precheckDetail?: PrecheckFailureDetail } | null;
  return document?.blockReason === 'PRECHECK_FAILED' ? document.precheckDetail ?? null : null;
};

/**
 * PL-R: 終わった監査のジョブの、報告の小さなまとめ（`report-summary.json`）の件数（なければ `null`）。スキーマと Run の ID を確かめる読み出しで読み、項目を選んで写す。
 */
const reportSummaryOfJob = async (job: AuditJobView): Promise<AuditJobReportSummaryView | null> => {
  if (job.jobKind !== WORKER_AUDIT_JOB_KIND || job.state !== FINISHED_AUDIT_JOB_STATE) {
    return null;
  }
  // 形はスキーマ（`schemas/report-summary.schema.json`）が確かめる（画面のコードは `src/report/` を読まない。`local-ui-boundary.test.ts` の (f)）。
  const document = await readJobResultDocument(job, 'report-summary') as { readonly problemCount: number; readonly notFullyCheckedPageCount: number } | null;
  return document === null ? null : { problemCount: document.problemCount, notFullyCheckedPageCount: document.notFullyCheckedPageCount };
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

/** MI-C 項目 12: ジョブの行が自動ログインの文脈か（MI-G と同じ判定。プロファイルがなければ、下書きを開いても保存できないので、真にして出さない）。 */
const automatedLoginContextOf = (job: AuditJobView): boolean => {
  const profile = currentProfileOf(job.profileId);
  return profile === null || isAutomatedLoginSource(loginStageRowSourceOf(job, profile.auth));
};

/** 今のプロファイルのモードと認証の方式（T43a。なければ `null`）。 */
const currentProfileOf = (profileId: string): AuditJobDetailView['currentProfile'] => {
  const stored = getProfile(localUiStore(), profileId);
  return stored === null ? null : { mode: stored.profile.mode, auth: stored.profile.auth };
};

// ---------------------------------------------------------------------------------------------------------------
// PL-2: 作業の画面の要点（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5、4 章の 2、13 章の 11・13）
// ---------------------------------------------------------------------------------------------------------------

/** 要点を求めるのに使う、ジョブの詳細（要点のほか）。 */
type JobDetailFacts = Omit<AuditJobDetailView, 'summary'>;

/** 点検が終わるまでの見積もりに使う上限（ターゲット設定の `crawl` の値）。 */
interface EstimateLimits {
  readonly maxPages: number;
  readonly maxRuntimeMs: number;
  readonly minNavigationIntervalMs: number;
}

/**
 * PL-2（13 章の 11）: 点検が終わるまでの、長くてもの見積もり（ms。0 以上）。残りのページの数（ページの上限 − 読み終えたページ）× ページの読み込みの間隔と、
 * 時間の上限の残り（時間の上限 − 経過）の、小さい方。求め方はここだけ（画面は分に直して描くだけ）。サーバだけの関数。
 */
export const auditRemainingUpperBoundMs = createServerOnlyFn((input: Readonly<{
  pagesFinished: number;
  maxPages: number;
  elapsedMs: number;
  minNavigationIntervalMs: number;
  maxRuntimeMs: number;
}>): number => Math.max(0, Math.min(
  Math.max(0, input.maxPages - input.pagesFinished) * input.minNavigationIntervalMs,
  input.maxRuntimeMs - input.elapsedMs,
)));

/** 点検の作業が動いている間だけ、プロファイルのターゲット設定から見積もりの上限を読む（読めなければ `null`。例外を投げない）。 */
const estimateLimitsOf = async (detail: JobDetailFacts): Promise<EstimateLimits | null> => {
  if (!detail.active || detail.jobKind !== WORKER_AUDIT_JOB_KIND) {
    return null;
  }
  try {
    const crawl = (await readProfileStart(detail.profileId))?.context?.targetConfig.crawl;
    return crawl === undefined
      ? null
      : { maxPages: crawl.maxPages, maxRuntimeMs: crawl.maxRuntimeMs, minNavigationIntervalMs: crawl.minNavigationIntervalMs };
  } catch {
    return null;
  }
};

/** 見積もり（減速の知らせがあれば、広げた間隔で求める）。 */
const progressEstimateOf = (detail: JobDetailFacts, limits: EstimateLimits | null): JobProgressEstimateView | null => {
  if (limits === null) {
    return null;
  }
  const progress = detail.lastProgress;
  const slowedIntervalMs = detail.lastNotice?.kind === 'SITE_UNAVAILABLE_SLOWDOWN' ? detail.lastNotice.minIntervalMs : 0;
  const pagesFinished = progress?.pagesFinished ?? 0;
  const maxPages = progress?.maxPages ?? limits.maxPages;
  return {
    pagesFinished,
    maxPages,
    remainingUpperBoundMs: auditRemainingUpperBoundMs({
      pagesFinished,
      maxPages,
      elapsedMs: progress?.elapsedMs ?? 0,
      minNavigationIntervalMs: Math.max(limits.minNavigationIntervalMs, slowedIntervalMs),
      maxRuntimeMs: limits.maxRuntimeMs,
    }),
  };
};

/** 書き込みのジョブの結果の 1 行の種類。 */
const writeResultOf = (write: WriteResultSummaryView | null): JobSummaryFinishedResult => {
  switch (write?.result ?? null) {
    case null:
      return 'WRITE_PENDING';
    case 'VERIFIED':
      return 'WRITE_VERIFIED';
    case 'PARTIAL':
      return 'WRITE_PARTIAL';
    case 'UNKNOWN':
      return 'WRITE_UNKNOWN';
    default:
      return 'WRITE_NOT_SENT';
  }
};

/** 入口の確かめのジョブの結果の 1 行の種類（読めて、認証の設定が要らないかそろったときだけ、確かめが済んだ）。 */
const entryCheckResultKindOf = (detail: JobDetailFacts): JobSummaryFinishedResult => {
  if (detail.entryCheck === null || detail.entryCheck.endReason !== 'READ') {
    return 'ENTRY_CHECK_NOT_READ';
  }
  if (detail.entryCheckAuthSetup !== null && detail.entryCheckAuthSetup !== 'NOT_USED' && detail.entryCheckAuthSetup !== 'PRESENT') {
    return 'ENTRY_CHECK_NEEDS_SETUP';
  }
  return detail.entryCheck.facts?.loginPage === true ? 'ENTRY_CHECK_LOGIN_PAGE' : 'ENTRY_CHECK_READ';
};

/** 結果の 1 行の種類（判定の順: 動いている → 安全の違反 → ログインの切れ → 書き込みの結果の記録 → 失敗・中断 → 種類ごとの結果）。 */
const jobSummaryResultOf = (detail: JobDetailFacts): JobSummaryResult => {
  if (detail.active) {
    if (detail.state === STOPPING_AUDIT_JOB_STATE) {
      return 'STOPPING';
    }
    if (detail.lastAuthState === WORKER_AWAITING_LOGIN_STATE) {
      return 'AWAITING_LOGIN';
    }
    return detail.state === 'STARTING' ? 'STARTING' : 'RUNNING';
  }
  if (detail.safetyViolation !== null || detail.runStatus === 'ABORTED_BY_SAFETY') {
    return 'SAFETY_VIOLATION';
  }
  if (detail.sessionLostUrl !== null) {
    return 'SESSION_LOST';
  }
  // 書き込みの結果の記録があれば、作業の終わり方（失敗・中断）より先に、その結果を出す（7 章: 送ったかどうか分からないことを必ず出す）。
  if (isWriteJobKind(detail.jobKind) && detail.write !== null && detail.write.result !== null) {
    return writeResultOf(detail.write);
  }
  if (detail.state === FAILED_AUDIT_JOB_STATE) {
    return 'FAILED';
  }
  if (detail.state !== FINISHED_AUDIT_JOB_STATE) {
    return 'INTERRUPTED';
  }
  if (isWriteJobKind(detail.jobKind)) {
    return writeResultOf(detail.write);
  }
  switch (detail.jobKind) {
    case WORKER_ENTRY_CHECK_JOB_KIND:
      return entryCheckResultKindOf(detail);
    case WORKER_LOGIN_CHECK_JOB_KIND:
      return detail.autoLogin?.result === 'SUCCEEDED' ? 'LOGIN_CHECK_SUCCEEDED' : 'FAILED';
    case WORKER_DISCOVERY_JOB_KIND:
      return 'DISCOVERY_FINISHED';
    case WORKER_READ_CHECK_JOB_KIND:
      return 'READ_CHECK_FINISHED';
    default:
      return detail.runStatus === 'COMPLETE' ? 'AUDIT_COMPLETE' : 'AUDIT_PARTIAL';
  }
};

/** 主のボタン（1 つまで。押す先がないときは出さない）。 */
const primaryActionOf = (detail: JobDetailFacts, result: JobSummaryResult): JobSummaryPrimaryAction | null => {
  // OP-1（4.1.3 の 4）: BeakSight がログインの終わりを判定できるときは、「ログインを終えた」を出さない（判定できないときだけ、今あるボタンを残す）。
  if (result === 'AWAITING_LOGIN') {
    return detail.loginEndDetection === true ? null : 'CONFIRM_LOGIN';
  }
  // OP-G2: まとめて実行の連鎖が動いている間は、点検の結果はまだない（点検の画面にとどまり、要点の 1 行目が今の段を言う）。
  if (detail.active || chainStageOf(detail) !== null) {
    return null;
  }
  if (detail.jobKind === WORKER_AUDIT_JOB_KIND) {
    return detail.artifacts.some(({ kind }) => kind === 'REPORT') ? 'OPEN_REPORT' : null;
  }
  if (isWriteJobKind(detail.jobKind)) {
    return detail.write?.report.reportHref === null || detail.write === null ? null : 'OPEN_WRITE_REPORT';
  }
  // OP-2 の修正の 1 回目（指示書の 8）: 書き込みの段を含む点検の、操作さがし・見るだけの確かめの段には、その画面への案内を出さない（サイトの画面へ移す）。
  if (chainWithWriteStagesOf(detail) !== null) {
    return null;
  }
  switch (result) {
    case 'ENTRY_CHECK_LOGIN_PAGE':
    case 'ENTRY_CHECK_READ':
      return 'START_AUDIT';
    case 'DISCOVERY_FINISHED':
      return 'OPEN_DISCOVERY';
    case 'READ_CHECK_FINISHED':
      return 'OPEN_READ_CHECKS';
    default:
      return null;
  }
};

/**
 * PL-U の修正の 1 回目（設計書 14.1 の判断）: 利用者が「止める」で止めた点検か。止めた点検は、押した人が止まったことをその場で見られるよう、作業の画面に残す
 * （移さない）。OP-1 修正の 2 回目: 判定は、ジョブに残る「止める」の要求の記録（`stopRequestedAt`。ジョブの管理が止める要求を受けた日時）で行う。前は Run の
 * 最後の実行の終わりの理由（`STOPPED_BY_SIGNAL`）を見ていたが、ログインを待つ間に止めると Run がまだなく、その記録がない（`runEnd` が `null`）ため、移していた。
 */
const stoppedByPersonOf = (detail: JobDetailFacts): boolean => detail.stopRequestedAt !== null;

/**
 * OP-2 の修正の 1 回目（指示書の 8）: 書き込みの段を行った点検（まとめて実行）か。書き込みの段の作業も、読み取りの段の作業も、同じ連鎖を持つ。
 */
const chainWithWriteStagesOf = (detail: JobDetailFacts): StageChainView | null =>
  (detail.stageChain !== null && detail.stageChain.writeStageJobIds.length > 0 ? detail.stageChain : null);

/** チェックした画面を 1 つも試せずに終えた連鎖の止まり方（`stage-chain-policy.ts` の閉じた一覧の 1 つ）。 */
const WRITE_NOT_TRIED_STOP_REASON: StageChainView['stopReason'] = 'WRITE_NOT_TRIED';

/** 書き込みの段を行った点検で、移さずに作業の画面に残す止まり方（安全の違反。止める要求は `stoppedByPersonOf` が先に見る）。 */
const WRITE_CHAIN_KEPT_STOP_REASONS: ReadonlySet<StageChainView['stopReason']> = new Set(['SAFETY_VIOLATION', 'USER_STOPPED']);

/**
 * OP-2 の修正の 1 回目（指示書の 8）: 書き込みの段を行った点検の、移す先。終わったら（止まったときも。行ごとの結果はサイトの画面の一覧が出す）、どの段の作業からも
 * サイトの画面へ。動いている間と、安全の違反・止める要求で止まったときは移さない。
 */
const writeChainAdvanceOf = (chain: StageChainView): JobSummaryAdvance | null => {
  if (chain.state === RUNNING_CHAIN_STATE || (chain.state !== FINISHED_CHAIN_STATE && WRITE_CHAIN_KEPT_STOP_REASONS.has(chain.stopReason))) {
    return null;
  }
  return { kind: 'SITE' };
};

/**
 * まとめて実行のステップの作業の、移す先（最後まで行ったらサイトの詳細）。OP-G2（OP-G の指示書の 6）: 動いている間は、次のステップの作業へ移さず、見ている
 * 点検の作業の画面にとどめる（要点の 1 行目が今の段を言う。`chainStageOf`）。前は次のステップの作業へ移していたので、書き込みの段の間は、終えた操作さがしの
 * 作業の画面（「操作さがしが終わりました。」だけ）になった。
 */
const stageChainAdvanceOf = (chain: StageChainView): JobSummaryAdvance | null =>
  // OP-G（指示書の 4）: チェックした画面を試せずに終えた点検（書き込みの段を 1 つも行わなかった）も、読み取りの段は最後まで行ったので、サイトの画面へ移す
  // （移った先の要点が、試せなかったことを 1 行で言う）。
  (chain.state === FINISHED_CHAIN_STATE || (chain.state !== RUNNING_CHAIN_STATE && chain.stopReason === WRITE_NOT_TRIED_STOP_REASON) ? { kind: 'SITE' } : null);

/** OP-G2: 段と段の間（次の段を準備している）の、今の段の値。 */
const NEXT_CHAIN_STAGE: JobSummaryChainStage = 'NEXT';

/**
 * OP-G2（OP-G の指示書の 6）: まとめて実行の連鎖が動いている間に、見ている作業（終えた段の作業）の画面にとどまって出す、今の段。動いている書き込みの段の作業が
 * あればその種類、動いている読み取りの段があればその種類、どれも動いていなければ段と段の間。見ている作業が動いている間と、連鎖が動いていないときは `null`。
 */
const chainStageOf = (detail: JobDetailFacts): JobSummaryChainStage | null => {
  const chain = detail.stageChain;
  if (detail.active || chain === null || chain.state !== RUNNING_CHAIN_STATE) {
    return null;
  }
  return detail.stageChainWriteKind ?? chain.stages.find((stage) => stage.state === RUNNING_CHAIN_STAGE_STATE)?.kind ?? NEXT_CHAIN_STAGE;
};

/**
 * 成功で終わったときに移す先（3 章の 5）。入口の確かめ → サイトの詳細、点検（手でのログイン・自動ログイン。一部のページを見られなかった点検も。14.1 の U1）→ サイトの詳細、まとめて実行 → 最後まで
 * 行ったらサイトの詳細（OP-G2: 動いている間は移さない）、書き込み → 続けて始めた更新の作業か、書き込みの手順の詳細。ほかの種類（ログインの確かめ・操作さがし・見るだけの確かめの単独の作業）は移さない。
 * 背後で書く結果（手でのログインからの自動の登録、続けて更新する予定）を待つ間は、まだ移さない。
 */
const advanceOf = (detail: JobDetailFacts, result: JobSummaryResult, awaitingRegistration: boolean): JobSummaryAdvance | null => {
  // OP-U: 移り先は、ページが出す送信の扱い（既定は削除のほかを通す）によらない。通した数と送り先は、成果物と報告に残す（作業の画面には出さない）。
  if (detail.active || awaitingRegistration || stoppedByPersonOf(detail)) {
    return null;
  }
  // OP-1（4.1.3 の 3）: 印つきの下調べは、続けて始めた点検の作業へ移す。始めなかったときは、下調べの結果によらずサイトの画面へ移す（サイトの画面が理由を出す）。
  const followUp = detail.entryCheckFollowUp;
  if (followUp !== null && followUp.state !== 'WAITING') {
    return followUp.state === 'STARTED' ? { kind: 'JOB', jobId: followUp.jobId } : { kind: 'SITE' };
  }
  // OP-2 の修正の 1 回目（指示書の 8）: 書き込みの段を含む点検の後は、どの段の作業からもサイトの画面へ（書き込みの手順の詳細へは移さない）。
  const writeChain = chainWithWriteStagesOf(detail);
  if (writeChain !== null) {
    return writeChainAdvanceOf(writeChain);
  }
  switch (result) {
    // PL-U（設計書 14.1 の U1）: 一部のページを見られなかった点検（`AUDIT_PARTIAL`）も、完了と同じく移す（移った先の要点の 1 行目が、そのことを言う）。
    case 'AUDIT_COMPLETE':
    case 'AUDIT_PARTIAL':
    case 'DISCOVERY_FINISHED':
    case 'READ_CHECK_FINISHED':
      return detail.stageChain !== null
        ? stageChainAdvanceOf(detail.stageChain)
        : result === 'AUDIT_COMPLETE' || result === 'AUDIT_PARTIAL' ? { kind: 'SITE' } : null;
    case 'ENTRY_CHECK_LOGIN_PAGE':
    case 'ENTRY_CHECK_READ':
      return { kind: 'SITE' };
    case 'WRITE_VERIFIED': {
      const chain = detail.writeChain;
      if (chain === null) {
        return detail.write === null ? null : { kind: 'SCENARIO', scenarioId: detail.write.scenarioId };
      }
      return chain.updateJobId === null ? null : { kind: 'JOB', jobId: chain.updateJobId };
    }
    default:
      return null;
  }
};

/** ログインの段の行のうち、人が登録できる行があるか（伏せた path と登録済みの理由の行のほか。`loginStageRegistrationOf` の 1 か所の振り分け）。 */
const hasRegistrableLoginStageRow = (stage: AuditJobLoginStageSummary): boolean =>
  [...(stage.blockedRequests?.requests ?? []), ...(stage.passedRequests?.requests ?? [])]
    .some((row) => loginStageRegistrationOf(row).kind !== 'MANUAL');

/**
 * 自動の登録が済んだ（足すものがないを含む）ときの、登録の結果の理由。DEF-182: token の送信先がテスト環境と同じ Origin のときも、行の登録で直せないので、済んだとする
 * （要点は、自動ログインを使えないの 1 行だけ）。
 */
const DONE_REGISTRATION_SKIP_REASONS: ReadonlySet<string> = new Set(['NOTHING_NEW', 'TOKEN_TARGET_ON_TEST_ORIGIN']);

/** ログインの段の行の登録の状態（4 章の 2: 済んだ登録の操作は出さない）。 */
const loginStageRegistrationStateOf = (detail: JobDetailFacts, awaitingRegistration: boolean): JobLoginStageRegistrationState => {
  const stage = detail.loginStage;
  if (stage === null) {
    return 'NONE';
  }
  const registration = stage.autoRegistration;
  if (registration?.result === 'SAVED' || (registration?.result === 'SKIPPED' && DONE_REGISTRATION_SKIP_REASONS.has(registration.reason))) {
    return 'DONE';
  }
  if (awaitingRegistration || detail.active) {
    return 'NONE';
  }
  return hasRegistrableLoginStageRow(stage) ? 'NEEDED' : 'NONE';
};

/** 確かめきれなかった所があるか（押す数の上限で押せなかった、サイトへの要求の上限に届いた、読みきれなかったページがある）。 */
const incompleteOf = (detail: JobDetailFacts): boolean =>
  (detail.pressLimitProbes?.priorityNotPressed ?? 0) > 0
  || detail.auditStage?.serviceRequestLimitReached === true
  || (detail.pageIncompleteReasons ?? []).some(({ pages }) => pages > 0);

/**
 * PL-2: 作業の画面の要点（判定の 1 か所）。サーバだけの関数にする（画面のブラウザ側の束に、判定と、それが読む部品を入れない。ジョブの詳細の Server Function
 * の中だけで使う）。
 */
export const jobSummaryOf = createServerOnlyFn((
  detail: JobDetailFacts,
  options: Readonly<{ estimateLimits: EstimateLimits | null; awaitingRegistration: boolean }>,
): AuditJobSummaryView => {
  const result = jobSummaryResultOf(detail);
  // OP-1: 続けて始める点検を待つ間も、背後の結果を待つ間として読み直す（まだ移さない）。
  const awaitingRegistration = options.awaitingRegistration || detail.entryCheckFollowUp?.state === 'WAITING';
  return {
    result,
    primary: primaryActionOf(detail, result),
    advance: advanceOf(detail, result, awaitingRegistration),
    estimate: progressEstimateOf(detail, options.estimateLimits),
    loginStageRegistration: loginStageRegistrationStateOf(detail, awaitingRegistration),
    incomplete: incompleteOf(detail),
    problemCount: result === 'AUDIT_COMPLETE' ? detail.reportSummary?.problemCount ?? null : null,
    awaitingRegistration,
    chainStage: chainStageOf(detail),
  };
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
    const chain = stageChainStartOf(profile.mode, checkInput);
    return {
      ...base,
      target,
      blocker: check.blocker,
      errorCodes: check.errorCodes,
      configError,
      authRequired: check.authRequired,
      approvedScenarioCount: await approvedScenarioCountOf(stored),
      writesOnCheckedScreens: chain !== null && localUiAuditJobs().checkedWriteScreenCountOf(profile.profileId) > 0,
      jobBrowserShown: readProfileDisplaySettings(localUiStore(), profile.profileId).showJobBrowser,
      authSetup: storedSetup === null
        ? null
        : {
          loginStartUrl: storedSetup.setup.loginStartUrl,
          auditPathPrefixes: [...storedSetup.setup.auditPathPrefixes],
          freshness: storedSetup.freshness,
          excludedPaths: [...storedSetup.setup.excludedPaths],
        },
      authSetupErrors: check.authSetupErrors,
      nextAllowedAt: check.nextAllowedAt,
      auth: profile.auth,
      autoLogin: reading.autoLoginSummary,
      chain,
      primaryStart: chain === null
        ? { kind: 'AUDIT_ONLY', blocker: check.blocker, errorCodes: check.errorCodes, authSetupErrors: check.authSetupErrors, nextAllowedAt: check.nextAllowedAt }
        : { kind: 'STAGE_CHAIN', blocker: chain.blocker, errorCodes: chain.errorCodes, authSetupErrors: chain.authSetupErrors, nextAllowedAt: chain.nextAllowedAt },
      resumeChoiceOffered: await resumeChoiceOfferedOf(profile.profileId),
    };
  });

/**
 * PL-3（4 章の 4）: 始め方を選ばせるか（`AuditStartSummaryView.resumeChoiceOffered`）。このサイトの、終わった最後の監査のジョブの終わり方（`run.json`）を読む。
 * 監査のジョブがなければ偽。終わり方の記録が読めない（Run を書く前に終わった・中断した）か、最後の実行が最後まで終えていなければ真。
 */
const resumeChoiceOfferedOf = async (profileId: string): Promise<boolean> => {
  // ジョブの一覧は新しい順（`listAuditJobs`）。
  const latest = localUiAuditJobs().listAuditJobs()
    .find((job) => job.profileId === profileId && job.jobKind === WORKER_AUDIT_JOB_KIND && !ACTIVE_STATES.has(job.state));
  if (latest === undefined) {
    return false;
  }
  const runEnd = await runEndOf(latest);
  return runEnd === null || runEnd.lastExecutionEndReason !== COMPLETED_RUN_EXECUTION_END_REASON;
};

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
 * OP-T fix round 2（I-1）: まとめて実行の始めの、取り消しの守りを終えられなかったときの開始の拒否の理由（今ある理由と文。書き込みの OK を使えなかった。
 * 利用者向けの文は足さない）。
 */
const CHECKED_SCREEN_GUARD_REJECTION = 'WRITE_GRANT_REJECTED' satisfies AuditJobStartRejectionReason;

/**
 * FM2d: まとめて実行を始める（開始の判断はジョブの管理が開始の直前に行う。入力は監査の開始と同じ形）。返すジョブは最初の段のもの（ジョブの詳細に連鎖の欄が
 * 出る）。
 * OP-T（DEF-184）: ジョブの管理に渡す前に、チェックした画面の手順の作り直しを確かめる（書き込みの段の対象は、ジョブの管理が開始のときに承認から決めるため、
 * その前。1 つの画面の作り直しの誤りでは止めない。中身は `redraftCheckedScreensOnChainStart`）。
 * OP-T fix round 2（I-1・Minor 2）: 一覧にチェックとして出ない承認の取り消しの守りを終えられなかったときは、ジョブの管理に渡さずに開始を拒む（fail-closed。
 * 文は今ある開始の失敗の文 `CHECKED_SCREEN_GUARD_REJECTION`）。
 */
export const startStageChainFn = createServerFn({ method: 'POST' })
  .validator(requestOf<AuditJobStartRequest>('ui-audit-job-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    if (!await redraftCheckedScreensOnChainStart(data.profileId)) {
      return { ok: false, reason: CHECKED_SCREEN_GUARD_REJECTION, errorCodes: [], authSetupErrors: [] };
    }
    const result = await localUiAuditJobs().startStageChain({
      profileId: data.profileId,
      expectedRevision: data.expectedRevision,
      startNew: data.startNew,
    });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
