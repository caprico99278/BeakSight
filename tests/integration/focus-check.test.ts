// AUD-4d・4c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4c・4d）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - 画面の外に置いた、フォーカスできる要素に、ほかの証拠を集め終えた後でフォーカスを当て、矩形・見えるか・押せるかを読む（段 `focus-check` の Evidence）。
//   - フォーカスで現れるスキップリンク: 指摘にしない（数だけ残す）。
//   - フォーカスしても現れないスキップリンク: `FOCUSED_CONTROL_HIDDEN` の指摘。フォーカスを当てたままの viewport の画像を撮り、指摘はその画像を参照する。
//   - 幅の走査の幅でも、同じ読み取りをする。
// - tel: のリンクは、指摘にしない（リンクの記録は消さない）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { findingImageRegionIndexOf } from '../../src/core/finding-image-regions.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;
const STRESS_WIDTH = 800;

const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>skip links</title>'
  + '<style>html, body { margin: 0; } .skip { position: absolute; left: -9999px; top: 0; } .skip:focus { left: 8px; top: 8px; background: #fff; }</style>'
  + '</head><body>'
  // 正常なスキップリンク（フォーカスで現れる）。
  + '<a id="skip" class="skip" href="#main">本文へ</a>'
  // フォーカスしても現れないスキップリンク。
  + '<a id="broken" href="#main" style="position: absolute; left: -9999px; top: 0">メニューへ</a>'
  + '<main id="main"><h1>見出し</h1><p>本文です。</p><a id="tel" href="tel:0120000000">電話する</a></main>'
  + '</body></html>';

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

describe('AUD-4d: the controls hidden until focus', () => {
  it('reads the focus at the end of the collection, reports only the control that does not appear, and points it at the focused image', async () => {
    server = await startLoopbackHttpServer((request, response) => {
      if (request.url === '/skip-links') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        return;
      }
      response.writeHead(404).end();
    });
    const { origin } = server;
    const config = createTestConfig(origin, '/', {
      viewports: { stressWidths: [STRESS_WIDTH] },
      audit: { interactions: false, performance: false, screenshots: true, accessibility: false },
    });
    const allocator = new IdAllocator();
    const root = await mkdtemp(join(tmpdir(), 'beaksight-focus-'));
    temporaryDirectories.push(root);
    const auditor = new PageAuditor({
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory: root,
      navigationPacer: createTestNavigationPacer(config),
      safetyViolationRecorded: () => false,
    });
    const outcome = await auditor.audit(normalized(`${origin}/skip-links`, config), allocator.allocatePageId());
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });

    for (const viewport of ['desktop', 'mobile'] as const) {
      const focus = outcome.result.evidence.filter((record) => record.type === 'focus' && record.viewport === viewport);
      const main = focus.find((record) => record.type === 'focus' && record.payload.stressWidth === undefined);
      expect(main, viewport).toMatchObject({ capture: { phase: 'focus-check' } });
      const selectors = main?.type === 'focus' ? main.payload.items.map(({ selector }) => selector) : [];
      expect([...selectors].sort(), viewport).toEqual(['#broken', '#skip']);
      const findings = outcome.result.findings.filter((finding) => finding.viewport === viewport && finding.ruleId === 'FOCUSED_CONTROL_HIDDEN'
        && !finding.groupingKeys?.some(({ name }) => name === 'stressWidth'));
      expect(findings.map((finding) => finding.groupingKeys?.find(({ name }) => name === 'selector')?.value), viewport).toEqual(['#broken']);
      // 指摘は、フォーカスを当てたままの画像（段 `focus-check`）を参照する。
      const shot = outcome.result.evidence.find((record) => record.type === 'screenshot' && findings[0]?.evidenceRefs.includes(record.evidenceId));
      expect(shot, viewport).toMatchObject({ capture: { phase: 'focus-check' }, payload: { captureType: 'VIEWPORT' } });
      // 指摘の画像の参照（AUD-3d）も、その画像と、フォーカスを当てた後の要素の矩形。
      const region = findings[0] === undefined ? null : findingImageRegionIndexOf({ pages: [outcome.result] } as unknown as AuditRunResult)(findings[0]);
      expect(region, viewport).toMatchObject({ screenshotEvidenceId: shot?.evidenceId, reason: null, regions: [{ role: 'TARGET', selector: '#broken' }] });
    }
    // 幅の走査の幅でも、同じ読み取りと指摘がある。
    const stressFocus = outcome.result.evidence.find((record) => record.type === 'focus' && record.payload.stressWidth === STRESS_WIDTH);
    expect(stressFocus).toMatchObject({ viewport: 'desktop', capture: { phase: 'focus-check' } });
    expect(outcome.result.findings.some((finding) => finding.ruleId === 'FOCUSED_CONTROL_HIDDEN'
      && finding.groupingKeys?.some(({ name, value }) => name === 'stressWidth' && value === String(STRESS_WIDTH)))).toBe(true);

    // AUD-4c: tel: のリンクは指摘にしない。リンクの記録は残る。
    expect(outcome.result.findings.some((finding) => finding.ruleId === 'UNSUPPORTED_URL_SCHEME')).toBe(false);
    const links = outcome.result.evidence.find((record) => record.type === 'link');
    expect(links?.type === 'link' ? links.payload.links.some((link) => link.admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') : false).toBe(true);
  }, TEST_TIMEOUT_MS);
});
