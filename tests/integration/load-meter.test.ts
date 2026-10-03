// L4（サイトへの負荷の制御の設計書 4.5、第7章）: factory が渡す要求の終わりの事象で、LoadMeter が数えた要求の数を、
// fixture のサーバが実際に受け取った要求の数と比べる。Page Auditor が作るすべての Context（Passive の Desktop と Mobile、幅の走査、
// Interaction）を通す。Guard が止めた要求は、サーバに届かず、数えない。ブラウザ自身のキャッシュの扱いも、ここで確かめる。
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { PageAuditOutcome } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createLoadMeter, type LoadMeter } from '../../src/crawl/load-meter.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';
import { createRunLauncher, expectOnlyReadRequests, runWithCoordinator } from '../helpers/run-harness.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
/** Interaction の候補が1つ（aria-expanded を切り替えるボタン）のページ。クリックの後に要求を送らない。 */
const INTERACTION_TOGGLE_PAGE = '/page-auditor-interaction-toggle.html';
/** 画像を1つ読むページ（文書と画像の2件の要求）。 */
const IMAGE_PAGE = '/unsized-svg-image.html';
/** 利用者の操作なしに、GET・HEAD 以外の要求（POST、sendBeacon、PUT、遅れた DELETE）を送るページ。Guard がすべて止める。 */
const NON_READ_REQUESTS_PAGE = '/page-auditor-non-read-requests.html';

let browser: Browser;
const servers: FixtureServer[] = [];
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftoverContexts = browser.contexts();
  for (const context of leftoverContexts) {
    await context.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
});

async function startServer(): Promise<FixtureServer> {
  const server = await startFixtureServer();
  servers.push(server);
  return server;
}

function meterFor(config: AuditConfig): LoadMeter {
  return createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() });
}

function pacerFor(config: AuditConfig): NavigationPacer {
  return createNavigationPacer({
    minIntervalMs: config.crawl.minNavigationIntervalMs,
    now: () => Date.now(),
    sleep: async () => undefined,
  });
}

/** `pathname` のページを、meter を渡した factory の Page Auditor で監査する。 */
async function auditWithMeter(
  server: FixtureServer,
  pathname: string,
  overrides: TestConfigOverrides = {},
): Promise<{ readonly outcome: PageAuditOutcome; readonly meter: LoadMeter; readonly pacer: NavigationPacer }> {
  const config = createTestConfig(server.origin, '/', overrides);
  const meter = meterFor(config);
  const pacer = pacerFor(config);
  const contextFactory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: meter });
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-load-meter-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory,
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer: pacer,
    safetyViolationRecorded: () => false,
  });
  const normalized = normalizeUrl(`${server.origin}${pathname}`, `${server.origin}${pathname}`, new Set());
  if (!normalized.ok) {
    throw new Error(`fixture URL must normalize: ${pathname}`);
  }
  const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
  expect(browser.contexts(), 'Contexts left in the browser after audit()').toHaveLength(0);
  return { outcome, meter, pacer };
}

describe('LoadMeter through the BrowserContextFactory and the Page Auditor (L4)', () => {
  it('counts as many allowed-origin requests as the server received, over every Context the Page Auditor creates', async () => {
    const server = await startServer();

    const { outcome, meter, pacer } = await auditWithMeter(server, INTERACTION_TOGGLE_PAGE);

    // Passive の2回と Interaction の候補の1回に加えて、幅の走査の読み込みも通した（このページの要求は、読み込みごとに文書の1件だけ）。
    expect(pacer.snapshot().navigationCount).toBeGreaterThan(3);
    expect(outcome.result.evidence.some((record) => record.type === 'interaction')).toBe(true);
    const received = server.getRequestObservations();
    expect(received.length).toBe(pacer.snapshot().navigationCount);
    expect(meter.snapshot()).toEqual({
      allowedOrigins: { count: received.length, peakPerMinute: received.length },
      otherOrigins: { count: 0, peakPerMinute: 0 },
      servedFromCache: 0,
      withheldOtherOrigins: 0,
    });
  }, AUDIT_TEST_TIMEOUT_MS);

  it('counts the subresources as well (the document and its image on every load)', async () => {
    const server = await startServer();

    const { meter, pacer } = await auditWithMeter(server, IMAGE_PAGE, { viewports: { stressWidths: [] } });

    const received = server.getRequestObservations();
    expect(received.filter(({ pathname }) => pathname === '/unsized-image.svg').length).toBe(pacer.snapshot().navigationCount);
    expect(meter.snapshot().allowedOrigins.count).toBe(received.length);
    expect(meter.snapshot().otherOrigins.count).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not count the requests the Guard blocked (they never reach the server)', async () => {
    const server = await startServer();

    const { meter } = await auditWithMeter(server, NON_READ_REQUESTS_PAGE, { viewports: { stressWidths: [] } });

    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
    const received = server.getRequestObservations();
    expect(received.every(({ pathname }) => pathname === NON_READ_REQUESTS_PAGE)).toBe(true);
    expect(meter.snapshot().allowedOrigins.count).toBe(received.length);
    expect(meter.snapshot().otherOrigins.count).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

/** 長く使える（`Cache-Control: max-age`）画像を返す、この試験だけのサーバ（ループバック）。受け取った要求のパスを記録する。 */
async function startCacheableServer(): Promise<{ readonly origin: string; readonly received: string[]; close(): Promise<void> }> {
  const received: string[] = [];
  const server: Server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    received.push(pathname);
    if (pathname === '/cacheable.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>cacheable</title><img src="/cacheable.svg" alt="cacheable">');
      return;
    }
    if (pathname === '/cacheable.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.setHeader('Cache-Control', 'public, max-age=3600');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('cacheable server did not bind to a TCP port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('LoadMeter and the browser cache in one Context (L4)', () => {
  it('counts every request the server received when the same Context loads a cacheable image twice', async () => {
    const cacheable = await startCacheableServer();
    const config = createTestConfig(cacheable.origin);
    const meter = meterFor(config);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: meter });
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    try {
      await page.goto(`${cacheable.origin}/cacheable.html`, { waitUntil: 'load' });
      await page.goto(`${cacheable.origin}/cacheable.html`, { waitUntil: 'load' });
      await expect.poll(() => meter.snapshot().allowedOrigins.count).toBeGreaterThanOrEqual(cacheable.received.length);

      // Guard の route があるので、Playwright はブラウザの HTTP のキャッシュを使わない。2回目の読み込みでも、画像はサーバに届く。
      expect(cacheable.received).toEqual(['/cacheable.html', '/cacheable.svg', '/cacheable.html', '/cacheable.svg']);
      expect(meter.snapshot().allowedOrigins.count).toBe(cacheable.received.length);
    } finally {
      await closePassiveResources({ factory, context, page });
      await cacheable.close();
    }
  });

  // 対照: route のない Context（BeakSight は作らない）では、2回目の画像をブラウザのキャッシュから返す。そのときも、Playwright は
  // `requestfinished` を出す（LoadMeter に渡せば、送っていない要求を数える。多めに数える側）。
  it('control: without a route, the browser serves the image from its cache and still emits requestfinished', async () => {
    const cacheable = await startCacheableServer();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const finished: string[] = [];
    context.on('requestfinished', (request) => {
      finished.push(new URL(request.url()).pathname);
    });
    try {
      const page = await context.newPage();
      await page.goto(`${cacheable.origin}/cacheable.html`, { waitUntil: 'load' });
      await page.goto(`${cacheable.origin}/cacheable.html`, { waitUntil: 'load' });
      await expect.poll(() => finished.length).toBe(4);

      // サーバが受け取った画像の要求は1件だけ（2回目はブラウザのキャッシュから返した）。事象は、画像の2回分が来る
      // （文書の `requestfinished` は本文の終わりに来るので、事象の順は読み込みの順と限らない）。
      expect(cacheable.received).toEqual(['/cacheable.html', '/cacheable.svg', '/cacheable.html']);
      expect([...finished].sort()).toEqual(['/cacheable.html', '/cacheable.html', '/cacheable.svg', '/cacheable.svg']);
    } finally {
      await context.close();
      await cacheable.close();
    }
  });
});

// L4: Run Coordinator は、Run の初めに meter を作り、PREFLIGHT を通して factory に渡す。Run の結果の `load` は、スキーマに合い、
// サーバが受け取った要求の数と、pacer が数えた読み込みの回数を記録する。
describe('the load record of a Run through the Run Coordinator (L4)', () => {
  it('records as many navigations and allowed-origin requests as the server received, and matches the run schema', async () => {
    const server = await startServer();
    const config = createTestConfig(server.origin, INTERACTION_TOGGLE_PAGE);
    const launcher = createRunLauncher();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-load-meter-run-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const result = await runWithCoordinator({ config, launchBrowser: launcher.launcher, outputDirectory });

      // robots.txt と sitemap.xml、Passive の2回、幅の走査、Interaction の候補の読み込みの、どれも文書の1件だけを受け取る。
      const received = server.getRequestObservations();
      expect(received.map(({ pathname }) => pathname)).toEqual(expect.arrayContaining(['/robots.txt', '/sitemap.xml']));
      expect(result.run.load).toEqual({
        minNavigationIntervalMs: config.crawl.minNavigationIntervalMs,
        maxInteractionsPerPage: config.crawl.maxInteractionsPerPage,
        navigationCount: received.length,
        pacingWaitMs: 0,
        requests: {
          allowedOrigins: { count: received.length, peakPerMinute: received.length },
          otherOrigins: { count: 0, peakPerMinute: 0 },
          servedFromCache: 0,
          withheldOtherOrigins: 0,
        },
      });
      await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
    } finally {
      expect(await launcher.closeAll(), 'Browsers left connected after the Run').toBe(0);
    }
  }, AUDIT_TEST_TIMEOUT_MS);
});
