// U16b（Task 14〜17 の設計書 6.1.3、UI追補設計書 第4章）: 確定した Run から、表示用モデルを1回だけ組み立てる。
// 表示用モデルは、数え、並べ、対応づけるだけで、判定しない。Finding の件数と一覧の出どころは `AuditRunResult.findings` だけである。
import { describe, expect, it, vi } from 'vitest';
import {
  SEVERITIES,
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type EvidenceId,
  type EvidenceRecord,
  type FindingId,
  type PageId,
  type RunSummary,
} from '../../src/core/contracts.js';
import type { InteractionEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createRunId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_CATEGORY_SECTIONS,
  findingCategoriesInSection,
  sortByDisplayOrder,
} from '../../src/presentation/catalog.js';
import { describeIncompleteReason, describeInteractionReason } from '../../src/presentation/messages.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import {
  FIXTURE_ORIGIN,
  PAGE_1,
  PAGE_2,
  PAGE_3,
  auditRun as buildAuditRun,
  dom,
  finding,
  fixtureUrl as url,
  idOf,
  interaction,
  metadata,
  page,
  runStatusInput,
  safety,
  safetyEventListNames,
  safetyEventSamples,
  screenshot,
  type SafetyEventLists,
} from '../helpers/audit-run-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

// 開始のページ（PAGE-000001）: metadata、再試行の前の試行（safety、スクリーンショット、Interaction）、最終の試行。
const E_METADATA = metadata(1, PAGE_1);
const E_RETRY_SAFETY = safety(2, PAGE_1, 'desktop');
const E_RETRY_SCREENSHOT = screenshot(3, PAGE_1, 'desktop', 'VIEWPORT', 1);
const E_RETRY_INTERACTION = interaction(4, PAGE_1, 'EXECUTION_FAILED', null);
const E_DOM_DESKTOP = dom(5, PAGE_1, 'desktop', 'Top page');
const E_SHOT_DESKTOP = screenshot(6, PAGE_1, 'desktop', 'VIEWPORT');
const E_SHOT_DESKTOP_FULL = screenshot(7, PAGE_1, 'desktop', 'FULL_PAGE');
const E_INTERACTION_1 = interaction(8, PAGE_1, 'NOT_VERIFIABLE', 'CHECK_NOT_COMPLETED');
const E_SHOT_MOBILE = screenshot(9, PAGE_1, 'mobile', 'VIEWPORT');
// PAGE-000002
const E_SHOT_PAGE_2 = screenshot(10, PAGE_2, 'desktop', 'VIEWPORT');
const E_INTERACTION_2 = interaction(11, PAGE_2, 'VERIFIED', null);
const E_INTERACTION_3 = interaction(12, PAGE_2, 'NOT_VERIFIABLE', 'OBSERVED_NO_CHANGE');

// `AuditRunResult.findings` の順は、次のとおり（INFO の F3 を、ERROR の F1 より先に置く）。
const F3 = finding(3, 'INFO', 'RESOURCE', PAGE_2, [idOf(E_SHOT_PAGE_2)]);
const F1 = finding(1, 'ERROR', 'HTTP', PAGE_1, [idOf(E_DOM_DESKTOP), idOf(E_SHOT_DESKTOP)]);
const F2 = finding(2, 'WARN', 'LAYOUT', PAGE_1, [idOf(E_SHOT_DESKTOP_FULL), idOf(E_SHOT_DESKTOP)]);
const F4 = finding(4, 'WARN', 'CROSS_PAGE', null, [idOf(E_METADATA)]);
const F5 = finding(5, 'SAFETY', 'SAFETY', PAGE_2, [idOf(E_INTERACTION_2)]);
const F6 = finding(6, 'ERROR', 'JAVASCRIPT', PAGE_1, [createEvidenceId('console', 99)]);
/** ページの `findings` にだけあり、`AuditRunResult.findings` にない Finding（出どころが1つであることを確かめる）。 */
const PAGE_ONLY_FINDING = finding(7, 'ERROR', 'DOM', PAGE_1, [idOf(E_DOM_DESKTOP)]);

const STATUS_INPUT = runStatusInput({
  incompleteReasons: [{ code: 'MAX_PAGES_REACHED', detail: null }],
  crawlLimitReached: true,
  skippedRequiredWork: 1,
  notVerifiedRequiredWork: 1,
});

/** このファイルの Run の要約の値（見本の既定値からの上書き）。 */
const runValues = (): Partial<RunSummary> => ({
  runStatus: 'PARTIAL',
  // ページの結果とわざと違う件数にする（表示用モデルが数え直さないことを確かめる）。
  discoveredPageCount: 7,
  auditedPageCount: 2,
  partialPageCount: 3,
  failedPageCount: 4,
  skippedPageCount: 5,
  viewportPageCounts: {
    desktop: { audited: 2, partial: 0, failed: 0, skipped: 1 },
    mobile: { audited: 2, partial: 0, failed: 0, skipped: 1 },
  },
  effectiveConfig: createTestConfig(FIXTURE_ORIGIN, '/', { crawl: { maxPages: 2, maxDepth: 3, maxRuntimeMs: 60_000 } }),
  safety: {
    guardEnabled: true,
    blockedRequestsByMethod: { POST: 2 },
    blockedActions: { requests: 2, navigations: 1, externalActions: 0, popups: 0, downloads: 0, webSockets: 0 },
    excludedInteractionCandidateCount: 3,
    invariantViolationCount: 0,
    invariantViolations: [],
    recordTruncated: false,
  },
  unverifiedInteractionCount: 2,
  unverifiedInternalLinkCount: 1,
  retries: [{
    url: url('/'),
    attempt: 1,
    navigationOutcome: 'TIMEOUT',
    detail: 'TIMEOUT',
    evidenceIds: [idOf(E_RETRY_SAFETY), idOf(E_RETRY_SCREENSHOT), idOf(E_RETRY_INTERACTION)],
  }],
  crawlLimits: { maxPagesReached: true, maxDepthReached: false, maxRuntimeReached: false },
  incompleteReasons: [{ code: 'MAX_PAGES_REACHED', detail: null }],
});

/** このファイルの Run（見本の補助 `auditRun` に、このファイルのページと Finding を渡したもの）。 */
const auditRun = (overrides: Partial<RunSummary> = {}): AuditRunResult =>
  buildAuditRun({
    run: { ...runValues(), ...overrides },
    pages: [
      page(PAGE_1, '/', 'AUDITED', [
        E_METADATA,
        E_RETRY_SAFETY,
        E_RETRY_SCREENSHOT,
        E_RETRY_INTERACTION,
        E_DOM_DESKTOP,
        E_SHOT_DESKTOP,
        E_SHOT_DESKTOP_FULL,
        E_INTERACTION_1,
        E_SHOT_MOBILE,
      ], [F1, F2, F6, PAGE_ONLY_FINDING]),
      page(PAGE_2, '/second.html', 'AUDITED', [E_SHOT_PAGE_2, E_INTERACTION_2, E_INTERACTION_3], [F3, F5]),
      page(PAGE_3, '/third.html', 'SKIPPED', [], []),
    ],
    findings: [F3, F1, F2, F4, F5, F6],
    statusInput: STATUS_INPUT,
  });

const findingIdsOf = (views: readonly { readonly finding: { readonly findingId: FindingId } }[]): FindingId[] =>
  views.map((view) => view.finding.findingId);

function pageView(model: ReportViewModel, pageId: PageId) {
  const view = model.pages.find((candidate) => candidate.pageId === pageId);
  if (view === undefined) {
    throw new Error(`page view is missing: ${pageId}`);
  }
  return view;
}

function findingView(model: ReportViewModel, findingId: FindingId) {
  const view = model.findings.find((candidate) => candidate.finding.findingId === findingId);
  if (view === undefined) {
    throw new Error(`finding view is missing: ${findingId}`);
  }
  return view;
}

/** 値と、その中のすべてのオブジェクトが凍結されているか（凍結されていない場所の一覧）。 */
function unfrozenPaths(value: unknown, path = '$', seen = new Set<object>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return [
    ...(Object.isFrozen(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, child]) => unfrozenPaths(child, `${path}.${key}`, seen)),
  ];
}

describe('buildReportViewModel: the run summary (design 6.1.3, 6.1.4)', () => {
  it('uses the Run Status of the run summary as it is, without deciding it again', () => {
    const model = buildReportViewModel(auditRun({ runStatus: 'ABORTED_BY_SAFETY' }));
    expect(model.summary.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(model.summary.runId).toBe(createRunId(20260924000000));
  });

  it('takes the page coverage from the run summary, without counting the pages again', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.summary.coverage).toEqual({ discovered: 7, audited: 2, partial: 3, failed: 4, skipped: 5 });
  });

  it('counts site quality (ERROR, WARN, INFO) and Safety separately, only from AuditRunResult.findings', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.summary.findingCounts).toEqual({
      total: 6,
      bySeverity: { ERROR: 2, WARN: 2, INFO: 1, SAFETY: 1 },
      byGroup: { SITE_QUALITY: 5, SAFETY: 1 },
    });
    expect(Object.keys(model.summary.findingCounts.bySeverity)).toEqual([...SEVERITIES]);
  });

  it('shows the limits, whether they were reached, and the Run reasons with their Japanese descriptions', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.summary.limits).toEqual({
      maxPages: 2,
      maxDepth: 3,
      maxRuntimeMs: 60_000,
      reached: { maxPagesReached: true, maxDepthReached: false, maxRuntimeReached: false },
    });
    expect(model.summary.incompleteReasons).toEqual([
      { code: 'MAX_PAGES_REACHED', detail: null, description: describeIncompleteReason('MAX_PAGES_REACHED') },
    ]);
    expect(model.summary.unverifiedInteractionCount).toBe(2);
    expect(model.summary.unverifiedInternalLinkCount).toBe(1);
    expect(model.summary.safetyInvariantViolationCount).toBe(0);
  });
});

describe('buildReportViewModel: Findings and their sections (design 6.1.3, 6.1.4)', () => {
  it('lists the Findings of AuditRunResult.findings only, in that order (one source)', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingIdsOf(model.findings)).toEqual([F3, F1, F2, F4, F5, F6].map(({ findingId }) => findingId));
    // ページの `findings` にだけある Finding は、どこにも現れない。
    const all = [
      ...model.findings,
      ...model.criticalFindings,
      ...model.categorySections.flatMap((section) => section.findings),
      ...model.pages.flatMap((view) => view.findings),
    ];
    expect(all.map((view) => view.finding.findingId)).not.toContain(PAGE_ONLY_FINDING.findingId);
  });

  it('makes the Findings of each page from AuditRunResult.findings filtered by the page ID', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingIdsOf(pageView(model, PAGE_1).findings)).toEqual([F1, F2, F6].map(({ findingId }) => findingId));
    expect(findingIdsOf(pageView(model, PAGE_2).findings)).toEqual([F3, F5].map(({ findingId }) => findingId));
    expect(pageView(model, PAGE_1).findingCounts).toEqual({
      total: 3,
      bySeverity: { ERROR: 2, WARN: 1, INFO: 0, SAFETY: 0 },
      byGroup: { SITE_QUALITY: 3, SAFETY: 0 },
    });
  });

  it('puts every ERROR Finding, of any category, in the critical Findings', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingIdsOf(model.criticalFindings)).toEqual([F1.findingId, F6.findingId]);
  });

  it('selects the critical Findings with criticalSection of the severity catalog, not with the colour tone (design 6.1.8)', async () => {
    // カタログの `criticalSection` だけを入れ替えた表示用モデルを読み込み直す（トーンは変えない）。
    vi.resetModules();
    vi.doMock(import('../../src/presentation/catalog.js'), async (importOriginal) => {
      const actual = await importOriginal();
      const swapped = {
        ...actual.SEVERITY_CATALOG,
        ERROR: { ...actual.SEVERITY_CATALOG.ERROR, criticalSection: false },
        WARN: { ...actual.SEVERITY_CATALOG.WARN, criticalSection: true },
      };
      return { ...actual, SEVERITY_CATALOG: swapped as unknown as typeof actual.SEVERITY_CATALOG };
    });
    try {
      const { buildReportViewModel: buildWithSwappedCatalog } = await import('../../src/report/view-model.js');
      const model = buildWithSwappedCatalog(auditRun());
      expect(findingIdsOf(model.criticalFindings)).toEqual([F2.findingId, F4.findingId]);
    } finally {
      vi.doUnmock(import('../../src/presentation/catalog.js'));
      vi.resetModules();
    }
  });

  it('has every category section in the catalog order, with the categories of the section', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.categorySections.map((section) => section.section)).toEqual(
      sortByDisplayOrder(REPORT_CATEGORY_SECTIONS, REPORT_CATEGORY_SECTION_CATALOG),
    );
    for (const section of model.categorySections) {
      expect(section.categories).toEqual(findingCategoriesInSection(section.section));
    }
  });

  it('puts each Finding in the section of its category, ordered by the severity order of the catalog', () => {
    const model = buildReportViewModel(auditRun());
    const bySection = Object.fromEntries(model.categorySections.map((section) => [section.section, findingIdsOf(section.findings)]));
    expect(bySection).toEqual({
      NETWORK: [F1.findingId, F3.findingId],
      JAVASCRIPT: [F6.findingId],
      LINKS: [],
      DOM: [],
      FORM: [],
      LAYOUT: [F2.findingId],
      ACCESSIBILITY: [],
      PERFORMANCE: [],
      CROSS_PAGE: [F4.findingId],
      SAFETY: [F5.findingId],
    });
    const network = model.categorySections.find((section) => section.section === 'NETWORK');
    expect(network?.counts).toEqual({
      total: 2,
      bySeverity: { ERROR: 1, WARN: 0, INFO: 1, SAFETY: 0 },
      byGroup: { SITE_QUALITY: 2, SAFETY: 0 },
    });
  });

  it('points each Evidence reference to its place in page.json, relative to the run directory', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingView(model, F1.findingId).evidence).toEqual([
      {
        evidenceId: idOf(E_DOM_DESKTOP),
        location: {
          evidenceId: idOf(E_DOM_DESKTOP),
          type: 'dom',
          pageId: PAGE_1,
          viewport: 'desktop',
          path: 'pages/PAGE-000001/page.json',
          pointer: '/evidence/4',
          retryAttempt: null,
          relatedFindingIds: [F1.findingId],
        },
      },
      {
        evidenceId: idOf(E_SHOT_DESKTOP),
        location: expect.objectContaining({ path: 'pages/PAGE-000001/page.json', pointer: '/evidence/5' }),
      },
    ]);
    expect(findingView(model, F4.findingId).evidence[0]?.location).toMatchObject({ pageId: PAGE_1, viewport: null, pointer: '/evidence/0' });
  });

  it('keeps an Evidence reference that is not on any page, without a place', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingView(model, F6.findingId).evidence).toEqual([{ evidenceId: createEvidenceId('console', 99), location: null }]);
  });
});

describe('buildReportViewModel: screenshots and relatedFindingIds (design 6.1.3, 6.1.8)', () => {
  it('relates each final screenshot to the Findings that refer to it or to an Evidence of the same page and viewport, in the order of AuditRunResult.findings', () => {
    const model = buildReportViewModel(auditRun());
    const shots = Object.fromEntries(pageView(model, PAGE_1).screenshots.map((shot) => [shot.evidenceId, shot.relatedFindingIds]));
    // F1 は、同じページ・同じビューポート（Desktop）の DOM の Evidence を参照するので、全体のスクリーンショットにも関係づく。
    expect(shots).toEqual({
      [idOf(E_SHOT_DESKTOP)]: [F1.findingId, F2.findingId],
      [idOf(E_SHOT_DESKTOP_FULL)]: [F1.findingId, F2.findingId],
      [idOf(E_SHOT_MOBILE)]: [],
    });
    // F5 は、PAGE-000002 の Desktop の Interaction の Evidence を参照する。
    expect(pageView(model, PAGE_2).screenshots.map((shot) => shot.relatedFindingIds)).toEqual([[F3.findingId, F5.findingId]]);
  });

  it('gives each Finding its screenshots (the directly referred ones first, in the order of its evidenceRefs), with the relative path of the run directory', () => {
    const model = buildReportViewModel(auditRun());
    expect(findingView(model, F2.findingId).screenshots).toEqual([
      {
        evidenceId: idOf(E_SHOT_DESKTOP_FULL),
        pageId: PAGE_1,
        viewport: 'desktop',
        captureType: 'FULL_PAGE',
        relativePath: 'pages/PAGE-000001/desktop/full-page.png',
        relatedFindingIds: [F1.findingId, F2.findingId],
      },
      expect.objectContaining({ evidenceId: idOf(E_SHOT_DESKTOP), relativePath: 'pages/PAGE-000001/desktop/viewport.png' }),
    ]);
    expect(findingView(model, F1.findingId).screenshots.map((shot) => shot.evidenceId)).toEqual(
      [E_SHOT_DESKTOP, E_SHOT_DESKTOP_FULL].map(idOf),
    );
    expect(findingView(model, F4.findingId).screenshots).toEqual([]);
    expect(findingView(model, F6.findingId).screenshots).toEqual([]);
  });
});

describe('buildReportViewModel: the rule that relates screenshots to Findings (design 6.1.8)', () => {
  // PAGE-000001: 再試行の前の試行（Desktop の DOM とスクリーンショット）と、最終の試行（Desktop と Mobile）。PAGE-000002: Desktop だけ。
  const R_DOM = dom(21, PAGE_1, 'desktop', 'Before retry');
  const R_SHOT = screenshot(22, PAGE_1, 'desktop', 'VIEWPORT', 1);
  const D_DOM = dom(23, PAGE_1, 'desktop', 'Top page');
  const D_SHOT = screenshot(24, PAGE_1, 'desktop', 'VIEWPORT');
  const D_FULL = screenshot(25, PAGE_1, 'desktop', 'FULL_PAGE');
  const M_DOM = dom(26, PAGE_1, 'mobile', 'Top page');
  const M_SHOT = screenshot(27, PAGE_1, 'mobile', 'VIEWPORT');
  const B_DOM = dom(28, PAGE_2, 'desktop', 'Second page');
  const B_SHOT = screenshot(29, PAGE_2, 'desktop', 'VIEWPORT');

  /** 最終の試行の Desktop の DOM を参照する。 */
  const G1 = finding(31, 'ERROR', 'DOM', PAGE_1, [idOf(D_DOM)]);
  /** 再試行の前の試行の DOM だけを参照する。 */
  const G2 = finding(32, 'WARN', 'DOM', PAGE_1, [idOf(R_DOM)]);
  /** 再試行の前の試行のスクリーンショットを、直接参照する。 */
  const G3 = finding(33, 'INFO', 'LAYOUT', PAGE_1, [idOf(R_SHOT)]);
  /** Cross-page の Finding（ページを持たない）が、2つのページの Evidence を参照する。 */
  const G4 = finding(34, 'WARN', 'CROSS_PAGE', null, [idOf(B_DOM), idOf(M_DOM)]);
  /** スクリーンショットの直接の参照と、別のビューポートの Evidence の参照。同じ参照が2回ある。 */
  const G5 = finding(35, 'WARN', 'LAYOUT', PAGE_1, [idOf(M_SHOT), idOf(D_DOM), idOf(M_SHOT)]);

  const relationRun = (): AuditRunResult => buildAuditRun({
    run: {
      ...runValues(),
      retries: [{ url: url('/'), attempt: 1, navigationOutcome: 'TIMEOUT', detail: 'TIMEOUT', evidenceIds: [idOf(R_DOM), idOf(R_SHOT)] }],
    },
    pages: [
      page(PAGE_1, '/', 'AUDITED', [R_DOM, R_SHOT, D_DOM, D_SHOT, D_FULL, M_DOM, M_SHOT], []),
      page(PAGE_2, '/second.html', 'AUDITED', [B_DOM, B_SHOT], []),
    ],
    findings: [G1, G2, G3, G4, G5],
    statusInput: STATUS_INPUT,
  });

  const shotsOf = (model: ReportViewModel, findingId: FindingId): EvidenceId[] =>
    findingView(model, findingId).screenshots.map((shot) => shot.evidenceId);

  const relatedOf = (model: ReportViewModel): Record<string, readonly FindingId[]> =>
    Object.fromEntries(
      model.pages.flatMap((view) => [...view.screenshots, ...view.retryAttempts.flatMap((attempt) => attempt.screenshots)])
        .map((shot) => [shot.evidenceId, shot.relatedFindingIds]),
    );

  const related = (model: ReportViewModel, evidence: EvidenceRecord): readonly FindingId[] | undefined => relatedOf(model)[idOf(evidence)];

  it('relates the final screenshots of the same page and viewport to a Finding that refers to a final Evidence', () => {
    const model = buildReportViewModel(relationRun());
    expect(shotsOf(model, G1.findingId)).toEqual([D_SHOT, D_FULL].map(idOf));
  });

  it('does not relate the screenshots of another viewport or another page', () => {
    const model = buildReportViewModel(relationRun());
    const relatedMap = relatedOf(model);
    expect(relatedMap[idOf(M_SHOT)]).not.toContain(G1.findingId);
    expect(relatedMap[idOf(B_SHOT)]).not.toContain(G1.findingId);
    expect(shotsOf(model, G1.findingId)).not.toContain(idOf(M_SHOT));
    expect(shotsOf(model, G1.findingId)).not.toContain(idOf(B_SHOT));
  });

  it('relates a screenshot of an attempt before a retry only when a Finding refers to it directly', () => {
    const model = buildReportViewModel(relationRun());
    // 最終の試行の Desktop の Evidence を参照しても、再試行の前の試行のスクリーンショットには関係づかない。
    expect(shotsOf(model, G1.findingId)).not.toContain(idOf(R_SHOT));
    // 再試行の前の試行の Evidence の参照は、どのスクリーンショットにも関係づけない（同じ試行のスクリーンショットにも）。
    expect(shotsOf(model, G2.findingId)).toEqual([]);
    // 直接の参照だけで関係づく。最終の試行のスクリーンショットには広げない。
    expect(shotsOf(model, G3.findingId)).toEqual([idOf(R_SHOT)]);
    expect(related(model, R_SHOT)).toEqual([G3.findingId]);
  });

  it('relates a cross-page Finding through the Evidence of each page it refers to', () => {
    const model = buildReportViewModel(relationRun());
    expect(shotsOf(model, G4.findingId)).toEqual([B_SHOT, M_SHOT].map(idOf));
    expect(related(model, B_SHOT)).toEqual([G4.findingId]);
  });

  it('keeps FindingView.screenshots and ScreenshotView.relatedFindingIds consistent, in order and without duplicates', () => {
    const model = buildReportViewModel(relationRun());
    // 直接の参照（evidenceRefs の順）が先で、その後に、同じページ・同じビューポートのもの。重複は入れない。
    expect(shotsOf(model, G5.findingId)).toEqual([M_SHOT, D_SHOT, D_FULL].map(idOf));
    expect(relatedOf(model)).toEqual({
      [idOf(D_SHOT)]: [G1.findingId, G5.findingId],
      [idOf(D_FULL)]: [G1.findingId, G5.findingId],
      [idOf(M_SHOT)]: [G4.findingId, G5.findingId],
      [idOf(B_SHOT)]: [G4.findingId],
      [idOf(R_SHOT)]: [G3.findingId],
    });
    // 2つの向きが、同じ関係を表す。
    for (const view of model.findings) {
      for (const shot of view.screenshots) {
        expect(shot.relatedFindingIds, `${view.finding.findingId} -> ${shot.evidenceId}`).toContain(view.finding.findingId);
      }
    }
    for (const [evidenceId, findingIds] of Object.entries(relatedOf(model))) {
      for (const findingId of findingIds) {
        expect(shotsOf(model, findingId), `${evidenceId} -> ${findingId}`).toContain(evidenceId);
      }
    }
  });

  it('keeps the Evidence places pointing to the Findings that refer to them directly', () => {
    const model = buildReportViewModel(relationRun());
    expect(model.evidence.find((location) => location.evidenceId === idOf(D_SHOT))?.relatedFindingIds).toEqual([]);
    expect(model.evidence.find((location) => location.evidenceId === idOf(M_SHOT))?.relatedFindingIds).toEqual([G5.findingId]);
  });

});

describe('buildReportViewModel: pages and the records before a retry (design 6.1.3, 5.6.4)', () => {
  it('lists the pages in the result order, with the page and viewport states and the artifact paths', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.pages.map((view) => [view.pageId, view.status])).toEqual([
      [PAGE_1, 'AUDITED'],
      [PAGE_2, 'AUDITED'],
      [PAGE_3, 'SKIPPED'],
    ]);
    const skipped = pageView(model, PAGE_3);
    expect(skipped.viewports.map((view) => [view.viewport, view.status, view.navigationOutcome])).toEqual([
      ['desktop', 'SKIPPED', null],
      ['mobile', 'SKIPPED', null],
    ]);
    expect(skipped.incompleteReasons).toEqual([
      { code: 'MAX_PAGES_REACHED', detail: null, description: describeIncompleteReason('MAX_PAGES_REACHED') },
    ]);
    expect(skipped.viewports[0]?.incompleteReasons).toEqual(skipped.incompleteReasons);
    expect(pageView(model, PAGE_1).pageJsonPath).toBe('pages/PAGE-000001/page.json');
    expect(pageView(model, PAGE_1).visibleTextPath).toBe('pages/PAGE-000001/visible-text.txt');
    expect(pageView(model, PAGE_2).visibleTextPath).toBeNull();
    expect(pageView(model, PAGE_1).viewports.map((view) => view.viewport)).toEqual([...VIEWPORT_PROFILES]);
  });

  it('separates the records before a retry with retries[].evidenceIds, and keeps them out of the final screenshots', () => {
    const model = buildReportViewModel(auditRun());
    const start = pageView(model, PAGE_1);
    expect(start.screenshots.map((shot) => shot.evidenceId)).toEqual([E_SHOT_DESKTOP, E_SHOT_DESKTOP_FULL, E_SHOT_MOBILE].map(idOf));
    expect(start.retryAttempts).toEqual([
      {
        attempt: 1,
        navigationOutcome: 'TIMEOUT',
        detail: 'TIMEOUT',
        evidence: [E_RETRY_SAFETY, E_RETRY_SCREENSHOT, E_RETRY_INTERACTION].map((evidence, index) =>
          expect.objectContaining({ evidenceId: idOf(evidence), retryAttempt: 1, pointer: `/evidence/${index + 1}` })),
        screenshots: [{
          evidenceId: idOf(E_RETRY_SCREENSHOT),
          pageId: PAGE_1,
          viewport: 'desktop',
          captureType: 'VIEWPORT',
          relativePath: 'pages/PAGE-000001/retry-1/desktop/viewport.png',
          relatedFindingIds: [],
        }],
      },
    ]);
    expect(pageView(model, PAGE_2).retryAttempts).toEqual([]);
  });

  it('indexes every Evidence of every page with its place, marking the records before a retry', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.evidence.map((location) => location.evidenceId)).toEqual([
      E_METADATA, E_RETRY_SAFETY, E_RETRY_SCREENSHOT, E_RETRY_INTERACTION, E_DOM_DESKTOP, E_SHOT_DESKTOP,
      E_SHOT_DESKTOP_FULL, E_INTERACTION_1, E_SHOT_MOBILE, E_SHOT_PAGE_2, E_INTERACTION_2, E_INTERACTION_3,
    ].map(idOf));
    expect(model.evidence.filter((location) => location.retryAttempt !== null).map((location) => location.evidenceId)).toEqual(
      [E_RETRY_SAFETY, E_RETRY_SCREENSHOT, E_RETRY_INTERACTION].map(idOf),
    );
    expect(model.evidence.find((location) => location.evidenceId === idOf(E_SHOT_PAGE_2))).toMatchObject({
      path: 'pages/PAGE-000002/page.json',
      pointer: '/evidence/0',
      relatedFindingIds: [F3.findingId],
    });
  });
});

describe('buildReportViewModel: Interactions and Safety (design 6.1.4)', () => {
  it('lists the Interactions of the final attempts with status, notVerifiableKind and reason', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.interactions.items).toEqual([
      {
        evidenceId: idOf(E_INTERACTION_1),
        pageId: PAGE_1,
        pageUrl: url('/'),
        viewport: 'desktop',
        candidateId: (E_INTERACTION_1.payload as InteractionEvidence).candidateId,
        target: { tagName: 'button', role: null, accessibleName: 'Button 8' },
        status: 'NOT_VERIFIABLE',
        notVerifiableKind: 'CHECK_NOT_COMPLETED',
        // C18o: 理由は、未完了の理由と同じ形（コード、日本語の説明、詳細）で渡す。コードは見本の既定（NOT_VERIFIABLE の一覧の
        // 最初のコード）、詳細は見本の既定の `reason <番号>` のまま。
        reason: {
          code: 'SESSION_OPEN_DEADLINE',
          detail: 'reason 8',
          description: describeInteractionReason('SESSION_OPEN_DEADLINE'),
        },
        location: {
          evidenceId: idOf(E_INTERACTION_1),
          type: 'interaction',
          pageId: PAGE_1,
          viewport: 'desktop',
          path: 'pages/PAGE-000001/page.json',
          pointer: '/evidence/7',
          retryAttempt: null,
          relatedFindingIds: [],
        },
      },
      expect.objectContaining({ evidenceId: idOf(E_INTERACTION_2), pageId: PAGE_2, status: 'VERIFIED', notVerifiableKind: null }),
      expect.objectContaining({ evidenceId: idOf(E_INTERACTION_3), status: 'NOT_VERIFIABLE', notVerifiableKind: 'OBSERVED_NO_CHANGE' }),
    ]);
    expect(model.interactions.byStatus).toEqual({
      VERIFIED: 1,
      REJECTED_UNSAFE: 0,
      BLOCKED_BY_SAFETY: 0,
      NOT_VERIFIABLE: 2,
      EXECUTION_FAILED: 0,
    });
    expect(model.interactions.notVerifiableByKind).toEqual({ OBSERVED_NO_CHANGE: 1, CHECK_NOT_COMPLETED: 1 });
  });

  // C18o（Task 19 の前の整理の設計書 5.1.2 の「表示」）: 理由は、Evidence のコードと詳細に、コードの日本語の説明を添えたもの。
  it('gives each Interaction its reason as the code, the Japanese description and the detail of the Evidence', () => {
    const withoutDetail = interaction(13, PAGE_2, 'EXECUTION_FAILED', null, { reason: 'CLICK_FAILED', reasonDetail: null });
    const result = auditRun();
    const withExtra: AuditRunResult = {
      ...result,
      pages: result.pages.map((view) =>
        view.pageId === PAGE_2 ? { ...view, evidence: [...view.evidence, withoutDetail] } : view),
    };
    const model = buildReportViewModel(withExtra);
    const payloads = new Map(
      withExtra.pages.flatMap((view) => view.evidence).flatMap((record) =>
        record.type === 'interaction' ? [[record.evidenceId, record.payload] as const] : []),
    );
    expect(model.interactions.items.length).toBe(4);
    for (const item of model.interactions.items) {
      const payload = payloads.get(item.evidenceId);
      expect(payload, item.evidenceId).toBeDefined();
      expect(item.reason, item.evidenceId).toEqual({
        code: payload!.reason,
        detail: payload!.reasonDetail,
        description: describeInteractionReason(payload!.reason),
      });
      expect(item, item.evidenceId).not.toHaveProperty('reasonDetail');
    }
    expect(model.interactions.items.at(-1)?.reason).toEqual({
      code: 'CLICK_FAILED',
      detail: null,
      description: describeInteractionReason('CLICK_FAILED'),
    });
  });

  it('shows the Safety summary of the run as it is', () => {
    const result = auditRun();
    const model = buildReportViewModel(result);
    // C16d: `events` は、Safety の Evidence から作る事象の一覧（下の describe）。ほかの項目は `RunSummary.safety` のまま。
    const { events: _events, ...summary } = model.safety;
    expect(summary).toEqual(result.run.safety);
    expect(model.safety).not.toBe(result.run.safety);
  });

  // C16d（設計書 6.1.10）: HTML は、Interaction の Evidence の参照を `location` から描く（ID から引き直さない）。
  it('gives each Interaction the place of its Evidence, the same as the Evidence index', () => {
    const model = buildReportViewModel(auditRun());
    expect(model.interactions.items.length).toBeGreaterThan(0);
    for (const item of model.interactions.items) {
      const indexed = model.evidence.find((location) => location.evidenceId === item.evidenceId);
      expect(indexed, item.evidenceId).toBeDefined();
      expect(item.location, item.evidenceId).toEqual(indexed);
    }
    expect(model.interactions.items.map((item) => item.location?.pointer)).toEqual(['/evidence/7', '/evidence/1', '/evidence/2']);
  });
});

describe('buildReportViewModel: the Safety events (design 6.1.10)', () => {
  // PAGE-000001: 再試行の前の試行の Safety（INTERACTION）、最終の試行の Safety（PASSIVE。すべての種類）、事象のない Safety。
  // PAGE-000002: Mobile の Safety。
  const S_RETRY = safety(41, PAGE_1, 'desktop', {
    scope: 'INTERACTION',
    blockedPopups: [{ url: url('/retry-popup.html'), reason: 'INTERACTION_FROZEN' }],
  });
  const S_ALL = safety(42, PAGE_1, 'desktop', safetyEventSamples());
  const S_EMPTY = safety(43, PAGE_1, 'mobile');
  const S_SECOND = safety(44, PAGE_2, 'mobile', {
    blockedRequests: [
      { method: 'DELETE', url: url('/api/second-1'), reason: 'NON_READ_METHOD' },
      { method: 'PATCH', url: url('/api/second-2'), reason: 'NON_READ_METHOD' },
    ],
  });
  const S_NO_VIEWPORT = safety(45, PAGE_2, null, {
    excludedInteractionCandidates: [{ candidateId: 'candidate-hidden', reason: 'NOT_VISIBLE' }],
  });

  const safetyRun = (): AuditRunResult => buildAuditRun({
    run: {
      ...runValues(),
      retries: [{ url: url('/'), attempt: 1, navigationOutcome: 'TIMEOUT', detail: 'TIMEOUT', evidenceIds: [idOf(S_RETRY)] }],
    },
    pages: [
      page(PAGE_1, '/', 'AUDITED', [E_METADATA, S_RETRY, S_ALL, S_EMPTY], []),
      page(PAGE_2, '/second.html', 'AUDITED', [S_SECOND, S_NO_VIEWPORT], []),
    ],
    findings: [],
    statusInput: STATUS_INPUT,
  });

  it('uses a schema-valid Run as the test sample', async () => {
    for (const value of safetyRun().pages) {
      await expect(validateArtifact('page', value)).resolves.toEqual({ ok: true });
    }
  });

  it('lists the records of every kind of SafetyEventsEvidence (page, Evidence, kind and record order)', () => {
    const model = buildReportViewModel(safetyRun());
    const samples = safetyEventSamples();
    const kinds = safetyEventListNames();
    // 見本は、すべての種類に記録がある。
    expect(Object.keys(samples)).toEqual(kinds);
    const fromSamples = kinds.flatMap((kind) => (samples[kind as keyof SafetyEventLists] as readonly unknown[]).map(() => kind));
    expect(model.safety.events.map((event) => [event.evidenceId, event.kind])).toEqual([
      [idOf(S_RETRY), 'blockedPopups'],
      ...fromSamples.map((kind) => [idOf(S_ALL), kind]),
      [idOf(S_SECOND), 'blockedRequests'],
      [idOf(S_SECOND), 'blockedRequests'],
      [idOf(S_NO_VIEWPORT), 'excludedInteractionCandidates'],
    ]);
    expect(model.safety.events.filter((event) => event.evidenceId === idOf(S_SECOND)).map((event) => event.method)).toEqual([
      'DELETE',
      'PATCH',
    ]);
  });

  it('gives each event its fields, with null for the fields its record does not have', () => {
    const model = buildReportViewModel(safetyRun());
    const all = model.safety.events.filter((event) => event.evidenceId === idOf(S_ALL));
    const location = model.evidence.find((candidate) => candidate.evidenceId === idOf(S_ALL));
    expect(location).toBeDefined();
    const common = { evidenceId: idOf(S_ALL), pageId: PAGE_1, viewport: 'desktop', scope: 'PASSIVE', retryAttempt: null, location };
    const samples = safetyEventSamples();
    expect(all).toEqual([
      { ...common, kind: 'blockedRequests', method: 'POST', url: samples.blockedRequests[0]!.url, candidateId: null, reason: 'NON_READ_METHOD' },
      {
        ...common,
        kind: 'blockedNavigations',
        method: 'GET',
        url: samples.blockedNavigations[0]!.url,
        candidateId: null,
        reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
      },
      { ...common, kind: 'blockedWebSockets', method: null, url: 'ws://127.0.0.1:4173/socket', candidateId: null, reason: 'PASSIVE_WEBSOCKET' },
      {
        ...common,
        kind: 'blockedExternalActions',
        method: null,
        url: 'mailto:contact@example.test',
        candidateId: 'candidate-mailto',
        reason: 'EXTERNAL_ACTION',
      },
      {
        ...common,
        kind: 'blockedExternalActions',
        method: null,
        url: 'tel:+81-3-0000-0000',
        candidateId: 'candidate-tel',
        reason: 'EXTERNAL_ACTION',
      },
      { ...common, kind: 'blockedExternalActions', method: null, url: null, candidateId: 'candidate-download', reason: 'DOWNLOAD' },
      {
        ...common,
        kind: 'excludedInteractionCandidates',
        method: null,
        url: null,
        candidateId: 'candidate-submit',
        reason: 'SUBMISSION_CONTROL',
      },
      { ...common, kind: 'blockedInteractionRequests', method: 'PUT', url: url('/api/update'), candidateId: null, reason: 'INTERACTION_FROZEN' },
      { ...common, kind: 'blockedInteractionNavigations', method: 'GET', url: url('/next.html'), candidateId: null, reason: 'INTERACTION_FROZEN' },
      { ...common, kind: 'blockedPopups', method: null, url: 'javascript:alert(1)', candidateId: null, reason: 'INTERACTION_FROZEN' },
      { ...common, kind: 'blockedDownloads', method: null, url: url('/file.pdf'), candidateId: null, reason: 'PASSIVE_DOWNLOAD' },
      {
        ...common,
        kind: 'blockedInteractionWebSockets',
        method: null,
        url: 'wss://external.test/live',
        candidateId: null,
        reason: 'INTERACTION_FROZEN',
      },
      {
        ...common,
        kind: 'externalSchemeNavigations',
        method: null,
        url: 'beaksight-test-app:probe',
        candidateId: null,
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      },
    ]);
    expect(model.safety.events.find((event) => event.evidenceId === idOf(S_NO_VIEWPORT))).toMatchObject({
      pageId: PAGE_2,
      viewport: null,
      candidateId: 'candidate-hidden',
      method: null,
      url: null,
    });
  });

  it('marks the records of an attempt before a retry with retryAttempt, and keeps its scope', () => {
    const model = buildReportViewModel(safetyRun());
    const [retried] = model.safety.events;
    expect(retried).toMatchObject({
      kind: 'blockedPopups',
      evidenceId: idOf(S_RETRY),
      scope: 'INTERACTION',
      retryAttempt: 1,
      url: url('/retry-popup.html'),
      location: expect.objectContaining({ evidenceId: idOf(S_RETRY), retryAttempt: 1, pointer: '/evidence/1' }),
    });
    expect(model.safety.events.slice(1).every((event) => event.retryAttempt === null)).toBe(true);
  });

  it('points each event to the place of its Safety Evidence', () => {
    const model = buildReportViewModel(safetyRun());
    for (const event of model.safety.events) {
      expect(event.location, event.evidenceId).toEqual(model.evidence.find((location) => location.evidenceId === event.evidenceId));
    }
  });

  it('has no events when the Safety Evidence has no record, and does not change the counts of the run', () => {
    const result = auditRun();
    const model = buildReportViewModel(result);
    expect(model.safety.events).toEqual([]);
    const withEvents = buildReportViewModel(safetyRun());
    const { events: _events, ...summary } = withEvents.safety;
    expect(summary).toEqual(runValues().safety);
  });
});

describe('buildReportViewModel: immutability', () => {
  it('returns a deeply frozen model, and does not freeze or change the input', () => {
    const result = auditRun();
    const before = JSON.stringify(result);
    const model = buildReportViewModel(result);

    expect(unfrozenPaths(model)).toEqual([]);
    expect(Object.isFrozen(result.findings[0])).toBe(false);
    expect(Object.isFrozen(result.run.safety)).toBe(false);
    expect(Object.isFrozen(result.pages[0]?.evidence[0]?.payload)).toBe(false);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('builds the same model from the same Run (deterministic)', () => {
    expect(JSON.stringify(buildReportViewModel(auditRun()))).toBe(JSON.stringify(buildReportViewModel(auditRun())));
  });
});
