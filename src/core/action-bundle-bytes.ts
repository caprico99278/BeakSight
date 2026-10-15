/**
 * 書き込みのバンドル（`beaksight-action-bundle_YYYYMMDDHHmmss.zip`）のバイト列の唯一の組み立て（Task 32 の設計書 4.1 の ZIP の行と「決定論の ZIP」。
 * T32f で `src/report/action-bundle.ts` に置き、T32R2 M-2 で `src/core/` に移した）。
 * - 使う側: ワーカーの報告の組み立て（`src/report/action-bundle.ts` の `createActionBundle`）と、書き込みのジョブを締める親の確かめ
 *   （`src/control/job/write-report-check.ts`。ディスクの 4 つのファイルから組み立て直し、ディスクの ZIP とバイト列で照らす）。`src/control/` は
 *   `src/report/` を読み込めない（画面のサーバが `src/report/` を読み込まない Gate `local-ui-boundary`）ので、両方から読める `src/core/` に置く。
 * - 中身と順: 目録（`ACTION_BUNDLE_MANIFEST_FILE_NAME`）、`action-run.json`、`action-evidence.json`、`approval-summary.json`、`action-report.html`。
 *   4 つのファイルは、渡したバイト列のまま入れる（ファイルに書くのと同じバイト列）。
 * - 目録: 版の印、ジョブと Run、人の値が入りうるか（`containsHumanEnteredValues`）とその注意（入りえなければ null）、目録を除く各ファイルのバイト数と
 *   sha256（`zipFileRecordsOf`）。書式は `artifactJsonBytes`。注意の文言は、`src/core/` が文言のカタログを読み込まないので、呼び出し側が
 *   カタログ（`ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice`）の値を渡す。
 * - 決定論: ZIP は `deterministicZipOf`（監査のバンドルと同じ）。同じ入力から同じバイト列。ファイルは書かない（ArtifactWriter）。
 */
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
} from './artifact-layout.js';
import { artifactJsonBytes } from './artifact-json.js';
import { deterministicZipOf, zipFileRecordsOf, type ZipEntry, type ZipFileRecord } from './deterministic-zip.js';

/** 目録の `bundleSchemaVersion`。 */
export const ACTION_BUNDLE_SCHEMA_VERSION = 'action-bundle/1.0';

/** ZIP の中の目録の名前。 */
export const ACTION_BUNDLE_MANIFEST_FILE_NAME = 'manifest.json';

/** 目録の中身。 */
export interface ActionBundleManifest {
  readonly bundleSchemaVersion: typeof ACTION_BUNDLE_SCHEMA_VERSION;
  readonly jobId: string;
  readonly runId: string;
  readonly containsHumanEnteredValues: boolean;
  readonly humanEnteredValuesNotice: string | null;
  /** 目録を除く、ZIP の中のすべてのファイル（ZIP の中の順）。 */
  readonly files: readonly ZipFileRecord[];
}

/** バンドルのバイト列の入力（4 つのファイルは、ファイルに書くのと同じバイト列）。 */
export interface ActionBundleBytesInput {
  readonly jobId: string;
  readonly runId: string;
  readonly containsHumanEnteredValues: boolean;
  /** 人の値が入りうるときに目録に書く注意（文言のカタログの `ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice`）。 */
  readonly humanEnteredValuesNotice: string;
  readonly actionRun: Uint8Array;
  readonly actionEvidence: Uint8Array;
  readonly approvalSummary: Uint8Array;
  readonly reportHtml: Uint8Array;
}

/** 書き込みのバンドルの ZIP のバイト列（ファイルは書かない）。 */
export const actionBundleBytesOf = (input: ActionBundleBytesInput): Uint8Array => {
  const files: readonly ZipEntry[] = [
    { path: ACTION_RUN_ARTIFACT_FILE_NAME, bytes: input.actionRun },
    { path: ACTION_EVIDENCE_ARTIFACT_FILE_NAME, bytes: input.actionEvidence },
    { path: APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, bytes: input.approvalSummary },
    { path: ACTION_REPORT_ARTIFACT_FILE_NAME, bytes: input.reportHtml },
  ];
  const manifest: ActionBundleManifest = {
    bundleSchemaVersion: ACTION_BUNDLE_SCHEMA_VERSION,
    jobId: input.jobId,
    runId: input.runId,
    containsHumanEnteredValues: input.containsHumanEnteredValues,
    humanEnteredValuesNotice: input.containsHumanEnteredValues ? input.humanEnteredValuesNotice : null,
    files: zipFileRecordsOf(files),
  };
  return deterministicZipOf([{ path: ACTION_BUNDLE_MANIFEST_FILE_NAME, bytes: artifactJsonBytes(manifest) }, ...files]);
};
