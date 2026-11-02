// PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章、13 章の最後の段落）: 点検の結果の報告（HTML）を、本物の Chromium（テストの既定）で
// 開き、アクセシビリティの検査（axe。wcag2a・wcag2aa・wcag22aa）の違反が 0 であることを、明るい配色と暗い配色（OS に従う）の両方で確かめる。
// ネットワークには出ない（文字列を開くだけ）。依存パッケージは製品の収集の部品と同じ `@axe-core/playwright`（足していない）。
// OP-G2（OP-G の指示書の 7。撮り直しで、報告の axe が 90 秒で終わらなかった件）: 報告の大きさ（1 ページあたりのバイト数）と axe の時間を、名前つきの上限で確かめる。
// いくつものページと、押して確かめた操作のある見本（`multiPageAuditRun`）も検査する（記録の段の表の行が並ぶ形）。
// 撮り直しで終わらなかったのは、画面のサーバが報告に付ける CSP（`sandbox`。スクリプトを動かさない）の下で axe を流したため（axe の待ちが進まない）。報告の大きさの
// せいではない（5 ページの報告は数十 KB）。ここでは今どおり、検査の Context だけ CSP を外す。
import { AxeBuilder } from '@axe-core/playwright';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRunResult, PageAuditResult } from '../../src/core/contracts.js';
import { createPageId } from '../../src/core/ids.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { JAPANESE_TEXT, auditRun, dom, edgeCaseAuditRun, finding, idOf, interaction, page as pageResult, screenshot } from '../helpers/audit-run-fixture.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';

/** 画面と同じ検査の基準（設計書 13 章の最後の段落）。 */
const AXE_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag22aa']);
/** OP-G2: 1 つの報告の axe の時間の上限（ms。この端末で、20 ページの見本は数秒）。 */
const REPORT_AXE_TIME_LIMIT_MS = 30_000;
/**
 * OP-G2: 報告の大きさの上限（バイト。UTF-8）は、ページによらない部分（見た目の決まり・まとめ・記録の段の点検の回の記録など。今は 3 万に届かない）と、1 ページ
 * あたり（いくつものページの見本で、今は約 1 万）の和。
 */
const REPORT_BASE_BYTES_LIMIT = 40_000;
const REPORT_BYTES_PER_PAGE_LIMIT = 12_000;
/** OP-G2: いくつものページの見本のページの数。 */
const MULTI_PAGE_SAMPLE_PAGES = 20;
const TEST_TIMEOUT_MS = REPORT_AXE_TIME_LIMIT_MS * 2;

/**
 * OP-G2: いくつものページの見本（ページごとに、2 つの画面の幅の DOM と写真、押して確かめた操作 1 つ、重さの違う問題 3 つ）。値は匿名（ループバックの fixture）。
 */
function multiPageAuditRun(): AuditRunResult {
  const evidencePerPage = 6;
  const findingsPerPage = 3;
  const pages: PageAuditResult[] = Array.from({ length: MULTI_PAGE_SAMPLE_PAGES }, (_, index) => {
    const pageId = createPageId(index + 1);
    const base = index * evidencePerPage;
    const desktopDom = dom(base + 1, pageId, 'desktop', JAPANESE_TEXT);
    const evidence = [
      desktopDom,
      screenshot(base + 2, pageId, 'desktop', 'VIEWPORT'),
      screenshot(base + 3, pageId, 'desktop', 'FULL_PAGE'),
      dom(base + 4, pageId, 'mobile', JAPANESE_TEXT),
      screenshot(base + 5, pageId, 'mobile', 'VIEWPORT'),
      interaction(base + 6, pageId, 'VERIFIED', null),
    ];
    const first = index * findingsPerPage + 1;
    const findings = [
      finding(first, 'ERROR', 'HTTP', pageId, [idOf(desktopDom)]),
      finding(first + 1, 'WARN', 'DOM', pageId, [idOf(desktopDom)]),
      finding(first + 2, 'INFO', 'LAYOUT', pageId, [idOf(desktopDom)]),
    ];
    return pageResult(pageId, `/p${index + 1}.html`, 'AUDITED', evidence, findings);
  });
  return auditRun({ pages });
}

const SAMPLES: readonly (readonly [string, () => AuditRunResult])[] = [
  ['the edge case sample', edgeCaseAuditRun],
  ['the audit run sample', auditRun],
  ['the multi page sample', multiPageAuditRun],
];
const COLOR_SCHEMES = ['light', 'dark'] as const;

describe('the audit report HTML: accessibility (PL-R)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchHeadlessChromium();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  describe.each(SAMPLES)('%s', (_name, sample) => {
    it.each(COLOR_SCHEMES)('has no axe violation in the %s colour scheme', async (colorScheme) => {
      // 報告は CSP でスクリプトを禁じる。検査のスクリプトを入れるため、検査の Context だけ CSP を外す（報告の見た目は変わらない）。
      const context = await browser.newContext({ colorScheme, bypassCSP: true });
      try {
        const page = await context.newPage();
        const run = sample();
        const html = renderHtmlReport(buildReportViewModel(run));
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(REPORT_BASE_BYTES_LIMIT + run.pages.length * REPORT_BYTES_PER_PAGE_LIMIT);
        await page.setContent(html, { waitUntil: 'load' });
        const startedAt = performance.now();
        const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
        expect(performance.now() - startedAt).toBeLessThanOrEqual(REPORT_AXE_TIME_LIMIT_MS);
        const violations = results.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.html}`));
        expect(violations).toEqual([]);
      } finally {
        await context.close();
      }
    }, TEST_TIMEOUT_MS);
  });
});
