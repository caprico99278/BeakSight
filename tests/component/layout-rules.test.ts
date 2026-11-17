import { describe, expect, it } from 'vitest';
import {
  FIXED_OCCLUSION_MIN_COVERED_RATIO,
  fixedOcclusionScrollExclusionsOf,
  LAYOUT_RULES,
  LINE_CLAMP_VISIBLE_LINE_TOLERANCE,
  MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX,
  MAX_IGNORED_CLIPPED_OVERFLOW_PX,
  MIN_DYNAMIC_LAYOUT_SHIFT_SCORE,
  OVERLAP_MIN_AREA_RATIO,
  OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO,
} from '../../src/audit/layout-rules.js';
import type { AuditRule, FindingDraft, PageRuleInput } from '../../src/audit/rule.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import type { EvidenceRecord, ViewportProfile } from '../../src/core/contracts.js';
import type {
  CLSAttributionEvidence,
  ClippedTextEvidence,
  ElementOverlapEvidence,
  FixedElementEvidence,
  FixedHeadingOverlapEvidence,
  LayoutCollectionResult,
  LayoutElementEvidence,
  LayoutElementKind,
  LayoutEvidence,
  LayoutEvidencePayload,
  NormalizedHttpUrlEvidence,
  NotificationFrameEvidence,
  StressLayoutEvidence,
  OutsideViewportEvidence,
  RectangleEvidence,
  VisibilityEvidence,
  WebVitalEvidence,
  ZeroSizeInteractiveEvidence,
} from '../../src/core/evidence-types.js';
import { INTENDED_CLIPPING_KINDS, VISUALLY_HIDDEN_MAX_DIMENSION_PX } from '../../src/core/evidence-types.js';
import { NOTIFICATION_OVERLAY_TEXT } from '../../src/presentation/messages.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';

const PAGE_ID = createPageId(3);
const PAGE_URL = 'http://127.0.0.1:4173/layout-rules/page' as NormalizedHttpUrlEvidence;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

const rect = (left: number, top: number, width: number, height: number): RectangleEvidence => ({
  x: left,
  y: top,
  top,
  right: left + width,
  bottom: top + height,
  left,
  width,
  height,
});

const areaOfRect = (box: RectangleEvidence): number => box.width * box.height;

const intersectionOf = (first: RectangleEvidence, second: RectangleEvidence): RectangleEvidence & { area: number } => {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { ...rect(left, top, width, height), area: width * height };
};

const visibility = (overrides: Partial<VisibilityEvidence> = {}): VisibilityEvidence => ({
  visible: true,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  hiddenAttribute: false,
  ariaHidden: false,
  clientRectCount: 1,
  ...overrides,
});

const baseLayout = (overrides: Partial<LayoutEvidence> = {}): LayoutEvidence => ({
  scrollPosition: { scrollX: 0, scrollY: 0 },
  document: {
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    documentElementClientWidth: VIEWPORT_WIDTH,
    documentElementClientHeight: VIEWPORT_HEIGHT,
    documentElementScrollWidth: VIEWPORT_WIDTH,
    documentElementScrollHeight: 3000,
    bodyScrollWidth: VIEWPORT_WIDTH,
    bodyScrollHeight: 3000,
    bodyClientWidth: VIEWPORT_WIDTH,
    bodyClientHeight: 3000,
    horizontalOverflowPx: 0,
    viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: [],
  zeroSizeInteractive: [],
  clippedText: [],
  fixedHeadingOverlaps: [],
  elementOverlaps: [],
  fixedElements: [],
  truncation: {
    omittedOutsideViewportCount: 0,
    omittedZeroSizeInteractiveCount: 0,
    omittedClippedTextCount: 0,
    omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0,
    omittedFixedElementCount: 0,
    overlapComparisonLimitReached: false,
    clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
  ...overrides,
});

/**
 * AUD-3a: 文書をスクロールできない高さ（ビューポートと同じ）にした document の事実。下や隅の固定要素の覆いは、スクロールできる文書では数えないので、
 * スクロールと関係のない決まり（DEF-204・DEF-210 など）を確かめる試験は、これで今までの意図を保つ。
 */
const notScrollableDocument = (): LayoutEvidence['document'] => ({
  ...baseLayout().document,
  documentElementScrollHeight: VIEWPORT_HEIGHT,
  bodyScrollHeight: VIEWPORT_HEIGHT,
  bodyClientHeight: VIEWPORT_HEIGHT,
});

const layoutRecord = (
  primary: LayoutCollectionResult,
  sequence = 1,
  viewport: ViewportProfile = 'desktop',
  stressSweep: LayoutEvidencePayload['stressSweep'] = null,
): EvidenceRecord => ({
  evidenceId: createEvidenceId('layout', sequence),
  type: 'layout',
  pageId: PAGE_ID,
  viewport,
  observedAt: '2026-09-24T00:00:00.000Z',
  payload: { primary, stressSweep },
});

const complete = (layout: LayoutEvidence): LayoutCollectionResult => ({ status: 'COMPLETE', layout });

/** DEF-210: 通知の枠の事実 1 つ（digest は `seed` から作る）。 */
const notificationFrame = (seed: string, overrides: Partial<NotificationFrameEvidence> = {}): NotificationFrameEvidence => ({
  digest: `sha256:${seed.repeat(64).slice(0, 64)}`,
  status: 'DISMISSIBLE',
  pressed: false,
  dismissed: false,
  hidden: false,
  hiddenReason: null,
  firstSeen: true,
  ...overrides,
});

/** DEF-210: layout の Evidence に、主の読み込みの通知の枠の事実（と、任意で閉じる前の layout と、幅の走査の事実）を足す。 */
const withNotificationOverlay = (
  record: EvidenceRecord,
  frames: readonly NotificationFrameEvidence[],
  extra: Partial<LayoutEvidencePayload> = {},
): EvidenceRecord => {
  if (record.type !== 'layout') throw new Error('not a layout record');
  return {
    ...record,
    payload: {
      ...record.payload,
      notificationOverlay: { readStatus: 'READ', frames, pressCount: frames.filter((frame) => frame.pressed).length, navigated: false, truncated: false },
      ...extra,
    },
  };
};

const input = (evidence: readonly EvidenceRecord[], viewport: ViewportProfile = 'desktop'): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: PAGE_URL,
  viewport,
  evidence,
});

const ruleById = (ruleId: string): AuditRule => {
  const rule = LAYOUT_RULES.find((candidate) => candidate.ruleId === ruleId);
  expect(rule, `${ruleId} が LAYOUT_RULES に登録されていること`).toBeDefined();
  return rule as AuditRule;
};

const evaluate = (ruleId: string, evidence: readonly EvidenceRecord[]): readonly FindingDraft[] =>
  ruleById(ruleId).evaluate(input(evidence));

const identity = (draft: FindingDraft | undefined, name: string): string | undefined =>
  draft?.identityFields.find((field) => field.name === name)?.value;

const element = (
  selector: string,
  kind: LayoutElementKind,
  box: RectangleEvidence,
  overrides: Partial<LayoutElementEvidence> = {},
): LayoutElementEvidence => ({
  selector,
  kind,
  rect: box,
  area: box.width * box.height,
  visibility: visibility(),
  position: 'static',
  zIndex: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  fixedOrStickyAncestor: false,
  ...overrides,
});

const overlap = (first: LayoutElementEvidence, second: LayoutElementEvidence): ElementOverlapEvidence => ({
  first,
  second,
  intersection: intersectionOf(first.rect, second.rect),
  truncated: false,
});

const outside = (
  selector: string,
  box: RectangleEvidence,
  overrides: Partial<OutsideViewportEvidence> = {},
): OutsideViewportEvidence => ({
  selector,
  kind: 'image',
  rect: box,
  visibility: visibility(),
  position: 'static',
  zIndex: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  horizontalClipAncestor: 'NONE',
  nearestListedAncestorIndex: null,
  outside: {
    left: box.left < 0,
    right: box.right > VIEWPORT_WIDTH,
    top: box.top < 0,
    bottom: box.bottom > VIEWPORT_HEIGHT,
  },
  truncated: false,
  ...overrides,
});

const clipped = (selector: string, overrides: Partial<ClippedTextEvidence> = {}): ClippedTextEvidence => ({
  selector,
  text: '見切れる可能性のある長いテキスト',
  rect: rect(0, 100, 300, 80),
  visibility: visibility(),
  overflowX: 'visible',
  overflowY: 'hidden',
  position: 'static',
  zIndex: 'auto',
  clientWidth: 300,
  clientHeight: 80,
  scrollWidth: 300,
  scrollHeight: 120,
  widthClipped: false,
  heightClipped: true,
  partiallyClippedText: true,
  truncated: false,
  ...overrides,
});

const zeroSize = (selector: string, overrides: Partial<ZeroSizeInteractiveEvidence> = {}): ZeroSizeInteractiveEvidence => ({
  selector,
  tagName: 'a',
  role: null,
  rect: rect(10, 10, 0, 0),
  visibility: visibility(),
  position: 'static',
  zIndex: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  hasRenderedDescendant: false,
  truncated: false,
  ...overrides,
});

const fixedElement = (
  selector: string,
  box: RectangleEvidence,
  overrides: Partial<FixedElementEvidence> = {},
): FixedElementEvidence => {
  const viewportArea = VIEWPORT_WIDTH * VIEWPORT_HEIGHT;
  const visible = intersectionOf(box, rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)).area;
  return {
    ...element(selector, 'other', box, { position: 'fixed' }),
    position: 'fixed',
    viewportIntersectionArea: visible,
    viewportArea,
    viewportAreaRatio: visible / viewportArea,
    truncated: false,
    ...overrides,
  };
};

const fixedHeading = (
  overlaySelector: string,
  overlayRect: RectangleEvidence,
  headingSelector: string,
  headingRect: RectangleEvidence,
  overrides: Partial<FixedHeadingOverlapEvidence> = {},
): FixedHeadingOverlapEvidence => ({
  overlaySelector,
  headingSelector,
  overlayRect,
  headingRect,
  overlayVisibility: visibility(),
  headingVisibility: visibility(),
  overlayPosition: 'fixed',
  overlayZIndex: '10',
  overlayOverflowX: 'visible',
  overlayOverflowY: 'visible',
  headingPosition: 'static',
  headingZIndex: 'auto',
  headingOverflowX: 'visible',
  headingOverflowY: 'visible',
  intersection: intersectionOf(overlayRect, headingRect),
  truncated: false,
  ...overrides,
});

const observedVital = <T>(value: number, attribution: T | null = null): WebVitalEvidence<T> => ({
  status: 'OBSERVED',
  value,
  id: 'v1-1',
  navigationType: 'navigate',
  attribution,
});

const notObservedVital = <T>(): WebVitalEvidence<T> => ({
  status: 'NOT_OBSERVED',
  value: null,
  id: null,
  navigationType: null,
  attribution: null,
});

const performanceRecord = (cls: WebVitalEvidence<CLSAttributionEvidence>, sequence = 1): EvidenceRecord => ({
  evidenceId: createEvidenceId('performance', sequence),
  type: 'performance',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: '2026-09-24T00:00:00.000Z',
  payload: {
    status: 'COMPLETE',
    reason: 'COLLECTED',
    webVitals: {
      CLS: cls,
      FCP: notObservedVital(),
      INP: notObservedVital(),
      LCP: notObservedVital(),
      TTFB: notObservedVital(),
    },
    navigationTiming: null,
    resources: [],
    resourceSummaries: null,
    resourceCoverage: null,
    serverTiming: [],
    telemetryHeaders: [],
    telemetryCandidates: [],
    truncation: null,
  },
});

const EXPECTED_RULES = [
  ['DOCUMENT_HORIZONTAL_OVERFLOW', 'ERROR'],
  ['ELEMENT_OUTSIDE_VIEWPORT', 'WARN'],
  ['ELEMENT_OVERLAP', 'WARN'],
  ['TEXT_CLIPPING', 'WARN'],
  ['FIXED_ELEMENT_OCCLUSION', 'WARN'],
  ['ZERO_SIZE_INTERACTIVE_ELEMENT', 'WARN'],
  ['CONTENT_COLLISION', 'WARN'],
  ['OVERSIZED_FIXED_ELEMENT', 'WARN'],
  ['DYNAMIC_LAYOUT_SHIFT', 'WARN'],
  ['NOTIFICATION_NOT_DISMISSIBLE', 'WARN'],
  ['NOTIFICATION_HANDLED_BEFORE_AUDIT', 'INFO'],
] as const;

describe('LAYOUT_RULES の登録', () => {
  it('設計書 5.1 の LAYOUT の Rule が、category LAYOUT と表の severity で、すべて登録されている', () => {
    expect(LAYOUT_RULES.map((rule) => rule.ruleId).sort()).toEqual(EXPECTED_RULES.map(([ruleId]) => ruleId).sort());
    for (const [ruleId, severity] of EXPECTED_RULES) {
      const rule = ruleById(ruleId);
      expect(rule.category).toBe('LAYOUT');
      expect(rule.severity).toBe(severity);
      expect(rule.version).toBe(1);
      expect(rule.ruleIdPrefix).toBeUndefined();
    }
  });

  it('判定の定数は、Rule のファイルが名前付きで持つ', () => {
    expect(OVERLAP_MIN_AREA_RATIO).toBe(0.25);
    expect(FIXED_OCCLUSION_MIN_COVERED_RATIO).toBe(0.25);
    expect(OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO).toBe(0.3);
    expect(MIN_DYNAMIC_LAYOUT_SHIFT_SCORE).toBe(0.1);
  });

  it('Evidence がない入力や、layout の結果がない PARTIAL の Evidence からは、例外を投げずに Finding を作らない', () => {
    const partialWithoutLayout = layoutRecord({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null });
    for (const rule of LAYOUT_RULES) {
      expect(rule.evaluate(input([]))).toEqual([]);
      expect(rule.evaluate(input([partialWithoutLayout]))).toEqual([]);
    }
  });

  it('別のビューポートの Evidence は、判定に使わない', () => {
    const mobileOverflow = layoutRecord(
      complete(baseLayout({ document: { ...baseLayout().document, horizontalOverflowPx: 40 } })),
      1,
      'mobile',
    );
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [mobileOverflow])).toEqual([]);
  });
});

describe('DOCUMENT_HORIZONTAL_OVERFLOW', () => {
  it('文書の横幅がビューポートを超えると、超えた量を含む ERROR を作る', () => {
    const layout = baseLayout({
      document: { ...baseLayout().document, documentElementScrollWidth: 1464, horizontalOverflowPx: 24 },
    });
    const record = layoutRecord(complete(layout));
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      ruleId: 'DOCUMENT_HORIZONTAL_OVERFLOW',
      ruleVersion: 1,
      category: 'LAYOUT',
      severity: 'ERROR',
      evidenceRefs: [record.evidenceId],
      identityFields: [],
    });
    expect(drafts[0]?.message).toContain('24 px');
    expect(drafts[0]?.message).toContain('1440 px');
  });

  it('横にはみ出していなければ、Finding を作らない', () => {
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [layoutRecord(complete(baseLayout()))])).toEqual([]);
  });

  it('PARTIAL の収集でも、集めた layout の事実は判定に使う', () => {
    const layout = baseLayout({ document: { ...baseLayout().document, horizontalOverflowPx: 10 } });
    const record = layoutRecord({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout });
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record])).toHaveLength(1);
  });

  // 設計書 5.1.2（RT12c）: ビューポートの横方向の overflow が hidden・clip なら、横スクロールが生じない。
  it('ビューポートの横方向の overflow が切り取り（CLIPPED）なら、文書が広くても Finding を作らない', () => {
    const layout = baseLayout({
      document: {
        ...baseLayout().document,
        documentElementScrollWidth: 1600,
        bodyScrollWidth: 1600,
        horizontalOverflowPx: 160,
        viewportHorizontalClip: 'CLIPPED',
      },
    });
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [layoutRecord(complete(layout))])).toEqual([]);
  });

  it.each(['NONE', 'SCROLLABLE'] as const)(
    'ビューポートの横方向の overflow が %s なら、横スクロールが生じるので Finding を作る',
    (viewportHorizontalClip) => {
      const layout = baseLayout({
        document: { ...baseLayout().document, horizontalOverflowPx: 24, viewportHorizontalClip },
      });
      expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [layoutRecord(complete(layout))])).toHaveLength(1);
    },
  );
});

describe('ELEMENT_OUTSIDE_VIEWPORT', () => {
  it('通常の流れにある可視の要素が、横方向にビューポートの外へはみ出すと、selector を同一性にした WARN を作る', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#wide-table', rect(40, 200, 1500, 300)),
        outside('#left-bleed', rect(-30, 600, 200, 100), { position: 'relative' }),
      ],
    })));
    const drafts = evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]);
    expect(drafts.map((draft) => identity(draft, 'selector'))).toEqual(['#wide-table', '#left-bleed']);
    expect(drafts[0]?.severity).toBe('WARN');
    expect(drafts[0]?.message).toContain('#wide-table');
    expect(drafts[0]?.message).toContain('1540 px');
    expect(drafts[1]?.message).toContain('-30 px');
  });

  it('画面外に置いて隠す要素、通常の流れの外の要素、見えない要素、縦方向だけのはみ出しは、Finding にしない', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#skip-link', rect(-9999, 0, 100, 20)),
        outside('#offscreen-right', rect(1500, 0, 100, 20)),
        outside('#absolute-decoration', rect(1400, 100, 200, 200), { position: 'absolute' }),
        outside('#fixed-drawer', rect(1400, 0, 300, 900), { position: 'fixed' }),
        outside('#transparent', rect(1400, 100, 200, 200), { visibility: visibility({ opacity: 0 }) }),
        outside('#aria-hidden', rect(1400, 100, 200, 200), { visibility: visibility({ ariaHidden: true }) }),
        outside('#below-fold', rect(0, 800, 400, 400)),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record])).toEqual([]);
  });

  it('横方向に切り取る祖先（CLIPPED）か、スクロールできる祖先（SCROLLABLE）の中の要素は、Finding にしない（RT12 の I1）', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#carousel-slide', rect(1200, 100, 400, 200), { horizontalClipAncestor: 'CLIPPED' }),
        outside('#carousel-image', rect(1300, 100, 400, 200), { horizontalClipAncestor: 'CLIPPED' }),
        outside('#scroll-table-link', rect(1400, 300, 200, 20), { kind: 'link', horizontalClipAncestor: 'SCROLLABLE' }),
        outside('#body-hidden-bleed', rect(40, 500, 1600, 100), { horizontalClipAncestor: 'CLIPPED' }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record])).toEqual([]);
  });

  it('主要要素でない要素（kind が other）は、Finding にしない（RT12 の I1）', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#carousel-track', rect(0, 100, 3600, 200), { kind: 'other' }),
        outside('#wide-image', rect(0, 400, 1600, 200), { kind: 'image' }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]).map((draft) => identity(draft, 'selector'))).toEqual([
      '#wide-image',
    ]);
  });

  it('横にはみ出す祖先が一覧にある要素は、祖先と重ねて Finding にしない（RT12 の I1）', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#wide-figure', rect(0, 100, 1600, 300), { kind: 'image' }),
        outside('#wide-figure-image', rect(0, 100, 1600, 200), { kind: 'image', nearestListedAncestorIndex: 0 }),
        outside('#wide-figure-link', rect(0, 320, 1500, 20), { kind: 'link', nearestListedAncestorIndex: 1 }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]).map((draft) => identity(draft, 'selector'))).toEqual([
      '#wide-figure',
    ]);
  });

  it('表（table）と埋め込み（media）は主要要素として、横にはみ出すと Finding にする（RT12r の N3）', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#wide-table', rect(0, 100, 1600, 300), { kind: 'table' }),
        outside('#wide-frame', rect(0, 500, 1600, 200), { kind: 'media' }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]).map((draft) => identity(draft, 'selector'))).toEqual([
      '#wide-table',
      '#wide-frame',
    ]);
  });

  it('一覧の祖先が縦方向だけにはみ出す場合は、横にはみ出す要素を引き続き Finding にする（RT12 の I1）', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#tall-main', rect(0, 0, VIEWPORT_WIDTH, 3000), { kind: 'other' }),
        outside('#fixed-width-image', rect(0, 200, 1600, 100), { kind: 'image', nearestListedAncestorIndex: 0 }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]).map((draft) => identity(draft, 'selector'))).toEqual([
      '#fixed-width-image',
    ]);
  });
});

describe('ELEMENT_OVERLAP と CONTENT_COLLISION', () => {
  const imageA = element('#image-a', 'image', rect(0, 0, 200, 200));
  const imageB = element('#image-b', 'image', rect(100, 0, 200, 200));
  const heading = element('#heading', 'heading', rect(0, 0, 400, 40));
  const paragraph = element('#paragraph', 'paragraph', rect(0, 20, 400, 100));

  it('どちらも静的配置のテキストでない要素が、しきい値を超えて重なると、ELEMENT_OVERLAP の WARN を作る', () => {
    const record = layoutRecord(complete(baseLayout({ elementOverlaps: [overlap(imageA, imageB)] })));
    const drafts = evaluate('ELEMENT_OVERLAP', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'firstSelector')).toBe('#image-a');
    expect(identity(drafts[0], 'secondSelector')).toBe('#image-b');
    expect(drafts[0]?.message).toContain('50%');
    expect(drafts[0]?.message).toContain('25%');
    expect(evaluate('CONTENT_COLLISION', [record])).toEqual([]);
  });

  it('見出しと段落がしきい値を超えて重なると、CONTENT_COLLISION の WARN を作り、ELEMENT_OVERLAP にはしない', () => {
    const record = layoutRecord(complete(baseLayout({ elementOverlaps: [overlap(heading, paragraph)] })));
    const drafts = evaluate('CONTENT_COLLISION', [record]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.severity).toBe('WARN');
    expect(identity(drafts[0], 'firstSelector')).toBe('#heading');
    expect(identity(drafts[0], 'secondSelector')).toBe('#paragraph');
    expect(evaluate('ELEMENT_OVERLAP', [record])).toEqual([]);
  });

  it('同一性の要素は、2つの selector の順序に左右されない', () => {
    const forward = evaluate('ELEMENT_OVERLAP', [layoutRecord(complete(baseLayout({
      elementOverlaps: [overlap(imageA, imageB)],
    })))]);
    const reversed = evaluate('ELEMENT_OVERLAP', [layoutRecord(complete(baseLayout({
      elementOverlaps: [overlap(imageB, imageA)],
    })))]);
    expect(reversed[0]?.identityFields).toEqual(forward[0]?.identityFields);
  });

  it('しきい値以下の重なり、静的配置でない要素、固定要素の子孫、z-index の指定、見えない要素、テキストと画像の組は、Finding にしない', () => {
    const slightly = element('#slightly', 'image', rect(190, 0, 200, 200));
    const overlaps = [
      overlap(imageA, slightly),
      overlap(imageA, element('#absolute', 'image', rect(100, 0, 200, 200), { position: 'absolute' })),
      overlap(imageA, element('#relative', 'image', rect(100, 0, 200, 200), { position: 'relative' })),
      overlap(imageA, element('#in-fixed', 'image', rect(100, 0, 200, 200), { fixedOrStickyAncestor: true })),
      overlap(imageA, element('#fixed', 'image', rect(100, 0, 200, 200), { position: 'fixed' })),
      overlap(imageA, element('#stacked', 'image', rect(100, 0, 200, 200), { zIndex: '2' })),
      overlap(imageA, element('#transparent', 'image', rect(100, 0, 200, 200), {
        visibility: visibility({ opacity: 0 }),
      })),
      overlap(heading, element('#float-image', 'image', rect(0, 0, 100, 100))),
      overlap(heading, element('#text-small', 'paragraph', rect(0, 35, 400, 100))),
    ];
    const record = layoutRecord(complete(baseLayout({ elementOverlaps: overlaps })));
    expect(evaluate('ELEMENT_OVERLAP', [record])).toEqual([]);
    expect(evaluate('CONTENT_COLLISION', [record])).toEqual([]);
  });

  it('EV-1: 行ごとの矩形が重ならない組（外接矩形だけの重なり）は ELEMENT_OVERLAP にしない。REV-SD2 の I-3: 重なりの点の hit-test では消さない', () => {
    const link = element('#link', 'link', rect(0, 0, 300, 40));
    const image = element('#image', 'image', rect(200, 20, 100, 40));
    const withLines = (lineOverlap: NonNullable<ElementOverlapEvidence['lineOverlap']>): EvidenceRecord =>
      layoutRecord(complete(baseLayout({ elementOverlaps: [{ ...overlap(link, image), lineOverlap }] })));
    expect(evaluate('ELEMENT_OVERLAP', [withLines({ area: 0, pointCount: 0, bothHitPointCount: 0 })])).toEqual([]);
    expect(evaluate('ELEMENT_OVERLAP', [withLines({ area: 2000, pointCount: 1, bothHitPointCount: 0 })])).toHaveLength(1);
  });

  it('表（table）と埋め込み（media）を含む組は、どちらの Rule の対象にもしない（RT12r の N3。結果を変えない）', () => {
    const table = element('#table', 'table', rect(100, 0, 200, 200));
    const frame = element('#frame', 'media', rect(100, 0, 200, 200));
    const record = layoutRecord(complete(baseLayout({
      elementOverlaps: [
        overlap(imageA, table),
        overlap(imageA, frame),
        overlap(table, frame),
        overlap(heading, element('#frame-under-heading', 'media', rect(0, 0, 400, 40))),
      ],
    })));
    expect(evaluate('ELEMENT_OVERLAP', [record])).toEqual([]);
    expect(evaluate('CONTENT_COLLISION', [record])).toEqual([]);
  });
});

describe('TEXT_CLIPPING', () => {
  it('overflow が hidden か clip の方向で内容が見切れていると、実際の大きさを含む WARN を作る', () => {
    const record = layoutRecord(complete(baseLayout({
      clippedText: [
        clipped('#card-body'),
        clipped('#title', {
          overflowX: 'clip',
          overflowY: 'visible',
          clientWidth: 200,
          scrollWidth: 260,
          widthClipped: true,
          heightClipped: false,
        }),
      ],
    })));
    const drafts = evaluate('TEXT_CLIPPING', [record]);
    expect(drafts.map((draft) => identity(draft, 'selector'))).toEqual(['#card-body', '#title']);
    expect(drafts[0]?.message).toContain('80 px');
    expect(drafts[0]?.message).toContain('120 px');
    expect(drafts[0]?.message).toContain('見切れる可能性のある長いテキスト');
    expect(drafts[1]?.message).toContain('260 px');
  });

  it('スクロールできる領域、1 px の差、画面外に隠すための 1 px の箱、見えない要素は、Finding にしない', () => {
    const record = layoutRecord(complete(baseLayout({
      clippedText: [
        clipped('#scrollable', { overflowY: 'auto' }),
        clipped('#scroll', { overflowY: 'scroll' }),
        clipped('#rounding', { scrollHeight: 81 }),
        clipped('#sr-only', { rect: rect(0, 0, 1, 1), clientWidth: 1, clientHeight: 1, scrollHeight: 40 }),
        clipped('#transparent', { visibility: visibility({ opacity: 0 }) }),
      ],
    })));
    expect(evaluate('TEXT_CLIPPING', [record])).toEqual([]);
  });

  it('テキストの行が箱の境界をまたいでいない候補（partiallyClippedText が false）は、Finding にしない（RT12 の I2）', () => {
    const record = layoutRecord(complete(baseLayout({
      clippedText: [
        clipped('#carousel', {
          overflowX: 'hidden',
          clientWidth: 400,
          scrollWidth: 1200,
          widthClipped: true,
          partiallyClippedText: false,
        }),
        clipped('#zoom-card', { partiallyClippedText: false }),
        clipped('#cut-caption', { partiallyClippedText: true }),
      ],
    })));
    expect(evaluate('TEXT_CLIPPING', [record]).map((draft) => identity(draft, 'selector'))).toEqual(['#cut-caption']);
  });

  it('clip・clip-path で描く面が 0 の要素（祖先を含む）は、大きさが 1 px より大きくても Finding にしない。印のない記録は今のとおり（DEF-205）', () => {
    const record = layoutRecord(complete(baseLayout({
      clippedText: [
        clipped('#skip-link', {
          rect: rect(0, 0, 44, 44),
          clientWidth: 44,
          scrollWidth: 208,
          overflowX: 'hidden',
          widthClipped: true,
          visibility: visibility({ clippedToZeroArea: true }),
        }),
        clipped('#really-cut', { visibility: visibility({ clippedToZeroArea: false }) }),
        clipped('#older-record'),
      ],
    })));
    expect(evaluate('TEXT_CLIPPING', [record]).map((draft) => identity(draft, 'selector'))).toEqual(['#really-cut', '#older-record']);
  });
});

describe('AUD-4a: 意図した省略（ellipsis・行数の省略・閉じた折りたたみ）を見切れと区別する', () => {
  /** 縦だけ見切れる、行の高さ 20 px の箱（表示の高さ = 見える行の数 × 20 px）。 */
  const clampedBox = (selector: string, clampCount: number, visibleLineCount: number): ClippedTextEvidence => clipped(selector, {
    clientHeight: visibleLineCount * 20,
    scrollHeight: 120,
    rect: rect(0, 100, 300, visibleLineCount * 20),
    clippingStyle: {
      textOverflow: 'ellipsis',
      whiteSpace: 'normal',
      webkitLineClamp: String(clampCount),
      lineClamp: '',
      display: '-webkit-box',
      webkitBoxOrient: 'vertical',
      maxHeight: 'none',
    },
    lineHeightPx: 20,
    visibleLineCount,
    lineClampCount: clampCount,
    collapsedByControl: false,
    intendedClipping: 'LINE_CLAMP',
  });
  /** 横だけ見切れる 1 行の箱。 */
  const singleLine = (selector: string, textOverflow: string, intended: boolean): ClippedTextEvidence => clipped(selector, {
    overflowX: 'hidden',
    overflowY: 'visible',
    clientWidth: 200,
    scrollWidth: 420,
    clientHeight: 20,
    scrollHeight: 20,
    rect: rect(0, 100, 200, 20),
    widthClipped: true,
    heightClipped: false,
    clippingStyle: {
      textOverflow,
      whiteSpace: 'nowrap',
      webkitLineClamp: 'none',
      lineClamp: '',
      display: 'block',
      webkitBoxOrient: 'horizontal',
      maxHeight: 'none',
    },
    lineHeightPx: 20,
    visibleLineCount: 1,
    lineClampCount: null,
    collapsedByControl: false,
    intendedClipping: intended ? 'INTENDED_ELLIPSIS' : null,
  });
  const selectorsOf = (clippedText: readonly ClippedTextEvidence[]): readonly (string | undefined)[] =>
    evaluate('TEXT_CLIPPING', [layoutRecord(complete(baseLayout({ clippedText })))]).map((draft) => identity(draft, 'selector'));

  it('line-clamp 2 で見える行が 2 なら Finding にしない', () => {
    expect(selectorsOf([clampedBox('#clamp-2', 2, 2)])).toEqual([]);
  });

  it('line-clamp 2 で箱の高さが 1.5 行（行の途中で切れる）なら Finding にする', () => {
    expect(selectorsOf([clampedBox('#clamp-half', 2, 1.5)])).toEqual(['#clamp-half']);
  });

  it('ellipsis と nowrap で横だけ見切れるものは Finding にしない', () => {
    expect(selectorsOf([singleLine('#ellipsis', 'ellipsis', true)])).toEqual([]);
  });

  it('ellipsis のない nowrap で横に見切れるものは Finding にする', () => {
    expect(selectorsOf([singleLine('#nowrap-cut', 'clip', false)])).toEqual(['#nowrap-cut']);
  });

  it('ellipsis と nowrap でも、縦にも見切れるものは Finding にする', () => {
    expect(selectorsOf([clipped('#both', {
      ...singleLine('#both', 'ellipsis', true),
      overflowY: 'hidden',
      clientHeight: 10,
      scrollHeight: 20,
      heightClipped: true,
    })])).toEqual(['#both']);
  });

  it('閉じた折りたたみ（aria-expanded="false" の操作要素が指す）の中のものは Finding にしない', () => {
    expect(selectorsOf([clipped('#collapsed-panel', { collapsedByControl: true, intendedClipping: 'COLLAPSED' })])).toEqual([]);
  });

  it('新しい事実のない古い Evidence は、今の判定のまま Finding にする', () => {
    expect(selectorsOf([clipped('#older-record')])).toEqual(['#older-record']);
  });

  it('区分の値は閉じた一覧で、行の数の許しの幅は名前つきの定数', () => {
    expect(INTENDED_CLIPPING_KINDS).toEqual(['INTENDED_ELLIPSIS', 'LINE_CLAMP', 'COLLAPSED']);
    expect(LINE_CLAMP_VISIBLE_LINE_TOLERANCE).toBeGreaterThan(0);
    expect(LINE_CLAMP_VISIBLE_LINE_TOLERANCE).toBeLessThan(0.5);
    expect(selectorsOf([clampedBox('#within', 2, 2 - LINE_CLAMP_VISIBLE_LINE_TOLERANCE)])).toEqual([]);
    expect(selectorsOf([clampedBox('#beyond', 2, 2 - LINE_CLAMP_VISIBLE_LINE_TOLERANCE - 0.05)])).toEqual(['#beyond']);
  });
});

describe('ELEMENT_OUTSIDE_VIEWPORT と描く面が 0 の要素（DEF-205）', () => {
  it('clip・clip-path で描く面が 0 の要素は Finding にせず、隠していない要素は今のとおり作る', () => {
    const record = layoutRecord(complete(baseLayout({
      boxesOutsideViewport: [
        outside('#hidden-wide', rect(40, 200, 1500, 300), { visibility: visibility({ clippedToZeroArea: true }) }),
        outside('#visible-wide', rect(40, 600, 1500, 300), { visibility: visibility({ clippedToZeroArea: false }) }),
      ],
    })));
    expect(evaluate('ELEMENT_OUTSIDE_VIEWPORT', [record]).map((draft) => identity(draft, 'selector'))).toEqual(['#visible-wide']);
  });
});

describe('FIXED_ELEMENT_OCCLUSION', () => {
  const header = rect(0, 0, VIEWPORT_WIDTH, 100);

  it('先頭の位置で固定要素が主要要素を覆うと、固定要素ごとに1件の WARN にまとめる', () => {
    const coveredParagraph = element('#intro', 'paragraph', rect(0, 60, 800, 60));
    const record = layoutRecord(complete(baseLayout({
      fixedHeadingOverlaps: [fixedHeading('#site-header', header, '#page-title', rect(0, 20, 600, 60))],
      elementOverlaps: [
        overlap(element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' }), coveredParagraph),
        overlap(
          element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' }),
          element('#page-title', 'heading', rect(0, 20, 600, 60)),
        ),
      ],
    })));
    const drafts = evaluate('FIXED_ELEMENT_OCCLUSION', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'overlaySelector')).toBe('#site-header');
    expect(drafts[0]?.severity).toBe('WARN');
    expect(drafts[0]?.message).toContain('2 件');
    expect(drafts[0]?.message).toContain('#page-title');
    expect(drafts[0]?.message).toContain('100%');
  });

  it('先頭の位置でない収集、しきい値以下の覆い方、背面の固定要素、上に描かれる要素、固定要素の中の要素は、Finding にしない', () => {
    const scrolled = layoutRecord(complete(baseLayout({
      scrollPosition: { scrollX: 0, scrollY: 400 },
      fixedHeadingOverlaps: [fixedHeading('#site-header', header, '#page-title', rect(0, 20, 600, 60))],
    })), 1);
    const others = layoutRecord(complete(baseLayout({
      fixedHeadingOverlaps: [
        fixedHeading('#thin-shadow', rect(0, 0, VIEWPORT_WIDTH, 25), '#title-a', rect(0, 20, 600, 60)),
        fixedHeading('#background', header, '#title-b', rect(0, 20, 600, 60), { overlayZIndex: '-1' }),
        fixedHeading('#site-header', header, '#title-c', rect(0, 20, 600, 60), {
          headingPosition: 'relative',
          headingZIndex: '20',
        }),
        fixedHeading('#faded', header, '#title-d', rect(0, 20, 600, 60), {
          overlayVisibility: visibility({ opacity: 0 }),
        }),
      ],
      elementOverlaps: [
        overlap(
          element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' }),
          element('#menu-link', 'link', rect(0, 0, 100, 40), { fixedOrStickyAncestor: true }),
        ),
        overlap(
          element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' }),
          element('#chat', 'button', rect(0, 0, 100, 40), { position: 'fixed' }),
        ),
      ],
    })), 2);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [scrolled, others])).toEqual([]);
  });

  it('覆われた割合は、ビューポートの中に見えている面積に対して計る', () => {
    const tallParagraph = element('#long-text', 'paragraph', rect(0, 700, 800, 2000));
    const banner = rect(0, 700, VIEWPORT_WIDTH, 200);
    // AUD-3a: スクロールできる文書では、下の帯の下の段落はスクロールで外へ出せるので数えない。この試験は割合の分母を確かめるものなので、
    // 文書をスクロールできない高さ（ビューポートと同じ）にして、今までの意図を保つ。
    const record = layoutRecord(complete(baseLayout({
      document: notScrollableDocument(),
      elementOverlaps: [overlap(tallParagraph, element('#cookie-banner', 'other', banner, { position: 'fixed' }))],
    })));
    const drafts = evaluate('FIXED_ELEMENT_OCCLUSION', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'overlaySelector')).toBe('#cookie-banner');
  });
});

describe('AUD-3a: スクロールすれば固定要素の外へ出せる内容', () => {
  const MOBILE_WIDTH = 390;
  const MOBILE_HEIGHT = 844;
  const bottomNavRect = rect(0, MOBILE_HEIGHT - 64, MOBILE_WIDTH, 64);
  const bottomNav = element('#bottom-nav', 'other', bottomNavRect, { position: 'fixed', zIndex: '10' });
  const underNav = element('#card-text', 'paragraph', rect(16, MOBILE_HEIGHT - 60, 358, 40));
  const mobileLayout = (documentHeight: number, overrides: Partial<LayoutEvidence> = {}): LayoutEvidence => baseLayout({
    document: {
      ...baseLayout().document,
      viewportWidth: MOBILE_WIDTH,
      viewportHeight: MOBILE_HEIGHT,
      documentElementClientWidth: MOBILE_WIDTH,
      documentElementClientHeight: MOBILE_HEIGHT,
      documentElementScrollWidth: MOBILE_WIDTH,
      documentElementScrollHeight: documentHeight,
      bodyScrollWidth: MOBILE_WIDTH,
      bodyScrollHeight: documentHeight,
      bodyClientWidth: MOBILE_WIDTH,
      bodyClientHeight: documentHeight,
    },
    ...overrides,
  });

  it('文書がスクロールできるページの、下の固定の帯の下の内容は数えない', () => {
    const record = layoutRecord(complete(mobileLayout(2400, { elementOverlaps: [overlap(underNav, bottomNav)] })));
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record])).toEqual([]);
  });

  it('スクロールできる量が足りず、帯の外へ出しきれない内容は数える', () => {
    // 文書の高さ 864 → スクロールできる量は 20 px。内容は 20 px しか上がらず、帯（780〜844）と 784+40-20=804 まで重なる。
    const record = layoutRecord(complete(mobileLayout(MOBILE_HEIGHT + 20, { elementOverlaps: [overlap(underNav, bottomNav)] })));
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector'))).toEqual(['#bottom-nav']);
  });

  it('EV-1: 文書は動かず内側の領域がスクロールするページの、下の固定の帯の下の内容は、祖先の動かせる量で数えない', () => {
    const container = { selector: 'main', rect: rect(0, 0, MOBILE_WIDTH, MOBILE_HEIGHT), scrollTop: 0, scrollRangeY: 2000 };
    const inner = { ...overlap(underNav, bottomNav), coveredScrollContainer: container };
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [layoutRecord(complete(mobileLayout(MOBILE_HEIGHT, { elementOverlaps: [inner] })))])).toEqual([]);
    // 祖先も動かせる量が足りなければ、今のとおり数える。
    const short = { ...inner, coveredScrollContainer: { ...container, scrollRangeY: 10 } };
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [layoutRecord(complete(mobileLayout(MOBILE_HEIGHT, { elementOverlaps: [short] })))])).toHaveLength(1);
  });

  it('スクロールできないページの、下の固定の帯の下の内容は、今のとおり数える', () => {
    const record = layoutRecord(complete(mobileLayout(MOBILE_HEIGHT, { elementOverlaps: [overlap(underNav, bottomNav)] })));
    const drafts = evaluate('FIXED_ELEMENT_OCCLUSION', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'overlaySelector')).toBe('#bottom-nav');
  });

  it('上の固定のヘッダが、先頭の位置で主要な内容を覆う形は、文書がスクロールできても今の判定のまま数える', () => {
    const headerRect = rect(0, 0, MOBILE_WIDTH, 56);
    const record = layoutRecord(complete(mobileLayout(2400, {
      elementOverlaps: [
        overlap(element('#top-bar', 'other', headerRect, { position: 'fixed', zIndex: '10' }),
          element('#page-title', 'heading', rect(16, 0, 358, 48))),
        overlap(element('#top-bar', 'other', headerRect, { position: 'fixed', zIndex: '10' }),
          element('#lead', 'paragraph', rect(16, 30, 358, 40))),
      ],
    })));
    const drafts = evaluate('FIXED_ELEMENT_OCCLUSION', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'overlaySelector')).toBe('#top-bar');
    expect(drafts[0]?.message).toContain('2 件');
  });

  it('sticky の帯は、スクロールで逃がせるとはみなさず、今のとおり数える', () => {
    const stickyBand = element('#sticky-band', 'other', bottomNavRect, { position: 'sticky', zIndex: '10' });
    const record = layoutRecord(complete(mobileLayout(2400, { elementOverlaps: [overlap(underNav, stickyBand)] })));
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector'))).toEqual(['#sticky-band']);
  });

  it('数えなかった組の数と区分 REACHABLE_BY_SCROLL を、Finding の外の記録として返す', () => {
    const layout = mobileLayout(2400, {
      elementOverlaps: [
        overlap(underNav, bottomNav),
        overlap(element('#card-link', 'link', rect(16, MOBILE_HEIGHT - 30, 120, 24)), bottomNav),
      ],
    });
    expect(fixedOcclusionScrollExclusionsOf(layout)).toEqual({ reason: 'REACHABLE_BY_SCROLL', pairCount: 2 });
    expect(fixedOcclusionScrollExclusionsOf(mobileLayout(MOBILE_HEIGHT, { elementOverlaps: [overlap(underNav, bottomNav)] })))
      .toEqual({ reason: 'REACHABLE_BY_SCROLL', pairCount: 0 });
  });
});

describe('ZERO_SIZE_INTERACTIVE_ELEMENT', () => {
  it('通常の流れにある可視の操作要素の大きさが 0 なら、WARN を作る', () => {
    const record = layoutRecord(complete(baseLayout({
      zeroSizeInteractive: [zeroSize('#empty-link'), zeroSize('#collapsed-button', { tagName: 'button', rect: rect(0, 0, 120, 0) })],
    })));
    const drafts = evaluate('ZERO_SIZE_INTERACTIVE_ELEMENT', [record]);
    expect(drafts.map((draft) => identity(draft, 'selector'))).toEqual(['#empty-link', '#collapsed-button']);
    expect(drafts[1]?.message).toContain('120 × 0 px');
    expect(drafts[1]?.message).toContain('button');
  });

  it('通常の流れの外の要素、透明な要素、aria-hidden の要素は、Finding にしない', () => {
    const record = layoutRecord(complete(baseLayout({
      zeroSizeInteractive: [
        zeroSize('#native-checkbox', { tagName: 'input', position: 'absolute' }),
        zeroSize('#fixed-link', { position: 'fixed' }),
        zeroSize('#transparent', { visibility: visibility({ opacity: 0 }) }),
        zeroSize('#aria-hidden', { visibility: visibility({ ariaHidden: true }) }),
      ],
    })));
    expect(evaluate('ZERO_SIZE_INTERACTIVE_ELEMENT', [record])).toEqual([]);
  });

  it('大きさのある描画された子孫を持つ要素（float の画像や absolute の子を包むリンク）は、Finding にしない（RT12 の I3）', () => {
    const record = layoutRecord(complete(baseLayout({
      zeroSizeInteractive: [
        zeroSize('#float-image-link', { hasRenderedDescendant: true }),
        zeroSize('#absolute-child-link', { rect: rect(10, 10, 0, 18), hasRenderedDescendant: true }),
        zeroSize('#empty-button', { tagName: 'button', hasRenderedDescendant: false }),
      ],
    })));
    expect(evaluate('ZERO_SIZE_INTERACTIVE_ELEMENT', [record]).map((draft) => identity(draft, 'selector'))).toEqual([
      '#empty-button',
    ]);
  });
});

describe('OVERSIZED_FIXED_ELEMENT', () => {
  it('固定要素がビューポートの面積のしきい値を超えて占めると、割合を含む WARN を作る', () => {
    const record = layoutRecord(complete(baseLayout({
      fixedElements: [fixedElement('#consent', rect(0, 450, VIEWPORT_WIDTH, 450))],
    })));
    const drafts = evaluate('OVERSIZED_FIXED_ELEMENT', [record]);
    expect(drafts).toHaveLength(1);
    expect(identity(drafts[0], 'selector')).toBe('#consent');
    expect(drafts[0]?.message).toContain('50%');
    expect(drafts[0]?.message).toContain('30%');
  });

  it('しきい値以下の固定要素、背面の固定要素、透明な固定要素は、Finding にしない', () => {
    const record = layoutRecord(complete(baseLayout({
      fixedElements: [
        fixedElement('#header', rect(0, 0, VIEWPORT_WIDTH, 120)),
        fixedElement('#background', rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT), { zIndex: '-1' }),
        fixedElement('#faded', rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT), { visibility: visibility({ opacity: 0 }) }),
      ],
    })));
    expect(evaluate('OVERSIZED_FIXED_ELEMENT', [record])).toEqual([]);
  });
});

describe('DYNAMIC_LAYOUT_SHIFT', () => {
  it('ユーザー入力のない最大の layout shift が、要素とともにしきい値を超えて観測されると、WARN を作る', () => {
    const record = performanceRecord(observedVital(0.3, { largestShiftTarget: '#late-banner', largestShiftValue: 0.18 }));
    const drafts = evaluate('DYNAMIC_LAYOUT_SHIFT', [record]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ category: 'LAYOUT', severity: 'WARN', evidenceRefs: [record.evidenceId] });
    expect(identity(drafts[0], 'shiftTarget')).toBe('#late-banner');
    expect(drafts[0]?.message).toContain('0.18');
    expect(drafts[0]?.message).toContain('0.1');
  });

  it('しきい値以下の shift、要素のない shift、観測できなかった CLS からは、Finding を作らない', () => {
    const records = [
      performanceRecord(observedVital(0.05, { largestShiftTarget: '#small', largestShiftValue: 0.05 }), 1),
      performanceRecord(observedVital(0.3, { largestShiftValue: 0.3 }), 2),
      performanceRecord(observedVital(0), 3),
      performanceRecord(notObservedVital(), 4),
    ];
    expect(evaluate('DYNAMIC_LAYOUT_SHIFT', records)).toEqual([]);
  });
});

describe('しきい値ちょうどの値と、わずかに超える値（RT12 の M6）', () => {
  const overlapPair = (kinds: readonly [LayoutElementKind, LayoutElementKind], overlapWidth: number): LayoutEvidence =>
    baseLayout({
      elementOverlaps: [overlap(
        element('#first', kinds[0], rect(0, 0, 100, 100)),
        element('#second', kinds[1], rect(100 - overlapWidth, 0, 100, 100)),
      )],
    });

  it.each([
    ['ELEMENT_OVERLAP', ['image', 'button']],
    ['CONTENT_COLLISION', ['heading', 'paragraph']],
  ] as const)('%s: 重なりの割合がしきい値ちょうどなら作らず、わずかに超えると作る', (ruleId, kinds) => {
    const atThreshold = overlapPair(kinds, 25);
    const overlapAtThreshold = atThreshold.elementOverlaps[0];
    expect((overlapAtThreshold?.intersection.area ?? 0) / (overlapAtThreshold?.first.area ?? 1)).toBe(OVERLAP_MIN_AREA_RATIO);
    expect(evaluate(ruleId, [layoutRecord(complete(atThreshold))])).toEqual([]);
    expect(evaluate(ruleId, [layoutRecord(complete(overlapPair(kinds, 26)))])).toHaveLength(1);
  });

  it('FIXED_ELEMENT_OCCLUSION: 覆われた割合がしきい値ちょうどなら作らず、わずかに超えると作る', () => {
    const covered = rect(0, 0, 100, 100);
    const occlusion = (overlayHeight: number): EvidenceRecord => layoutRecord(complete(baseLayout({
      fixedHeadingOverlaps: [fixedHeading('#bar', rect(0, 0, VIEWPORT_WIDTH, overlayHeight), '#title', covered)],
    })));
    expect((100 * 25) / areaOfRect(covered)).toBe(FIXED_OCCLUSION_MIN_COVERED_RATIO);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [occlusion(25)])).toEqual([]);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [occlusion(26)])).toHaveLength(1);
  });

  it('OVERSIZED_FIXED_ELEMENT: ビューポートの面積の割合がしきい値ちょうどなら作らず、わずかに超えると作る', () => {
    const atThreshold = fixedElement('#panel', rect(0, 0, VIEWPORT_WIDTH, 270));
    expect(atThreshold.viewportAreaRatio).toBe(OVERSIZED_FIXED_ELEMENT_MIN_VIEWPORT_RATIO);
    expect(evaluate('OVERSIZED_FIXED_ELEMENT', [layoutRecord(complete(baseLayout({ fixedElements: [atThreshold] })))]))
      .toEqual([]);
    const above = fixedElement('#panel', rect(0, 0, VIEWPORT_WIDTH, 271));
    expect(evaluate('OVERSIZED_FIXED_ELEMENT', [layoutRecord(complete(baseLayout({ fixedElements: [above] })))]))
      .toHaveLength(1);
  });

  it('DYNAMIC_LAYOUT_SHIFT: shift の値がしきい値ちょうどなら作らず、わずかに超えると作る', () => {
    const shift = (value: number): EvidenceRecord =>
      performanceRecord(observedVital(value, { largestShiftTarget: '#banner', largestShiftValue: value }));
    expect(evaluate('DYNAMIC_LAYOUT_SHIFT', [shift(MIN_DYNAMIC_LAYOUT_SHIFT_SCORE)])).toEqual([]);
    expect(evaluate('DYNAMIC_LAYOUT_SHIFT', [shift(MIN_DYNAMIC_LAYOUT_SHIFT_SCORE + 0.0001)])).toHaveLength(1);
  });

  it('DOCUMENT_HORIZONTAL_OVERFLOW: はみ出しの量がしきい値ちょうどなら作らず、わずかに超えると作る', () => {
    const overflowBy = (overflow: number): EvidenceRecord => layoutRecord(complete(baseLayout({
      document: { ...baseLayout().document, horizontalOverflowPx: overflow },
    })));
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [overflowBy(MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX)])).toEqual([]);
    expect(evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [overflowBy(MAX_ALLOWED_HORIZONTAL_OVERFLOW_PX + 0.5)])).toHaveLength(1);
  });

  it('TEXT_CLIPPING: 内容の差と箱の大きさがしきい値ちょうどなら作らず、わずかに超えると作る', () => {
    const clippedBy = (difference: number): EvidenceRecord => layoutRecord(complete(baseLayout({
      clippedText: [clipped('#text', { clientHeight: 80, scrollHeight: 80 + difference })],
    })));
    expect(evaluate('TEXT_CLIPPING', [clippedBy(MAX_IGNORED_CLIPPED_OVERFLOW_PX)])).toEqual([]);
    expect(evaluate('TEXT_CLIPPING', [clippedBy(MAX_IGNORED_CLIPPED_OVERFLOW_PX + 1)])).toHaveLength(1);
    const boxOfWidth = (width: number): EvidenceRecord => layoutRecord(complete(baseLayout({
      clippedText: [clipped('#narrow', { rect: rect(0, 100, width, 80), clientWidth: width })],
    })));
    expect(evaluate('TEXT_CLIPPING', [boxOfWidth(VISUALLY_HIDDEN_MAX_DIMENSION_PX)])).toEqual([]);
    expect(evaluate('TEXT_CLIPPING', [boxOfWidth(VISUALLY_HIDDEN_MAX_DIMENSION_PX + 1)])).toHaveLength(1);
  });
});

describe('レスポンシブの幅ごとの結果（stressSweep。設計書 5.1.1）', () => {
  const STRESS_HEIGHT = 800;

  /** 幅 `width` のビューポートで集めた、問題のない layout。 */
  const narrowLayout = (width: number, overrides: Partial<LayoutEvidence> = {}): LayoutEvidence => baseLayout({
    document: {
      ...baseLayout().document,
      viewportWidth: width,
      viewportHeight: STRESS_HEIGHT,
      documentElementClientWidth: width,
      documentElementClientHeight: STRESS_HEIGHT,
      documentElementScrollWidth: width,
      bodyScrollWidth: width,
      bodyClientWidth: width,
    },
    ...overrides,
  });

  const withOverflow = (width: number, overflow: number): LayoutEvidence => narrowLayout(width, {
    document: {
      ...narrowLayout(width).document,
      documentElementScrollWidth: width + overflow,
      horizontalOverflowPx: overflow,
    },
  });

  const stressComplete = (width: number, layout: LayoutEvidence): StressLayoutEvidence => ({
    width,
    height: STRESS_HEIGHT,
    status: 'COMPLETE',
    layout,
  });

  it('320 px の幅だけで横にはみ出すと、stressWidth: "320" の DOCUMENT_HORIZONTAL_OVERFLOW を1件作る', () => {
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [
      stressComplete(320, withOverflow(320, 40)),
      stressComplete(768, narrowLayout(768)),
    ]);
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      ruleId: 'DOCUMENT_HORIZONTAL_OVERFLOW',
      severity: 'ERROR',
      evidenceRefs: [record.evidenceId],
      identityFields: [{ name: 'stressWidth', value: '320' }],
    });
    expect(drafts[0]?.message).toContain('320 px');
    expect(drafts[0]?.message).toContain('40 px');
  });

  it('ビューポートの横方向の overflow が切り取り（CLIPPED）の幅の結果からは、DOCUMENT_HORIZONTAL_OVERFLOW を作らない', () => {
    const clipped = withOverflow(320, 40);
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [
      stressComplete(320, { ...clipped, document: { ...clipped.document, viewportHorizontalClip: 'CLIPPED' } }),
      stressComplete(768, withOverflow(768, 12)),
    ]);
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts.map((draft) => identity(draft, 'stressWidth'))).toEqual(['768']);
  });

  it('主要なビューポートと同じ幅の結果からは、Finding を作らない', () => {
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [
      stressComplete(VIEWPORT_WIDTH, withOverflow(VIEWPORT_WIDTH, 30)),
      stressComplete(320, withOverflow(320, 40)),
    ]);
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts.map((draft) => identity(draft, 'stressWidth'))).toEqual(['320']);
  });

  it('FAILED の幅と layout が null の PARTIAL の幅は判定せず、layout のある PARTIAL の幅は集めた部分で判定する', () => {
    const failed: StressLayoutEvidence = {
      width: 390,
      height: STRESS_HEIGHT,
      status: 'FAILED',
      stage: 'NAVIGATION',
      reason: 'NAVIGATION_FAILED',
      message: 'navigation failed',
      layout: null,
    };
    const partialWithoutLayout: StressLayoutEvidence = {
      width: 768,
      height: STRESS_HEIGHT,
      status: 'PARTIAL',
      reason: 'DEADLINE_EXCEEDED',
      layout: null,
    };
    const partialWithLayout: StressLayoutEvidence = {
      width: 1024,
      height: STRESS_HEIGHT,
      status: 'PARTIAL',
      reason: 'DEADLINE_EXCEEDED',
      layout: withOverflow(1024, 16),
    };
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [failed, partialWithoutLayout, partialWithLayout]);
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts.map((draft) => identity(draft, 'stressWidth'))).toEqual(['1024']);
    const withoutJudgeable = layoutRecord(complete(baseLayout()), 1, 'desktop', [failed, partialWithoutLayout]);
    for (const rule of LAYOUT_RULES) {
      expect(rule.evaluate(input([withoutJudgeable]))).toEqual([]);
    }
  });

  const STRESS_WIDTH = 375;
  const STRESS_CASES: readonly (readonly [string, LayoutEvidence])[] = [
    ['DOCUMENT_HORIZONTAL_OVERFLOW', withOverflow(STRESS_WIDTH, 25)],
    ['ELEMENT_OUTSIDE_VIEWPORT', narrowLayout(STRESS_WIDTH, {
      boxesOutsideViewport: [outside('#wide-card', rect(10, 200, 400, 100), {
        outside: { left: false, right: true, top: false, bottom: false },
      })],
    })],
    ['ELEMENT_OVERLAP', narrowLayout(STRESS_WIDTH, {
      elementOverlaps: [overlap(element('#logo', 'image', rect(0, 0, 200, 100)), element('#badge', 'image', rect(100, 0, 200, 100)))],
    })],
    ['CONTENT_COLLISION', narrowLayout(STRESS_WIDTH, {
      elementOverlaps: [overlap(
        element('#title', 'heading', rect(0, 0, 300, 60)),
        element('#lead', 'paragraph', rect(0, 20, 300, 80)),
      )],
    })],
    ['FIXED_ELEMENT_OCCLUSION', narrowLayout(STRESS_WIDTH, {
      fixedHeadingOverlaps: [fixedHeading('#bar', rect(0, 0, STRESS_WIDTH, 100), '#title', rect(0, 20, 300, 60))],
    })],
  ];

  it.each(STRESS_CASES)('%s は、幅ごとの結果から、幅を同一性と文言に持つ Finding を作る', (ruleId, layout) => {
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [stressComplete(STRESS_WIDTH, layout)]);
    const drafts = evaluate(ruleId, [record]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.evidenceRefs).toEqual([record.evidenceId]);
    expect(identity(drafts[0], 'stressWidth')).toBe(String(STRESS_WIDTH));
    expect(drafts[0]?.message).toContain(`${String(STRESS_WIDTH)} px`);
  });

  it('設計書 5.1.1 の5つ以外の layout の Rule は、幅ごとの結果を判定しない', () => {
    const record = layoutRecord(complete(baseLayout()), 1, 'desktop', [stressComplete(STRESS_WIDTH, narrowLayout(STRESS_WIDTH, {
      clippedText: [clipped('#clip')],
      zeroSizeInteractive: [zeroSize('#zero')],
      fixedElements: [fixedElement('#overlay', rect(0, 0, STRESS_WIDTH, STRESS_HEIGHT), { viewportAreaRatio: 1 })],
    }))]);
    for (const ruleId of ['TEXT_CLIPPING', 'ZERO_SIZE_INTERACTIVE_ELEMENT', 'OVERSIZED_FIXED_ELEMENT', 'DYNAMIC_LAYOUT_SHIFT']) {
      expect(evaluate(ruleId, [record])).toEqual([]);
    }
  });

  it('primary の layout がない場合は、重複しないので、どの幅の結果も判定する', () => {
    const record = layoutRecord({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null }, 1, 'desktop', [
      stressComplete(VIEWPORT_WIDTH, withOverflow(VIEWPORT_WIDTH, 30)),
    ]);
    const drafts = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [record]);
    expect(drafts.map((draft) => identity(draft, 'stressWidth'))).toEqual([String(VIEWPORT_WIDTH)]);
  });

  it('primary の Finding は stressWidth を持たず、fingerprint は幅ごとの結果の有無で変わらない', () => {
    const primary = complete(withOverflow(VIEWPORT_WIDTH, 24));
    const engine = (): RuleEngine =>
      new RuleEngine({ targetId: 'layout-rules-test', firstFindingSequence: 1, catalog: LAYOUT_RULES });
    const withoutSweep = engine().evaluate(input([layoutRecord(primary)]));
    const withSweep = engine().evaluate(input([layoutRecord(primary, 1, 'desktop', [
      stressComplete(320, withOverflow(320, 40)),
    ])]));
    expect(withoutSweep.failures).toEqual([]);
    expect(withSweep.failures).toEqual([]);
    expect(withoutSweep.findings).toHaveLength(1);
    expect(withSweep.findings).toHaveLength(2);
    const primaryFingerprint = withoutSweep.findings[0]?.fingerprint;
    expect(withSweep.findings.map((finding) => finding.fingerprint)).toContain(primaryFingerprint);
    expect(new Set(withSweep.findings.map((finding) => finding.fingerprint)).size).toBe(2);
    const primaryDraft = evaluate('DOCUMENT_HORIZONTAL_OVERFLOW', [layoutRecord(primary, 1, 'desktop', [
      stressComplete(320, withOverflow(320, 40)),
    ])]).find((draft) => identity(draft, 'stressWidth') === undefined);
    expect(primaryDraft?.identityFields).toEqual([]);
  });
});

describe('LAYOUT_RULES と Rule Engine', () => {
  it('すべての下書きが Engine の検査に通る', () => {
    const layout = layoutRecord(complete(baseLayout({
      document: { ...baseLayout().document, horizontalOverflowPx: 12 },
      boxesOutsideViewport: [outside('#wide', rect(0, 0, 1500, 100))],
      clippedText: [clipped('#clip')],
      zeroSizeInteractive: [zeroSize('#zero')],
      elementOverlaps: [
        overlap(element('#a', 'image', rect(0, 0, 100, 100)), element('#b', 'image', rect(50, 0, 100, 100))),
        overlap(element('#h', 'heading', rect(0, 200, 100, 40)), element('#p', 'paragraph', rect(0, 210, 100, 40))),
      ],
      fixedHeadingOverlaps: [fixedHeading('#bar', rect(0, 0, VIEWPORT_WIDTH, 100), '#title', rect(0, 0, 100, 40))],
      fixedElements: [fixedElement('#overlay', rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT))],
    })));
    const performance = performanceRecord(observedVital(0.3, { largestShiftTarget: '#x', largestShiftValue: 0.3 }));
    const engine = new RuleEngine({ targetId: 'layout-rules-test', firstFindingSequence: 1, catalog: LAYOUT_RULES });
    const result = engine.evaluate(input([withNotificationOverlay(layout, [notificationFrame('a', { hidden: true, hiddenReason: 'NO_CLOSE_BUTTON' })]),
      performance]));
    expect(result.failures).toEqual([]);
    expect(new Set(result.findings.map((finding) => finding.ruleId))).toEqual(
      new Set(EXPECTED_RULES.map(([ruleId]) => ruleId)),
    );
  });
});

describe('DEF-210: 通知の枠の規則', () => {
  const corner = rect(VIEWPORT_WIDTH - 380, VIEWPORT_HEIGHT - 306, 380, 306);
  const covered = element('#corner-text', 'paragraph', rect(VIEWPORT_WIDTH - 380, VIEWPORT_HEIGHT - 300, 380, 200));
  const header = rect(0, 0, VIEWPORT_WIDTH, 100);
  const headerCovered = element('#intro', 'paragraph', rect(0, 60, 800, 60));

  it('NOTIFICATION_NOT_DISMISSIBLE は、閉じられない枠ごとに 1 件で、主の読み込みと幅の走査の同じ枠は 1 件にまとめる', () => {
    const record = withNotificationOverlay(layoutRecord(complete(baseLayout())), [
      notificationFrame('a', { pressed: true, dismissed: true }),
      notificationFrame('b', { pressed: true, hidden: true, hiddenReason: 'NOT_DISMISSED' }),
      notificationFrame('c', { status: 'CLOSE_BUTTON_DISABLED', hidden: true, hiddenReason: 'CLOSE_BUTTON_DISABLED' }),
      notificationFrame('d', { status: 'NO_CLOSE_BUTTON', hidden: false, hiddenReason: 'NO_CLOSE_BUTTON' }),
      notificationFrame('e', { status: 'TOO_LARGE' }),
    ], {
      stressNotificationOverlays: [{
        width: 320,
        overlay: { readStatus: 'READ', frames: [notificationFrame('b', { hidden: true, hiddenReason: 'NOT_DISMISSED' })], pressCount: 1, navigated: false, truncated: false },
      }],
    });
    const drafts = evaluate('NOTIFICATION_NOT_DISMISSIBLE', [record]);
    expect(drafts.map((draft) => identity(draft, 'notificationFrame'))).toEqual([
      notificationFrame('b').digest, notificationFrame('c').digest, notificationFrame('d').digest,
    ]);
    expect(drafts.every((draft) => draft.severity === 'WARN' && draft.category === 'LAYOUT')).toBe(true);
    expect(drafts[0]?.message).toContain('押しましたが、枠が残りました');
    expect(drafts.map((draft) => draft.message).join('')).not.toMatch(/sha256|http/u);
  });

  it('NOTIFICATION_HANDLED_BEFORE_AUDIT は、閉じたか隠した枠があるビューポートに 1 件の INFO で、文は messages.ts の文', () => {
    const closedOnly = withNotificationOverlay(layoutRecord(complete(baseLayout()), 1), [notificationFrame('a', { pressed: true, dismissed: true })]);
    const both = withNotificationOverlay(layoutRecord(complete(baseLayout()), 2), [
      notificationFrame('a', { pressed: true, dismissed: true }),
      notificationFrame('b', { hidden: true, hiddenReason: 'NO_CLOSE_BUTTON', status: 'NO_CLOSE_BUTTON' }),
    ]);
    const none = withNotificationOverlay(layoutRecord(complete(baseLayout()), 3), [notificationFrame('e', { status: 'TOO_LARGE' })]);
    expect(evaluate('NOTIFICATION_HANDLED_BEFORE_AUDIT', [closedOnly]).map((draft) => [draft.severity, draft.message]))
      .toEqual([['INFO', NOTIFICATION_OVERLAY_TEXT.dismissed]]);
    expect(evaluate('NOTIFICATION_HANDLED_BEFORE_AUDIT', [both]).map((draft) => draft.message)).toEqual([NOTIFICATION_OVERLAY_TEXT.dismissedAndHidden]);
    expect(evaluate('NOTIFICATION_HANDLED_BEFORE_AUDIT', [none])).toEqual([]);
    expect(evaluate('NOTIFICATION_HANDLED_BEFORE_AUDIT', [layoutRecord(complete(baseLayout()), 4)])).toEqual([]);
  });

  it('FIXED_ELEMENT_OCCLUSION は、閉じる前の layout の覆いを 1 回だけ足し、閉じた後も残る固定要素の覆いは重ねない', () => {
    const fixedHeader = element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' });
    const notice = element('#notice', 'other', corner, { position: 'fixed', zIndex: '41' });
    const before = complete(baseLayout({ elementOverlaps: [overlap(fixedHeader, headerCovered), overlap(notice, covered)] }));
    const after = complete(baseLayout({ elementOverlaps: [overlap(fixedHeader, headerCovered)] }));
    const record = withNotificationOverlay(layoutRecord(after), [notificationFrame('a', { pressed: true, dismissed: true })], {
      beforeNotificationDismissal: before,
    });
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector')).sort())
      .toEqual(['#notice', '#site-header']);
    // 閉じる前の layout がない（2 ページ目からの同じ枠）ときは、閉じた後の状態だけ。
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [layoutRecord(after)]).map((draft) => identity(draft, 'overlaySelector'))).toEqual(['#site-header']);
  });

  it('AUD-3a: 閉じる前の layout の隅の通知の覆いは、スクロールできる文書でも 1 件になる（スクロールの除外を当てない）', () => {
    const notice = element('#notice', 'other', corner, { position: 'fixed', zIndex: '41' });
    const before = complete(baseLayout({ elementOverlaps: [overlap(notice, covered)] }));
    expect(before.status === 'COMPLETE' && before.layout.document.bodyScrollHeight > VIEWPORT_HEIGHT).toBe(true);
    const record = withNotificationOverlay(layoutRecord(complete(baseLayout())), [notificationFrame('a', { pressed: true, dismissed: true })], {
      beforeNotificationDismissal: before,
    });
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector'))).toEqual(['#notice']);
  });

  it('AUD-3a: 閉じた後の layout に残る隅の固定要素の覆いは、スクロールできる文書なら除外する', () => {
    const notice = element('#notice', 'other', corner, { position: 'fixed', zIndex: '41' });
    const after = complete(baseLayout({ elementOverlaps: [overlap(notice, covered)] }));
    const record = withNotificationOverlay(layoutRecord(after), [notificationFrame('a', { pressed: true, dismissed: true })], {
      beforeNotificationDismissal: complete(baseLayout()),
    });
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record])).toEqual([]);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [layoutRecord(after)])).toEqual([]);
  });
});

describe('DEF-204: 描く面がなく押下を受けない固定の入れ物', () => {
  const full = rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  const corner = rect(VIEWPORT_WIDTH - 380, VIEWPORT_HEIGHT - 306, 380, 306);
  const covered = element('#corner-text', 'paragraph', rect(VIEWPORT_WIDTH - 380, VIEWPORT_HEIGHT - 300, 380, 200));

  it('OVERSIZED_FIXED_ELEMENT と FIXED_ELEMENT_OCCLUSION は、入れ物を数えず、中の固定の子と、描く面のある全面の固定要素は数える', () => {
    const container = fixedElement('#layer', full, { zIndex: '40', paintsOwnSurface: false, pointerEvents: 'none' });
    const painted = fixedElement('#shade', full, { zIndex: '40', paintsOwnSurface: true, pointerEvents: 'none' });
    const box = fixedElement('#notice', corner, { zIndex: '41', paintsOwnSurface: true, pointerEvents: 'auto' });
    // AUD-3a: 隅の通知の下の段落は、スクロールできる文書では外へ出せるので、文書をスクロールできない高さにする。
    const record = layoutRecord(complete(baseLayout({
      document: notScrollableDocument(),
      fixedElements: [container, painted, box],
      elementOverlaps: [
        overlap(element('#layer', 'other', full, { position: 'fixed', zIndex: '40' }), covered),
        overlap(element('#shade', 'other', full, { position: 'fixed', zIndex: '40' }), covered),
        overlap(element('#notice', 'other', corner, { position: 'fixed', zIndex: '41' }), covered),
      ],
    })));
    expect(evaluate('OVERSIZED_FIXED_ELEMENT', [record]).map((draft) => identity(draft, 'selector'))).toEqual(['#shade']);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector')).sort())
      .toEqual(['#notice', '#shade']);
  });

  it('描く面がなくても押下を受ける入れ物と、事実の記録のない前の Evidence の固定要素は、今までどおり数える', () => {
    const clickable = fixedElement('#clickable-layer', full, { paintsOwnSurface: false, pointerEvents: 'auto' });
    const legacy = fixedElement('#legacy-layer', full);
    const record = layoutRecord(complete(baseLayout({
      fixedElements: [clickable, legacy],
      elementOverlaps: [
        overlap(element('#clickable-layer', 'other', full, { position: 'fixed' }), covered),
        overlap(element('#legacy-layer', 'other', full, { position: 'fixed' }), covered),
      ],
    })));
    expect(evaluate('OVERSIZED_FIXED_ELEMENT', [record]).map((draft) => identity(draft, 'selector')))
      .toEqual(['#clickable-layer', '#legacy-layer']);
    expect(evaluate('FIXED_ELEMENT_OCCLUSION', [record]).map((draft) => identity(draft, 'overlaySelector')).sort())
      .toEqual(['#clickable-layer', '#legacy-layer']);
  });
});

describe('AUD-9a: layout の Finding の groupingKeys', () => {
  it('FIXED_ELEMENT_OCCLUSION の Finding に、覆う固定要素の selector を残す', () => {
    const header = rect(0, 0, VIEWPORT_WIDTH, 100);
    const record = layoutRecord(complete(baseLayout({
      elementOverlaps: [overlap(element('#site-header', 'other', header, { position: 'fixed', zIndex: '10' }),
        element('#intro', 'paragraph', rect(0, 60, 800, 60)))],
    })));
    const result = new RuleEngine({ targetId: 'layout-grouping', firstFindingSequence: 1, catalog: [ruleById('FIXED_ELEMENT_OCCLUSION')] })
      .evaluate(input([record]));
    expect(result.findings.map((finding) => [finding.schemaVersion, finding.groupingKeys]))
      .toEqual([['finding-schema/1.1', [{ name: 'overlaySelector', value: '#site-header' }]]]);
  });
});
