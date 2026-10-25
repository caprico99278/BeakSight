// T32f: 書き込みの報告の 3 つの文書（`action-run.json`・`action-evidence.json`・`approval-summary.json`）の見本（テストのファイルではない）。表示用
// モデル・HTML・バンドル・ArtifactWriter の単体のテストが使う。どれも契約の型のまま作り、スキーマに合う形にする。値は匿名の合成のテストデータだけ
// （`example.invalid`）。結果ごとの見本（照合済みの CREATE・UPDATE、送らずに止めた回、結果が分からない回、照合できていない回）を置く。
// T32k（CC-090）: 成果物のスキーマのテスト（`action-run-schema`・`action-evidence-schema`）も、ここの見本を元に、確かめる項目だけを上書きする。
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  ACTION_RUN_SCHEMA_VERSION,
  type ActionEvidenceDocument,
  type ActionRunDocument,
  type ApprovalSummaryDocument,
} from '../../src/control/actions/action-contracts.js';
import { sampleApprovalSummary } from './approval-facts-sample.js';

/** 3 つの文書の組。 */
export interface ActionReportDocuments {
  readonly actionRun: ActionRunDocument;
  readonly evidence: ActionEvidenceDocument;
  readonly approvalSummary: ApprovalSummaryDocument;
}

const JOB_ID = 'job-report';
const RUN_ID = 'RUN-20261015010000';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** 照合の READ を実行した回の証拠（READ の確かめの成果物の 1 件と同じ形）。 */
export type ExecutedReadVerification = Extract<ActionEvidenceDocument['readVerification'], { readonly state: 'EXECUTED' }>;

/** 照合の READ を実行して一致した回の証拠の見本（行の数の期待 1 つ。人の値を持たない）。確かめる項目だけを上書きできる。 */
export const sampleExecutedRead = (overrides: Partial<ExecutedReadVerification> = {}): ExecutedReadVerification => ({
  readCheckId: 'rc-verify',
  readCheckRevision: 1,
  targetKind: 'CANDIDATE',
  targetIdentityDigest: DIGEST,
  state: 'EXECUTED',
  result: 'MATCHED',
  detail: 'EXPECTATIONS_EVALUATED',
  url: 'http://127.0.0.1:4173/members?q=%E3%82%B5',
  httpStatus: 200,
  blockedRequests: 0,
  structure: {
    region: 'MAIN', tables: 1, tableRowCounts: [1], lists: 0, listItemCounts: [], detailFields: 0, textLength: 40, limitReached: false, settled: true,
  },
  expectations: [
    { expectation: { kind: 'ROW_COUNT_EQUALS', count: 1 }, result: 'MATCHED', undeterminedReason: null, rowSource: 'TABLE', observedRowCount: 1 },
  ],
  ...overrides,
});

/** 照合済みの CREATE（`VERIFIED`）。 */
export const verifiedCreateDocuments = (): ActionReportDocuments => {
  const actionRun: ActionRunDocument = {
    schemaVersion: ACTION_RUN_SCHEMA_VERSION,
    jobId: JOB_ID,
    runId: RUN_ID,
    profileId: 'example-write',
    scenarioId: 'scenario-w',
    scenarioRevision: 1,
    grantId: 'grant-w',
    seedRecord: {
      seed: 'd'.repeat(64) as ActionRunDocument['seedRecord']['seed'],
      seedInput: { profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, ruleSetDigest: DIGEST, executionGrantId: 'grant-w' },
      baseDate: '2026-10-15',
      attempt: 0,
    },
    submittedValues: { name: 'サンプル 太郎', email: 'sample0001@example.invalid' },
    resultConditions: { successCondition: { pathPrefix: '/members/', selector: '.registered' }, inputErrorCondition: { pathPrefix: '/members/new', selector: null } },
    submission: 'SENT',
    blockReason: null,
    httpStatus: 200,
    responseJudgement: 'SUCCESS',
    recordId: '1001',
    readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, result: 'MATCHED' },
    reservationState: 'COMMITTED',
    result: 'VERIFIED',
    reason: 'READ_VERIFICATION_MATCHED',
    startedAt: '20261015010000',
    submittedAt: '20261015010010',
    finishedAt: '20261015010030',
    // T40c: 版 1.1 の送り方と API の要約（FORM は null）。
    transport: 'FORM',
    api: null,
  };
  const evidence: ActionEvidenceDocument = {
    schemaVersion: ACTION_EVIDENCE_SCHEMA_VERSION,
    jobId: JOB_ID,
    runId: RUN_ID,
    profileId: 'example-write',
    scenarioId: 'scenario-w',
    scenarioRevision: 1,
    kind: 'CREATE',
    containsHumanEnteredValues: false,
    precheck: { candidateDigestMatched: true, blockReason: null },
    submission: { state: 'SENT', submittedValues: actionRun.submittedValues, actionPath: '/members', submittedAt: '20261015010010' },
    response: { httpStatus: 200, judgement: 'SUCCESS', judgedAt: '20261015010012' },
    recordId: '1001',
    update: null,
    readVerification: sampleExecutedRead(),
    guard: {
      blockedByReason: { OUTSIDE_ALLOWED_ORIGINS: 0, SUBMISSION_WINDOW: 0, SUBMISSION_WINDOW_BROWSER_FAVICON: 1 },
      blockedByOtherRulesInWindow: 0,
      submissionWindowOpen: false,
      blockedByPayloadReason: { VALUE_MISMATCH: 0 },
      documentCharsetRead: true,
      responseDeliveryCanceled: false,
    },
    result: 'VERIFIED',
    reason: 'READ_VERIFICATION_MATCHED',
    startedAt: '20261015010000',
    finishedAt: '20261015010030',
    transport: 'FORM',
    api: null,
  };
  const approvalSummary = sampleApprovalSummary(
    { kind: 'CREATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' },
    { jobId: JOB_ID, runId: RUN_ID },
  );
  return { actionRun, evidence, approvalSummary };
};

/** 照合済みの UPDATE（変えた欄の前の値は人の値でありうる。照合の READ の取れた値も持つ）。 */
export const verifiedUpdateDocuments = (): ActionReportDocuments => {
  const base = verifiedCreateDocuments();
  const update = {
    targetRecordId: '1001',
    updateEvidence: {
      fields: [
        { fieldName: 'name', role: 'CHANGED' as const, previousValue: '前の 名前', newValue: '新しい 名前', matched: true },
        { fieldName: 'email', role: 'KEPT' as const, previousValue: null, newValue: null, matched: true },
      ],
    },
  };
  return {
    actionRun: { ...base.actionRun, submittedValues: { name: '新しい 名前' }, update },
    evidence: {
      ...base.evidence,
      kind: 'UPDATE',
      containsHumanEnteredValues: true,
      submission: { ...base.evidence.submission, submittedValues: { name: '新しい 名前' }, actionPath: '/members/1001' },
      update,
      readVerification: sampleExecutedRead({
        expectations: [
          { expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', value: '新しい 名前' }, result: 'MATCHED', undeterminedReason: null, observedValue: '新しい 名前' },
          { expectation: { kind: 'TEXT_CONTAINS', text: '新しい 名前' }, result: 'MATCHED', undeterminedReason: null, found: true },
        ],
      }),
    },
    approvalSummary: sampleApprovalSummary(
      { kind: 'UPDATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' },
      { jobId: base.actionRun.jobId, runId: base.actionRun.runId },
    ),
  };
};

/** 送らずに止めた回（`BLOCKED`。送る中身の照合で止めた）。 */
export const blockedDocuments = (): ActionReportDocuments => {
  const base = verifiedCreateDocuments();
  return {
    actionRun: {
      ...base.actionRun, submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, responseJudgement: null, recordId: null,
      readVerification: null, reservationState: 'RELEASED', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH', submittedAt: null,
    },
    evidence: {
      ...base.evidence,
      precheck: { candidateDigestMatched: true, blockReason: 'PAYLOAD_MISMATCH' },
      submission: { state: 'NOT_SENT', submittedValues: {}, actionPath: null, submittedAt: null },
      response: null,
      recordId: null,
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, state: 'NOT_EXECUTED' },
      result: 'BLOCKED',
      reason: 'PAYLOAD_MISMATCH',
    },
    approvalSummary: base.approvalSummary,
  };
};

/** 送ったが結果が分からない回（`UNKNOWN`。応答がない）。 */
export const unknownDocuments = (): ActionReportDocuments => {
  const base = verifiedCreateDocuments();
  return {
    actionRun: {
      ...base.actionRun, httpStatus: null, responseJudgement: null, recordId: null, readVerification: null, reservationState: 'UNKNOWN', result: 'UNKNOWN',
      reason: 'NO_RESPONSE',
    },
    evidence: {
      ...base.evidence,
      response: { httpStatus: null, judgement: null, judgedAt: null },
      recordId: null,
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, state: 'NOT_EXECUTED' },
      result: 'UNKNOWN',
      reason: 'NO_RESPONSE',
    },
    approvalSummary: base.approvalSummary,
  };
};

/** 成功の画面に当たったが照合できていない回（`PARTIAL`。登録の ID が取れない）。 */
export const partialDocuments = (): ActionReportDocuments => {
  const base = verifiedCreateDocuments();
  return {
    actionRun: { ...base.actionRun, recordId: null, readVerification: null, result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' },
    evidence: {
      ...base.evidence,
      recordId: null,
      readVerification: { readCheckId: 'rc-verify', readCheckRevision: 1, state: 'NOT_EXECUTED' },
      result: 'PARTIAL',
      reason: 'RECORD_ID_NOT_FOUND',
    },
    approvalSummary: base.approvalSummary,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// T40c（Task 40 の設計書 3.4）: 版 1.1 の API の登録の見本と、前の版（1.0）の見本
// ---------------------------------------------------------------------------------------------------------------

/** API の見本の送り先の Origin と path の型（匿名の合成の値）。 */
export const SAMPLE_API_ORIGIN = 'http://127.0.0.2:4174';
export const SAMPLE_API_PATH = '/rest/v1/members';
export const SAMPLE_API_SHAPE_DIGEST = `sha256:${'b'.repeat(64)}`;

/** API の要約の見本（照合の型と同じ鍵。ページが決める鍵の値は、JSON の scalar を文字列にした形）。 */
export const sampleApiSummary = (overrides: Partial<NonNullable<ActionRunDocument['api']>> = {}): NonNullable<ActionRunDocument['api']> => ({
  method: 'POST',
  origin: SAMPLE_API_ORIGIN,
  pathShape: SAMPLE_API_PATH,
  shapeDigest: SAMPLE_API_SHAPE_DIGEST,
  keyNames: ['email', 'name'],
  pageKeyNames: ['tenant_id'],
  httpFieldNames: ['x-client-info'],
  recordIdKey: 'id',
  pageKeyValues: { tenant_id: '"tenant-1"' },
  ...overrides,
});

/** 照合済みの API の登録（`VERIFIED`。成否の条件は持たない）。 */
export const verifiedApiCreateDocuments = (): ActionReportDocuments => {
  const base = verifiedCreateDocuments();
  const api = sampleApiSummary();
  return {
    actionRun: { ...base.actionRun, resultConditions: null, httpStatus: 201, transport: 'API', api },
    evidence: {
      ...base.evidence,
      submission: { ...base.evidence.submission, actionPath: SAMPLE_API_PATH },
      response: { httpStatus: 201, judgement: 'SUCCESS', judgedAt: '20261015010012' },
      transport: 'API',
      api,
    },
    approvalSummary: base.approvalSummary,
  };
};

/** 送らずに止めた API の登録（`BLOCKED`。ページが決める鍵の値は読めていない）。 */
export const blockedApiDocuments = (): ActionReportDocuments => {
  const base = blockedDocuments();
  const api = sampleApiSummary({ pageKeyValues: null });
  return {
    actionRun: { ...base.actionRun, resultConditions: null, transport: 'API', api },
    evidence: { ...base.evidence, transport: 'API', api },
    approvalSummary: base.approvalSummary,
  };
};

/**
 * T41e（Task 41 の設計書 3.5）: 照合済みの API の更新（`VERIFIED`。API の要約と更新の前後の差分の両方を持つ）。変える鍵は `name`、保つ鍵は `email`
 * （保つ欄は値を持たない）。ページが決める鍵の値は、更新では残さない（送る前の値と照らす。T41c）ので空。成否の条件は持たない。
 */
export const verifiedApiUpdateDocuments = (): ActionReportDocuments => {
  const base = verifiedUpdateDocuments();
  const api = sampleApiSummary({ method: 'PATCH', keyNames: ['name'], recordIdKey: null, pageKeyValues: {} });
  return {
    actionRun: { ...base.actionRun, resultConditions: null, transport: 'API', api },
    evidence: {
      ...base.evidence,
      submission: { ...base.evidence.submission, actionPath: SAMPLE_API_PATH },
      transport: 'API',
      api,
    },
    approvalSummary: base.approvalSummary,
  };
};
