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
import type { ExecutionGrantRejectionReason, RecordIdSource, ScenarioVerificationItem } from '../../../../src/control/approval-view.js';
import type {
  ACTION_BLOCK_REASON_CATALOG,
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  RECORD_ID_SOURCE_CATALOG,
  RESPONSE_JUDGEMENT_CATALOG,
  SCENARIO_VERIFICATION_ITEM_CATALOG,
  SETTLED_RESERVATION_STATE_CATALOG,
  SUBMISSION_STATE_CATALOG,
  WRITE_REPORT_CHECK_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type { EXECUTION_GRANT_REJECTION_DESCRIPTIONS, WRITE_START_LOCAL_REJECTION_DESCRIPTIONS } from '../../../../src/presentation/messages.js';
import type { WriteStartLocalRejectionReason } from '../server/write-job-functions';
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
  ReadExpectationUndeterminedReason,
  ReadRowSource,
} from '../../../../src/control/discovery-view.js';
import type { DiscoveryIndexDrift } from '../../../../src/control/job/discovery-index-store.js';
import type { ReadCheckDefinitionRejectionReason } from '../../../../src/control/read-check-policy.js';
import type { AuthSetupFreshness, AuthSetupStoreRejectionReason } from '../../../../src/control/store/auth-setup-store.js';
import type { ProfileStatus } from '../../../../src/control/store/profile-records.js';
import type { WorkerAuthState, WorkerLoginFormInvalidReason, WorkerOutcomeKind } from '../../../../src/control/worker-protocol.js';
import type {
  AUDIT_JOB_AUTH_STATE_CATALOG,
  AUDIT_JOB_KIND_CATALOG,
  AUTOMATED_LOGIN_RESULT_CATALOG,
  AUTOMATED_LOGIN_SUBMISSION_CATALOG,
  CREDENTIAL_CHANGE_KIND_CATALOG,
  CREDENTIAL_ENVIRONMENT_CATALOG,
  AUTH_SETUP_FRESHNESS_CATALOG,
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
  READ_CHECK_END_REASON_CATALOG,
  READ_CHECK_EXPECTATION_KIND_CATALOG,
  READ_CHECK_RESULT_CATALOG,
} from '../../../../src/presentation/catalog.js';
import type {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS,
  AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOGIN_FORM_INVALID_REASON_DESCRIPTIONS,
  PROFILE_VALIDATION_ERROR_DESCRIPTIONS,
  READ_CHECK_DEFINITION_REJECTION_DESCRIPTIONS,
  CANDIDATE_REASON_DESCRIPTIONS,
  DISCOVERY_INCOMPLETE_REASON_DESCRIPTIONS,
  DISCOVERY_UNREAD_REASON_LABELS,
  READ_CHECK_DETAIL_DESCRIPTIONS,
  READ_EXPECTATION_UNDETERMINED_REASON_DESCRIPTIONS,
  READ_ROW_SOURCE_LABELS,
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
import type {
  EXTERNAL_DELIVERY_KIND_CATALOG,
  FIELD_RELATION_KIND_CATALOG,
  FIELD_RULE_STATUS_CATALOG,
  GENERATION_METHOD_CATALOG,
  INPUT_RULE_STATE_CATALOG,
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
  RuleSetStoreRejectionReason,
  RuleSource,
  SemanticKind,
} from '../../../../src/control/data-rules-view.js';
import type { FIELD_RELATION_ROLES } from '../../../../src/control/data-rules-view.js';
import type { DataRuleRequestLocalRejectionReason } from '../server/data-rule-functions';
import type { InputRuleState } from './data-rules';
import type { CredentialEnvironmentState } from '../server/credential-runtime';

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

// 監査のジョブ（Task 24 の設計書 4.8。T24f）: 状態、終わり方、開始と停止を拒む理由、失敗と中断の理由のすべてに、表示と説明がある。
export type AuditJobStateCatalogCoversEveryState = AssertTrue<SameKeys<AuditJobState, keyof typeof AUDIT_JOB_STATE_CATALOG>>;
export type AuditJobEndKindCatalogCoversEveryKind = AssertTrue<SameKeys<WorkerOutcomeKind, keyof typeof AUDIT_JOB_END_KIND_CATALOG>>;
export type AuditJobStartRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobStartRejectionReason, keyof typeof AUDIT_JOB_START_REJECTION_DESCRIPTIONS>
>;
export type AuditJobStopRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobStopRejectionReason, keyof typeof AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS>
>;
export type AuditJobFailureReasonDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuditJobFailureReason, keyof typeof AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS>
>;

// T25d（Task 25 の設計書 4.4、4.5）: 監査のジョブの最後の認証の状態のすべてに、表示と説明がある。
export type AuditJobAuthStateCatalogCoversEveryState = AssertTrue<SameKeys<WorkerAuthState, keyof typeof AUDIT_JOB_AUTH_STATE_CATALOG>>;

// T25e（Task 25 の設計書 4.1、4.5）: 認証の設定の検証の誤りのコード、保存を拒む理由、保存した設定の新しさのすべてに、表示と説明がある。
export type AuthSetupValidationErrorDescriptionsCoverEveryCode = AssertTrue<
  SameKeys<AuthSetupValidationErrorCode, keyof typeof AUTH_SETUP_VALIDATION_ERROR_DESCRIPTIONS>
>;
export type AuthSetupStoreRejectionDescriptionsCoverEveryReason = AssertTrue<
  SameKeys<AuthSetupStoreRejectionReason, keyof typeof AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS>
>;
export type AuthSetupFreshnessCatalogCoversEveryValue = AssertTrue<SameKeys<AuthSetupFreshness, keyof typeof AUTH_SETUP_FRESHNESS_CATALOG>>;

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

// T32g（Task 32 の設計書 4.1 の「親の確かめと画面の配布」）: 書き込みの報告の親の確かめの結果のすべてに表示がある。
export type WriteReportCheckCatalogCoversEveryCheck = AssertTrue<SameKeys<WriteReportCheck, keyof typeof WRITE_REPORT_CHECK_CATALOG>>;
