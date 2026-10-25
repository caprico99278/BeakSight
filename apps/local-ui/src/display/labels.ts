/**
 * 画面の表示の語（Task 23 設計書 4.7。T23f）。値（英数字）から、表示カタログ（`src/presentation/catalog.ts`）のラベルと色のトーンを引く。
 * 画面の部品は、ここと `src/presentation/` の文言・書式だけを使って描く（日本語の文字列を直接書かない）。
 */
import {
  AUDIT_MODES,
  AUTH_STRATEGIES,
  ENVIRONMENT_KINDS,
  type AuditMode,
  type AuthStrategy,
  type EnvironmentKind,
} from '../../../../src/control/contracts.js';
import { isExecutableAuditMode, isProfileOperationAllowed } from '../../../../src/control/execution-policy.js';
import type { AutomatedLoginResult, AutomatedLoginSubmission } from '../../../../src/control/auth/automated-login-results.js';
import type { CredentialChangeKind } from '../../../../src/control/credentials/credential-store.js';
import type { AuthSetupFreshness } from '../../../../src/control/store/auth-setup-store.js';
import type { LoginTransport } from '../../../../src/control/auth/auth-setup-contracts.js';
import type { EntryCheckEndReason, EntryCheckFormPlacement } from '../../../../src/control/entry-check.js';
import type { WorkerAuthState } from '../../../../src/control/worker-protocol.js';
import type { AuditJobKind, AuditJobState, WriteReportCheck } from '../../../../src/control/job/job-records.js';
import type { CredentialEnvironmentState } from '../server/credential-runtime';
import type { WorkerOutcomeKind } from '../../../../src/control/worker-protocol.js';
import type { IncompleteReasonCode, RunExecutionEndReason, RunStatus } from '../../../../src/core/contracts.js';
import { LOCAL_UI_JOB_NEXT_STEPS, nextStepOfIncompleteReason } from '../../../../src/presentation/messages.js';
import type {
  CandidateClassification,
  CandidateKind,
  DiscoveryEndReason,
  ReadCheckEndReason,
  ReadCheckExpectationKind,
  ReadCheckResult,
  SubmissionProbeReason,
  SubmissionProbeResult,
} from '../../../../src/control/discovery-view.js';
import type { DiscoveryIndexDrift } from '../../../../src/control/job/discovery-index-store.js';
import type {
  ApprovalDigestItem,
  ApprovalInvalidityReason,
  ApprovalReceiptKind,
  RevocationReason,
  ScenarioKind,
  SideEffectConfirmation,
} from '../../../../src/control/approval-view.js';
import type { ScenarioDisplayState } from './scenarios';
import type { WriteChainState, WriteChainStopReason } from '../server/write-chain-policy';
import type { ChainStageState, ChainState, ChainStopReason } from '../../../../src/control/job/stage-chain-policy.js';
import type { NextStepState, ProfileNextStep } from './next-steps';
import type {
  ExternalDeliveryKind,
  FieldRelationKind,
  FieldRuleStatus,
  GenerationMethod,
  RuleOrigin,
  RuleSource,
  SemanticKind,
} from '../../../../src/control/data-rules-view.js';
import type { InputRuleState } from './data-rules';
import type {
  ActionBlockReason,
  ActionOutcomeReason,
  ActionResult,
  ResponseJudgement,
  SettledReservationState,
  SubmissionState,
} from '../../../../src/control/actions/action-contracts.js';
import type { DraftValueOrigin, RecordIdSource, ScenarioTransport, ScenarioVerificationItem } from '../../../../src/control/approval-view.js';
import {
  ACTION_BLOCK_REASON_CATALOG,
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  RECORD_ID_SOURCE_CATALOG,
  RESPONSE_JUDGEMENT_CATALOG,
  SCENARIO_TRANSPORT_CATALOG,
  SCENARIO_VERIFICATION_ITEM_CATALOG,
  WRITE_CHAIN_STATE_CATALOG,
  WRITE_CHAIN_STOP_REASON_CATALOG,
  STAGE_CHAIN_STATE_CATALOG,
  STAGE_CHAIN_STAGE_STATE_CATALOG,
  STAGE_CHAIN_STOP_REASON_CATALOG,
  SETTLED_RESERVATION_STATE_CATALOG,
  SUBMISSION_STATE_CATALOG,
  WRITE_REPORT_CHECK_CATALOG,
} from '../../../../src/presentation/catalog.js';
import {
  EXTERNAL_DELIVERY_KIND_CATALOG,
  FIELD_RELATION_KIND_CATALOG,
  FIELD_RULE_STATUS_CATALOG,
  GENERATION_METHOD_CATALOG,
  INPUT_RULE_STATE_CATALOG,
  RULE_ORIGIN_CATALOG,
  DRAFT_VALUE_ORIGIN_CATALOG,
  RULE_SOURCE_CATALOG,
  SEMANTIC_KIND_CATALOG,
} from '../../../../src/presentation/catalog.js';
import {
  APPROVAL_DIGEST_ITEM_CATALOG,
  APPROVAL_INVALIDITY_REASON_CATALOG,
  APPROVAL_RECEIPT_KIND_CATALOG,
  REVOCATION_REASON_CATALOG,
  SCENARIO_DISPLAY_STATE_CATALOG,
  SCENARIO_KIND_CATALOG,
  SIDE_EFFECT_CONFIRMATION_CATALOG,
  AUDIT_JOB_AUTH_STATE_CATALOG,
  CANDIDATE_CLASSIFICATION_CATALOG,
  CANDIDATE_KIND_CATALOG,
  DISCOVERY_DRIFT_CATALOG,
  DISCOVERY_END_REASON_CATALOG,
  SUBMISSION_PROBE_REASON_CATALOG,
  SUBMISSION_PROBE_RESULT_CATALOG,
  READ_CHECK_END_REASON_CATALOG,
  READ_CHECK_EXPECTATION_KIND_CATALOG,
  READ_CHECK_RESULT_CATALOG,
  AUDIT_JOB_END_KIND_CATALOG,
  AUDIT_JOB_KIND_CATALOG,
  AUTOMATED_LOGIN_RESULT_CATALOG,
  AUTOMATED_LOGIN_SUBMISSION_CATALOG,
  CREDENTIAL_CHANGE_KIND_CATALOG,
  CREDENTIAL_ENVIRONMENT_CATALOG,
  AUDIT_JOB_STATE_CATALOG,
  AUDIT_MODE_CATALOG,
  AUTH_SETUP_FRESHNESS_CATALOG,
  LOGIN_TRANSPORT_CATALOG,
  ENTRY_CHECK_END_REASON_CATALOG,
  ENTRY_CHECK_FORM_PLACEMENT_CATALOG,
  NEXT_STEP_STATE_CATALOG,
  PROFILE_NEXT_STEP_CATALOG,
  AUTH_STRATEGY_CATALOG,
  ENVIRONMENT_KIND_CATALOG,
  PROFILE_STATUS_CATALOG,
  RUN_EXECUTION_END_REASON_CATALOG,
  RUN_STATUS_CATALOG,
  sortByDisplayOrder,
  type DisplayTone,
} from '../../../../src/presentation/catalog.js';

/** 表示の 1 つの値（ラベルと色のトーン）。 */
export interface DisplayValue {
  readonly label: string;
  readonly tone: DisplayTone;
  /** カタログの説明（なければ `null`）。 */
  readonly description: string | null;
}

/** プロファイルの状態（`src/control/store/profile-records.ts` の `PROFILE_STATUSES` の値）。 */
export type ProfileStatusValue = keyof typeof PROFILE_STATUS_CATALOG;

export const auditModeDisplay = (mode: AuditMode): DisplayValue => AUDIT_MODE_CATALOG[mode];
export const environmentDisplay = (environment: EnvironmentKind): DisplayValue => ENVIRONMENT_KIND_CATALOG[environment];
export const authStrategyDisplay = (auth: AuthStrategy): DisplayValue => AUTH_STRATEGY_CATALOG[auth];
export const profileStatusDisplay = (status: ProfileStatusValue): DisplayValue => PROFILE_STATUS_CATALOG[status];
/** 監査のジョブの状態（T24f）。 */
export const auditJobStateDisplay = (state: AuditJobState): DisplayValue => AUDIT_JOB_STATE_CATALOG[state];
/** 監査のジョブの終わり方（監査の中核の結果の種類。T24f）。 */
export const auditJobEndKindDisplay = (kind: WorkerOutcomeKind): DisplayValue => AUDIT_JOB_END_KIND_CATALOG[kind];
/** Run の状態（既存の表示カタログ。HTML レポートと CLI と同じラベル。T24f）。 */
export const runStatusDisplay = (status: RunStatus): DisplayValue => RUN_STATUS_CATALOG[status];
/** T44e: 1 回の実行の終わり方（ジョブの画面の「終わり方と理由」）。 */
export const runExecutionEndReasonDisplay = (reason: RunExecutionEndReason): DisplayValue => RUN_EXECUTION_END_REASON_CATALOG[reason];
/** 監査のジョブの最後の認証の状態（T25e）。 */
export const auditJobAuthStateDisplay = (state: WorkerAuthState): DisplayValue => AUDIT_JOB_AUTH_STATE_CATALOG[state];
/** 保存した認証の設定の新しさ（T25e）。 */
export const authSetupFreshnessDisplay = (freshness: AuthSetupFreshness): DisplayValue => AUTH_SETUP_FRESHNESS_CATALOG[freshness];

/** T43a: プロファイルの「次にすること」の手順と、その状態（値の一覧は `next-steps.ts`）。 */
export const profileNextStepDisplay = (step: ProfileNextStep): DisplayValue => PROFILE_NEXT_STEP_CATALOG[step];
export const nextStepStateDisplay = (state: NextStepState): DisplayValue => NEXT_STEP_STATE_CATALOG[state];

/** T34d: ログインの送り方（フォームの送信・スクリプトの送信）。 */
export const loginTransportDisplay = (transport: LoginTransport): DisplayValue => LOGIN_TRANSPORT_CATALOG[transport];
/** T43c: 入口の確かめの終わり方と、3 つの要素の form の中の置き方。 */
export const entryCheckEndReasonDisplay = (reason: EntryCheckEndReason): DisplayValue => ENTRY_CHECK_END_REASON_CATALOG[reason];
export const entryCheckFormPlacementDisplay = (placement: EntryCheckFormPlacement): DisplayValue => ENTRY_CHECK_FORM_PLACEMENT_CATALOG[placement];
/** ジョブの種類（監査、ログインの確かめ。T26e）。 */
export const auditJobKindDisplay = (kind: AuditJobKind): DisplayValue => AUDIT_JOB_KIND_CATALOG[kind];
/** 自動ログインの結果（T26e）。 */
export const automatedLoginResultDisplay = (result: AutomatedLoginResult): DisplayValue => AUTOMATED_LOGIN_RESULT_CATALOG[result];
/** 自動ログインで、ログインの POST を送ったか（T26e）。 */
export const automatedLoginSubmissionDisplay = (submitted: AutomatedLoginSubmission): DisplayValue =>
  AUTOMATED_LOGIN_SUBMISSION_CATALOG[submitted];
/** 保存した資格情報の最後の変更の種類（T26e）。 */
export const credentialChangeKindDisplay = (kind: CredentialChangeKind): DisplayValue => CREDENTIAL_CHANGE_KIND_CATALOG[kind];
/** 資格情報の暗号化を、この環境で使えるか（サーバが判定した結果。T26e）。 */
export const credentialEnvironmentDisplay = (state: CredentialEnvironmentState): DisplayValue => CREDENTIAL_ENVIRONMENT_CATALOG[state];
/** 操作の候補の分類（T27f）。 */
export const candidateClassificationDisplay = (classification: CandidateClassification): DisplayValue =>
  CANDIDATE_CLASSIFICATION_CATALOG[classification];
/** 操作の候補の種類（フォーム、ボタン。T27f）。 */
export const candidateKindDisplay = (kind: CandidateKind): DisplayValue => CANDIDATE_KIND_CATALOG[kind];
/** 候補の索引のドリフト（T27f）。 */
export const discoveryDriftDisplay = (drift: DiscoveryIndexDrift): DisplayValue => DISCOVERY_DRIFT_CATALOG[drift];
/** 発見のジョブの終わり方（T27f）。 */
export const discoveryEndReasonDisplay = (reason: DiscoveryEndReason): DisplayValue => DISCOVERY_END_REASON_CATALOG[reason];
/** T37c: 送らずに観察する probe の結果と理由。 */
export const submissionProbeResultDisplay = (result: SubmissionProbeResult): DisplayValue => SUBMISSION_PROBE_RESULT_CATALOG[result];
export const submissionProbeReasonDisplay = (reason: SubmissionProbeReason): DisplayValue => SUBMISSION_PROBE_REASON_CATALOG[reason];
/** READ の確かめの結果（期待 1 件の結果にも使う。T27f）。 */
export const readCheckResultDisplay = (result: ReadCheckResult): DisplayValue => READ_CHECK_RESULT_CATALOG[result];
/** READ の確かめの期待の種類（T27f）。 */
export const readCheckExpectationKindDisplay = (kind: ReadCheckExpectationKind): DisplayValue => READ_CHECK_EXPECTATION_KIND_CATALOG[kind];
/** READ の確かめのジョブの終わり方と、確かめなかった定義の理由（T27f）。 */
export const readCheckEndReasonDisplay = (reason: ReadCheckEndReason): DisplayValue => READ_CHECK_END_REASON_CATALOG[reason];
/** シナリオの種類（T28e）。 */
export const scenarioKindDisplay = (kind: ScenarioKind): DisplayValue => SCENARIO_KIND_CATALOG[kind];
/** シナリオの表示の状態（T28e。選び方は `scenarios.ts`）。 */
export const scenarioDisplayStateDisplay = (state: ScenarioDisplayState): DisplayValue => SCENARIO_DISPLAY_STATE_CATALOG[state];
/** 再承認が要る理由（T28e）。 */
export const approvalInvalidityReasonDisplay = (reason: ApprovalInvalidityReason): DisplayValue => APPROVAL_INVALIDITY_REASON_CATALOG[reason];
/** 副作用の確認の項目（T28e）。 */
export const sideEffectConfirmationDisplay = (item: SideEffectConfirmation): DisplayValue => SIDE_EFFECT_CONFIRMATION_CATALOG[item];
/** 承認の digest の項目（最後の承認との差分の項目名。T28e）。 */
export const approvalDigestItemDisplay = (item: ApprovalDigestItem): DisplayValue => APPROVAL_DIGEST_ITEM_CATALOG[item];
/** 承認の記録の種類（T28e）。 */
export const approvalReceiptKindDisplay = (kind: ApprovalReceiptKind): DisplayValue => APPROVAL_RECEIPT_KIND_CATALOG[kind];
/** 撤回の理由（T28e）。 */
export const revocationReasonDisplay = (reason: RevocationReason): DisplayValue => REVOCATION_REASON_CATALOG[reason];
/** 入力の規則の、欄の意味の種類（T29e）。 */
export const semanticKindDisplay = (kind: SemanticKind): DisplayValue => SEMANTIC_KIND_CATALOG[kind];
/** 入力の規則の、値の作り方（T29e）。 */
export const generationMethodDisplay = (method: GenerationMethod): DisplayValue => GENERATION_METHOD_CATALOG[method];
/** 入力の規則の、欄どうしの関係（T29e）。 */
export const fieldRelationKindDisplay = (kind: FieldRelationKind): DisplayValue => FIELD_RELATION_KIND_CATALOG[kind];
/** 入力の規則の、欄の規則の出どころ（T29e）。 */
export const ruleSourceDisplay = (source: RuleSource): DisplayValue => RULE_SOURCE_CATALOG[source];
/** 入力の規則の、保存した規則の出どころの印（FM2c）。 */
export const ruleOriginDisplay = (origin: RuleOrigin): DisplayValue => RULE_ORIGIN_CATALOG[origin];
/** 自動で作る下書きの案の出どころの印（FM2b。表示カタログの 1 か所）。 */
export const draftValueOriginDisplay = (origin: DraftValueOrigin): DisplayValue => DRAFT_VALUE_ORIGIN_CATALOG[origin];
/** 入力の規則の、欄ごとの判定の状態（T29e）。 */
export const fieldRuleStatusDisplay = (status: FieldRuleStatus): DisplayValue => FIELD_RULE_STATUS_CATALOG[status];
/** シナリオの入力の規則の状態（T29e。選び方は `data-rules.ts`）。 */
export const inputRuleStateDisplay = (state: InputRuleState): DisplayValue => INPUT_RULE_STATE_CATALOG[state];
/** 入力の規則の、外部到達の種類（T29e）。 */
export const externalDeliveryKindDisplay = (kind: ExternalDeliveryKind): DisplayValue => EXTERNAL_DELIVERY_KIND_CATALOG[kind];

/** 選択肢（値とラベル。表示の順）。 */
export interface SelectOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

const optionsOf = <TValue extends string>(
  values: readonly TValue[],
  catalog: Readonly<Record<TValue, { readonly label: string; readonly order: number }>>,
): readonly SelectOption<TValue>[] => sortByDisplayOrder(values, catalog).map((value) => ({ value, label: catalog[value].label }));

export const AUDIT_MODE_OPTIONS = optionsOf(AUDIT_MODES, AUDIT_MODE_CATALOG);
export const ENVIRONMENT_OPTIONS = optionsOf(ENVIRONMENT_KINDS, ENVIRONMENT_KIND_CATALOG);
export const AUTH_STRATEGY_OPTIONS = optionsOf(AUTH_STRATEGIES, AUTH_STRATEGY_CATALOG);

/**
 * 今は監査を実行できない（書き込みが要る）モードか。今実行できるモードの一覧は、`src/control/execution-policy.ts` が唯一の owner
 * （T23R の M5。T24f で画面の写しを消した）。ジョブの管理も、開始の直前に同じ判定を使う。T28b: 書き込みのモードでも、認証の設定・発見・READ の
 * 確かめは使える（監査だけが実行できない。フォームの案内の文言で伝える）。
 */
export const isNotYetExecutableMode = (mode: AuditMode): boolean => !isExecutableAuditMode(mode);

/**
 * 今実行できる、モードと認証の方式の組み合わせか（T25e。一覧の「監査を始める」を置くか）。判定は `src/control/execution-policy.ts` の
 * `isProfileOperationAllowed`（監査 `AUDIT` の行。モードの判定を含む。T28b）。認証の設定の有無と新しさは、開始の画面とジョブの管理が確かめる。
 */
export const isExecutableProfile = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('AUDIT', mode, auth);

/**
 * 認証の設定を使うプロファイルか（T25e。T28b で `src/control/execution-policy.ts` の `AUTH_SETUP` の行の判定にした。認証つきの読み取りの監査と
 * 書き込みのモードの、手動のログインか自動ログイン）。認証の設定の画面とその案内は、このプロファイルだけに出す。
 */
export const usesAuthSetup = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('AUTH_SETUP', mode, auth);

/**
 * 操作の候補の発見か READ の確かめを使うプロファイルか（T28b。`src/control/execution-policy.ts` の `DISCOVERY`・`READ_CHECK` の行）。プロファイルの
 * 詳細の、操作の候補と READ の確かめへの案内は、このプロファイルだけに出す。
 */
export const usesDiscovery = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('DISCOVERY', mode, auth);
export const usesReadCheck = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('READ_CHECK', mode, auth);

/**
 * 自動ログインを使うプロファイルか（T26e。Task 26 の設計書 4.2、4.6。T28b で `src/control/execution-policy.ts` の `CREDENTIAL` の行の判定にした。
 * 認証つきの読み取りの監査と書き込みのモードの、自動ログイン）。資格情報の画面とログインの確かめの案内は、このプロファイルだけに出す。この環境で
 * 暗号化が使えるか（Windows か）は、サーバが判定して画面に渡す（ここでは判定しない。このファイルはブラウザのバンドルにも入る）。
 */
export const usesAutomatedLogin = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('CREDENTIAL', mode, auth);

/**
 * FM-1（手動の操作を減らす設計書 2.3）: 「次から自動でログインする」を案内するプロファイルか（認証の設定を使い、自動ログインでない、つまり手動の
 * ログインのプロファイル）。
 */
export const offersAutomatedLogin = (mode: AuditMode, auth: AuthStrategy): boolean => usesAuthSetup(mode, auth) && !usesAutomatedLogin(mode, auth);

/**
 * 書き込みのシナリオ（作成・変更・承認）を使うプロファイルか（T28e。Task 28 の設計書 4.6。fix round 1 で `src/control/execution-policy.ts` の
 * `SCENARIO` の行の判定にした。承認した書き込みのモードの、手動のログインか自動ログイン）。プロファイルの詳細のシナリオへの案内、候補の画面の
 * 「シナリオを作る」、シナリオの画面の作成・変更・承認は、このプロファイルだけに出す（シナリオの保存の部品も、同じ行で `SCENARIO_MODE_NOT_WRITE`
 * を返す）。
 */
export const usesScenarios = (mode: AuditMode, auth: AuthStrategy): boolean => isProfileOperationAllowed('SCENARIO', mode, auth);

/** 色のトーンの CSS のクラス。 */
export const toneClass = (tone: DisplayTone): string => `badge badge--${tone}`;

// T30g（Task 30 の設計書 3 章）: 書き込みの結果と検証の指定の表示。
export const actionResultDisplay = (result: ActionResult): DisplayValue => ACTION_RESULT_CATALOG[result];

export const submissionStateDisplay = (state: SubmissionState): DisplayValue => SUBMISSION_STATE_CATALOG[state];

export const actionBlockReasonDisplay = (reason: ActionBlockReason): DisplayValue => ACTION_BLOCK_REASON_CATALOG[reason];

export const responseJudgementDisplay = (judgement: ResponseJudgement): DisplayValue => RESPONSE_JUDGEMENT_CATALOG[judgement];

export const actionOutcomeReasonDisplay = (reason: ActionOutcomeReason): DisplayValue => ACTION_OUTCOME_REASON_CATALOG[reason];

export const settledReservationStateDisplay = (state: SettledReservationState): DisplayValue => SETTLED_RESERVATION_STATE_CATALOG[state];

export const scenarioVerificationItemDisplay = (item: ScenarioVerificationItem): DisplayValue => SCENARIO_VERIFICATION_ITEM_CATALOG[item];

export const recordIdSourceDisplay = (source: RecordIdSource): DisplayValue => RECORD_ID_SOURCE_CATALOG[source];

/** T41g: 「登録してから更新する」の状態と、更新を始めなかった理由。 */
export const writeChainStateDisplay = (state: WriteChainState): DisplayValue => WRITE_CHAIN_STATE_CATALOG[state];
export const writeChainStopReasonDisplay = (reason: WriteChainStopReason): DisplayValue => WRITE_CHAIN_STOP_REASON_CATALOG[reason];

/** FM2d・FM2R の Minor 3: まとめて実行の状態、段の状態、止めた理由。 */
export const stageChainStateDisplay = (state: ChainState): DisplayValue => STAGE_CHAIN_STATE_CATALOG[state];
export const stageChainStageStateDisplay = (state: ChainStageState): DisplayValue => STAGE_CHAIN_STAGE_STATE_CATALOG[state];
export const stageChainStopReasonDisplay = (reason: ChainStopReason): DisplayValue => STAGE_CHAIN_STOP_REASON_CATALOG[reason];

/** T40d: 書き込みの送り方（フォームの送信・API の要求）。 */
export const scenarioTransportDisplay = (transport: ScenarioTransport): DisplayValue => SCENARIO_TRANSPORT_CATALOG[transport];

/** T32g: 書き込みの報告の親の確かめの結果（`VALID` のときだけ報告を配る）。 */
export const writeReportCheckDisplay = (check: WriteReportCheck): DisplayValue => WRITE_REPORT_CHECK_CATALOG[check];

/**
 * T44e（Task 44 の設計書 P2-7）: ジョブの画面の、Run の理由の次にできること。閉じた一覧の理由は画面の文（`LOCAL_UI_JOB_NEXT_STEPS.runReasons`。画面の操作を書く）、
 * ほかは HTML レポートと同じ文（`nextStepOfIncompleteReason`）。T44h の判断 (1): レポートの文はすべての理由にあるので、どの理由にも文がある。
 */
export const runReasonNextStepOf = (code: IncompleteReasonCode): string =>
  (LOCAL_UI_JOB_NEXT_STEPS.runReasons as Partial<Record<IncompleteReasonCode, string>>)[code] ?? nextStepOfIncompleteReason(code);
