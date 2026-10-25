// T32f（Task 32 の設計書 4.1 の ZIP の行と「決定論の ZIP」）: 書き込みのバンドル（`src/report/action-bundle.ts`）。
// - 中身と順: 目録（`manifest.json`）、`action-run.json`、`action-evidence.json`、`approval-summary.json`、`action-report.html`。JSON と HTML は、渡した
//   文字列（ArtifactWriter が伏せ字とスキーマを通した後のもの）のバイト列のまま入れる。
// - 目録: 各ファイルのバイト数と sha256（中身と一致）、ジョブと Run、人の値が入りうるときの注意（文言はカタログ）。
// - 決定論: 同じ入力から同じバイト列。表示用モデルと HTML から作る `createActionPresentation` も同じ。
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ACTION_EVIDENCE_ARTIFACT_FILE_NAME,
  ACTION_REPORT_ARTIFACT_FILE_NAME,
  ACTION_RUN_ARTIFACT_FILE_NAME,
  APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
} from '../../src/core/artifact-layout.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import {
  ACTION_BUNDLE_MANIFEST_FILE_NAME,
  ACTION_BUNDLE_SCHEMA_VERSION,
  createActionBundle,
  createActionPresentation,
  type ActionBundleInput,
} from '../../src/report/action-bundle.js';
import { renderActionReport } from '../../src/report/action-report.js';
import { buildActionViewModel } from '../../src/report/action-view-model.js';
import { escapeHtml } from '../../src/report/html-components.js';
import {
  verifiedApiCreateDocuments,
  verifiedCreateDocuments,
  verifiedUpdateDocuments,
  type ActionReportDocuments,
} from '../helpers/action-report-samples.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const sha256Of = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
/** T44f: 書くのと同じ書式（artifact の JSON の書式は字下げなし。`serializeArtifactJson`）。 */
const textOf = (value: unknown): string => `${JSON.stringify(value)}\n`;
/** バイト列を固定するテストの HTML（表示の変更に左右されない固定の文字列）。 */
const PINNED_HTML = '<!DOCTYPE html>\n<p>pinned</p>\n';

const inputOf = (documents: ActionReportDocuments): ActionBundleInput => ({
  jobId: documents.actionRun.jobId,
  runId: documents.actionRun.runId,
  containsHumanEnteredValues: documents.evidence.containsHumanEnteredValues,
  actionRunJson: textOf(documents.actionRun),
  actionEvidenceJson: textOf(documents.evidence),
  approvalSummaryJson: textOf(documents.approvalSummary),
  reportHtml: renderActionReport(buildActionViewModel(documents)),
});

describe('write bundle (T32f)', () => {
  it('puts the manifest, the three JSON files and the HTML report, in this order, with the given bytes', () => {
    const input = inputOf(verifiedCreateDocuments());
    const entries = unzipSync(createActionBundle(input));
    expect(Object.keys(entries)).toEqual([
      ACTION_BUNDLE_MANIFEST_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, ACTION_EVIDENCE_ARTIFACT_FILE_NAME, APPROVAL_SUMMARY_ARTIFACT_FILE_NAME,
      ACTION_REPORT_ARTIFACT_FILE_NAME,
    ]);
    expect(decoder.decode(entries[ACTION_RUN_ARTIFACT_FILE_NAME])).toBe(input.actionRunJson);
    expect(decoder.decode(entries[ACTION_EVIDENCE_ARTIFACT_FILE_NAME])).toBe(input.actionEvidenceJson);
    expect(decoder.decode(entries[APPROVAL_SUMMARY_ARTIFACT_FILE_NAME])).toBe(input.approvalSummaryJson);
    expect(decoder.decode(entries[ACTION_REPORT_ARTIFACT_FILE_NAME])).toBe(input.reportHtml);
  });

  it('lists every file but the manifest with its byte length and SHA-256, the job, the run and no notice without human values', () => {
    const entries = unzipSync(createActionBundle(inputOf(verifiedCreateDocuments())));
    const manifest = JSON.parse(decoder.decode(entries[ACTION_BUNDLE_MANIFEST_FILE_NAME])) as Record<string, unknown>;
    expect(manifest).toEqual({
      bundleSchemaVersion: ACTION_BUNDLE_SCHEMA_VERSION,
      jobId: 'job-report',
      runId: 'RUN-20261015010000',
      containsHumanEnteredValues: false,
      humanEnteredValuesNotice: null,
      files: Object.entries(entries).filter(([path]) => path !== ACTION_BUNDLE_MANIFEST_FILE_NAME)
        .map(([path, bytes]) => ({ path, byteLength: bytes.byteLength, sha256: sha256Of(bytes) })),
    });
  });

  it('writes the notice of the values entered by people in the manifest when the evidence may hold them', () => {
    const entries = unzipSync(createActionBundle(inputOf(verifiedUpdateDocuments())));
    const manifest = JSON.parse(decoder.decode(entries[ACTION_BUNDLE_MANIFEST_FILE_NAME])) as Record<string, unknown>;
    expect(manifest).toMatchObject({ containsHumanEnteredValues: true, humanEnteredValuesNotice: ACTION_REPORT_TEXT.bundleHumanEnteredValuesNotice });
  });

  // T32R2 M-2: 組み立てを `src/core/` に移す前に、今のバイト列を sha256 で固定する（移した後も、書き込みのバンドルは 1 バイトも変わらない。HTML は
  // 表示の変更に左右されないよう、固定の文字列）。
  // T40c: 見本は版 1.1（送り方と API の要約を持つ）になったので、版 1.1 の見本の値を足した（組み立ての部品は変えていない）。LG-4 で前の版 1.0 の見本の
  // 値は捨てた。
  // T44f（Task 44 の設計書 P3-1 の A）: artifact の JSON を字下げなしで書くようにしたので、値を求め直した（目録と 3 つの JSON の書式。組み立ての部品は変えて
  // いない）。
  // LG-4: 照合の READ の見本に対象の種類（`targetKind`。read-evidence の前の版を捨てて必ず持つ）を足したので、版 1.1 の値を求め直した（組み立ての部品は
  // 変えていない）。
  it.each<readonly [string, () => ActionReportDocuments, string]>([
    ['a verified create of 1.1', verifiedCreateDocuments, 'sha256:6c6efe3bc817e05fede06b02e0852b55aee5ff82537bae78fc332210e91a2b57'],
    ['a verified update of 1.1 (with the notice)', verifiedUpdateDocuments,
      'sha256:0f3c4767154761d3fc35f93912fad30304cdebb86f3363ed6dcdaffd9e2298c3'],
  ])('keeps the SHA-256 of the bundle of %s (T32R2 M-2)', (_label, documents, expected) => {
    expect(sha256Of(createActionBundle({ ...inputOf(documents()), reportHtml: PINNED_HTML }))).toBe(expected);
  });

  it('makes the same bytes from the same input', () => {
    expect(createActionBundle(inputOf(verifiedUpdateDocuments()))).toEqual(createActionBundle(inputOf(verifiedUpdateDocuments())));
  });

  // T40d: API の書き込みの HTML とバンドルも、同じ表示用モデルから 1 回だけ組み立てる（バンドルの中の HTML に API の節がある）。
  it('puts the HTML with the API section, made from the same view model, in the bundle of an API write', () => {
    const documents = verifiedApiCreateDocuments();
    const presentation = createActionPresentation({
      actionRun: { text: textOf(documents.actionRun), value: documents.actionRun },
      evidence: { text: textOf(documents.evidence), value: documents.evidence },
      approvalSummary: { text: textOf(documents.approvalSummary), value: documents.approvalSummary },
    });
    expect(presentation.reportHtml).toBe(renderActionReport(buildActionViewModel(documents)));
    const html = decoder.decode(unzipSync(presentation.bundleBytes)[ACTION_REPORT_ARTIFACT_FILE_NAME]);
    expect(html).toBe(presentation.reportHtml);
    expect(html).toContain(`>${escapeHtml(ACTION_REPORT_TEXT.sections.api)}</h2>`);
  });

  it('makes the HTML report and the bundle from the prepared files once (the HTML inside the bundle is the same)', () => {
    const documents = verifiedUpdateDocuments();
    const prepared = {
      actionRun: { text: textOf(documents.actionRun), value: documents.actionRun },
      evidence: { text: textOf(documents.evidence), value: documents.evidence },
      approvalSummary: { text: textOf(documents.approvalSummary), value: documents.approvalSummary },
    };
    const presentation = createActionPresentation(prepared);
    expect(presentation.reportHtml).toBe(renderActionReport(buildActionViewModel(documents)));
    const entries = unzipSync(presentation.bundleBytes);
    expect(entries[ACTION_REPORT_ARTIFACT_FILE_NAME]).toEqual(encoder.encode(presentation.reportHtml));
    expect(decoder.decode(entries[ACTION_EVIDENCE_ARTIFACT_FILE_NAME])).toBe(prepared.evidence.text);
    expect(presentation.bundleBytes).toEqual(createActionPresentation(prepared).bundleBytes);
  });
});
