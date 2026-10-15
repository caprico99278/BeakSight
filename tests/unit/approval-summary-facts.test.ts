// T32d（Task 32 の設計書 4.1 の「承認の要約の受け渡し」）: 親が実行の許可を消費した後に、`START` の `write.approvalFacts`（書き込みの報告の
// 承認の要約の事実）を組み立てる純粋な関数（`src/control/actions/approval-summary-facts.ts`）。
// - 値は開始の時点のもの: 消費した許可（発行・期限・消費の時刻、予約の件数と時刻）、許可が結ぶ承認の記録（bound を含む）、許可の版のシナリオ
//   （種類・上限・期限の日数・副作用の確認・入力の規則の参照）、撤回の記録の有無、消費の直後の累積の件数。
// - 承認の判断はしない（有効かどうかは消費が判定済み）。事実どうしが食い違う（許可と承認の記録とシナリオの組が違う、消費していない）ときは null。
// - 人と自動の一覧は、シナリオの種類で絞る。秘密と人の名前を持たない。成果物のスキーマ（`approval-summary`）の事実の形を通る。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  AUTOMATED_ACTIONS,
  HUMAN_DECISIONS,
  type ApprovalSummaryDocument,
} from '../../src/control/actions/action-contracts.js';
import { approvalSummaryFactsOf, type ApprovalSummaryFactsInputs } from '../../src/control/actions/approval-summary-facts.js';
import { APPROVER_LOCAL_OPERATOR } from '../../src/control/approval/scenario-contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { PROFILE_ID, sampleApproval, sampleRevocation, sampleScenario, sampleUpdateScenario } from './approval-samples.js';

const APPROVAL_DIGEST = `sha256:${'9'.repeat(64)}`;

/** 消費した許可（`ExecutionGrantView` の要る項目）。 */
const consumedGrant = (overrides: Partial<ApprovalSummaryFactsInputs['grant']> = {}): ApprovalSummaryFactsInputs['grant'] => ({
  grantId: 'grant-1',
  profileId: PROFILE_ID,
  scenarioId: 'scenario-1',
  scenarioRevision: 3,
  approvalReceiptId: 'receipt-1',
  issuedAt: '20261015000000',
  expiresAt: '20261015000500',
  consumedAt: '20261015000005',
  reservation: { count: 1, reservedAt: '20261015000000' },
  ...overrides,
});

const inputsOf = (overrides: Partial<ApprovalSummaryFactsInputs> = {}): ApprovalSummaryFactsInputs => ({
  grant: consumedGrant(),
  scenario: sampleScenario(),
  receipts: [sampleApproval(APPROVAL_DIGEST)],
  usedCumulativeWrites: 4,
  capturedAt: '20261015000005',
  ...overrides,
});

/** 成果物の文書にする（ワーカーが足す 3 つの項目を足す）。 */
const documentOf = (facts: unknown): ApprovalSummaryDocument => ({
  ...(facts as ApprovalSummaryDocument),
  schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-000001',
});

describe('approvalSummaryFactsOf (T32d)', () => {
  it('copies the values at the start for a CREATE scenario', async () => {
    const facts = approvalSummaryFactsOf(inputsOf());
    const approval = sampleApproval(APPROVAL_DIGEST);
    expect(facts).toEqual({
      profileId: PROFILE_ID,
      scenario: { scenarioId: 'scenario-1', revision: 3, kind: 'CREATE' },
      approval: {
        receiptId: approval.receiptId,
        approvalDigest: APPROVAL_DIGEST,
        bound: approval.bound,
        approvedAt: approval.approvedAt,
        expiresAt: approval.expiresAt,
        approver: APPROVER_LOCAL_OPERATOR,
      },
      revokedAtStart: false,
      inputRuleReference: sampleScenario().inputRuleReference,
      limits: sampleScenario().limits,
      approvalTtlDays: sampleScenario().approvalTtlDays,
      sideEffectConfirmations: sampleScenario().sideEffectConfirmations,
      grantAtStart: { grantId: 'grant-1', issuedAt: '20261015000000', expiresAt: '20261015000500', consumedAt: '20261015000005' },
      reservationAtStart: { count: 1, reservedAt: '20261015000000' },
      cumulativeAtStart: { used: 4, limit: sampleScenario().limits.maxCumulativeCreates },
      humanDecisions: ['SCENARIO_APPROVAL', 'INPUT_RULES', 'LIMITS', 'SIDE_EFFECT_CONFIRMATIONS'],
      automatedActions: ['VALUE_GENERATION', 'SUBMISSION', 'RESULT_JUDGEMENT', 'READ_VERIFICATION'],
      capturedAt: '20261015000005',
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(await validateArtifact('approval-summary', documentOf(facts))).toEqual({ ok: true });
  });

  it('lists every decision and every automatic action for an UPDATE scenario', async () => {
    const facts = approvalSummaryFactsOf(inputsOf({ scenario: sampleUpdateScenario() }));
    expect(facts?.scenario.kind).toBe('UPDATE');
    expect(facts?.humanDecisions).toEqual([...HUMAN_DECISIONS]);
    expect(facts?.automatedActions).toEqual([...AUTOMATED_ACTIONS]);
    expect(await validateArtifact('approval-summary', documentOf(facts))).toEqual({ ok: true });
  });

  it('marks a revocation of the approval of the grant that is recorded at the start', () => {
    expect(approvalSummaryFactsOf(inputsOf({ receipts: [sampleApproval(APPROVAL_DIGEST), sampleRevocation()] }))?.revokedAtStart).toBe(true);
    // ほかの承認の撤回は数えない。
    expect(approvalSummaryFactsOf(inputsOf({
      receipts: [sampleApproval(APPROVAL_DIGEST, { receiptId: 'receipt-0' }), sampleRevocation({ targetReceiptId: 'receipt-0' }), sampleApproval(APPROVAL_DIGEST)],
    }))?.revokedAtStart).toBe(false);
  });

  it('takes the approval record that the grant binds, not the latest one', () => {
    const facts = approvalSummaryFactsOf(inputsOf({
      receipts: [sampleApproval(APPROVAL_DIGEST), sampleApproval(`sha256:${'8'.repeat(64)}`, { receiptId: 'receipt-9', approvedAt: '20261014000000' })],
    }));
    expect(facts?.approval.receiptId).toBe('receipt-1');
    expect(facts?.approval.approvalDigest).toBe(APPROVAL_DIGEST);
  });

  it('has no property for a secret or a person name', () => {
    const text = JSON.stringify(approvalSummaryFactsOf(inputsOf())).toLowerCase();
    for (const word of ['password', 'cookie', 'token', 'csrf', 'hidden', 'session', 'username', 'credential']) {
      expect(text.includes(`"${word}`), word).toBe(false);
    }
  });

  it.each<readonly [string, Partial<ApprovalSummaryFactsInputs>]>([
    ['a grant that is not consumed', { grant: consumedGrant({ consumedAt: null }) }],
    ['a grant of another scenario', { grant: consumedGrant({ scenarioId: 'scenario-2' }) }],
    ['a grant of another revision', { grant: consumedGrant({ scenarioRevision: 2 }) }],
    ['a grant of another profile', { grant: consumedGrant({ profileId: 'other-profile' }) }],
    ['no approval record of the grant', { receipts: [sampleApproval(APPROVAL_DIGEST, { receiptId: 'receipt-0' })] }],
    ['an approval record of another revision', { receipts: [sampleApproval(APPROVAL_DIGEST, { scenarioRevision: 2 })] }],
    ['an approval record of another scenario', { receipts: [sampleApproval(APPROVAL_DIGEST, { scenarioId: 'scenario-2' })] }],
    ['a revocation with the id of the grant record', { receipts: [sampleRevocation({ receiptId: 'receipt-1' })] }],
  ])('returns null for %s (the facts do not agree)', (_label, overrides) => {
    expect(approvalSummaryFactsOf(inputsOf(overrides))).toBeNull();
  });
});
