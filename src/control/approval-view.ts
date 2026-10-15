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
  // T30g: 検証の指定の入力と表示、連続の上限の表示。
  MAX_WRITES_PER_DAY,
  MIN_WRITE_INTERVAL_MS,
  RECORD_ID_SOURCES,
  SCENARIO_VERIFICATION_ITEMS,
  VERIFICATION_EXPECTATION_KINDS,
  // T31h-1: UPDATE の指定の path の型の、レコードの ID の区切りの印（画面に `'{id}'` を書き写さない）。
  RECORD_ID_PLACEHOLDER,
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
} from './approval/scenario-contracts.js';

export {
  SCENARIO_DRAFT_REJECTION_REASONS,
  // T31R-fix-1 の I-2: 画面の型の選択肢が、台帳の登録の ID の取り方に結び付かない組を外すため（下書きの確かめと同じ判定）。
  isUpdatePathBoundToLedger,
  missingVerificationItemsOf,
  unconfirmedSideEffectsOf,
  validateScenarioDraft,
} from './approval/scenario-policy.js';
export type { ScenarioDraftError, ScenarioDraftInput, ScenarioDraftRejectionReason } from './approval/scenario-policy.js';

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
  readScenarioRevisions,
  // T31e: UPDATE の更新の予定のレコードの ID（読むだけ。開始の画面に出し、発行の予定の ID に渡す）。
  readPlannedUpdateTarget,
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
