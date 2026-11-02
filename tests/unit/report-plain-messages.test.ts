// OP-R2（PL 設計書 14 章。UI の SSOT の決まり「Finding の文言は Rule が持ち、表示面では作り直さない」）: 結果の報告の本文は、Rule のやさしい文を出す。
// - 表示用モデルの `FindingView.plainMessage` と、まとめの段の大事な問題の `plainMessage` は、Rule の定義の文（`rulePlainMessageOf`）。どの Rule も持たない
//   ruleId（前の版の Rule など）は、Rule の文（`message`）のまま。
// - 本文（まとめの段、重大な問題、種類ごとの問題、ページごとの問題）は、やさしい文を出す。末尾の記録の段は、Rule の文（`message`）をそのまま出す。
// - ChatGPT 用のファイルの JSON の鍵と値は変えない（`chatgpt-bundle.test.ts` の SHA-256 の固定で確かめる）。
import { describe, expect, it } from 'vitest';
import { rulePlainMessageOf } from '../../src/audit/cross-page-rules.js';
import { REPORT_SECTION_CATALOG } from '../../src/presentation/catalog.js';
import { escapeHtml } from '../../src/report/html-components.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { beaksightBlockAuditRun, edgeCaseAuditRun } from '../helpers/audit-run-fixture.js';

const positionOfId = (html: string, id: string): number => html.indexOf(` id="${id}"`);

/** 本文（まとめの段の始まりから、記録の段の前まで）と、記録の段。 */
const partsOf = (html: string): { readonly body: string; readonly record: string } => {
  const start = positionOfId(html, REPORT_SECTION_CATALOG.OVERVIEW.anchor);
  const recordStart = positionOfId(html, REPORT_SECTION_CATALOG.RECORD.anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(recordStart).toBeGreaterThan(start);
  return { body: html.slice(start, recordStart), record: html.slice(recordStart) };
};

describe('buildReportViewModel: the plain message of each Finding (OP-R2)', () => {
  it('carries the plain message of the Rule that owns the ruleId, and the message of the Rule when no Rule owns it', () => {
    for (const sample of [beaksightBlockAuditRun(), edgeCaseAuditRun()]) {
      const model = buildReportViewModel(sample);
      expect(model.findings.length).toBeGreaterThan(0);
      for (const view of model.findings) {
        expect(view.plainMessage, view.finding.ruleId).toBe(rulePlainMessageOf(view.finding.ruleId) ?? view.finding.message);
      }
    }
    // 見本の確かめ: Rule の持つ ruleId の Finding では、やさしい文が Rule の文と違う。
    const known = buildReportViewModel(beaksightBlockAuditRun()).findings.filter((view) => rulePlainMessageOf(view.finding.ruleId) !== null);
    expect(known.length).toBeGreaterThan(0);
    for (const view of known) {
      expect(view.plainMessage, view.finding.ruleId).not.toBe(view.finding.message);
    }
  });

  it('carries the plain message of the first example in each important problem of the overview', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    expect(model.overview.topProblems.length).toBeGreaterThan(0);
    for (const problem of model.overview.topProblems) {
      const view = model.findings.find(({ finding }) => finding.findingId === problem.findingId);
      expect(view, problem.ruleId).toBeDefined();
      expect(problem.plainMessage, problem.ruleId).toBe(view!.plainMessage);
      expect(problem.message, problem.ruleId).toBe(view!.finding.message);
    }
  });
});

describe('renderHtmlReport: the plain message in the body and the message of the Rule in the record (OP-R2)', () => {
  it('shows the plain message in the body, not the message of the Rule, and keeps the message of the Rule in the record', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    const { body, record } = partsOf(renderHtmlReport(model));
    const known = model.findings.filter((view) => rulePlainMessageOf(view.finding.ruleId) !== null);
    expect(known.length).toBeGreaterThan(0);
    for (const view of known) {
      expect(body, view.finding.findingId).toContain(escapeHtml(view.plainMessage));
      expect(body, view.finding.findingId).not.toContain(escapeHtml(view.finding.message));
      expect(record, view.finding.findingId).toContain(escapeHtml(view.finding.message));
    }
  });

  it('shows the plain message in the important problems of the overview', () => {
    const model = buildReportViewModel(beaksightBlockAuditRun());
    const html = renderHtmlReport(model);
    const overview = html.slice(
      positionOfId(html, REPORT_SECTION_CATALOG.OVERVIEW.anchor),
      positionOfId(html, REPORT_SECTION_CATALOG.CRITICAL_FINDINGS.anchor),
    );
    for (const problem of model.overview.topProblems) {
      expect(overview, problem.ruleId).toContain(escapeHtml(problem.plainMessage));
      expect(overview, problem.ruleId).not.toContain(escapeHtml(problem.message));
    }
  });
});
