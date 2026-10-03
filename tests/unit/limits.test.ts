import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  COLLECTOR_DEADLINE_MARGIN_MS,
  CONTEXT_CLOSE_TIMEOUT_MS,
  CONTROLLED_SCROLL_PACING,
  GEOMETRY_EPSILON_PX,
  INTERACTION_CLEANUP_ALLOWANCE_MS,
  INTERACTION_PERSISTENCE_WINDOW_MS,
  INTERACTION_STABILITY_WINDOW_MS,
  INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HTTP_METHOD_LENGTH,
  MAX_SELECTOR_DEPTH,
  MAX_SELECTOR_LENGTH,
  MAX_URL_LENGTH,
  MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS,
  PAGE_CLOSE_TIMEOUT_MS,
  PAGE_SETTLING_PACING,
  SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER,
  SESSION_OPEN_TIMEOUT_MS,
} from '../../src/core/limits.js';
import { COLOR_LIMITS } from '../../src/evidence/color-collector.js';
import { LAYOUT_THRESHOLDS } from '../../src/evidence/layout-collector.js';
import { INTERACTION_CANDIDATE_LIMITS } from '../../src/safety/interaction-policy.js';

describe('shared limits', () => {
  it('keeps the values currently used by the existing owners', () => {
    expect(MAX_URL_LENGTH).toBe(2_048);
    expect(MAX_ERROR_MESSAGE_LENGTH).toBe(2_048);
    expect(MAX_HTTP_METHOD_LENGTH).toBe(32);
    expect(MAX_SELECTOR_LENGTH).toBe(512);
    expect(MAX_SELECTOR_DEPTH).toBe(8);
    expect(GEOMETRY_EPSILON_PX).toBe(0.5);
  });

  it('matches the exported limits that the collectors and policies define today', () => {
    expect(MAX_URL_LENGTH).toBe(INTERACTION_CANDIDATE_LIMITS.maxUrlLength);
    expect(MAX_SELECTOR_LENGTH).toBe(COLOR_LIMITS.maxSelectorLength);
    expect(MAX_SELECTOR_DEPTH).toBe(COLOR_LIMITS.maxSelectorDepth);
    expect(MAX_SELECTOR_LENGTH).toBe(LAYOUT_THRESHOLDS.maxSelectorLength);
    expect(MAX_SELECTOR_DEPTH).toBe(LAYOUT_THRESHOLDS.maxSelectorDepth);
    expect(GEOMETRY_EPSILON_PX).toBe(LAYOUT_THRESHOLDS.geometryEpsilonPx);
  });

  // F17b: Interaction の時間は、設定の検証と src/interaction の両方が参照するので、src/core/limits.ts に1か所だけ置く。
  it('owns the interaction time windows and the lower bound of the interaction timeout', () => {
    expect(INTERACTION_STABILITY_WINDOW_MS).toBe(500);
    expect(INTERACTION_PERSISTENCE_WINDOW_MS).toBe(500);
    expect(MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS).toBe(INTERACTION_STABILITY_WINDOW_MS + INTERACTION_PERSISTENCE_WINDOW_MS);
  });
});

// P14a（Task 14〜17 の設計書 4.5.7）: Page Auditor の期限と待ち方の定数。値の根拠は、定義のコメントに書く。
describe('page audit timing limits', () => {
  it('owns the cleanup allowance of one Interaction candidate', () => {
    expect(INTERACTION_CLEANUP_ALLOWANCE_MS).toBe(2_000);
  });

  // P14e（R14 の m2）: Page Auditor の候補ごとの期限と、設定の検証が、同じ倍数を使う。
  it('owns the number of Interaction timeouts in the budget of one Interaction candidate', () => {
    expect(INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE).toBe(2);
  });

  it('owns the DOM readiness pacing (poll interval and stable window)', () => {
    expect(PAGE_SETTLING_PACING).toEqual({ pollIntervalMs: 100, stableWindowMs: 500 });
    expect(Object.isFrozen(PAGE_SETTLING_PACING)).toBe(true);
    expect(PAGE_SETTLING_PACING.pollIntervalMs).toBeLessThan(PAGE_SETTLING_PACING.stableWindowMs);
  });

  it('owns the controlled scroll pacing (step fraction, step wait, and stable window)', () => {
    expect(CONTROLLED_SCROLL_PACING).toEqual({ stepViewportFraction: 0.75, stepWaitMs: 250, stableWindowMs: 500 });
    expect(Object.isFrozen(CONTROLLED_SCROLL_PACING)).toBe(true);
    expect(CONTROLLED_SCROLL_PACING.stepViewportFraction).toBeGreaterThan(0);
    expect(CONTROLLED_SCROLL_PACING.stepViewportFraction).toBeLessThan(1);
  });

  it('gives the scroll stage four times the resource settling timeout', () => {
    expect(SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER).toBe(4);
  });

  // P14f（R14r の Minor-2）: 期限を受け取る collector には、ページの期限からこの余裕を引いた時刻を渡す。
  it('owns the margin between the page deadline and the deadline given to the collectors', () => {
    expect(COLLECTOR_DEADLINE_MARGIN_MS).toBe(500);
    // 既定のページの期限（60,000ms）に比べて十分に小さい。
    expect(COLLECTOR_DEADLINE_MARGIN_MS * 100).toBeLessThanOrEqual(DEFAULT_CONFIG.crawl.overallPageTimeoutMs);
  });
});

// P18a（DEF-008。Task 18 の前の整理の設計書 4.2）: Context の終了と、Context と page の作成を待つ上限。
describe('passive session open and close deadlines', () => {
  it('owns the Context close deadline, equal to the page close deadline', () => {
    expect(CONTEXT_CLOSE_TIMEOUT_MS).toBe(5_000);
    expect(CONTEXT_CLOSE_TIMEOUT_MS).toBe(PAGE_CLOSE_TIMEOUT_MS);
  });

  it('owns the session open deadline', () => {
    expect(SESSION_OPEN_TIMEOUT_MS).toBe(10_000);
    // 既定のページの期限（60,000ms）より短い。
    expect(SESSION_OPEN_TIMEOUT_MS).toBeLessThan(DEFAULT_CONFIG.crawl.overallPageTimeoutMs);
  });
});
