// AUD-6a・6c（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md`）:
// - AUD-6a: Rule ごとの「検証の根拠」の表（Rule の定義の 1 か所）が Rule の一覧と過不足なく一致し、表示用モデルが指摘ごとに 1 回だけ `verification` を付ける。
//   証拠の参照に欠けがあれば `UNVERIFIED`（理由つき）。バンドルの findings.json は、表示用モデルの値の写し。
// - AUD-6c: 表示用モデルが、Web Vitals の指標ごとに 観測・未観測・未対応・未収集 の数を数える。合格の意味の値は出さない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { CROSS_PAGE_RULES } from '../../src/audit/cross-page-rules.js';
import { RULE_CATALOG } from '../../src/audit/rule-catalog.js';
import {
  RULE_VERIFICATION_BASES,
  RULE_VERIFICATION_BASIS_TABLE,
  ruleVerificationBasisOf,
} from '../../src/audit/rule-verification-basis.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, EvidencePayloadByType, PageId, ViewportProfile } from '../../src/core/contracts.js';
import { createEvidenceId } from '../../src/core/ids.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, FINDING_UNVERIFIED_NEXT_STEP_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle, type ReadArtifactFile } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, auditRun, dom, edgeCaseAuditRun, finding, idOf, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

const keyOf = (entry: { readonly ruleId?: string; readonly ruleIdPrefix?: string }): string =>
  entry.ruleIdPrefix === undefined ? `id:${entry.ruleId ?? ''}` : `prefix:${entry.ruleIdPrefix}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 書き出し済みの Run のディレクトリの代わり（すべての参照先があるとする）。 */
const readAll = (result: AuditRunResult): ReadArtifactFile => async (path) =>
  path === RUN_ARTIFACT_FILE_NAMES.run
    ? encoder.encode(JSON.stringify(result.run))
    : result.pages.some((value) => path === pageArtifactRelativePath(value.pageId, 'page'))
      ? encoder.encode(JSON.stringify(result.pages.find((value) => path === pageArtifactRelativePath(value.pageId, 'page'))))
      : encoder.encode('x');

type Vital = 'OBSERVED' | 'NOT_OBSERVED' | 'UNSUPPORTED';
const vital = (status: Vital, value = 100): object =>
  status === 'OBSERVED'
    ? { status, value, id: 'v1', navigationType: 'navigate', attribution: null }
    : { status, value: null, id: null, navigationType: null, attribution: null };

/** performance の Evidence（表示用モデルが読む `webVitals` だけを持つ見本）。`webVitals` が `null` なら未収集。 */
const performance = (sequence: number, pageId: PageId, viewport: ViewportProfile, statuses: Readonly<Record<string, Vital>> | null) =>
  record('performance', sequence, pageId, viewport, {
    status: 'COMPLETE',
    reason: 'COLLECTED',
    webVitals:
      statuses === null
        ? null
        : Object.fromEntries(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'].map((metric) => [metric, vital(statuses[metric] ?? 'OBSERVED')])),
    navigationTiming: null,
    resources: [],
    resourceSummaries: null,
    resourceCoverage: null,
    serverTiming: [],
    telemetryHeaders: [],
    telemetryCandidates: [],
    truncation: null,
  } as unknown as EvidencePayloadByType['performance']);

describe('AUD-6a: the table of the verification basis of each Rule', () => {
  it('has exactly one row for each Rule of the catalogs (by ruleId, or by ruleIdPrefix), and no other row', () => {
    const ruleKeys = [...RULE_CATALOG, ...CROSS_PAGE_RULES].map(keyOf).sort();
    const tableKeys = RULE_VERIFICATION_BASIS_TABLE.map(keyOf).sort();
    expect(tableKeys).toEqual(ruleKeys);
    expect(new Set(tableKeys).size).toBe(tableKeys.length);
    for (const entry of RULE_VERIFICATION_BASIS_TABLE) {
      expect(RULE_VERIFICATION_BASES, keyOf(entry)).toContain(entry.basis);
    }
  });

  it('has the closed list of the four bases', () => {
    expect(RULE_VERIFICATION_BASES).toEqual(['STATIC_CANDIDATE', 'RENDERED', 'NAVIGATION_OBSERVED', 'INTERACTION_REPRODUCED']);
  });

  it('gives axe a static candidate, layout and color a rendered check, and HTTP a navigation observation', () => {
    for (const ruleId of ['A11Y_IMAGE_ALT', 'A11Y_BUTTON_NAME', 'A11Y_DOCUMENT_TITLE']) {
      expect(ruleVerificationBasisOf(ruleId), ruleId).toBe('STATIC_CANDIDATE');
    }
    for (const ruleId of ['DOCUMENT_HORIZONTAL_OVERFLOW', 'ELEMENT_OVERLAP', 'FIXED_ELEMENT_OCCLUSION', 'COLOR_CONTRAST_VIOLATION']) {
      expect(ruleVerificationBasisOf(ruleId), ruleId).toBe('RENDERED');
    }
    for (const ruleId of ['HTTP_4XX', 'HTTP_5XX', 'RESOURCE_4XX', 'BROKEN_INTERNAL_LINK']) {
      expect(ruleVerificationBasisOf(ruleId), ruleId).toBe('NAVIGATION_OBSERVED');
    }
    // 表にない ruleId（前の版の Rule・テストの仮の Rule）は、いちばん弱い根拠（候補）にする。
    expect(ruleVerificationBasisOf('UNKNOWN_RULE')).toBe('STATIC_CANDIDATE');
  });
});

describe('AUD-6a: the verification of each Finding in the view model', () => {
  it('gives each Finding the basis of its Rule once, and UNVERIFIED with a reason when a reference is missing', () => {
    const base = edgeCaseAuditRun();
    const result: AuditRunResult = {
      ...base,
      findings: base.findings.map((value) => (value.findingId === base.findings[4]?.findingId ? { ...value, ruleId: 'HTTP_4XX' } : value)),
    };
    const model = buildReportViewModel(result, { missingArtifactPaths: ['pages/PAGE-000001/desktop/viewport.png'] });
    const byId = new Map(model.findings.map((view) => [view.finding.findingId, view.verification]));

    // AUD-2d で、検証の状態に確かめ直しの印（`recheck`）の欄が増えた（この見本に確かめ直しの表はないので `NOT_RECHECKED`）。期待が古いままだったので、
    // その欄だけを足した（根拠・状態・理由の期待は変えていない）。
    // PAGE-000002 の指摘（HTTP_4XX にした）は、欠けがないので、Rule の根拠のまま。
    expect(byId.get(base.findings[4]!.findingId)).toEqual({ status: 'NAVIGATION_OBSERVED', basis: 'NAVIGATION_OBSERVED', reason: null, recheck: 'NOT_RECHECKED' });
    // PAGE-000001 の Desktop の画像が欠けたので、その画像に関係する指摘は UNVERIFIED。AUD-6b: 検証できなかった指摘には、次に要る手順（やさしい文）を付ける。
    expect(byId.get(base.findings[0]!.findingId)).toEqual({
      status: 'UNVERIFIED', basis: 'STATIC_CANDIDATE', reason: 'EVIDENCE_FILE_MISSING', recheck: 'NOT_RECHECKED',
      nextStep: FINDING_UNVERIFIED_NEXT_STEP_TEXT.EVIDENCE_FILE_MISSING,
    });
  });

  it('marks a Finding whose Evidence is on no page as UNVERIFIED', () => {
    const base = auditRun();
    const result: AuditRunResult = { ...base, findings: [...base.findings, finding(9, 'INFO', 'CROSS_PAGE', null, [createEvidenceId('console', 99)])] };
    const model = buildReportViewModel(result);
    const unknown = model.findings.find((view) => view.evidence.some((reference) => reference.location === null));
    expect(unknown?.verification).toMatchObject({ status: 'UNVERIFIED', reason: 'EVIDENCE_NOT_FOUND' });
    // ほかの指摘は、Rule の根拠のまま。
    expect(model.findings[0]?.verification.status).not.toBe('UNVERIFIED');
  });

  it('copies the verification of the view model into the main and excluded Findings of the bundle, and explains it in the guide', async () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await createChatGptBundle(model, result, readAll(result)));
    const verificationOf = (list: 'main' | 'excluded'): ReadonlyMap<unknown, unknown> =>
      new Map(bundledFindingsOf<{ readonly finding: { readonly findingId: string }; readonly verification: unknown }>(entries, list)
        .map((entry) => [entry.finding.findingId, entry.verification]));
    const expected = (views: typeof model.mainFindings): ReadonlyMap<unknown, unknown> =>
      new Map(JSON.parse(JSON.stringify(views.map((view) => [view.finding.findingId, view.verification]))) as [unknown, unknown][]);

    // REC-4: 指摘はページごとの指摘のファイルに分かれる（並びはファイルの順なので、指摘の ID で比べる）。
    expect(verificationOf('main')).toEqual(expected(model.mainFindings));
    expect(verificationOf('excluded')).toEqual(expected(model.excludedFindings));
    const guide = decoder.decode(entries['README.md']);
    expect(guide).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.verificationNote);
  });

  it('does not put the codes of the verification in the HTML body', async () => {
    const { renderHtmlReport } = await import('../../src/report/html-report.js');
    const html = renderHtmlReport(buildReportViewModel(edgeCaseAuditRun()));
    for (const code of ['STATIC_CANDIDATE', 'NAVIGATION_OBSERVED', 'INTERACTION_REPRODUCED', 'UNVERIFIED']) {
      expect(html, code).not.toContain(code);
    }
  });
});

describe('AUD-6c: the coverage of the Web Vitals observations', () => {
  const vitalsRun = (): AuditRunResult => {
    const d1 = dom(1, PAGE_1, 'desktop', 'one');
    return auditRun({
      pages: [
        page(PAGE_1, '/', 'AUDITED', [
          d1,
          performance(2, PAGE_1, 'desktop', { INP: 'NOT_OBSERVED' }),
          performance(3, PAGE_1, 'mobile', { INP: 'NOT_OBSERVED', LCP: 'UNSUPPORTED' }),
        ], [finding(1, 'WARN', 'DOM', PAGE_1, [idOf(d1)])]),
        page(PAGE_2, '/second.html', 'AUDITED', [performance(4, PAGE_2, 'desktop', null)], []),
      ],
    });
  };

  it('counts the observed, not observed, unsupported and not collected values of each metric, without any value meaning a pass', () => {
    const model: ReportViewModel = buildReportViewModel(vitalsRun());
    const coverage = model.summary.webVitalsCoverage;

    expect(coverage.evidenceCount).toBe(3);
    expect(coverage.byMetric.INP).toEqual({ observed: 0, notObserved: 2, unsupported: 0, notCollected: 1 });
    expect(coverage.byMetric.LCP).toEqual({ observed: 1, notObserved: 0, unsupported: 1, notCollected: 1 });
    expect(coverage.byMetric.TTFB).toEqual({ observed: 2, notObserved: 0, unsupported: 0, notCollected: 1 });
    expect(coverage.interpretation).toBe('UNOBSERVED_IS_NOT_PASSING');
    // 合格の意味の値（good・pass・ok など）を持たない。
    expect(JSON.stringify(coverage)).not.toMatch(/good|pass(ed)?"|ok"/iu);
  });

  it('puts the same coverage in summary.json of the bundle, and tells in the guide that not observed does not mean good', async () => {
    const result = vitalsRun();
    const model = buildReportViewModel(result);
    const entries = unzipSync(await createChatGptBundle(model, result, readAll(result)));
    const summary = JSON.parse(decoder.decode(entries['summary.json'])) as { readonly webVitalsCoverage: unknown };

    expect(summary.webVitalsCoverage).toEqual(JSON.parse(JSON.stringify(model.summary.webVitalsCoverage)));
    expect(decoder.decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.webVitalsCoverageNote);
  });
});
