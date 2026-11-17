/**
 * 監査の報告の小さなまとめ（`report-summary.json`。`schemas/report-summary.schema.json`）の中身の唯一の owner（PL-R。設計書
 * `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、13 章の 13）。
 * - 報告（`report.html`）と同じ表示用モデル（`buildReportViewModel` の結果）の `overview` と `summary` を写すだけにする（数え直さない。GATE-UI04）。
 * - 画面の作業の画面は、大きな `audit.json` を読まずに、これを読んで「問題が 2 件見つかりました」を出す。
 * - 持つのは、件数と Run の ID と Run Status だけ（URL・文言・サイトの値を持たない）。
 * - ファイルは書かない。書くのは `ArtifactWriter.writePresentation` だけである（ARCH08）。
 */
import { artifactJsonBytes } from '../core/artifact-json.js';
import type { RunId, RunStatus, Severity } from '../core/contracts.js';
import type { ReportViewModel } from './view-model.js';

/** スキーマの版（`schemas/report-summary.schema.json` の `schemaVersion`）。 */
export const REPORT_SUMMARY_SCHEMA_VERSION = 'report-summary-schema/1.0';

/** 報告の小さなまとめ。 */
export interface ReportSummaryDocument {
  readonly schemaVersion: typeof REPORT_SUMMARY_SCHEMA_VERSION;
  readonly runId: RunId;
  readonly runStatus: RunStatus;
  /** 問題の数（サイト品質の Finding の数。表示用モデルの `overview.problemCount`）。 */
  readonly problemCount: number;
  /** severity ごとの Finding の数（表示用モデルの `summary.findingCounts.bySeverity`）。 */
  readonly findingCounts: Readonly<Record<Severity, number>>;
  /** 最後まで見られなかったページの数（表示用モデルの `overview.notFullyCheckedPageCount`）。 */
  readonly notFullyCheckedPageCount: number;
}

/** 表示用モデルから、報告の小さなまとめを作る（写すだけ）。 */
export const reportSummaryDocumentOf = (viewModel: ReportViewModel): ReportSummaryDocument => ({
  schemaVersion: REPORT_SUMMARY_SCHEMA_VERSION,
  runId: viewModel.summary.runId,
  runStatus: viewModel.summary.runStatus,
  problemCount: viewModel.overview.problemCount,
  findingCounts: { ...viewModel.summary.findingCounts.bySeverity },
  notFullyCheckedPageCount: viewModel.overview.notFullyCheckedPageCount,
});

/** 報告の小さなまとめのバイト列（成果物の JSON の書式。`artifactJsonBytes`）。 */
export const reportSummaryBytesOf = (document: ReportSummaryDocument): Uint8Array => artifactJsonBytes(document);
