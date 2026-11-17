// AUD-3b・3c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3b・3c）: 固定の要素の重なりの区分の判定の表。
// 区分は `src/audit/fixed-overlap-classes.ts` の 1 か所で決める（描画と押下・押下だけ・描画だけ・幾何だけ・モーダル・スクロールで見える）。
import { describe, expect, it } from 'vitest';
import {
  FIXED_OVERLAP_CLASSES,
  FIXED_OVERLAP_FINDING_CLASSES,
  fixedOverlapClassOf,
  hitTestJudgementOf,
  layerPaintLevelOf,
  strongestFixedOverlapClass,
} from '../../src/audit/fixed-overlap-classes.js';
import type { OverlapHitLayerEvidence, OverlapHitPointEvidence, OverlapHitTestEvidence } from '../../src/core/evidence-types.js';
import { colorAlphaOf } from '../../src/core/own-surface.js';

const layer = (overrides: Partial<OverlapHitLayerEvidence> = {}): OverlapHitLayerEvidence => ({
  selector: '#cover',
  relation: 'OVERLAY',
  position: 'fixed',
  zIndex: '10',
  pointerEvents: 'auto',
  effectiveOpacity: 1,
  visibility: 'visible',
  backgroundColor: 'rgb(255, 255, 255)',
  hasBackgroundImage: false,
  paintsOwnSurface: true,
  ...overrides,
});

const point = (overrides: Partial<OverlapHitPointEvidence> = {}): OverlapHitPointEvidence => ({
  x: 10,
  y: 10,
  topRelation: 'OVERLAY',
  layers: [layer()],
  targetFound: true,
  targetSelector: '#content',
  ...overrides,
});

const hitTest = (points: readonly OverlapHitPointEvidence[], overrides: Partial<OverlapHitTestEvidence> = {}): OverlapHitTestEvidence => ({
  target: 'COVERED',
  points,
  overlay: layer(),
  modal: { dialogModal: false, ariaModal: false },
  ...overrides,
});

describe('the closed list of the classes', () => {
  it('has the six classes, and only the three classes that make a Finding, strongest first', () => {
    expect(FIXED_OVERLAP_CLASSES).toEqual(['RENDER_AND_POINTER', 'POINTER_ONLY', 'RENDER_ONLY', 'GEOMETRY_ONLY', 'MODAL', 'SCROLL_REVEALABLE']);
    expect(FIXED_OVERLAP_FINDING_CLASSES).toEqual(['RENDER_AND_POINTER', 'POINTER_ONLY', 'RENDER_ONLY']);
    expect(strongestFixedOverlapClass(['RENDER_ONLY', 'POINTER_ONLY'])).toBe('POINTER_ONLY');
    expect(strongestFixedOverlapClass(['RENDER_ONLY', 'RENDER_AND_POINTER'])).toBe('RENDER_AND_POINTER');
    expect(strongestFixedOverlapClass([])).toBeNull();
  });
});

describe('the alpha of a computed color', () => {
  it('reads the alpha of the color functions and the keyword', () => {
    expect(colorAlphaOf('rgb(1, 2, 3)')).toBe(1);
    expect(colorAlphaOf('rgba(1, 2, 3, 0.5)')).toBe(0.5);
    expect(colorAlphaOf('rgba(0, 0, 0, 0)')).toBe(0);
    expect(colorAlphaOf('transparent')).toBe(0);
    expect(colorAlphaOf('color(srgb 1 0 0 / 0.25)')).toBe(0.25);
    expect(colorAlphaOf('rgb(1 2 3 / 40%)')).toBe(0.4);
    expect(colorAlphaOf('unknown')).toBeNull();
  });
});

describe('the paint level of one element above the covered element', () => {
  it('is OPAQUE only with an opaque background and full opacity', () => {
    expect(layerPaintLevelOf(layer())).toBe('OPAQUE');
  });

  it('is PARTIAL when the paint cannot decide the occlusion (half transparent, background image, text only, opacity)', () => {
    expect(layerPaintLevelOf(layer({ backgroundColor: 'rgba(0, 0, 0, 0.5)' }))).toBe('PARTIAL');
    expect(layerPaintLevelOf(layer({ backgroundColor: 'rgba(0, 0, 0, 0)', hasBackgroundImage: true }))).toBe('PARTIAL');
    expect(layerPaintLevelOf(layer({ backgroundColor: 'rgba(0, 0, 0, 0)' }))).toBe('PARTIAL');
    expect(layerPaintLevelOf(layer({ effectiveOpacity: 0.6 }))).toBe('PARTIAL');
  });

  it('is NONE without a surface, when hidden, or with no opacity', () => {
    expect(layerPaintLevelOf(layer({ paintsOwnSurface: false, backgroundColor: 'rgba(0, 0, 0, 0)' }))).toBe('NONE');
    expect(layerPaintLevelOf(layer({ visibility: 'hidden' }))).toBe('NONE');
    expect(layerPaintLevelOf(layer({ effectiveOpacity: 0 }))).toBe('NONE');
  });
});

describe('the hit-test judgement of the points', () => {
  it('counts a point as captured when the topmost element is the overlay or inside it', () => {
    const judged = hitTestJudgementOf(hitTest([
      point(),
      point({ topRelation: 'OVERLAY_DESCENDANT', layers: [layer({ relation: 'OVERLAY_DESCENDANT', selector: '#cover > p' })] }),
      point({ topRelation: 'COVERED', layers: [] }),
    ]), { overlayAbove: true });
    expect(judged).toEqual({ render: 'OPAQUE', capturedPointCount: 2, pointCount: 3 });
  });

  it('prefers COVERED: the covered element on top is neither captured nor occluded', () => {
    const judged = hitTestJudgementOf(hitTest([point({ topRelation: 'COVERED_DESCENDANT', layers: [] })]), { overlayAbove: true });
    expect(judged).toEqual({ render: 'NONE', capturedPointCount: 0, pointCount: 1 });
  });

  it('does not use the hit-test alone for the paint: a transparent overlay on top captures but does not occlude', () => {
    const transparent = layer({ backgroundColor: 'rgba(0, 0, 0, 0)', paintsOwnSurface: false });
    const judged = hitTestJudgementOf(hitTest([point({ layers: [transparent] })], { overlay: transparent }), { overlayAbove: true });
    expect(judged).toEqual({ render: 'NONE', capturedPointCount: 1, pointCount: 1 });
  });

  it('uses the paint of an overlay that the hit-test skips (pointer-events: none), only when it is drawn above', () => {
    const band = layer({ pointerEvents: 'none' });
    const points = [point({ topRelation: 'COVERED', layers: [] })];
    expect(hitTestJudgementOf(hitTest(points, { overlay: band }), { overlayAbove: true })).toEqual({ render: 'OPAQUE', capturedPointCount: 0, pointCount: 1 });
    expect(hitTestJudgementOf(hitTest(points, { overlay: band }), { overlayAbove: false })).toEqual({ render: 'NONE', capturedPointCount: 0, pointCount: 1 });
  });

  it('does not count a point of a lone fixed element when nothing but its ancestors is beneath it', () => {
    const alone = hitTest([point({ topRelation: 'OVERLAY_DESCENDANT', targetFound: false, targetSelector: null })], { target: 'BENEATH' });
    expect(hitTestJudgementOf(alone, { overlayAbove: true })).toEqual({ render: 'NONE', capturedPointCount: 0, pointCount: 1 });
    // 下に内容があれば、その点を数える。
    const above = hitTest([point({ topRelation: 'OVERLAY_DESCENDANT' })], { target: 'BENEATH' });
    expect(hitTestJudgementOf(above, { overlayAbove: true })).toEqual({ render: 'OPAQUE', capturedPointCount: 1, pointCount: 1 });
  });
});

describe('the class of a pair (the decision table)', () => {
  const cases = [
    { name: 'opaque cover that catches the pointer', input: { render: 'OPAQUE', pointerCaptured: true }, expected: 'RENDER_AND_POINTER' },
    { name: 'half transparent cover that catches the pointer', input: { render: 'PARTIAL', pointerCaptured: true }, expected: 'RENDER_AND_POINTER' },
    { name: 'transparent cover that catches the pointer', input: { render: 'NONE', pointerCaptured: true }, expected: 'POINTER_ONLY' },
    { name: 'opaque band that lets the pointer through', input: { render: 'OPAQUE', pointerCaptured: false }, expected: 'RENDER_ONLY' },
    { name: 'transparent frame that lets the pointer through', input: { render: 'NONE', pointerCaptured: false }, expected: 'GEOMETRY_ONLY' },
  ] as const;
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(fixedOverlapClassOf({ modal: false, scrollRevealable: false, ...input })).toBe(expected);
    });
  }

  it('puts the modal first, then the content that the scroll reveals', () => {
    expect(fixedOverlapClassOf({ modal: true, scrollRevealable: true, render: 'OPAQUE', pointerCaptured: true })).toBe('MODAL');
    expect(fixedOverlapClassOf({ modal: false, scrollRevealable: true, render: 'OPAQUE', pointerCaptured: true })).toBe('SCROLL_REVEALABLE');
  });
});
