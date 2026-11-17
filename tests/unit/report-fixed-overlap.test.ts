// AUD-3c: 固定の要素の重なりの区分を、表示用モデルが指摘ごとに引き（`verification.overlap`）、Finding にしなかった区分を数え（`fixedOverlapsNotCounted`）、
// バンドルに写す。描画を決められない指摘の候補群は、確信度を 1 段下げる。HTML の本文には区分のコードを出さない。ブラウザを使わない。
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type {
  FixedElementEvidence,
  LayoutEvidence,
  OverlapHitLayerEvidence,
  OverlapHitTestEvidence,
} from '../../src/core/evidence-types.js';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath } from '../../src/core/artifact-layout.js';
import { CHATGPT_BUNDLE_GUIDE_TEXT } from '../../src/presentation/messages.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, auditRun, finding, idOf, metadata, page, record } from '../helpers/audit-run-fixture.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';

const WIDTH = 400;
const HEIGHT = 300;
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height });
const visible = { visible: true, display: 'block', visibility: 'visible', opacity: 1, hiddenAttribute: false, ariaHidden: false, clientRectCount: 1 };

const layer = (selector: string, overrides: Partial<OverlapHitLayerEvidence> = {}): OverlapHitLayerEvidence => ({
  selector, relation: 'OVERLAY', position: 'fixed', zIndex: '10', pointerEvents: 'auto', effectiveOpacity: 1, visibility: 'visible',
  backgroundColor: 'rgba(0, 0, 0, 0.5)', hasBackgroundImage: false, paintsOwnSurface: true, ...overrides,
});

const hitTest = (selector: string, top: OverlapHitLayerEvidence, beneath: boolean): OverlapHitTestEvidence => ({
  target: 'BENEATH',
  points: [{ x: 10, y: 10, topRelation: top.relation, layers: [top], targetFound: beneath, targetSelector: beneath ? '#content' : null }],
  overlay: top,
  modal: { dialogModal: false, ariaModal: false },
});

const fixedElement = (selector: string, test: OverlapHitTestEvidence): FixedElementEvidence => ({
  selector, kind: 'other', rect: rect(0, 0, WIDTH, HEIGHT), area: WIDTH * HEIGHT, visibility: visible, position: 'fixed', zIndex: '10',
  overflowX: 'visible', overflowY: 'visible', fixedOrStickyAncestor: false, viewportIntersectionArea: WIDTH * HEIGHT, viewportArea: WIDTH * HEIGHT,
  viewportAreaRatio: 1, truncated: false, paintsOwnSurface: test.overlay.paintsOwnSurface, pointerEvents: test.overlay.pointerEvents, hitTest: test,
});

const layout = (): LayoutEvidence => ({
  scrollPosition: { scrollX: 0, scrollY: 0 },
  document: {
    viewportWidth: WIDTH, viewportHeight: HEIGHT, documentElementClientWidth: WIDTH, documentElementClientHeight: HEIGHT,
    documentElementScrollWidth: WIDTH, documentElementScrollHeight: HEIGHT, bodyScrollWidth: WIDTH, bodyScrollHeight: HEIGHT,
    bodyClientWidth: WIDTH, bodyClientHeight: HEIGHT, horizontalOverflowPx: 0, viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: [], zeroSizeInteractive: [], clippedText: [], fixedHeadingOverlaps: [], elementOverlaps: [],
  fixedElements: [
    // 半透明の覆い（描画を決められない）が押下を捕まえる: RENDER_AND_POINTER、確信度を下げる。
    fixedElement('#cover', hitTest('#cover', layer('#cover'), true)),
    // 内容を中に持つ外枠（下に祖先のほかの要素がない）: GEOMETRY_ONLY。
    fixedElement('#frame', hitTest('#frame', layer('#frame', { backgroundColor: 'rgb(255, 255, 255)', relation: 'OVERLAY_DESCENDANT' }), false)),
  ],
  truncation: {
    omittedOutsideViewportCount: 0, omittedZeroSizeInteractiveCount: 0, omittedClippedTextCount: 0, omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0, omittedFixedElementCount: 0, overlapComparisonLimitReached: false, clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
});

const run = () => {
  const layoutRecord = record('layout', 40, PAGE_1, 'desktop', { primary: { status: 'COMPLETE', layout: layout() }, stressSweep: null });
  const oversized = finding(70, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], {
    ruleId: 'OVERSIZED_FIXED_ELEMENT',
    groupingKeys: [{ name: 'selector', value: '#cover' }],
  });
  const other = finding(71, 'WARN', 'LAYOUT', PAGE_1, [idOf(layoutRecord)], { ruleId: 'TEXT_CLIPPING', groupingKeys: [{ name: 'selector', value: '#t' }] });
  return auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [metadata(1, PAGE_1), layoutRecord], [oversized, other])] });
};

describe('AUD-3c: the classes of the fixed overlaps in the report model and the bundle', () => {
  it('puts the class on the finding of the rules with classes only, and lowers the confidence when the paint is not determined', () => {
    const model = buildReportViewModel(run());
    const [oversized, other] = model.findings;
    expect(oversized?.verification.overlap).toEqual({ overlapClass: 'RENDER_AND_POINTER', renderDetermined: false });
    expect(other?.verification).not.toHaveProperty('overlap');
    const group = model.findingGroups.find((candidate) => candidate.ruleId === 'OVERSIZED_FIXED_ELEMENT');
    // RENDERED（HIGH）から、描画を決められないので 1 段下げる。
    expect(group?.confidence).toBe('MEDIUM');
  });

  it('counts the overlaps that are not findings', () => {
    expect(buildReportViewModel(run()).summary.fixedOverlapsNotCounted).toEqual({
      total: 1,
      byClass: [{ ruleId: 'OVERSIZED_FIXED_ELEMENT', overlapClass: 'GEOMETRY_ONLY', count: 1 }],
    });
  });

  it('copies them to the bundle, and keeps the codes out of the HTML body', async () => {
    const result = run();
    const model = buildReportViewModel(result);
    const html = renderHtmlReport(model);
    expect(html).not.toContain('GEOMETRY_ONLY');
    expect(html).not.toContain('RENDER_AND_POINTER');
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([[RUN_ARTIFACT_FILE_NAMES.run, encoder.encode(JSON.stringify(result.run))]]);
    for (const value of result.pages) {
      files.set(pageArtifactRelativePath(value.pageId, 'page'), encoder.encode(JSON.stringify(value)));
    }
    const entries = unzipSync(await createChatGptBundle(model, result, async (path) => files.get(path) ?? null));
    const summary = JSON.parse(new TextDecoder().decode(entries['summary.json'])) as { readonly fixedOverlapsNotCounted: unknown };
    expect(summary.fixedOverlapsNotCounted).toEqual(JSON.parse(JSON.stringify(model.summary.fixedOverlapsNotCounted)));
    const findings = bundledFindingsOf<{ readonly verification: { readonly overlap?: unknown } }>(entries);
    expect(findings.map(({ verification }) => verification.overlap ?? null)).toContainEqual({ overlapClass: 'RENDER_AND_POINTER', renderDetermined: false });
    expect(new TextDecoder().decode(entries['README.md'])).toContain(CHATGPT_BUNDLE_GUIDE_TEXT.fixedOverlapNote);
  });
});
