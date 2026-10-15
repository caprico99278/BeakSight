// T32f（Task 32 の設計書 4.1 の `action-report.html` の行、人の値、1 回だけ組み立てる）: 書き込みの報告の表示用モデル
// （`src/report/action-view-model.ts` の `buildActionViewModel`）。
// - 入力は 3 つの文書（`action-run.json`・`action-evidence.json`・`approval-summary.json`）。`src/report/` は契約の型を読めない
//   （`control-boundary` (a)）ので、入力の型は `src/report/` の中の「描くのに要る項目だけの構造の型」。契約の文書がその型に代入できることを、
//   ここの型の確かめで固定する（typecheck で落ちる）。
// - 値の表示（ラベル、色）はカタログから、文言は `ACTION_REPORT_TEXT` から、日時と数は書式の部品から取る。
// - 結果ごと（CREATE・UPDATE・`BLOCKED`・`UNKNOWN`・`PARTIAL`）の形、人の値の注意、承認の要約が開始の時点の値であることの明示。
import { describe, expect, it } from 'vitest';
import type { ActionEvidenceDocument, ActionRunDocument, ApprovalSummaryDocument } from '../../src/control/actions/action-contracts.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  AUTOMATED_ACTION_CATALOG,
  HUMAN_DECISION_CATALOG,
  SCENARIO_KIND_CATALOG,
} from '../../src/presentation/catalog.js';
import { formatDateTime, formatInteger } from '../../src/presentation/format.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import { buildActionViewModel, type ActionReportInput } from '../../src/report/action-view-model.js';
import {
  blockedDocuments,
  partialDocuments,
  unknownDocuments,
  verifiedCreateDocuments,
  verifiedUpdateDocuments,
  type ActionReportDocuments,
} from '../helpers/action-report-samples.js';

/** 契約の文書は、表示用モデルの入力の型にそのまま代入できる（型を書き写していないことの確かめ。typecheck で落ちる）。 */
const inputOf = (actionRun: ActionRunDocument, evidence: ActionEvidenceDocument, approvalSummary: ApprovalSummaryDocument): ActionReportInput =>
  ({ actionRun, evidence, approvalSummary });

const modelOf = (documents: ActionReportDocuments) => buildActionViewModel(inputOf(documents.actionRun, documents.evidence, documents.approvalSummary));

const timeText = (compact: string): string => formatDateTime(dateOfCompactUtcTimestamp(compact).toISOString());

describe('action report view model (T32f)', () => {
  it('builds a verified CREATE from the catalogs, the texts and the formatters', () => {
    const documents = verifiedCreateDocuments();
    const model = modelOf(documents);
    expect(model.title).toBe(ACTION_REPORT_TEXT.title);
    expect(model.notices).toEqual({ humanEnteredValues: false, result: null });
    expect(model.summary).toMatchObject({
      result: { code: 'VERIFIED', spec: ACTION_RESULT_CATALOG.VERIFIED },
      reason: { code: 'READ_VERIFICATION_MATCHED', spec: ACTION_OUTCOME_REASON_CATALOG.READ_VERIFICATION_MATCHED },
      kind: { code: 'CREATE', spec: SCENARIO_KIND_CATALOG.CREATE },
      jobId: 'job-report', runId: 'RUN-20261015010000', scenarioId: 'scenario-w', scenarioRevisionText: formatInteger(1), grantId: 'grant-w',
      recordId: '1001', startedAtText: timeText('20261015010000'), finishedAtText: timeText('20261015010030'),
    });
    expect(model.precheck).toEqual({ candidateDigestText: ACTION_REPORT_TEXT.candidateDigest.matched, blockReason: null });
    expect(model.submission).toMatchObject({
      state: { code: 'SENT' }, actionPath: '/members', submittedAtText: timeText('20261015010010'),
      values: [{ name: 'name', value: 'サンプル 太郎' }, { name: 'email', value: 'sample0001@example.invalid' }],
    });
    expect(model.response).toMatchObject({ httpStatusText: formatInteger(200), judgement: { code: 'SUCCESS' }, judgedAtText: timeText('20261015010012') });
    expect(model.update).toBeNull();
    expect(model.readVerification).toMatchObject({
      readCheckId: 'rc-verify', revisionText: formatInteger(1),
      executed: { result: { code: 'MATCHED' }, url: 'http://127.0.0.1:4173/members?q=%E3%82%B5', httpStatusText: formatInteger(200),
        expectations: [{ expectedText: formatInteger(1), result: { code: 'MATCHED' }, observedText: formatInteger(1) }] },
    });
    expect(model.guard).not.toBeNull();
    // 0 でない理由ごとの数だけを示す（0 の理由は並べない）。
    expect(model.guard?.filter((entry) => entry.label.includes('SUBMISSION_WINDOW_BROWSER_FAVICON'))).toHaveLength(1);
    expect(model.guard?.some((entry) => entry.label.includes('VALUE_MISMATCH'))).toBe(false);
  });

  it('marks the approval summary as the values at the start, and lists what a person decided and what BeakSight did by kind', () => {
    const create = modelOf(verifiedCreateDocuments()).approval;
    expect(create.atStartNote).toBe(ACTION_REPORT_TEXT.atStartNote);
    expect(create.kind).toEqual({ code: 'CREATE', spec: SCENARIO_KIND_CATALOG.CREATE });
    expect(create.humanDecisions).toEqual([
      HUMAN_DECISION_CATALOG.SCENARIO_APPROVAL, HUMAN_DECISION_CATALOG.INPUT_RULES, HUMAN_DECISION_CATALOG.LIMITS,
      HUMAN_DECISION_CATALOG.SIDE_EFFECT_CONFIRMATIONS,
    ]);
    expect(create.automatedActions).toEqual([
      AUTOMATED_ACTION_CATALOG.VALUE_GENERATION, AUTOMATED_ACTION_CATALOG.SUBMISSION, AUTOMATED_ACTION_CATALOG.RESULT_JUDGEMENT,
      AUTOMATED_ACTION_CATALOG.READ_VERIFICATION,
    ]);
    expect(create).toMatchObject({
      approver: 'LOCAL_OPERATOR', revokedAtStartText: ACTION_REPORT_TEXT.no, cumulativeText: ACTION_REPORT_TEXT.cumulativeValue(formatInteger(1), formatInteger(20)),
      capturedAtText: timeText('20261015000005'), grantConsumedAtText: timeText('20261015000005'),
    });
    expect(create.sideEffects.every((item) => item.confirmedText === ACTION_REPORT_TEXT.sideEffectConfirmed)).toBe(true);
    const update = modelOf(verifiedUpdateDocuments()).approval;
    expect(update.humanDecisions).toContain(HUMAN_DECISION_CATALOG.UPDATE_FIELD_ROLES);
    expect(update.automatedActions).toContain(AUTOMATED_ACTION_CATALOG.TARGET_RECORD_SELECTION);
  });

  it('builds a verified UPDATE with the prior and new values, the kept fields, the READ values and the human value notice', () => {
    const model = modelOf(verifiedUpdateDocuments());
    expect(model.notices.humanEnteredValues).toBe(true);
    expect(model.update).toEqual({
      targetRecordId: '1001',
      evidenceRecorded: true,
      changed: [{ fieldName: 'name', previousValue: '前の 名前', newValue: '新しい 名前', matchedText: ACTION_REPORT_TEXT.matchedValue }],
      kept: [{ fieldName: 'email', matchedText: ACTION_REPORT_TEXT.matchedValue }],
    });
    expect(model.readVerification.executed?.expectations).toEqual([
      expect.objectContaining({ expectedText: ACTION_REPORT_TEXT.detailExpectation('氏名', '新しい 名前'), observedText: '新しい 名前' }),
      expect.objectContaining({ expectedText: '新しい 名前', observedText: ACTION_REPORT_TEXT.found }),
    ]);
  });

  it('builds a blocked run with no sent value, no response and no executed READ', () => {
    const model = modelOf(blockedDocuments());
    expect(model.summary.result).toEqual({ code: 'BLOCKED', spec: ACTION_RESULT_CATALOG.BLOCKED });
    expect(model.precheck.blockReason?.code).toBe('PAYLOAD_MISMATCH');
    expect(model.submission).toMatchObject({ state: { code: 'NOT_SENT' }, actionPath: null, values: [], submittedAtText: ACTION_REPORT_TEXT.none });
    expect(model.response).toBeNull();
    expect(model.readVerification.executed).toBeNull();
    expect(model.notices.result).toBeNull();
  });

  it.each<readonly [string, () => ActionReportDocuments, 'UNKNOWN' | 'PARTIAL']>([
    ['an unknown result', unknownDocuments, 'UNKNOWN'],
    ['a partial result', partialDocuments, 'PARTIAL'],
  ])('puts the notice of %s at the top', (_label, documents, result) => {
    const model = modelOf(documents());
    expect(model.notices.result).toEqual(ACTION_REPORT_TEXT.resultNotices[result]);
    expect(model.summary.result.spec).toBe(ACTION_RESULT_CATALOG[result]);
  });

  it('shows a response without a status as not observed, without making it 0', () => {
    const model = modelOf(unknownDocuments());
    expect(model.response).toEqual({ httpStatusText: formatInteger(null), judgement: null, judgedAtText: ACTION_REPORT_TEXT.none });
  });
});
