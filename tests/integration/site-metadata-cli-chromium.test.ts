// DEF-029 の設計書 2.3、DEF-030（SLIM-GROUP で `site-metadata.test.ts` から分けた。Chromium の版を上げるときの束 `CHROMIUM_UPGRADE_TEST_FILES`）:
// CLI と同じ起動の設定の Chromium は、本文が空の 4xx・5xx の読み込みを、応答を受けた後に `net::ERR_HTTP_RESPONSE_CODE_FAILURE` で失敗にする（テストの
// 既定の headless-shell では、この失敗が起きない）。その場合も、観測の status から、`NOT_FOUND`（404）と `FAILED`（503。`httpStatus` は 503）を導く。
// Chromium の振る舞いに依る「誤って失敗にしない」確かめなので、区切りの遅い組では流さず、版を上げるときに流す。
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { collectSiteMetadata } from '../../src/crawl/site-metadata.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BROWSER_DEFAULT_FAVICON_PATH, launchCliChromium, testContextsOf } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { NO_PACING_WAIT } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 120_000;

describe('collectSiteMetadata with the Chromium of the CLI: failures after the response (DEF-029 design 2.3, SU3b)', () => {
  let cliBrowser: Browser;
  let server: LoopbackHttpServer;
  const requestedPaths: string[] = [];

  beforeAll(async () => {
    // EL-12: 本番と同じ起動の部品（`launchCliChromium`）で起動する。
    cliBrowser = await launchCliChromium();
    // 本文が空の 404 の robots.txt と、本文が空の 503 の sitemap.xml を返す。
    server = await startLoopbackHttpServer((request, response) => {
      const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
      if (pathname !== BROWSER_DEFAULT_FAVICON_PATH) {
        requestedPaths.push(pathname);
      }
      response.statusCode = pathname === '/sitemap.xml' ? 503 : 404;
      response.setHeader('Content-Length', 0);
      response.end();
    });
  });

  afterAll(async () => {
    await cliBrowser?.close();
    await server?.close();
  });

  it('records an empty 404 robots.txt as NOT_FOUND and an empty 503 sitemap.xml as FAILED with HTTP 503', async () => {
    const config = createTestConfig(server.origin, '/');
    const allocator = new IdAllocator();
    const observations: MainFrameLoadObservation[] = [];

    const result = await collectSiteMetadata({
      contextFactory: new BrowserContextFactory(cliBrowser, config, () => new SafetyLedger()),
      origin: server.origin,
      config,
      pageId: allocator.allocatePageId(),
      allocator,
      clock: () => new Date('2026-09-24T00:00:00.000Z'),
      beforeNavigation: NO_PACING_WAIT,
      afterNavigation: (observation) => observations.push(observation),
    });

    // 読み込みは、応答を受けた後に例外で終わった（この Chromium の振る舞いが、このテストの前提）。
    const responseCodeFailure = expect.stringContaining('net::ERR_HTTP_RESPONSE_CODE_FAILURE') as unknown;
    expect(observations).toEqual([
      { navigationOutcome: 'FAILED', httpStatus: 404, failureDetail: responseCodeFailure },
      { navigationOutcome: 'FAILED', httpStatus: 503, failureDetail: responseCodeFailure },
    ]);
    expect(result.records[0].payload).toMatchObject({ kind: 'ROBOTS_TXT', outcome: 'NOT_FOUND', httpStatus: 404, text: null, sitemapUrls: null });
    expect(result.records[1].payload).toMatchObject({ outcome: 'FAILED', httpStatus: 503, text: null, sitemapUrls: null });
    expect(result.failures).toEqual([]);
    expect(result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(requestedPaths).toEqual(['/robots.txt', '/sitemap.xml']);
    expect(testContextsOf(cliBrowser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});
