// CC-020（R15d）: ビューポート（Desktop・Mobile）と、設定の主要なビューポートの大きさの対応づけを、1つの関数にする。
import { describe, expect, it } from 'vitest';
import { viewportSizeFor } from '../../src/config/viewport-size.js';
import { VIEWPORT_PROFILES, type ViewportProfile } from '../../src/core/contracts.js';
import { createTestConfig } from '../helpers/test-config.js';

describe('viewportSizeFor (CC-020)', () => {
  const config = createTestConfig('http://127.0.0.1:1', '/', {
    viewports: { primaryDesktop: { width: 1280, height: 800 }, primaryMobile: { width: 375, height: 667 } },
  });

  it('maps Desktop to primaryDesktop and Mobile to primaryMobile', () => {
    expect(viewportSizeFor(config, 'desktop')).toBe(config.viewports.primaryDesktop);
    expect(viewportSizeFor(config, 'mobile')).toBe(config.viewports.primaryMobile);
  });

  it('covers every viewport profile', () => {
    for (const profile of VIEWPORT_PROFILES) {
      expect(viewportSizeFor(config, profile)).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    }
  });

  it('rejects a profile outside the closed list instead of guessing', () => {
    expect(() => viewportSizeFor(config, 'tablet' as ViewportProfile)).toThrow(RangeError);
  });
});
