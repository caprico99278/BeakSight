// L1b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L1・L2）: Page Auditor の段の見張りと collector の見張りを 1 つにつなぎ、
// 見張りが段を終えても、collector の途中の記録を Evidence に残すことの結合のテスト（既定の Chromium）。
// - axe の段で固まる画面（axe を入れた後の最初の `getComputedStyle` で main thread を止める）: accessibility の途中の記録
//   （スクロール位置を読んだ PARTIAL）が Evidence に残り、理由は段の見張りの 1 つだけ。
// - screenshot の途中で固まる画面（全体の画像の撮影を返さない偽の page を、本物の撮影の部品に渡す）: 撮り終えた viewport の画像の Evidence と
//   ファイルが残り、理由は段の見張りの 1 つだけ。
// 反応なしの長さは、テストでは短くする（製品は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。サーバは、このテストの中の 127.0.0.1 のサーバだけを使う。
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { artifactFilePath } from '../../src/core/artifact-layout.js';
import type { PageAuditOutcome } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS, type TestConfigOverrides } from '../helpers/test-config.js';

const QUIET_LIMIT_MS = 4_000;
const TEST_TIMEOUT_MS = 3 * 60_000;

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/plain': '<!doctype html><html lang="en"><head><title>plain</title></head><body><main><h1>plain</h1><p>text</p></main></body></html>',
  // axe を入れた後（`window.axe` がある）の最初の `getComputedStyle` で、main thread を止める（通信を出さないので「静まらない」に
  // ならない。DOM の収集などの、axe の前の段の呼び出しでは止めない。止めたページは、ビューポートの終わりに Context を閉じると終わる）。
  '/freeze-on-axe': '<!doctype html><html lang="en"><head><title>freeze on axe</title></head><body><main><h1>freeze on axe</h1></main><script>'
    + 'const original = window.getComputedStyle; let frozen = false;'
    + 'window.getComputedStyle = function (...args) {'
    + '  if (!frozen && typeof window.axe === "object") { frozen = true; for (;;) { /* 止める */ } }'
    + '  return original.apply(this, args);'
    + '};'
    + '</script></body></html>',
  // L9: スクロールの途中（300px より下）で main thread を止める。
  '/freeze-on-scroll': '<!doctype html><html lang="en"><head><title>freeze on scroll</title><style>main{height:4000px}</style></head><body>'
    + '<main><h1>freeze on scroll</h1></main><script>'
    + 'addEventListener("scroll", () => { if (window.scrollY > 300) { for (;;) { /* 止める */ } } }, { passive: true });'
    + '</script></body></html>',
});

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

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server;
};

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

const createAuditor = async (
  origin: string,
  overrides: TestConfigOverrides,
  extra: Partial<Pick<PageAuditorDependencies, 'collectors'>> = {},
): Promise<{ readonly auditor: PageAuditor; readonly config: AuditConfig; readonly allocator: IdAllocator; readonly root: string }> => {
  const config = createTestConfig(origin, '/', overrides);
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-collector-watch-'));
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
    progressWatchQuietLimitMs: QUIET_LIMIT_MS,
    ...extra,
  });
  return { auditor, config, allocator, root };
};

const evidenceOf = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile', type: string): readonly unknown[] =>
  outcome.result.evidence.filter((record) => record.viewport === viewport && record.type === type).map((record) => record.payload);

const expectPageSchema = async (outcome: PageAuditOutcome): Promise<void> => {
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
};

/**
 * 全体の画像の撮影（`fullPage: true` の `screenshot`）を返さない page（ほかは本物の page にそのまま渡す）。AUD-2c: viewport の画像と全体の画像を別の回に撮るので、
 * 回数ではなく撮り方で見分ける（前は 2 回目の `screenshot` を止めた）。
 */
function pageFreezingOnFullPageCapture(page: Page): Page {
  return new Proxy(page, {
    get(target, property, receiver) {
      if (property === 'screenshot') {
        return (options: Parameters<Page['screenshot']>[0]) =>
          (options?.fullPage === true ? new Promise<Buffer>(() => undefined) : target.screenshot(options));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('L1b: one progress watch for a stage and its collector, keeping the records collected so far', () => {
  it('keeps the partial accessibility record of a page that freezes during axe, with one watch reason', async () => {
    const { origin } = await startServer();
    const { auditor, config, allocator } = await createAuditor(origin, {
      viewports: { stressWidths: [] },
      audit: { interactions: false, performance: false, screenshots: false },
    });

    const outcome = await auditor.audit(normalized(`${origin}/freeze-on-axe`, config), allocator.allocatePageId());

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].incompleteReasons, viewport).toEqual([{ code: 'STAGE_UNRESPONSIVE', detail: 'accessibility' }]);
      const accessibility = evidenceOf(outcome, viewport, 'accessibility');
      expect(accessibility, viewport).toHaveLength(1);
      expect(accessibility[0], viewport).toMatchObject({
        status: 'PARTIAL',
        reason: 'STAGE_UNRESPONSIVE',
        scrollPosition: { scrollX: 0, scrollY: 0 },
      });
    }
    await expectPageSchema(outcome);
  }, TEST_TIMEOUT_MS);

  it('L9: keeps the partial scroll record of a page that freezes while scrolling, with one watch reason', async () => {
    const { origin } = await startServer();
    const { auditor, config, allocator } = await createAuditor(origin, {
      viewports: { stressWidths: [] },
      audit: { interactions: false, performance: false, screenshots: false, accessibility: false },
    });

    const outcome = await auditor.audit(normalized(`${origin}/freeze-on-scroll`, config), allocator.allocatePageId());

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].incompleteReasons, viewport).toEqual([{ code: 'STAGE_UNRESPONSIVE', detail: 'scroll' }]);
      const scroll = evidenceOf(outcome, viewport, 'scroll') as readonly { readonly observations: readonly unknown[] }[];
      expect(scroll, viewport).toHaveLength(1);
      expect(scroll[0], viewport).toMatchObject({ status: 'PARTIAL', reason: 'STAGE_UNRESPONSIVE' });
      expect(scroll[0]?.observations.length, viewport).toBeGreaterThan(0);
    }
    await expectPageSchema(outcome);
  }, TEST_TIMEOUT_MS);

  it('keeps the viewport capture and its file when the full-page capture never returns, with one watch reason', async () => {
    const { origin } = await startServer();
    const { auditor, config, allocator, root } = await createAuditor(
      origin,
      { viewports: { stressWidths: [] }, audit: { interactions: false, performance: false, accessibility: false } },
      { collectors: { captureScreenshots: (page, paths, options) => captureScreenshots(pageFreezingOnFullPageCapture(page), paths, options) } },
    );

    const outcome = await auditor.audit(normalized(`${origin}/plain`, config), allocator.allocatePageId());

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(outcome.result.viewports[viewport].incompleteReasons, viewport).toEqual([{ code: 'STAGE_UNRESPONSIVE', detail: 'screenshot' }]);
      const screenshots = evidenceOf(outcome, viewport, 'screenshot') as readonly { readonly captureType: string; readonly relativePath: string }[];
      expect(screenshots.map((screenshot) => screenshot.captureType), viewport).toEqual(['VIEWPORT']);
      await expect(access(artifactFilePath(root, screenshots[0]?.relativePath ?? ''))).resolves.toBeUndefined();
    }
    await expectPageSchema(outcome);
  }, TEST_TIMEOUT_MS);
});
