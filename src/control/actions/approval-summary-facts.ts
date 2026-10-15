// 書き込みの報告の承認の要約の事実（`ApprovalSummaryFacts`）を組み立てる純粋な部品（Task 32 の設計書 4.1 の「承認の要約の受け渡し」。T32d）。
// - ジョブの管理（`src/control/job/audit-job-manager.ts` の書き込みの準備）が、実行の許可を消費した直後に、消費の結果・許可の版のシナリオ・承認の
//   記録の一覧・累積の使った件数を渡して呼び、`START` の `write.approvalFacts` に入れる。ワーカーは照らさずに `approval-summary.json` に書き写す。
// - 承認の判断はしない（有効かどうかは消費 `consumeExecutionGrant` が判定済み。承認の SSOT は `src/control/approval/`）。ここは、渡された事実を、
//   開始の時点の値として写すだけ。事実どうしが食い違う（消費していない、許可とシナリオと承認の記録の組が違う、許可の承認の記録がない）ときは、
//   null を返す（呼び出し側は書き込みを始めない。fail-closed）。
// - 撤回の有無は、許可が結ぶ承認の記録を撤回した記録があるか（ほかの承認の撤回は数えない）。
// - 人と自動の一覧は、契約の閉じた一覧（`HUMAN_DECISIONS`・`AUTOMATED_ACTIONS`）を、シナリオの種類で絞る（CREATE は UPDATE だけの項目を除く）。
// - 秘密（資格情報、Cookie、CSRF、hidden の値、認証の状態）と人の名前を持たない（承認者は固定の `LOCAL_OPERATOR`）。
// - 置き場所: 組み立てる形（契約）の owner の `action-contracts.ts` の隣（`src/control/actions/`）。承認の判定の部品（`src/control/approval/`）に置くと、
//   報告の形が承認の SSOT に入り込むため。管理データ・画面・ブラウザ・ワーカーに触れない。
import { deepFreeze } from '../../core/immutable.js';
import type { ApprovalReceipt, ApprovalReceiptRecord, ScenarioKind, ScenarioRevision } from '../approval/scenario-contracts.js';
import {
  AUTOMATED_ACTIONS,
  HUMAN_DECISIONS,
  UPDATE_ONLY_AUTOMATED_ACTIONS,
  UPDATE_ONLY_HUMAN_DECISIONS,
  type ApprovalSummaryFacts,
  type AutomatedAction,
  type HumanDecision,
} from './action-contracts.js';

/** UPDATE のシナリオの種類（UPDATE だけの項目を含める）。 */
const UPDATE_KIND = 'UPDATE' satisfies ScenarioKind;
/** 承認の記録の種類（承認と撤回）。 */
const APPROVAL_RECEIPT_KIND = 'APPROVAL' satisfies ApprovalReceiptRecord['kind'];
const REVOCATION_RECEIPT_KIND = 'REVOCATION' satisfies ApprovalReceiptRecord['kind'];

/**
 * 消費した実行の許可の、要約に要る項目（`scenario-store.ts` の `ExecutionGrantView` の部分。保存の部品の型に依らないよう、形だけを受ける）。
 */
export interface ConsumedGrantFacts {
  readonly grantId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly approvalReceiptId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** 消費の時刻（消費していなければ null。そのときは要約を作らない）。 */
  readonly consumedAt: string | null;
  readonly reservation: { readonly count: number; readonly reservedAt: string };
}

/** 組み立ての入力（どれも、許可の消費の直後に読んだ値）。 */
export interface ApprovalSummaryFactsInputs {
  /** 消費の結果の許可と予約。 */
  readonly grant: ConsumedGrantFacts;
  /** 許可の版のシナリオ。 */
  readonly scenario: ScenarioRevision;
  /** シナリオの承認と撤回の記録（追記の順）。 */
  readonly receipts: readonly ApprovalReceiptRecord[];
  /** 累積の使った件数（この許可の予約を含む。`readUsedCumulativeWrites`）。 */
  readonly usedCumulativeWrites: number;
  /** 開始の時点の値を読んだ時刻（UTC の 14 桁。消費の時刻）。 */
  readonly capturedAt: string;
}

/** 種類に当たる項目だけ（CREATE は UPDATE だけの項目を除く。一覧の順のまま）。 */
const itemsForKind = <Item extends string>(items: readonly Item[], updateOnly: readonly Item[], kind: ScenarioKind): readonly Item[] =>
  items.filter((item) => kind === UPDATE_KIND || !updateOnly.includes(item));

/** 許可が結ぶ承認の記録（シナリオ・版・プロファイルが許可と同じもの。なければ null）。 */
const boundApprovalOf = (inputs: ApprovalSummaryFactsInputs): ApprovalReceipt | null => {
  const { grant } = inputs;
  const receipt = inputs.receipts.find((record) => record.receiptId === grant.approvalReceiptId);
  return receipt?.kind === APPROVAL_RECEIPT_KIND
    && receipt.scenarioId === grant.scenarioId
    && receipt.scenarioRevision === grant.scenarioRevision
    && receipt.profileId === grant.profileId
    ? receipt
    : null;
};

/**
 * 開始の時点の承認の要約の事実（凍結）。事実どうしが食い違えば null（上の説明）。値の範囲（件数、期限の日数など）はここで確かめない（`START` の
 * 契約のスキーマが確かめる）。
 */
export const approvalSummaryFactsOf = (inputs: ApprovalSummaryFactsInputs): ApprovalSummaryFacts | null => {
  const { grant, scenario } = inputs;
  if (grant.consumedAt === null
    || grant.scenarioId !== scenario.scenarioId
    || grant.scenarioRevision !== scenario.revision
    || grant.profileId !== scenario.profileId) {
    return null;
  }
  const approval = boundApprovalOf(inputs);
  if (approval === null) {
    return null;
  }
  const revokedAtStart = inputs.receipts.some((record) => record.kind === REVOCATION_RECEIPT_KIND && record.targetReceiptId === approval.receiptId);
  const humanDecisions: readonly HumanDecision[] = itemsForKind(HUMAN_DECISIONS, UPDATE_ONLY_HUMAN_DECISIONS, scenario.kind);
  const automatedActions: readonly AutomatedAction[] = itemsForKind(AUTOMATED_ACTIONS, UPDATE_ONLY_AUTOMATED_ACTIONS, scenario.kind);
  // 入力の値（承認の記録の bound、シナリオの上限など）を凍結しないよう、写しを凍結する。
  return deepFreeze(structuredClone({
    profileId: scenario.profileId,
    scenario: { scenarioId: scenario.scenarioId, revision: scenario.revision, kind: scenario.kind },
    approval: {
      receiptId: approval.receiptId,
      approvalDigest: approval.approvalDigest,
      bound: approval.bound,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      approver: approval.approver,
    },
    revokedAtStart,
    inputRuleReference: scenario.inputRuleReference,
    limits: scenario.limits,
    approvalTtlDays: scenario.approvalTtlDays,
    sideEffectConfirmations: scenario.sideEffectConfirmations,
    grantAtStart: { grantId: grant.grantId, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, consumedAt: grant.consumedAt },
    reservationAtStart: { count: grant.reservation.count, reservedAt: grant.reservation.reservedAt },
    cumulativeAtStart: { used: inputs.usedCumulativeWrites, limit: scenario.limits.maxCumulativeCreates },
    humanDecisions,
    automatedActions,
    capturedAt: inputs.capturedAt,
  } satisfies ApprovalSummaryFacts));
};
