/**
 * 書き込みの報告の HTML（`action-report.html`。Task 32 の設計書 4.1 の `action-report.html` の行。T32f）。
 * - 入力は、表示用モデル（`buildActionViewModel` の結果）だけ。判定と組み立てはしない（値は表示用モデルのまま描く）。
 * - HTML のタグを書かない。`html-components.ts` の部品（`renderDocument`・`renderSection`・`renderTable`・`renderKeyValueList`・`renderBadge` など）を
 *   組み合わせるだけにする（GATE-UI03）。値は部品がエスケープする。見た目は `html-tokens.ts` のクラスだけ（GATE-UI02）。
 * - 日本語の文言は `ACTION_REPORT_TEXT` と表示のカタログから取る（GATE-UI06）。結果や理由の値の文字列を書かない（値で分岐しない）。
 * - 先頭に注意を置く: 人が入れた値が入りうるとき（`notices.humanEnteredValues`）と、結果のお知らせ（`UNKNOWN`・`PARTIAL` など。文言の表にある結果）。
 * - 照合の READ の URL は、リンクにせず文字で示す（`renderUrlAsText`。1 回のクリックで要求を送らせない）。
 * - 同じ入力からは、同じ文字列を返す（時刻や乱数を使わない）。ファイルは書かない（書くのは ArtifactWriter）。
 */
import { ACTION_REPORT_NOTICE_CATALOG } from '../presentation/catalog.js';
import { ACTION_REPORT_TEXT } from '../presentation/messages.js';
import type { ActionViewModel, CodedView, LabeledText } from './action-view-model.js';
import {
  htmlText,
  renderBadge,
  renderCode,
  renderDocument,
  renderKeyValueList,
  renderMutedText,
  renderParagraph,
  renderReferenceList,
  renderSection,
  renderTable,
  renderTableRow,
  renderUrlAsText,
  type HtmlContent,
  type SafeHtml,
} from './html-components.js';

type Fragment = SafeHtml<'fragment'>;

/** 節の見出しの `id`（文書の中のアンカー）。 */
const SECTION_ANCHORS = Object.freeze({
  notices: 'action-notices',
  summary: 'action-summary',
  precheck: 'action-precheck',
  submission: 'action-submission',
  response: 'action-response',
  update: 'action-update',
  readVerification: 'action-read-verification',
  guard: 'action-guard',
  approval: 'action-approval',
  decisions: 'action-decisions',
} as const);

/** 節の見出しの階層（`<h2>`）。 */
const SECTION_LEVEL = 2;
/** 節の中の小見出しの階層（`<h3>`）。 */
const SUBSECTION_LEVEL = 3;

/** 人の値の注意のバッジ（カタログの鍵。`data-value` にも入れる）。 */
const HUMAN_ENTERED_VALUES_NOTICE = 'HUMAN_ENTERED_VALUES' satisfies keyof typeof ACTION_REPORT_NOTICE_CATALOG;

const badgeOf = (view: CodedView): Fragment => renderBadge(view.spec, view.code);

/** 値がなければ「なし」を薄く示す。 */
const optionalCode = (value: string | null): HtmlContent => (value === null ? renderMutedText(ACTION_REPORT_TEXT.none) : renderCode(value));

const section = (key: keyof typeof SECTION_ANCHORS, content: readonly Fragment[]): Fragment =>
  renderSection({ level: SECTION_LEVEL, label: ACTION_REPORT_TEXT.sections[key], anchorId: SECTION_ANCHORS[key], content });

const labeledList = (entries: readonly LabeledText[]): Fragment => renderKeyValueList(entries.map(({ label, value }) => ({ label, value })));

/** 先頭の注意（人の値、結果のお知らせ）。どちらもなければ節を置かない。 */
const noticesOf = (model: ActionViewModel): readonly Fragment[] => {
  const parts: Fragment[] = [];
  if (model.notices.humanEnteredValues) {
    parts.push(
      renderParagraph(renderBadge(ACTION_REPORT_NOTICE_CATALOG[HUMAN_ENTERED_VALUES_NOTICE], HUMAN_ENTERED_VALUES_NOTICE)),
      renderParagraph(htmlText(ACTION_REPORT_TEXT.humanEnteredValuesHeading)),
      renderParagraph(ACTION_REPORT_TEXT.humanEnteredValuesBody),
    );
  }
  if (model.notices.result !== null) {
    parts.push(
      renderParagraph(badgeOf(model.summary.result)),
      renderParagraph(htmlText(model.notices.result.heading)),
      renderParagraph(model.notices.result.body),
    );
  }
  return parts.length === 0 ? [] : [section('notices', parts)];
};

const summaryOf = ({ summary }: ActionViewModel): Fragment => {
  const labels = ACTION_REPORT_TEXT.labels;
  return section('summary', [renderKeyValueList([
    { label: labels.result, value: badgeOf(summary.result) },
    { label: labels.reason, value: badgeOf(summary.reason) },
    { label: labels.kind, value: badgeOf(summary.kind) },
    { label: labels.recordId, value: optionalCode(summary.recordId) },
    { label: labels.reservation, value: badgeOf(summary.reservation) },
    { label: labels.job, value: renderCode(summary.jobId) },
    { label: labels.run, value: renderCode(summary.runId) },
    { label: labels.scenario, value: renderCode(summary.scenarioId) },
    { label: labels.revision, value: summary.scenarioRevisionText },
    { label: labels.grant, value: renderCode(summary.grantId) },
    { label: labels.startedAt, value: summary.startedAtText },
    { label: labels.finishedAt, value: summary.finishedAtText },
  ])]);
};

const precheckOf = ({ precheck }: ActionViewModel): Fragment => section('precheck', [renderKeyValueList([
  { label: ACTION_REPORT_TEXT.labels.candidateDigest, value: precheck.candidateDigestText },
  { label: ACTION_REPORT_TEXT.labels.blockReason, value: precheck.blockReason === null ? renderMutedText(ACTION_REPORT_TEXT.none) : badgeOf(precheck.blockReason) },
])]);

const submissionOf = ({ submission }: ActionViewModel): Fragment => section('submission', [
  renderKeyValueList([
    { label: ACTION_REPORT_TEXT.labels.submission, value: badgeOf(submission.state) },
    { label: ACTION_REPORT_TEXT.labels.actionPath, value: optionalCode(submission.actionPath) },
    { label: ACTION_REPORT_TEXT.labels.submittedAt, value: submission.submittedAtText },
  ]),
  renderTable({
    caption: ACTION_REPORT_TEXT.submittedValuesHeading,
    columns: [ACTION_REPORT_TEXT.valueColumns.field, ACTION_REPORT_TEXT.valueColumns.value],
    rows: submission.values.map(({ name, value }) => renderTableRow([renderCode(name), value])),
    emptyText: ACTION_REPORT_TEXT.noSubmittedValues,
  }),
]);

const responseOf = ({ response }: ActionViewModel): Fragment => section('response', response === null
  ? [renderParagraph(renderMutedText(ACTION_REPORT_TEXT.none))]
  : [renderKeyValueList([
    { label: ACTION_REPORT_TEXT.labels.httpStatus, value: response.httpStatusText },
    { label: ACTION_REPORT_TEXT.labels.judgement, value: response.judgement === null ? renderMutedText(ACTION_REPORT_TEXT.none) : badgeOf(response.judgement) },
    { label: ACTION_REPORT_TEXT.labels.judgedAt, value: response.judgedAtText },
  ])]);

/** UPDATE の前後の差分（UPDATE だけ。CREATE は節を置かない）。 */
const updateOf = ({ update }: ActionViewModel): readonly Fragment[] => {
  if (update === null) {
    return [];
  }
  const columns = ACTION_REPORT_TEXT.diffColumns;
  return [section('update', [
    renderKeyValueList([{ label: ACTION_REPORT_TEXT.labels.target, value: renderCode(update.targetRecordId) }]),
    renderParagraph(ACTION_REPORT_TEXT.diffNote),
    ...(update.evidenceRecorded
      ? [
        renderTable({
          caption: ACTION_REPORT_TEXT.changedDiffHeading,
          columns: [columns.field, columns.previous, columns.next, columns.matched],
          rows: update.changed.map((field) => renderTableRow([renderCode(field.fieldName), field.previousValue, field.newValue, field.matchedText])),
          emptyText: ACTION_REPORT_TEXT.none,
        }),
        renderTable({
          caption: ACTION_REPORT_TEXT.keptDiffHeading,
          columns: [columns.field, columns.matched],
          rows: update.kept.map((field) => renderTableRow([renderCode(field.fieldName), field.matchedText])),
          emptyText: ACTION_REPORT_TEXT.none,
        }),
      ]
      : [renderParagraph(renderMutedText(ACTION_REPORT_TEXT.noUpdateEvidence))]),
  ])];
};

const readVerificationOf = ({ readVerification }: ActionViewModel): Fragment => {
  const { executed } = readVerification;
  const labels = ACTION_REPORT_TEXT.labels;
  const identity = { label: labels.readCheck, value: htmlText(`${readVerification.readCheckId} / ${readVerification.revisionText}`) };
  if (executed === null) {
    return section('readVerification', [renderKeyValueList([identity]), renderParagraph(renderMutedText(ACTION_REPORT_TEXT.readNotExecuted))]);
  }
  const columns = ACTION_REPORT_TEXT.expectationColumns;
  return section('readVerification', [
    renderKeyValueList([
      identity,
      { label: labels.readResult, value: badgeOf(executed.result) },
      { label: labels.readDetail, value: executed.detailText },
      { label: labels.readUrl, value: executed.url === null ? renderMutedText(ACTION_REPORT_TEXT.none) : renderUrlAsText(executed.url) },
      { label: labels.httpStatus, value: executed.httpStatusText },
    ]),
    renderTable({
      caption: ACTION_REPORT_TEXT.expectationsHeading,
      columns: [columns.kind, columns.expected, columns.result, columns.observed],
      rows: executed.expectations.map((expectation) =>
        renderTableRow([expectation.kindLabel, expectation.expectedText, badgeOf(expectation.result), expectation.observedText])),
      emptyText: ACTION_REPORT_TEXT.none,
    }),
  ]);
};

const guardOf = ({ guard }: ActionViewModel): Fragment =>
  section('guard', [guard === null ? renderParagraph(renderMutedText(ACTION_REPORT_TEXT.noGuard)) : labeledList(guard)]);

const approvalOf = ({ approval }: ActionViewModel): Fragment => {
  const labels = ACTION_REPORT_TEXT.labels;
  return section('approval', [
    renderParagraph(approval.atStartNote),
    renderKeyValueList([
      { label: labels.scenario, value: renderCode(approval.scenarioId) },
      { label: labels.revision, value: approval.revisionText },
      { label: labels.kind, value: badgeOf(approval.kind) },
      { label: labels.receipt, value: renderCode(approval.receiptId) },
      { label: labels.approvalDigest, value: renderCode(approval.approvalDigest) },
      { label: labels.approvedAt, value: approval.approvedAtText },
      { label: labels.expiresAt, value: approval.expiresAtText },
      { label: labels.approver, value: renderCode(approval.approver) },
      { label: labels.revokedAtStart, value: approval.revokedAtStartText },
      { label: labels.inputRule, value: approval.inputRuleText },
      { label: labels.limits, value: approval.limitsText },
      { label: labels.approvalTtlDays, value: approval.approvalTtlDaysText },
      { label: labels.grant, value: renderCode(approval.grantId) },
      { label: labels.grantIssuedAt, value: approval.grantIssuedAtText },
      { label: labels.grantExpiresAt, value: approval.grantExpiresAtText },
      { label: labels.grantConsumedAt, value: approval.grantConsumedAtText },
      { label: labels.reservationCount, value: approval.reservationCountText },
      { label: labels.reservedAt, value: approval.reservedAtText },
      { label: labels.cumulative, value: approval.cumulativeText },
      { label: labels.capturedAt, value: approval.capturedAtText },
    ]),
    renderTable({
      caption: ACTION_REPORT_TEXT.sideEffectsHeading,
      columns: [ACTION_REPORT_TEXT.sideEffectColumns.item, ACTION_REPORT_TEXT.sideEffectColumns.confirmed],
      rows: approval.sideEffects.map((item) => renderTableRow([item.label, item.confirmedText])),
      emptyText: ACTION_REPORT_TEXT.none,
    }),
  ]);
};

const decisionsOf = ({ approval }: ActionViewModel): Fragment => section('decisions', [
  renderSection({
    level: SUBSECTION_LEVEL,
    label: ACTION_REPORT_TEXT.humanDecisionsHeading,
    anchorId: `${SECTION_ANCHORS.decisions}-human`,
    content: [renderReferenceList(approval.humanDecisions.map((spec) => htmlText(spec.label)))],
  }),
  renderSection({
    level: SUBSECTION_LEVEL,
    label: ACTION_REPORT_TEXT.automatedActionsHeading,
    anchorId: `${SECTION_ANCHORS.decisions}-automated`,
    content: [renderReferenceList(approval.automatedActions.map((spec) => htmlText(spec.label)))],
  }),
]);

/** 書き込みの報告の HTML（静的な文書。改行は LF、末尾に改行を 1 つ）。 */
export const renderActionReport = (model: ActionViewModel): string => renderDocument({
  title: model.title,
  content: [
    ...noticesOf(model),
    summaryOf(model),
    precheckOf(model),
    submissionOf(model),
    responseOf(model),
    ...updateOf(model),
    readVerificationOf(model),
    guardOf(model),
    approvalOf(model),
    decisionsOf(model),
  ],
});
