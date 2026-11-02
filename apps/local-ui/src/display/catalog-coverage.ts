/**
 * 表示カタログと文言が、`src/control/` の値の一覧のすべてを、余分なく持つことを型で確かめる（T23f）。
 * `src/presentation/` は `src/control/` を import しない決まりなので、両方を import してよい画面の側に置く
 * （`src/config/config-error.ts`、`src/control/setup-local.ts` と同じ方式）。実行時の値は持たない。
 */
import type { AuthSetupValidationErrorCode } from '../../../../src/control/auth/auth-setup-contracts.js';
import type {
  ActionBlockReason,
  ActionOutcomeReason,
  ActionResult,
  ResponseJudgement,
  SettledReservationState,
  SubmissionState,
} from '../../../../src/control/actions/action-contracts.js';
import type {
  ApiScenarioLedgerOption,
  AutoDraftBlocker,
  AutoDraftCreatePlan,
  AutoDraftInferredItemKind,
  AutoDraftUpdateResultStatus,
  DraftValueGround,
  DraftValueOrigin,
  ExecutionGrantRejectionReason,
  FormAutoDraftGap,
  UpdateVerificationCopyUnavailableReason,
  RecordIdSource,
  ScenarioTransport,
  ScenarioVerificationItem,
} from '../../../../src/control/approval-view.js';
import type { DRAFT_VALUE_TEXT, LOCAL_UI_AUTO_DRAFT_TEXT, LOCAL_UI_SCENARIO_TEXT } from '../../../../src/presentation/messages.js';
import type { DRAFT_VALUE_ORIGIN_CATALOG } from '../../../../src/presentation/catalog.js';
import type {
  ACTION_BLOCK_REASON_CATALOG,
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  RECORD_ID_SOURCE_CATALOG,
  RESPONSE_JUDGEMENT_CATALOG,
  SCENARIO_TRANSPORT_CATALOG,
  SCENARIO_VERIFICATION_ITEM_CATALOG,
  SETTLED_RESERVATION_STATE_CATALOG,
  SUBMISSION_STATE_CATALOG,
  WRITE_REPORT_CHECK_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type { EXECUTION_GRANT_REJECTION_DESCRIPTIONS, WRITE_START_LOCAL_REJECTION_DESCRIPTIONS } from '../../../../src/presentation/messages.js';
import type { WriteChainStartRejectionReason, WriteStartLocalRejectionReason } from '../server/write-job-functions';
import type { WriteChainOfferReason, WriteChainState, WriteChainStopReason } from '../server/write-chain-policy';
import type { WRITE_CHAIN_STATE_CATALOG, WRITE_CHAIN_STOP_REASON_CATALOG } from '../../../../src/presentation/catalog.js';
import type {
  STAGE_CHAIN_STAGE_STATE_CATALOG,
  STAGE_CHAIN_STATE_CATALOG,
  STAGE_CHAIN_STOP_REASON_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type { LOCAL_UI_WRITE_TEXT } from '../../../../src/presentation/messages.js';
import type { LOCAL_UI_FRAME_TEXT } from '../../../../src/presentation/messages.js';
import type { LOCAL_UI_JOB_SUMMARY_TEXT } from '../../../../src/presentation/messages.js';
import type { AuditPrimaryStartKind, JobSummaryActiveResult, JobSummaryFinishedResult } from '../server/audit-job-functions';
import type { JobSummaryChainStage } from './job-summary-values';
import type { LOCAL_UI_AUDIT_TEXT } from '../../../../src/presentation/messages.js';
import type { NoticeKind } from '../components/Notice';
import type { AutomatedLoginResult, AutomatedLoginSubmission } from '../../../../src/control/auth/automated-login-results.js';
import type { CredentialChangeKind } from '../../../../src/control/credentials/credential-store.js';
import type { AuditMode, AuthStrategy, EnvironmentKind, ProfileValidationErrorCode } from '../../../../src/control/contracts.js';
import type {
  AuditJobFailureReason,
  AuditJobKind,
  AuditJobStartRejectionReason,
  AuditJobState,
  AuditJobStopRejectionReason,
  WriteReportCheck,
} from '../../../../src/control/job/job-records.js';
import type {
  CandidateClassification,
  CandidateKind,
  CandidateReasonCode,
  DiscoveryEndReason,
  DiscoveryUnreadReason,
  IncompleteReason,
  ReadCheckDetail,
  ReadCheckEndReason,
  ReadCheckExpectationKind,
  ReadCheckResult,
  ReadCheckTargetKind,
  ReadExpectationUndeterminedReason,
  ReadRowSource,
  SubmissionProbeReason,
  SubmissionProbeResult,
} from '../../../../src/control/discovery-view.js';
import type { DiscoveryIndexDrift } from '../../../../src/control/job/discovery-index-store.js';
import type { ReadCheckDefinitionRejectionReason } from '../../../../src/control/read-check-policy.js';
import type { AuthSetupFreshness, AuthSetupStoreRejectionReason } from '../../../../src/control/store/auth-setup-store.js';
import type { LoginTransport } from '../../../../src/control/auth/auth-setup-contracts.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import type {
  WorkerAuthState,
  WorkerChainStageKind,
  WorkerLoginFormInvalidReason,
  WorkerLoginStageBlockReason,
  WorkerOutcomeKind,
  WorkerRequestResourceType,
  WorkerWriteJobKind,
} from '../../../../src/control/worker-protocol.js';
import type { REQUEST_RESOURCE_TYPE_LABELS } from '../../../../src/presentation/catalog.js';
import type {
  AUDIT_JOB_AUTH_STATE_CATALOG,
  AUDIT_JOB_KIND_CATALOG,
  AUTOMATED_LOGIN_RESULT_CATALOG,
  AUTOMATED_LOGIN_SUBMISSION_CATALOG,
  CREDENTIAL_CHANGE_KIND_CATALOG,
  CREDENTIAL_ENVIRONMENT_CATALOG,
  AUTH_SETUP_FRESHNESS_CATALOG,
  LOGIN_TRANSPORT_CATALOG,
  AUDIT_JOB_END_KIND_CATALOG,
  AUDIT_JOB_STATE_CATALOG,
  AUDIT_MODE_CATALOG,
  AUTH_STRATEGY_CATALOG,
  ENVIRONMENT_KIND_CATALOG,
  PROFILE_STATUS_CATALOG,
  CANDIDATE_CLASSIFICATION_CATALOG,
  CANDIDATE_KIND_CATALOG,
  DISCOVERY_DRIFT_CATALOG,
  DISCOVERY_END_REASON_CATALOG,
  SUBMISSION_PROBE_REASON_CATALOG,
  SUBMISSION_PROBE_RESULT_CATALOG,
  READ_CHECK_END_REASON_CATALOG,
  READ_CHECK_EXPECTATION_KIND_CATALOG,
  READ_CHECK_RESULT_CATALOG,
  ENTRY_CHECK_END_REASON_CATALOG,
  ENTRY_CHECK_FORM_PLACEMENT_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type { EntryCheckEndReason, EntryCheckField, EntryCheckFormPlacement } from '../../../../src/control/entry-check.js';
import type {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS,
  LOGIN_FORM_INVALID_REASON_DESCRIPTIONS,
  LOGIN_STAGE_BLOCK_REASON_LABELS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  CANDIDATE_REASON_DESCRIPTIONS,
  DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS,
  DISCOVERY_UNREAD_REASON_LABELS,
  READ_CHECK_DETAIL_DESCRIPTIONS,
  READ_CHECK_TARGET_KIND_LABELS,
  READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS,
  READ_ROW_SOURCE_LABELS,
  LOCAL_UI_ENTRY_CHECK_TEXT,
} from '../../../../src/presentation/messages.js';
import type {
  ApprovalDigestItem,
  ApprovalInvalidityReason,
  ApprovalReceiptKind,
  RevocationReason,
  ScenarioDraftRejectionReason,
  ScenarioKind,
  ScenarioStoreRejectionReason,
  SideEffectConfirmation,
} from '../../../../src/control/approval-view.js';
import type {
  APPROVAL_DIGEST_ITEM_CATALOG,
  APPROVAL_INVALIDITY_REASON_CATALOG,
  APPROVAL_RECEIPT_KIND_CATALOG,
  REVOCATION_REASON_CATALOG,
  SCENARIO_DISPLAY_STATE_CATALOG,
  SCENARIO_KIND_CATALOG,
  SIDE_EFFECT_CONFIRMATION_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type { SCENARIO_DRAFT_REJECTION_DESCRIPTIONS, SCENARIO_REQUEST_REJECTION_DESCRIPTIONS } from '../../../../src/presentation/messages.js';
import type { CredentialRequestRejectionReason } from '../server/credential-errors';
import type { ScenarioRequestLocalRejectionReason } from '../server/scenario-facts';
import type { ScenarioDisplayState } from './scenarios';
import type { ProfileAction, ProfileNextStep, ProfileStageKind } from './next-steps';
import type { LOCAL_UI_NEXT_STEP_TEXT } from '../../../../src/presentation/messages.js';
import type {
  EXTERNAL_DELIVERY_KIND_CATALOG,
  FIELD_RELATION_KIND_CATALOG,
  FIELD_RULE_STATUS_CATALOG,
  GENERATION_METHOD_CATALOG,
  INPUT_RULE_STATE_CATALOG,
  RULE_ORIGIN_CATALOG,
  RULE_SOURCE_CATALOG,
  SEMANTIC_KIND_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type {
  DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_DATA_RULE_TEXT,
  RULE_PROBLEM_DETAIL_DESCRIPTIONS,
} from '../../../../src/presentation/messages.js';
import type {
  ExternalDeliveryBlockedDetail,
  ExternalDeliveryKind,
  FieldRelationKind,
  FieldRuleStatus,
  GenerationMethod,
  NeedsRuleInputDetail,
  RuleConflictDetail,
  RuleOrigin,
  RuleSetStoreRejectionReason,
  RuleSource,
  SemanticKind,
} from '../../../../src/control/data-rules-view.js';
import type { FIELD_RELATION_ROLES } from '../../../../src/control/data-rules-view.js';
import type { DataRuleRequestLocalRejectionReason } from '../server/data-rule-functions';
import type { AuthSetupSaveRejectionReason } from '../server/auth-setup-functions';
import type { ProfileSaveGuardRejection } from '../../../../src/control/auth/credential-destination.js';
import type {
  TargetConfigCreationFailure,
  TargetCrawlLimitField,
  TargetCrawlLimitProblemCode,
  TargetCrawlLimitsChangeFailure,
  TargetSiteProblem,
} from '../../../../src/config/target-config-draft.js';
import type { IncompleteReasonCode, RunExecutionEndReason, RunStatus } from '../../../../src/core/contracts.js';
import type { PrecheckFailureDetail } from '../../../../src/control/actions/action-contracts.js';
import type {
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  INCOMPLETE_REASON_NEXT_STEPS,
  PRECHECK_FAILURE_DETAIL_DESCRIPTIONS,
  LOCAL_UI_CRAWL_LIMITS_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS,
  TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS,
  TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS,
  TARGET_SITE_PROBLEM_DESCRIPTIONS,
} from '../../../../src/presentation/messages.js';
import type { InputRuleState } from './data-rules';
import type { CredentialEnvironmentState } from '../server/credential-runtime';
import type { AuditJobLoginConfirmRejectionReason } from '../../../../src/control/job/audit-job-manager.js';
import type { AuditJobAutomatedLoginUnavailableReason, AuditJobLoginAutoRegistrationSkipReason } from '../../../../src/control/job/job-store.js';
import type { ChainStageState, ChainState, ChainStopReason } from '../../../../src/control/job/stage-chain-policy.js';
import type {
  LOCAL_UI_DISPLAY_SETTINGS_TEXT,
  LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_STAGE_CHAIN_TEXT,
} from '../../../../src/presentation/messages.js';
import type { ProfileDisplaySettingsRejectionReason } from '../../../../src/control/store/profile-store.js';
import type { LoginStageRowRejectionReason } from '../server/login-stage-registration-functions';
// FM2e: 1 回の操作で自動ログインの設定を終える画面の理由と戻しの一覧（型だけ）。
import type { AutomatedLoginSetupRejectionReason, AutomatedLoginSetupRollback } from '../server/credential-service';
// FM2e: 自動ログインにする画面の文言（型だけ。理由と戻しの一覧の網羅）。
import type { LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT } from '../../../../src/presentation/messages.js';
import type { LOCAL_UI_UNUSABLE_PROFILE_TEXT, LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../../src/presentation/messages.js';
import type { WriteScreenCheckRejection, WriteScreenRowState } from '../server/write-screen-functions';
import type { InspectionWriteOutcome, WriteScreenNotCheckableKind, WriteScreenUpdateState } from './write-screen-values';
import type { UnusableProfileReason } from '../../../../src/control/unusable-profile.js';
// MI-3: 入口の確かめの後の認証の設定の状態の一覧（型だけ）。
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
import type { LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT } from '../../../../src/presentation/messages.js';

type SameKeys<Left extends PropertyKey, Right extends PropertyKey> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Condition extends true> = Condition;

export type AuditModeCatalogCoversEveryMode = AssertTrue<SameKeys<AuditMode, keyof typeof AUDIT_MODE_CATALOG>>;
export type EnvironmentKindCatalogCoversEveryKind = AssertTrue<SameKeys<EnvironmentKind, keyof typeof ENVIRONMENT_KIND_CATALOG>>;
export type AuthStrategyCatalogCoversEveryStrategy = AssertTrue<SameKeys<AuthStrategy, keyof typeof AUTH_STRATEGY_CATALOG>>;
export type ProfileStatusCatalogCoversEveryStatus = AssertTrue<SameKeys<ProfileStatus, keyof typeof PROFILE_STATUS_CATALOG>>;
export type ProfileValidationErrorDescriptionsCoverEveryCode = AssertTrue<
  SameKeys<ProfileValidationErrorCode, keyof typeof PROFILE_VALIDATION_ERROR_DESCRIPTIONS>
>;
// T43b（Task 43 の設計書 4.2）: 開始の URL と許可 Origin の欄の誤り、対象の設定のファイルを作れなかった理由のすべてに、説明がある。
export type TargetSiteProblemDescriptionsCoverEveryProblem = AssertTrue<
  SameKeys<TargetSiteProblem, keyof typeof TARGET_SITE_PROBLEM_DESCRIPTIONS>
>;
export type TargetConfigCreationFailureDescriptionsCoverEveryFailure = AssertTrue<
  SameKeys<TargetConfigCreationFailure, keyof typeof TARGET_CONFIG_CREATION_FAILURE_DESCRIPTIONS>
>;
// MI-F1（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 1・2）: プロファイルの作成・編集の口が拒む理由のすべてに、説明がある。
export type ProfileSaveGuardRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ProfileSaveGuardRejection, keyof typeof PROFILE_SAVE_GUARD_REJECTION_DESCRIPTIONS>
>;

// 監査のジョブ（Task 24 の設計書 4.8。T24f）: 状態、終わり方、開始と停止を拒む理由、失敗と中断の理由のすべてに、表示と説明がある。
export type AuditJobStateCatalogCoversEveryState = AssertTrue<SameKeys<AuditJobState, keyof typeof AUDIT_JOB_STATE_CATALOG>>;
export type AuditJobEndKindCatalogCoversEveryKind = AssertTrue<SameKeys<WorkerOutcomeKind, keyof typeof AUDIT_JOB_END_KIND_CATALOG>>;
export type AuditJobStartRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobStartRejectionReason, keyof typeof AUDIT_JOB_START_REJECTION_DESCRIPTIONS>
>;
export type AuditJobStopRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobStopRejectionReason, keyof typeof AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS>
>;
// DEF-146: 止める確認のダイアログの呼び名は、すべてのジョブの種類にある。
export type AuditJobStopTargetNamesCoverEveryKind = AssertTrue<SameKeys<AuditJobKind, keyof typeof AUDIT_JOB_STOP_TARGET_NAMES>>;
// T44d（Task 44 の設計書 P2-3）: 止める確認のダイアログの本文も、すべてのジョブの種類にある。
export type AuditJobStopDialogBodiesCoverEveryKind = AssertTrue<SameKeys<AuditJobKind, keyof typeof AUDIT_JOB_STOP_DIALOG_BODIES>>;
export type AuditJobStopRequestedTextsCoverEveryKind = AssertTrue<SameKeys<AuditJobKind, keyof typeof AUDIT_JOB_STOP_REQUESTED_TEXTS>>;
// T44d（Task 44 の設計書 P2-1）: 「監査の負荷」の欄の誤りと、変えられなかった理由のすべてに、説明がある。
export type TargetCrawlLimitProblemDescriptionsCoverEveryCode = AssertTrue<
  SameKeys<TargetCrawlLimitProblemCode, keyof typeof TARGET_CRAWL_LIMIT_PROBLEM_DESCRIPTIONS>
>;
export type TargetCrawlLimitsChangeFailureDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<TargetCrawlLimitsChangeFailure, keyof typeof TARGET_CRAWL_LIMITS_CHANGE_FAILURE_DESCRIPTIONS>
>;
export type CrawlLimitFieldLabelsCoverEveryField = AssertTrue<SameKeys<TargetCrawlLimitField, keyof typeof LOCAL_UI_CRAWL_LIMITS_TEXT.fields>>;

// T44e（Task 44 の設計書 P2-7）: ジョブの画面の「次にできること」は、終わり方と Run の状態のすべてにある（成功は `null`）。
type JobNextSteps = typeof LOCAL_UI_JOB_NEXT_STEPS;
export type JobNextStepsCoverEveryExecutionEnd = AssertTrue<SameKeys<RunExecutionEndReason, keyof JobNextSteps['runExecutionEndReasons']>>;
export type JobNextStepsCoverEveryRunStatus = AssertTrue<SameKeys<RunStatus, keyof JobNextSteps['runStatuses']>>;
export type JobNextStepsCoverEveryEndKind = AssertTrue<SameKeys<WorkerOutcomeKind, keyof JobNextSteps['endKinds']>>;
export type JobNextStepsCoverEveryDiscoveryEnd = AssertTrue<SameKeys<DiscoveryEndReason, keyof JobNextSteps['discoveryEndReasons']>>;
export type JobNextStepsCoverEveryReadCheckEnd = AssertTrue<SameKeys<ReadCheckEndReason, keyof JobNextSteps['readCheckEndReasons']>>;
export type JobNextStepsCoverEveryEntryCheckEnd = AssertTrue<SameKeys<EntryCheckEndReason, keyof JobNextSteps['entryCheckEndReasons']>>;
/**
 * Run の全体に付く理由の閉じた一覧（`run-coordinator.ts` の Run の理由: 上限・止める印・サイトの不調・ログインの切れ・サービスへの要求の上限・安全の中止と、
 * 実行の前の確認・途中の保存・Run のディレクトリの失敗）。ページごとの理由は HTML レポートに出す。
 */
type RunLevelIncompleteReason =
  | 'MAX_PAGES_REACHED'
  | 'MAX_DEPTH_REACHED'
  | 'MAX_RUNTIME_REACHED'
  | 'RUN_INTERRUPTED'
  | 'SITE_UNAVAILABLE'
  | 'AUTH_SESSION_LOST'
  | 'SERVICE_REQUEST_LIMIT_REACHED'
  | 'SAFETY_VIOLATION_ABORT'
  | 'PREFLIGHT_FAILED'
  | 'CHECKPOINT_WRITE_FAILED'
  | 'RUN_DIRECTORY_UNAVAILABLE';
// T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由のすべてに、説明と次にできることがある。
export type PrecheckFailureDetailDescriptionsCoverEveryDetail = AssertTrue<
  SameKeys<PrecheckFailureDetail, keyof typeof PRECHECK_FAILURE_DETAIL_DESCRIPTIONS>
>;
export type JobNextStepsCoverEveryRunLevelReason = AssertTrue<SameKeys<RunLevelIncompleteReason, keyof JobNextSteps['runReasons']>>;
// T44h の判断 (1)（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」の行）: ページの理由と、Run の閉じた一覧の外の理由を含め、すべての未完了の理由に、
// レポートと画面の次にできること（閉じた一覧の外は、この文）がある。
export type IncompleteReasonNextStepsCoverEveryCode = AssertTrue<SameKeys<IncompleteReasonCode, keyof typeof INCOMPLETE_REASON_NEXT_STEPS>>;
export type JobNextStepsRunReasonsAreIncompleteReasons = AssertTrue<SameKeys<keyof JobNextSteps['runReasons'] & IncompleteReasonCode, keyof JobNextSteps['runReasons']>>;
export type AuditJobFailureReasonDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobFailureReason, keyof typeof AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS>
>;

// T25d（Task 25 の設計書 4.4、4.5）: 監査のジョブの最後の認証の状態のすべてに、表示と説明がある。
export type AuditJobAuthStateCatalogCoversEveryState = AssertTrue<SameKeys<WorkerAuthState, keyof typeof AUDIT_JOB_AUTH_STATE_CATALOG>>;

// T25e（Task 25 の設計書 4.1、4.5）: 認証の設定の検証の誤りのコード、保存を拒む理由、保存した設定の新しさのすべてに、表示と説明がある。
export type AuthSetupValidationErrorDescriptionsCoverEveryCode = AssertTrue<
  SameKeys<AuthSetupValidationErrorCode, keyof typeof AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS>
>;
// MI-C 項目 12: 認証の設定の画面の保存の理由（保存の部品の理由と、自動ログインのプロファイルの `NEW_TARGET_FROM_AUTOMATED_LOGIN`）。
export type AuthSetupStoreRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuthSetupSaveRejectionReason, keyof typeof AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS>
>;
export type AuthSetupFreshnessCatalogCoversEveryValue = AssertTrue<SameKeys<AuthSetupFreshness, keyof typeof AUTH_SETUP_FRESHNESS_CATALOG>>;
// T34d: ログインの送り方のすべてに表示がある。
export type LoginTransportCatalogCoversEveryValue = AssertTrue<SameKeys<LoginTransport, keyof typeof LOGIN_TRANSPORT_CATALOG>>;
// T34e: ログインの段で止めた読み取りでない要求の理由のすべてに表示がある。
export type LoginStageBlockReasonLabelsCoverEveryReason = AssertTrue<
  SameKeys<WorkerLoginStageBlockReason, keyof typeof LOGIN_STAGE_BLOCK_REASON_LABELS>
>;

// T26e（Task 26 の設計書 4.2、4.6）: ジョブの種類、自動ログインの結果と送信、資格情報の最後の変更の種類、資格情報の暗号化の状態、資格情報の画面の
// 要求を拒む理由、フォームの確かめの理由のコードのすべてに、表示と説明がある。
export type AuditJobKindCatalogCoversEveryKind = AssertTrue<SameKeys<AuditJobKind, keyof typeof AUDIT_JOB_KIND_CATALOG>>;
export type AutomatedLoginResultCatalogCoversEveryResult = AssertTrue<SameKeys<AutomatedLoginResult, keyof typeof AUTOMATED_LOGIN_RESULT_CATALOG>>;
export type AutomatedLoginSubmissionCatalogCoversEveryValue = AssertTrue<
  SameKeys<AutomatedLoginSubmission, keyof typeof AUTOMATED_LOGIN_SUBMISSION_CATALOG>
>;
export type CredentialChangeKindCatalogCoversEveryKind = AssertTrue<SameKeys<CredentialChangeKind, keyof typeof CREDENTIAL_CHANGE_KIND_CATALOG>>;
export type CredentialEnvironmentCatalogCoversEveryState = AssertTrue<
  SameKeys<CredentialEnvironmentState, keyof typeof CREDENTIAL_ENVIRONMENT_CATALOG>
>;
export type CredentialRequestRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<CredentialRequestRejectionReason, keyof typeof CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS>
>;
export type LoginFormInvalidReasonDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<WorkerLoginFormInvalidReason, keyof typeof LOGIN_FORM_INVALID_REASON_DESCRIPTIONS>
>;

// T27c（Task 27 の設計書 4.5）: READ の確かめの定義の保存を拒む理由のすべてに、説明と手順がある（ジョブの種類と失敗の理由は上の型で確かめる）。
export type ReadCheckDefinitionRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ReadCheckDefinitionRejectionReason, keyof typeof READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS>
>;

// T27f（Task 27 の設計書 4.3、4.4、4.5、4.7）: 操作の候補の分類・種類・理由のコード・ドリフト、発見の終わり方・読まなかった理由・読み切れなかった
// 理由、READ の確かめの結果・詳しい理由・期待の種類・照らせなかった理由・数えた構造・終わり方のすべてに、表示と説明がある（値の一覧は
// `src/control/discovery-view.ts` から公開し直したもの）。
export type CandidateClassificationCatalogCoversEveryClassification = AssertTrue<
  SameKeys<CandidateClassification, keyof typeof CANDIDATE_CLASSIFICATION_CATALOG>
>;
export type CandidateKindCatalogCoversEveryKind = AssertTrue<SameKeys<CandidateKind, keyof typeof CANDIDATE_KIND_CATALOG>>;
export type CandidateReasonDescriptionsCoverEveryCode = AssertTrue<SameKeys<CandidateReasonCode, keyof typeof CANDIDATE_REASON_DESCRIPTIONS>>;
export type DiscoveryDriftCatalogCoversEveryDrift = AssertTrue<SameKeys<DiscoveryIndexDrift, keyof typeof DISCOVERY_DRIFT_CATALOG>>;
export type DiscoveryEndReasonCatalogCoversEveryReason = AssertTrue<SameKeys<DiscoveryEndReason, keyof typeof DISCOVERY_END_REASON_CATALOG>>;
// T37c（Task 37 の設計書 3.6）: 送らずに観察する probe の結果と理由のすべてに、表示がある。
export type SubmissionProbeResultCatalogCoversEveryResult = AssertTrue<SameKeys<SubmissionProbeResult, keyof typeof SUBMISSION_PROBE_RESULT_CATALOG>>;
export type SubmissionProbeReasonCatalogCoversEveryReason = AssertTrue<SameKeys<SubmissionProbeReason, keyof typeof SUBMISSION_PROBE_REASON_CATALOG>>;
export type DiscoveryUnreadReasonLabelsCoverEveryReason = AssertTrue<
  SameKeys<DiscoveryUnreadReason, keyof typeof DISCOVERY_UNREAD_REASON_LABELS>
>;
export type DiscoveryIncompleteReasonDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<IncompleteReason, keyof typeof DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS>
>;
export type ReadCheckResultCatalogCoversEveryResult = AssertTrue<SameKeys<ReadCheckResult, keyof typeof READ_CHECK_RESULT_CATALOG>>;
export type ReadCheckDetailDescriptionsCoverEveryDetail = AssertTrue<SameKeys<ReadCheckDetail, keyof typeof READ_CHECK_DETAIL_DESCRIPTIONS>>;
export type ReadCheckExpectationKindCatalogCoversEveryKind = AssertTrue<
  SameKeys<ReadCheckExpectationKind, keyof typeof READ_CHECK_EXPECTATION_KIND_CATALOG>
>;
export type ReadExpectationUndeterminedReasonDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ReadExpectationUndeterminedReason, keyof typeof READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS>
>;
export type ReadRowSourceLabelsCoverEverySource = AssertTrue<SameKeys<ReadRowSource, keyof typeof READ_ROW_SOURCE_LABELS>>;
export type ReadCheckEndReasonCatalogCoversEveryReason = AssertTrue<SameKeys<ReadCheckEndReason, keyof typeof READ_CHECK_END_REASON_CATALOG>>;
// T37d（Task 37 の設計書 3.5）: 定義の対象の種類（候補を読む・画面を読む）。
export type ReadCheckTargetKindLabelsCoverEveryKind = AssertTrue<SameKeys<ReadCheckTargetKind, keyof typeof READ_CHECK_TARGET_KIND_LABELS>>;

// T28e（Task 28 の設計書 4.1、4.3、4.6）: シナリオの種類・表示の状態・再承認が要る理由（13 種）・副作用の確認の項目・承認の digest の項目（差分の
// 項目名）・承認の記録の種類・撤回の理由、下書きを拒む理由、画面の要求を拒む理由（保存の部品の理由と画面のサーバの理由）のすべてに、表示と説明が
// ある（値の一覧は `src/control/approval-view.ts` から公開し直したものと、`scenarios.ts`・`scenario-facts.ts` の一覧）。
export type ScenarioKindCatalogCoversEveryKind = AssertTrue<SameKeys<ScenarioKind, keyof typeof SCENARIO_KIND_CATALOG>>;
export type ScenarioDisplayStateCatalogCoversEveryState = AssertTrue<SameKeys<ScenarioDisplayState, keyof typeof SCENARIO_DISPLAY_STATE_CATALOG>>;
export type ApprovalInvalidityReasonCatalogCoversEveryReason = AssertTrue<
  SameKeys<ApprovalInvalidityReason, keyof typeof APPROVAL_INVALIDITY_REASON_CATALOG>
>;
export type SideEffectConfirmationCatalogCoversEveryItem = AssertTrue<
  SameKeys<SideEffectConfirmation, keyof typeof SIDE_EFFECT_CONFIRMATION_CATALOG>
>;
export type ApprovalDigestItemCatalogCoversEveryItem = AssertTrue<SameKeys<ApprovalDigestItem, keyof typeof APPROVAL_DIGEST_ITEM_CATALOG>>;
export type ApprovalReceiptKindCatalogCoversEveryKind = AssertTrue<SameKeys<ApprovalReceiptKind, keyof typeof APPROVAL_RECEIPT_KIND_CATALOG>>;
export type RevocationReasonCatalogCoversEveryReason = AssertTrue<SameKeys<RevocationReason, keyof typeof REVOCATION_REASON_CATALOG>>;
export type ScenarioDraftRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ScenarioDraftRejectionReason, keyof typeof SCENARIO_DRAFT_REJECTION_DESCRIPTIONS>
>;
export type ScenarioRequestRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ScenarioStoreRejectionReason | ScenarioRequestLocalRejectionReason, keyof typeof SCENARIO_REQUEST_REJECTION_DESCRIPTIONS>
>;

// T29e（Task 29 の設計書 3 章の「補完の画面」、4.1、4.4）: 入力の規則の意味の種類（23）・作り方・欄どうしの関係・出どころ・欄ごとの状態・入力の規則の
// 状態・外部到達の種類、判定の細分のすべて、保存を拒む理由（保存の部品の理由と画面のサーバの理由）、関係の役割の名前のすべてに、表示と説明がある
// （値の一覧は `src/control/data-rules-view.ts` から公開し直したものと、`data-rules.ts`・`data-rule-functions.ts` の一覧）。
export type SemanticKindCatalogCoversEveryKind = AssertTrue<SameKeys<SemanticKind, keyof typeof SEMANTIC_KIND_CATALOG>>;
export type GenerationMethodCatalogCoversEveryMethod = AssertTrue<SameKeys<GenerationMethod, keyof typeof GENERATION_METHOD_CATALOG>>;
export type FieldRelationKindCatalogCoversEveryKind = AssertTrue<SameKeys<FieldRelationKind, keyof typeof FIELD_RELATION_KIND_CATALOG>>;
export type RuleSourceCatalogCoversEverySource = AssertTrue<SameKeys<RuleSource, keyof typeof RULE_SOURCE_CATALOG>>;
// FM2c: 保存した規則の出どころの印にも、表示がある。
export type RuleOriginCatalogCoversEveryOrigin = AssertTrue<SameKeys<RuleOrigin, keyof typeof RULE_ORIGIN_CATALOG>>;
export type FieldRuleStatusCatalogCoversEveryStatus = AssertTrue<SameKeys<FieldRuleStatus, keyof typeof FIELD_RULE_STATUS_CATALOG>>;
export type InputRuleStateCatalogCoversEveryState = AssertTrue<SameKeys<InputRuleState, keyof typeof INPUT_RULE_STATE_CATALOG>>;
export type ExternalDeliveryKindCatalogCoversEveryKind = AssertTrue<SameKeys<ExternalDeliveryKind, keyof typeof EXTERNAL_DELIVERY_KIND_CATALOG>>;
export type RuleProblemDetailDescriptionsCoverEveryDetail = AssertTrue<
  SameKeys<NeedsRuleInputDetail | RuleConflictDetail | ExternalDeliveryBlockedDetail, keyof typeof RULE_PROBLEM_DETAIL_DESCRIPTIONS>
>;
export type DataRuleRequestRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<RuleSetStoreRejectionReason | DataRuleRequestLocalRejectionReason, keyof typeof DATA_RULE_REQUEST_REJECTION_DESCRIPTIONS>
>;
export type DataRuleRelationRoleLabelsCoverEveryRole = AssertTrue<
  SameKeys<(typeof FIELD_RELATION_ROLES)[FieldRelationKind][number], keyof typeof LOCAL_UI_DATA_RULE_TEXT.relationRoles>
>;

// T30g（Task 30 の設計書 3 章）: 書き込みの結果・送信の状態・止めた理由・応答の判定・結果の理由・予約の締め・検証の指定の項目・登録の ID の取り方の
// すべてに表示があり、実行の許可の発行を拒む理由と、書き込みの開始を画面のサーバが拒む理由のすべてに説明と手順がある。
export type ActionResultCatalogCoversEveryResult = AssertTrue<SameKeys<ActionResult, keyof typeof ACTION_RESULT_CATALOG>>;
export type SubmissionStateCatalogCoversEveryState = AssertTrue<SameKeys<SubmissionState, keyof typeof SUBMISSION_STATE_CATALOG>>;
export type ActionBlockReasonCatalogCoversEveryReason = AssertTrue<SameKeys<ActionBlockReason, keyof typeof ACTION_BLOCK_REASON_CATALOG>>;
export type ResponseJudgementCatalogCoversEveryJudgement = AssertTrue<SameKeys<ResponseJudgement, keyof typeof RESPONSE_JUDGEMENT_CATALOG>>;
export type ActionOutcomeReasonCatalogCoversEveryReason = AssertTrue<SameKeys<ActionOutcomeReason, keyof typeof ACTION_OUTCOME_REASON_CATALOG>>;
export type SettledReservationStateCatalogCoversEveryState = AssertTrue<
  SameKeys<SettledReservationState, keyof typeof SETTLED_RESERVATION_STATE_CATALOG>
>;
export type ScenarioVerificationItemCatalogCoversEveryItem = AssertTrue<
  SameKeys<ScenarioVerificationItem, keyof typeof SCENARIO_VERIFICATION_ITEM_CATALOG>
>;
export type RecordIdSourceCatalogCoversEverySource = AssertTrue<SameKeys<RecordIdSource, keyof typeof RECORD_ID_SOURCE_CATALOG>>;
export type ExecutionGrantRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<ExecutionGrantRejectionReason, keyof typeof EXECUTION_GRANT_REJECTION_DESCRIPTIONS>
>;
export type WriteStartLocalRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<WriteStartLocalRejectionReason, keyof typeof WRITE_START_LOCAL_REJECTION_DESCRIPTIONS>
>;

// T41g（Task 41 の設計書 3.5.1）: 「登録してから更新する」の状態と、更新を始めなかった理由のすべてに表示があり、出す理由と何も始めずに拒む理由の
// すべてに文言がある。
export type WriteChainStateCatalogCoversEveryState = AssertTrue<SameKeys<WriteChainState, keyof typeof WRITE_CHAIN_STATE_CATALOG>>;
export type WriteChainStopReasonCatalogCoversEveryReason = AssertTrue<SameKeys<WriteChainStopReason, keyof typeof WRITE_CHAIN_STOP_REASON_CATALOG>>;
export type WriteChainOfferTextCoversEveryReason = AssertTrue<SameKeys<WriteChainOfferReason, keyof typeof LOCAL_UI_WRITE_TEXT.chain.offerReasons>>;
export type WriteChainStartRejectionTextCoversEveryReason = AssertTrue<
  SameKeys<WriteChainStartRejectionReason, keyof typeof LOCAL_UI_WRITE_TEXT.chain.startRejections>
>;

// T40d（Task 40 の設計書 3.5）: 書き込みの送り方のすべてに表示がある。
export type ScenarioTransportCatalogCoversEveryTransport = AssertTrue<SameKeys<ScenarioTransport, keyof typeof SCENARIO_TRANSPORT_CATALOG>>;

// T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」）: 書き込みの報告の親の確かめの結果のすべてに表示がある。
export type WriteReportCheckCatalogCoversEveryCheck = AssertTrue<SameKeys<WriteReportCheck, keyof typeof WRITE_REPORT_CHECK_CATALOG>>;

// T43a（Task 43 の設計書 4.1）: 保存の後の次の手順のすべてにリンクの文言がある。PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、6 章）: サイトの
// 画面の段のすべてに今の様子の文と一覧の短い文があり、ボタンの行き先のすべてに名前がある（値の一覧は `next-steps.ts`）。
export type NextStepActionTextCoversEveryStep = AssertTrue<SameKeys<ProfileNextStep, keyof typeof LOCAL_UI_NEXT_STEP_TEXT.after.actions>>;
export type ProfileStageTextCoversEveryStage = AssertTrue<SameKeys<ProfileStageKind, keyof typeof LOCAL_UI_NEXT_STEP_TEXT.stages>>;
export type ProfileStageListTextCoversEveryStage = AssertTrue<SameKeys<ProfileStageKind, keyof typeof LOCAL_UI_NEXT_STEP_TEXT.listStages>>;
// OP-3: 点検から移ってきたときの段の文は、段の一覧の中の鍵だけ（余分がない）。
export type ProfileStageAfterArrivalTextIsWithinStages = AssertTrue<
  [keyof typeof LOCAL_UI_NEXT_STEP_TEXT.afterAuditArrival] extends [ProfileStageKind] ? true : false
>;
export type ProfileActionTextCoversEveryAction = AssertTrue<SameKeys<ProfileAction, keyof typeof LOCAL_UI_NEXT_STEP_TEXT.actions>>;

// T43c（Task 43 の設計書 4.3）: 入口の確かめの終わり方と、3 つの要素の置き方と、欄のすべてに表示がある（値の一覧は `src/control/entry-check.ts`）。
export type EntryCheckEndReasonCatalogCoversEveryReason = AssertTrue<SameKeys<EntryCheckEndReason, keyof typeof ENTRY_CHECK_END_REASON_CATALOG>>;
export type EntryCheckFormPlacementCatalogCoversEveryPlacement = AssertTrue<
  SameKeys<EntryCheckFormPlacement, keyof typeof ENTRY_CHECK_FORM_PLACEMENT_CATALOG>
>;
export type EntryCheckFieldTextCoversEveryField = AssertTrue<SameKeys<EntryCheckField, keyof typeof LOCAL_UI_ENTRY_CHECK_TEXT.job.fields>>;

// ML-b-2（手動のログインの設計書 2.2、2.3）: 「ログインを終えた」をジョブの管理が拒む理由と、設定を自動で登録しなかった理由のすべてに文言がある
// （値の一覧は `src/control/job/audit-job-manager.ts` と `src/control/job/job-store.ts`）。
export type ManualLoginConfirmRejectionTextCoversEveryReason = AssertTrue<
  SameKeys<AuditJobLoginConfirmRejectionReason, keyof typeof LOCAL_UI_MANUAL_LOGIN_TEXT.rejectionReasons>
>;
// FM-1（手動の操作を減らす設計書 2.2）: 表示の設定の保存が拒む理由のすべてに文言がある。
export type DisplaySettingsTextCoversEveryReason = AssertTrue<
  SameKeys<ProfileDisplaySettingsRejectionReason, keyof typeof LOCAL_UI_DISPLAY_SETTINGS_TEXT.reasons>
>;
// FM-1（手動の操作を減らす設計書 2.1）: 表の 1 行の「登録する」の理由のすべてに文言がある。
export type LoginStageRowRegisterTextCoversEveryReason = AssertTrue<
  SameKeys<LoginStageRowRejectionReason, keyof typeof LOCAL_UI_LOGIN_STAGE_REGISTER_TEXT.reasons>
>;
// OP-K（K3）: 自動ログインへ切り替えられなかった理由のすべてに、1 行の文がある。
export type AutomatedLoginUnavailableTextCoversEveryReason = AssertTrue<
  SameKeys<AuditJobAutomatedLoginUnavailableReason, keyof typeof LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.automatedLoginReasons>
>;
export type ManualLoginAutoRegistrationSkipTextCoversEveryReason = AssertTrue<
  SameKeys<AuditJobLoginAutoRegistrationSkipReason, keyof typeof LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.skipReasons>
>;
// FM2d（手動の操作を減らす設計書 3A.1）: まとめて実行の状態・段の状態・止めた理由のすべてに、文言（止めた理由は次にできることも）がある。
// FM2R の Minor 3: ラベルと色は表示カタログ（`catalog.ts`）、止めた理由の次にできることは `LOCAL_UI_STAGE_CHAIN_TEXT.stopReasons`。
export type StageChainCatalogCoversEveryState = AssertTrue<SameKeys<ChainState, keyof typeof STAGE_CHAIN_STATE_CATALOG>>;
export type StageChainCatalogCoversEveryStageState = AssertTrue<SameKeys<ChainStageState, keyof typeof STAGE_CHAIN_STAGE_STATE_CATALOG>>;
export type StageChainCatalogCoversEveryStopReason = AssertTrue<SameKeys<ChainStopReason, keyof typeof STAGE_CHAIN_STOP_REASON_CATALOG>>;
export type StageChainTextCoversEveryStopReason = AssertTrue<SameKeys<ChainStopReason, keyof typeof LOCAL_UI_STAGE_CHAIN_TEXT.stopReasons>>;
// PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3、3 章の 1）: 開始の画面の主のボタンが始めるもの（まとめて実行か、点検だけか）のすべてに、
// 1 回押すと何が起きるかの文がある。
export type StartTextCoversEveryPrimaryStartKind = AssertTrue<
  SameKeys<AuditPrimaryStartKind, keyof typeof LOCAL_UI_AUDIT_TEXT.start.whatHappens>
>;
// FM2b（手を減らす段 2 の設計書 3A.2）: 下書きをボタン 1 回で作るときの押せない理由・行の状態・推測の項目、案の出どころと
// 根拠のすべてに文言がある（値の一覧は `src/control/approval/api-scenario-autodraft.ts` と `draft-value-origin.ts`）。
export type AutoDraftTextCoversEveryBlocker = AssertTrue<SameKeys<AutoDraftBlocker, keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.blockers>>;
export type AutoDraftTextCoversEveryCreateStatus = AssertTrue<SameKeys<AutoDraftCreatePlan['status'], keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.createStatuses>>;
// OP-2: 作った結果の状態（保存した・作れなかった）も含める。
export type AutoDraftTextCoversEveryUpdateStatus = AssertTrue<SameKeys<AutoDraftUpdateResultStatus, keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.updateStatuses>>;
export type AutoDraftTextCoversEveryInferredItem = AssertTrue<SameKeys<AutoDraftInferredItemKind, keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.inferredItems>>;
// MI-7（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6）: 更新の照合の READ を台帳から埋められない理由のすべてに文言がある（値の一覧は
// `src/control/approval/api-scenario-draft.ts` の `API_UPDATE_LEDGER_READ_UNAVAILABLE_REASONS`）。
export type ApiUpdateLedgerReadTextCoversEveryReason = AssertTrue<SameKeys<
  Extract<ApiScenarioLedgerOption['readVerification'], { readonly status: 'UNAVAILABLE' }>['reason'],
  keyof typeof LOCAL_UI_SCENARIO_TEXT.api.ledgerReadUnavailable
>>;
// PL-6b（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1）: フォームの形の下書きの決められなかった理由と、書き換えの検証の指定を台帳から写せない理由の
// すべてに文言がある（値の一覧は `form-scenario-autodraft.ts` の `FORM_AUTO_DRAFT_GAPS` と `update-verification-copy.ts`）。
export type AutoDraftTextCoversEveryFormGap = AssertTrue<SameKeys<FormAutoDraftGap, keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.formGaps>>;
export type AutoDraftTextCoversEveryUpdateCopyReason = AssertTrue<
  SameKeys<UpdateVerificationCopyUnavailableReason, keyof typeof LOCAL_UI_AUTO_DRAFT_TEXT.updateCopyUnavailable>
>;
// FM2b: 案の出どころの表示（名前・順・色の区分）は表示カタログの 1 か所。
export type DraftValueOriginCatalogCoversEveryOrigin = AssertTrue<SameKeys<DraftValueOrigin, keyof typeof DRAFT_VALUE_ORIGIN_CATALOG>>;
export type DraftValueTextCoversEveryGround = AssertTrue<SameKeys<DraftValueGround, keyof typeof DRAFT_VALUE_TEXT.grounds>>;
// FM2e（手を減らす段 2 の設計書 3A.4）: 1 回の操作で自動ログインの設定を終える画面の、拒否の理由と資格情報のファイルの戻しのすべてに文言がある（値の一覧は
// `src/server/credential-service.ts`）。
export type AutomatedLoginSetupTextCoversEveryRejection = AssertTrue<
  SameKeys<AutomatedLoginSetupRejectionReason, keyof typeof LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.rejections>
>;
export type AutomatedLoginSetupTextCoversEveryRollback = AssertTrue<
  SameKeys<AutomatedLoginSetupRollback, keyof typeof LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.rollbacks>
>;
// PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2）: 切り替えの画面にセレクタの案のもとの説明を出さなくなったので、案のもとの文言の網羅は外した。
// OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D6・D7'）: 「書き込みにも使う」の確認のダイアログと文言はなくした（切り替えは、一覧の
// チェックの保存が中で行い、拒んだときは `LOCAL_UI_WRITE_SCREENS_TEXT.rejections.MODE_SWITCH_FAILED` の 1 行を出す）。
// OP-2 の修正の 2 回目（判断 2・R1）: サイトの画面の一覧の、試せない行の理由の種類と、更新の 1 行の状態と、行の状態と、保存を拒む理由のすべてに文言がある（値の
// 一覧は `src/display/write-screen-values.ts` と `src/server/write-screen-functions.ts`）。
export type WriteScreensTextCoversEveryNotCheckableKind = AssertTrue<
  SameKeys<WriteScreenNotCheckableKind, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.notCheckable>
>;
export type WriteScreensTextCoversEveryUpdateState = AssertTrue<SameKeys<WriteScreenUpdateState, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.update>>;
/** OP-G: 点検の要点の書き込みの 1 行の種類と、その文。 */
export type WriteScreensTextCoversEveryInspectionWriteOutcome = AssertTrue<SameKeys<InspectionWriteOutcome, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.inspectionWrite>>;
export type WriteScreensTextCoversEveryRowState = AssertTrue<SameKeys<WriteScreenRowState, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.states>>;
export type WriteScreensTextCoversEveryRejection = AssertTrue<
  SameKeys<WriteScreenCheckRejection, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.rejections>
>;
// OP-F: 前の点検の結果の「前回は試せませんでした」の理由（送らずに締めた理由のすべて）。
export type WriteScreensTextCoversEveryNotSentReason = AssertTrue<SameKeys<ActionBlockReason, keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.notSentReasons>>;
// MI-3（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後の認証の設定の状態（`NOT_USED` と、文を出さない `PRESENT` を除く）のすべてに文言がある（値の一覧は
// `src/control/auth/auth-setup-proposal.ts`）。
export type AuthSetupProposalTextCoversEveryState = AssertTrue<
  SameKeys<Exclude<EntryCheckAuthSetupState, 'NOT_USED' | 'PRESENT'>, keyof typeof LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT.states>
>;
// MI-F3 項目 6: 起動のときに使えないプロファイルを自動で取り消す理由のすべてに、ログの文言がある（値の一覧は `src/control/unusable-profile.ts`）。
export type UnusableProfileTextCoversEveryReason = AssertTrue<
  SameKeys<UnusableProfileReason, keyof typeof LOCAL_UI_UNUSABLE_PROFILE_TEXT.reasons>
>;
// PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 6）: 知らせの種類のすべてに、見出しがないときに出す種類の語がある（種類の一覧は
// `components/Notice.tsx` の `NoticeKind`）。
export type NoticeKindTextCoversEveryKind = AssertTrue<SameKeys<NoticeKind, keyof typeof LOCAL_UI_FRAME_TEXT.noticeKinds>>;
// PL-W（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 2・4）: 要求の種類のすべてに、画面の日本語の名前がある（値の一覧は
// `src/control/worker-protocol.ts` の `WORKER_REQUEST_RESOURCE_TYPES`）。
export type RequestResourceTypeLabelsCoverEveryType = AssertTrue<
  SameKeys<WorkerRequestResourceType, keyof typeof REQUEST_RESOURCE_TYPE_LABELS>
>;
// PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1・5）: 作業の画面の要点の結果の 1 行のすべてに文言がある（値の一覧は
// `server/audit-job-functions.ts` の `JOB_SUMMARY_ACTIVE_RESULTS`・`JOB_SUMMARY_FINISHED_RESULTS`。止めている間は、種類ごとの `AUDIT_JOB_STOP_REQUESTED_TEXTS`）。
export type JobSummaryTextCoversEveryActiveResult = AssertTrue<
  SameKeys<Exclude<JobSummaryActiveResult, 'STOPPING'>, keyof typeof LOCAL_UI_JOB_SUMMARY_TEXT.active>
>;
export type JobSummaryTextCoversEveryFinishedResult = AssertTrue<SameKeys<JobSummaryFinishedResult, keyof typeof LOCAL_UI_JOB_SUMMARY_TEXT.finished>>;
// OP-G2（OP-G の指示書の 6）: 点検の画面にとどまる間の今の段のすべてに、結果の 1 行の文言がある（値の一覧は `display/job-summary-values.ts` の
// `JOB_SUMMARY_CHAIN_STAGES`）。
export type JobSummaryTextCoversEveryChainStage = AssertTrue<SameKeys<JobSummaryChainStage, keyof typeof LOCAL_UI_JOB_SUMMARY_TEXT.chainStage>>;
// OP-H: 今の段の一覧の、段の値は、IPC の契約の読み取りの段と書き込みの段のちょうど全部（`NEXT` は段と段の間）。
export type JobSummaryChainStagesAreTheChainStages = AssertTrue<
  SameKeys<Exclude<JobSummaryChainStage, 'NEXT'>, WorkerChainStageKind | WorkerWriteJobKind>
>;
