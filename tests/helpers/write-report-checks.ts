// T32e（Task 32 の設計書 4.1 の「書く人と時点」「人の値」「報告の対象」「1 回だけ組み立てる」）: 書き込みのジョブの Run のディレクトリの、書き込みの
// 報告の 2 つの JSON（`action-evidence.json`・`approval-summary.json`）を読んで確かめる補助（テストのファイルではない）。T32f: HTML の報告と書き込みの
// バンドル（ZIP。展開した中身）も確かめる。同じ process の中の流れ
// （`write-create-run.test.ts`・`write-update-run.test.ts`）と、本物のワーカーの結合（`write-job-*.test.ts`）が使う。
// - それぞれのスキーマに合う。秘密の目印が出ない。
// - `action-run.json` と重なる値が一致する（送らなかった回は、送った値が `{}`、応答が null、照合の READ が実行しなかった印）。
// - 人の値の印（`containsHumanEnteredValues`）は、UPDATE の変えた欄の証拠か READ の取れた値があるときだけ真。
// - 承認の要約は、`START` の承認の要約の事実（渡したとき）に、ワーカーが足す 3 つの項目を足したものと同じ。
// 値の場所の検査（送った値・変える欄の値が、決まった場所だけにあること）の、決まった成果物の名前の一覧も置く（`action-evidence.json` は、ユーザーの
// 判断 6 で人の値と送った値を入れる場所に加わった）。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { unzipSync } from 'fflate';
import { expect } from 'vitest';
import {
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  type ActionEvidenceDocument,
  type ActionRunDocument,
  type ApprovalSummaryDocument,
  type ApprovalSummaryFacts,
} from '../../src/control/actions/action-contracts.js';
import { ACTION_BUNDLE_MANIFEST_FILE_NAME } from '../../src/core/action-bundle-bytes.js';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
  actionBundleFileName,
  artifactFilePath,
  isActionBundleFileName,
} from '../../src/core/artifact-layout.js';
import { createSha256FingerprintOfBytes } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';

/**
 * 送った値と変える欄の前後の値を持ってよい成果物（`action-run.json` と、T32e から `action-evidence.json`、T32f から `action-report.html`）。承認の
 * 要約は持たない。書き込みのバンドル（ZIP）の中の同じ名前の項目（`<ZIP>!/<名前>`）も、同じ扱い（ZIP は展開した中身で検査する）。
 */
export const WRITE_VALUE_ARTIFACT_FILE_NAMES: readonly string[] = Object.freeze([
  ACTION_RUN_ARTIFACT_FILE_NAME,
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
]);

/**
 * その場所（ファイルのパスか、`<ZIP>!/<名前>` の ZIP の中の項目）が、送った値を持ってよい成果物か。書き込みのバンドルのファイルそのもの（圧縮した
 * バイト列）も、中身が値を持ってよい成果物なので含める（目録 `manifest.json` は含めない）。
 */
export const isWriteValueArtifactPlace = (place: string): boolean =>
  WRITE_VALUE_ARTIFACT_FILE_NAMES.some((name) => place.endsWith(name)) || isActionBundleFileName(basename(place));

/** 読んだ 2 つの JSON（文字列と値）。 */
export interface WriteReportFiles {
  readonly evidenceText: string;
  readonly evidence: ActionEvidenceDocument;
  readonly approvalSummaryText: string;
  readonly approvalSummary: ApprovalSummaryDocument;
}

/** 人の値が入りうる項目（UPDATE の変えた欄の証拠、照合の READ の取れた値）があるか。 */
const hasHumanEnteredValues = (evidence: ActionEvidenceDocument): boolean => {
  const changed = evidence.update?.updateEvidence?.fields.some((field) => field.role === 'CHANGED') ?? false;
  const read = evidence.readVerification;
  const observed = read.state === 'EXECUTED'
    && read.expectations.some((expectation) => 'observedValue' in expectation && typeof expectation.observedValue === 'string');
  return changed || observed;
};

/** `action-evidence.json` の、`action-run.json` と重なる値が一致する（送らなかった回の空の形を含む）。 */
export function expectEvidenceMatchesActionRun(evidence: ActionEvidenceDocument, run: ActionRunDocument): void {
  const sent = run.submission !== 'NOT_SENT';
  expect({
    jobId: evidence.jobId, runId: evidence.runId, profileId: evidence.profileId, scenarioId: evidence.scenarioId,
    scenarioRevision: evidence.scenarioRevision, result: evidence.result, reason: evidence.reason, startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt, recordId: evidence.recordId, update: evidence.update, kind: evidence.kind,
    submission: { state: evidence.submission.state, submittedValues: evidence.submission.submittedValues, submittedAt: evidence.submission.submittedAt },
    blockReason: evidence.precheck.blockReason,
    response: evidence.response === null ? null : { httpStatus: evidence.response.httpStatus, judgement: evidence.response.judgement },
    readVerification: evidence.readVerification.state === 'EXECUTED'
      ? { readCheckId: evidence.readVerification.readCheckId, readCheckRevision: evidence.readVerification.readCheckRevision,
        result: evidence.readVerification.result }
      : null,
  }).toEqual({
    jobId: run.jobId, runId: run.runId, profileId: run.profileId, scenarioId: run.scenarioId, scenarioRevision: run.scenarioRevision,
    result: run.result, reason: run.reason, startedAt: run.startedAt, finishedAt: run.finishedAt, recordId: run.recordId, update: run.update ?? null,
    kind: run.update === undefined ? 'CREATE' : 'UPDATE',
    submission: { state: run.submission, submittedValues: sent ? run.submittedValues : {}, submittedAt: run.submittedAt },
    blockReason: run.blockReason,
    response: sent ? { httpStatus: run.httpStatus, judgement: run.responseJudgement } : null,
    readVerification: run.readVerification,
  });
  expect(evidence.containsHumanEnteredValues).toBe(hasHumanEnteredValues(evidence));
  if (!sent) {
    expect(evidence.submission.actionPath).toBeNull();
    expect(evidence.readVerification.state).toBe('NOT_EXECUTED');
  }
}

/**
 * Run のディレクトリの 2 つの JSON を読み、スキーマ・秘密の目印・`action-run.json` との一致・承認の要約（`approvalFacts` を渡したとき、それに 3 つの
 * 項目を足したもの。渡さなければ、ジョブと Run と許可が `action-run.json` と同じ）を確かめる。
 */
export async function readWriteReportFiles(
  runDirectory: string,
  run: ActionRunDocument,
  options: { readonly markers: readonly string[]; readonly approvalFacts?: ApprovalSummaryFacts },
): Promise<WriteReportFiles> {
  const evidenceText = readFileSync(artifactFilePath(runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8');
  const approvalSummaryText = readFileSync(artifactFilePath(runDirectory, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME), 'utf8');
  const evidence = JSON.parse(evidenceText) as ActionEvidenceDocument;
  const approvalSummary = JSON.parse(approvalSummaryText) as ApprovalSummaryDocument;
  expect(await validateArtifact('action-evidence', evidence)).toEqual({ ok: true });
  expect(await validateArtifact('approval-summary', approvalSummary)).toEqual({ ok: true });
  for (const marker of options.markers) {
    expect(evidenceText).not.toContain(marker);
    expect(approvalSummaryText).not.toContain(marker);
  }
  expectEvidenceMatchesActionRun(evidence, run);
  // T32f: HTML の報告と書き込みのバンドル。バンドルの中の JSON と HTML は、書いたファイルと同じバイト列で、目録の sha256 が中身と一致し、スキーマに
  // 合う。秘密の目印は、HTML にも、展開したバンドルのどの項目にも出ない。
  const reportHtml = readFileSync(artifactFilePath(runDirectory, ACTION_REPORT_ARTIFACT_FILE_NAME), 'utf8');
  expect(reportHtml.startsWith('<!DOCTYPE html>')).toBe(true);
  const bundle = unzipSync(readFileSync(artifactFilePath(runDirectory, actionBundleFileName(run.finishedAt))));
  expect(Object.keys(bundle)).toEqual([
    ACTION_BUNDLE_MANIFEST_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
    ACTION_REPORT_ARTIFACT_FILE_NAME,
  ]);
  for (const name of [ACTION_RUN_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME, ACTION_REPORT_ARTIFACT_FILE_NAME]) {
    expect(Buffer.from(bundle[name] ?? new Uint8Array()).equals(readFileSync(artifactFilePath(runDirectory, name))), name).toBe(true);
  }
  const manifest = JSON.parse(new TextDecoder().decode(bundle[ACTION_BUNDLE_MANIFEST_FILE_NAME])) as {
    readonly containsHumanEnteredValues: boolean;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  };
  expect(manifest.containsHumanEnteredValues).toBe(evidence.containsHumanEnteredValues);
  expect(manifest.files.map(({ path, sha256 }) => [path, sha256])).toEqual(Object.entries(bundle)
    .filter(([path]) => path !== ACTION_BUNDLE_MANIFEST_FILE_NAME)
    .map(([path, bytes]) => [path, createSha256FingerprintOfBytes(bytes)]));
  for (const marker of options.markers) {
    expect(reportHtml).not.toContain(marker);
    for (const [path, bytes] of Object.entries(bundle)) {
      expect(new TextDecoder().decode(bytes), path).not.toContain(marker);
    }
  }
  if (options.approvalFacts === undefined) {
    expect({ jobId: approvalSummary.jobId, runId: approvalSummary.runId, grantId: approvalSummary.grantAtStart.grantId })
      .toEqual({ jobId: run.jobId, runId: run.runId, grantId: run.grantId });
  } else {
    expect(approvalSummary).toEqual({ ...options.approvalFacts, schemaVersion: APPROVAL_SUMMARY_SCHEMA_VERSION, jobId: run.jobId, runId: run.runId });
  }
  return { evidenceText, evidence, approvalSummaryText, approvalSummary };
}
