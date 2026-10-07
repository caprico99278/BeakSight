// L5b（サイトへの負荷の制御の設計書 3.1 の2・3・5、4.6、4.7、第7章）と DEF-031（設計書 4.10）: Run 全体のキャッシュと、許可された
// 要求の届け方を、Guard と Context の factory に配線した結果を、ローカルの fixture のサーバが受け取った要求で確かめる。
// - 主の読み込み（Passive の Desktop と Mobile。役割 PRIMARY）は、キャッシュにある画像・スクリプト・スタイルシート・フォント・動画を
//   キャッシュから返し、キャッシュにないものは（許可 Origin の外でも）ネットワークから取って、応答をキャッシュに入れる（DEF-031）。
// - 読み込み直しの Context（幅の走査と Interaction。役割 REVISIT）は、キャッシュにある画像とスクリプトをキャッシュから返し、
//   許可 Origin の外への、キャッシュにない要求を送らない。文書の要求は、どの読み込みでも送る。
// - 凍結の後の要求と、GET・HEAD 以外の要求は、届け方の部品に渡らず、今のまま Guard が止めて Safety の記録に残す。
// 2つ目の Origin（許可 Origin の外）は、fixture のサーバをもう1つ起動して作る（ポートが違うので、別の Origin になる）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import {
  RESOURCE_CACHE_FULL_RANGE_REQUEST,
  RESOURCE_CACHE_FULL_RANGE_STATUS,
  RESOURCE_CACHE_STORABLE_STATUS,
  ResourceCache,
} from '../../src/browser/resource-delivery.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceRecord, EvidenceRecordFor, EvidenceType, PageAuditOutcome, ViewportProfile } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createLoadMeter, type LoadMeter } from '../../src/crawl/load-meter.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BROWSER_DEFAULT_FAVICON_PATH, useHeadlessChromium } from '../helpers/chromium.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createRunLauncher, expectOnlyReadRequests, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
/** 許可 Origin の画像とスクリプト、2つ目の Origin の画像とスクリプトを読み、Interaction の候補を1つ持つページ。 */
const RESOURCE_PAGE = '/resource-delivery.html';
/** クリックの後に、`RESOURCE_PAGE` が読む画像（`ALLOWED_IMAGE`）を読もうとするページ。読み込みのときには読まない。 */
const AFTER_CLICK_PAGE = '/resource-delivery-after-click.html';
const ALLOWED_IMAGE = '/resource-delivery.svg';
const ALLOWED_SCRIPT = '/resource-delivery.js';
/** 2つ目の Origin の画像（同じパスで、読み込みごとに違うクエリの計測の画像も読む。サーバの記録のパスはクエリを含まない）。 */
const OTHER_IMAGE = '/external-image.svg';
const OTHER_SCRIPT = '/external-script.js';
/** `RESOURCE_PAGE` の1回の読み込みで、2つ目の Origin に送る要求（画像、計測の画像、スクリプト）。 */
const OTHER_REQUESTS_PER_LOAD = 3;
/**
 * `RESOURCE_PAGE` の1回の読み込みで、2つ目の Origin に送る要求のうち、Run 全体のキャッシュに入らない要求（計測の画像。読み込みごとに
 * URL が違う）。主の読み込み（PRIMARY）は、キャッシュにない要求を、許可 Origin の外でも送る（DEF-031）。
 */
const UNCACHED_OTHER_REQUESTS_PER_LOAD = 1;
/**
 * Run の中で、キャッシュに入る画像やスクリプトを、ネットワークから取る読み込みの回数（DEF-031。最初の Passive の読み込みの1回だけ。
 * 2回目からの Passive の読み込みと、読み込み直しは、キャッシュから返す）。
 */
const NETWORK_LOADS_OF_CACHED_RESOURCES = 1;
/** `RESOURCE_PAGE` の1回の読み込み直しで、キャッシュから返す要求（許可 Origin と2つ目の Origin の、画像とスクリプト）。 */
const CACHED_REQUESTS_PER_REVISIT = 4;
/** `RESOURCE_PAGE` の1回の読み込み直しで、送らない要求（2つ目の Origin の計測の画像。読み込みごとに URL が違う）。 */
const WITHHELD_REQUESTS_PER_REVISIT = 1;
/** 主の読み込み（Passive の Desktop と Mobile）の回数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
/** `RESOURCE_PAGE` が2つ目の Origin のポートを受け取るクエリの名前。URL の正規化で落とさないよう、設定で残す。 */
const OTHER_PORT_QUERY_PARAMETER = 'otherPort';
/** 幅の走査（幅を1つ）と Interaction（候補は1つ）を行い、スクリーンショットは撮らない設定。 */
const REVISIT_OVERRIDES: TestConfigOverrides = Object.freeze({
  crawl: Object.freeze({ allowedQueryParameters: [OTHER_PORT_QUERY_PARAMETER] }),
  viewports: Object.freeze({ stressWidths: [1_024] }),
  audit: Object.freeze({ screenshots: false, interactions: true }),
});

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

/** 許可 Origin のサーバ（`allowed`）と、2つ目の Origin のサーバ（`other`）。 */
async function startServers(): Promise<{ readonly allowed: FixtureServer; readonly other: FixtureServer }> {
  return { allowed: await startServer(), other: await startServer() };
}

/** `RESOURCE_PAGE` に、2つ目の Origin のポートを付けたパス。 */
const resourcePagePath = (other: FixtureServer): string =>
  `${RESOURCE_PAGE}?${OTHER_PORT_QUERY_PARAMETER}=${new URL(other.origin).port}`;

/** サーバが受け取った、`pathname` の要求の数。 */
const receivedCount = (server: FixtureServer, pathname: string): number =>
  server.getRequestObservations().filter((observation) => observation.pathname === pathname).length;

function meterFor(config: AuditConfig): LoadMeter {
  return createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() });
}

interface CachedFactory {
  readonly config: AuditConfig;
  readonly factory: BrowserContextFactory;
  readonly cache: ResourceCache;
  readonly meter: LoadMeter;
}

/** Run Coordinator と同じく、Run 全体のキャッシュと meter を渡した factory。 */
function cachedFactory(allowed: FixtureServer, overrides: TestConfigOverrides = REVISIT_OVERRIDES): CachedFactory {
  const config = createTestConfig(allowed.origin, '/', overrides);
  const cache = new ResourceCache();
  const meter = meterFor(config);
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: meter, resourceCache: cache });
  return { config, factory, cache, meter };
}

/** `pathname` のページを、`cached` の factory の Page Auditor で監査する（本番の Run Coordinator と同じ部品の組み合わせ）。 */
async function auditPage(
  cached: CachedFactory,
  origin: string,
  pathname: string,
  pacer: NavigationPacer = createTestNavigationPacer(cached.config),
): Promise<PageAuditOutcome> {
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resource-delivery-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory: cached.factory,
    config: cached.config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer: pacer,
    safetyViolationRecorded: () => false,
  });
  const normalized = normalizeUrl(`${origin}${pathname}`, `${origin}${pathname}`, new Set(cached.config.crawl.allowedQueryParameters));
  if (!normalized.ok) {
    throw new Error(`fixture URL must normalize: ${pathname}`);
  }
  const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
  expect(browser.contexts(), 'Contexts left in the browser after audit()').toHaveLength(0);
  return outcome;
}

function evidenceOf<TType extends EvidenceType>(
  outcome: PageAuditOutcome,
  type: TType,
  viewport: ViewportProfile,
): EvidenceRecordFor<TType>[] {
  return outcome.result.evidence.filter(
    (record): record is EvidenceRecordFor<TType> & EvidenceRecord => record.type === type && record.viewport === viewport,
  );
}

describe('the Run cache and resource delivery through the Page Auditor (L5b)', () => {
  it('serves the main-load images and scripts from the Run cache in the width scan and Interaction Contexts and withholds the other origin', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    const pacer = createTestNavigationPacer(cached.config);

    const outcome = await auditPage(cached, allowed.origin, resourcePagePath(other), pacer);

    // Passive の Desktop と Mobile に加えて、幅の走査（1つ）と Interaction（候補1つ）の読み込み直しを行った。
    const navigationCount = pacer.snapshot().navigationCount;
    const revisitLoads = navigationCount - PRIMARY_LOADS_PER_PAGE;
    expect(revisitLoads).toBe(2);
    expect(evidenceOf(outcome, 'interaction', 'desktop').map((record) => record.payload.status)).toEqual(['VERIFIED']);
    expect(outcome.result.viewports.desktop.status).toBe('AUDITED');
    expect(outcome.safety.invariantViolationCount).toBe(0);

    // 文書の要求は、すべての読み込みで届く。画像とスクリプトは、最初の主の読み込み（Desktop）の1回だけ届く（DEF-031。2回目の主の
    // 読み込み（Mobile）と、読み込み直しでは、キャッシュから返すので届かない）。
    expect(receivedCount(allowed, RESOURCE_PAGE)).toBe(navigationCount);
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
    expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
    expect(allowed.getRequestObservations()).toHaveLength(navigationCount + 2 * NETWORK_LOADS_OF_CACHED_RESOURCES);
    // 2つ目の Origin には、最初の主の読み込みのすべてと、2回目の主の読み込みの、キャッシュにない計測の画像だけが届く（主の読み込みは、
    // キャッシュにない要求を、許可 Origin の外でも送る）。読み込み直しの Context からは、何も届かない。
    expect(receivedCount(other, OTHER_IMAGE)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES + UNCACHED_OTHER_REQUESTS_PER_LOAD * PRIMARY_LOADS_PER_PAGE);
    expect(receivedCount(other, OTHER_SCRIPT)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
    expect(other.getRequestObservations())
      .toHaveLength(OTHER_REQUESTS_PER_LOAD + UNCACHED_OTHER_REQUESTS_PER_LOAD * (PRIMARY_LOADS_PER_PAGE - NETWORK_LOADS_OF_CACHED_RESOURCES));
    expectOnlyReadRequests(allowed.getCounters(), allowed.getRequestObservations());
    expectOnlyReadRequests(other.getCounters(), other.getRequestObservations());

    // 負荷の記録: キャッシュから返した要求と送らなかった要求は、数に入らない（サーバが受け取った数と一致する）。キャッシュから返した数は、
    // 2回目の主の読み込みと、読み込み直しの分。送らなかった数は、読み込み直しの分だけ（主の読み込みは送らないことを選ばない）。
    expect(cached.meter.snapshot()).toEqual({
      allowedOrigins: { count: allowed.getRequestObservations().length, peakPerMinute: allowed.getRequestObservations().length },
      otherOrigins: { count: other.getRequestObservations().length, peakPerMinute: other.getRequestObservations().length },
      servedFromCache: CACHED_REQUESTS_PER_REVISIT * (revisitLoads + PRIMARY_LOADS_PER_PAGE - NETWORK_LOADS_OF_CACHED_RESOURCES),
      withheldOtherOrigins: WITHHELD_REQUESTS_PER_REVISIT * revisitLoads,
    });

    // 主の読み込み（PRIMARY）の Desktop はネットワークから、Mobile はキャッシュから、画像とスクリプトを取った（DEF-031）。どちらの
    // network の Evidence にも、画像とスクリプトの要求と、200 の応答があり、失敗はない（キャッシュから返しても、表示は壊れない）。
    const resourceUrls = [
      `${allowed.origin}${ALLOWED_IMAGE}`,
      `${allowed.origin}${ALLOWED_SCRIPT}`,
      `${other.origin}${OTHER_IMAGE}`,
      `${other.origin}${OTHER_SCRIPT}`,
    ];
    for (const viewport of ['desktop', 'mobile'] as const) {
      const network = evidenceOf(outcome, 'network', viewport);
      expect(network, viewport).toHaveLength(1);
      const payload = network[0]!.payload;
      for (const url of resourceUrls) {
        expect(payload.requests.map((request) => request.url), `${viewport} ${url}`).toContain(url);
        expect(payload.responses.filter((response) => response.url === url).map((response) => response.status), `${viewport} ${url}`)
          .toEqual([200]);
      }
      expect(payload.failures, viewport).toEqual([]);
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not serve a cached image requested after the freeze; the Guard blocks it and records it in the Safety Evidence', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    // 先に、画像（`ALLOWED_IMAGE`）を読むページを監査し、Run 全体のキャッシュに入れる。
    await auditPage(cached, allowed.origin, resourcePagePath(other));
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
    const before = cached.meter.snapshot();
    const imageUrl = `${allowed.origin}${ALLOWED_IMAGE}`;

    const outcome = await auditPage(cached, allowed.origin, AFTER_CLICK_PAGE);

    // クリックの後の画像の要求は、キャッシュにあっても、Guard が凍結で止め、Interaction の Safety の記録に残す。
    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(interactions.map((record) => record.payload.status)).toEqual(['BLOCKED_BY_SAFETY']);
    const interactionSafety = evidenceOf(outcome, 'safety', 'desktop').filter((record) => record.payload.scope === 'INTERACTION');
    expect(interactionSafety).toHaveLength(1);
    expect(interactionSafety[0]?.payload.blockedInteractionRequests).toEqual([
      expect.objectContaining({ method: 'GET', url: imageUrl, reason: 'INTERACTION_FROZEN' }),
    ]);
    // キャッシュから返していない（数が増えていない）し、サーバにも届いていない。
    expect(cached.meter.snapshot().servedFromCache).toBe(before.servedFromCache);
    expect(cached.meter.snapshot().withheldOtherOrigins).toBe(before.withheldOtherOrigins);
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
    expect(outcome.safety.invariantViolationCount).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('the Run cache and resource delivery in the Contexts of the factory (L5b)', () => {
  it('renders the images and runs the scripts served from the Run cache in a REVISIT Context and withholds the other origin', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    const viewport = cached.config.viewports.primaryDesktop;
    const pageUrl = `${allowed.origin}${resourcePagePath(other)}`;
    const primary = await cached.factory.createPassiveContext(viewport);
    const primaryPage = await cached.factory.createPassivePage(primary);
    const revisit = await cached.factory.createPassiveContext(viewport, 'REVISIT');
    const revisitPage = await cached.factory.createPassivePage(revisit);
    try {
      await primaryPage.goto(pageUrl, { waitUntil: 'load' });
      // 応答の本文は非同期で取ってからキャッシュに入れるので、4件（許可 Origin と2つ目の Origin の画像とスクリプト）が入るまで待つ。
      await expect.poll(() => cached.cache.stats().entryCount).toBeGreaterThanOrEqual(CACHED_REQUESTS_PER_REVISIT);

      await revisitPage.goto(pageUrl, { waitUntil: 'load' });
      const rendered = await revisitPage.evaluate(() => ({
        allowedImageWidth: document.querySelector<HTMLImageElement>('#allowed-image')?.naturalWidth ?? null,
        otherImageWidth: document.querySelector<HTMLImageElement>('#other-image')?.naturalWidth ?? null,
        allowedScriptLoaded: (globalThis as { fixtureResourceDeliveryScriptLoaded?: boolean }).fixtureResourceDeliveryScriptLoaded ?? false,
        otherScriptLoaded: (globalThis as { fixtureExternalScriptLoaded?: boolean }).fixtureExternalScriptLoaded ?? false,
      }));

      // キャッシュから返した画像は表示され、スクリプトは実行される。
      expect(rendered).toEqual({ allowedImageWidth: 8, otherImageWidth: 1, allowedScriptLoaded: true, otherScriptLoaded: true });
      // サーバには、文書が2回、画像とスクリプトは主の読み込みの1回だけ届く。2つ目の Origin にも、主の読み込みの分だけ届く。
      expect(receivedCount(allowed, RESOURCE_PAGE)).toBe(2);
      expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(1);
      expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(1);
      expect(other.getRequestObservations()).toHaveLength(OTHER_REQUESTS_PER_LOAD);
      await expect.poll(() => cached.meter.snapshot().withheldOtherOrigins).toBe(WITHHELD_REQUESTS_PER_REVISIT);
      expect(cached.meter.snapshot().servedFromCache).toBe(CACHED_REQUESTS_PER_REVISIT);
      // 送らなかった要求は、安全のための遮断ではないので、Safety の記録に入れない。
      const revisitSafety = cached.factory.getSafetyLedger(revisit).snapshot();
      expect(revisitSafety.blockedRequests).toEqual([]);
      expect(revisitSafety.invariantViolationCount).toBe(0);
    } finally {
      await closePassiveResources({ factory: cached.factory, context: primary, page: primaryPage });
      await closePassiveResources({ factory: cached.factory, context: revisit, page: revisitPage });
    }
  });

  it('does not pass non-read requests of a REVISIT Context to the delivery part; the Guard blocks and records them', async () => {
    const allowed = await startServer();
    const cached = cachedFactory(allowed);
    const revisit = await cached.factory.createPassiveContext(cached.config.viewports.primaryDesktop, 'REVISIT');
    const page = await cached.factory.createPassivePage(revisit);
    try {
      await page.goto(`${allowed.origin}/passive-patch-request.html`, { waitUntil: 'load' });
      const ledger = cached.factory.getSafetyLedger(revisit);
      await expect.poll(() => ledger.snapshot().blockedRequests.length).toBe(1);

      // Guard が、許可の判定の BLOCK で止めた（Safety の記録に残る）。届け方の部品は、送らない要求として数えていない。
      expect(ledger.snapshot().blockedRequests).toEqual([
        expect.objectContaining({ method: 'PATCH', url: `${allowed.origin}/__mutation` }),
      ]);
      expect(cached.meter.snapshot().withheldOtherOrigins).toBe(0);
      expect(cached.meter.snapshot().servedFromCache).toBe(0);
      expect(allowed.getCounters().patch).toBe(0);
      expectOnlyReadRequests(allowed.getCounters(), allowed.getRequestObservations());
    } finally {
      await closePassiveResources({ factory: cached.factory, context: revisit, page });
    }
  });
});

// Run Coordinator は、Run の初めに Run 全体のキャッシュを1つ作り、PREFLIGHT を通して factory に渡す。Run の結果の `load` に、
// キャッシュから返した数と、送らなかった数が入る。許可 Origin とそれ以外の要求の数は、サーバが受け取った数と一致する。
describe('the Run cache through the Run Coordinator (L5b)', () => {
  it('records requests served from the Run cache and withheld requests in load, apart from the requests the servers received', async () => {
    const { allowed, other } = await startServers();
    const config = createTestConfig(allowed.origin, resourcePagePath(other), REVISIT_OVERRIDES);
    const launcher = createRunLauncher();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resource-delivery-run-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const result = await runWithCoordinator({ config, launchBrowser: launcher.launcher, outputDirectory });

      const { load } = result.run;
      expect(load.requests.servedFromCache).toBeGreaterThan(0);
      expect(load.requests.withheldOtherOrigins).toBeGreaterThan(0);
      // キャッシュから返した要求と送らなかった要求は、`allowedOrigins` と `otherOrigins` に入らない。
      expect(load.requests.allowedOrigins.count).toBe(allowed.getRequestObservations().length);
      expect(load.requests.otherOrigins.count).toBe(other.getRequestObservations().length);
      // 画像とスクリプトは、最初の Passive の読み込みの1回だけ届く（DEF-031）。2つ目の Origin には、それに加えて、2回目の Passive の
      // 読み込みの、キャッシュにない計測の画像が届く。
      expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
      expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(NETWORK_LOADS_OF_CACHED_RESOURCES);
      expect(other.getRequestObservations())
        .toHaveLength(OTHER_REQUESTS_PER_LOAD + UNCACHED_OTHER_REQUESTS_PER_LOAD * (PRIMARY_LOADS_PER_PAGE - NETWORK_LOADS_OF_CACHED_RESOURCES));
      await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
    } finally {
      expect(await launcher.closeAll(), 'Browsers left connected after the Run').toBe(0);
    }
  }, AUDIT_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------
// DEF-031（サイトへの負荷の制御の設計書 4.10）: Passive の読み込み（PRIMARY）も Run 全体のキャッシュを使う
// ---------------------------------------------------------------------------------------------------------------

/** この試験だけのサーバが返すページ。許可 Origin と2つ目の Origin の、画像・スクリプト・スタイルシート・フォント・動画を読む。 */
const PRIMARY_CACHE_PAGE = '/primary-cache.html';
/** 両方のサーバが返す、Run 全体のキャッシュに入る部品（種類ごとに1つ）。 */
const PRIMARY_CACHE_RESOURCES = Object.freeze({
  image: '/primary-cache.svg',
  script: '/primary-cache.js',
  stylesheet: '/primary-cache.css',
  font: '/primary-cache.woff2',
  media: '/primary-cache.mp4',
} as const);
const PRIMARY_CACHE_RESOURCE_PATHS: readonly string[] = Object.freeze(Object.values(PRIMARY_CACHE_RESOURCES));
/** 2つ目の Origin の、読み込みごとに URL が違う計測の画像（Run 全体のキャッシュにない）。 */
const PRIMARY_CACHE_BEACON = '/primary-cache-beacon.svg';
/** 両方の Origin の、キャッシュに入る部品の数。 */
const PRIMARY_CACHED_RESOURCE_COUNT = 2 * PRIMARY_CACHE_RESOURCE_PATHS.length;
/** 動画（VP9 の小さな mp4。`fixtures/site/` に置く。ffmpeg で作った 16x16、1秒の動画）。 */
const VIDEO_FIXTURE_URL = new URL('../../fixtures/site/resource-delivery-video.mp4', import.meta.url);
/** 画像の幅（サーバごとに変え、どちらの画像が表示されたかを見分ける）。 */
const PRIMARY_CACHE_IMAGE_WIDTHS = Object.freeze({ allowed: 8, other: 4 } as const);
/** スタイルシートが付ける文字の色（サーバごとに変える）。 */
const PRIMARY_CACHE_COLORS = Object.freeze({ allowed: 'rgb(1, 2, 3)', other: 'rgb(4, 5, 6)' } as const);
/** キャッシュとサーバの記録が落ち着くのを待つ上限（ms）。 */
const PRIMARY_CACHE_POLL_TIMEOUT_MS = 10_000;
const PRIMARY_CACHE_TEST_TIMEOUT_MS = 60_000;

type ResourceServerLabel = keyof typeof PRIMARY_CACHE_IMAGE_WIDTHS;

interface ResourceServerRequest {
  readonly method: string;
  readonly pathname: string;
  readonly range: string | null;
}

/** この試験だけのサーバ（ループバック）。受け取った要求を記録する。 */
interface ResourceServer {
  readonly origin: string;
  /** 受け取った要求（ブラウザ自身の `/favicon.ico` の GET を除く。DEF-024）。 */
  received(): readonly ResourceServerRequest[];
  close(): Promise<void>;
}

/** `PRIMARY_CACHE_PAGE` の HTML。2つ目の Origin の部品は、クエリの otherPort で受け取ったポートから読む。 */
const PRIMARY_CACHE_PAGE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Primary cache fixture</title>',
  `<link rel="stylesheet" href="${PRIMARY_CACHE_RESOURCES.stylesheet}">`,
  `<script src="${PRIMARY_CACHE_RESOURCES.script}"></script>`,
  `<style>@font-face { font-family: AllowedFont; src: url(${PRIMARY_CACHE_RESOURCES.font}) format("woff2"); }`,
  '#allowed-font { font-family: AllowedFont, sans-serif; }</style>',
  '</head><body>',
  '<p id="allowed-styled">allowed</p><p id="other-styled">other</p>',
  '<p id="allowed-font">allowed font</p><p id="other-font">other font</p>',
  `<img id="allowed-image" src="${PRIMARY_CACHE_RESOURCES.image}" alt="allowed">`,
  `<video id="allowed-video" src="${PRIMARY_CACHE_RESOURCES.media}" muted preload="auto"></video>`,
  '<script>',
  'window.videoEvents = { allowed: [], other: [] };',
  'const watch = (video, label) => { for (const type of ["loadedmetadata", "error"]) video.addEventListener(type, () => window.videoEvents[label].push(type)); };',
  'watch(document.querySelector("#allowed-video"), "allowed");',
  'const otherPort = new URLSearchParams(location.search).get("otherPort");',
  'const otherOrigin = location.protocol + "//" + location.hostname + ":" + otherPort;',
  `const link = document.createElement("link"); link.rel = "stylesheet"; link.href = otherOrigin + "${PRIMARY_CACHE_RESOURCES.stylesheet}"; document.head.append(link);`,
  `const script = document.createElement("script"); script.src = otherOrigin + "${PRIMARY_CACHE_RESOURCES.script}"; document.head.append(script);`,
  `const style = document.createElement("style"); style.textContent = "@font-face { font-family: OtherFont; src: url(" + otherOrigin + "${PRIMARY_CACHE_RESOURCES.font}); } #other-font { font-family: OtherFont, sans-serif; }"; document.head.append(style);`,
  `const image = document.createElement("img"); image.id = "other-image"; image.alt = "other"; image.src = otherOrigin + "${PRIMARY_CACHE_RESOURCES.image}"; document.body.append(image);`,
  `const video = document.createElement("video"); video.id = "other-video"; video.muted = true; video.preload = "auto"; watch(video, "other"); video.src = otherOrigin + "${PRIMARY_CACHE_RESOURCES.media}"; document.body.append(video);`,
  `new Image().src = otherOrigin + "${PRIMARY_CACHE_BEACON}?load=" + Date.now() + "-" + Math.random();`,
  '</script></body></html>',
].join('\n');

/** 動画を返す。`Range: bytes=<start>-[<end>]` なら 206 と `Content-Range` で、なければ 200 で全体を返す（ふつうのサーバと同じ）。 */
function sendVideo(request: IncomingMessage, response: ServerResponse, video: Buffer): void {
  response.setHeader('Content-Type', 'video/mp4');
  response.setHeader('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d+)-(\d*)$/u.exec((request.headers.range ?? '').trim());
  if (range === null) {
    response.setHeader('Content-Length', String(video.byteLength));
    response.end(video);
    return;
  }
  const start = Number(range[1]);
  const end = range[2] === '' ? video.byteLength - 1 : Math.min(Number(range[2]), video.byteLength - 1);
  response.statusCode = RESOURCE_CACHE_FULL_RANGE_STATUS;
  response.setHeader('Content-Range', `bytes ${start}-${end}/${video.byteLength}`);
  response.setHeader('Content-Length', String(end - start + 1));
  response.end(video.subarray(start, end + 1));
}

/** `label` の部品を返す、この試験だけのサーバを起動する。 */
async function startResourceServer(label: ResourceServerLabel, video: Buffer): Promise<ResourceServer> {
  const received: ResourceServerRequest[] = [];
  const server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
    received.push({ method: request.method ?? '', pathname, range: request.headers.range ?? null });
    switch (pathname) {
      case PRIMARY_CACHE_PAGE:
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(PRIMARY_CACHE_PAGE_HTML);
        return;
      case PRIMARY_CACHE_RESOURCES.stylesheet:
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end(`#${label}-styled { color: ${PRIMARY_CACHE_COLORS[label]}; }`);
        return;
      case PRIMARY_CACHE_RESOURCES.script:
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(`(globalThis.primaryCacheScripts ??= []).push(${JSON.stringify(label)});`);
        return;
      case PRIMARY_CACHE_RESOURCES.image:
      case PRIMARY_CACHE_BEACON: {
        const width = PRIMARY_CACHE_IMAGE_WIDTHS[label];
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"></svg>`);
        return;
      }
      case PRIMARY_CACHE_RESOURCES.font:
        // フォントの中身は確かめない（要求がサーバに届くかだけを確かめる）。別の Origin から読めるよう、CORS を許す。
        response.setHeader('Content-Type', 'font/woff2');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.end(`fixture font of the ${label} origin`);
        return;
      case PRIMARY_CACHE_RESOURCES.media:
        sendVideo(request, response, video);
        return;
      default:
        response.statusCode = 404;
        response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received: () => received.filter(({ method, pathname }) => !(method === 'GET' && pathname === BROWSER_DEFAULT_FAVICON_PATH)),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** サーバが受け取った、`pathname` の要求の数。 */
const resourceRequestCount = (server: ResourceServer, pathname: string): number =>
  server.received().filter((request) => request.pathname === pathname).length;

/** サーバが受け取った、キャッシュに入る部品の要求の数（パスごと）。 */
const resourceRequestCounts = (server: ResourceServer): Record<string, number> =>
  Object.fromEntries(PRIMARY_CACHE_RESOURCE_PATHS.map((pathname) => [pathname, resourceRequestCount(server, pathname)]));

/** すべての部品が `count` 回ずつ届いたことを表す、`resourceRequestCounts` の期待。 */
const eachResourceReceived = (count: number): Record<string, number> =>
  Object.fromEntries(PRIMARY_CACHE_RESOURCE_PATHS.map((pathname) => [pathname, count]));

/** ページが表示した結果（画像の幅、スクリプト、スタイルシートの色、動画の事象）。動画の事象が出るまで待つ。 */
async function renderedPrimaryCachePage(page: Page): Promise<unknown> {
  await expect.poll(
    () => page.evaluate(() => (globalThis as { videoEvents?: Record<string, string[]> }).videoEvents),
    { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS },
  ).toEqual({ allowed: ['loadedmetadata'], other: ['loadedmetadata'] });
  return page.evaluate(() => ({
    allowedImageWidth: document.querySelector<HTMLImageElement>('#allowed-image')?.naturalWidth ?? null,
    otherImageWidth: document.querySelector<HTMLImageElement>('#other-image')?.naturalWidth ?? null,
    scripts: [...((globalThis as { primaryCacheScripts?: string[] }).primaryCacheScripts ?? [])].sort(),
    allowedColor: getComputedStyle(document.querySelector('#allowed-styled')!).color,
    otherColor: getComputedStyle(document.querySelector('#other-styled')!).color,
    videoEvents: (globalThis as { videoEvents?: unknown }).videoEvents,
  }));
}

const EXPECTED_PRIMARY_CACHE_RENDERING = Object.freeze({
  allowedImageWidth: PRIMARY_CACHE_IMAGE_WIDTHS.allowed,
  otherImageWidth: PRIMARY_CACHE_IMAGE_WIDTHS.other,
  scripts: ['allowed', 'other'],
  allowedColor: PRIMARY_CACHE_COLORS.allowed,
  otherColor: PRIMARY_CACHE_COLORS.other,
  videoEvents: { allowed: ['loadedmetadata'], other: ['loadedmetadata'] },
});

/** Context の、要求の終わり（URL ごとの応答の status と、失敗した URL）。 */
interface RequestEnds {
  readonly finishedStatuses: Map<string, number | null>;
  readonly failedUrls: string[];
}

function watchRequestEnds(context: BrowserContext): RequestEnds {
  const ends: RequestEnds = { finishedStatuses: new Map(), failedUrls: [] };
  context.on('requestfinished', (request: Request) => {
    void request.response().then((response) => {
      ends.finishedStatuses.set(request.url(), response?.status() ?? null);
    }, () => undefined);
  });
  context.on('requestfailed', (request: Request) => {
    ends.failedUrls.push(request.url());
  });
  return ends;
}

describe('Passive (PRIMARY) loads use the Run cache (DEF-031)', () => {
  let cliBrowser: Browser | undefined;
  let video: Buffer;
  const resourceServers: ResourceServer[] = [];

  beforeAll(async () => {
    video = await readFile(VIDEO_FIXTURE_URL);
    // CLI と同じ起動の設定（headless）。テストの既定の Chromium（headless shell）と、動画の取り方が違う可能性があるため（DEF-030）。
    cliBrowser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  });

  afterAll(async () => {
    await cliBrowser?.close();
  });

  afterEach(async () => {
    for (const server of resourceServers.splice(0)) {
      await server.close();
    }
  });

  it.each([
    { name: 'the default test Chromium (headless shell)', browserOf: (): Browser => browser },
    { name: 'the Chromium of the CLI (chromiumLaunchOptions, headless)', browserOf: (): Browser => cliBrowser! },
  ])('takes images, scripts, stylesheets, fonts, and videos from the network only on the first Passive load: $name', async ({ browserOf }) => {
    const targetBrowser = browserOf();
    const allowed = await startResourceServer('allowed', video);
    resourceServers.push(allowed);
    const other = await startResourceServer('other', video);
    resourceServers.push(other);
    const config = createTestConfig(allowed.origin);
    const cache = new ResourceCache();
    const meter = meterFor(config);
    const factory = new BrowserContextFactory(targetBrowser, config, () => new SafetyLedger(), { loadMeter: meter, resourceCache: cache });
    const pageUrl = `${allowed.origin}${PRIMARY_CACHE_PAGE}?${OTHER_PORT_QUERY_PARAMETER}=${new URL(other.origin).port}`;
    const resourceUrls = [allowed, other].flatMap((server) => PRIMARY_CACHE_RESOURCE_PATHS.map((pathname) => `${server.origin}${pathname}`));

    // 1つ目の Passive の読み込み（PRIMARY。Desktop）: キャッシュが空なので、部品の要求は、どちらのサーバにも届く（空振りでないこと）。
    const first = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const firstPage = await factory.createPassivePage(first);
    try {
      await firstPage.goto(pageUrl, { waitUntil: 'load' });
      expect(await renderedPrimaryCachePage(firstPage)).toEqual(EXPECTED_PRIMARY_CACHE_RENDERING);
      // 部品は、どれもキャッシュに入る（計測の画像も入るが、読み込みごとに URL が違うので、2回目には使われない）。
      await expect.poll(() => resourceUrls.filter((url) => cache.lookup(url) === undefined), { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS })
        .toEqual([]);
      expect(resourceRequestCounts(allowed)).toEqual(eachResourceReceived(1));
      expect(resourceRequestCounts(other)).toEqual(eachResourceReceived(1));
      // Chromium は、動画を `Range: bytes=0-` で取る（全体を 206 で受け取り、キャッシュに入れる。設計書 4.10.3 の前提）。
      for (const server of [allowed, other]) {
        expect(server.received().filter(({ pathname }) => pathname === PRIMARY_CACHE_RESOURCES.media).map(({ range }) => range))
          .toEqual([RESOURCE_CACHE_FULL_RANGE_REQUEST]);
      }
      expect(cache.lookup(`${other.origin}${PRIMARY_CACHE_RESOURCES.media}`)?.status).toBe(RESOURCE_CACHE_STORABLE_STATUS);
      expect(meter.snapshot().servedFromCache).toBe(0);
    } finally {
      await closePassiveResources({ factory, context: first, page: firstPage });
    }

    // 2つ目の Passive の読み込み（PRIMARY。同じ factory と同じキャッシュ。Mobile の幅）: 部品は、キャッシュから返し、どちらのサーバにも
    // 届かない。ページの文書と、キャッシュにない許可 Origin の外の計測の画像は、ネットワークに送る（PRIMARY では送らないことを選ばない）。
    const second = await factory.createPassiveContext(config.viewports.primaryMobile);
    const ends = watchRequestEnds(second);
    const secondPage = await factory.createPassivePage(second);
    try {
      await secondPage.goto(pageUrl, { waitUntil: 'load' });
      await expect.poll(() => meter.snapshot().servedFromCache, { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS })
        .toBe(PRIMARY_CACHED_RESOURCE_COUNT);
      // 表示は壊れていない（画像が表示され、スクリプトが動き、スタイルシートが効き、動画が読み込みの事象を出す）。
      expect(await renderedPrimaryCachePage(secondPage)).toEqual(EXPECTED_PRIMARY_CACHE_RENDERING);
      // 部品の要求は、どれも 200 で終わった（動画も、キャッシュから全体を 200 で返した。フォントは中身を確かめない）。
      await expect.poll(() => resourceUrls.map((url) => ends.finishedStatuses.get(url)), { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS })
        .toEqual(resourceUrls.map(() => RESOURCE_CACHE_STORABLE_STATUS));
      expect(ends.failedUrls).toEqual([]);

      expect(resourceRequestCount(allowed, PRIMARY_CACHE_PAGE)).toBe(2);
      expect(resourceRequestCounts(allowed)).toEqual(eachResourceReceived(1));
      expect(resourceRequestCounts(other)).toEqual(eachResourceReceived(1));
      expect(resourceRequestCount(other, PRIMARY_CACHE_BEACON)).toBe(2);
      // 負荷の記録: キャッシュから返した数だけ servedFromCache が増え、ネットワークに送った数は、サーバが受け取った数と一致する。
      await expect.poll(() => meter.snapshot().otherOrigins.count, { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS }).toBe(other.received().length);
      await expect.poll(() => meter.snapshot().allowedOrigins.count, { timeout: PRIMARY_CACHE_POLL_TIMEOUT_MS }).toBe(allowed.received().length);
      expect(meter.snapshot().servedFromCache).toBe(PRIMARY_CACHED_RESOURCE_COUNT);
      expect(meter.snapshot().withheldOtherOrigins).toBe(0);
      expect([...allowed.received(), ...other.received()].every(({ method }) => method === 'GET')).toBe(true);
      // Guard の違反はない。キャッシュから返した要求は、Safety の記録に入れない。
      for (const context of [first, second]) {
        const ledger = factory.getSafetyLedger(context).snapshot();
        expect(ledger.invariantViolationCount).toBe(0);
        expect(ledger.blockedRequests).toEqual([]);
      }
    } finally {
      await closePassiveResources({ factory, context: second, page: secondPage });
    }
    expect(targetBrowser.contexts(), 'Contexts left in the browser after the test').toHaveLength(0);
  }, PRIMARY_CACHE_TEST_TIMEOUT_MS);
});
