/**
 * 書き込みのバンドル（`beaksight-action-bundle_YYYYMMDDHHmmss.zip`）を、ワーカーの報告の組み立てから作る口（Task 32 の設計書 4.1 の ZIP の行と
 * 「決定論の ZIP」。T32f）。
 * - バイト列の組み立て（中身と順、目録、決定論）の唯一の owner は `src/core/action-bundle-bytes.ts`（T32R2 M-2 で移した。親の確かめが同じ手順で組み
 *   立て直して照らすため）。ここは、文字列をファイルに書くのと同じ UTF-8 のバイト列にし、目録の注意の文言（`ACTION_REPORT_TEXT`）を渡す。
 * - JSON は、ArtifactWriter が伏せ字とスキーマを通した文字列（`ArtifactWriter.prepareActionReport` の `text`。ファイルに書くのと同じバイト列）のまま
 *   入れる。組み立て直さない。
 * - `createActionPresentation`: 伏せ字の後の 3 つの文書から、表示用モデル → HTML → バンドルを 1 回だけ組み立てる（バンドルの中の HTML は、書く HTML と
 *   同じ文字列）。
 */
import { actionBundleBytesOf } from '../core/action-bundle-bytes.js';
import { ACTION_REPORT_TEXT } from '../presentation/messages.js';
import { renderActionReport } from './action-report.js';
import { buildActionViewModel, type ActionReportInput } from './action-view-model.js';
import type { PreparedJobDocument } from './artifact-writer.js';

/** 目録の版の印・名前・中身の型（定義は `src/core/action-bundle-bytes.ts`。報告の側から読む口として、ここからも出す）。 */
export { ACTION_BUNDLE_MANIFEST_FILE_NAME, ACTION_BUNDLE_SCHEMA_VERSION, type ActionBundleManifest } from '../core/action-bundle-bytes.js';

/** バンドルの入力（JSON と HTML は、ファイルに書くのと同じ文字列）。 */
export interface ActionBundleInput {
  readonly jobId: string;
  readonly runId: string;
  readonly containsHumanEnteredValues: boolean;
  readonly actionRunJson: string;
  readonly actionEvidenceJson: string;
  readonly approvalSummaryJson: string;
  readonly reportHtml: string;
}

const encoder = new TextEncoder();

/** 書き込みのバンドルの ZIP のバイト列（ファイルは書かない。組み立ては `actionBundleBytesOf`）。 */
export const createActionBundle = (input: ActionBundleInput): Uint8Array => actionBundleBytesOf({
  jobId: input.jobId,
  runId: input.runId,
  containsHumanEnteredValues: input.containsHumanEnteredValues,
  humanEnteredValuesNotice: ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice,
  actionRun: encoder.encode(input.actionRunJson),
  actionEvidence: encoder.encode(input.actionEvidenceJson),
  approvalSummary: encoder.encode(input.approvalSummaryJson),
  reportHtml: encoder.encode(input.reportHtml),
});

/** 表示用モデルの入力の形の、伏せ字の後の 3 つの文書（`ArtifactWriter.prepareActionReport` の結果の形）。 */
export interface PreparedActionReportDocuments {
  readonly actionRun: PreparedJobDocument<ActionReportInput['actionRun']>;
  readonly evidence: PreparedJobDocument<ActionReportInput['evidence']>;
  readonly approvalSummary: PreparedJobDocument<ActionReportInput['approvalSummary']>;
}

/** HTML の報告と、書き込みのバンドルのバイト列。 */
export interface ActionPresentation {
  readonly reportHtml: string;
  readonly bundleBytes: Uint8Array;
}

/** 伏せ字の後の 3 つの文書から、HTML の報告とバンドルを 1 回だけ組み立てる（バンドルの中の HTML は `reportHtml` と同じ）。 */
export const createActionPresentation = (documents: PreparedActionReportDocuments): ActionPresentation => {
  const reportHtml = renderActionReport(buildActionViewModel({
    actionRun: documents.actionRun.value,
    evidence: documents.evidence.value,
    approvalSummary: documents.approvalSummary.value,
  }));
  const evidence = documents.evidence.value;
  return {
    reportHtml,
    bundleBytes: createActionBundle({
      jobId: evidence.jobId,
      runId: evidence.runId,
      containsHumanEnteredValues: evidence.containsHumanEnteredValues,
      actionRunJson: documents.actionRun.text,
      actionEvidenceJson: documents.evidence.text,
      approvalSummaryJson: documents.approvalSummary.text,
      reportHtml,
    }),
  };
};
