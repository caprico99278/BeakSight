// T32f（Task 32 の設計書 4.1 の `action-report.html` の行）: 書き込みの報告の HTML を、本物の Chromium（headless。テストの既定と CLI の起動の設定の
// 両方）で開き、要素と文があることを確かめる（CSP の下でスタイルが効くかは、画面の配布の T32g の範囲）。ネットワークには出ない（文字列を開くだけ）。
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_RESULT_CATALOG, HUMAN_DECISION_CATALOG } from '../../src/presentation/catalog.js';
import { ACTION_REPORT_TEXT } from '../../src/presentation/messages.js';
import { renderActionReport } from '../../src/report/action-report.js';
import { buildActionViewModel } from '../../src/report/action-view-model.js';
import { verifiedUpdateDocuments } from '../helpers/action-report-samples.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const CASES = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 60_000;

describe.each(CASES)('the write report HTML in a browser (%s)', (_name, launch) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  it('shows the title, the notice of the values entered by people, the result badge and the tables', async () => {
    const page = await browser.newPage();
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setContent(renderActionReport(buildActionViewModel(verifiedUpdateDocuments())), { waitUntil: 'load' });
      expect(await page.locator('h1').textContent()).toBe(ACTION_REPORT_TEXT.title);
      expect(await page.locator('body').innerText()).toContain(ACTION_REPORT_TEXT.humanEnteredValuesHeading);
      expect(await page.locator('[data-value="VERIFIED"]').first().textContent()).toBe(ACTION_RESULT_CATALOG.VERIFIED.label);
      expect(await page.getByText(HUMAN_DECISION_CATALOG.UPDATE_FIELD_ROLES.label).count()).toBeGreaterThan(0);
      expect(await page.locator('table').count()).toBeGreaterThanOrEqual(3);
      expect(await page.locator('script').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});
