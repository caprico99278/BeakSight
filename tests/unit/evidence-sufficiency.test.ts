// EV-5（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.5）: 表示用モデルが、保留の理由ごとの数・対象が写った画像の数・まだ見ていない画面と
// ビューポートの数を 1 回だけ数え、HTML・CLI・バンドルはそれを描くだけ。再開の列の先に置く画面の決まり（時間切れで一部だけ終わった画面と、確かめを待つ指摘の
// ある画面。読み直しは確かめを待つ指摘が減らなくなったら終える）。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, screenshotRelativePath } from '../../src/core/artifact-layout.js';
import type { EvidenceCapture, EvidenceRecord, PageAuditResult } from '../../src/core/contracts.js';
import type { LayoutEvidence } from '../../src/core/evidence-types.js';
import { runSummaryLines } from '../../src/cli/output.js';
import { EVIDENCE_SUFFICIENCY_TEXT } from '../../src/presentation/messages.js';
import {
  keepsRevisit,
  pageRevisitFactOf,
  readAgainAfterRevisit,
  resumesAfterRunTimeLimit,
  revisitOrderOf,
} from '../../src/orchestration/resume-revisit.js';
import { createChatGptBundleParts } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, PAGE_3, auditRun, dom, finding, idOf, metadata, page, record, viewportResult } from '../helpers/audit-run-fixture.js';

const WIDTH = 400;
const HEIGHT = 300;
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });

const emptyLayout = (): LayoutEvidence => ({
  scrollPosition: { scrollX: 0, scrollY: 0 },
  document: {
    viewportWidth: WIDTH, viewportHeight: HEIGHT, documentElementClientWidth: WIDTH, documentElementClientHeight: HEIGHT,
    documentElementScrollWidth: WIDTH, documentElementScrollHeight: HEIGHT, bodyScrollWidth: WIDTH, bodyScrollHeight: HEIGHT,
    bodyClientWidth: WIDTH, bodyClientHeight: HEIGHT, horizontalOverflowPx: 0, viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: [], zeroSizeInteractive: [], clippedText: [], fixedHeadingOverlaps: [], elementOverlaps: [], fixedElements: [],
  truncation: {
    omittedOutsideViewportCount: 0, omittedZeroSizeInteractiveCount: 0, omittedClippedTextCount: 0, omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0, omittedFixedElementCount: 0, overlapComparisonLimitReached: false, clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
});

const capture = (phase: EvidenceCapture['phase']): EvidenceCapture => ({
  stateId: `${PAGE_1}:desktop:1` as EvidenceCapture['stateId'], phase, startedAt: '2026-11-10T00:00:00.000Z', finishedAt: '2026-11-10T00:00:01.000Z',
  url: null, scrollPosition: null,
});
const withCapture = <T extends EvidenceRecord>(value: T, captured: EvidenceCapture): T => ({ ...value, capture: captured });

/** 重なりの指摘 3 件（対象が写った・写っていない・動かして撮れなかった）のページ。Mobile は時間切れで見ていない。 */
const heldPage = (): PageAuditResult => {
  const target = (selectors: readonly string[], inclusion: 'INSIDE' | 'OUTSIDE') => ({
    purpose: 'ELEMENT_OVERLAP', selectors, position: 'TARGET', found: true,
    scroll: { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 3000 } }, ancestors: [] },
    rect: rect(0, 25, 100, 50), elementRects: [rect(0, 0, 100, 50), rect(0, 25, 100, 50)], lineRectCounts: [1, 1],
    visibleRect: inclusion === 'INSIDE' ? rect(0, 25, 100, 50) : null, hitTestPointCount: 5, hitPointCount: 5, inclusion,
  });
  const revealShot = withCapture(record('screenshot', 70, PAGE_1, 'desktop', {
    pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, null, null, 1),
    captureType: 'VIEWPORT', scrollPosition: { scrollX: 0, scrollY: 3000 },
    reveal: { viewportWidth: WIDTH, viewportHeight: HEIGHT, targets: [target(['#a', '#b'], 'INSIDE'), target(['#c', '#d'], 'OUTSIDE')] },
  } as never), capture('screenshot'));
  const layoutRecord = withCapture(record('layout', 71, PAGE_1, 'desktop', {
    primary: { status: 'COMPLETE', layout: emptyLayout() }, stressSweep: null,
  }), capture('layout'));
  const overlapOf = (sequence: number, first: string, second: string) => finding(sequence, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], {
    ruleId: 'ELEMENT_OVERLAP', groupingKeys: [{ name: 'firstSelector', value: first }, { name: 'secondSelector', value: second }],
  });
  const findings = [overlapOf(95, '#a', '#b'), overlapOf(96, '#c', '#d'), overlapOf(97, '#e', '#f')];
  const audited = page(PAGE_1, '/', 'PARTIAL', [metadata(1, PAGE_1), layoutRecord, revealShot], findings);
  const mobile = viewportResult(audited.pageUrl, 'SKIPPED', { incompleteReasons: [{ code: 'MAX_RUNTIME_REACHED', detail: null }] });
  return { ...audited, viewports: { ...audited.viewports, mobile } };
};

// S-12: 読み込めなかったページ（点検のための操作の記録が 1 件ある）。
const failedPage = (): PageAuditResult => page(PAGE_3, '/failed', 'FAILED', [], [
  finding(98, 'INFO', 'LAYOUT', PAGE_3, [], { ruleId: 'NOTIFICATION_HANDLED_BEFORE_AUDIT' }),
]);

const run = () => auditRun({ pages: [heldPage(), page(PAGE_2, '/later', 'SKIPPED'), failedPage()] });

describe('EV-5: the counts of the evidence in the report model', () => {
  it('counts the findings on hold by reason, the findings whose target is in the image, and the pages and viewports not collected', () => {
    expect(buildReportViewModel(run()).summary.evidenceSufficiency).toEqual({
      heldFindingCount: 2,
      heldByReason: { TARGET_NOT_IN_IMAGE: 1, PAGE_NOT_READY: 0, NOT_OPERATED: 1, EVIDENCE_MISMATCH: 0, PAGE_READINESS_UNKNOWN: 0 },
      targetImageJudgedCount: 2,
      targetInImageCount: 1,
      uncollectedPageCount: 1,
      uncollectedViewportCount: 3,
      failedPageCount: 1,
    });
  });

  // S-12: 点検のための操作の記録は、指摘の数に入れず、別に数える。
  it('counts the records of the operations for the audit apart from the findings', () => {
    const { summary, overview } = buildReportViewModel(run());
    expect(summary.operationRecordCount).toBe(1);
    expect([summary.findingCounts.total, summary.findingCounts.bySeverity.INFO, overview.problemCount]).toEqual([3, 0, 3]);
  });

  it('shows the counts in a few plain lines of the HTML report and the CLI, and copies them to the bundle', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const html = renderHtmlReport(model);
    const labels = [EVIDENCE_SUFFICIENCY_TEXT.heldLabel, EVIDENCE_SUFFICIENCY_TEXT.uncollectedLabel, EVIDENCE_SUFFICIENCY_TEXT.failedLabel, EVIDENCE_SUFFICIENCY_TEXT.operationRecordLabel];
    for (const text of [...labels, EVIDENCE_SUFFICIENCY_TEXT.imageLabel]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/TARGET_NOT_IN_IMAGE|NOTIFICATION_HANDLED_BEFORE_AUDIT/u);
    const cli = runSummaryLines(model.summary, 'out').join('\n');
    for (const text of labels) {
      expect(cli).toContain(text);
    }
    expect(cli).not.toContain('NOTIFICATION_HANDLED_BEFORE_AUDIT');
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, new TextEncoder().encode(JSON.stringify(result.run))]]);
    const parts = await createChatGptBundleParts(model, result, async (path) => files.get(path) ?? null);
    const summary = JSON.parse(new TextDecoder().decode(unzipSync(parts[0]?.bytes ?? new Uint8Array())['summary.json'])) as { evidenceSufficiency: unknown };
    expect(summary.evidenceSufficiency).toEqual(model.summary.evidenceSufficiency);
  });
});

describe('EV-5: the pages to read first when a run stopped by the time limit is resumed', () => {
  it('finds a page cut by the time limit and counts the findings waiting for an image of their target (not the ones waiting for the page)', () => {
    expect(pageRevisitFactOf(heldPage())).toEqual({ cutByRunTimeLimit: true, heldFindingCount: 2, collectedViewportCount: 1 });
    expect(pageRevisitFactOf(page(PAGE_2, '/done', 'AUDITED'))).toEqual({ cutByRunTimeLimit: false, heldFindingCount: 0, collectedViewportCount: 2 });
  });

  it('AUD-4: counts a finding whose layout and image do not match (EVIDENCE_MISMATCH) as waiting, and reads its page again', () => {
    const mark = { documentScroll: { scrollX: 0, scrollY: 0 }, scrollBoxes: [], structureDigest: '1:00000000000000aa' };
    const zeroBox = { selector: '#z', tagName: 'a', role: null, rect: rect(10, 10, 0, 20), visibility: { visible: true, display: 'block', visibility: 'visible',
      opacity: 1, hiddenAttribute: false, ariaHidden: false, clientRectCount: 1 }, position: 'static', zIndex: 'auto', overflowX: 'visible', overflowY: 'visible',
    hasRenderedDescendant: false, truncated: false };
    const layoutRecord = withCapture(record('layout', 71, PAGE_1, 'desktop', {
      primary: { status: 'COMPLETE', layout: { ...emptyLayout(), zeroSizeInteractive: [zeroBox], stateMark: mark } }, stressSweep: null,
    }), capture('layout'));
    // 撮る直前に読み直した対象が見つからない（消えた）。
    const shot = withCapture(record('screenshot', 72, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null), captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 0 }, stateMark: { ...mark, targetRects: [{ selector: '#z', matchCount: 0, rect: null }] },
    }), capture('screenshot'));
    const zero = finding(99, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], { ruleId: 'ZERO_SIZE_INTERACTIVE_ELEMENT', groupingKeys: [{ name: 'selector', value: '#z' }] });
    const mismatched = page(PAGE_1, '/', 'AUDITED', [layoutRecord, shot], [zero]);
    expect(pageRevisitFactOf(mismatched).heldFindingCount).toBe(1);
    expect(buildReportViewModel(auditRun({ pages: [mismatched] })).summary.evidenceSufficiency.heldByReason.EVIDENCE_MISMATCH).toBe(1);
  });

  it('AUD-6: counts a content finding of a state whose settling did not complete (PAGE_READINESS_UNKNOWN) as waiting, and reads its page again', () => {
    const domRecord = withCapture(dom(73, PAGE_1, 'desktop', '本文'), capture('dom'));
    const heading = finding(99, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(domRecord)], { ruleId: 'A11Y_PAGE_HAS_HEADING_ONE' });
    const audited = page(PAGE_1, '/', 'AUDITED', [domRecord], [heading]);
    const settling = { status: 'NOT_COMPLETED', reason: null, elapsedMs: 0, observationCount: 0, lastScrollHeight: null, watchEnd: null } as const;
    const unknown = { ...audited, viewports: { ...audited.viewports, desktop: { ...audited.viewports.desktop, stateId: capture('dom').stateId, settling } } };
    expect(pageRevisitFactOf(unknown).heldFindingCount).toBe(1);
    expect(buildReportViewModel(auditRun({ pages: [unknown] })).summary.evidenceSufficiency.heldByReason.PAGE_READINESS_UNKNOWN).toBe(1);
  });

  /** 読み直しの事実（一部だけ終わったか・確かめを待つ指摘の数・見たビューポートの数）。 */
  const fact = (cutByRunTimeLimit: boolean, heldFindingCount: number, collectedViewportCount = 2) => ({ cutByRunTimeLimit, heldFindingCount, collectedViewportCount });

  it('puts the pages cut by the time limit first, then the pages with findings on hold, and leaves the others', () => {
    const facts = [{ url: 'a', fact: fact(false, 2) }, { url: 'b', fact: fact(false, 0) }, { url: 'c', fact: fact(true, 0, 1) }];
    expect(revisitOrderOf(facts).map(({ url }) => url)).toEqual(['c', 'a']);
  });

  it.each([
    ['fewer findings on hold', fact(false, 3), fact(false, 2), true],
    ['as many findings on hold', fact(false, 2), fact(false, 2), false],
    ['no finding on hold', fact(false, 2), fact(false, 0), false],
    ['a page completed after the cut, with findings on hold', fact(true, 0, 1), fact(false, 1), true],
    ['a page cut again', fact(true, 0, 1), fact(true, 1, 1), false],
  ] as const)('reads a page again only while the findings on hold decrease: %s', (_label, before, after, expected) => {
    expect(readAgainAfterRevisit(before, after)).toBe(expected);
  });

  // REV-EV5 の I-1: 時間切れで途中になり、前より見たビューポートが少ない読み直しは捨てる。
  it.each([
    ['a full page read again and cut', fact(false, 1), fact(true, 0, 1), false],
    ['a cut page read again and cut as far', fact(true, 0, 1), fact(true, 0, 1), true],
    ['a full page read again in full', fact(false, 1), fact(false, 1), true],
  ] as const)('keeps a reading again unless it saw fewer viewports because of the time limit: %s', (_label, before, after, expected) => {
    expect(keepsRevisit(before, after)).toBe(expected);
  });

  // REV-EV5 の I-2: どれかの実行が時間切れで終わった Run は、後の実行が別の理由で止まっても読み直す。止める印だけの Run は読み直さない。
  it('reads again in a run that once stopped by the time limit, and not in a run stopped only by the stop signal', () => {
    expect(resumesAfterRunTimeLimit([{ endReason: 'STOPPED_BY_RUNTIME_LIMIT' }, { endReason: 'STOPPED_BY_SIGNAL' }])).toBe(true);
    expect(resumesAfterRunTimeLimit([{ endReason: 'STOPPED_BY_SIGNAL' }])).toBe(false);
  });
});
