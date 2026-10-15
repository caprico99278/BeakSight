// 書き込みのジョブの報告の確かめ（T32g。Task 32 の設計書 4.1 の「親の確かめと画面の配布」「報告の確かめの記録」）。ジョブの管理
// （`audit-job-manager.ts`）が、書き込みの結果の締めと同じ時点で呼び、結果（`WRITE_REPORT_CHECKS` の 1 つ）を `recordWriteReportCheck` で記録する。
// - 照らす: 報告の 2 つの JSON（`action-evidence.json`・`approval-summary.json`）が成果物のスキーマに合う。ジョブ・Run・プロファイル・シナリオと版・
//   許可・結果と理由が、使えた `action-run.json` と同じ。組み立て直しに使う `action-run.json` のバイト列（2 回目の読み取り）が、締めに使った文書
//   （1 回目に読んで確かめたもの）と同じ内容（JSON でなければ `REPORT_INVALID`、違えば `REPORT_MISMATCH`。T32R3 Minor-1）。承認の要約の事実が、`START` で送った承認の要約の事実と同じ（`START` の値は親のメモリにだけ
//   あるので、ここでしか照らせない）。書き込みのバンドルは、ディスクの 4 つのファイル（`action-run.json`・`action-evidence.json`・
//   `approval-summary.json`・`action-report.html`）から同じ手順（`actionBundleBytesOf`。ワーカーと同じ部品）で組み立て直したバイト列と、ディスクの
//   ZIP のバイト列が一致する（T32R2 M-2。目録・項目の名前と順・ローカルのヘッダ・前後のごみまで、1 バイトでも違えば `BUNDLE_MISMATCH`）。
// - 照らさない（既知の限界。締めの前に誰かが Run のディレクトリを書き換えた場合に限る）: 上の項目の外（`action-evidence.json` の送った値・登録の ID
//   などが `action-run.json` と一致するか）。バンドルは 4 つのファイルと同じ中身であることまでを照らす。
// - 照らすだけで、書き込みの結果（予約・台帳）は変えない。ファイルは、出力先の Run のディレクトリの中を、リンクをたどらずに読む（読む口は呼び出し側が
//   渡す。`readContainedArtifactFile`）。
// - 報告の組み立て（`src/report/`）は読み込まない（画面のサーバが読み込む。Gate `local-ui-boundary`）。バンドルのバイト列の組み立ては、両方から読める
//   `src/core/action-bundle-bytes.ts`、目録の注意の文言は文言のカタログ（`ACTION_REPORT_TEXT`）から取る。
// 例外を投げない（読めないは理由のコードにする）。
import { Buffer } from 'node:buffer';
import { actionBundleBytesOf } from '../../core/action-bundle-bytes.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
} from '../../core/artifact-layout.js';
import { validateArtifact, type ArtifactSchemaName } from '../../core/schema-validator.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { ACTION_REPORT_TEXT } from '../../presentation/messages.js';
import type { ActionEvidenceDocument, ActionRunDocument, ApprovalSummaryDocument, ApprovalSummaryFacts } from '../actions/action-contracts.js';
import type { WriteReportCheck } from './job-records.js';

/** Run のディレクトリの中のファイルを読む口（なければ・読めなければ null）。 */
export type WriteReportFileReader = (fileName: string) => Promise<Uint8Array | null>;

/** 報告の確かめの入力。 */
export interface WriteReportCheckInput {
  /** 使えた `action-run.json`（スキーマとジョブ・許可の一致を確かめた後のもの）。 */
  readonly actionRun: ActionRunDocument;
  /** `START` で送った承認の要約の事実。 */
  readonly approvalFacts: ApprovalSummaryFacts;
  readonly readFile: WriteReportFileReader;
}

const VALID: WriteReportCheck = 'VALID';
const REPORT_MISSING: WriteReportCheck = 'REPORT_MISSING';
const REPORT_INVALID: WriteReportCheck = 'REPORT_INVALID';
const REPORT_MISMATCH: WriteReportCheck = 'REPORT_MISMATCH';
const APPROVAL_FACTS_MISMATCH: WriteReportCheck = 'APPROVAL_FACTS_MISMATCH';
const BUNDLE_MISMATCH: WriteReportCheck = 'BUNDLE_MISMATCH';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** JSON の文書を読み、スキーマで確かめる（なければ `REPORT_MISSING`、JSON でない・合わなければ `REPORT_INVALID`）。 */
const readDocument = async (bytes: Uint8Array | null, schema: ArtifactSchemaName): Promise<unknown> => {
  if (bytes === null) {
    return REPORT_MISSING;
  }
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return (await validateArtifact(schema, value)).ok ? value : REPORT_INVALID;
  } catch {
    return REPORT_INVALID;
  }
};

/** JSON として読んだ値の、鍵を並べた JSON の文字列（比べるため。UTF-8 でない・JSON でなければ null）。 */
const sortedJsonOfBytes = (bytes: Uint8Array): string | null => {
  try {
    return sortedKeysJsonOf(JSON.parse(decoder.decode(bytes)));
  } catch {
    return null;
  }
};

/** 報告のジョブ・Run・プロファイル・シナリオと版・許可・結果と理由が、`action-run.json` と同じか。 */
const identityMatches = (run: ActionRunDocument, evidence: ActionEvidenceDocument, summary: ApprovalSummaryDocument): boolean =>
  evidence.jobId === run.jobId
  && evidence.runId === run.runId
  && evidence.profileId === run.profileId
  && evidence.scenarioId === run.scenarioId
  && evidence.scenarioRevision === run.scenarioRevision
  && evidence.result === run.result
  && evidence.reason === run.reason
  && summary.jobId === run.jobId
  && summary.runId === run.runId
  && summary.profileId === run.profileId
  && summary.scenario.scenarioId === run.scenarioId
  && summary.scenario.revision === run.scenarioRevision
  && summary.grantAtStart.grantId === run.grantId;

/** 承認の要約の事実（ワーカーが足した 3 つの項目を除く）が、`START` の事実と同じか。 */
const approvalFactsMatch = (summary: ApprovalSummaryDocument, facts: ApprovalSummaryFacts): boolean => {
  const { schemaVersion: _schemaVersion, jobId: _jobId, runId: _runId, ...summaryFacts } = summary;
  return sortedKeysJsonOf(summaryFacts) === sortedKeysJsonOf(facts);
};

/** ディスクの 4 つのファイル（ファイルに書いたバイト列）。 */
interface WriteReportDiskFiles {
  readonly actionRun: Uint8Array;
  readonly actionEvidence: Uint8Array;
  readonly approvalSummary: Uint8Array;
  readonly reportHtml: Uint8Array;
}

/**
 * ディスクの 4 つのファイルから、ワーカーと同じ手順でバンドルを組み立て直し、ディスクの ZIP とバイト列が一致するか（T32R2 M-2）。ジョブ・Run と
 * 人の値の印は、確かめた `action-evidence.json` の値（ワーカーの組み立てと同じ）。
 */
const bundleCheckOf = (bundle: Uint8Array, evidence: ActionEvidenceDocument, files: WriteReportDiskFiles): WriteReportCheck => {
  const rebuilt = actionBundleBytesOf({
    jobId: evidence.jobId,
    runId: evidence.runId,
    containsHumanEnteredValues: evidence.containsHumanEnteredValues,
    humanEnteredValuesNotice: ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice,
    ...files,
  });
  return Buffer.compare(rebuilt, bundle) === 0 ? VALID : BUNDLE_MISMATCH;
};

/** 書き込みのジョブの報告を照らし、結果のコードを返す（照らす順と理由はファイルの先頭）。例外を投げない。 */
export async function checkWriteReport(input: WriteReportCheckInput): Promise<WriteReportCheck> {
  const { actionRun } = input;
  const read = async (fileName: string): Promise<Uint8Array | null> => {
    try {
      return await input.readFile(fileName);
    } catch {
      return null;
    }
  };
  const evidenceBytes = await read(ACTION_EVIDENCE_ARTIFACT_FILE_NAME);
  const summaryBytes = await read(APPROVAL_SUMMARY_ARTIFACT_FILE_NAME);
  const htmlBytes = await read(ACTION_REPORT_ARTIFACT_FILE_NAME);
  const runBytes = await read(ACTION_RUN_ARTIFACT_FILE_NAME);
  let bundleName: string;
  try {
    bundleName = actionBundleFileName(actionRun.finishedAt);
  } catch {
    return REPORT_MISMATCH;
  }
  const bundleBytes = await read(bundleName);
  if (evidenceBytes === null || summaryBytes === null || htmlBytes === null || runBytes === null || bundleBytes === null) {
    return REPORT_MISSING;
  }
  const evidence = await readDocument(evidenceBytes, 'action-evidence');
  const summary = await readDocument(summaryBytes, 'approval-summary');
  // T32R3 Minor-1: 組み立て直しに使う `action-run.json` のバイト列は、締めに使った文書と同じ内容でなければならない。
  const diskActionRun = sortedJsonOfBytes(runBytes);
  if (evidence === REPORT_INVALID || summary === REPORT_INVALID || diskActionRun === null) {
    return REPORT_INVALID;
  }
  if (!identityMatches(actionRun, evidence as ActionEvidenceDocument, summary as ApprovalSummaryDocument)
    || diskActionRun !== sortedKeysJsonOf(actionRun)) {
    return REPORT_MISMATCH;
  }
  if (!approvalFactsMatch(summary as ApprovalSummaryDocument, input.approvalFacts)) {
    return APPROVAL_FACTS_MISMATCH;
  }
  return bundleCheckOf(bundleBytes, evidence as ActionEvidenceDocument, {
    actionRun: runBytes, actionEvidence: evidenceBytes, approvalSummary: summaryBytes, reportHtml: htmlBytes,
  });
}
