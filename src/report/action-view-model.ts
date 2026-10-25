/**
 * 書き込みの報告（`action-report.html`）の表示用モデル（Task 32 の設計書 4.1 の `action-report.html` の行、人の値、1 回だけ組み立てる。T32f）。
 * - 入力は、書き込みのジョブの 3 つの文書（`action-run.json`・`action-evidence.json`・`approval-summary.json`）。値は、ArtifactWriter が伏せ字と
 *   スキーマを通した後のもの（`ArtifactWriter.prepareActionReport` の値。照合の READ の URL は伏せ字の後）。
 * - 入力の型は、ここに置く「描くのに要る項目だけの構造の型」（`src/report/` は `src/control/` の契約の型を読めない。`control-boundary` (a)）。値の
 *   閉じた一覧は、表示のカタログの鍵から導く。契約の文書がこの型に代入できることは、`tests/unit/action-view-model.test.ts` の型の確かめで固定する
 *   （型を書き写さない）。
 * - 表示（ラベル、順、色）はカタログ、文言は `ACTION_REPORT_TEXT`、日時と数は書式の部品（`formatDateTime`・`formatInteger`）から取る。値で分岐しない
 *   （結果や理由を足しても、ここを変えずに描ける。`tests/unit/action-report-changeability.test.ts`）。
 * - 1 回だけ組み立てる。HTML（`action-report.ts`）は、この表示用モデルを描くだけにする。判定はしない（結果と理由は文書のまま）。
 * - T40d（Task 40 の設計書 3.4、3.5）: 版 1.1 の API の要約（証拠の `transport`・`api`）から、API の節（`api`）を組み立てる。送り方のラベルはカタログ
 *   （`SCENARIO_TRANSPORT_CATALOG`）、項目名と文言は `ACTION_REPORT_TEXT.api`。API の要約がない文書（FORM）は `api` が null で、ほかの
 *   値は今までと同じ（HTML も変わらない）。送り方の値で分岐しない（要約があるかで決める）。成否の条件と入力の誤りの条件は報告に出さず、API では
 *   判定のしかたの説明を出す。ページが決める鍵の値は、null の印を「上限を超えたので残していない」、値の全体がない回を「値がない」として示す。
 * - T41e（Task 41 の設計書 3.5）: API の更新は、API の節と更新の前後の差分（`update`。form の更新と同じ組み立て）を両方持つ。値の一覧にないページが決める
 *   鍵は「更新では値を残さない（送る前の値と照らした）」として示す。保つ欄は一致だけを示し、値は出さない。
 */
import { parseCompactUtcTimestamp } from '../core/utc-timestamp.js';
import {
  ACTION_BLOCK_REASON_CATALOG,
  ACTION_OUTCOME_REASON_CATALOG,
  ACTION_RESULT_CATALOG,
  AUTOMATED_ACTION_CATALOG,
  HUMAN_DECISION_CATALOG,
  READ_CHECK_EXPECTATION_KIND_CATALOG,
  READ_CHECK_RESULT_CATALOG,
  RESPONSE_JUDGEMENT_CATALOG,
  SCENARIO_KIND_CATALOG,
  SCENARIO_TRANSPORT_CATALOG,
  SETTLED_RESERVATION_STATE_CATALOG,
  SIDE_EFFECT_CONFIRMATION_CATALOG,
  SUBMISSION_STATE_CATALOG,
  sortByDisplayOrder,
  type DisplaySpec,
} from '../presentation/catalog.js';
import { formatDateTime, formatInteger, formatNotObserved } from '../presentation/format.js';
import { ACTION_REPORT_TEXT, READ_CHECK_DETAIL_DESCRIPTIONS, listText } from '../presentation/messages.js';

// ---------------------------------------------------------------------------------------------------------------
// 入力（描くのに要る項目だけの構造の型）
// ---------------------------------------------------------------------------------------------------------------

type ActionResultValue = keyof typeof ACTION_RESULT_CATALOG;
type ActionOutcomeReasonValue = keyof typeof ACTION_OUTCOME_REASON_CATALOG;
type ScenarioKindValue = keyof typeof SCENARIO_KIND_CATALOG;
type ReadCheckResultValue = keyof typeof READ_CHECK_RESULT_CATALOG;
type SideEffectConfirmationValue = keyof typeof SIDE_EFFECT_CONFIRMATION_CATALOG;

/** `action-run.json` のうち、報告に要る項目。 */
export interface ActionRunReportInput {
  readonly grantId: string;
  readonly reservationState: keyof typeof SETTLED_RESERVATION_STATE_CATALOG;
}

/** UPDATE の証拠の欄 1 つ。 */
export interface ActionUpdateFieldInput {
  readonly fieldName: string;
  readonly role: string;
  readonly previousValue: string | null;
  readonly newValue: string | null;
  readonly matched: boolean | null;
}

/** 照合の READ の期待 1 件と、その結果（期待の種類ごとに、ある項目だけを持つ）。 */
export interface ActionReadExpectationInput {
  readonly expectation: {
    readonly kind: keyof typeof READ_CHECK_EXPECTATION_KIND_CATALOG;
    readonly count?: number;
    readonly text?: string;
    readonly field?: string;
    readonly value?: string;
  };
  readonly result: ReadCheckResultValue;
  readonly observedRowCount?: number | null;
  readonly found?: boolean | null;
  readonly observedValue?: string | null;
}

/** 照合の READ（実行した証拠の全体か、実行しなかった印）。 */
export type ActionReadVerificationInput =
  | {
    readonly state: 'EXECUTED';
    readonly readCheckId: string;
    readonly readCheckRevision: number;
    readonly result: ReadCheckResultValue;
    readonly detail: keyof typeof READ_CHECK_DETAIL_DESCRIPTIONS;
    readonly url: string | null;
    readonly httpStatus: number | null;
    readonly expectations: readonly ActionReadExpectationInput[];
  }
  | { readonly state: 'NOT_EXECUTED'; readonly readCheckId: string; readonly readCheckRevision: number };

/** Guard の数の要約。 */
export interface ActionGuardInput {
  readonly blockedByReason: Readonly<Record<string, number>>;
  readonly blockedByOtherRulesInWindow: number;
  readonly submissionWindowOpen: boolean;
  readonly blockedByPayloadReason: Readonly<Record<string, number>>;
  readonly documentCharsetRead: boolean;
  readonly responseDeliveryCanceled: boolean;
}

/**
 * API の要約（T40d。`action-evidence.json` 1.1 の `api`。契約は `ActionApiSummary`）。ページが決める鍵の値は、JSON の scalar を JSON の文字列にした形で、
 * 上限を超えた値は null の印。照合まで進まなかった回は、値の全体が null。
 */
export interface ActionApiReportInput {
  readonly method: string;
  readonly origin: string;
  readonly pathShape: string;
  readonly shapeDigest: string;
  readonly keyNames: readonly string[];
  readonly pageKeyNames: readonly string[];
  readonly httpFieldNames: readonly string[];
  readonly recordIdKey: string | null;
  readonly pageKeyValues: Readonly<Record<string, string | null>> | null;
}

/** `action-evidence.json` のうち、報告に要る項目。 */
export interface ActionEvidenceReportInput {
  readonly jobId: string;
  readonly runId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly kind: ScenarioKindValue;
  readonly containsHumanEnteredValues: boolean;
  readonly precheck: { readonly candidateDigestMatched: boolean | null; readonly blockReason: keyof typeof ACTION_BLOCK_REASON_CATALOG | null };
  readonly submission: {
    readonly state: keyof typeof SUBMISSION_STATE_CATALOG;
    readonly submittedValues: Readonly<Record<string, string>>;
    readonly actionPath: string | null;
    readonly submittedAt: string | null;
  };
  readonly response: {
    readonly httpStatus: number | null;
    readonly judgement: keyof typeof RESPONSE_JUDGEMENT_CATALOG | null;
    readonly judgedAt: string | null;
  } | null;
  readonly recordId: string | null;
  readonly update: {
    readonly targetRecordId: string;
    readonly updateEvidence: { readonly fields: readonly ActionUpdateFieldInput[] } | null;
  } | null;
  readonly readVerification: ActionReadVerificationInput;
  readonly guard: ActionGuardInput | null;
  readonly result: ActionResultValue;
  readonly reason: ActionOutcomeReasonValue;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** T40d: 送り方と API の要約（FORM の要約は null）。 */
  readonly transport?: keyof typeof SCENARIO_TRANSPORT_CATALOG;
  readonly api?: ActionApiReportInput | null;
}

/** `approval-summary.json` のうち、報告に要る項目。 */
export interface ApprovalSummaryReportInput {
  readonly scenario: { readonly scenarioId: string; readonly revision: number; readonly kind: ScenarioKindValue };
  readonly approval: {
    readonly receiptId: string;
    readonly approvalDigest: string;
    readonly approvedAt: string;
    readonly expiresAt: string;
    readonly approver: string;
  };
  readonly revokedAtStart: boolean;
  readonly inputRuleReference: { readonly ruleSetId: string; readonly revision: number; readonly digest: string } | null;
  readonly limits: { readonly maxCreatesPerRun: number; readonly maxCumulativeCreates: number };
  readonly approvalTtlDays: number;
  readonly sideEffectConfirmations: Readonly<Record<SideEffectConfirmationValue, boolean>>;
  readonly grantAtStart: { readonly grantId: string; readonly issuedAt: string; readonly expiresAt: string; readonly consumedAt: string };
  readonly reservationAtStart: { readonly count: number; readonly reservedAt: string };
  readonly cumulativeAtStart: { readonly used: number; readonly limit: number };
  readonly humanDecisions: readonly (keyof typeof HUMAN_DECISION_CATALOG)[];
  readonly automatedActions: readonly (keyof typeof AUTOMATED_ACTION_CATALOG)[];
  readonly capturedAt: string;
}

/** 表示用モデルの入力（3 つの文書）。 */
export interface ActionReportInput {
  readonly actionRun: ActionRunReportInput;
  readonly evidence: ActionEvidenceReportInput;
  readonly approvalSummary: ApprovalSummaryReportInput;
}

// ---------------------------------------------------------------------------------------------------------------
// 表示用モデル
// ---------------------------------------------------------------------------------------------------------------

/** コードと、その表示（カタログの 1 件。バッジに使う）。 */
export interface CodedView {
  readonly code: string;
  readonly spec: DisplaySpec;
}

/** 項目と値（文字）。 */
export interface LabeledText {
  readonly label: string;
  readonly value: string;
}

export interface UpdateChangedView {
  readonly fieldName: string;
  readonly previousValue: string;
  readonly newValue: string;
  readonly matchedText: string;
}

export interface UpdateKeptView {
  readonly fieldName: string;
  readonly matchedText: string;
}

export interface ReadExpectationView {
  readonly kindLabel: string;
  readonly expectedText: string;
  readonly result: CodedView;
  readonly observedText: string;
}

export interface ReadExecutedView {
  readonly result: CodedView;
  readonly detailText: string;
  readonly url: string | null;
  readonly httpStatusText: string;
  readonly expectations: readonly ReadExpectationView[];
}

export interface ApprovalView {
  readonly atStartNote: string;
  readonly scenarioId: string;
  readonly revisionText: string;
  readonly kind: CodedView;
  readonly receiptId: string;
  readonly approvalDigest: string;
  readonly approvedAtText: string;
  readonly expiresAtText: string;
  readonly approver: string;
  readonly revokedAtStartText: string;
  readonly inputRuleText: string;
  readonly limitsText: string;
  readonly approvalTtlDaysText: string;
  readonly sideEffects: readonly { readonly label: string; readonly confirmedText: string }[];
  readonly grantId: string;
  readonly grantIssuedAtText: string;
  readonly grantExpiresAtText: string;
  readonly grantConsumedAtText: string;
  readonly reservationCountText: string;
  readonly reservedAtText: string;
  readonly cumulativeText: string;
  readonly capturedAtText: string;
  readonly humanDecisions: readonly DisplaySpec[];
  readonly automatedActions: readonly DisplaySpec[];
}

/** ページが決める鍵 1 つと、その値の表示（`kept` が偽なら、値の代わりの文言）。 */
export interface ApiPageKeyView {
  readonly key: string;
  readonly valueText: string;
  readonly kept: boolean;
}

/** API の要約の節（T40d）。 */
export interface ActionApiView {
  readonly transport: CodedView;
  /** 判定のしかたの説明（成否の条件と入力の誤りの条件は使わない）。 */
  readonly judgementNote: string;
  readonly method: string;
  readonly origin: string;
  readonly pathShape: string;
  readonly shapeDigest: string;
  readonly keyNamesText: string;
  readonly httpFieldNamesText: string;
  readonly recordIdKeyText: string;
  readonly pageKeys: readonly ApiPageKeyView[];
}

/** 書き込みの報告の表示用モデル。 */
export interface ActionViewModel {
  readonly title: string;
  readonly notices: {
    /** 人が入れた値が入りうる（先頭に注意を出す）。 */
    readonly humanEnteredValues: boolean;
    /** 結果のお知らせ（`ACTION_REPORT_TEXT.resultNotices` にある結果だけ）。 */
    readonly result: { readonly heading: string; readonly body: string } | null;
  };
  readonly summary: {
    readonly result: CodedView;
    readonly reason: CodedView;
    readonly kind: CodedView;
    readonly jobId: string;
    readonly runId: string;
    readonly scenarioId: string;
    readonly scenarioRevisionText: string;
    readonly grantId: string;
    readonly recordId: string | null;
    readonly reservation: CodedView;
    readonly startedAtText: string;
    readonly finishedAtText: string;
  };
  readonly precheck: { readonly candidateDigestText: string; readonly blockReason: CodedView | null };
  readonly submission: {
    readonly state: CodedView;
    readonly actionPath: string | null;
    readonly submittedAtText: string;
    readonly values: readonly { readonly name: string; readonly value: string }[];
  };
  /** T40d: API の要約の節（API の要約のない文書は null）。 */
  readonly api: ActionApiView | null;
  readonly response: { readonly httpStatusText: string; readonly judgement: CodedView | null; readonly judgedAtText: string } | null;
  readonly update: {
    readonly targetRecordId: string;
    readonly evidenceRecorded: boolean;
    readonly changed: readonly UpdateChangedView[];
    readonly kept: readonly UpdateKeptView[];
  } | null;
  readonly readVerification: { readonly readCheckId: string; readonly revisionText: string; readonly executed: ReadExecutedView | null };
  /** Guard の数と印（書き込みの段に入らなければ null）。0 でない理由ごとの数だけを並べる。 */
  readonly guard: readonly LabeledText[] | null;
  readonly approval: ApprovalView;
}

// ---------------------------------------------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------------------------------------------

/** UPDATE の証拠の、変えた欄の役割。 */
const CHANGED_FIELD_ROLE = 'CHANGED';
/** 照合の READ を実行した証拠の状態。 */
const READ_EXECUTED_STATE = 'EXECUTED';

/** コードと、カタログの表示。 */
const codedOf = <TCode extends string>(catalog: Readonly<Record<TCode, DisplaySpec>>, code: TCode): CodedView => ({ code, spec: catalog[code] });

/** UTC の 14 桁の日時を、表示の書式で示す（null は「なし」。読めない値は、記録されたままの文字を示す）。 */
const timeText = (compact: string | null): string => {
  if (compact === null) {
    return ACTION_REPORT_TEXT.none;
  }
  const date = parseCompactUtcTimestamp(compact);
  return formatDateTime(date === null ? compact : date.toISOString());
};

const booleanText = (value: boolean): string => (value ? ACTION_REPORT_TEXT.yes : ACTION_REPORT_TEXT.no);

/** 照合の一致（照合できなければ、照合できない）。 */
const matchedText = (matched: boolean | null): string => {
  if (matched === null) {
    return ACTION_REPORT_TEXT.undeterminedValue;
  }
  return matched ? ACTION_REPORT_TEXT.matchedValue : ACTION_REPORT_TEXT.notMatchedValue;
};

const candidateDigestText = (matched: boolean | null): string => {
  if (matched === null) {
    return ACTION_REPORT_TEXT.candidateDigest.notChecked;
  }
  return matched ? ACTION_REPORT_TEXT.candidateDigest.matched : ACTION_REPORT_TEXT.candidateDigest.notMatched;
};

/** 結果のお知らせ（文言の表にある結果だけ）。 */
const resultNoticeOf = (result: string): { readonly heading: string; readonly body: string } | null => {
  const notices: Readonly<Record<string, { readonly heading: string; readonly body: string }>> = ACTION_REPORT_TEXT.resultNotices;
  return Object.hasOwn(notices, result) ? notices[result] ?? null : null;
};

/** 期待の中身（行の数、詳細の項目と値、本文の文）。 */
const expectedTextOf = ({ expectation }: ActionReadExpectationInput): string => {
  if (expectation.count !== undefined) {
    return formatInteger(expectation.count);
  }
  if (expectation.field !== undefined && expectation.value !== undefined) {
    return ACTION_REPORT_TEXT.detailExpectation(expectation.field, expectation.value);
  }
  return expectation.text ?? formatNotObserved();
};

/** 読んだ値（数えた行の数、文を含んでいたか、取れた値）。 */
const observedTextOf = (evidence: ActionReadExpectationInput): string => {
  if (evidence.observedRowCount !== undefined) {
    return formatInteger(evidence.observedRowCount);
  }
  if (evidence.found !== undefined) {
    if (evidence.found === null) {
      return formatNotObserved();
    }
    return evidence.found ? ACTION_REPORT_TEXT.found : ACTION_REPORT_TEXT.notFound;
  }
  return evidence.observedValue ?? formatNotObserved();
};

const readVerificationOf = (read: ActionReadVerificationInput): ActionViewModel['readVerification'] => ({
  readCheckId: read.readCheckId,
  revisionText: formatInteger(read.readCheckRevision),
  executed: read.state === READ_EXECUTED_STATE
    ? {
      result: codedOf(READ_CHECK_RESULT_CATALOG, read.result),
      detailText: READ_CHECK_DETAIL_DESCRIPTIONS[read.detail],
      url: read.url,
      httpStatusText: formatInteger(read.httpStatus),
      expectations: read.expectations.map((evidence) => ({
        kindLabel: READ_CHECK_EXPECTATION_KIND_CATALOG[evidence.expectation.kind].label,
        expectedText: expectedTextOf(evidence),
        result: codedOf(READ_CHECK_RESULT_CATALOG, evidence.result),
        observedText: observedTextOf(evidence),
      })),
    }
    : null,
});

/** 0 でない理由ごとの数（記録の順）。 */
const reasonCountsOf = (counts: Readonly<Record<string, number>>, labelOf: (code: string) => string): readonly LabeledText[] =>
  Object.entries(counts).filter(([, count]) => count > 0).map(([code, count]) => ({ label: labelOf(code), value: formatInteger(count) }));

const guardOf = (guard: ActionGuardInput | null): readonly LabeledText[] | null => {
  if (guard === null) {
    return null;
  }
  const labels = ACTION_REPORT_TEXT.guardLabels;
  return [
    { label: labels.blockedByOtherRulesInWindow, value: formatInteger(guard.blockedByOtherRulesInWindow) },
    { label: labels.submissionWindowOpen, value: booleanText(guard.submissionWindowOpen) },
    { label: labels.documentCharsetRead, value: booleanText(guard.documentCharsetRead) },
    { label: labels.responseDeliveryCanceled, value: booleanText(guard.responseDeliveryCanceled) },
    ...reasonCountsOf(guard.blockedByReason, labels.blockedByReason),
    ...reasonCountsOf(guard.blockedByPayloadReason, labels.blockedByPayloadReason),
  ];
};

const updateOf = (update: ActionEvidenceReportInput['update']): ActionViewModel['update'] => {
  if (update === null) {
    return null;
  }
  const fields = update.updateEvidence?.fields ?? [];
  return {
    targetRecordId: update.targetRecordId,
    evidenceRecorded: update.updateEvidence !== null,
    changed: fields.filter((field) => field.role === CHANGED_FIELD_ROLE).map((field) => ({
      fieldName: field.fieldName,
      previousValue: field.previousValue ?? '',
      newValue: field.newValue ?? '',
      matchedText: matchedText(field.matched),
    })),
    kept: fields.filter((field) => field.role !== CHANGED_FIELD_ROLE).map((field) => ({ fieldName: field.fieldName, matchedText: matchedText(field.matched) })),
  };
};

/** 名前の一覧の表示（空なら「なし」）。 */
const namesText = (names: readonly string[]): string => (names.length === 0 ? ACTION_REPORT_TEXT.api.none : listText(names));

/**
 * ページが決める鍵ごとの値の表示（鍵の順は要約のまま）。値の全体がない回（送らなかった、照合まで進まなかった）は「値がない」、null の印は「上限を
 * 超えたので残していない」。
 */
const pageKeysOf = (api: ActionApiReportInput): readonly ApiPageKeyView[] => {
  const values = api.pageKeyValues;
  return api.pageKeyNames.map((key) => {
    if (values === null) {
      return { key, valueText: ACTION_REPORT_TEXT.api.pageKeyValuesNotRecorded, kept: false };
    }
    // T41e: 値の一覧にない鍵は、値を残さない鍵（更新では、送る前の値と照らし、値は残さない。T41c）。
    if (!Object.hasOwn(values, key)) {
      return { key, valueText: ACTION_REPORT_TEXT.api.pageKeyValueNotKeptForUpdate, kept: false };
    }
    const value = values[key] ?? null;
    return value === null ? { key, valueText: ACTION_REPORT_TEXT.api.pageKeyValueCut, kept: false } : { key, valueText: value, kept: true };
  });
};

/** API の要約の節（要約と送り方のない文書は null。送り方の値では分岐しない）。 */
const apiOf = (evidence: ActionEvidenceReportInput): ActionApiView | null => {
  const { api, transport } = evidence;
  if (api === undefined || api === null || transport === undefined) {
    return null;
  }
  return {
    transport: codedOf(SCENARIO_TRANSPORT_CATALOG, transport),
    judgementNote: ACTION_REPORT_TEXT.api.judgementNote,
    method: api.method,
    origin: api.origin,
    pathShape: api.pathShape,
    shapeDigest: api.shapeDigest,
    keyNamesText: namesText(api.keyNames),
    httpFieldNamesText: namesText(api.httpFieldNames),
    recordIdKeyText: api.recordIdKey ?? ACTION_REPORT_TEXT.api.recordIdKeyUnset,
    pageKeys: pageKeysOf(api),
  };
};

const approvalOf = (summary: ApprovalSummaryReportInput): ApprovalView => {
  const rule = summary.inputRuleReference;
  const sideEffectItems = sortByDisplayOrder(
    Object.keys(SIDE_EFFECT_CONFIRMATION_CATALOG) as SideEffectConfirmationValue[],
    SIDE_EFFECT_CONFIRMATION_CATALOG,
  );
  return {
    atStartNote: ACTION_REPORT_TEXT.atStartNote,
    scenarioId: summary.scenario.scenarioId,
    revisionText: formatInteger(summary.scenario.revision),
    kind: codedOf(SCENARIO_KIND_CATALOG, summary.scenario.kind),
    receiptId: summary.approval.receiptId,
    approvalDigest: summary.approval.approvalDigest,
    approvedAtText: timeText(summary.approval.approvedAt),
    expiresAtText: timeText(summary.approval.expiresAt),
    approver: summary.approval.approver,
    revokedAtStartText: booleanText(summary.revokedAtStart),
    inputRuleText: rule === null ? ACTION_REPORT_TEXT.none : ACTION_REPORT_TEXT.inputRuleValue(rule.ruleSetId, formatInteger(rule.revision), rule.digest),
    limitsText: ACTION_REPORT_TEXT.limitsValue(formatInteger(summary.limits.maxCreatesPerRun), formatInteger(summary.limits.maxCumulativeCreates)),
    approvalTtlDaysText: ACTION_REPORT_TEXT.approvalTtlDaysValue(formatInteger(summary.approvalTtlDays)),
    sideEffects: sideEffectItems.map((item) => ({
      label: SIDE_EFFECT_CONFIRMATION_CATALOG[item].label,
      confirmedText: summary.sideEffectConfirmations[item] ? ACTION_REPORT_TEXT.sideEffectConfirmed : ACTION_REPORT_TEXT.sideEffectNotConfirmed,
    })),
    grantId: summary.grantAtStart.grantId,
    grantIssuedAtText: timeText(summary.grantAtStart.issuedAt),
    grantExpiresAtText: timeText(summary.grantAtStart.expiresAt),
    grantConsumedAtText: timeText(summary.grantAtStart.consumedAt),
    reservationCountText: formatInteger(summary.reservationAtStart.count),
    reservedAtText: timeText(summary.reservationAtStart.reservedAt),
    cumulativeText: ACTION_REPORT_TEXT.cumulativeValue(formatInteger(summary.cumulativeAtStart.used), formatInteger(summary.cumulativeAtStart.limit)),
    capturedAtText: timeText(summary.capturedAt),
    humanDecisions: sortByDisplayOrder(summary.humanDecisions, HUMAN_DECISION_CATALOG).map((item) => HUMAN_DECISION_CATALOG[item]),
    automatedActions: sortByDisplayOrder(summary.automatedActions, AUTOMATED_ACTION_CATALOG).map((item) => AUTOMATED_ACTION_CATALOG[item]),
  };
};

/** 書き込みの報告の表示用モデルを、3 つの文書から 1 回だけ組み立てる（同じ入力からは同じ値）。 */
export const buildActionViewModel = (input: ActionReportInput): ActionViewModel => {
  const { actionRun, evidence, approvalSummary } = input;
  const { submission, response } = evidence;
  return {
    title: ACTION_REPORT_TEXT.title,
    notices: { humanEnteredValues: evidence.containsHumanEnteredValues, result: resultNoticeOf(evidence.result) },
    summary: {
      result: codedOf(ACTION_RESULT_CATALOG, evidence.result),
      reason: codedOf(ACTION_OUTCOME_REASON_CATALOG, evidence.reason),
      kind: codedOf(SCENARIO_KIND_CATALOG, evidence.kind),
      jobId: evidence.jobId,
      runId: evidence.runId,
      scenarioId: evidence.scenarioId,
      scenarioRevisionText: formatInteger(evidence.scenarioRevision),
      grantId: actionRun.grantId,
      recordId: evidence.recordId,
      reservation: codedOf(SETTLED_RESERVATION_STATE_CATALOG, actionRun.reservationState),
      startedAtText: timeText(evidence.startedAt),
      finishedAtText: timeText(evidence.finishedAt),
    },
    precheck: {
      candidateDigestText: candidateDigestText(evidence.precheck.candidateDigestMatched),
      blockReason: evidence.precheck.blockReason === null ? null : codedOf(ACTION_BLOCK_REASON_CATALOG, evidence.precheck.blockReason),
    },
    submission: {
      state: codedOf(SUBMISSION_STATE_CATALOG, submission.state),
      actionPath: submission.actionPath,
      submittedAtText: timeText(submission.submittedAt),
      values: Object.entries(submission.submittedValues).map(([name, value]) => ({ name, value })),
    },
    api: apiOf(evidence),
    response: response === null
      ? null
      : {
        httpStatusText: formatInteger(response.httpStatus),
        judgement: response.judgement === null ? null : codedOf(RESPONSE_JUDGEMENT_CATALOG, response.judgement),
        judgedAtText: timeText(response.judgedAt),
      },
    update: updateOf(evidence.update),
    readVerification: readVerificationOf(evidence.readVerification),
    guard: guardOf(evidence.guard),
    approval: approvalOf(approvalSummary),
  };
};
