// PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、13 章の 13）: 報告を作る時に書く小さなまとめ（`report-summary.json`）。
// 作業の画面は、大きな `audit.json` を読まずに、これだけを読んで「問題が 2 件見つかりました」を出す。
// - 値は表示用モデル（`overview` と `summary`）を写すだけ（数え直さない）。
// - スキーマ（`schemas/report-summary.schema.json`）に通り、URL・文言・ID のほかの値を持たない。
// - 書き出しは `ArtifactWriter.writePresentation` の 1 か所（報告の HTML と同じ時）。
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAuditRunOutputs } from '../../src/cli/audit-run.js';
import { REPORT_SUMMARY_ARTIFACT_FILE_NAME, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { REPORT_SUMMARY_SCHEMA_VERSION, reportSummaryBytesOf, reportSummaryDocumentOf } from '../../src/report/report-summary.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, edgeCaseAuditRun } from '../helpers/audit-run-fixture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('reportSummaryDocumentOf: the small summary for the job screen (PL-R)', () => {
  it('copies the counts of the view model and matches the schema', async () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const document = reportSummaryDocumentOf(model);
    expect(document).toEqual({
      schemaVersion: REPORT_SUMMARY_SCHEMA_VERSION,
      runId: model.summary.runId,
      runStatus: model.summary.runStatus,
      problemCount: model.overview.problemCount,
      findingCounts: { ...model.summary.findingCounts.bySeverity },
      notFullyCheckedPageCount: model.overview.notFullyCheckedPageCount,
    });
    expect(document.findingCounts).toEqual({ ERROR: 1, WARN: 2, INFO: 2, SAFETY: 1 });
    expect(document.problemCount).toBe(5);
    expect(await validateArtifact('report-summary', document)).toEqual({ ok: true });
  });

  it('rejects an unknown item, a negative count and a missing count in the schema', async () => {
    const document = reportSummaryDocumentOf(buildReportViewModel(auditRun()));
    expect(await validateArtifact('report-summary', { ...document, url: 'http://127.0.0.1/' })).toMatchObject({ ok: false });
    expect(await validateArtifact('report-summary', { ...document, problemCount: -1 })).toMatchObject({ ok: false });
    const { notFullyCheckedPageCount: _omitted, ...missing } = document;
    expect(await validateArtifact('report-summary', missing)).toMatchObject({ ok: false });
  });

  it('writes the bytes as JSON with a final LF', () => {
    const document = reportSummaryDocumentOf(buildReportViewModel(auditRun()));
    const text = new TextDecoder().decode(reportSummaryBytesOf(document));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(document);
  });
});

describe('writeAuditRunOutputs: the small summary is written with the report (PL-R)', () => {
  it('writes report-summary.json next to report.html from the same view model', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'beaksight-report-summary-'));
    directories.push(outputDirectory);
    const result = edgeCaseAuditRun();
    const outputs = await writeAuditRunOutputs(result, outputDirectory);
    const runDirectory = runArtifactDirectory(outputDirectory, outputs.runId);
    expect(readdirSync(runDirectory)).toContain(REPORT_SUMMARY_ARTIFACT_FILE_NAME);
    const written: unknown = JSON.parse(readFileSync(join(runDirectory, REPORT_SUMMARY_ARTIFACT_FILE_NAME), 'utf8'));
    expect(written).toEqual(reportSummaryDocumentOf(buildReportViewModel(result)));
    expect(await validateArtifact('report-summary', written)).toEqual({ ok: true });
  });
});
