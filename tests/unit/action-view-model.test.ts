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
  SCENARIO_TRANSPORT_CATALOG,
  SCENARIO_VERIFICATION_ITEM_CATALOG,
} from '../../src/presentation/catalog.js';
import { formatDateTime, formatInteger } from '../../src/presentation/format.js';
import { ACTION_REPORT_TEXT, listText } from '../../src/presentation/messages.js';
import { buildActionViewModel, type ActionReportInput } from '../../src/report/action-view-model.js';
import {
  SAMPLE_API_ORIGIN,
  SAMPLE_API_PATH,
  SAMPLE_API_SHAPE_DIGEST,
  blockedApiDocuments,
  blockedDocuments,
  partialDocuments,
  sampleApiSummary,
  unknownDocuments,
  verifiedApiCreateDocuments,
  verifiedApiUpdateDocuments,
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

// T40d（Task 40 の設計書 3.4、3.5、7 章の履歴の「T40a の報告（API の検証の指定）」「T40c の報告」）: 版 1.1 の API の要約の節。
// - 送り方（カタログのラベル）、method、送り先の Origin と path の型、型の digest、送る鍵、許すヘッダの名前、登録の ID の鍵、ページが決める鍵とその値。
// - ページが決める鍵の値の null の印は「上限を超えたので残していない」、送らなかった回（値の全体が null）は「値がない」。
// - 成否の条件と入力の誤りの条件は出さず、「API では応答の状態と ID で判定する」旨の説明を出す。
// - FORM の文書（1.0 と 1.1）は API の節を持たず、2 つの版の表示用モデルは同じ。
/** T41e: 保つ欄の値の目印（記録の形に入れても、表示用モデルに入らないことを確かめる）。 */
const KEPT_VALUE_MARKER = 'kept-value-t41e';

/** T41e: 保つ欄に値の目印を入れた API の UPDATE（契約の形では保つ欄は値を持たない。表示が値を拾わないことの確かめ）。 */
const verifiedApiUpdateWithKeptMarker = (): ActionReportDocuments => {
  const documents = verifiedApiUpdateDocuments();
  const update = documents.evidence.update;
  if (update === null || update.updateEvidence === null) {
    throw new Error('the API update sample has no update evidence');
  }
  const fields = update.updateEvidence.fields.map((field) => (field.role === 'KEPT' ? { ...field, previousValue: KEPT_VALUE_MARKER, newValue: KEPT_VALUE_MARKER } : field));
  return { ...documents, evidence: { ...documents.evidence, update: { ...update, updateEvidence: { fields } } } };
};

describe('action report view model of an API write (T40d)', () => {
  const apiText = ACTION_REPORT_TEXT.api;

  it('builds the API section from the summary of the evidence of 1.1', () => {
    const model = modelOf(verifiedApiCreateDocuments());
    expect(model.api).toEqual({
      transport: { code: 'API', spec: SCENARIO_TRANSPORT_CATALOG.API },
      judgementNote: apiText.judgementNote,
      method: 'POST',
      origin: SAMPLE_API_ORIGIN,
      pathShape: SAMPLE_API_PATH,
      shapeDigest: SAMPLE_API_SHAPE_DIGEST,
      keyNamesText: listText(['email', 'name']),
      httpFieldNamesText: listText(['x-client-info']),
      recordIdKeyText: 'id',
      pageKeys: [{ key: 'tenant_id', valueText: '"tenant-1"', kept: true }],
    });
    // 送信の結果（応答の状態と判定）、登録の ID、照合の READ の結果は、今の節の値のまま描ける。
    expect(model.response).toMatchObject({ httpStatusText: formatInteger(201), judgement: { code: 'SUCCESS' } });
    expect(model.summary.recordId).toBe('1001');
    expect(model.readVerification.executed?.result.code).toBe('MATCHED');
  });

  it('shows a cut page key value as not kept over the limit, and no values for a run that was not sent', () => {
    const base = verifiedApiCreateDocuments();
    const api = sampleApiSummary({ pageKeyNames: ['source', 'tenant_id'], pageKeyValues: { source: '7', tenant_id: null } });
    const cut = modelOf({ ...base, actionRun: { ...base.actionRun, api }, evidence: { ...base.evidence, api } });
    expect(cut.api?.pageKeys).toEqual([
      { key: 'source', valueText: '7', kept: true },
      { key: 'tenant_id', valueText: apiText.pageKeyValueCut, kept: false },
    ]);
    const blocked = modelOf(blockedApiDocuments());
    expect(blocked.api?.pageKeys).toEqual([{ key: 'tenant_id', valueText: apiText.pageKeyValuesNotRecorded, kept: false }]);
    expect(blocked.response).toBeNull();
  });

  it('shows no page key and the unset record ID key with the texts of the catalog', () => {
    const base = verifiedApiCreateDocuments();
    const api = sampleApiSummary({ pageKeyNames: [], pageKeyValues: {}, httpFieldNames: [], recordIdKey: null });
    const model = modelOf({ ...base, actionRun: { ...base.actionRun, api }, evidence: { ...base.evidence, api } });
    expect(model.api).toMatchObject({ pageKeys: [], httpFieldNamesText: apiText.none, recordIdKeyText: apiText.recordIdKeyUnset });
  });

  it('does not show the success and input error conditions of an API write, and tells how an API write is judged', () => {
    // 条件の値（FORM の見本の path とセレクタ）を記録に残したままの文書でも、表示用モデルに条件は入らない。条件の項目の説明も入らない。
    const base = verifiedApiCreateDocuments();
    const conditions = verifiedCreateDocuments().actionRun.resultConditions;
    const text = JSON.stringify(modelOf({ ...base, actionRun: { ...base.actionRun, resultConditions: conditions } }));
    expect(text).toContain(JSON.stringify(apiText.judgementNote));
    for (const value of ['/members/new', '.registered']) {
      expect(text, value).not.toContain(value);
    }
    for (const item of [SCENARIO_VERIFICATION_ITEM_CATALOG.successCondition, SCENARIO_VERIFICATION_ITEM_CATALOG.inputErrorCondition]) {
      expect(text).not.toContain(item.description);
    }
  });

  // T41e（Task 41 の設計書 3.5）: API の UPDATE は、API の要約と更新の前後の差分の両方を持つ。保つ欄の値は出さない。ページが決める鍵の値は、更新では
  // 残さない（送る前の値と照らす）ので、値の全体がない回とも上限の印とも違う文言で示す。
  it('builds both the API section and the update diff of an API update, without the values of the kept fields', () => {
    const model = modelOf(verifiedApiUpdateWithKeptMarker());
    expect(model.api).toMatchObject({ transport: { code: 'API' }, keyNamesText: listText(['name']) });
    expect(model.api?.pageKeys).toEqual([{ key: 'tenant_id', valueText: apiText.pageKeyValueNotKeptForUpdate, kept: false }]);
    expect(model.update).toEqual({
      targetRecordId: '1001',
      evidenceRecorded: true,
      changed: [{ fieldName: 'name', previousValue: '前の 名前', newValue: '新しい 名前', matchedText: ACTION_REPORT_TEXT.matchedValue }],
      kept: [{ fieldName: 'email', matchedText: ACTION_REPORT_TEXT.matchedValue }],
    });
    expect(model.summary.kind.code).toBe('UPDATE');
    // 保つ欄の値は、記録の形に入っていても表示用モデルに入らない。
    expect(JSON.stringify(model)).not.toContain(KEPT_VALUE_MARKER);
  });

  it.each<readonly [string, () => ActionReportDocuments]>([
    ['a verified create', verifiedCreateDocuments],
    ['a verified update', verifiedUpdateDocuments],
    ['a blocked run', blockedDocuments],
    ['an unknown run', unknownDocuments],
    ['a partial run', partialDocuments],
  ])('keeps the FORM view of %s: no API section', (_label, documents) => {
    expect(modelOf(documents()).api).toBeNull();
  });
});
