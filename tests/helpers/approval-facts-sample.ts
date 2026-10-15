// T32d: `START` の書き込みの指定の承認の要約（`write.approvalFacts`）の例（テストのファイルではない）。IPC の契約のテスト、ワーカーのテスト、書き込みの
// 流れの結合のテストが、書き込みの指定のシナリオ・版・許可・プロファイル・種類に合わせて使う。値は匿名の合成のテストデータだけ。
// T32k（CC-090）: 文書の `approval-summary.json` の例（事実にワーカーが足す `schemaVersion`・`jobId`・`runId`）も、ここの 1 か所で作る。
import {
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  AUTOMATED_ACTIONS,
  HUMAN_DECISIONS,
  UPDATE_ONLY_AUTOMATED_ACTIONS,
  UPDATE_ONLY_HUMAN_DECISIONS,
  type ApprovalSummaryDocument,
  type ApprovalSummaryFacts,
} from '../../src/control/actions/action-contracts.js';
import { APPROVER_LOCAL_OPERATOR, type ScenarioKind } from '../../src/control/approval/scenario-contracts.js';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const RULE_DIGEST = `sha256:${'f'.repeat(64)}`;
const UPDATE_KIND: ScenarioKind = 'UPDATE';

/** 例の承認の要約を結び付ける書き込みの指定の値。 */
export interface ApprovalFactsSampleKeys {
  readonly kind: ScenarioKind;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly grantId: string;
}

/** 開始の時点の承認の要約の例（`kind` で、人と自動の一覧を絞る）。 */
export const sampleApprovalFacts = (keys: ApprovalFactsSampleKeys): ApprovalSummaryFacts => ({
  profileId: keys.profileId,
  scenario: { scenarioId: keys.scenarioId, revision: keys.scenarioRevision, kind: keys.kind },
  approval: {
    receiptId: 'receipt-1',
    approvalDigest: FINGERPRINT,
    bound: {
      profileRevision: 1,
      authSetupDigest: FINGERPRINT,
      targetConfigDigest: 'c'.repeat(64),
      candidateIdentityDigest: FINGERPRINT,
      candidateRuleDigest: FINGERPRINT,
      inputRuleReference: { ruleSetId: 'rules-1', revision: 1, digest: RULE_DIGEST },
    },
    approvedAt: '20261014000000',
    expiresAt: '20261113000000',
    approver: APPROVER_LOCAL_OPERATOR,
  },
  revokedAtStart: false,
  inputRuleReference: { ruleSetId: 'rules-1', revision: 1, digest: RULE_DIGEST },
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  sideEffectConfirmations: { TEST_RECORDS_ONLY: true, NO_EXTERNAL_NOTIFICATION: true, NO_PAYMENT_OR_EXTERNAL_SERVICE: true, NOT_DESTRUCTIVE: true },
  grantAtStart: { grantId: keys.grantId, issuedAt: '20261015000000', expiresAt: '20261015000500', consumedAt: '20261015000005' },
  reservationAtStart: { count: 1, reservedAt: '20261015000000' },
  cumulativeAtStart: { used: 1, limit: 20 },
  humanDecisions: HUMAN_DECISIONS.filter((item) => keys.kind === UPDATE_KIND || !(UPDATE_ONLY_HUMAN_DECISIONS as readonly string[]).includes(item)),
  automatedActions: AUTOMATED_ACTIONS.filter((item) => keys.kind === UPDATE_KIND || !(UPDATE_ONLY_AUTOMATED_ACTIONS as readonly string[]).includes(item)),
  capturedAt: '20261015000005',
});

/** 例の承認の要約の文書を結び付けるジョブと Run。 */
export interface ApprovalSummarySampleIds {
  readonly jobId: string;
  readonly runId: string;
}

/** 開始の時点の承認の要約の文書の例（`sampleApprovalFacts` に、ワーカーが足す項目を足す）。 */
export const sampleApprovalSummary = (keys: ApprovalFactsSampleKeys, ids: ApprovalSummarySampleIds): ApprovalSummaryDocument => ({
  ...sampleApprovalFacts(keys),
  schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION,
  jobId: ids.jobId,
  runId: ids.runId,
});
