// AUD-3d: 指摘の画像の参照と対象の領域の矩形を、表示用モデルが 1 回だけ作る（`finding-image-regions.ts`）。同じ状態の画像がないときは理由を出す。幅の走査の幅の
// 画像は、それを参照する指摘にだけ関係づけ、バンドルでは指摘に関係する画像を先に詰める。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath, screenshotRelativePath } from '../../src/core/artifact-layout.js';
import type { EvidenceCapture, EvidenceRecord } from '../../src/core/contracts.js';
import type { FixedElementEvidence, LayoutEvidence, ScrollPosition } from '../../src/core/evidence-types.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT, FINDING_HOLD_REASON_TEXT, findingImageRegionLinkText } from '../../src/presentation/messages.js';
import { isPageArtifactReferencePath } from '../../src/report/artifact-references.js';
import { createChatGptBundleParts, type ChatGptBundleManifest } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { FIXTURE_OBSERVED_AT, PAGE_1, auditRun, dom, finding, idOf, metadata, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

const WIDTH = 400;
const HEIGHT = 300;
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });
const visible = { visible: true, display: 'block', visibility: 'visible', opacity: 1, hiddenAttribute: false, ariaHidden: false, clientRectCount: 1 };

const fixedElement = (selector: string, box: ReturnType<typeof rect>): FixedElementEvidence => ({
  selector, kind: 'other', rect: box, area: box.width * box.height, visibility: visible, position: 'fixed', zIndex: '10',
  overflowX: 'visible', overflowY: 'visible', fixedOrStickyAncestor: false, viewportIntersectionArea: box.width * box.height, viewportArea: WIDTH * HEIGHT,
  viewportAreaRatio: 0.5, truncated: false,
});

const layout = (width: number, scrollPosition: ScrollPosition): LayoutEvidence => ({
  scrollPosition,
  document: {
    viewportWidth: width, viewportHeight: HEIGHT, documentElementClientWidth: width, documentElementClientHeight: HEIGHT,
    documentElementScrollWidth: width, documentElementScrollHeight: HEIGHT, bodyScrollWidth: width, bodyScrollHeight: HEIGHT,
    bodyClientWidth: width, bodyClientHeight: HEIGHT, horizontalOverflowPx: 0, viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: [], zeroSizeInteractive: [], clippedText: [],
  fixedHeadingOverlaps: [{
    overlaySelector: '#cover', headingSelector: '#title', overlayRect: rect(0, 0, width, 120), headingRect: rect(8, 8, 200, 30),
    overlayVisibility: visible, headingVisibility: visible, overlayPosition: 'fixed', overlayZIndex: '10', overlayOverflowX: 'visible',
    overlayOverflowY: 'visible', headingPosition: 'static', headingZIndex: 'auto', headingOverflowX: 'visible', headingOverflowY: 'visible',
    intersection: { ...rect(8, 8, 200, 30), area: 6000 }, truncated: false,
  }],
  elementOverlaps: [],
  fixedElements: [fixedElement('#cover', rect(0, 0, width, 120))],
  truncation: {
    omittedOutsideViewportCount: 0, omittedZeroSizeInteractiveCount: 0, omittedClippedTextCount: 0, omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0, omittedFixedElementCount: 0, overlapComparisonLimitReached: false, clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
});

const capture = (viewport: 'desktop' | 'mobile', phase: EvidenceCapture['phase']): EvidenceCapture => ({
  stateId: `${PAGE_1}:${viewport}:1` as EvidenceCapture['stateId'],
  phase,
  startedAt: '2026-11-10T00:00:00.000Z',
  finishedAt: '2026-11-10T00:00:01.000Z',
  url: null,
  scrollPosition: null,
});

const withCapture = <T extends EvidenceRecord>(value: T, captured: EvidenceCapture): T => ({ ...value, capture: captured });

const widthShot = (sequence: number, width: number): EvidenceRecord => withCapture(record('screenshot', sequence, PAGE_1, 'desktop', {
  pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, width), captureType: 'VIEWPORT',
  scrollPosition: { scrollX: 0, scrollY: 0 }, stressWidth: width,
}), capture('desktop', 'stress-layout'));

const run = () => {
  // 主の layout は、50px 下へスクロールした位置で読んだ（画像は先頭で撮った）。
  const desktopLayout = withCapture(record('layout', 40, PAGE_1, 'desktop', {
    primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 50 }) },
    stressSweep: [{ width: 800, height: HEIGHT, status: 'COMPLETE', layout: layout(800, { scrollX: 0, scrollY: 0 }) }],
  }), capture('desktop', 'layout'));
  const mainShot = withCapture(record('screenshot', 50, PAGE_1, 'desktop', {
    pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null), captureType: 'VIEWPORT',
    scrollPosition: { scrollX: 0, scrollY: 0 },
  }), capture('desktop', 'screenshot'));
  // 状態のない前の版の layout と、画像のない Mobile の layout。
  const oldLayout = record('layout', 41, PAGE_1, 'desktop', { primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 0 }) }, stressSweep: null });
  const mobileLayout = withCapture(record('layout', 42, PAGE_1, 'mobile', {
    primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 0 }) }, stressSweep: null,
  }), capture('mobile', 'layout'));
  const findings = [
    finding(80, 'WARN', 'LAYOUT', PAGE_1, [idOf(desktopLayout)], { ruleId: 'OVERSIZED_FIXED_ELEMENT', groupingKeys: [{ name: 'selector', value: '#cover' }] }),
    finding(81, 'WARN', 'LAYOUT', PAGE_1, [idOf(desktopLayout)], {
      ruleId: 'FIXED_ELEMENT_OCCLUSION',
      groupingKeys: [{ name: 'overlaySelector', value: '#cover' }, { name: 'stressWidth', value: '800' }],
    }),
    finding(82, 'WARN', 'LAYOUT', PAGE_1, [idOf(oldLayout)], { ruleId: 'OVERSIZED_FIXED_ELEMENT', groupingKeys: [{ name: 'selector', value: '#cover' }] }),
    finding(83, 'WARN', 'LAYOUT', PAGE_1, [idOf(mobileLayout)], { ruleId: 'OVERSIZED_FIXED_ELEMENT', viewport: 'mobile', groupingKeys: [{ name: 'selector', value: '#cover' }] }),
  ];
  const evidence = [metadata(1, PAGE_1), desktopLayout, oldLayout, mobileLayout, mainShot, widthShot(51, 800), widthShot(52, 1024)];
  return auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', evidence, findings)] });
};

describe('AUD-3d: the image and the regions of each finding in the report model', () => {
  it('points a finding at the image of the same state, and moves the rectangle by the difference of the scroll positions', () => {
    const model = buildReportViewModel(run());
    const [main, width, old, mobile] = model.findings;
    expect(main?.imageRegion).toMatchObject({
      relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null),
      stressWidth: null,
      imageScrollPosition: { scrollX: 0, scrollY: 0 },
      regionScrollPosition: { scrollX: 0, scrollY: 50 },
      regions: [{ role: 'TARGET', selector: '#cover', rect: { x: 0, y: 50, width: WIDTH, height: 120 } }],
      reason: null,
    });
    // 幅の走査の指摘は、その幅の画像と、覆う要素・覆われる要素の矩形。
    expect(width?.imageRegion).toMatchObject({
      relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, 800),
      stressWidth: 800,
      regions: [
        { role: 'OVERLAY', selector: '#cover', rect: { x: 0, y: 0, width: 800, height: 120 } },
        { role: 'COVERED', selector: '#title', rect: { x: 8, y: 8, width: 200, height: 30 } },
      ],
      reason: null,
    });
    // 状態がない・同じ状態の画像がない指摘は、参照なしの理由。
    expect(old?.imageRegion).toMatchObject({ relativePath: null, regions: [], reason: 'EVIDENCE_WITHOUT_STATE' });
    expect(mobile?.imageRegion).toMatchObject({ relativePath: null, regions: [], reason: 'NO_SCREENSHOT_OF_STATE' });
  });

  it('EV-1: gives a focus finding of a width the width of its image, and aligns the rectangle with the position after the focus scrolled', () => {
    const shot = withCapture(record('screenshot', 60, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, 800), captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 100 }, stressWidth: 800,
    }), capture('desktop', 'focus-check'));
    const focus = withCapture(record('focus', 61, PAGE_1, 'desktop', {
      status: 'COMPLETE', viewportWidth: 800, viewportHeight: HEIGHT, scrollPosition: { scrollX: 0, scrollY: 0 }, stressWidth: 800,
      items: [{
        selector: '#link', tagName: 'a', beforeRect: rect(900, 10, 50, 20), focused: true, afterRect: rect(10, 10, 50, 20),
        visibleAfterFocus: true, hitAfterFocus: false, screenshotEvidenceId: idOf(shot),
        scroll: { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 100 } }, ancestors: [] },
      }],
    }), capture('desktop', 'focus-check'));
    const focusFinding = finding(84, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(focus), idOf(shot)], {
      ruleId: 'FOCUSED_CONTROL_HIDDEN', groupingKeys: [{ name: 'selector', value: '#link' }, { name: 'stressWidth', value: '800' }],
    });
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), shot, focus], [focusFinding])] }));
    expect(model.findings[0]?.imageRegion).toMatchObject({
      stressWidth: 800,
      regions: [{ role: 'TARGET', selector: '#link', rect: { x: 10, y: 10, width: 50, height: 20 } }],
      reason: null,
    });
  });

  it('relates a width image only to the findings that refer to it', () => {
    const model = buildReportViewModel(run());
    const findingIdOf = (index: number): string | undefined => model.findings[index]?.finding.findingId;
    const relatedOf = (width: number): readonly string[] =>
      model.artifactReferences.find((reference) => reference.path === screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, width))?.relatedFindingIds ?? ['missing'];
    expect(relatedOf(800)).toEqual([findingIdOf(1)]);
    expect(relatedOf(1024)).toEqual([]);
  });

  it('recognizes the path of a width image as a page artifact, and nothing else under the width directory', () => {
    expect(isPageArtifactReferencePath(screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, 800))).toBe(true);
    expect(isPageArtifactReferencePath(screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', 2, 800))).toBe(true);
    expect(isPageArtifactReferencePath(`pages/${PAGE_1}/desktop/stress-0/viewport.png`)).toBe(false);
    expect(isPageArtifactReferencePath(`pages/${PAGE_1}/desktop/stress-800/full-page.png`)).toBe(false);
    expect(() => screenshotRelativePath(PAGE_1, 'desktop', 'FULL_PAGE', null, 800)).toThrow(RangeError);
  });

  it('packs the width image related to a finding before the other width image, and copies the reference to the Finding file', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    for (const reference of model.artifactReferences) {
      if (reference.kind === 'SCREENSHOT') files.set(reference.path, new Uint8Array([1, 2, 3]));
    }
    const parts = await createChatGptBundleParts(model, result, async (path) => files.get(path) ?? null, { partSizeBytes: 1 });
    const first = unzipSync(parts[0]?.bytes ?? new Uint8Array());
    const manifest = JSON.parse(new TextDecoder().decode(first['manifest.json'])) as ChatGptBundleManifest;
    const partOf = (width: number): number => manifest.files.find(({ path }) => path === screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, width))?.part ?? -1;
    expect(partOf(800)).toBeGreaterThan(0);
    expect(partOf(800)).toBeLessThan(partOf(1024));
    const all: Record<string, Uint8Array> = Object.assign({}, ...parts.map((part) => unzipSync(part.bytes)));
    const findings = bundledFindingsOf<{ readonly imageRegion: { readonly relativePath: string | null } | null }>(all);
    expect(findings.map(({ imageRegion }) => imageRegion?.relativePath ?? null)).toContain(screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, 800));
  });

  it('gives an axe finding the rectangle of its target, and an empty list with the reason when the target was not read', () => {
    const node = (selector: string, region: unknown) => ({
      impact: 'serious', targetSelectors: [selector], failureSummary: null, htmlSnippet: '<img>', truncated: false, region,
    });
    const axe = withCapture(record('accessibility', 60, PAGE_1, 'desktop', {
      status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 }, regionScrollPosition: { scrollX: 0, scrollY: 30 },
      violations: [{
        ruleId: 'image-alt', impact: 'serious', help: 'h', helpUrl: 'https://rules.test/x', tags: [], omittedNodeCount: 0,
        nodes: [node('#a', { status: 'READ', rect: rect(10, 20, 30, 40) }), node('#b', { status: 'UNREADABLE', reason: 'NOT_FOUND' })],
      }],
      incomplete: [],
    } as never), capture('desktop', 'accessibility'));
    const mainShot = withCapture(record('screenshot', 50, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null), captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 0 },
    }), capture('desktop', 'screenshot'));
    const findings = ['#a', '#b'].map((selector, index) => finding(90 + index, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(axe)], {
      ruleId: 'A11Y_IMAGE_ALT', groupingKeys: [{ name: 'target', value: JSON.stringify([selector]) }],
    }));
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), axe, mainShot], findings)] }));
    // 矩形を読んだ位置（30px 下）と、画像を撮った位置（先頭）の差だけ動かす。
    expect(model.findings[0]?.imageRegion).toMatchObject({
      reason: null, regionUnavailableReason: null, regions: [{ role: 'TARGET', selector: '#a', rect: { x: 10, y: 50, width: 30, height: 40 } }],
    });
    expect(model.findings[1]?.imageRegion).toMatchObject({ reason: null, regionUnavailableReason: 'NOT_FOUND', regions: [] });
  });

  it('EV-2: points an overlap at the image taken after moving to it, and gives the hold reason when the target is not in the image', () => {
    const element = (left: number, top: number) => rect(left, top, 100, 50);
    const target = (selectors: readonly string[], inclusion: 'INSIDE' | 'OUTSIDE') => ({
      purpose: 'ELEMENT_OVERLAP', selectors, position: 'TARGET', found: true,
      scroll: { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 3000 } }, ancestors: [] },
      rect: element(0, 25), elementRects: [element(0, 0), element(0, 25)], lineRectCounts: [1, 1], visibleRect: inclusion === 'INSIDE' ? element(0, 25) : null,
      hitTestPointCount: 5, hitPointCount: 5, inclusion,
    });
    const revealShot = withCapture(record('screenshot', 70, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, null, null, 1),
      captureType: 'VIEWPORT', scrollPosition: { scrollX: 0, scrollY: 3000 },
      reveal: { viewportWidth: WIDTH, viewportHeight: HEIGHT, targets: [target(['#a', '#b'], 'INSIDE'), target(['#c', '#d'], 'OUTSIDE')] },
    } as never), capture('desktop', 'screenshot'));
    const layoutRecord = withCapture(record('layout', 71, PAGE_1, 'desktop', {
      primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 0 }) }, stressSweep: null,
    }), capture('desktop', 'layout'));
    const overlapOf = (sequence: number, first: string, second: string) => finding(sequence, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], {
      ruleId: 'ELEMENT_OVERLAP', groupingKeys: [{ name: 'firstSelector', value: first }, { name: 'secondSelector', value: second }],
    });
    const findings = [overlapOf(95, '#a', '#b'), overlapOf(96, '#c', '#d'), overlapOf(97, '#e', '#f')];
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), layoutRecord, revealShot], findings)] }));
    expect(model.findings[0]?.imageRegion).toMatchObject({
      screenshotEvidenceId: idOf(revealShot), targetInImage: 'INSIDE', holdReason: null,
      regions: [{ role: 'TARGET', selector: '#a', rect: { x: 0, y: 0, width: 100, height: 50 } }, { role: 'TARGET', selector: '#b', rect: { x: 0, y: 25 } }],
    });
    expect(model.findings[1]?.imageRegion).toMatchObject({ targetInImage: 'OUTSIDE', holdReason: 'TARGET_NOT_IN_IMAGE' });
    // 測り直しの画像も状態の画像もない重なりは、動かして撮れなかった理由。
    expect(model.findings[2]?.imageRegion).toMatchObject({ screenshotEvidenceId: null, holdReason: 'NOT_OPERATED' });
    const html = renderHtmlReport(model);
    expect(html).toContain(FINDING_HOLD_REASON_TEXT.TARGET_NOT_IN_IMAGE);
    expect(html).toContain(FINDING_HOLD_REASON_TEXT.NOT_OPERATED);
  });

  it('EV-2: relates an image taken after moving only to the findings it shows, and cuts the parts of a split overlap to the image', () => {
    const scroll = { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 0 } }, ancestors: [] };
    // 高さ 500px の 2 つの要素の重なり（画像の高さは 300px）を 2 枚に分けて撮った。
    const part = (sequence: number, index: number, top: number) => withCapture(record('screenshot', sequence, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, null, null, index + 1),
      captureType: 'VIEWPORT', scrollPosition: { scrollX: 0, scrollY: 0 },
      reveal: { viewportWidth: WIDTH, viewportHeight: HEIGHT, targets: [{
        purpose: 'ELEMENT_OVERLAP', selectors: ['#a', '#b'], position: 'TARGET', found: true, scroll, rect: rect(0, 0, 100, 300),
        elementRects: [rect(0, top, 100, 500), rect(0, top, 100, 500)], lineRectCounts: [1, 1], visibleRect: rect(0, 0, 100, 300),
        hitTestPointCount: 5, hitPointCount: 5, inclusion: 'INSIDE', segment: { index, count: 2 },
      }] },
    } as never), capture('desktop', 'screenshot'));
    const shots = [part(72, 0, 0), part(73, 1, -300)];
    const layoutRecord = withCapture(record('layout', 74, PAGE_1, 'desktop', {
      primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 0 }) }, stressSweep: null,
    }), capture('desktop', 'layout'));
    const findings = [
      finding(99, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], {
        ruleId: 'ELEMENT_OVERLAP', groupingKeys: [{ name: 'firstSelector', value: '#a' }, { name: 'secondSelector', value: '#b' }],
      }),
      finding(100, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], { ruleId: 'OVERSIZED_FIXED_ELEMENT', groupingKeys: [{ name: 'selector', value: '#cover' }] }),
    ];
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), layoutRecord, ...shots], findings)] }));
    expect(model.findings[0]?.imageRegion?.regions.map(({ rect: box }) => box)).toEqual([
      { x: 0, y: 0, width: 100, height: HEIGHT }, { x: 0, y: 0, width: 100, height: HEIGHT },
    ]);
    expect(model.findings[0]?.imageRegion?.revealScreenshotEvidenceIds).toEqual(shots.map(idOf));
    for (const shot of shots) {
      const reference = model.artifactReferences.find((candidate) => candidate.path === (shot.payload as { relativePath: string }).relativePath);
      expect(reference?.relatedFindingIds).toEqual([model.findings[0]?.finding.findingId]);
    }
    expect(CHATGPT_BUNDLE_GUIDE_TEXT.imageRegionNote).toContain('holdReason');
  });

  it('EV-2: keeps a focus finding whose control stays off the screen out of the hold, with the target recorded as outside the image', () => {
    const scroll = { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 0 } }, ancestors: [] };
    const shot = withCapture(record('screenshot', 80, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, 1), captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      reveal: { viewportWidth: WIDTH, viewportHeight: HEIGHT, targets: [{
        purpose: 'FOCUS', selectors: ['#skip'], position: 'AS_IS', found: true, scroll, rect: rect(-9999, 0, 50, 20), elementRects: [rect(-9999, 0, 50, 20)],
        lineRectCounts: [1], visibleRect: null, hitTestPointCount: 0, hitPointCount: 0, inclusion: 'OUTSIDE',
      }] },
    } as never), capture('desktop', 'focus-check'));
    const focus = withCapture(record('focus', 81, PAGE_1, 'desktop', {
      status: 'COMPLETE', viewportWidth: WIDTH, viewportHeight: HEIGHT, scrollPosition: { scrollX: 0, scrollY: 0 },
      items: [{
        selector: '#skip', tagName: 'a', beforeRect: rect(-9999, 0, 50, 20), focused: true, afterRect: rect(-9999, 0, 50, 20),
        visibleAfterFocus: true, hitAfterFocus: false, screenshotEvidenceId: idOf(shot), scroll,
      }],
    }), capture('desktop', 'focus-check'));
    const focusFinding = finding(98, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(focus), idOf(shot)], {
      ruleId: 'FOCUSED_CONTROL_HIDDEN', groupingKeys: [{ name: 'selector', value: '#skip' }],
    });
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), shot, focus], [focusFinding])] }));
    expect(model.findings[0]?.imageRegion).toMatchObject({ screenshotEvidenceId: idOf(shot), targetInImage: 'OUTSIDE', holdReason: null });
  });

  it('EV-4: points a clipped text and a scrollable region at the images taken after moving to them, and holds a region outside the image of the state', () => {
    const scroll = { document: { before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 2000 } }, ancestors: [] };
    const target = (purpose: string, selector: string) => ({
      purpose, selectors: [selector], position: 'TARGET', found: true, scroll, rect: rect(10, 100, 150, 20), elementRects: [rect(10, 100, 150, 20)],
      lineRectCounts: [1], visibleRect: rect(10, 100, 150, 20), hitTestPointCount: 5, hitPointCount: 5, inclusion: 'INSIDE',
    });
    const shot = (sequence: number, index: number, purpose: string, selector: string, phase: EvidenceCapture['phase']) => withCapture(record('screenshot', sequence, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null, null, false, null, null, index),
      captureType: 'VIEWPORT', scrollPosition: { scrollX: 0, scrollY: 2000 },
      reveal: { viewportWidth: WIDTH, viewportHeight: HEIGHT, targets: [target(purpose, selector)] },
    } as never), capture('desktop', phase));
    const clipShot = shot(110, 1, 'TEXT_CLIPPING', '#clip', 'screenshot');
    const regionShot = shot(111, 2, 'SCROLLABLE_REGION', '#region', 'focus-check');
    const mainShot = withCapture(record('screenshot', 112, PAGE_1, 'desktop', {
      pageId: PAGE_1, viewport: 'desktop', relativePath: screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null), captureType: 'VIEWPORT',
      scrollPosition: { scrollX: 0, scrollY: 0 },
    }), capture('desktop', 'screenshot'));
    const layoutRecord = withCapture(record('layout', 113, PAGE_1, 'desktop', {
      primary: { status: 'COMPLETE', layout: layout(WIDTH, { scrollX: 0, scrollY: 0 }) }, stressSweep: null,
    }), capture('desktop', 'layout'));
    const node = (selector: string, top: number) => ({
      impact: 'serious', targetSelectors: [selector], failureSummary: null, htmlSnippet: '<div>', truncated: false, region: { status: 'READ', rect: rect(10, top, 300, 40) },
    });
    const axe = withCapture(record('accessibility', 114, PAGE_1, 'desktop', {
      status: 'COMPLETE', frameScope: 'SAME_ORIGIN_ONLY', scrollPosition: { scrollX: 0, scrollY: 0 }, regionScrollPosition: { scrollX: 0, scrollY: 0 },
      violations: [{
        ruleId: 'scrollable-region-focusable', impact: 'serious', help: 'h', helpUrl: 'https://rules.test/x', tags: [], omittedNodeCount: 0,
        nodes: [node('#region', 2000), node('#far', 2100)],
      }],
      incomplete: [],
    } as never), capture('desktop', 'accessibility'));
    const regionFinding = (sequence: number, selector: string) => finding(sequence, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(axe)], {
      ruleId: 'A11Y_SCROLLABLE_REGION_FOCUSABLE', groupingKeys: [{ name: 'target', value: JSON.stringify([selector]) }],
    });
    const findings = [
      finding(115, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], { ruleId: 'TEXT_CLIPPING', groupingKeys: [{ name: 'selector', value: '#clip' }] }),
      regionFinding(116, '#region'),
      regionFinding(117, '#far'),
    ];
    const evidence = [metadata(1, PAGE_1), layoutRecord, axe, mainShot, clipShot, regionShot];
    const model = buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', evidence, findings)] }));
    expect(model.findings[0]?.imageRegion).toMatchObject({
      screenshotEvidenceId: idOf(clipShot), targetInImage: 'INSIDE', holdReason: null, regions: [{ role: 'TARGET', selector: '#clip' }],
    });
    expect(model.findings[1]?.imageRegion).toMatchObject({
      screenshotEvidenceId: idOf(regionShot), targetInImage: 'INSIDE', holdReason: null, regions: [{ role: 'TARGET', selector: '#region' }],
    });
    // 動かして撮れなかった領域は、状態の画像の範囲の外なので、確かめを待つ。
    expect(model.findings[2]?.imageRegion).toMatchObject({ screenshotEvidenceId: idOf(mainShot), targetInImage: 'OUTSIDE', holdReason: 'TARGET_NOT_IN_IMAGE' });
  });

  // EV-3: 内容に関わる指摘は、その状態の準備が終わっていなければ、準備が終わらない理由で保留にする。準備の状態は、その状態の落ち着きの待ちの終わり方
  // （表示が残ったまま終えたか）と DOM の表示の数を合わせて決める。確かめ直しの値は、確かめ直しの印のある指摘だけに使い、1 回目に準備ができていた指摘には
  // 使わない。
  it.each([
    ['ready at the first pass, with a blinking indicator read by the DOM', 'DOM_AND_HEIGHT_STABLE', undefined, undefined, null],
    ['not ready at the first pass, with no recheck', 'LOADING_INDICATOR_REMAINED', undefined, undefined, 'PAGE_NOT_READY'],
    ['not ready at first, a rule the recheck does not run', 'LOADING_INDICATOR_REMAINED', true, undefined, 'PAGE_NOT_READY'],
    ['not ready at first, persistent after the page became ready', 'LOADING_INDICATOR_REMAINED', true, 'PERSISTENT', null],
    ['not ready at first only, gone at the recheck', 'LOADING_INDICATOR_REMAINED', true, 'INITIAL_ONLY', null],
    ['not ready even at the recheck', 'LOADING_INDICATOR_REMAINED', false, 'PERSISTENT', 'PAGE_NOT_READY'],
    ['ready at the first pass, not ready at the recheck', 'DOM_AND_HEIGHT_STABLE', false, 'PERSISTENT', null],
    // REV-WSO: データが届く前に終えた落ち着き（DEF-283）も、準備が終わっていない。
    ['the data was still loading at the first pass and at the recheck', 'DATA_STILL_LOADING', false, 'PERSISTENT', 'PAGE_NOT_READY'],
  ] as const)('EV-3: gives a content finding the hold reason by the readiness of the page: %s', (_label, settled, recheckReady, mark, expected) => {
    const domRecord = withCapture(dom(90, PAGE_1, 'desktop', '読み込み中', {
      loadingIndicators: { ariaBusyCount: 1, progressbarCount: 0, indeterminateProgressCount: 0 },
    }), capture('desktop', 'dom'));
    const content = finding(99, 'WARN', 'ACCESSIBILITY', PAGE_1, [idOf(domRecord)], { ruleId: 'A11Y_PAGE_HAS_HEADING_ONE' });
    const recheck = recheckReady === undefined ? {} : { recheck: {
      status: 'RECHECKED', reason: null, stateId: `${PAGE_1}:desktop:1`, startedAt: FIXTURE_OBSERVED_AT, finishedAt: FIXTURE_OBSERVED_AT,
      settling: null, axeRuleIds: [], headings: [], pageReady: recheckReady,
      findings: mark === undefined ? [] : [{ fingerprint: content.fingerprint, ruleId: content.ruleId, state: mark }],
    } as const };
    const settling = { status: 'SETTLED', reason: settled, elapsedMs: 0, observationCount: 1, lastScrollHeight: null, watchEnd: null } as const;
    const audited = page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), domRecord], [content]);
    const desktop = { ...audited.viewports.desktop, stateId: `${PAGE_1}:desktop:1` as const, settling, ...recheck };
    const result = { ...audited, viewports: { ...audited.viewports, desktop } };
    expect(buildReportViewModel(auditRun({ pages: [result] })).findings[0]?.imageRegion?.holdReason ?? null).toBe(expected);
  });

  it('shows the image and the place in plain words in the HTML body, without the role codes', () => {
    const html = renderHtmlReport(buildReportViewModel(run()));
    expect(html).toContain(findingImageRegionLinkText);
    expect(html).toContain('左から 0 px、上から 50 px');
    expect(html).not.toContain('OVERLAY');
    expect(html).not.toContain('NO_SCREENSHOT_OF_STATE');
  });
});
