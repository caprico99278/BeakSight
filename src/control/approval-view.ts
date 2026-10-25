// シナリオの承認の、画面（`apps/local-ui/`）に要る型と閉じた一覧と読み出し・書き込みの口を、`src/control/approval/` から公開し直す 1 か所
// （Task 28 の設計書 4.6。T28e）。手本は `src/control/discovery-view.ts`。
// - 画面のコードは `src/control/approval/` を直接 import しない（`tests/architecture/local-ui-boundary.test.ts` の (j)）。画面は、ここから型と値を
//   読む（書き写さない）。意味の owner は、それぞれの `src/control/approval/` のファイルのまま（ここは名前を公開し直すだけで、判断を持たない）。
// - 公開しないもの（`tests/architecture/approval-ssot.test.ts` の (d)）: 承認の期限の 1 日の長さ（期限の計算は `approval-validity.ts` だけが使う。
//   T28a の Gate (b)）、実行の許可の消費・確かめ直しと予約の状態の変更（ジョブの管理が書き込みのジョブの中で使う）、入力の規則の参照を付ける口
//   （Task 29）。
// - T30g（Task 30 の設計書 3 章、T30g の Blocker の判断（案 A））: 実行の許可の発行（`issueExecutionGrant`）と、連続の上限の予定
//   （`writeScheduleOf`）を公開する。発行を呼べる画面のコードは、書き込みの開始の Server Function のファイル 1 つだけ（Gate `approval-ssot` の (e)）。
//   検証の指定の閉じた一覧と未指定の項目の判定（`missingVerificationItemsOf`）も、画面の入力と表示のために公開する。
// - 値（関数と閉じた一覧）は、画面のサーバ（`apps/local-ui/src/server/`）だけが読む。ブラウザ側の画面のコードは、ここから型だけを import する
//   （値はサーバの Server Function が返す。ここから読み込む部品は Node の部品を使う）。

export {
  APPROVAL_RECEIPT_KINDS,
  APPROVAL_TTL_DAYS,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MIN_APPROVAL_TTL_DAYS,
  MIN_SCENARIO_LIMIT,
  REVOCATION_REASONS,
  SCENARIO_KINDS,
  SCENARIO_STATES,
  SIDE_EFFECT_CONFIRMATIONS,
  WRITE_AUDIT_MODE,
  // CC-106（FM2b）: シナリオの種類の値の名前つきの定数（画面のサーバに `'CREATE' satisfies ScenarioKind` を書き写さない）。
  CREATE_SCENARIO_KIND,
  UPDATE_SCENARIO_KIND,
  // FM2R の Minor 13: 下書きの状態の名前つきの定数。
  DRAFT_SCENARIO_STATE,
  // T30g: 検証の指定の入力と表示、連続の上限の表示。
  MAX_WRITES_PER_DAY,
  MIN_WRITE_INTERVAL_MS,
  RECORD_ID_SOURCES,
  SCENARIO_VERIFICATION_ITEMS,
  // T40R-fix-B（M-2）: 送り方の値の名前つきの定数（画面のサーバが使う）。
  API_SCENARIO_TRANSPORT,
  FORM_SCENARIO_TRANSPORT,
  VERIFICATION_EXPECTATION_KINDS,
  // T31h-1: UPDATE の指定の path の型の、レコードの ID の区切りの印（画面に `'{id}'` を書き写さない）。
  RECORD_ID_PLACEHOLDER,
  // T38c: 送り方（API のシナリオの要求の型の要約を出す）。
  scenarioTransportOf,
  // T38f: API のシナリオの作成の画面（欄に対応する鍵と欄の識別。T38R-fix の I-1: 索引の鍵と欄の digest と同じ部品）。
  scenarioApiKeyFieldsOfProbe,
  // DEF-147: API のシナリオの公開の状態にあたる鍵（承認の画面と作成の画面の注意の印）。
  scenarioApiPublicationStateKeysOf,
} from './approval/scenario-contracts.js';
export type {
  ApprovalBoundFacts,
  ApprovalReceipt,
  ApprovalReceiptKind,
  ApprovalReceiptRecord,
  InputRuleReference,
  ReadCheckReference,
  RevocationReason,
  RevocationReceipt,
  ScenarioKind,
  ScenarioLimits,
  ScenarioRequestShape,
  ScenarioRevision,
  ScenarioState,
  SideEffectConfirmation,
  SideEffectConfirmations,
  // T30g: 検証の指定。
  RecordIdSource,
  ScenarioReadVerification,
  ScenarioRecordIdSpec,
  ScenarioResultCondition,
  ScenarioVerification,
  ScenarioVerificationItem,
  VerificationBinding,
  VerificationExpectation,
  VerificationExpectationKind,
  // T38c: API のシナリオの指定（承認の画面の型の要約）。
  ScenarioApiSpec,
  ScenarioTransport,
  // T38f: 欄の識別。
  ScenarioApiFieldIdentity,
} from './approval/scenario-contracts.js';

export {
  SCENARIO_DRAFT_REJECTION_REASONS,
  // T31R-fix-1 の I-2: 画面の型の選択肢が、台帳の登録の ID の取り方に結び付かない組を外すため（下書きの確かめと同じ判定）。
  isUpdatePathBoundToLedger,
  missingVerificationItemsOf,
  // T40a-fix: 送り方ごとの、検証の指定で求める項目（画面の表示も同じ一覧に従う）。
  requiredVerificationItemsOf,
  unconfirmedSideEffectsOf,
  validateScenarioDraft,
  // T41e-2: その型から API のシナリオを作れない理由（候補の一覧の入口で示す。下書きの確かめと同じ判定）。
  apiScenarioShapeRejectionOf,
  // T41e-3: probe の型の要求の送り先（API の更新の台帳の選択肢を絞る確かめの事実）と、台帳の結び付きの唯一の判定。
  apiRequestTargetOfProbe,
  apiUpdateLedgerBindingRejectionOf,
} from './approval/scenario-policy.js';
export type { ScenarioDraftContext, ScenarioDraftError, ScenarioDraftInput, ScenarioDraftRejectionReason } from './approval/scenario-policy.js';

// FM2a（手を減らす段 2 の設計書 3A.2 の「共通化」）: API のシナリオの下書きの入力と案（作成の画面と自動の下書きが共用する純粋な部品）と、選べるかの
// 確かめの下書きの共用の値（副作用の確認はすべて偽、確かめのためだけの台帳の参照と画面の型、更新の指定の入力で直せる理由、ID の区切りの判定）。
export {
  DRAFT_PROBE_LEDGER_SCENARIO_ID,
  DRAFT_PROBE_PATH_TEMPLATE,
  SCENARIO_UPDATE_INPUT_REASONS,
  UNCONFIRMED_SIDE_EFFECTS,
  apiScenarioFormOf,
  isUsableRecordIdSegment,
} from './approval/api-scenario-draft.js';
export type {
  ApiScenarioExistingScenario,
  ApiScenarioFormProposal,
  ApiScenarioKeyFieldProposal,
  ApiScenarioLedgerOption,
  ApiScenarioPageKeyProposal,
} from './approval/api-scenario-draft.js';

// FM2b（手を減らす段 2 の設計書 3A.2。案 2）: シナリオの下書きをボタン 1 回で作る決まり（作る順、`recordId.key` の推し、台帳の結び付けの判定、照合の READ の
// 推し、既にあるものの判定、表示のときの推測の項目の求め直し）と、案の出どころの印の根拠と出どころ。
export {
  AUTO_DRAFT_BLOCKERS,
  AUTO_DRAFT_EXPECTATION_OUTCOMES,
  AUTO_DRAFT_INFERRED_ITEMS,
  AUTO_DRAFT_READ_CHECK_OUTCOMES,
  apiAutoDraftPlanOf,
  apiUpdateDraftPresetOf,
  autoDraftBlockerOf,
  autoDraftExpectationStepOf,
  autoDraftInferredItemsOf,
  autoDraftReadCheckChoiceOf,
  autoDraftReadVerificationOf,
  autoDraftScenarioIdOf,
} from './approval/api-scenario-autodraft.js';
export type {
  AutoDraftBlocker,
  AutoDraftCreatePlan,
  AutoDraftExpectationOutcome,
  AutoDraftReadCheckChoice,
  AutoDraftInferredItem,
  AutoDraftInferredItemKind,
  AutoDraftPlan,
  AutoDraftReadCheckFact,
  AutoDraftReadCheckOutcome,
  AutoDraftScenarioFact,
  AutoDraftUpdatePlan,
  AutoDraftUpdatePreset,
} from './approval/api-scenario-autodraft.js';
export type { DraftValue, DraftValueGround, DraftValueOrigin } from './approval/draft-value-origin.js';

export { APPROVAL_INVALIDITY_REASONS } from './approval/approval-validity.js';
export type { ApprovalInvalidityReason, ApprovalValidity } from './approval/approval-validity.js';

export { APPROVAL_DIGEST_ITEMS, approvalDigestDifferencesOf } from './approval/approval-digest.js';
export type {
  ApprovalDigestDifference,
  ApprovalDigestFacts,
  ApprovalDigestItem,
  ApprovalDigestSubject,
  ApprovalDigestValue,
} from './approval/approval-digest.js';

export {
  COUNTED_WRITE_RESERVATION_STATES,
  EXECUTION_GRANT_REJECTION_REASONS,
  usedCumulativeWrites,
  writeScheduleOf,
} from './approval/execution-grant.js';
export type { ExecutionGrantRejectionReason, WriteSchedule } from './approval/execution-grant.js';

export {
  SCENARIO_STORE_REJECTION_REASONS,
  approveScenario,
  createScenario,
  issueExecutionGrant,
  listScenarios,
  readApprovalReceipts,
  readScenario,
  readScenarioApprovalStatus,
  // T38f: 下書きの確かめの文脈（作成の画面が、保存と同じ文脈で選べる項目と候補の誤りを求める）。
  readScenarioDraftContext,
  readScenarioRevisions,
  // T31e: UPDATE の更新の予定のレコードの ID（読むだけ。開始の画面に出し、発行の予定の ID に渡す）。
  readPlannedUpdateTarget,
  // T41e-2: API の UPDATE の台帳の結び付きの誤り（開始の画面。発行の確かめ直しと同じ部品）。
  readApiUpdateLedgerBindingRejection,
  readUsedCumulativeWrites,
  readWriteReservations,
  revokeScenarioApproval,
  updateScenario,
} from './approval/scenario-store.js';
export type {
  ApprovalExternalFacts,
  ExecutionGrantResult,
  ExecutionGrantView,
  ScenarioApprovalStatus,
  ScenarioRevisionView,
  ScenarioStoreRejectionReason,
  ScenarioStoreResult,
  ScenarioView,
  WriteReservationView,
} from './approval/scenario-store.js';
