/**
 * `src/core/limits.ts` の定数の間の関係（TEST-SLIM C1: 値そのものを固定する場面は消した。値の根拠は定義のコメントにある）。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_SCROLL_PACING,
  GEOMETRY_EPSILON_PX,
  MAX_SELECTOR_DEPTH,
  PAGE_SETTLING_PACING,
} from '../../src/core/limits.js';
import { LAYOUT_THRESHOLDS } from '../../src/evidence/layout-collector.js';

describe('shared limits', () => {
  it('the collectors use the shared selector depth and geometry limits', () => {
    expect(LAYOUT_THRESHOLDS.maxSelectorDepth).toBe(MAX_SELECTOR_DEPTH);
    expect(LAYOUT_THRESHOLDS.geometryEpsilonPx).toBe(GEOMETRY_EPSILON_PX);
  });

  it('the pacing values are frozen and consistent', () => {
    expect(Object.isFrozen(PAGE_SETTLING_PACING)).toBe(true);
    expect(PAGE_SETTLING_PACING.pollIntervalMs).toBeLessThan(PAGE_SETTLING_PACING.stableWindowMs);
    expect(Object.isFrozen(CONTROLLED_SCROLL_PACING)).toBe(true);
    expect(CONTROLLED_SCROLL_PACING.stepViewportFraction).toBeGreaterThan(0);
    expect(CONTROLLED_SCROLL_PACING.stepViewportFraction).toBeLessThan(1);
  });
});
