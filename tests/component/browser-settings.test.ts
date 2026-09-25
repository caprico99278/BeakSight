import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { validateConfig } from '../../src/config/validate-config.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

let browser: Browser;

useHeadlessChromium((launched) => {
  browser = launched;
});

describe('browser locale and timezone accepted by the configuration validation (R\'\'2 I-1)', () => {
  it('creates a Chromium context and page with every accepted locale and timezone', async () => {
    const accepted = [
      [DEFAULT_CONFIG.browser.locale, DEFAULT_CONFIG.browser.timezone],
      ['en-US', 'Pacific/Auckland'],
      ['de-CH', 'UTC'],
    ] as const;
    for (const [locale, timezone] of accepted) {
      const config = createTestConfig('https://example.test');
      expect(validateConfig({ ...config, browser: { ...config.browser, locale, timezone } })).toMatchObject({ ok: true });

      const context = await browser.newContext({ locale, timezoneId: timezone });
      try {
        const page = await context.newPage();
        await page.setContent('<p>settings</p>');
        const observed = await page.evaluate(() => ({
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }));

        expect(observed).toEqual({ locale, timeZone: timezone });
      } finally {
        await context.close();
      }
    }
  });

  // F13b: ICU が別の表記に解決する IANA の名前（Asia/Kolkata → Asia/Calcutta など）も、Chromium の Context と page で使える。
  it('creates a Chromium context and page with accepted timezones that ICU resolves to another spelling (F13b)', async () => {
    for (const timezone of ['Asia/Kolkata', 'Etc/UTC']) {
      const config = createTestConfig('https://example.test');
      expect(validateConfig({ ...config, browser: { ...config.browser, timezone } })).toMatchObject({ ok: true });

      const context = await browser.newContext({ locale: config.browser.locale, timezoneId: timezone });
      try {
        const page = await context.newPage();
        await page.setContent('<p>settings</p>');
        // page の既定の time zone が、設定した名前を page 自身が解決した time zone と同じであること（表記の違いは問わない）。
        const observed = await page.evaluate((configured) => ({
          pageDefault: Intl.DateTimeFormat().resolvedOptions().timeZone,
          configuredResolved: new Intl.DateTimeFormat('en-US', { timeZone: configured }).resolvedOptions().timeZone,
        }), timezone);

        expect(observed.pageDefault).toBe(observed.configuredResolved);
      } finally {
        await context.close();
      }
    }
  });
});
