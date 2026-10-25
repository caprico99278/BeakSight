// T44i（Task 44 の設計書 6 章の 2026-10-22 の行。P2-9）: 表示用モデルの、category の別の件数、Rule の別の件数、Rule ごとの要約（`ruleDigests`）。
// 集計は表示用モデルの 1 か所だけで行い、ChatGPT 用バンドルは描くだけにする。出どころは `AuditRunResult.findings` だけである。
import { describe, expect, it } from 'vitest';
import { FINDING_CATEGORIES, SEVERITIES, VIEWPORT_PROFILES, type AuditRunResult, type Finding } from '../../src/core/contracts.js';
import { createFindingId } from '../../src/core/ids.js';
import { REPORT_RULE_DIGEST_EXAMPLE_COUNT } from '../../src/core/limits.js';
import { FINDING_CATEGORY_CATALOG, VIEWPORT_PROFILE_CATALOG, sortByDisplayOrder } from '../../src/presentation/catalog.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, PAGE_3, auditRun, dom, finding, idOf, page, screenshot } from '../helpers/audit-run-fixture.js';

// PAGE-000001: Desktop の DOM と、見える範囲・ページ全体のスクリーンショット、Mobile の DOM。PAGE-000002: Desktop の DOM とスクリーンショット。PAGE-000003: Desktop の DOM。
const P1_DESKTOP = dom(1, PAGE_1, 'desktop', 'p1');
const P1_SHOT = screenshot(2, PAGE_1, 'desktop', 'VIEWPORT');
const P1_FULL = screenshot(3, PAGE_1, 'desktop', 'FULL_PAGE');
const P1_MOBILE = dom(4, PAGE_1, 'mobile', 'p1 mobile');
const P2_DESKTOP = dom(5, PAGE_2, 'desktop', 'p2');
const P2_SHOT = screenshot(6, PAGE_2, 'desktop', 'VIEWPORT');
const P3_DESKTOP = dom(7, PAGE_3, 'desktop', 'p3');

/** 見本の Finding（`AuditRunResult.findings` の順）。Rule の名前は、件数と並びを確かめやすい値にする。 */
const FINDINGS: readonly Finding[] = [
  finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'LAYOUT_FIXED' }),
  finding(2, 'WARN', 'LAYOUT', PAGE_1, [idOf(P1_MOBILE)], { ruleId: 'LAYOUT_FIXED', viewport: 'mobile' }),
  finding(3, 'WARN', 'LAYOUT', PAGE_2, [idOf(P2_DESKTOP)], { ruleId: 'LAYOUT_FIXED' }),
  finding(4, 'ERROR', 'JAVASCRIPT', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'JS_ERROR' }),
  finding(5, 'WARN', 'LAYOUT', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'LAYOUT_FIXED' }),
  finding(6, 'WARN', 'LAYOUT', PAGE_3, [idOf(P3_DESKTOP)], { ruleId: 'LAYOUT_FIXED' }),
  finding(7, 'INFO', 'CROSS_PAGE', null, [idOf(P1_DESKTOP)], { ruleId: 'CROSS_TITLE' }),
  finding(8, 'INFO', 'LINK', PAGE_2, [idOf(P2_DESKTOP)], { ruleId: 'LINK_BROKEN' }),
  finding(9, 'INFO', 'LINK', PAGE_3, [idOf(P3_DESKTOP)], { ruleId: 'LINK_BROKEN' }),
  // 2 ページの 4 件（例は、ページの違う 2 件の後に、残りの 1 件で埋める）。
  finding(10, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'A11Y_NAME' }),
  finding(11, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'A11Y_NAME' }),
  finding(12, 'WARN', 'ACCESSIBILITY', PAGE_2, [idOf(P2_DESKTOP)], { ruleId: 'A11Y_NAME' }),
  finding(13, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'A11Y_NAME' }),
  // severity の混ざる Rule（並びは、いちばん重い severity で決める）。
  finding(14, 'INFO', 'DOM', PAGE_2, [idOf(P2_DESKTOP)], { ruleId: 'MIXED' }),
  finding(15, 'ERROR', 'DOM', PAGE_3, [idOf(P3_DESKTOP)], { ruleId: 'MIXED' }),
  // 件数の同じ Rule は、`ruleId` の順。
  finding(16, 'INFO', 'PERFORMANCE', PAGE_1, [idOf(P1_DESKTOP)], { ruleId: 'AAA_INFO' }),
];

const sampleRun = (): AuditRunResult =>
  auditRun({
    pages: [
      page(PAGE_1, '/', 'AUDITED', [P1_DESKTOP, P1_SHOT, P1_FULL, P1_MOBILE]),
      page(PAGE_2, '/second.html', 'AUDITED', [P2_DESKTOP, P2_SHOT]),
      page(PAGE_3, '/third.html', 'AUDITED', [P3_DESKTOP]),
    ],
    findings: FINDINGS,
  });

const counts = (values: Readonly<Record<string, number>>): Record<string, number> => ({ ...values });
const findingIds = (...sequences: readonly number[]): readonly string[] => sequences.map(createFindingId);

describe('buildReportViewModel: the counts by category and by Rule (T44i)', () => {
  it('counts the Findings of every category in the display order of the catalog, including the categories with no Finding', () => {
    const model = buildReportViewModel(sampleRun());
    const expectedOrder = sortByDisplayOrder(FINDING_CATEGORIES, FINDING_CATEGORY_CATALOG);

    expect(model.summary.findingCountsByCategory.map((entry) => entry.category)).toEqual([...expectedOrder]);
    expect(model.summary.findingCountsByCategory).toEqual(
      expectedOrder.map((category) => ({ category, count: FINDINGS.filter((value) => value.category === category).length })),
    );
    // 見本の確かめ: 0 の category を含む（HTTP・RESOURCE・FORM・SAFETY）。
    expect(model.summary.findingCountsByCategory.filter((entry) => entry.count === 0).map((entry) => entry.category)).toEqual(['HTTP', 'RESOURCE', 'FORM', 'SAFETY']);
    expect(model.summary.findingCountsByCategory.reduce((sum, entry) => sum + entry.count, 0)).toBe(model.summary.findingCounts.total);
  });

  it('counts the Findings of each Rule, the largest count first and then in ruleId order', () => {
    const model = buildReportViewModel(sampleRun());

    expect(model.summary.findingCountsByRule).toEqual([
      { ruleId: 'LAYOUT_FIXED', category: 'LAYOUT', count: 5 },
      { ruleId: 'A11Y_NAME', category: 'ACCESSIBILITY', count: 4 },
      { ruleId: 'LINK_BROKEN', category: 'LINK', count: 2 },
      { ruleId: 'MIXED', category: 'DOM', count: 2 },
      { ruleId: 'AAA_INFO', category: 'PERFORMANCE', count: 1 },
      { ruleId: 'CROSS_TITLE', category: 'CROSS_PAGE', count: 1 },
      { ruleId: 'JS_ERROR', category: 'JAVASCRIPT', count: 1 },
    ]);
  });

  it('has empty counts by Rule and zero counts by category for a Run with no Finding', () => {
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [P1_DESKTOP])], findings: [] }));

    expect(model.summary.findingCountsByRule).toEqual([]);
    expect(model.summary.findingCountsByCategory.every((entry) => entry.count === 0)).toBe(true);
    expect(model.summary.findingCountsByCategory).toHaveLength(FINDING_CATEGORIES.length);
    expect(model.ruleDigests).toEqual([]);
  });
});

describe('buildReportViewModel: the digests by Rule (T44i)', () => {
  it('orders the digests by the most severe severity in the display order, then the largest count, then ruleId', () => {
    const model = buildReportViewModel(sampleRun());

    // ERROR（MIXED は ERROR を含む 2 件、JS_ERROR は 1 件）、WARN（5 件、4 件）、INFO（2 件、1 件、1 件。同じ件数は ruleId の順）。
    expect(model.ruleDigests.map((digest) => digest.ruleId)).toEqual([
      'MIXED',
      'JS_ERROR',
      'LAYOUT_FIXED',
      'A11Y_NAME',
      'LINK_BROKEN',
      'AAA_INFO',
      'CROSS_TITLE',
    ]);
  });

  it('has the category, the counts by severity in the order of SEVERITIES, the count, the number of pages and the counts by viewport', () => {
    const model = buildReportViewModel(sampleRun());
    const digestOf = (ruleId: string) => model.ruleDigests.find((digest) => digest.ruleId === ruleId);

    const layout = digestOf('LAYOUT_FIXED');
    expect(layout?.category).toBe('LAYOUT');
    expect(layout?.count).toBe(5);
    expect(Object.keys(layout?.bySeverity ?? {})).toEqual([...SEVERITIES]);
    expect(counts(layout?.bySeverity ?? {})).toEqual({ ERROR: 0, WARN: 5, INFO: 0, SAFETY: 0 });
    // ページの数は、違うページの数（PAGE-000001 の 3 件は 1 つと数える）。
    expect(layout?.pageCount).toBe(3);
    expect(Object.keys(layout?.byViewport ?? {})).toEqual([...sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG)]);
    expect(counts(layout?.byViewport ?? {})).toEqual({ desktop: 4, mobile: 1 });
    expect(layout?.viewportIndependentCount).toBe(0);

    const mixed = digestOf('MIXED');
    expect(counts(mixed?.bySeverity ?? {})).toEqual({ ERROR: 1, WARN: 0, INFO: 1, SAFETY: 0 });
    expect(mixed?.pageCount).toBe(2);

    // ページによらない・ビューポートによらない Finding は、ページの数に入れず、ビューポートによらない件数に数える。
    const cross = digestOf('CROSS_TITLE');
    expect(cross?.pageCount).toBe(0);
    expect(counts(cross?.byViewport ?? {})).toEqual({ desktop: 0, mobile: 0 });
    expect(cross?.viewportIndependentCount).toBe(1);

    // 要約の件数の合計は、Finding の件数と同じ。
    expect(model.ruleDigests.reduce((sum, digest) => sum + digest.count, 0)).toBe(FINDINGS.length);
  });

  it('picks the examples in the order of AuditRunResult.findings, the ones of different pages first, up to REPORT_RULE_DIGEST_EXAMPLE_COUNT', () => {
    expect(REPORT_RULE_DIGEST_EXAMPLE_COUNT).toBe(3);
    const model = buildReportViewModel(sampleRun());
    const examplesOf = (ruleId: string) => model.ruleDigests.find((digest) => digest.ruleId === ruleId)?.examples.map((example) => example.findingId);

    // 5 件・3 ページ: ページの違う 3 件（1、3、6）。同じページの 2 件目（2、5）は入らない。
    expect(examplesOf('LAYOUT_FIXED')).toEqual(findingIds(1, 3, 6));
    // 4 件・2 ページ: ページの違う 2 件（10、12）の後に、残りの最初の 1 件（11）。
    expect(examplesOf('A11Y_NAME')).toEqual(findingIds(10, 12, 11));
    // 3 件より少ない Rule は、全部。
    expect(examplesOf('LINK_BROKEN')).toEqual(findingIds(8, 9));
    for (const digest of model.ruleDigests) {
      expect(digest.examples.length).toBeLessThanOrEqual(REPORT_RULE_DIGEST_EXAMPLE_COUNT);
    }
  });

  it('gives each example the ID, the page, the viewport, the message of the Rule and the screenshots of the Finding', () => {
    const model = buildReportViewModel(sampleRun());
    const [first] = model.ruleDigests.find((digest) => digest.ruleId === 'LAYOUT_FIXED')?.examples ?? [];
    const findingView = model.findings.find((value) => value.finding.findingId === createFindingId(1));

    expect(first).toEqual({
      findingId: createFindingId(1),
      pageId: PAGE_1,
      viewport: 'desktop',
      message: FINDINGS[0]?.message,
      screenshots: findingView?.screenshots,
    });
    // 見本の確かめ: 表示用モデルの例は、撮り方を問わず、Finding のスクリーンショットを持つ（バンドルに入れる撮り方で絞るのは、バンドルの側）。
    expect(first?.screenshots.map((shot) => shot.captureType)).toEqual(['VIEWPORT', 'FULL_PAGE']);
    const cross = model.ruleDigests.find((digest) => digest.ruleId === 'CROSS_TITLE')?.examples[0];
    expect(cross?.pageId).toBeNull();
    expect(cross?.viewport).toBeNull();
  });

  it('is deeply frozen and the same for the same Run', () => {
    const model = buildReportViewModel(sampleRun());
    expect(Object.isFrozen(model.ruleDigests)).toBe(true);
    expect(Object.isFrozen(model.ruleDigests[0]?.examples)).toBe(true);
    expect(Object.isFrozen(model.summary.findingCountsByRule)).toBe(true);
    expect(buildReportViewModel(sampleRun())).toEqual(model);
  });
});
